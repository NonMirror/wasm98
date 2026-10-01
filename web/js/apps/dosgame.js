/* DOS Games -- runs a js-dos (.jsdos) bundle inside a Win98 window.
 *
 * Emulator: js-dos 8.5.0 / DOSBox WebAssembly, self-hosted in
 *   web/vendor/js-dos/emulators/  (emulators.js exposes window.emulators,
 *   a plain classic-script UMD global -- no bundler, no CDN, no remote worker).
 *
 * App-level API used (see vendor/js-dos/emulators/types/emulators.d.ts):
 *   emulators.bundleConfig(bytes)        -> { dosboxConf, jsdosConf } | null
 *   emulators.dosboxDirect(bytes, opts)  -> CommandInterface
 *   ci.events().onFrameSize / onFrame / onSoundPush / onExit / onMessage
 *   ci.pause() ci.resume() ci.mute() ci.unmute() ci.persist() ci.exit()
 *   ci.sendKeyEvent(code, pressed) ci.sendMouseMotion() ci.sendMouseButton()
 *   ci.sendMouseRelativeMotion() ci.width() ci.height() ci.soundFrequency()
 *
 * The higher level window.Dos() preact player is deliberately NOT used: its
 * daisyUI stylesheet (js-dos.css) starts with a global Tailwind reset
 * (`*,:before,:after{box-sizing:border-box;...}`) that would break the 98.css
 * desktop.  This file drives the same emulator core directly, so the emulator's
 * own framebuffer is the only thing inside the Win98 client area.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ paths */

  function siteRoot() {
    var s = document.currentScript;
    var m = s && s.src && /^(.*\/)js\/apps\/[^\/]*$/.exec(s.src);
    if (m) { return m[1]; }
    return location.pathname.replace(/[^\/]*$/, '');
  }

  var ROOT = siteRoot();
  var EMU_DIR = ROOT + 'vendor/js-dos/emulators/';
  var MANIFEST_URL = ROOT + 'games/dos/manifest.json';
  var APP = { id: 'dosgame', title: 'DOS Games', icon: 'dos' };
  var DEFAULT_CONTROLS =
    'Ctrl+F10 mouse capture · Esc release mouse · Alt+Enter fullscreen · P pause · F5 save state · F9 load state';

  var manifestCache = [];

  function localUrl(p) {
    if (!p) { return p; }
    if (/^[a-z]+:/i.test(p) || p.indexOf('//') === 0) { return p; }
    return ROOT + String(p).replace(/^\//, '');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function titlebarIcon() {
    try {
      if (W98.icons && typeof W98.icons.url === 'function') { return W98.icons.url('dos'); }
    } catch (e) { /* ignore */ }
    return null;
  }

  function fmtBytes(n) {
    if (!n) { return '0 KB'; }
    if (n < 1024) { return n + ' bytes'; }
    if (n < 1024 * 1024) { return Math.round(n / 1024) + ' KB'; }
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ------------------------------------------------ emulator script (local) */

  var emuPromise = null;
  function loadEmulators() {
    if (window.emulators) { return Promise.resolve(window.emulators); }
    if (emuPromise) { return emuPromise; }
    emuPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = EMU_DIR + 'emulators.js';
      s.async = true;
      s.onload = function () {
        if (!window.emulators) {
          reject(new Error('emulators.js loaded but window.emulators is missing'));
          return;
        }
        window.emulators.pathPrefix = EMU_DIR;
        window.emulators.pathSuffix = '';
        resolve(window.emulators);
      };
      s.onerror = function () { reject(new Error('cannot load ' + s.src)); };
      (document.head || document.documentElement).appendChild(s);
    });
    return emuPromise;
  }

  /* ------------------------------------------------------- bundle download */

  function download(url, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = function (e) {
        if (onProgress) { onProgress(e.loaded, e.lengthComputable ? e.total : 0); }
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) { onProgress(xhr.response.byteLength, xhr.response.byteLength); }
          resolve(new Uint8Array(xhr.response));
        } else {
          reject(new Error('HTTP ' + xhr.status + ' while loading ' + url));
        }
      };
      xhr.onerror = function () { reject(new Error('network error loading ' + url)); };
      xhr.send();
    });
  }

  function loadManifest() {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', MANIFEST_URL, true);
      xhr.responseType = 'text';
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('HTTP ' + xhr.status + ' for ' + MANIFEST_URL));
          return;
        }
        try {
          var data = JSON.parse(xhr.responseText);
          var list = Array.isArray(data) ? data : (data.games || []);
          manifestCache = list;
          resolve(list);
        } catch (e) { reject(e); }
      };
      xhr.onerror = function () { reject(new Error('cannot load ' + MANIFEST_URL)); };
      xhr.send();
    });
  }

  /* ------------------------------------------------- DOS key code mapping  */
  /* Browser keyCode -> DOSBox key code, exactly as the js-dos player does it
   * (src/window/dos/controls/keys.ts). Letters/digits are their ASCII codes,
   * everything else is a KBD_* constant of the emulator protocol. */
  var KEY_CODES = {
    8: 259, 9: 258, 13: 257, 16: 340, 17: 341, 18: 342, 19: 284, 27: 256,
    32: 32, 33: 266, 34: 267, 35: 269, 36: 268, 37: 263, 38: 265, 39: 262, 40: 264,
    45: 260, 46: 261, 48: 48, 49: 49, 50: 50, 51: 51, 52: 52, 53: 53, 54: 54,
    55: 55, 56: 56, 57: 57, 59: 59, 64: 61,
    65: 65, 66: 66, 67: 67, 68: 68, 69: 69, 70: 70, 71: 71, 72: 72, 73: 73,
    74: 74, 75: 75, 76: 76, 77: 77, 78: 78, 79: 79, 80: 80, 81: 81, 82: 82,
    83: 83, 84: 84, 85: 85, 86: 86, 87: 87, 88: 88, 89: 89, 90: 90,
    91: 91, 93: 93,
    96: 320, 97: 321, 98: 322, 99: 323, 100: 324, 101: 325, 102: 326, 103: 327,
    104: 328, 105: 329, 106: 332, 111: 331,
    112: 290, 113: 291, 114: 292, 115: 293, 116: 294, 117: 295, 118: 296,
    119: 297, 120: 298, 121: 299, 122: 300, 123: 301,
    144: 282, 145: 281, 173: 45, 186: 59, 187: 61, 188: 44, 189: 45, 190: 46,
    191: 47, 192: 96, 219: 91, 220: 92, 221: 93, 222: 39
  };
  var LOCATIONAL = {
    16: { 1: 340, 2: 344 },   /* left / right shift */
    17: { 1: 341, 2: 345 },   /* left / right ctrl  */
    18: { 1: 342, 2: 346 }    /* left / right alt   */
  };
  var KBD_PAUSE = 284;

  function domToDosKey(keyCode, location) {
    var loc = LOCATIONAL[keyCode];
    if (loc && loc[location]) { return loc[location]; }
    return KEY_CODES[keyCode] !== undefined ? KEY_CODES[keyCode] : 0;
  }

  /* ------------------------------------------------------------------ audio */

  function Sampler(ci) {
    this.queue = [];
    this.length = 0;
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.started = false;
    this.ci = ci;
    var self = this;
    ci.events().onSoundPush(function (samples) { self.push(samples); });
  }
  Sampler.prototype.push = function (samples) {
    if (!samples || !samples.length) { return; }
    if (this.length > 4096 * 3) { return; }
    if (!this.ctx) { this.create(); }
    if (!this.ctx) { return; }
    this.queue.push(samples);
    this.length += samples.length;
  };
  Sampler.prototype.create = function () {
    var rate = 0;
    try { rate = this.ci.soundFrequency(); } catch (e) { rate = 0; }
    if (!rate || rate < 8000 || rate > 96000) { rate = 44100; }
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { return; }
    var ctx;
    try {
      ctx = new Ctx({ sampleRate: rate, latencyHint: 'interactive' });
    } catch (e) {
      try { ctx = new Ctx(); } catch (e2) { return; }
    }
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(ctx.destination);
    var node = ctx.createScriptProcessor(2048, 0, 1);
    this.node = node;
    var self = this;
    node.onaudioprocess = function (event) {
      var out = event.outputBuffer;
      var frames = out.length;
      if (!self.started) {
        if (self.length < 2048) { return; }
        self.started = true;
      }
      for (var ch = 0; ch < out.numberOfChannels; ch++) {
        var data = out.getChannelData(ch);
        var w = 0;
        while (self.queue.length > 0 && w < frames) {
          var src = self.queue[0];
          var take = Math.min(frames - w, src.length);
          if (take === src.length) {
            data.set(src, w);
            self.queue.shift();
          } else {
            data.set(src.subarray(0, take), w);
            self.queue[0] = src.subarray(take);
          }
          w += take;
          self.length -= take;
        }
        for (var i = w; i < frames; i++) { data[i] = 0; }
      }
    };
    node.connect(this.gain);
    var self2 = this;
    this._resume = function () {
      if (self2.ctx && self2.ctx.state === 'suspended') { self2.ctx.resume(); }
    };
    document.addEventListener('pointerdown', this._resume, { once: true });
    document.addEventListener('keydown', this._resume, { once: true });
  };
  Sampler.prototype.setMuted = function (muted) {
    if (this.gain) { this.gain.gain.value = muted ? 0 : 1; }
  };
  Sampler.prototype.destroy = function () {
    if (this._resume) {
      document.removeEventListener('pointerdown', this._resume);
      document.removeEventListener('keydown', this._resume);
    }
    try { if (this.node) { this.node.onaudioprocess = null; this.node.disconnect(); } } catch (e) { /* ignore */ }
    try { if (this.gain) { this.gain.disconnect(); } } catch (e) { /* ignore */ }
    if (this.ctx) { this.ctx.close().catch(function () { }); }
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.queue = [];
    this.length = 0;
  };

  /* ------------------------------------------------------------------ style */

  var styleDone = false;
  function injectStyle() {
    if (styleDone) { return; }
    styleDone = true;
    var css = [
      '.dosgame-screen{position:absolute;left:0;top:0;right:0;bottom:0;background:#000;',
      'overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:none}',
      '.dosgame-canvas{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges;',
      'image-rendering:-moz-crisp-edges;background:#000}',
      '.dosgame-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
      'background:#c0c0c0;padding:10px 14px;width:320px;text-align:center;',
      'font:11px Tahoma,"MS Sans Serif",sans-serif}',
      '.dosgame-loading img{width:32px;height:32px;vertical-align:middle}',
      '.dosgame-load-text{margin:6px 0 1px 0;font-weight:bold}',
      '.dosgame-load-bytes{margin-top:4px}',
      '.dosgame-progress{margin:6px 0 0 0}',
      '.dosgame-picker{display:flex;flex-direction:column;height:100%;padding:4px;',
      'font:11px Tahoma,"MS Sans Serif",sans-serif}',
      '.dosgame-picker-body{display:flex;flex:1;min-height:0;gap:4px}',
      '.dosgame-list{flex:1;min-height:0;overflow:auto;margin:0;padding:2px;list-style:none}',
      '.dosgame-row{display:flex;align-items:center;gap:6px;padding:2px 3px;cursor:default}',
      '.dosgame-row img{width:16px;height:16px;flex:0 0 auto}',
      '.dosgame-row .dosgame-name{font-weight:bold;flex:0 0 auto}',
      '.dosgame-row .dosgame-meta{color:#404040;overflow:hidden;white-space:nowrap}',
      '.dosgame-side{width:190px;padding:6px;overflow:auto;background:#c0c0c0}',
      '.dosgame-side h4{margin:0 0 4px 0;font-size:11px}',
      '.dosgame-side p{margin:0 0 6px 0;line-height:1.35}',
      '.dosgame-buttons{display:flex;justify-content:flex-end;gap:6px;padding-top:4px}'
    ].join('');
    var el = document.createElement('style');
    el.id = 'dosgame-style';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  /* -------------------------------------------------------- game picker    */

  function closestRow(el) {
    while (el && el !== document) {
      if (el.classList && el.classList.contains('dosgame-row')) { return el; }
      el = el.parentNode;
    }
    return null;
  }

  function createPicker(win) {
    if (win.setIcon) { win.setIcon('dos'); }
    win.setTitle('DOS Games');
    win.claimKeys();

    var root = document.createElement('div');
    root.className = 'dosgame-picker';
    var body = document.createElement('div');
    body.className = 'dosgame-picker-body';
    var list = document.createElement('ul');
    list.className = 'dosgame-list w98-listbox';
    var side = document.createElement('div');
    side.className = 'dosgame-side w98-raised';
    side.innerHTML = '<h4>DOS Games</h4>' +
      '<p>Classic MS-DOS titles running on the bundled DOSBox WebAssembly emulator. ' +
      'Everything is stored locally — nothing is downloaded at runtime.</p>' +
      '<p>' + escapeHtml(DEFAULT_CONTROLS) + '</p>';
    body.appendChild(list);
    body.appendChild(side);

    var buttons = document.createElement('div');
    buttons.className = 'dosgame-buttons';
    var playBtn = document.createElement('button');
    playBtn.className = 'default';
    playBtn.textContent = '&Play';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    buttons.appendChild(playBtn);
    buttons.appendChild(closeBtn);

    root.appendChild(body);
    root.appendChild(buttons);
    win.el.appendChild(root);

    var games = [];
    var selected = -1;
    var iconUrl = titlebarIcon();

    function render() {
      list.textContent = '';
      for (var i = 0; i < games.length; i++) {
        var g = games[i];
        var li = document.createElement('li');
        li.className = 'dosgame-row w98-listitem' + (i === selected ? ' selected' : '');
        li.dataset.index = String(i);
        if (iconUrl) {
          var img = document.createElement('img');
          img.src = iconUrl;
          img.alt = '';
          li.appendChild(img);
        }
        var name = document.createElement('span');
        name.className = 'dosgame-name';
        name.textContent = g.title;
        li.appendChild(name);
        var meta = document.createElement('span');
        meta.className = 'dosgame-meta';
        meta.textContent = (g.publisher || '') + (g.year ? ', ' + g.year : '') +
          ' · ' + fmtBytes(g.size);
        li.appendChild(meta);
        list.appendChild(li);
      }
    }

    function updateSide() {
      var g = games[selected];
      if (!g) { return; }
      side.innerHTML = '<h4>' + escapeHtml(g.title) + '</h4>' +
        '<p><b>' + escapeHtml(g.publisher || '') + '</b>' + (g.year ? ', ' + g.year : '') + '</p>' +
        '<p>' + escapeHtml(g.license || '') + '</p>' +
        '<p>' + escapeHtml(g.note || '') + '</p>' +
        '<p><b>Controls:</b> ' + escapeHtml(g.controls || '') + '</p>' +
        '<p>' + escapeHtml(DEFAULT_CONTROLS) + '</p>';
    }

    function select(i) {
      selected = i;
      render();
      updateSide();
    }

    function launch() {
      var g = games[selected];
      if (!g) { return; }
      W98.launch('dosgame', { bundle: localUrl(g.file), title: g.title });
    }

    list.addEventListener('click', function (e) {
      var row = closestRow(e.target);
      if (row) { select(Number(row.dataset.index)); }
    });
    list.addEventListener('dblclick', function (e) {
      var row = closestRow(e.target);
      if (row) { select(Number(row.dataset.index)); launch(); }
    });
    playBtn.addEventListener('click', launch);
    closeBtn.addEventListener('click', function () { win.close(); });

    var note = document.createElement('li');
    note.className = 'dosgame-row';
    note.textContent = 'Loading games…';
    list.appendChild(note);

    loadManifest().then(function (list2) {
      games = list2;
      if (games.length === 0) { throw new Error('manifest has no games'); }
      select(0);
      win.setStatus([{ text: games.length + ' games', width: 80 },
        { text: 'js-dos / DOSBox WebAssembly (local)', width: 220 },
        { text: 'Double-click a title to play' }]);
    }).catch(function (err) {
      list.textContent = '';
      var li = document.createElement('li');
      li.className = 'dosgame-row';
      li.textContent = 'Unable to read manifest: ' + err.message;
      list.appendChild(li);
      win.setStatus([{ text: 'manifest error' }, { text: String(err.message) }]);
    });

    return {};
  }

  /* ---------------------------------------------------------- the emulator  */

  function createGame(win, args) {
    if (win.setIcon) { win.setIcon('dos'); }
    win.claimKeys();
    win.setTitle(args.title || 'DOS Game');

    var bundleUrl = localUrl(args.bundle);
    var gameId = (bundleUrl.split('/').pop() || 'game').replace(/\.jsdos$/i, '');
    var SAVE_PATH = 'C:\\My Documents\\dos-' + gameId + '.sav';

    var st = {
      ci: null,
      bytes: null,
      closing: false,
      booted: false,
      userPaused: false,
      muted: false,
      scaleMode: 'auto',
      frameW: 0,
      frameH: 0,
      wantCapture: false,
      sampler: null,
      pressed: {},
      emuVersion: '8.5.0'
    };

    /* ---- DOM ---------------------------------------------------------- */
    var screen = document.createElement('div');
    screen.className = 'dosgame-screen';
    var canvas = document.createElement('canvas');
    canvas.className = 'dosgame-canvas';
    screen.appendChild(canvas);

    var loading = document.createElement('div');
    loading.className = 'dosgame-loading w98-raised';
    var lIcon = titlebarIcon();
    loading.innerHTML = (lIcon ? '<img src="' + lIcon + '" alt="">' : '') +
      '<div class="dosgame-load-text">Loading…</div>' +
      '<div class="w98-progress dosgame-progress"><i style="width:0%"></i></div>' +
      '<div class="dosgame-load-bytes">&nbsp;</div>';
    screen.appendChild(loading);
    win.el.appendChild(screen);

    var bar = loading.querySelector('.dosgame-progress i');
    var loadText = loading.querySelector('.dosgame-load-text');
    var loadBytes = loading.querySelector('.dosgame-load-bytes');

    var ctx2d = canvas.getContext('2d');
    var rgba = null;
    var imageData = null;
    var firstFrame = false;

    screen.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* ---- layout: integer scaling, letterboxed on black ---------------- */
    function fit() {
      if (!st.frameW || !st.frameH) { return; }
      var rect = screen.getBoundingClientRect();
      var bw = Math.max(1, Math.floor(rect.width));
      var bh = Math.max(1, Math.floor(rect.height));
      var scale;
      if (st.scaleMode === 'auto') {
        scale = Math.min(Math.floor(bw / st.frameW), Math.floor(bh / st.frameH));
        if (!isFinite(scale) || scale < 1) { scale = 1; }
      } else {
        scale = st.scaleMode;
      }
      var w = st.frameW * scale;
      var h = st.frameH * scale;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      canvas.style.left = Math.floor((bw - w) / 2) + 'px';
      canvas.style.top = Math.floor((bh - h) / 2) + 'px';
      updateStatus();
    }

    /* ---- status bar --------------------------------------------------- */
    function updateStatus() {
      var segs = [
        { text: st.frameW ? st.frameW + '×' + st.frameH : 'no video', width: 84 },
        { text: 'Scale ' + (st.scaleMode === 'auto' ? 'auto' : st.scaleMode + 'x'), width: 76 },
        {
          text: 'Mouse: ' + (st.wantCapture ?
            (document.pointerLockElement === canvas ? 'captured' : 'click to capture') : 'released'),
          width: 148
        }
      ];
      segs.push(st.userPaused ? { text: 'PAUSED' } : { text: DEFAULT_CONTROLS });
      win.setStatus(segs);
    }

    /* ---- menus -------------------------------------------------------- */
    function buildMenu() {
      win.setMenu([
        {
          label: '&Game',
          items: [
            { label: st.userPaused ? '&Resume' : '&Pause / Resume', accel: 'P', onclick: togglePause },
            { type: 'sep' },
            { label: '&Save State', accel: 'F5', onclick: saveState },
            { label: '&Load State', accel: 'F9', onclick: loadState },
            { type: 'sep' },
            { label: '&Mute', type: 'check', checked: st.muted, onclick: toggleMute },
            { label: '&Reset', onclick: resetGame },
            { type: 'sep' },
            { label: 'E&xit', onclick: function () { win.close(); } }
          ]
        },
        {
          label: '&Video',
          items: [
            { label: 'Scale &Automatic', type: 'radio', checked: st.scaleMode === 'auto', onclick: function () { setScale('auto'); } },
            { label: 'Scale &1x (100%)', type: 'radio', checked: st.scaleMode === 1, onclick: function () { setScale(1); } },
            { label: 'Scale &2x (200%)', type: 'radio', checked: st.scaleMode === 2, onclick: function () { setScale(2); } },
            { label: 'Scale &3x (300%)', type: 'radio', checked: st.scaleMode === 3, onclick: function () { setScale(3); } }
          ]
        },
        {
          label: '&Help',
          items: [
            { label: '&Controls…', onclick: showControls },
            { label: '&Emulator && Licences…', onclick: showLicences },
            { type: 'sep' },
            { label: '&About DOS Games…', onclick: showAbout }
          ]
        }
      ]);
    }

    function setScale(mode) {
      st.scaleMode = mode;
      buildMenu();
      fit();
    }

    /* ---- frame / loading --------------------------------------------- */
    function showLoading(text, pct, bytesText) {
      loading.style.display = '';
      loadText.textContent = text;
      bar.style.width = (pct == null ? 0 : Math.round(pct)) + '%';
      loadBytes.textContent = bytesText || '';
    }
    function hideLoading() { loading.style.display = 'none'; }

    function onFrameSize(w, h) {
      if (!w || !h) { return; }
      if (w === st.frameW && h === st.frameH && imageData) { return; }
      st.frameW = w;
      st.frameH = h;
      canvas.width = w;
      canvas.height = h;
      rgba = new Uint8ClampedArray(w * h * 4);
      imageData = new ImageData(rgba, w, h);
      fit();
    }

    function onFrame(rgb, rgbaFrame) {
      if (!imageData) { return; }
      var frame = rgb || rgbaFrame;
      if (!frame) { return; }
      var target = rgba.length;
      var four = frame.length === target;
      var src = 0;
      var dst = 0;
      while (dst < target) {
        rgba[dst++] = frame[src++];
        rgba[dst++] = frame[src++];
        rgba[dst++] = frame[src++];
        rgba[dst++] = 255;
        if (four) { src++; }
      }
      ctx2d.putImageData(imageData, 0, 0);
      if (!firstFrame) {
        firstFrame = true;
        st.booted = true;
        hideLoading();
        updateStatus();
      }
    }

    /* ---- emulator lifecycle ------------------------------------------- */
    function attach(ci) {
      st.ci = ci;
      var ev = ci.events();
      ev.onFrameSize(onFrameSize);
      ev.onFrame(onFrame);
      ev.onExit(function () {
        if (st.closing) { return; }
        hideLoading();
        win.setStatus([{ text: 'Emulator stopped', width: 130 },
          { text: 'Game > Reset to start again' }]);
      });
      ev.onMessage(function (type, message) {
        if (type === 'error' || type === 'warn') { console.warn('[js-dos] ' + message); }
      });
      st.sampler = new Sampler(ci);
      st.sampler.setMuted(st.muted);
      if (ci.width() > 0 && ci.height() > 0) { onFrameSize(ci.width(), ci.height()); }
      if (st.wantCapture) { requestCapture(); }
      setTimeout(function () {
        if (!firstFrame && !st.closing) { hideLoading(); updateStatus(); }
      }, 20000);
      updateStatus();
    }

    /* boot(changes): downloads the bundle once, then starts DOSBox.  When a
     * "changes" bundle (the files the guest OS wrote, see ci.persist()) is
     * given, it is stacked on top of the original bundle - exactly how the
     * js-dos player itself re-applies persisted files. */
    function boot(changes) {
      var saved = st.bytes;
      firstFrame = false;
      showLoading('Loading ' + (args.title || gameId) + '…', 0, '');
      return loadEmulators().then(function (E) {
        st.emuVersion = E.version || st.emuVersion;
        var bytes = saved ? Promise.resolve(saved) :
          download(bundleUrl, function (loaded, total) {
            var pct = total ? (loaded / total) * 100 : 0;
            showLoading('Loading ' + (args.title || gameId) + '…', pct,
              fmtBytes(loaded) + ' / ' + (total ? fmtBytes(total) : '?'));
          });
        return bytes.then(function (b) {
          st.bytes = b;
          showLoading('Starting DOSBox…', 100, fmtBytes(b.length) + ' bundle');
          return E.bundleConfig(b).then(function (config) {
            if (!config || !config.dosboxConf) {
              throw new Error('bundle has no .jsdos/dosbox.conf');
            }
            return E.dosboxDirect(changes ? [b, changes] : b, {});
          });
        });
      }).then(function (ci) {
        if (st.closing) {
          try { ci.exit(); } catch (e) { /* ignore */ }
          return;
        }
        attach(ci);
      }).catch(function (err) {
        hideLoading();
        win.setStatus([{ text: 'Failed to start game' }, { text: String(err.message || err) }]);
        if (W98.dialog) {
          W98.dialog.alert('DOS Games', 'Unable to start the game:\n\n' + (err.message || err), 'error');
        }
      });
    }

    function stopEmulator() {
      if (st.sampler) { st.sampler.destroy(); st.sampler = null; }
      releaseKeys();
      var ci = st.ci;
      st.ci = null;
      if (!ci) { return Promise.resolve(); }
      return Promise.resolve(ci.exit()).catch(function () { });
    }

    function restart(changes) {
      var saved = st.bytes;
      return stopEmulator().then(function () {
        st.bytes = saved;
        return boot(changes);
      });
    }

    /* ---- game commands ----------------------------------------------- */
    function togglePause() {
      if (!st.ci) { return; }
      st.userPaused = !st.userPaused;
      if (st.userPaused) { st.ci.pause(); } else { st.ci.resume(); }
      buildMenu();
      updateStatus();
    }

    function toggleMute() {
      st.muted = !st.muted;
      if (st.ci) {
        try { if (st.muted) { st.ci.mute(); } else { st.ci.unmute(); } } catch (e) { /* ignore */ }
      }
      if (st.sampler) { st.sampler.setMuted(st.muted); }
      buildMenu();
    }

    function saveState() {
      if (!st.ci) { return; }
      win.setStatus([{ text: 'Saving state…' }]);
      Promise.resolve(st.ci.persist(true)).then(function (bytes) {
        if (!bytes || bytes.length === 0) {
          W98.dialog.alert('Save State', 'There is nothing to save yet.\n\n' +
            'A state is the set of files the guest C: drive changed, so play a ' +
            'little (or use the game\'s own save function) before saving.');
        } else {
          W98.fs.writeBytes(SAVE_PATH, bytes);
          W98.dialog.alert('Save State', 'State saved to ' + SAVE_PATH +
            ' (' + fmtBytes(bytes.length) + ').');
        }
        updateStatus();
      }).catch(function (err) {
        updateStatus();
        W98.dialog.alert('Save State', 'Unable to save state: ' + (err.message || err), 'error');
      });
    }

    function loadState() {
      var bytes = W98.fs.readBytes(SAVE_PATH);
      if (!bytes || bytes.length === 0) {
        W98.dialog.alert('Load State', 'No saved state found at ' + SAVE_PATH + '.');
        return;
      }
      W98.dialog.confirm('Load State', 'Restore ' + SAVE_PATH + ' (' + fmtBytes(bytes.length) +
        ')?\n\nThe emulator is restarted with the saved files applied.').then(function (ok) {
        if (!ok) { return; }
        restart(bytes);
      });
    }

    function resetGame() { restart(null); }

    function showControls() {
      var g = null;
      for (var i = 0; i < manifestCache.length; i++) {
        if (manifestCache[i].id === gameId) { g = manifestCache[i]; }
      }
      var text = DEFAULT_CONTROLS + '\n\n';
      if (g && g.controls) { text += g.title + ':\n' + g.controls; }
      W98.dialog.alert('Controls', text, 'info');
    }

    function showLicences() {
      W98.dialog.alert('Emulator & Licences',
        'Emulator: js-dos ' + st.emuVersion + ' / DOSBox compiled to WebAssembly, ' +
        'self-hosted in web/vendor/js-dos/. js-dos is GPL-2.0, DOSBox is GPL-2.0.\n\n' +
        'The games in web/games/dos/ are shareware or freely redistributable ' +
        'releases; see games/dos/manifest.json for the source and licence of each ' +
        'title.', 'info');
    }

    function showAbout() {
      if (W98.aboutDialog) {
        W98.aboutDialog(APP);
        return;
      }
      W98.dialog.alert('About DOS Games',
        'DOS Games\nClassic MS-DOS titles in a Win98 window\n\n' +
        'Emulator: js-dos ' + st.emuVersion + ' (DOSBox WebAssembly)', 'info');
    }

    /* ---- keyboard ----------------------------------------------------- */
    function releaseKeys() {
      if (!st.ci) { st.pressed = {}; return; }
      for (var code in st.pressed) {
        if (Object.prototype.hasOwnProperty.call(st.pressed, code)) {
          try { st.ci.sendKeyEvent(Number(code), false); } catch (e) { /* ignore */ }
        }
      }
      st.pressed = {};
    }

    function onKeyDown(e) {
      if (!st.ci) { return; }

      if (e.altKey && (e.keyCode === 13 || e.key === 'Enter')) {
        e.preventDefault(); e.stopPropagation();
        toggleFullscreen();
        return;
      }
      if (e.ctrlKey && e.keyCode === 121) {           /* Ctrl+F10 */
        e.preventDefault(); e.stopPropagation();
        toggleCapture();
        return;
      }
      if (e.altKey && !e.ctrlKey && /^[a-z]$/i.test(e.key || '')) { return; }

      if (e.keyCode === 19 || (!e.ctrlKey && !e.altKey && e.keyCode === 80)) {
        e.preventDefault(); e.stopPropagation();
        togglePause();
        return;
      }
      if (!e.ctrlKey && !e.altKey && e.keyCode === 116) {   /* F5 */
        e.preventDefault(); e.stopPropagation();
        saveState();
        return;
      }
      if (!e.ctrlKey && !e.altKey && e.keyCode === 120) {   /* F9 */
        e.preventDefault(); e.stopPropagation();
        loadState();
        return;
      }
      if (e.keyCode === 27 && document.pointerLockElement === canvas) {
        e.preventDefault(); e.stopPropagation();
        document.exitPointerLock();
        return;
      }

      var code = domToDosKey(e.keyCode, e.location);
      if (!code || code === KBD_PAUSE) { return; }
      st.pressed[code] = true;
      st.ci.sendKeyEvent(code, true);
      e.preventDefault();
      e.stopPropagation();
    }

    function onKeyUp(e) {
      if (!st.ci) { return; }
      var code = domToDosKey(e.keyCode, e.location);
      if (!code) { return; }
      if (st.pressed[code]) {
        delete st.pressed[code];
        st.ci.sendKeyEvent(code, false);
      }
      if (e.ctrlKey && e.altKey) { return; }
      e.preventDefault();
      e.stopPropagation();
    }

    function toggleFullscreen() {
      var doc = document;
      var fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (fsEl) {
        var ex = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (ex) { var p = ex.call(doc); if (p && p.catch) { p.catch(function () { }); } }
        return;
      }
      var req = screen.requestFullscreen || screen.webkitRequestFullscreen;
      if (!req || !(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
        win.setStatus([{ text: 'Fullscreen is not available in this browser' }]);
        return;
      }
      var r = req.call(screen);
      if (r && r.catch) { r.catch(function () { }); }
    }

    /* ---- mouse -------------------------------------------------------- */
    function lockPointer() {
      if (document.pointerLockElement === canvas || !canvas.requestPointerLock) { return; }
      var p;
      try {
        p = canvas.requestPointerLock({ unadjustedMovement: true });
      } catch (e) {
        p = canvas.requestPointerLock();
      }
      if (p && p.catch) { p.catch(function () { }); }
    }

    function canvasXY(e) {
      var rect = canvas.getBoundingClientRect();
      var x = (e.clientX - rect.left) / (rect.width || 1);
      var y = (e.clientY - rect.top) / (rect.height || 1);
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    function buttonOf(e) { return e.button === 0 ? 0 : 1; }

    function onPointerDown(e) {
      if (!st.ci) { return; }
      win.focus();
      e.preventDefault();
      if (document.pointerLockElement === canvas) {
        st.ci.sendMouseButton(buttonOf(e), true);
        return;
      }
      if (st.wantCapture) { lockPointer(); }
      var p = canvasXY(e);
      st.ci.sendMouseMotion(p.x, p.y);
      st.ci.sendMouseButton(buttonOf(e), true);
    }

    function onPointerMove(e) {
      if (!st.ci) { return; }
      if (document.pointerLockElement === canvas) {
        st.ci.sendMouseRelativeMotion(e.movementX || 0, e.movementY || 0);
        return;
      }
      var p = canvasXY(e);
      st.ci.sendMouseMotion(p.x, p.y);
    }

    function onPointerUp(e) {
      if (!st.ci) { return; }
      if (document.pointerLockElement !== canvas) {
        var p = canvasXY(e);
        st.ci.sendMouseMotion(p.x, p.y);
      }
      st.ci.sendMouseButton(buttonOf(e), false);
    }

    function onPointerLeave(e) {
      if (!st.ci || document.pointerLockElement === canvas) { return; }
      var p = canvasXY(e);
      st.ci.sendMouseMotion(p.x, p.y);
    }

    function toggleCapture() {
      st.wantCapture = !st.wantCapture;
      if (st.wantCapture) { lockPointer(); }
      else if (document.pointerLockElement === canvas) { document.exitPointerLock(); }
      updateStatus();
    }

    function requestCapture() { lockPointer(); updateStatus(); }

    /* ---- window wiring ------------------------------------------------ */
    function onWinFocus() {
      if (st.ci && !st.userPaused) { st.ci.resume(); }
      updateStatus();
    }
    function onWinBlur() {
      if (st.ci) { st.ci.pause(); }
      releaseKeys();
    }
    function onWinResize() { fit(); }
    function onLockChange() { updateStatus(); }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    win.el.addEventListener('keydown', onKeyDown, true);
    win.el.addEventListener('keyup', onKeyUp, true);
    win.on('resize', onWinResize);
    win.on('focus', onWinFocus);
    win.on('blur', onWinBlur);
    document.addEventListener('pointerlockchange', onLockChange);

    var resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(function () { fit(); });
      resizeObserver.observe(screen);
    }

    buildMenu();
    updateStatus();
    boot(null);

    return {
      onResize: function () { fit(); },
      onFocus: onWinFocus,
      onBlur: onWinBlur,
      onClose: function () {
        st.closing = true;
        if (resizeObserver) { resizeObserver.disconnect(); }
        document.removeEventListener('pointerlockchange', onLockChange);
        win.el.removeEventListener('keydown', onKeyDown, true);
        win.el.removeEventListener('keyup', onKeyUp, true);
        if (document.pointerLockElement === canvas) { document.exitPointerLock(); }
        return stopEmulator();
      }
    };
  }

  /* ------------------------------------------------------------- register  */

  if (typeof W98 !== 'undefined' && W98.registerApp) {
    W98.registerApp({
      id: 'dosgame',
      title: 'DOS Game',
      icon: 'dos',
      width: 640,
      height: 480,
      minWidth: 320,
      minHeight: 200,
      resizable: true,
      singleton: false,
      desktop: false,
      startMenuGroup: 'Games',
      create: function (win, args) {
        injectStyle();
        if (!args || !args.bundle) { return createPicker(win); }
        return createGame(win, args);
      }
    });

    /* keep the manifest around for Help > Controls */
    try { loadManifest().catch(function () { }); } catch (e) { /* ignore */ }
  }
})();
