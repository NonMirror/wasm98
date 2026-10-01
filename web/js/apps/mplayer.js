/* ===========================================================================
 * mplayer.js — Media Player 6.4 (Windows 98 accessory)
 *
 * Classic script (NOT a module).  Registers itself with W98.registerApp().
 * Plays WAV data out of W98.fs through Web Audio, with a playlist, a seek
 * slider, a volume slider and an AnalyserNode-driven visualizer.
 * =========================================================================*/
(function () {
  'use strict';

  var ID = 'mplayer';
  var REG_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\MediaPlayer';
  var MEDIA_DIR = 'C:\\WINDOWS\\MEDIA';
  var AUDIO_RE = /\.(wav|wave)$/i;
  var MIDI_RE = /\.(mid|midi|rmi)$/i;
  var VIDEO_RE = /\.(avi|mpg|mpeg)$/i;
  var ANY_MEDIA_RE = /\.(wav|wave|mid|midi|rmi|avi|mpg|mpeg|mp3|m3u|asf)$/i;

  /* ---------------------------------------------------------- 16-colour */
  var EGA = ['#000000', '#000080', '#008000', '#008080', '#800000', '#800080',
    '#808000', '#c0c0c0', '#808080', '#0000ff', '#00ff00', '#00ffff', '#ff0000',
    '#ff00ff', '#ffff00', '#ffffff'];

  /* --------------------------------------------------- procedural icons */
  function clearIco(g) {
    g.clearRect(0, 0, 16, 16);
  }
  function tri(g, x, y, w, h, dir, col) {
    g.fillStyle = col;
    for (var i = 0; i < w; i++) {
      var t = (dir === 'right') ? (i + 1) : (w - i);
      var hh = Math.max(1, Math.round(t / w * h));
      var yy = y + Math.round((h - hh) / 2);
      g.fillRect(x + i, yy, 1, hh);
    }
  }
  function rect(g, x, y, w, h, col) {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  }
  function bevel(g, x, y, w, h) {
    g.fillStyle = '#000000';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#c0c0c0';
    g.fillRect(x + 1, y + 1, w - 2, h - 2);
  }
  function drawIcon(kind, cv) {
    var g = cv.getContext('2d');
    clearIco(g);
    if (kind === 'play') {
      tri(g, 2, 1, 10, 14, 'right', EGA[0]);
      tri(g, 3, 2, 8, 12, 'right', EGA[2]);
    } else if (kind === 'pause') {
      bevel(g, 3, 2, 4, 12);
      bevel(g, 9, 2, 4, 12);
    } else if (kind === 'stop') {
      rect(g, 2, 2, 12, 12, EGA[0]);
      rect(g, 3, 3, 10, 10, EGA[8]);
      rect(g, 3, 3, 10, 1, EGA[7]);
      rect(g, 3, 3, 1, 10, EGA[7]);
    } else if (kind === 'eject') {
      tri(g, 1, 0, 14, 10, 'up', EGA[0]);
      tri(g, 2, 1, 12, 8, 'up', EGA[7]);
      rect(g, 2, 11, 12, 1, EGA[0]);
      rect(g, 2, 12, 12, 3, EGA[0]);
      rect(g, 3, 12, 10, 2, EGA[7]);
    } else if (kind === 'prev') {
      tri(g, 0, 1, 8, 14, 'left', EGA[0]);
      tri(g, 1, 2, 6, 12, 'left', EGA[7]);
      tri(g, 7, 1, 8, 14, 'left', EGA[0]);
      tri(g, 8, 2, 6, 12, 'left', EGA[7]);
    } else if (kind === 'next') {
      tri(g, 1, 1, 8, 14, 'right', EGA[0]);
      tri(g, 2, 2, 6, 12, 'right', EGA[7]);
      tri(g, 8, 1, 8, 14, 'right', EGA[0]);
      tri(g, 9, 2, 6, 12, 'right', EGA[7]);
    } else if (kind === 'volume') {
      rect(g, 1, 6, 3, 4, EGA[0]);
      rect(g, 4, 4, 2, 8, EGA[0]);
      tri(g, 6, 2, 4, 12, 'right', EGA[0]);
      rect(g, 11, 6, 1, 4, EGA[0]);
      rect(g, 13, 4, 1, 8, EGA[0]);
    } else if (kind === 'speaker') {
      rect(g, 1, 5, 3, 6, EGA[0]);
      rect(g, 4, 3, 2, 10, EGA[0]);
      tri(g, 6, 1, 5, 14, 'right', EGA[0]);
      rect(g, 12, 5, 1, 6, EGA[0]);
      rect(g, 14, 3, 1, 10, EGA[0]);
    }
  }

  /* ---------------------------------------------------------------- css */
  var CSS = [
    '.mp-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
    '  min-width:0;min-height:0;background:#c0c0c0;padding:3px;overflow:hidden;',
    '  font:11px Tahoma,"MS Sans Serif",sans-serif;color:#000000}',
    '.mp-root,.mp-root *{box-sizing:border-box}',
    '.mp-video{position:relative;flex:1 1 auto;min-height:96px;background:#000000;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000,inset -1px -1px 0 #dfdfdf;overflow:hidden;',
    '  margin:0 0 3px}',
    '.mp-video canvas{position:absolute;left:0;top:0;width:100%;height:100%;',
    '  image-rendering:pixelated;image-rendering:crisp-edges}',
    '.mp-msg{position:absolute;left:0;right:0;bottom:3px;text-align:center;color:#c0c0c0;',
    '  font:11px Tahoma,sans-serif;pointer-events:none;white-space:nowrap;overflow:hidden;',
    '  text-overflow:ellipsis}',
    '.mp-list{flex:none;height:54px;overflow-y:auto;background:#ffffff;color:#000000;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000;margin:0 0 3px;padding:0;display:none}',
    '.mp-list.on{display:block}',
    '.mp-item{font:11px Tahoma,sans-serif;padding:1px 3px;white-space:nowrap;overflow:hidden;',
    '  text-overflow:ellipsis;cursor:default}',
    '.mp-item.sel{background:#000080;color:#ffffff}',
    '.mp-item.playing{font-weight:bold}',
    '.mp-seek{flex:none;display:flex;align-items:center;gap:5px;height:20px;margin:0 0 2px}',
    '.mp-time{flex:none;width:52px;text-align:center;font:11px Tahoma,sans-serif}',
    '.mp-seek input[type=range]{flex:1 1 auto;min-width:0;margin:0;height:16px}',
    '.mp-vol{flex:none;display:flex;align-items:center;gap:5px;height:20px;margin:0 0 3px}',
    '.mp-vol canvas{width:16px;height:16px;flex:none}',
    '.mp-vol label{font:11px Tahoma,sans-serif;flex:none}',
    '.mp-vol input[type=range]{flex:0 0 110px;margin:0;height:16px}',
    '.mp-vol .mp-vnum{flex:none;width:26px;text-align:right;font:11px Tahoma,sans-serif}',
    '.mp-toolbar{flex:none;display:flex;gap:2px;padding:2px;background:#c0c0c0;',
    '  border:1px solid #ffffff;border-right-color:#000000;border-bottom-color:#000000}',
    '.mp-toolbar button{flex:1 1 0;min-width:0;display:flex;flex-direction:column;',
    '  align-items:center;justify-content:center;gap:1px;padding:2px 0;background:#c0c0c0;',
    '  border:1px solid #ffffff;border-right-color:#000000;border-bottom-color:#000000;',
    '  border-radius:0;font:11px Tahoma,sans-serif;color:#000000;cursor:default}',
    '.mp-toolbar button:active,.mp-toolbar button.on{border-color:#000000 #ffffff #ffffff #000000;',
    '  padding:3px 0 1px 0}',
    '.mp-toolbar button canvas{width:16px;height:16px;flex:none}',
    '.mp-toolbar button span{font:10px Tahoma,sans-serif;white-space:nowrap}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style');
    st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  function baseName(p) {
    var a = String(p || '').split(/[\\/]/);
    return a[a.length - 1] || String(p || '');
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    var s = Math.floor(sec % 60);
    var m = Math.floor(sec / 60) % 60;
    var h = Math.floor(sec / 3600);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(s)) : (p2(m) + ':' + p2(s));
  }

  W98.registerApp({
    id: ID,
    title: 'Media Player',
    icon: 'media-player',
    width: 400,
    height: 300,
    minWidth: 320,
    minHeight: 240,
    resizable: true,
    maximizable: true,
    singleton: true,
    startMenuGroup: 'Accessories',
    create: create
  });

  function create(win, args) {
    ensureCss();
    win.el.style.display = 'flex';
    win.el.style.overflow = 'hidden';
    var root = document.createElement('div');
    root.className = 'mp-root';
    root.style.flex = '1 1 auto';
    win.el.appendChild(root);

    /* ------------------------------------------------------------ video */
    var video = document.createElement('div');
    video.className = 'mp-video';
    var canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 150;
    video.appendChild(canvas);
    var msg = document.createElement('div');
    msg.className = 'mp-msg';
    msg.textContent = 'No media loaded';
    video.appendChild(msg);
    root.appendChild(video);

    /* --------------------------------------------------------- playlist */
    var list = document.createElement('div');
    list.className = 'mp-list';
    list.tabIndex = 0;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Playlist');
    root.appendChild(list);

    /* ------------------------------------------------------------- seek */
    var seekRow = document.createElement('div');
    seekRow.className = 'mp-seek';
    var posT = document.createElement('div');
    posT.className = 'mp-time';
    posT.textContent = '00:00';
    var seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'slider';
    seek.min = '0';
    seek.max = '1000';
    seek.step = '1';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Position');
    var durT = document.createElement('div');
    durT.className = 'mp-time';
    durT.textContent = '00:00';
    seekRow.appendChild(posT);
    seekRow.appendChild(seek);
    seekRow.appendChild(durT);
    root.appendChild(seekRow);

    /* ----------------------------------------------------------- volume */
    var volRow = document.createElement('div');
    volRow.className = 'mp-vol';
    var volIco = document.createElement('canvas');
    volIco.width = 16;
    volIco.height = 16;
    drawIcon('speaker', volIco);
    volRow.appendChild(volIco);
    var volLab = document.createElement('label');
    volLab.textContent = 'Volume:';
    volRow.appendChild(volLab);
    var vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'slider';
    vol.min = '0';
    vol.max = '100';
    vol.step = '1';
    vol.value = '70';
    vol.setAttribute('aria-label', 'Volume');
    volRow.appendChild(vol);
    var volNum = document.createElement('div');
    volNum.className = 'mp-vnum';
    volNum.textContent = '70';
    volRow.appendChild(volNum);
    root.appendChild(volRow);

    /* ---------------------------------------------------------- toolbar */
    var bar = document.createElement('div');
    bar.className = 'w98-toolbar mp-toolbar';
    var TB = [
      { key: 'play', label: 'Play' },
      { key: 'pause', label: 'Pause' },
      { key: 'stop', label: 'Stop' },
      { key: 'eject', label: 'Eject' },
      { key: 'prev', label: 'Previous' },
      { key: 'next', label: 'Next' }
    ];
    var toolBtns = {};
    TB.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'w98-toolbtn';
      b.setAttribute('data-cmd', t.key);
      b.title = t.label;
      var ic = document.createElement('canvas');
      ic.width = 16;
      ic.height = 16;
      drawIcon(t.key, ic);
      var sp = document.createElement('span');
      sp.textContent = t.label;
      b.appendChild(ic);
      b.appendChild(sp);
      b.addEventListener('click', function () { cmd(t.key); });
      toolBtns[t.key] = b;
      bar.appendChild(b);
    });
    root.appendChild(bar);

    /* ------------------------------------------------------------ state */
    var S = {
      items: [],
      index: -1,
      buffer: null,
      bufferPath: null,
      src: null,
      gain: null,
      analyser: null,
      actx: null,
      playing: false,
      paused: false,
      offset: 0,
      startedAt: 0,
      duration: 0,
      volume: 70,
      device: 'Sound',
      scale: 'Size',
      seekBusy: false,
      timer: 0,
      raf: 0,
      busy: false,
      token: 0
    };
    try {
      var v = parseInt(W98.reg.get(REG_KEY, 'Volume', '70'), 10);
      if (isFinite(v) && v >= 0 && v <= 100) { S.volume = v; }
      vol.value = String(S.volume);
      volNum.textContent = String(S.volume);
      var sc = W98.reg.get(REG_KEY, 'Scale', 'Size');
      if (sc === 'Half' || sc === 'Double' || sc === 'Size') { S.scale = sc; }
    } catch (e) { /* defaults */ }

    /* -------------------------------------------------------------- raf */
    var ctx = canvas.getContext('2d');
    var rafLoop = null;

    function sizeCanvas() {
      var w = Math.max(16, video.clientWidth);
      var h = Math.max(16, video.clientHeight);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      idleDraw();
    }
    function idleDraw() {
      if (S.playing) { return; }
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    function drawViz() {
      var w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      var an = S.analyser;
      if (!an) { return; }
      var n = an.frequencyBinCount;
      var fa = new Uint8Array(n);
      an.getByteFrequencyData(fa);
      var bars = 32;
      var zoom = S.scale === 'Half' ? 1 : S.scale === 'Double' ? 3 : 2;
      var bw = Math.max(2, Math.floor(w / bars));
      for (var i = 0; i < bars; i++) {
        var v = fa[Math.floor(i * n / bars)] || 0;
        var bh = Math.round(v / 255 * (h - 6));
        ctx.fillStyle = v > 190 ? '#ff0000' : v > 120 ? '#ffff00' : '#00ff00';
        ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1 - (2 - zoom)), bh);
      }
      var ta = new Uint8Array(n);
      an.getByteTimeDomainData(ta);
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      var step = Math.max(1, Math.floor(n / Math.max(1, w)));
      for (var x = 0; x < w; x++) {
        var y = (ta[Math.min(n - 1, x * step)] / 128 - 1) * (h / 2) + h / 2;
        if (x === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    function startRaf() {
      if (rafLoop) { return; }
      rafLoop = W98.raf(function () {
        if (!S.playing) { return; }
        drawViz();
      });
    }
    function stopRaf() {
      if (rafLoop) {
        try { rafLoop(); } catch (e) { /* cancel fn */ }
        rafLoop = null;
      }
      idleDraw();
    }

    /* ------------------------------------------------------------ audio */
    function audioCtx() {
      if (S.actx) { return S.actx; }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return null; }
      S.actx = new AC();
      S.gain = S.actx.createGain();
      S.gain.gain.value = S.volume / 100;
      S.analyser = S.actx.createAnalyser();
      S.analyser.fftSize = 512;
      S.analyser.smoothingTimeConstant = 0.75;
      S.gain.connect(S.analyser);
      S.analyser.connect(S.actx.destination);
      return S.actx;
    }

    function decode(bytes) {
      return new Promise(function (resolve, reject) {
        var actx = audioCtx();
        if (!actx) { reject(new Error('no audio')); return; }
        var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        var done = false;
        var p = actx.decodeAudioData(ab, function (buf) {
          done = true; resolve(buf);
        }, function (err) {
          if (!done) { reject(err || new Error('decode')); }
        });
        if (p && typeof p.then === 'function') {
          p.then(function (buf) { if (!done) { done = true; resolve(buf); } },
            function (err) { if (!done) { reject(err); } });
        }
      });
    }

    function failPlay(name) {
      void name;
      try { W98.sound.error(); } catch (e) { }
      W98.dialog.alert('Media Player', 'Media Player cannot play this file', 'error');
    }

    function loadTrack(i) {
      var item = S.items[i];
      if (!item) { return Promise.resolve(false); }
      if (S.bufferPath === item.path && S.buffer) { return Promise.resolve(true); }
      var bytes = null;
      try { bytes = W98.fs.readBytes(item.path); } catch (e) { bytes = null; }
      if (!bytes || !bytes.length) {
        failPlay(item.name);
        return Promise.resolve(false);
      }
      S.busy = true;
      return decode(bytes).then(function (buf) {
        S.busy = false;
        if (!buf || !buf.length) {
          failPlay(item.name);
          return false;
        }
        S.buffer = buf;
        S.bufferPath = item.path;
        S.duration = buf.duration;
        S.offset = 0;
        durT.textContent = fmtTime(S.duration);
        return true;
      }, function () {
        S.busy = false;
        failPlay(item.name);
        return false;
      });
    }

    function stopSource() {
      if (S.src) {
        try { S.src.onended = null; } catch (e) { }
        try { S.src.stop(0); } catch (e2) { }
        try { S.src.disconnect(0); } catch (e3) { }
        S.src = null;
      }
    }

    function startSource(offset) {
      if (!S.buffer || !S.actx) { return; }
      stopSource();
      var src = S.actx.createBufferSource();
      src.buffer = S.buffer;
      src.connect(S.gain);
      src.onended = function () {
        if (!S.playing) { return; }
        var end = S.offset + (S.actx.currentTime - S.startedAt);
        if (end >= S.duration - 0.05) { trackEnded(); }
      };
      var off = Math.max(0, Math.min(offset, Math.max(0, S.duration - 0.02)));
      try { src.start(0, off); } catch (e) { return; }
      S.src = src;
      S.startedAt = S.actx.currentTime;
      S.offset = off;
    }

    function trackEnded() {
      if (S.index + 1 < S.items.length) {
        selectItem(S.index + 1, true);
      } else {
        S.playing = false;
        S.paused = false;
        S.offset = 0;
        stopSource();
        stopRaf();
        paint();
        updateTime();
      }
    }

    function play() {
      if (S.busy) { return; }
      if (S.index < 0) {
        if (!S.items.length) { openFiles(); return; }
        selectItem(0, true);
        return;
      }
      var need = (S.bufferPath !== S.items[S.index].path) || !S.buffer;
      var token = ++S.token;
      var go = need ? loadTrack(S.index) : Promise.resolve(!!S.buffer);
      go.then(function (ok) {
        /* a stop/eject/track change while we were decoding supersedes us */
        if (token !== S.token) { return; }
        if (!ok) { return; }
        var actx = audioCtx();
        if (!actx) {
          W98.dialog.alert('Media Player', 'Media Player cannot play this file', 'error');
          return;
        }
        try {
          if (actx.state === 'suspended' && actx.resume) {
            var rp = actx.resume();
            if (rp && rp['catch']) { rp['catch'](function () { }); }
          }
        } catch (e) { /* ignore */ }
        S.playing = true;
        S.paused = false;
        startSource(S.offset);
        startRaf();
        drawViz();
        paint();
        updateTime();
      });
    }

    function pause() {
      if (!S.playing) {
        if (S.paused) { play(); }
        return;
      }
      var pos = position();
      S.offset = pos;
      stopSource();
      try {
        if (S.actx && S.actx.suspend) {
          var sp = S.actx.suspend();
          if (sp && sp['catch']) { sp['catch'](function () { }); }
        }
      } catch (e) { /* ignore */ }
      S.playing = false;
      S.paused = true;
      stopRaf();
      paint();
      updateTime();
    }

    function stop() {
      var wasPlaying = S.playing;
      S.playing = false;
      S.paused = false;
      S.token++;
      stopSource();
      if (wasPlaying && S.actx && S.actx.suspend) {
        try {
          var sp = S.actx.suspend();
          if (sp && sp['catch']) { sp['catch'](function () { }); }
        } catch (e) { /* ignore */ }
      }
      S.offset = 0;
      stopRaf();
      paint();
      updateTime();
    }

    function eject() {
      stop();
      S.buffer = null;
      S.bufferPath = null;
      S.duration = 0;
      durT.textContent = '00:00';
      posT.textContent = '00:00';
      seek.value = '0';
    }

    function position() {
      if (!S.playing || !S.actx) { return S.offset; }
      var p = S.offset + (S.actx.currentTime - S.startedAt);
      return Math.max(0, Math.min(S.duration || 0, p));
    }

    function seekTo(sec) {
      if (!S.duration) { return; }
      sec = Math.max(0, Math.min(S.duration, sec));
      S.offset = sec;
      if (S.playing) {
        startSource(sec);
        startRaf();
      } else {
        try {
          if (S.actx && S.actx.state === 'suspended' && S.actx.resume) {
            var rp = S.actx.resume();
            if (rp && rp['catch']) { rp['catch'](function () { }); }
          }
        } catch (e) { /* ignore */ }
      }
      updateTime();
    }

    function updateTime() {
      var p = position();
      posT.textContent = fmtTime(p);
      if (!S.seekBusy && S.duration > 0) {
        seek.value = String(Math.round(p / S.duration * 1000));
      }
    }

    /* --------------------------------------------------------- playlist */
    function paint() {
      for (var i = 0; i < list.children.length; i++) {
        var el = list.children[i];
        el.className = 'mp-item' +
          (i === S.index ? ' sel' : '') +
          (i === S.index && S.playing ? ' playing' : '');
      }
      msg.textContent = S.items.length && S.index >= 0
        ? (S.playing ? S.items[S.index].name : S.items[S.index].name + ' - ' +
          (S.paused ? 'Paused' : 'Stopped'))
        : 'No media loaded';
      toolBtns.play.setAttribute('aria-pressed', S.playing ? 'true' : 'false');
      toolBtns.pause.setAttribute('aria-pressed', S.paused ? 'true' : 'false');
      toolBtns.stop.setAttribute('aria-pressed',
        (!S.playing && !S.paused && S.index >= 0) ? 'true' : 'false');
    }

    function renderList() {
      list.innerHTML = '';
      S.items.forEach(function (it, i) {
        var d = document.createElement('div');
        d.className = 'mp-item' + (i === S.index ? ' sel' : '');
        d.textContent = it.name;
        d.title = it.path;
        d.setAttribute('data-i', String(i));
        d.setAttribute('role', 'option');
        list.appendChild(d);
      });
      list.classList.toggle('on', S.items.length > 0);
      paint();
    }

    function addPath(p) {
      if (!p) { return -1; }
      var name = baseName(p);
      for (var i = 0; i < S.items.length; i++) {
        if (S.items[i].path === p) { return i; }
      }
      S.items.push({ path: p, name: name });
      return S.items.length - 1;
    }

    function selectItem(i, autoplay) {
      if (i < 0 || i >= S.items.length) { return; }
      if (i !== S.index) {
        stop();
        S.buffer = null;
        S.bufferPath = null;
        S.duration = 0;
        seek.value = '0';
        posT.textContent = '00:00';
        durT.textContent = '00:00';
      }
      S.index = i;
      renderList();
      if (autoplay) { play(); }
    }

    list.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute('data-i') === null) { return; }
      var i = parseInt(t.getAttribute('data-i'), 10);
      if (S.index === i && S.playing) { pause(); return; }
      selectItem(i, true);
    });
    list.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var d = e.key === 'ArrowDown' ? 1 : -1;
        selectItem(Math.max(0, Math.min(S.items.length - 1, S.index + d)), false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (S.index >= 0) { play(); }
      }
    });

    /* -------------------------------------------------------- media scan */
    function scanMedia() {
      var found = [];
      try {
        var entries = W98.fs.list(MEDIA_DIR) || [];
        entries.forEach(function (e) {
          if (e && !e.dir && ANY_MEDIA_RE.test(e.name)) {
            found.push(MEDIA_DIR + '\\' + e.name);
          }
        });
      } catch (e) { /* media folder may not exist */ }
      found.sort();
      found.forEach(function (p) { addPath(p); });
      if (found.length) { renderList(); }
    }

    /* ------------------------------------------------------ file / dialog */
    function filterFor(device) {
      if (device === 'Sound') { return '*.wav'; }
      if (device === 'MIDI Sequencer') { return '*.mid;*.rmi'; }
      if (device === 'Video for Windows') { return '*.avi'; }
      return '*.wav;*.avi;*.mid';
    }

    function openFiles() {
      Promise.resolve(W98.dialog.fileOpen({
        path: MEDIA_DIR, filter: filterFor(S.device)
      })).then(function (p) {
        if (!p) { return; }
        var paths = Array.isArray(p) ? p : [p];
        var first = -1;
        paths.forEach(function (q) {
          var i = addPath(q);
          if (first < 0) { first = i; }
        });
        renderList();
        if (first >= 0) {
          var target = S.index >= 0 ? S.index : first;
          if (target === first && S.index < 0) { selectItem(first, true); }
          else { S.index = target; renderList(); }
        }
      }, function () { /* cancelled */ });
    }

    function cmd(key) {
      try {
        if (key === 'play') { play(); }
        else if (key === 'pause') { pause(); }
        else if (key === 'stop') { stop(); }
        else if (key === 'eject') { eject(); try { win.setTitle('Media Player'); } catch (e) { } }
        else if (key === 'prev') {
          var i = S.index > 0 ? S.index - 1 : 0;
          selectItem(i, true);
        } else if (key === 'next') {
          var j = S.index + 1 < S.items.length ? S.index + 1 : S.items.length - 1;
          if (j >= 0) { selectItem(j, true); }
        }
      } catch (e) { /* never throw from a button */ }
    }

    /* ---------------------------------------------------------- controls */
    seek.addEventListener('input', function () {
      S.seekBusy = true;
      posT.textContent = fmtTime(S.duration * (parseInt(seek.value, 10) / 1000));
    });
    seek.addEventListener('change', function () {
      S.seekBusy = false;
      seekTo(S.duration * (parseInt(seek.value, 10) / 1000));
    });
    seek.addEventListener('mouseup', function () { S.seekBusy = false; });
    seek.addEventListener('mousedown', function () { S.seekBusy = true; });
    seek.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        var d = (e.key === 'ArrowLeft' ? -5 : 5);
        seekTo(Math.min(S.duration, Math.max(0, position() + d)));
      }
    });
    vol.addEventListener('input', function () {
      S.volume = parseInt(vol.value, 10) || 0;
      volNum.textContent = String(S.volume);
      try {
        if (S.gain) { S.gain.gain.value = S.volume / 100; }
      } catch (e) { /* ignore */ }
      try { W98.reg.set(REG_KEY, 'Volume', String(S.volume)); } catch (e2) { }
    });

    /* --------------------------------------------------------------- menu */
    function menu() {
      win.setMenu([
        {
          label: '&File', items: [
            { label: '&Open\u2026', accel: 'Ctrl+O', onclick: openFiles },
            { label: '&Close', onclick: function () { eject(); } },
            { type: 'sep' },
            { label: 'E&xit', onclick: function () { win.close(); } }
          ]
        },
        {
          label: '&Device', items: [
            {
              label: '&Video for Windows\u2026', type: 'radio', checked: S.device === 'Video for Windows',
              onclick: function () { setDevice('Video for Windows'); }
            },
            {
              label: '&Sound\u2026', type: 'radio', checked: S.device === 'Sound',
              onclick: function () { setDevice('Sound'); }
            },
            {
              label: '&MIDI Sequencer\u2026', type: 'radio', checked: S.device === 'MIDI Sequencer',
              onclick: function () { setDevice('MIDI Sequencer'); }
            },
            { type: 'sep' },
            { label: 'P&roperties', onclick: function () { deviceProps(); } }
          ]
        },
        {
          label: '&Scale', items: [
            {
              label: '&Half', type: 'radio', checked: S.scale === 'Half',
              onclick: function () { setScale('Half'); }
            },
            {
              label: '&Size', type: 'radio', checked: S.scale === 'Size',
              onclick: function () { setScale('Size'); }
            },
            {
              label: '&Double', type: 'radio', checked: S.scale === 'Double',
              onclick: function () { setScale('Double'); }
            }
          ]
        },
        {
          label: '&Help', items: [
            { label: '&Help Topics', onclick: helpTopics },
            { type: 'sep' },
            { label: '&About Media Player', onclick: about }
          ]
        }
      ]);
    }
    function setDevice(d) {
      S.device = d;
      menu();
      openFiles();
    }
    function setScale(s) {
      S.scale = s;
      try { W98.reg.set(REG_KEY, 'Scale', s); } catch (e) { }
      menu();
      if (S.playing) { drawViz(); }
    }
    function deviceProps() {
      W98.dialog.alert('Properties',
        S.device + ' Properties\n\n' +
        'Sample rate: 22050 Hz\nChannels: 2 (stereo)\nBits per sample: 16', 'info');
    }
    function helpTopics() {
      W98.dialog.alert('Media Player Help',
        'Media Player Help Topics\n\n' +
        '\u2022 On the Device menu, click the device you want to use.\n' +
        '\u2022 On the File menu, click Open to select a media file.\n' +
        '\u2022 Use the Scale menu to change the size of the display area.\n' +
        '\u2022 Drag the position slider to seek within the clip.\n' +
        '\u2022 Drag the Volume slider to change the playback volume.', 'info');
    }
    function about() {
      var def = {
        id: ID, title: 'About Media Player', icon: 'mediaplayer',
        name: 'Media Player',
        text: 'Microsoft Windows Media Player\nVersion 6.4.09.1128\n\n' +
          'Copyright \u00A9 1998 Microsoft Corporation.\nAll rights reserved.'
      };
      try {
        if (typeof W98.aboutDialog === 'function') { W98.aboutDialog(def); return; }
      } catch (e) { /* fall through */ }
      W98.dialog.alert('About Media Player', def.text, 'info');
    }

    /* ----------------------------------------------------------- keyboard */
    function onKey(e) {
      if (e.ctrlKey || e.metaKey) {
        if (String(e.key).toLowerCase() === 'o') { e.preventDefault(); openFiles(); }
        return;
      }
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (e.key === ' ' && !typing) {
        e.preventDefault();
        if (S.playing) { pause(); } else { play(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); stop(); return; }
      if (!typing && (e.key === 'Home')) { e.preventDefault(); seekTo(0); return; }
      if (!typing && e.key === 'End') { e.preventDefault(); seekTo(S.duration); }
    }
    win.el.addEventListener('keydown', onKey);

    /* ---------------------------------------------------------- start up */
    menu();
    renderList();
    scanMedia();
    sizeCanvas();
    win.setTitle('Media Player');

    /* the shell launches us as W98.launch('mplayer', { path: 'C:\\...' }) */
    var argPath = null;
    if (typeof args === 'string') { argPath = args; }
    else if (args && typeof args === 'object' && typeof args.path === 'string') { argPath = args.path; }
    if (argPath) {
      var ai = addPath(argPath);
      renderList();
      if (ai >= 0) { selectItem(ai, true); }
    }

    S.timer = win.setInterval(function () {
      if (!S.playing) { return; }
      updateTime();
      /* keep the display alive even where requestAnimationFrame is throttled */
      drawViz();
    }, 200);

    var onRes = win.on('resize', function () {
      sizeCanvas();
      if (S.playing) { drawViz(); }
    });
    void onRes;

    return {
      onClose: function () {
        S.playing = false;
        if (S.timer) { win.clearInterval(S.timer); S.timer = 0; }
        stopRaf();
        stopSource();
        try {
          if (S.gain) { S.gain.disconnect(0); }
          if (S.analyser) { S.analyser.disconnect(0); }
        } catch (e) { /* ignore */ }
        try {
          if (S.actx && S.actx.state !== 'closed' && S.actx.close) {
            var cp = S.actx.close();
            if (cp && cp['catch']) { cp['catch'](function () { }); }
          }
        } catch (e2) { /* ignore */ }
        S.actx = null;
        S.gain = null;
        S.analyser = null;
        S.src = null;
        S.buffer = null;
      },
      onResize: function () { sizeCanvas(); },
      onFocus: function () { },
      onBlur: function () { }
    };
  }
})();
