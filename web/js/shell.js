/* ============================================================================
   shell.js — the desktop shell: window manager, menus, dialogs, sounds, and
   the W98 system API that applications are written against.

   Every window is a process in the WebAssembly kernel: creating a window calls
   k_proc_create, focus/z-order go into the kernel's process table, timers run
   through the kernel's timer queue, and files/registry live in the kernel
   filesystem.  JS owns pixels; the kernel owns state.
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.W98Kernel;
  var ICONS = global.W98Icons;

  /* ==================================================================== */
  /* W98 namespace                                                        */
  /* ==================================================================== */
  var W98 = global.W98 = {
    version: '4.10.1998',
    apps: {},
    registry: [],       /* registration order */
    windows: [],
    shutdownInProgress: false
  };

  var USER = 'User';
  var PROG = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion';
  var DESK = 'HKEY_CURRENT_USER\\Control Panel\\Desktop';

  function regKey(suffix) { return PROG + '\\' + suffix; }
  W98.regKey = regKey;

  /* ==================================================================== */
  /* tiny helpers                                                         */
  /* ==================================================================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function txt(s) { return document.createTextNode(s); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function on(e, ev, fn, opt) { e.addEventListener(ev, fn, opt); return fn; }
  function off(e, ev, fn) { e.removeEventListener(ev, fn); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* render "&File" as "F<u>i</u>le" the 1998 way */
  function menuLabel(s) {
    var i = s.indexOf('&');
    if (i < 0) return escapeHtml(s);
    return escapeHtml(s.slice(0, i)) + '<u>' + escapeHtml(s[i + 1]) + '</u>' + escapeHtml(s.slice(i + 2));
  }
  function stripAmp(s) { return String(s).replace(/&(.)/g, '$1'); }

  W98.util = { $: $, el: el, clamp: clamp, pad2: pad2, escapeHtml: escapeHtml, menuLabel: menuLabel };

  /* ==================================================================== */
  /* sound: registry scheme -> C:\WINDOWS\MEDIA\<file> -> kernel fs        */
  /* ==================================================================== */
  var Sound = (function () {
    var ctx = null, master = null, buffers = {}, rawCache = {};
    var state = { muted: false, volume: 0.7 };

    function audio() {
      if (!ctx) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = state.volume;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function eventName(ev) {
      return W98.reg.get('HKEY_CURRENT_USER\\AppEvents\\Schemes\\Apps\\.Default\\' + ev, '.Current', null);
    }
    function schemePath(ev) {
      var p = eventName(ev);
      if (p && p !== '') return p;
      return null;
    }
    var synthMap = {
      SystemStart: 'startup', SystemExit: 'shutdown', DefaultBeep: 'ding',
      SystemAsterisk: 'chime', SystemHand: 'error', SystemExclamation: 'exclamation',
      SystemQuestion: 'question', MenuCommand: 'click', MenuPopup: 'menu',
      WindowOpen: 'click', WindowClose: 'click', Minimize: 'minimize', Maximize: 'maximize',
      RestoreUp: 'restore', RestoreDown: 'restore', Recycle: 'recycle',
      SystemLogon: 'logon', SystemLogoff: 'logoff', Chord: 'chord', Tada: 'tada',
      Balloon: 'balloon', Notify: 'notify'
    };
    function decodeBytes(bytes) {
      return new Promise(function (resolve) {
        var c = audio();
        if (!c) return resolve(null);
        c.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          function (b) { resolve(b); }, function () { resolve(null); });
      });
    }
    function playBuffer(buf) {
      var c = audio();
      if (!c || !buf) return false;
      var src = c.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start(0);
      return true;
    }
    function synth(name) {
      var c = audio();
      if (!c) return;
      var t = c.currentTime;
      function tone(f, at, dur, type, vol) {
        var o = c.createOscillator(), g = c.createGain();
        o.type = type || 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + at);
        g.gain.linearRampToValueAtTime(vol == null ? .28 : vol, t + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0008, t + at + dur);
        o.connect(g); g.connect(master);
        o.start(t + at); o.stop(t + at + dur + .03);
      }
      function noise(at, dur, vol) {
        var n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        var s = c.createBufferSource(), g = c.createGain();
        s.buffer = buf; g.gain.value = vol == null ? .12 : vol;
        s.connect(g); g.connect(master); s.start(t + at);
      }
      switch (name) {
        case 'startup': /* the long rising pad of the 1998 boot sound */
          [261.6, 329.6, 392.0, 523.3].forEach(function (f, i) { tone(f, 0.05 * i, 3.4, 'triangle', .16); });
          [523.3, 659.3, 784.0].forEach(function (f, i) { tone(f, 1.6 + .12 * i, 2.2, 'sine', .12); });
          break;
        case 'shutdown':
          [523.3, 392.0, 329.6, 261.6].forEach(function (f, i) { tone(f, .18 * i, .9, 'triangle', .16); });
          break;
        case 'ding':
          tone(880, 0, .28, 'sine', .3); tone(1318.5, .07, .30, 'sine', .22); break;
        case 'chime':
          [1046.5, 1318.5, 1568].forEach(function (f, i) { tone(f, i * .05, .5, 'sine', .18); }); break;
        case 'chord':
          [523.3, 659.3, 784.0].forEach(function (f) { tone(f, 0, 1.1, 'triangle', .12); }); break;
        case 'tada':
          [523.3, 659.3, 784, 1046.5].forEach(function (f, i) { tone(f, i * .12, .55, 'square', .1); }); break;
        case 'error':
          tone(160, 0, .3, 'square', .18); tone(120, .1, .34, 'square', .16); break;
        case 'exclamation': tone(660, 0, .3, 'triangle', .22); tone(440, .12, .3, 'triangle', .18); break;
        case 'question': tone(740, 0, .18, 'triangle', .2); tone(988, .13, .26, 'triangle', .18); break;
        case 'click': noise(0, .02, .06); break;
        case 'menu': noise(0, .012, .03); break;
        case 'minimize': tone(700, 0, .1, 'sine', .12); break;
        case 'maximize': tone(900, 0, .1, 'sine', .12); break;
        case 'restore': tone(520, 0, .12, 'sine', .12); break;
        case 'recycle': noise(0, .3, .1); tone(300, 0, .3, 'sawtooth', .06); break;
        case 'logon': [392, 523.3, 659.3].forEach(function (f, i) { tone(f, i * .09, .5, 'triangle', .14); }); break;
        case 'logoff': [659.3, 523.3, 392].forEach(function (f, i) { tone(f, i * .09, .5, 'triangle', .14); }); break;
        case 'notify': tone(1200, 0, .18, 'sine', .18); tone(1600, .06, .2, 'sine', .14); break;
        case 'balloon': tone(1568, 0, .12, 'sine', .16); break;
        default: noise(0, .02, .05);
      }
    }
    function playEvent(ev, force) {
      if (state.muted && !force) return;
      var path = schemePath(ev);
      if (path && path !== '(None)') {
        if (buffers[path]) { playBuffer(buffers[path]); return; }
        if (!rawCache[path]) rawCache[path] = W98.fs.readBytes(path);
        var bytes = rawCache[path];
        if (bytes && bytes.length > 40) {
          decodeBytes(bytes).then(function (buf) {
            if (buf) { buffers[path] = buf; playBuffer(buf); }
            else synth(synthMap[ev] || 'ding');
          });
          return;
        }
      }
      synth(synthMap[ev] || 'ding');
    }
    function tone(freq, ms, type) {
      var c = audio();
      if (!c || state.muted) return;
      var t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(.18, t);
      g.gain.exponentialRampToValueAtTime(.0008, t + (ms || 80) / 1000);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + (ms || 80) / 1000 + .02);
    }
    return {
      play: playEvent,
      tone: tone,
      beep: function () { playEvent('DefaultBeep'); },
      click: function () { playEvent('MenuCommand'); },
      error: function () { playEvent('SystemHand'); },
      startup: function () { playEvent('SystemStart', true); },
      shutdown: function () { playEvent('SystemExit', true); },
      setMuted: function (m) { state.muted = !!m; W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'MuteSounds', m ? '1' : '0'); },
      muted: function () { return state.muted; },
      setVolume: function (v) {
        state.volume = clamp(v, 0, 1);
        if (master) master.gain.value = state.volume;
        W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'Volume', String(Math.round(state.volume * 100)));
      },
      volume: function () { return state.volume; },
      resume: function () { audio(); },
      synthOnly: synth
    };
  })();

  /* ==================================================================== */
  /* app registry                                                         */
  /* ==================================================================== */
  W98.registerApp = function (def) {
    if (!def || !def.id) throw new Error('registerApp: id required');
    if (W98.apps[def.id] && W98.apps[def.id]._registered !== false) {
      console.warn('W98.registerApp: re-registering ' + def.id);
    }
    W98.apps[def.id] = def;
    if (W98.registry.indexOf(def) < 0) W98.registry.push(def);
    if (W98.booted) rebuildDesktopIcons();
    return def;
  };
  W98.getApp = function (id) { return W98.apps[id] || null; };

  /* ==================================================================== */
  /* window manager                                                       */
  /* ==================================================================== */
  var desktopEl, taskbarEl, tasksEl, windowsHolder;
  var zTop = 100;
  var activeWin = null;
  var rafCbs = [];
  var lastRafTs = 0;

  function clientSize(win) {
    return { w: win.el.offsetWidth, h: win.el.offsetHeight };
  }

  function makeTitleBar(win) {
    var bar = el('div', 'title-bar');
    var text = el('div', 'title-bar-text');
    text.appendChild(el('span', 'ti'));
    text.appendChild(el('span', 'tt'));
    bar.appendChild(text);
    var ctrls = el('div', 'title-bar-controls');
    var bMin = el('button'); bMin.setAttribute('aria-label', 'Minimize'); bMin.title = 'Minimize';
    var bMax = el('button'); bMax.setAttribute('aria-label', 'Maximize'); bMax.title = 'Maximize';
    var bClose = el('button'); bClose.setAttribute('aria-label', 'Close'); bClose.title = 'Close';
    if (win.def.minimizable === false) bMin.disabled = true;
    if (win.def.maximizable === false) bMax.disabled = true;
    ctrls.appendChild(bMin); ctrls.appendChild(bMax); ctrls.appendChild(bClose);
    bar.appendChild(ctrls);
    on(bMin, 'click', function (e) { e.stopPropagation(); win.minimize(); });
    on(bMax, 'click', function (e) {
      e.stopPropagation();
      if (win.state === 'max') win.restore(); else win.maximize();
    });
    on(bClose, 'click', function (e) { e.stopPropagation(); win.close(); });
    on(bar, 'mousedown', function (e) {
      if (e.target.closest('button')) return;
      if (e.button !== 0) return;
      win.focus();
      if (win.state === 'max') return;
      dragWindow(win, e);
    });
    on(bar, 'dblclick', function (e) {
      if (e.target.closest('button')) return;
      if (win.def.maximizable === false) return;
      if (win.state === 'max') win.restore(); else win.maximize();
    });
    win.barEl = bar;
    win.titleTextEl = text;
    win.iconSpan = text.querySelector('.ti');
    win.textSpan = text.querySelector('.tt');
    win.btnMin = bMin; win.btnMax = bMax;
    return bar;
  }

  function dragWindow(win, startEvent) {
    var sx = startEvent.clientX, sy = startEvent.clientY;
    var ox = win.root.offsetLeft, oy = win.root.offsetTop;
    var br = desktopEl.getBoundingClientRect();
    function move(e) {
      var nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = clamp(nx, -win.root.offsetWidth + 60, br.width - 60);
      ny = clamp(ny, 0, br.height - 24);
      win.root.style.left = nx + 'px';
      win.root.style.top = ny + 'px';
    }
    function up() {
      off(document, 'mousemove', move); off(document, 'mouseup', up);
      document.body.classList.remove('cur-move');
      win.emit('move', win.root.offsetLeft, win.root.offsetTop);
    }
    document.body.classList.add('cur-move');
    on(document, 'mousemove', move);
    on(document, 'mouseup', up);
  }

  function buildResizers(win) {
    if (win.def.resizable === false) return;
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (dir) {
      var h = el('div', 'w98-resize rz-' + dir);
      on(h, 'mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        win.focus();
        startResize(win, dir, e);
      });
      win.root.appendChild(h);
    });
  }

  function startResize(win, dir, startEvent) {
    var sx = startEvent.clientX, sy = startEvent.clientY;
    var ow = win.root.offsetWidth, oh = win.root.offsetHeight;
    var ox = win.root.offsetLeft, oy = win.root.offsetTop;
    var cw = win.el.offsetWidth;
    var ch = win.el.offsetHeight;
    var minW = win.def.minWidth || 120, minH = win.def.minHeight || 60;
    var dx0 = ow - cw, dy0 = oh - ch;
    win.root.classList.add('sizing');
    function move(e) {
      var dx = e.clientX - sx, dy = e.clientY - sy;
      var nw = cw, nh = ch, nx = ox, ny = oy;
      if (dir.indexOf('e') >= 0) nw = Math.max(minW, cw + dx);
      if (dir.indexOf('s') >= 0) nh = Math.max(minH, ch + dy);
      if (dir.indexOf('w') >= 0) { nw = Math.max(minW, cw - dx); nx = ox + (cw - nw); }
      if (dir.indexOf('n') >= 0) { nh = Math.max(minH, ch - dy); ny = oy + (ch - nh); }
      if (win.def.maxClientWidth) nw = Math.min(nw, win.def.maxClientWidth);
      if (win.def.maxClientHeight) nh = Math.min(nh, win.def.maxClientHeight);
      win.root.style.left = nx + 'px';
      win.root.style.top = ny + 'px';
      win.el.style.width = nw + 'px';
      win.el.style.height = nh + 'px';
      win.width = nw; win.height = nh;
      win.emit('resize', nw, nh);
    }
    function up() {
      off(document, 'mousemove', move); off(document, 'mouseup', up);
      win.root.classList.remove('sizing');
      win.emit('resizeend', win.width, win.height);
    }
    on(document, 'mousemove', move);
    on(document, 'mouseup', up);
    void dx0; void dy0;
  }

  function Window(def, args, opts) {
    opts = opts || {};
    var self = this;
    this.def = def;
    this.args = args;
    this.pid = K.procs.create(def.title || def.id);
    this.listeners = {};
    this.timers = [];
    this.state = 'normal';
    this.modal = !!opts.modal;
    this.modalParent = opts.parent || null;
    this.restoreBox = null;
    this.savedPath = null;
    this.built = false;

    var we = el('div', 'window w98-window');
    we.tabIndex = -1;
    this.root = we;              /* the frame, title bar, borders */
    we.dataset.pid = this.pid;

    var bar = makeTitleBar(this);
    we.appendChild(bar);

    var body = el('div', 'window-body');
    var client = el('div', 'w98-client');
    client.style.position = 'relative';
    client.style.width = (def.width || 400) + 'px';
    client.style.height = (def.height || 300) + 'px';
    client.style.overflow = def.scroll === true ? 'auto' : 'hidden';
    client.tabIndex = 0;
    body.appendChild(client);
    we.appendChild(body);
    this.el = client;            /* contract: win.el is the CLIENT area */
    this.bodyEl = body;

    // client-area size helpers
    this.getClient = function () { return client; };
    Object.defineProperty(this, 'clientEl', { get: function () { return client; } });
    this.width = def.width || 400;
    this.height = def.height || 300;

    buildResizers(this);

    on(we, 'mousedown', function (e) {
      if (opts.modal) return;
      var w = winByEl(we);
      if (w && w !== activeWin) w.focus();
    });
    on(client, 'keydown', function (e) { self.emit('key', e); });

    this.setTitle(def.title || def.id);
    this.setIcon(def.icon || 'unknown-file');

    /* place: cascade from the top-left, like Windows does */
    var d = openWindows.length;
    var br = desktopEl.getBoundingClientRect();
    var left = clamp((opts.left != null ? opts.left : 24 + (d % 9) * 22), 0, Math.max(0, br.width - 120));
    var top = clamp((opts.top != null ? opts.top : 16 + (d % 9) * 22), 0, Math.max(0, br.height - 60));
    we.style.left = left + 'px';
    we.style.top = top + 'px';
    windowsHolder.appendChild(we);

    openWindows.push(this);
    this.z = ++zTop;
    K.procs.setZ(this.pid, this.z);
    this.focus();
    this.emit('resize', this.width, this.height);
  }

  /* the window object that apps see */
  Window.prototype.setTitle = function (t) {
    this.title = t;
    if (this.textSpan) this.textSpan.textContent = t;
    var btn = taskButtonFor(this);
    if (btn) btn.querySelector('.lb').textContent = t;
    if (document.title.indexOf('Windows 98') === 0 || true) {
      /* the OS title bar shows the foreground app */
    }
    return this;
  };
  Window.prototype.setIcon = function (key) {
    this.iconKey = key;
    if (this.iconSpan) {
      this.iconSpan.innerHTML = '';
      var im = ICONS.el(key, 16);
      this.iconSpan.appendChild(im);
    }
    var btn = taskButtonFor(this);
    if (btn) {
      var ic = btn.querySelector('.tbi');
      if (ic) { ic.innerHTML = ''; ic.appendChild(ICONS.el(key, 16)); }
    }
    return this;
  };
  Window.prototype.setToolbar = function () { return this; };
  Window.prototype.on = function (ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    return fn;
  };
  Window.prototype.off = function (ev, fn) {
    var a = this.listeners[ev] || [];
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  Window.prototype.emit = function (ev) {
    var a = this.listeners[ev] || [];
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < a.length; i++) {
      try { a[i].apply(this, args); } catch (e) { console.error('window ' + this.def.id + ' ' + ev + ' handler', e); }
    }
  };
  Window.prototype.focus = function () {
    if (this.minimized) this.restore();
    if (activeWin === this) { this.z = ++zTop; this.root.style.zIndex = this.z; return; }
    var prev = activeWin;
    activeWin = this;
    this.z = ++zTop;
    this.root.style.zIndex = this.z;
    K.procs.focus(this.pid);
    K.procs.setZ(this.pid, this.z);
    for (var i = 0; i < openWindows.length; i++) {
      var w = openWindows[i];
      w.barEl.classList.toggle('inactive', w !== this);
      if (w !== this) { w.root.classList.remove('focused'); }
    }
    this.root.classList.add('focused');
    updateTaskbarStates();
    if (prev && prev !== this) prev.emit('blur');
    this.emit('focus');
    try { this.el.focus({ preventScroll: true }); } catch (e) { }
    return this;
  };
  Window.prototype.minimize = function () {
    if (this.minimized) return this;
    this.minimized = true;
    this.root.style.display = 'none';
    K.procs.setState(this.pid, K.PS.MIN);
    if (activeWin === this) {
      activeWin = null;
      var top = null;
      for (var i = 0; i < openWindows.length; i++) {
        var w = openWindows[i];
        if (!w.minimized && (!top || w.z > top.z)) top = w;
      }
      if (top) top.focus();
    }
    updateTaskbarStates();
    Sound.play('Minimize');
    this.emit('minimize');
    return this;
  };
  Window.prototype.restore = function () {
    if (this.state === 'max') {
      this.minimized = false;
      this.root.style.display = '';
      this.root.style.left = this.restoreBox.left + 'px';
      this.root.style.top = this.restoreBox.top + 'px';
      this.setClientSize(this.restoreBox.w, this.restoreBox.h);
      this.state = 'normal';
      this.root.classList.remove('maximized');
      if (this.btnMax) { this.btnMax.setAttribute('aria-label', 'Maximize'); this.btnMax.title = 'Maximize'; }
      this.emit('restore');
    }
    if (this.minimized) {
      this.minimized = false;
      this.root.style.display = '';
      this.emit('restore');
    }
    K.procs.setState(this.pid, K.PS.RUNNING);
    this.focus();
    return this;
  };
  Window.prototype.maximize = function () {
    if (this.state === 'max' || this.def.maximizable === false) return this;
    this.restoreBox = { left: this.root.offsetLeft, top: this.root.offsetTop, w: this.width, h: this.height };
    var br = desktopEl.getBoundingClientRect();
    var chrome = this.root.offsetHeight - this.el.offsetHeight;
    var chromeW = this.root.offsetWidth - this.el.offsetWidth;
    this.root.style.left = '0px';
    this.root.style.top = '0px';
    this.setClientSize(br.width - chromeW, br.height - chrome);
    this.state = 'max';
    this.root.classList.add('maximized');
    if (this.btnMax) { this.btnMax.setAttribute('aria-label', 'Restore'); this.btnMax.title = 'Restore'; }
    K.procs.setState(this.pid, K.PS.RUNNING);
    this.emit('restore');
    this.emit('resize', this.width, this.height);
    return this;
  };
  Window.prototype.setClientSize = function (w, h) {
    this.width = Math.round(w);
    this.height = Math.round(h);
    this.el.style.width = this.width + 'px';
    this.el.style.height = this.height + 'px';
    this.emit('resize', this.width, this.height);
    return this;
  };
  Window.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    for (var i = 0; i < this.timers.length; i++) K.clearTimer(this.timers[i]);
    this.timers = [];
    K.procs.destroy(this.pid);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    var idx = openWindows.indexOf(this);
    if (idx >= 0) openWindows.splice(idx, 1);
    var b = taskButtonFor(this);
    if (b && b.parentNode) b.parentNode.removeChild(b);
    if (activeWin === this) {
      activeWin = null;
      var top = null;
      for (var j = 0; j < openWindows.length; j++) {
        var w = openWindows[j];
        if (!w.minimized && (!top || w.z > top.z)) top = w;
      }
      if (top) top.focus();
    }
    updateTaskbarStates();
    Sound.play('WindowClose');
  };
  Window.prototype.saveTo = function (path) { this.savedPath = path; return this; };
  Window.prototype.claimKeys = function () { this.keysClaimed = true; return this; };
  Window.prototype.setInterval = function (fn, ms) {
    var self = this;
    var tid = K.setTimer(function () { if (!self.closed) fn(); }, ms, false);
    this.timers.push(tid);
    return tid;
  };
  Window.prototype.setTimeout = function (fn, ms) {
    var self = this;
    var tid = K.setTimer(function () { if (!self.closed) fn(); }, ms, true);
    this.timers.push(tid);
    return tid;
  };
  Window.prototype.clearInterval = function (tid) { K.clearTimer(tid); };
  Window.prototype.clearTimeout = function (tid) { K.clearTimer(tid); };

  /* menu bar ---------------------------------------------------------- */
  Window.prototype.setMenu = function (menuDef) {
    this.menuDef = menuDef || [];
    if (this.menuEl) this.menuEl.parentNode.removeChild(this.menuEl);
    if (!menuDef || !menuDef.length) { this.menuEl = null; return this; }
    var bar = el('div', 'w98-menubar');
    var self = this;
    this.menuButtons = [];
    menuDef.forEach(function (m) {
      var b = el('button');
      b.innerHTML = menuLabel(m.label);
      b.tabIndex = -1;
      on(b, 'mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        Sound.play('MenuPopup');
        var opening = !b.classList.contains('open');
        closeAllMenus();
        if (opening) openMenuFromBar(self, m, b);
      });
      on(b, 'mouseenter', function () {
        if (menuBarIsOpen(self) && !b.classList.contains('open')) {
          closeAllMenus();
          openMenuFromBar(self, m, b);
        }
      });
      bar.appendChild(b);
      self.menuButtons.push({ btn: b, def: m });
    });
    on(bar, 'mousedown', function (e) { e.preventDefault(); });
    this.menuEl = bar;
    var body = this.root.querySelector('.window-body');
    body.insertBefore(bar, body.firstChild);
    return this;
  };
  Window.prototype.bodyFirstChild = function () { return this.el.querySelector('.window-body').firstChild; };
  Window.prototype.setStatus = function (segments) {
    if (this.statusEl) { this.statusEl.parentNode.removeChild(this.statusEl); this.statusEl = null; }
    if (!segments) return this;
    var sb = el('div', 'w98-statusbar');
    segments.forEach(function (s, i) {
      var f = el('div', 'field', escapeHtml(s.text == null ? '' : s.text));
      if (s.width) { f.style.flex = '0 0 ' + s.width + 'px'; }
      else if (i < segments.length - 1 && !s.width) f.style.flex = '0 0 auto';
      if (s.sunken) f.style.boxShadow = 'inset 1px 1px grey, inset -1px -1px #dfdfdf';
      sb.appendChild(f);
    });
    this.statusEl = sb;
    this.root.querySelector('.window-body').appendChild(sb);
    return this;
  };

  var openWindows = [];

  function winByEl(e) {
    for (var i = 0; i < openWindows.length; i++) if (openWindows[i].root === e) return openWindows[i];
    return null;
  }
  W98.windows = openWindows;
  W98.focusedWindow = function () { return activeWin; };
  W98.windowByPid = function (pid) {
    for (var i = 0; i < openWindows.length; i++) if (openWindows[i].pid === pid) return openWindows[i];
    return null;
  };

  W98.launch = function (appId, args, opts) {
    var def = W98.apps[appId];
    if (!def) {
      W98.dialog.alert('Windows', 'Cannot find the file \'' + appId + '\' (or one of its components).\n' +
        'Make sure the path and filename are correct and that all required libraries are available.',
        'error');
      return null;
    }
    if (def.singleton) {
      for (var i = 0; i < openWindows.length; i++) {
        if (openWindows[i].def.id === appId) { openWindows[i].restore(); return openWindows[i]; }
      }
    }
    var w = new Window(def, args, opts || {});
    var hooks = null;
    W98.busy(1);
    try {
      hooks = def.create ? def.create(w, args) : null;
    } catch (e) {
      console.error('app ' + appId + ' failed to create', e);
      W98.dialog.alert('Program Error', (def.title || appId) + ' has encountered a problem and needs to close.\n' + e.message,
        'error');
      w.close();
      W98.busy(-1);
      return null;
    }
    W98.busy(-1);
    if (hooks && typeof hooks === 'object') {
      Object.keys(hooks).forEach(function (k) {
        if (typeof hooks[k] === 'function') w.on(k.replace(/^on/, '').toLowerCase(), hooks[k]);
      });
    }
    w.built = true;
    Sound.play('WindowOpen');
    return w;
  };

  /* busy cursor helper (reference counted) */
  var busyCount = 0;
  W98.busy = function (n) {
    busyCount += n;
    if (busyCount < 0) busyCount = 0;
    document.body.classList.toggle('cur-wait', busyCount > 0);
  };

  /* ==================================================================== */
  /* menus (drop-downs, submenus, context menus)                          */
  /* ==================================================================== */
  var menuStack = [];

  function closeAllMenus() {
    while (menuStack.length) {
      var m = menuStack.pop();
      if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
      if (m.onClose) m.onClose();
      if (m.barBtn) { m.barBtn.classList.remove('open'); }
    }
  }
  W98.closeMenus = closeAllMenus;
  function menuBarIsOpen(win) {
    return menuStack.some(function (m) { return m.win === win && m.fromBar; });
  }
  function openMenuFromBar(win, menuDef, btn) {
    var r = btn.getBoundingClientRect();
    showMenu(menuDef.items || [], r.left, r.bottom + 1, {
      win: win, fromBar: true, barBtn: btn, parentItems: menuDef, ownerBtn: btn
    });
  }
  function showMenu(items, x, y, opts) {
    opts = opts || {};
    var e = el('div', 'w98-menu');
    e.setAttribute('role', 'menu');
    var rec = { el: e, items: items, opts: opts, hoverIndex: -1 };
    e.style.left = x + 'px';
    e.style.top = y + 'px';
    e.style.minWidth = opts.minWidth ? opts.minWidth + 'px' : '';
    document.body.appendChild(e);
    menuStack.push(rec);
    fillMenu(rec);
    /* keep on screen */
    var r = e.getBoundingClientRect();
    if (r.right > innerWidth - 2) e.style.left = Math.max(2, innerWidth - r.width - 2) + 'px';
    if (r.bottom > innerHeight - 30) e.style.top = Math.max(2, y - r.height) + 'px';
    /* swallow the click that opened us */
    var swallow = function (ev) { ev.preventDefault(); ev.stopPropagation(); };
    on(e, 'mousedown', swallow, true);
    rec.close = function () { closeMenuFrom(rec); };
    return rec;
  }
  function closeMenuFrom(rec) {
    var i = menuStack.indexOf(rec);
    while (menuStack.length > i) {
      var m = menuStack.pop();
      if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
      if (m.opts && m.opts.barBtn) m.opts.barBtn.classList.remove('open');
      if (m.onClose) m.onClose();
    }
  }
  function fillMenu(rec) {
    var e = rec.el;
    e.innerHTML = '';
    rec.items.forEach(function (it, idx) {
      if (it.type === 'sep') { e.appendChild(el('div', 'w98-menu-sep')); return; }
      var row = el('div', 'w98-menu-item');
      row.dataset.idx = idx;
      if (it.checked) row.classList.add(it.type === 'radio' ? 'radio' : 'checked');
      if (it.disabled) row.classList.add('disabled');
      if (it.icon) {
        var ic = el('span', 'mi-icon');
        ic.appendChild(ICONS.el(it.icon, 16));
        row.appendChild(ic);
      }
      row.appendChild(el('span', 'mi-label', menuLabel(it.label)));
      if (it.accel) row.appendChild(el('span', 'mi-accel', it.accel));
      if (it.items) row.appendChild(el('span', 'mi-arrow', '&#9654;'));
      on(row, 'mouseenter', function () {
        rec.hoverIndex = idx;
        highlight(rec, row);
        var sub = menuStack[menuStack.indexOf(rec) + 1];
        if (sub) closeMenuFrom(sub);
        if (it.items && !it.disabled) {
          clearTimeout(rec._subT);
          rec._subT = setTimeout(function () { openSub(rec, it, row); }, 240);
        }
      });
      on(row, 'mouseup', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        activate(rec, it, idx);
      });
      e.appendChild(row);
    });
  }
  function highlight(rec, row) {
    var rows = rec.el.querySelectorAll('.w98-menu-item');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('hover', rows[i] === row);
  }
  function openSub(rec, it, row) {
    var r = row.getBoundingClientRect();
    showMenu(it.items, r.right - 4, r.top - 3, { parentRec: rec, minWidth: 120 });
  }
  function activate(rec, it, idx) {
    if (it.disabled) return;
    if (it.items) { return; }
    closeAllMenus();
    Sound.play('MenuCommand');
    if (it.onclick) {
      try { it.onclick(); } catch (e) { console.error('menu item failed: ' + it.label, e); }
    }
    if (rec.opts && rec.opts.onPick) rec.opts.onPick(it, idx);
  }
  function keyboardMenu(rec, key, e) {
    var items = rec.items, i;
    var rows = [].slice.call(rec.el.querySelectorAll('.w98-menu-item'));
    var cur = rec.hoverIndex;
    function moveTo(n) {
      do { n = (n + items.length) % items.length; }
      while (items[n] && items[n].type === 'sep' && rows.length > 1);
      rec.hoverIndex = n;
      var row = rec.el.querySelector('.w98-menu-item[data-idx="' + n + '"]');
      if (row) highlight(rec, row);
      return n;
    }
    if (key === 'ArrowDown') { e.preventDefault(); moveTo(cur + 1); }
    else if (key === 'ArrowUp') { e.preventDefault(); moveTo(cur - 1); }
    else if (key === 'ArrowRight') {
      var it = items[cur];
      if (it && it.items) {
        e.preventDefault();
        var row = rec.el.querySelector('.w98-menu-item[data-idx="' + cur + '"]');
        openSub(rec, it, row);
      }
    } else if (key === 'ArrowLeft') { e.preventDefault(); closeMenuFrom(rec); }
    else if (key === 'Enter') {
      e.preventDefault();
      var it2 = items[cur];
      if (it2) {
        if (it2.items) {
          var row2 = rec.el.querySelector('.w98-menu-item[data-idx="' + cur + '"]');
          openSub(rec, it2, row2);
        } else activate(rec, it2, cur);
      }
    } else if (key === 'Escape') { e.preventDefault(); closeAllMenus(); }
    for (i = 0; i < 0; i++) { }
  }
  W98.menu = {
    show: function (items, x, y, opts) { return showMenu(items, x, y, opts); },
    close: closeAllMenus,
    contextMenu: function (items, ev) {
      ev.preventDefault();
      closeAllMenus();
      Sound.play('MenuPopup');
      return showMenu(items, ev.clientX, ev.clientY, {});
    }
  };

  on(document, 'mousedown', function (e) {
    if (!menuStack.length) return;
    var inMenu = e.target.closest && e.target.closest('.w98-menu');
    var inBar = e.target.closest && e.target.closest('.w98-menubar');
    if (!inMenu && !inBar) closeAllMenus();
  }, true);
  on(document, 'keydown', function (e) {
    if (menuStack.length) {
      keyboardMenu(menuStack[menuStack.length - 1], e.key, e);
      if (e.key === 'Escape') { e.stopPropagation(); }
      return;
    }
    if (e.altKey && e.key && e.key.length === 1 && activeWin && activeWin.menuButtons) {
      var ch = e.key.toUpperCase();
      for (var i = 0; i < activeWin.menuButtons.length; i++) {
        var mb = activeWin.menuButtons[i];
        var lab = stripAmp(mb.def.label).toUpperCase();
        if (lab.charAt(0) === ch) {
          e.preventDefault();
          openMenuFromBar(activeWin, mb.def, mb.btn);
          return;
        }
      }
    }
  }, true);

  /* ==================================================================== */
  /* dialogs                                                              */
  /* ==================================================================== */
  var modalStack = [];

  function pushModal(win, ownerWin) {
    var rec = { win: win, owner: ownerWin };
    modalStack.push(rec);
    if (ownerWin && ownerWin.root) ownerWin.root.classList.add('modal-disabled');
    return rec;
  }
  function popModal(rec) {
    var i = modalStack.indexOf(rec);
    if (i >= 0) modalStack.splice(i, 1);
    if (rec.owner && rec.owner.root) rec.owner.root.classList.remove('modal-disabled');
    if (rec.owner) rec.owner.focus();
  }
  /* clicking outside a modal dialog dings and flashes, exactly like Windows */
  on(desktopEl || document, 'mousedown', function (e) {
    if (!modalStack.length) return;
    var top = modalStack[modalStack.length - 1];
    if (top.win.root.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    Sound.play('DefaultBeep');
    top.win.el.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
      { duration: 180, iterations: 2 }
    );
  }, true);

  function makeDialog(opts) {
    var def = {
      id: 'dialog-' + (opts.title || 'dlg'),
      title: opts.title || '',
      icon: opts.icon || null,
      width: opts.width || 300,
      height: opts.height || 100,
      resizable: !!opts.resizable,
      maximizable: false,
      minimizable: false,
      singleton: false,
      scroll: false
    };
    var w = new Window(def, null, { modal: true, left: opts.left, top: opts.top, parent: opts.owner });
    w.root.classList.add('w98-dialog', 'w98-raised');
    w.setMenu(null);
    /* message boxes appear centred on the desktop, like the real ones */
    if (opts.left == null) {
      setTimeout(function () {
        if (w.closed) return;
        var br = desktopEl.getBoundingClientRect();
        var dw = w.root.offsetWidth, dh = w.root.offsetHeight;
        w.root.style.left = Math.max(0, Math.round((br.width - dw) / 2)) + 'px';
        w.root.style.top = Math.max(0, Math.round((br.height - dh) / 2) - 24) + 'px';
      }, 0);
    }
    if (opts.icon) w.setIcon(opts.icon);
    var box = el('div', 'col');
    box.style.position = 'absolute';
    box.style.inset = '0';
    box.style.padding = '12px';
    box.style.overflow = 'auto';
    w.el.appendChild(box);
    w.box = box;
    return w;
  }

  var dlgSeq = 0;
  function messageBox(title, text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var kind = opts.kind || 'info';
      var iconKey = opts.icon || (kind === 'error' ? 'error' : kind === 'warn' ? 'warning'
        : kind === 'question' ? 'question' : 'info');
      var buttons = opts.buttons || ['OK'];
      var results = opts.results || buttons.map(function (b) { return b.toLowerCase() === 'yes' ? true : b.toLowerCase() === 'no' ? false : b; });
      var lines = String(text).split('\n');
      var width = opts.width || Math.max(260, Math.min(420, 180 + Math.max.apply(null, lines.map(function (l) { return l.length * 6; }))));
      var est = Math.ceil(Math.max.apply(null, lines.map(function (l) { return Math.ceil(l.length / ((width - 110) / 6)) || 1; }))) * 14 + 76 + (opts.extra ? 40 : 0);
      var w = makeDialog({ title: title, width: width, height: est, owner: opts.owner, left: opts.left, top: opts.top });
      var body = el('div', 'dlg-body');
      var ic = el('div', 'dlg-icon');
      ic.appendChild(ICONS.el(iconKey, 32));
      var tx = el('div', 'dlg-text');
      tx.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
      body.appendChild(ic); body.appendChild(tx);
      w.box.appendChild(body);
      var extraBox = null;
      if (opts.buildExtra) {
        extraBox = el('div');
        extraBox.style.margin = '10px 12px 0';
        opts.buildExtra(extraBox, w);
        w.box.appendChild(extraBox);
      }
      var btns = el('div', 'dlg-buttons');
      var defBtn = null;
      buttons.forEach(function (b, i) {
        var bt = el('button', i === 0 ? 'default' : '', escapeHtml(b));
        bt.style.minWidth = '75px';
        on(bt, 'click', function () { Sound.play('MenuCommand'); finish(results[i]); });
        if (i === 0) defBtn = bt;
        btns.appendChild(bt);
      });
      w.box.appendChild(btns);
      var rec = pushModal(w, opts.owner);
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        popModal(rec);
        w.close();
        resolve(val);
      }
      w.on('close', function () { if (!done) { done = true; popModal(rec); resolve(null); } });
      on(w.el, 'keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(results[results.length - 1] === true || results[results.length - 1] === false ? null : null); }
        else if (e.key === 'Enter' && defBtn) { e.preventDefault(); defBtn.click(); }
      });
      Sound.play(opts.sound || (kind === 'error' ? 'SystemHand' : kind === 'warn' ? 'SystemExclamation'
        : kind === 'question' ? 'SystemQuestion' : 'SystemAsterisk'));
      if (defBtn) setTimeout(function () { defBtn.focus(); }, 30);
    });
  }

  function promptDialog(title, text, defValue, opts) {
    opts = opts || {};
    var val = defValue == null ? '' : String(defValue);
    return new Promise(function (resolve) {
      var w = makeDialog({
        title: title, width: opts.width || 340, height: opts.height || (96 + String(text).split('\n').length * 14),
        owner: opts.owner, icon: 'question'
      });
      w.setIcon('question');
      w.box.style.padding = '12px';
      w.box.appendChild(el('div', '', escapeHtml(text).replace(/\n/g, '<br>')));
      var inp = el('input');
      inp.type = 'text';
      inp.value = val;
      inp.style.width = '100%';
      inp.style.marginTop = '10px';
      w.box.appendChild(inp);
      var btns = el('div', 'dlg-buttons');
      var okB = el('button', 'default', 'OK');
      var cancelB = el('button', '', 'Cancel');
      btns.appendChild(okB); btns.appendChild(cancelB);
      w.box.appendChild(btns);
      var rec = pushModal(w, opts.owner);
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        popModal(rec);
        w.close();
        resolve(v);
      }
      on(okB, 'click', function () { Sound.play('MenuCommand'); finish(inp.value); });
      on(cancelB, 'click', function () { Sound.play('MenuCommand'); finish(null); });
      on(inp, 'keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(inp.value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      });
      w.on('close', function () { finish(null); });
      Sound.play('SystemQuestion');
      setTimeout(function () { inp.focus(); inp.select(); }, 40);
    });
  }

  /* ---------------------------------------------------- file open/save */
  var lastDialogDir = 'C:\\My Documents';

  function fileDialog(opts) {
    var mode = opts.mode || 'open';
    var cur = W98.fs.norm ? W98.fs.norm(opts.path || lastDialogDir) : (opts.path || lastDialogDir);
    var picked = opts.name || '';
    var filter = opts.filter || '*.*';
    return new Promise(function (resolve) {
      var w = makeDialog({
        title: opts.title || (mode === 'open' ? 'Open' : 'Save As'),
        width: 470, height: 330, owner: opts.owner, resizable: true,
        icon: null
      });
      var box = w.box;
      box.style.padding = '8px';
      /* Look in */
      var row1 = el('div', 'row');
      row1.style.gap = '6px';
      row1.appendChild(el('div', '', 'Look in:'));
      var combo = el('input');
      combo.type = 'text';
      combo.value = cur;
      combo.style.flex = '1 1 auto';
      row1.appendChild(combo);
      box.appendChild(row1);

      var main = el('div', 'row');
      main.style.alignItems = 'stretch';
      main.style.gap = '6px';
      main.style.marginTop = '8px';
      main.style.height = '190px';
      var tree = el('ul', 'w98-tree');
      tree.style.width = '150px';
      tree.style.flex = '0 0 150px';
      var listWrap = el('div', 'w98-listbox');
      listWrap.style.flex = '1 1 auto';
      main.appendChild(tree);
      main.appendChild(listWrap);
      box.appendChild(main);

      var fileRow = el('div', 'row');
      fileRow.style.gap = '6px';
      fileRow.style.marginTop = '8px';
      fileRow.appendChild(el('div', '', 'File name:'));
      var nameIn = el('input');
      nameIn.type = 'text';
      nameIn.value = picked;
      nameIn.style.flex = '1 1 auto';
      fileRow.appendChild(nameIn);
      box.appendChild(fileRow);

      var typeRow = el('div', 'row');
      typeRow.style.gap = '6px';
      typeRow.style.marginTop = '6px';
      typeRow.appendChild(el('div', '', 'Files of type:'));
      var typeIn = el('input');
      typeIn.type = 'text';
      typeIn.value = filter;
      typeIn.style.flex = '1 1 auto';
      typeRow.appendChild(typeIn);
      box.appendChild(typeRow);

      var btns = el('div', 'dlg-buttons');
      btns.style.margin = '10px 0 0';
      btns.style.justifyContent = 'flex-end';
      var okB = el('button', 'default', mode === 'open' ? 'Open' : 'Save');
      var cancelB = el('button', '', 'Cancel');
      btns.appendChild(okB); btns.appendChild(cancelB);
      box.appendChild(btns);

      function listDir(p) {
        cur = p; combo.value = p; lastDialogDir = p;
        listWrap.innerHTML = '';
        var entries = W98.fs.list(p) || [];
        if (p.lastIndexOf('\\') > 2) {
          var up = el('div', 'w98-listitem');
          up.appendChild(ICONS.el('arrow-up', 16));
          up.appendChild(el('span', '', '..'));
          on(up, 'dblclick', function () { listDir(p.slice(0, p.lastIndexOf('\\')) || 'C:\\'); });
          on(up, 'click', function () { up.parentNode.querySelectorAll('.selected').forEach(function (n) { n.classList.remove('selected'); }); up.classList.add('selected'); });
          listWrap.appendChild(up);
        }
        entries.forEach(function (e2) {
          if (filter && filter !== '*.*' && !e2.dir) {
            var ext = filter.replace('*', '').toLowerCase();
            if (ext && e2.name.toLowerCase().indexOf(ext.replace('.', '.')) < 0 && e2.name.toLowerCase().indexOf(ext) < 0) return;
          }
          var row = el('div', 'w98-listitem');
          row.appendChild(ICONS.el(iconForEntry(e2), 16));
          row.appendChild(el('span', '', escapeHtml(e2.name)));
          on(row, 'click', function () {
            listWrap.querySelectorAll('.selected').forEach(function (n) { n.classList.remove('selected'); });
            row.classList.add('selected');
            if (!e2.dir || mode === 'save') nameIn.value = e2.name;
          });
          on(row, 'dblclick', function () {
            if (e2.dir) listDir((p.replace(/\\$/, '') + '\\' + e2.name));
            else { nameIn.value = e2.name; ok(); }
          });
          listWrap.appendChild(row);
        });
      }
      function buildTree() {
        var roots = [
          { label: 'Desktop', path: 'C:\\WINDOWS\\Desktop' },
          { label: '(C:)', path: 'C:\\' },
          { label: 'My Documents', path: 'C:\\My Documents' },
          { label: 'WINDOWS', path: 'C:\\WINDOWS' },
          { label: 'Program Files', path: 'C:\\Program Files' },
          { label: '3\u00bd Floppy (A:)', path: 'A:\\' }
        ];
        roots.forEach(function (r) {
          var li = el('li');
          li.appendChild(ICONS.el(r.path === 'A:\\' ? 'floppy-3-5' : (r.path === 'C:\\' ? 'hard-disk' : 'folder'), 16));
          li.appendChild(el('span', '', r.label));
          on(li, 'click', function () {
            tree.querySelectorAll('li').forEach(function (n) { n.classList.remove('sel'); });
            li.classList.add('sel');
            listDir(r.path);
          });
          on(li, 'dblclick', function () { listDir(r.path); });
          tree.appendChild(li);
        });
      }
      function ok() {
        var n = nameIn.value.trim();
        if (!n && mode === 'open') {
          messageBox('Open', 'Please type a file name.', { kind: 'warn', owner: w });
          return;
        }
        if (!n) { done = true; popModal(rec); w.close(); resolve(null); return; }
        var full = (cur.replace(/\\$/, '') + '\\' + n);
        if (mode === 'open' && !W98.fs.exists(full)) {
          messageBox('Open', 'Cannot find the file \'' + full + '\'.\nCheck the file name and try again.', { kind: 'error', owner: w });
          return;
        }
        done = true;
        popModal(rec); w.close();
        resolve(full);
      }
      var done = false;
      on(okB, 'click', function () { Sound.play('MenuCommand'); ok(); });
      on(cancelB, 'click', function () { done = true; popModal(rec); w.close(); resolve(null); });
      on(nameIn, 'keydown', function (e) { if (e.key === 'Enter') ok(); });
      on(combo, 'keydown', function (e) { if (e.key === 'Enter') listDir(combo.value); });
      var rec = pushModal(w, opts.owner);
      w.on('close', function () { if (!done) { done = true; popModal(rec); resolve(null); } });
      buildTree();
      listDir(cur);
      setTimeout(function () { nameIn.focus(); nameIn.select(); }, 40);
    });
  }

  /* ==================================================================== */
  /* paths, icons for files                                               */
  /* ==================================================================== */
  var EXT_ICON = {
    txt: 'text-file', log: 'text-file', ini: 'ini-file', bat: 'exe-file', sys: 'ini-file',
    bmp: 'bmp-file', png: 'bmp-file', jpg: 'bmp-file', gif: 'bmp-file', dib: 'bmp-file',
    exe: 'exe-file', com: 'exe-file', dll: 'dll-file', scr: 'display',
    wav: 'wav-file', mid: 'wav-file', mp3: 'media-player', avi: 'media-player',
    lnk: 'unknown-file', url: 'ie', htm: 'ie', html: 'ie', scr_: 'display'
  };
  function iconForEntry(e) {
    if (e.dir) return e.name === '..' ? 'arrow-up' : (e.open ? 'folder-open' : 'folder');
    var dot = e.name.lastIndexOf('.');
    var ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    if (e.isShortcut) return e.targetIcon || 'unknown-file';
    return EXT_ICON[ext] || 'unknown-file';
  }
  W98.iconForEntry = iconForEntry;
  W98.iconForFile = function (path) {
    var name = String(path).split('\\').pop();
    var isDir = W98.fs.isDir(path);
    return iconForEntry({ dir: isDir, name: name });
  };

  /* ==================================================================== */
  /* the public system API apps use                                       */
  /* ==================================================================== */
  var fsApi = {
    exists: function (p) { return K.fs ? K.fs.exists(p) : false; },
    isDir: function (p) { return K.fs ? K.fs.isDir(p) : false; },
    norm: function (p) { return K.normPath ? K.normPath(p) : p; },
    readText: function (p) { return K.fs ? K.fs.readText(p) : null; },
    writeText: function (p, s) { return K.fs ? K.fs.writeText(p, s) : null; },
    readBytes: function (p) { return K.fs ? K.fs.readBytes(p) : null; },
    writeBytes: function (p, b) { return K.fs ? K.fs.writeBytes(p, b) : null; },
    list: function (p) { return (K.fs && K.fs.list(p)) || []; },
    mkdir: function (p) { return K.fs ? K.fs.mkdir(p) : -1; },
    remove: function (p) { return K.fs ? K.fs.remove(p) : -1; },
    rename: function (a, b) { return K.fs ? K.fs.rename(a, b) : -1; },
    stat: function (p) { return K.fs ? K.fs.stat(p) : null; },
    join: function (a, b) {
      if (/^[A-Za-z]:\\?$/.test(a)) return a.replace(/\\?$/, '\\') + b;
      return a.replace(/\\$/, '') + '\\' + b;
    },
    parent: function (p) {
      var s = String(p).replace(/\\$/, '');
      var i = s.lastIndexOf('\\');
      return i <= 2 ? s.slice(0, 3) : s.slice(0, i);
    },
    drive: function (p) { return String(p).slice(0, 2).toUpperCase(); },
    /* time for display: the kernel stamps files with uptime, JS has the epoch */
    timeString: function (mtime) {
      var boot = W98.bootWallClock || Date.now();
      var d = new Date(boot - (K.stats().UPTIME - mtime));
      return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '/' + d.getFullYear() + ' ' +
        pad2(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12) + ':' + pad2(d.getMinutes()) + ' ' +
        (d.getHours() < 12 ? 'AM' : 'PM');
    }
  };
  W98.fs = fsApi;
  /* the registry is usable before kernel.wasm finishes booting: early writes
     are queued and replayed into the kernel once it is up. */
  var earlyReg = { store: {}, pending: [] };
  W98.reg = {
    get: function (path, name, dflt) {
      if (K.reg) return K.reg.get(path, name, dflt);
      var k = path + '\u0000' + name;
      for (var i = earlyReg.pending.length - 1; i >= 0; i--)
        if (earlyReg.pending[i].k === k) return earlyReg.pending[i].v;
      if (k in earlyReg.store) return earlyReg.store[k];
      return dflt === undefined ? null : dflt;
    },
    set: function (path, name, value) {
      if (K.reg) return K.reg.set(path, name, value);
      var k = path + '\u0000' + name;
      earlyReg.pending.push({ k: k, p: path, n: name, v: String(value) });
      return true;
    },
    del: function (path, name) {
      if (K.reg) return K.reg.del(path, name);
      var k = path + '\u0000' + name;
      earlyReg.pending = earlyReg.pending.filter(function (r) { return r.k !== k; });
      return true;
    },
    flushEarly: function () {
      if (!K.reg) return 0;
      var n = 0;
      earlyReg.pending.forEach(function (r) { K.reg.set(r.p, r.n, r.v); n++; });
      earlyReg.pending = [];
      return n;
    }
  };
  W98.tick = function () { return K.stats().UPTIME; };
  W98.now = function () { return Date.now(); };
  W98.stats = function () { return K.stats(); };
  /* the kernel object itself: apps that want the raw syscalls (the NT
     executive snapshot, a bugcheck, the module) read it from here */
  W98.kernel = K;
  W98.kernelProcs = function () { return K.procs.list(); };
  W98.moduleBytes = function () { return K.moduleBytes || 0; };
  W98.heapPeak = function () { return K.heapPeak ? K.heapPeak() : 0; };
  W98.regCount = function () { return K.regCount ? K.regCount() : 0; };
  W98.regEnum = function (i) { return K.regEnum ? K.regEnum(i) : null; };
  W98.regSearch = function (keyPrefix) {
    var out = [], n = W98.regCount(), pre = String(keyPrefix).toUpperCase();
    for (var i = 0; i < n; i++) {
      var r = W98.regEnum(i);
      if (!r) continue;
      if (!pre || r.path.toUpperCase().indexOf(pre) === 0 || r.path.toUpperCase() === pre) out.push(r);
    }
    return out;
  };
  W98.kernelLog = function () { return K.logText(); };
  W98.kernelMode = function () { return K.mode; };
  W98.raf = function (fn) {
    rafCbs.push(fn);
    return function () {
      var i = rafCbs.indexOf(fn);
      if (i >= 0) rafCbs.splice(i, 1);
    };
  };
  W98.sound = Sound;
  /* pointer trails (Control Panel > Mouse > Pointers) */
  var trails = { on: false, nodes: [], timer: null };
  W98.setPointerTrails = function (on) {
    trails.on = !!on;
    if (!trails.on) {
      trails.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      trails.nodes = [];
      if (trails.timer) { clearInterval(trails.timer); trails.timer = null; }
      return;
    }
    while (trails.nodes.length < 6) {
      var t = el('div');
      t.style.cssText = 'position:fixed;width:16px;height:16px;pointer-events:none;z-index:99999;' +
        'background:url("assets/cursors/arrow.png") no-repeat;background-size:16px 16px;image-rendering:pixelated';
      document.body.appendChild(t);
      trails.nodes.push(t);
    }
    var pos = trails.nodes.map(function () { return null; });
    if (!trails.timer) {
      trails.timer = setInterval(function () {
        var mx = 0, my = 0;
        for (var i = trails.nodes.length - 1; i >= 0; i--) {
          var n = trails.nodes[i];
          if (i === 0) { mx = trails.mx || mx; my = trails.my || my; }
          if (pos[i]) {
            var t = trails.nodes[i - 1] && pos[i - 1] ? pos[i - 1] : { x: mx, y: my };
            pos[i].x += (t.x - pos[i].x) * 0.45;
            pos[i].y += (t.y - pos[i].y) * 0.45;
            n.style.left = pos[i].x + 'px';
            n.style.top = pos[i].y + 'px';
            n.style.opacity = String(0.8 - i * 0.12);
          }
        }
      }, 40);
    }
    on(document, 'mousemove', function (e) {
      trails.mx = e.clientX; trails.my = e.clientY;
      if (trails.nodes[0]) {
        trails.nodes[0].style.left = (e.clientX + 4) + 'px';
        trails.nodes[0].style.top = (e.clientY + 4) + 'px';
        trails.nodes[0].style.opacity = '0.9';
      }
      for (var i = 1; i < trails.nodes.length; i++) if (!pos[i]) pos[i] = { x: e.clientX, y: e.clientY };
    });
  };


  W98.icons = ICONS;

  W98.dialog = {
    alert: function (title, text, kind) {
      var k = typeof kind === 'string' ? kind : (kind || 'info');
      return messageBox(title, text, { kind: k === 'warn' ? 'warn' : k, buttons: ['OK'], results: [null] });
    },
    error: function (title, text) { return messageBox(title, text, { kind: 'error', buttons: ['OK'], results: [null] }); },
    confirm: function (title, text, opts) {
      var yesNo = !opts || opts.style !== 'okcancel';
      var buttons = yesNo ? ['Yes', 'No'] : ['OK', 'Cancel'];
      return messageBox(title, text, { kind: 'question', buttons: buttons, results: yesNo ? [true, false] : ['ok', null] })
        .then(function (r) { return yesNo ? r === true : r === 'ok'; });
    },
    prompt: promptDialog,
    fileOpen: function (o) { o = o || {}; o.mode = 'open'; return fileDialog(o); },
    fileSave: function (o) { o = o || {}; o.mode = 'save'; return fileDialog(o); },
    messageBox: messageBox,
    custom: makeDialog
  };

  W98.aboutDialog = function (app) {
    var def = W98.apps[app] || app;
    var text = 'Microsoft ' + (def.title || def.id) + '\n' +
      'Version ' + W98.version + ' (kernel.wasm build)\n' +
      'Copyright \u00a9 1981-1998 Microsoft Corporation\n\n' +
      'This product is licensed to:\n   ' + USER + '\n\n' +
      'Physical memory available to Windows: ' +
      Math.round(W98.stats().HEAP_FREE / 1024) + ' KB free of ' +
      Math.round(W98.stats().HEAP_SIZE / 1024) + ' KB';
    return messageBox('About ' + (def.title || 'Windows'), text, {
      kind: 'info', buttons: ['OK'], results: [null], icon: def.icon || 'info'
    });
  };

  /* ==================================================================== */
  /* boot: seed the volume, build the desktop                             */
  /* ==================================================================== */
  var medFiles = [];

  function seedMedia() {
    /* the vendored sound scheme is copied into C:\WINDOWS\MEDIA so Media
       Player and the Sounds applet see real files, exactly as on Windows. */
    var man = ICONS.manifest && ICONS.manifest();
    var sounds = (man && man.sounds) || null;
    var names = sounds ? Object.keys(sounds) : ['startup', 'shutdown', 'ding', 'chime', 'chord', 'tada',
      'error', 'exclamation', 'question', 'click', 'logon', 'logoff', 'recycle', 'notify', 'menu',
      'minimize', 'maximize', 'close', 'restore', 'balloon'];
    var scheme = {
      SystemStart: 'startup.wav', SystemExit: 'shutdown.wav', DefaultBeep: 'ding.wav',
      SystemAsterisk: 'chime.wav', SystemHand: 'error.wav', SystemExclamation: 'exclamation.wav',
      SystemQuestion: 'question.wav', MenuCommand: 'click.wav', MenuPopup: 'menu.wav',
      WindowOpen: 'click.wav', WindowClose: 'close.wav', Minimize: 'minimize.wav',
      Maximize: 'maximize.wav', RestoreUp: 'restore.wav', RestoreDown: 'restore.wav',
      Recycle: 'recycle.wav', SystemLogon: 'logon.wav', SystemLogoff: 'logoff.wav',
      Chord: 'chord.wav', Tada: 'tada.wav', Balloon: 'balloon.wav', Notify: 'notify.wav'
    };
    var need = names.filter(function (n) {
      return !W98.fs.exists('C:\\WINDOWS\\MEDIA\\' + n.toUpperCase() + '.WAV');
    });
    if (!need.length) return Promise.resolve(0);
    return Promise.all(need.map(function (n) {
      var rel = (sounds && sounds[n] && sounds[n].file) || ('sounds/' + n + '.wav');
      return fetch('assets/' + rel).then(function (r) {
        if (!r.ok) throw new Error('missing ' + rel);
        return r.arrayBuffer();
      }).then(function (buf) {
        W98.fs.writeBytes('C:\\WINDOWS\\MEDIA\\' + n.toUpperCase() + '.WAV', new Uint8Array(buf));
        medFiles.push(n.toUpperCase() + '.WAV');
        return 1;
      }).catch(function () { return 0; });
    })).then(function (a) {
      a.reduce(function (x, y) { return x + y; }, 0);
      /* point the AppEvents scheme at the real files (Control Panel > Sounds) */
      Object.keys(scheme).forEach(function (ev) {
        var cur = W98.reg.get('HKEY_CURRENT_USER\\AppEvents\\Schemes\\Apps\\.Default\\' + ev, '.Current', null);
        if (cur === null) {
          var p = 'C:\\WINDOWS\\MEDIA\\' + scheme[ev].toUpperCase().replace('.WAV', '.wav');
          W98.reg.set('HKEY_CURRENT_USER\\AppEvents\\Schemes\\Apps\\.Default\\' + ev, '.Current', p);
        }
      });
      return medFiles.length;
    });
  }

  function seedSampleFiles() {
    var bmpPath = 'C:\\My Documents\\My Pictures\\Blue Hills.bmp';
    /* the bitmap is binary: it must be written as bytes, and a file left behind
       by an older build (which wrote the byte array as text) is repaired here */
    var bmpOk = false;
    try {
      var head = W98.fs.readBytes(bmpPath);
      bmpOk = !!(head && head.length > 2 && head[0] === 0x42 && head[1] === 0x4D);
    } catch (e) { bmpOk = false; }
    if (bmpOk) return;
    /* a small hand-built bitmap so Paint opens something real */
    var cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    var g = cv.getContext('2d');
    var sky = g.createLinearGradient(0, 0, 0, 80);
    sky.addColorStop(0, '#3050a0'); sky.addColorStop(1, '#a8c8f0');
    g.fillStyle = sky; g.fillRect(0, 0, 160, 80);
    g.fillStyle = '#ffffff';
    [[30, 18, 22], [52, 22, 16], [110, 14, 26]].forEach(function (c) {
      g.beginPath(); g.arc(c[0], c[1], c[2], 0, 7); g.arc(c[0] + c[2] * .7, c[1] + 4, c[2] * .7, 0, 7); g.fill();
    });
    g.fillStyle = '#3a8040';
    g.beginPath(); g.moveTo(0, 80); g.lineTo(50, 46); g.lineTo(96, 80); g.closePath(); g.fill();
    g.fillStyle = '#2a6030';
    g.beginPath(); g.moveTo(60, 80); g.lineTo(110, 52); g.lineTo(160, 80); g.closePath(); g.fill();
    g.fillStyle = '#208020'; g.fillRect(0, 80, 160, 40);
    g.fillStyle = '#186018'; g.fillRect(0, 104, 160, 16);
    try {
      W98.fs.writeBytes(bmpPath, bmpEncode(g.getImageData(0, 0, 160, 120)));
    } catch (e) { }
    W98.fs.writeText('C:\\My Documents\\Notes.txt',
      'Shopping list\r\n------------\r\n- 64 MB of RAM (it will never be enough)\r\n' +
      '- one of those new 56k modems\r\n- CD-R pack\r\n- check on Y2K\r\n');
    W98.fs.writeText('C:\\WINDOWS\\Desktop\\MS-DOS-Prompt.lnk', 'app:cmd');
  }

  /* minimal 24-bit BMP writer (also used by Paint through W98.bmp) */
  function bmpEncode(imageData) {
    var w = imageData.width, h = imageData.height;
    var rowSize = (w * 3 + 3) & ~3;
    var size = 54 + rowSize * h;
    var buf = new Uint8Array(size);
    var dv = new DataView(buf.buffer);
    buf[0] = 0x42; buf[1] = 0x4D;
    dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
    var p = 54;
    for (var y = h - 1; y >= 0; y--) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        buf[p++] = imageData.data[i + 2];
        buf[p++] = imageData.data[i + 1];
        buf[p++] = imageData.data[i];
      }
      p += rowSize - w * 3;
    }
    return buf;
  }
  W98.bmpEncode = bmpEncode;

  /* ==================================================================== */
  /* main loop                                                            */
  /* ==================================================================== */
  var clockEl = null, lastClock = '', lastHeartbeat = 0;
  function heartbeat(ts) {
    var dt = lastRafTs ? Math.min(200, ts - lastRafTs) : 16;
    lastRafTs = ts;
    lastHeartbeat = ts;
    /* the kernel heartbeat: advances its clock, expires timers, charges the
       scheduler. Everything time-based in the desktop hangs off this. */
    K.tick(Math.floor(ts));
    for (var i = rafCbs.length - 1; i >= 0; i--) {
      try { rafCbs[i](dt); } catch (e) { console.error('raf cb', e); }
    }
    if (clockEl) {
      var d = new Date();
      var s = (d.getHours() % 12 === 0 ? 12 : d.getHours() % 12) + ':' + pad2(d.getMinutes()) + ' ' + (d.getHours() < 12 ? 'AM' : 'PM');
      if (s !== lastClock) { lastClock = s; clockEl.textContent = s; }
    }
  }
  function mainLoop(ts) {
    heartbeat(ts || global.performance.now());
    global.requestAnimationFrame(mainLoop);
  }
  /* Browsers throttle requestAnimationFrame to a standstill in a background
     tab, which would freeze every kernel timer. This coarse interval keeps the
     kernel clock and its timer queue honest when that happens. */
  setInterval(function () {
    var now = global.performance.now();
    if (now - lastHeartbeat > 80) heartbeat(now);
  }, 32);

  /* ==================================================================== */
  /* exports used by the desktop/taskbar file                             */
  /* ==================================================================== */
  W98.shell = {
    desktop: function () { return desktopEl; },
    taskbar: function () { return taskbarEl; },
    tasks: function () { return tasksEl; },
    windowsHolder: function () { return windowsHolder; },
    setWindowRefs: function (refs) {
      desktopEl = refs.desktop; taskbarEl = refs.taskbar; tasksEl = refs.tasks;
      windowsHolder = refs.holder; clockEl = refs.clock;
    },
    startLoop: function () { global.requestAnimationFrame(mainLoop); },
    rebuildDesktopIcons: function () { rebuildDesktopIcons(); },
    seedMedia: seedMedia,
    seedSampleFiles: seedSampleFiles,
    Sound: Sound,
    USER: USER,
    windows: openWindows,
    activeWindow: function () { return activeWin; },
    setActive: function (w) { activeWin = w; }
  };
  function rebuildDesktopIcons() { if (W98.onRebuildDesktop) W98.onRebuildDesktop(); }
  function taskButtonFor(win) {
    var btns = tasksEl ? tasksEl.querySelectorAll('.tbtn') : [];
    for (var i = 0; i < btns.length; i++) if (btns[i].dataset.pid === String(win.pid)) return btns[i];
    return null;
  }
  function updateTaskbarStates() {
    if (W98.onTaskbarUpdate) W98.onTaskbarUpdate();
  }
  W98.shell.updateTaskbar = updateTaskbarStates;
  W98.shell.taskButtonFor = taskButtonFor;
})(window);
