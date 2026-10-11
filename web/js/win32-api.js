/* ============================================================================
   win32-api.js — the host side of the Win32 import boundary
   ----------------------------------------------------------------------------
   A PE runner supplies machine-code execution and calls this file whenever an
   imported user32/gdi32/kernel32 symbol is reached.  The bridge deliberately
   has no dependency on a PE decoder: handles are stable integers, strings are
   JavaScript strings (the runner performs guest-memory decoding), and output
   buffers are Uint8Array/DataView friendly objects.  This keeps the ABI useful
   to an interpreter as well as to tests running without a document.

   In a browser, CreateWindowExA creates a regular W98 shell window containing
   a canvas.  In a worker or Node, the same calls use a bounded RGBA virtual
   canvas, so GUI programs can run their message and drawing code headlessly.
   The implementation is intentionally deterministic; it does not use network
   APIs or host filesystem paths.
   ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98 || null;
  var hasDocument = !!(global.document && global.document.createElement);
  var nextRuntime = 1;
  var now0 = Date.now();

  var C = {
    /* PE machine values. */
    IMAGE_FILE_MACHINE_I386: 0x014c,
    IMAGE_FILE_MACHINE_AMD64: 0x8664,
    /* window messages */
    WM_NULL: 0x0000, WM_CREATE: 0x0001, WM_DESTROY: 0x0002,
    WM_MOVE: 0x0003, WM_SIZE: 0x0005, WM_PAINT: 0x000f,
    WM_CLOSE: 0x0010, WM_QUIT: 0x0012, WM_ERASEBKGND: 0x0014,
    WM_SHOWWINDOW: 0x0018, WM_SETTEXT: 0x000c, WM_GETTEXT: 0x000d,
    WM_USER: 0x0400, WM_APP: 0x8000,
    WM_KEYDOWN: 0x0100, WM_KEYUP: 0x0101, WM_CHAR: 0x0102,
    WM_MOUSEMOVE: 0x0200, WM_LBUTTONDOWN: 0x0201, WM_LBUTTONUP: 0x0202,
    WM_RBUTTONDOWN: 0x0204, WM_RBUTTONUP: 0x0205,
    WM_MBUTTONDOWN: 0x0207, WM_MBUTTONUP: 0x0208,
    WM_NCCREATE: 0x0081, WM_NCDESTROY: 0x0082,
    /* ShowWindow commands. */
    SW_HIDE: 0, SW_SHOWNORMAL: 1, SW_NORMAL: 1, SW_SHOWMINIMIZED: 2,
    SW_SHOWMAXIMIZED: 3, SW_MAXIMIZE: 3, SW_SHOWNOACTIVATE: 4,
    SW_SHOW: 5, SW_MINIMIZE: 6, SW_SHOWMINNOACTIVE: 7, SW_SHOWNA: 8,
    SW_RESTORE: 9,
    /* message results and common handles */
    IDOK: 1, IDCANCEL: 2, IDYES: 6, IDNO: 7,
    STD_INPUT_HANDLE: -10, STD_OUTPUT_HANDLE: -11, STD_ERROR_HANDLE: -12,
    /* GDI raster operation and stock objects. */
    SRCCOPY: 0x00cc0020, BLACKNESS: 0x00000042, WHITENESS: 0x00ff0062,
    NULL_BRUSH: 5, WHITE_BRUSH: 0, LTGRAY_BRUSH: 1, GRAY_BRUSH: 2,
    DKGRAY_BRUSH: 3, BLACK_BRUSH: 4, NULL_PEN: 8, WHITE_PEN: 6,
    BLACK_PEN: 7, SYSTEM_FONT: 13,
    COLOR_WINDOW: 5, COLOR_WINDOWTEXT: 8, COLOR_BTNFACE: 15,
    COLOR_BTNTEXT: 18, COLOR_HIGHLIGHT: 13, COLOR_HIGHLIGHTTEXT: 14,
    ERROR_SUCCESS: 0, ERROR_FILE_NOT_FOUND: 2, ERROR_INVALID_HANDLE: 6,
    ERROR_INVALID_PARAMETER: 87, ERROR_CALL_NOT_IMPLEMENTED: 120,
    ERROR_PROC_NOT_FOUND: 127, ERROR_ALREADY_EXISTS: 183,
    PAGE_READWRITE: 4, MEM_COMMIT: 0x1000, MEM_RESERVE: 0x2000
  };

  function own(o, k, v) { o[k] = v; return v; }
  function text(v) { return v == null ? '' : String(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function low(s) { return text(s).toLowerCase().replace(/\.dll$/, ''); }
  function asNumber(v, d) { v = Number(v); return isFinite(v) ? v : (d || 0); }
  function colorRGB(c) {
    c = (Number(c) >>> 0);
    /* COLORREF is 0x00bbggrr; canvas pixels are RGBA. */
    return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, 255];
  }
  function rgbColor(r, g, b) { return ((b & 255) << 16) | ((g & 255) << 8) | (r & 255); }
  function rectOf(r) {
    r = r || {};
    return { left: asNumber(r.left), top: asNumber(r.top), right: asNumber(r.right), bottom: asNumber(r.bottom) };
  }
  function setOutRect(out, r) {
    if (!out) return;
    out.left = r.left; out.top = r.top; out.right = r.right; out.bottom = r.bottom;
  }
  function setOut(out, value) {
    if (!out) return;
    if (typeof out === 'object' && out.length != null) out[0] = value;
    else if (typeof out === 'object') out.value = value;
  }

  function fillSurface(s, rgba) {
    var p = s.pixels, i;
    for (i = 0; i < p.length; i += 4) {
      p[i] = rgba[0]; p[i + 1] = rgba[1]; p[i + 2] = rgba[2]; p[i + 3] = rgba[3];
    }
    if (s.ctx) { s.ctx.fillStyle = 'rgba(' + rgba[0] + ',' + rgba[1] + ',' + rgba[2] + ',' + (rgba[3] / 255) + ')'; s.ctx.fillRect(0, 0, s.width, s.height); }
  }

  function Runtime(options) {
    options = options || {};
    this.id = nextRuntime++;
    this.options = options;
    this.lastError = C.ERROR_SUCCESS;
    this.exitCode = 0;
    this.exited = false;
    this._nextHandle = 0x100 + this.id * 0x1000;
    this._nextAtom = 1;
    this._objects = Object.create(null);
    this._classes = Object.create(null);
    this._windows = Object.create(null);
    this._messages = [];
    this._files = Object.create(null);
    this._memory = Object.create(null);
    this._guestAllocs = Object.create(null);
    this._console = { input: [], output: '', title: '' };
    this._commandLine = text(options.commandLine || '');
    this._env = options.environment || Object.create(null);
    this._defaultWindow = null;
    this._cpu = null;             /* active PE interpreter, when present */
    this.constants = C;
    this.user32 = this._makeUser32();
    this.gdi32 = this._makeGdi32();
    this.kernel32 = this._makeKernel32();
    this.exports = { user32: this.user32, gdi32: this.gdi32, kernel32: this.kernel32 };
    this.modules = { kernel32: 1, user32: 2, gdi32: 3, advapi32: 4, msvcrt: 5 };
  }

  Runtime.prototype._fail = function (code) { this.lastError = code; return 0; };
  Runtime.prototype._ok = function () { this.lastError = C.ERROR_SUCCESS; };
  Runtime.prototype._handle = function (kind, value) {
    var h = this._nextHandle++;
    this._objects[h] = { kind: kind, value: value };
    return h;
  };
  Runtime.prototype._obj = function (h, kind) {
    var o = this._objects[h];
    if (!o || (kind && o.kind !== kind)) return null;
    return o.value;
  };
  Runtime.prototype._drop = function (h) { delete this._objects[h]; };
  Runtime.prototype._surface = function (w, h, canvas) {
    w = clamp(Math.floor(asNumber(w, 1)), 1, 4096);
    h = clamp(Math.floor(asNumber(h, 1)), 1, 4096);
    var s = { width: w, height: h, pixels: new Uint8ClampedArray(w * h * 4), canvas: canvas || null, ctx: null };
    if (canvas && canvas.getContext) {
      try { s.ctx = canvas.getContext('2d'); s.ctx.imageSmoothingEnabled = false; } catch (e) { s.ctx = null; }
    }
    fillSurface(s, [255, 255, 255, 255]);
    return s;
  };
  Runtime.prototype._dcForWindow = function (win) {
    if (win.dc) return win.dc;
    win.surface = this._surface(win.width, win.height, win.canvas);
    win.dc = { surface: win.surface, bitmap: null, brush: this._stock(C.WHITE_BRUSH), pen: this._stock(C.BLACK_PEN), x: 0, y: 0 };
    win.hdc = this._handle('dc', win.dc);
    return win.dc;
  };
  Runtime.prototype._stock = function (which) {
    var key = 'stock:' + which, o = this._stockObjects && this._stockObjects[key];
    if (o) return o;
    this._stockObjects = this._stockObjects || Object.create(null);
    var v;
    if (which === C.NULL_BRUSH || which === C.WHITE_BRUSH || which === C.LTGRAY_BRUSH || which === C.GRAY_BRUSH || which === C.DKGRAY_BRUSH || which === C.BLACK_BRUSH) {
      var c = which === C.WHITE_BRUSH ? 0x00ffffff : which === C.BLACK_BRUSH ? 0 : which === C.GRAY_BRUSH ? 0x00808080 : which === C.LTGRAY_BRUSH ? 0x00c0c0c0 : which === C.DKGRAY_BRUSH ? 0x00404040 : 0;
      v = { kind: 'brush', color: c, nullObject: which === C.NULL_BRUSH };
    } else {
      var pc = which === C.WHITE_PEN ? 0x00ffffff : 0;
      v = { kind: 'pen', color: pc, width: 1, nullObject: which === C.NULL_PEN };
    }
    this._stockObjects[key] = v;
    return v;
  };

  Runtime.prototype._openShellWindow = function (win) {
    var self = this;
    if (!W98 || !W98.registerApp || !W98.launch || !W98.shell || !hasDocument) return;
    var id = 'win32-' + this.id + '-' + win.hwnd;
    var app = {
      id: id, title: win.title || 'Win32 program', icon: 'exe-file',
      width: win.width, height: win.height, minWidth: 80, minHeight: 60,
      desktop: false, singleton: false,
      create: function (w) {
        win.hostWindow = w;
        var canvas = document.createElement('canvas');
        canvas.width = win.width; canvas.height = win.height;
        canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
        canvas.tabIndex = 0;
        w.el.appendChild(canvas); win.canvas = canvas;
        self._dcForWindow(win);
        function post(type, ev) {
          var r = canvas.getBoundingClientRect(), x = Math.round(ev.clientX - r.left), y = Math.round(ev.clientY - r.top);
          self.postMessage(win.hwnd, type, ev.button || 0, ((y & 0xffff) << 16) | (x & 0xffff));
        }
        canvas.addEventListener('mousemove', function (e) { post(C.WM_MOUSEMOVE, e); });
        canvas.addEventListener('mousedown', function (e) { post(e.button === 2 ? C.WM_RBUTTONDOWN : C.WM_LBUTTONDOWN, e); });
        canvas.addEventListener('mouseup', function (e) { post(e.button === 2 ? C.WM_RBUTTONUP : C.WM_LBUTTONUP, e); });
        canvas.addEventListener('keydown', function (e) { self.postMessage(win.hwnd, C.WM_KEYDOWN, e.keyCode || e.which || 0, 0); });
        canvas.addEventListener('keyup', function (e) { self.postMessage(win.hwnd, C.WM_KEYUP, e.keyCode || e.which || 0, 0); });
        return { onclose: function () { self._destroyWindow(win.hwnd, true); } };
      }
    };
    try { W98.registerApp(app); win.hostWindow = W98.launch(id); } catch (e) { win.hostWindow = null; }
  };

  Runtime.prototype._destroyWindow = function (hwnd, fromShell) {
    var w = this._windows[hwnd];
    if (!w || w.destroying) return 0;
    w.destroying = true;
    this.sendMessage(hwnd, C.WM_DESTROY, 0, 0);
    this.sendMessage(hwnd, C.WM_NCDESTROY, 0, 0);
    if (w.hostWindow && !fromShell && w.hostWindow.close) { try { w.hostWindow.close(); } catch (e) {} }
    delete this._windows[hwnd];
    if (this._defaultWindow === hwnd) this._defaultWindow = null;
    return 1;
  };

  /* --------------------------- user32 -------------------------------- */
  Runtime.prototype._makeUser32 = function () {
    var r = this, u = {};
    u.RegisterClassExA = function (spec) { return r.registerClass(spec); };
    u.RegisterClassExW = u.RegisterClassExA;
    u.RegisterClassA = u.RegisterClassExA; u.RegisterClassW = u.RegisterClassExA;
    u.UnregisterClassA = function (name) { delete r._classes[text(name)]; return 1; };
    u.UnregisterClassW = u.UnregisterClassA;
    u.CreateWindowExA = function () { return r.createWindow.apply(r, arguments); };
    u.CreateWindowExW = u.CreateWindowExA;
    u.DestroyWindow = function (h) { return r._destroyWindow(h, false); };
    u.ShowWindow = function (h, c) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); var was = w.visible ? 1 : 0; w.visible = c !== C.SW_HIDE; if (w.hostWindow && w.hostWindow.root) w.hostWindow.root.style.display = w.visible ? '' : 'none'; r.postMessage(h, C.WM_SHOWWINDOW, w.visible ? 1 : 0, 0); return was; };
    u.UpdateWindow = function (h) { return r.sendMessage(h, C.WM_PAINT, 0, 0) >= 0 ? 1 : 0; };
    u.GetMessageA = function (m, h, lo, hi) { return r.getMessage(m, h, lo, hi); };
    u.GetMessageW = u.GetMessageA;
    u.PeekMessageA = function (m, h, lo, hi, remove) { return r.peekMessage(m, h, lo, hi, remove); };
    u.PeekMessageW = u.PeekMessageA;
    u.TranslateMessage = function (m) { if (m && m.message === C.WM_KEYDOWN && m.wParam >= 32 && m.wParam < 0x110000) r.postMessage(m.hwnd, C.WM_CHAR, m.wParam, m.lParam); return 1; };
    u.DispatchMessageA = function (m) { return r.dispatchMessage(m); }; u.DispatchMessageW = u.DispatchMessageA;
    u.DefWindowProcA = function (h, msg, wp, lp) { return r.defWindowProc(h, msg, wp, lp); }; u.DefWindowProcW = u.DefWindowProcA;
    u.PostMessageA = function (h, msg, wp, lp) { return r.postMessage(h, msg, wp, lp); }; u.PostMessageW = u.PostMessageA;
    u.SendMessageA = function (h, msg, wp, lp) { return r.sendMessage(h, msg, wp, lp); }; u.SendMessageW = u.SendMessageA;
    u.PostQuitMessage = function (code) { r._messages.push({ hwnd: 0, message: C.WM_QUIT, wParam: code || 0, lParam: 0 }); return 1; };
    u.SetWindowTextA = function (h, s) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); w.title = text(s); if (w.hostWindow && w.hostWindow.setTitle) w.hostWindow.setTitle(w.title); return 1; }; u.SetWindowTextW = u.SetWindowTextA;
    u.GetWindowTextA = function (h, out, cap) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); var s = w.title.slice(0, Math.max(0, asNumber(cap, 0) - 1)); if (out && typeof out === 'object') out.value = s; return s.length; }; u.GetWindowTextW = u.GetWindowTextA;
    u.GetWindowTextLengthA = function (h) { var w = r._windows[h]; return w ? w.title.length : r._fail(C.ERROR_INVALID_HANDLE); }; u.GetWindowTextLengthW = u.GetWindowTextLengthA;
    u.GetClientRect = function (h, out) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); setOutRect(out, { left: 0, top: 0, right: w.width, bottom: w.height }); return 1; };
    u.GetWindowRect = function (h, out) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); setOutRect(out, { left: w.x, top: w.y, right: w.x + w.width, bottom: w.y + w.height }); return 1; };
    u.GetDC = function (h) { var w = r._windows[h || r._defaultWindow]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); r._dcForWindow(w); return w.hdc; };
    u.GetWindowDC = u.GetDC; u.ReleaseDC = function () { return 1; };
    u.BeginPaint = function (h, ps) { var w = r._windows[h]; if (!w) return r._fail(C.ERROR_INVALID_HANDLE); r._dcForWindow(w); if (ps) { ps.hdc = w.hdc; ps.fErase = 1; ps.rcPaint = { left: 0, top: 0, right: w.width, bottom: w.height }; } return w.hdc; };
    u.EndPaint = function () { return 1; };
    u.InvalidateRect = function (h) { if (!r._windows[h]) return r._fail(C.ERROR_INVALID_HANDLE); return r.postMessage(h, C.WM_PAINT, 0, 0); };
    u.ValidateRect = function () { return 1; };
    u.MessageBoxA = function (h, body, title) { if (W98 && W98.dialog && W98.dialog.alert) { try { W98.dialog.alert(text(title || 'Program'), text(body || ''), 'info'); } catch (e) {} } return C.IDOK; }; u.MessageBoxW = u.MessageBoxA;
    u.GetForegroundWindow = function () { return r._defaultWindow || 0; };
    u.SetForegroundWindow = function (h) { if (!r._windows[h]) return r._fail(C.ERROR_INVALID_HANDLE); r._defaultWindow = h; if (r._windows[h].hostWindow && r._windows[h].hostWindow.focus) r._windows[h].hostWindow.focus(); return 1; };
    u.GetSystemMetrics = function (n) { var d = W98 && W98.shell && W98.shell.desktop ? W98.shell.desktop() : null; var w = d ? d.clientWidth : 800, h = d ? d.clientHeight : 600; return n === 0 ? w : n === 1 ? h : 0; };
    return u;
  };

  Runtime.prototype.registerClass = function (spec) {
    spec = spec || {};
    var name = text(spec.lpszClassName || spec.className || spec.name);
    if (!name) return this._fail(C.ERROR_INVALID_PARAMETER);
    var atom = this._nextAtom++;
    var proc = spec.lpfnWndProc || spec.wndProc || null;
    if (typeof proc === 'number' || typeof proc === 'bigint') {
      var address = proc, self = this;
      proc = function (hwnd, message, wParam, lParam) {
        return self._cpu && typeof self._cpu.callGuest === 'function' ? self._cpu.callGuest(address, [hwnd, message, wParam, lParam]) : 0;
      };
    }
    this._classes[name] = { name: name, wndProc: proc, wndProcAddress: spec.lpfnWndProc || 0, background: spec.hbrBackground || C.WHITE_BRUSH, atom: atom };
    this._ok(); return atom;
  };
  Runtime.prototype.createWindow = function (ex, klass, title, style, x, y, width, height, parent, menu, instance, param) {
    /* Accept both the Win32 12-argument shape and a compact object shape. */
    if (typeof ex === 'object') { var a = ex; ex = a.exStyle; klass = a.className; title = a.title; style = a.style; x = a.x; y = a.y; width = a.width; height = a.height; parent = a.parent; menu = a.menu; instance = a.instance; param = a.param; }
    var cls = this._classes[text(klass)];
    if (!cls) return this._fail(C.ERROR_INVALID_PARAMETER);
    width = clamp(Math.floor(asNumber(width, 320)), 1, 4096); height = clamp(Math.floor(asNumber(height, 200)), 1, 4096);
    var w = { hwnd: 0, className: cls.name, title: text(title), style: asNumber(style), exStyle: asNumber(ex), x: asNumber(x), y: asNumber(y), width: width, height: height, parent: parent || 0, menu: menu || 0, instance: instance || 0, param: param || 0, visible: false, destroying: false, hostWindow: null, canvas: null, surface: null, dc: null, hdc: 0 };
    w.hwnd = this._handle('hwnd', w); this._windows[w.hwnd] = w; if (!this._defaultWindow) this._defaultWindow = w.hwnd;
    this._openShellWindow(w); this._dcForWindow(w);
    this.sendMessage(w.hwnd, C.WM_NCCREATE, 0, param || 0); this.sendMessage(w.hwnd, C.WM_CREATE, 0, param || 0);
    this._ok(); return w.hwnd;
  };
  Runtime.prototype._match = function (m, h, lo, hi) { return (!h || m.hwnd === h) && (!lo || m.message >= lo) && (!hi || m.message <= hi); };
  Runtime.prototype.postMessage = function (h, msg, wp, lp) { if (h && !this._windows[h]) return this._fail(C.ERROR_INVALID_HANDLE); this._messages.push({ hwnd: h || 0, message: msg >>> 0, wParam: wp || 0, lParam: lp || 0, time: Date.now() }); return 1; };
  Runtime.prototype.peekMessage = function (out, h, lo, hi, remove) { var i, m; for (i = 0; i < this._messages.length; i++) { m = this._messages[i]; if (!this._match(m, h, lo, hi)) continue; if (out) { out.hwnd = m.hwnd; out.message = m.message; out.wParam = m.wParam; out.lParam = m.lParam; out.time = m.time; } if (remove) this._messages.splice(i, 1); return 1; } return 0; };
  Runtime.prototype.getMessage = function (out, h, lo, hi) { var r = this.peekMessage(out, h, lo, hi, true); if (!r) return 0; return out && out.message === C.WM_QUIT ? 0 : 1; };
  Runtime.prototype.dispatchMessage = function (m) { if (!m) return this._fail(C.ERROR_INVALID_PARAMETER); return this.sendMessage(m.hwnd, m.message, m.wParam, m.lParam); };
  Runtime.prototype.sendMessage = function (h, msg, wp, lp) {
    var w = this._windows[h], ret = 0, fn;
    if (!w) return this._fail(C.ERROR_INVALID_HANDLE);
    fn = this._classes[w.className] && this._classes[w.className].wndProc;
    if (typeof fn === 'function') { try { ret = fn(h, msg, wp, lp); } catch (e) { this.lastError = C.ERROR_INVALID_PARAMETER; ret = -1; } }
    else ret = this.defWindowProc(h, msg, wp, lp);
    return ret == null ? 0 : ret;
  };
  Runtime.prototype.defWindowProc = function (h, msg, wp) { if (msg === C.WM_CLOSE) { this._destroyWindow(h, false); return 0; } if (msg === C.WM_ERASEBKGND) return 1; if (msg === C.WM_NCDESTROY) return 0; return 0; };

  /* ----------------------------- gdi32 -------------------------------- */
  Runtime.prototype._makeGdi32 = function () {
    var r = this, g = {};
    g.CreateCompatibleDC = function (hdc) { var base = r._obj(hdc, 'dc'), s = base ? r._surface(base.surface.width, base.surface.height) : r._surface(1, 1); return r._handle('dc', { surface: s, bitmap: null, brush: r._stock(C.WHITE_BRUSH), pen: r._stock(C.BLACK_PEN), x: 0, y: 0 }); };
    g.DeleteDC = function (h) { if (!r._obj(h, 'dc')) return r._fail(C.ERROR_INVALID_HANDLE); r._drop(h); return 1; };
    g.CreateCompatibleBitmap = function (hdc, w, h) { var d = r._obj(hdc, 'dc'); return r._handle('bitmap', { surface: r._surface(w, h, null), selected: 0, owner: d || null }); };
    g.CreateBitmap = g.CreateCompatibleBitmap;
    g.DeleteObject = function (h) { var o = r._objects[h]; if (!o || (o.kind !== 'bitmap' && o.kind !== 'brush' && o.kind !== 'pen' && o.kind !== 'font')) return r._fail(C.ERROR_INVALID_HANDLE); r._drop(h); return 1; };
    g.SelectObject = function (hdc, h) { var d = r._obj(hdc, 'dc'), o = r._objects[h]; if (!d || !o) return r._fail(C.ERROR_INVALID_HANDLE); var kind = o.value && o.value.kind ? o.value.kind : o.kind, old; if (kind === 'bitmap') { old = d.bitmap; d.bitmap = o.value; o.value.selected = hdc; if (d.bitmap && d.bitmap !== o.value) d.bitmap.selected = 0; d.surface = o.value.surface; } else if (kind === 'brush') { old = d.brush; d.brush = o.value; } else if (kind === 'pen') { old = d.pen; d.pen = o.value; } else { old = d.font; d.font = o.value; } return old ? r._handle(kind, old) : 0; };
    g.CreateSolidBrush = function (c) { return r._handle('brush', { kind: 'brush', color: c >>> 0 }); };
    g.CreateHatchBrush = g.CreateSolidBrush;
    g.CreatePen = function (style, width, c) { return r._handle('pen', { kind: 'pen', style: style || 0, width: Math.max(1, asNumber(width, 1)), color: c >>> 0 }); };
    g.CreateFontA = function (h, w, e, o, weight, italic, underline, strike, charset, outp, clip, quality, pitch, face) { return r._handle('font', { height: h || 12, face: text(face || 'System'), weight: weight || 400, italic: !!italic }); }; g.CreateFontW = g.CreateFontA;
    g.GetStockObject = function (which) { return r._handle('stock', r._stock(which)); };
    function drawPixel(d, x, y, c) { if (!d || !d.surface || x < 0 || y < 0 || x >= d.surface.width || y >= d.surface.height) return; var i = (y * d.surface.width + x) * 4, p = colorRGB(c); d.surface.pixels[i] = p[0]; d.surface.pixels[i + 1] = p[1]; d.surface.pixels[i + 2] = p[2]; d.surface.pixels[i + 3] = 255; }
    function sync(d, x, y, w, h) { if (!d || !d.surface || !d.surface.ctx) return; var s = d.surface, im; try { im = s.surfaceImageData; if (!im || im.width !== s.width || im.height !== s.height) im = s.surfaceImageData = s.ctx.createImageData(s.width, s.height); im.data.set(s.pixels); s.ctx.putImageData(im, 0, 0, x || 0, y || 0, w || s.width, h || s.height); } catch (e) {} }
    g.SetPixel = function (hdc, x, y, c) { var d = r._obj(hdc, 'dc'); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); drawPixel(d, asNumber(x), asNumber(y), c); sync(d, x, y, 1, 1); return c >>> 0; };
    g.GetPixel = function (hdc, x, y) { var d = r._obj(hdc, 'dc'); if (!d || x < 0 || y < 0 || x >= d.surface.width || y >= d.surface.height) return 0xffffffff; var i = (y * d.surface.width + x) * 4, p = d.surface.pixels; return rgbColor(p[i], p[i + 1], p[i + 2]); };
    g.MoveToEx = function (hdc, x, y, old) { var d = r._obj(hdc, 'dc'); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); if (old) { old.x = d.x; old.y = d.y; } d.x = asNumber(x); d.y = asNumber(y); return 1; };
    g.LineTo = function (hdc, x2, y2) { var d = r._obj(hdc, 'dc'); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); var x0 = d.x, y0 = d.y, x1 = asNumber(x2), y1 = asNumber(y2), dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy, e2; while (true) { if (!d.pen.nullObject) drawPixel(d, x0, y0, d.pen.color); if (x0 === x1 && y0 === y1) break; e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } } d.x = x1; d.y = y1; sync(d, 0, 0, d.surface.width, d.surface.height); return 1; };
    g.FillRect = function (hdc, rr, hb) { var d = r._obj(hdc, 'dc'), bo = hb ? r._objects[hb] : null, b = bo && bo.value && bo.value.kind === 'brush' ? bo.value : (hb ? r._obj(hb, 'brush') : null), q = rectOf(rr); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); b = b || d.brush; if (!b || b.nullObject) return 1; q.left = clamp(q.left, 0, d.surface.width); q.right = clamp(q.right, 0, d.surface.width); q.top = clamp(q.top, 0, d.surface.height); q.bottom = clamp(q.bottom, 0, d.surface.height); for (var y = q.top; y < q.bottom; y++) for (var x = q.left; x < q.right; x++) drawPixel(d, x, y, b.color); sync(d, q.left, q.top, q.right - q.left, q.bottom - q.top); return 1; };
    g.PatBlt = function (hdc, x, y, w, h, rop) { var d = r._obj(hdc, 'dc'); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); return g.FillRect(hdc, { left: x, top: y, right: x + w, bottom: y + h }, rop === C.WHITENESS ? r.gdi32.GetStockObject(C.WHITE_BRUSH) : r.gdi32.GetStockObject(C.BLACK_BRUSH)); };
    g.Rectangle = function (hdc, l, t, rr, btm) { var d = r._obj(hdc, 'dc'); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); g.MoveToEx(hdc, l, t); g.LineTo(hdc, rr, t); g.LineTo(hdc, rr, btm); g.LineTo(hdc, l, btm); g.LineTo(hdc, l, t); if (d.brush && !d.brush.nullObject) g.FillRect(hdc, { left: l + 1, top: t + 1, right: rr - 1, bottom: btm - 1 }, 0); return 1; };
    g.TextOutA = function (hdc, x, y, s) { var d = r._obj(hdc, 'dc'), str = text(s); if (!d) return r._fail(C.ERROR_INVALID_HANDLE); if (d.surface.ctx) { try { d.surface.ctx.fillStyle = 'rgb(0,0,0)'; d.surface.ctx.font = ((d.font && d.font.height) || 12) + 'px monospace'; d.surface.ctx.fillText(str, x, y + ((d.font && d.font.height) || 12)); } catch (e) {} } else { /* A deterministic one-pixel representation for headless callers. */ for (var i = 0; i < str.length; i++) drawPixel(d, x + i, y, d.pen.color); } return 1; }; g.TextOutW = g.TextOutA;
    g.GetDeviceCaps = function (hdc, index) { var d = r._obj(hdc, 'dc'); if (!d) return 0; return index === 8 ? d.surface.width : index === 10 ? d.surface.height : index === 12 ? 32 : index === 14 ? 1 : 0; };
    g.BitBlt = function (hdst, x, y, w, h, hsrc, sx, sy, rop) { var dst = r._obj(hdst, 'dc'), src = r._obj(hsrc, 'dc'); if (!dst || !src) return r._fail(C.ERROR_INVALID_HANDLE); var copy = new Uint8ClampedArray(Math.max(0, w * h * 4)), xx, yy, si, di; for (yy = 0; yy < h; yy++) for (xx = 0; xx < w; xx++) { si = ((sy + yy) * src.surface.width + sx + xx) * 4; di = (yy * w + xx) * 4; if (sx + xx >= 0 && sy + yy >= 0 && sx + xx < src.surface.width && sy + yy < src.surface.height) { copy[di] = src.surface.pixels[si]; copy[di + 1] = src.surface.pixels[si + 1]; copy[di + 2] = src.surface.pixels[si + 2]; copy[di + 3] = src.surface.pixels[si + 3]; } } for (yy = 0; yy < h; yy++) for (xx = 0; xx < w; xx++) { if (x + xx < 0 || y + yy < 0 || x + xx >= dst.surface.width || y + yy >= dst.surface.height) continue; di = ((y + yy) * dst.surface.width + x + xx) * 4; si = (yy * w + xx) * 4; dst.surface.pixels[di] = copy[si]; dst.surface.pixels[di + 1] = copy[si + 1]; dst.surface.pixels[di + 2] = copy[si + 2]; dst.surface.pixels[di + 3] = copy[si + 3]; } sync(dst, x, y, w, h); return 1; };
    return g;
  };

  /* ---------------------------- kernel32 ------------------------------- */
  Runtime.prototype._makeKernel32 = function () {
    var r = this, k = {};
    k.GetLastError = function () { return r.lastError >>> 0; }; k.SetLastError = function (e) { r.lastError = e >>> 0; };
    k.GetModuleHandleA = function () { return 1; }; k.GetModuleHandleW = k.GetModuleHandleA;
    k.LoadLibraryA = function (name) { var n = low(name); if (!r.modules[n]) r.modules[n] = r._handle('module', n); return r.modules[n]; }; k.LoadLibraryW = k.LoadLibraryA;
    k.GetProcAddress = function (mod, name) { var n = text(name).replace(/^_/, '').replace(/@\d+$/, ''), dll = ''; for (var x in r.modules) if (r.modules[x] === mod) dll = x; var fn = r.resolve(dll, n); if (!fn) return r._fail(C.ERROR_PROC_NOT_FOUND); return fn; };
    k.GetTickCount = function () { return (Date.now() - now0) >>> 0; }; k.GetTickCount64 = k.GetTickCount;
    k.Sleep = function (ms) { r.virtualTime = (r.virtualTime || 0) + Math.max(0, asNumber(ms)); return 0; };
    k.QueryPerformanceCounter = function (out) { setOut(out, (Date.now() - now0) * 1000); return 1; }; k.QueryPerformanceFrequency = function (out) { setOut(out, 1000000); return 1; };
    k.GetStdHandle = function (which) { which = typeof which === 'bigint' ? Number(BigInt.asIntN(32, which)) : Number(which) | 0; return which === C.STD_INPUT_HANDLE ? C.STD_INPUT_HANDLE : which === C.STD_ERROR_HANDLE ? C.STD_ERROR_HANDLE : C.STD_OUTPUT_HANDLE; };
    k.WriteConsoleA = function (h, value, n, written) { h = typeof h === 'bigint' ? Number(BigInt.asIntN(32, h)) : Number(h) | 0; if (h !== C.STD_OUTPUT_HANDLE && h !== C.STD_ERROR_HANDLE) return r._fail(C.ERROR_INVALID_HANDLE); var s = text(value).slice(0, n == null ? undefined : asNumber(n)); r._console.output += s; setOut(written, s.length); return 1; }; k.WriteConsoleW = k.WriteConsoleA;
    k.ReadConsoleA = function (h, out, n, read) { h = typeof h === 'bigint' ? Number(BigInt.asIntN(32, h)) : Number(h) | 0; if (h !== C.STD_INPUT_HANDLE) return r._fail(C.ERROR_INVALID_HANDLE); var s = r._console.input.splice(0, 1).join('').slice(0, asNumber(n)); if (out && typeof out === 'object') out.value = s; setOut(read, s.length); return 1; }; k.ReadConsoleW = k.ReadConsoleA;
    k.WriteFile = function (h, data, n, written) { h = typeof h === 'bigint' ? Number(BigInt.asIntN(32, h)) : Number(h) | 0; if (h === C.STD_OUTPUT_HANDLE || h === C.STD_ERROR_HANDLE) return k.WriteConsoleA(h, data, n, written); var f = r._obj(h, 'file'); if (!f) return r._fail(C.ERROR_INVALID_HANDLE); var b = data instanceof Uint8Array ? data : new Uint8Array(data || []), len = n == null ? b.length : Math.min(b.length, asNumber(n)); f.bytes = f.bytes ? new Uint8Array(f.bytes) : new Uint8Array(0); var next = new Uint8Array(Math.max(f.bytes.length, f.pos + len)); next.set(f.bytes); next.set(b.subarray(0, len), f.pos); f.bytes = next; f.pos += len; setOut(written, len); return 1; };
    k.CreateFileA = function (path, access, share, sec, create, flags, template) { var p = text(path), bytes = W98 && W98.fs && W98.fs.readBytes ? W98.fs.readBytes(p) : null; if (!bytes && create === 3 /* OPEN_EXISTING */) return r._fail(C.ERROR_FILE_NOT_FOUND); return r._handle('file', { path: p, bytes: bytes || new Uint8Array(0), pos: 0, access: access || 0 }); }; k.CreateFileW = k.CreateFileA;
    k.CloseHandle = function (h) { if (!r._objects[h]) return r._fail(C.ERROR_INVALID_HANDLE); r._drop(h); return 1; };
    k.SetFilePointer = function (h, dist, high, method) { var f = r._obj(h, 'file'); if (!f) return r._fail(C.ERROR_INVALID_HANDLE); var old = f.pos, m = method || 0; f.pos = m === 0 ? dist : m === 1 ? f.pos + dist : (f.bytes || []).length + dist; return old; };
    k.GetCommandLineA = function () { return r._commandLine; }; k.GetCommandLineW = k.GetCommandLineA;
    k.GetEnvironmentVariableA = function (name, out, n) { var s = text(r._env[text(name)] || ''); s = s.slice(0, Math.max(0, asNumber(n) - 1)); if (out && typeof out === 'object') out.value = s; return s.length; }; k.GetEnvironmentVariableW = k.GetEnvironmentVariableA;
    k.lstrlenA = function (s) { return text(s).length; }; k.lstrlenW = k.lstrlenA; k.lstrcmpA = function (a, b) { a = text(a); b = text(b); return a < b ? -1 : a > b ? 1 : 0; }; k.lstrcmpW = k.lstrcmpA;
    k.VirtualAlloc = function (addr, bytes) { var b = new Uint8Array(Math.max(1, asNumber(bytes))); return r._handle('memory', { bytes: b, size: b.length }); }; k.HeapAlloc = k.VirtualAlloc;
    k.VirtualFree = function (h) { if (r._guestAllocs[String(h)]) { delete r._guestAllocs[String(h)]; return 1; } if (!r._obj(h, 'memory')) return r._fail(C.ERROR_INVALID_HANDLE); r._drop(h); return 1; }; k.HeapFree = k.VirtualFree;
    k.ExitProcess = function (code) { r.exited = true; r.exitCode = asNumber(code); r.postMessage(0, C.WM_QUIT, r.exitCode, 0); return 0; };
    return k;
  };

  Runtime.prototype.resolve = function (dll, name) {
    var d = low(dll), n = text(name).replace(/^_/, '').replace(/@\d+$/, '');
    var table = d === 'user32' ? this.user32 : d === 'gdi32' ? this.gdi32 : (d === 'kernel32' || d === 'advapi32' || d === 'msvcrt' ? this.kernel32 : null);
    return table && (table[n] || table[n.replace(/A$/, 'W')] || table[n.replace(/W$/, 'A')]) || null;
  };
  function guestPtr(ctx, value) {
    return value == null ? 0 : (typeof value === 'bigint' ? value : Number(value));
  }
  function guestString(ctx, value, wide) {
    if (ctx && typeof ctx.readGuestString === 'function' && (typeof value === 'number' || typeof value === 'bigint')) {
      try { return ctx.readGuestString(guestPtr(ctx, value), !!wide); } catch (e) { return ''; }
    }
    return text(value);
  }
  function writeGuestStruct(ctx, ptr, bytes) {
    if (!ctx || !ptr || typeof ctx.writeGuestBytes !== 'function') return;
    try { ctx.writeGuestBytes(guestPtr(ctx, ptr), bytes); } catch (e) {}
  }
  function writeU32(a, p, n) {
    n = Number(n) >>> 0; a[p] = n & 255; a[p + 1] = (n >>> 8) & 255;
    a[p + 2] = (n >>> 16) & 255; a[p + 3] = (n >>> 24) & 255;
  }
  function readU32(a, p) { return (a[p] | (a[p + 1] << 8) | (a[p + 2] << 16) | (a[p + 3] << 24)) >>> 0; }
  function encodeGuestText(s, wide) {
    s = text(s); var b = new Uint8Array((s.length + 1) * (wide ? 2 : 1)), i;
    if (wide) for (i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) & 255; b[i * 2 + 1] = s.charCodeAt(i) >>> 8; }
    else for (i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  }
  Runtime.prototype._importArgs = function (dll, name, args, ctx) {
    var n = text(name).replace(/@[0-9]+$/, ''), a = args.slice(), self = this;
    function outRect(ptr, r) { var b = new Uint8Array(16); writeU32(b, 0, r.left); writeU32(b, 4, r.top); writeU32(b, 8, r.right); writeU32(b, 12, r.bottom); writeGuestStruct(ctx, ptr, b); }
    function outCount(ptr, v) { var b = new Uint8Array(4); writeU32(b, 0, v); writeGuestStruct(ctx, ptr, b); }
    if (/^RegisterClass(?:Ex)?/.test(n)) {
      var p = guestPtr(ctx, a[0]), spec = { lpszClassName: '', lpfnWndProc: 0, hbrBackground: C.WHITE_BRUSH };
      if (p && ctx && typeof ctx.readPtr === 'function') {
        var step = ctx.word || (ctx.x64 ? 8 : 4), base = p;
        try {
          /* WNDCLASSEX keeps the callback immediately after cbSize/style;
             the pointer is eight bytes wide on PE32+ but its field offset is
             still 8 (not two pointer slots). */
          spec.lpfnWndProc = ctx.readPtr(ctx.x64 ? BigInt(base) + 8n : base + 8);
          var clsOff = ctx.x64 ? 64 : 40;
          var clsPtr = ctx.readPtr(ctx.x64 ? BigInt(base) + BigInt(clsOff) : base + clsOff);
          spec.lpszClassName = guestString(ctx, clsPtr, /W$/.test(n));
          var brushOff = ctx.x64 ? 48 : 32;
          spec.hbrBackground = asNumber(ctx.read(ctx.x64 ? BigInt(base) + BigInt(brushOff) : base + brushOff, step));
        } catch (e) {}
      }
      a[0] = spec;
    } else if (/^CreateWindowEx/.test(n)) { a[1] = guestString(ctx, a[1], /W$/.test(n)); a[2] = guestString(ctx, a[2], /W$/.test(n)); }
    else if (/^(SetWindowText|MessageBox)/.test(n)) { if (n.indexOf('MessageBox') === 0) { a[1] = guestString(ctx, a[1], /W$/.test(n)); a[2] = guestString(ctx, a[2], /W$/.test(n)); } else a[1] = guestString(ctx, a[1], /W$/.test(n)); }
    else if (/^GetEnvironmentVariable/.test(n)) { a[0] = guestString(ctx, a[0], /W$/.test(n)); /* output buffers are filled below */ }
    else if (/^GetWindowText/.test(n)) { /* output buffers are filled below */ }
    else if (/^(GetModuleHandle|LoadLibrary)/.test(n)) a[0] = guestString(ctx, a[0], /W$/.test(n));
    else if (/^GetProcAddress/.test(n)) a[1] = guestString(ctx, a[1], false);
    else if (/^(TextOut|DrawText)/.test(n)) { a[3] = guestString(ctx, a[3], /W$/.test(n)); }
    else if (/^(CreateFont)/.test(n)) { a[a.length - 1] = guestString(ctx, a[a.length - 1], /W$/.test(n)); }
    else if (/^WriteConsole/.test(n)) { a[1] = guestString(ctx, a[1], /W$/.test(n)); a[3] = {}; }
    else if (/^ReadConsole/.test(n)) { a[1] = {}; a[3] = {}; }
    else if (/^CreateFile/.test(n)) a[0] = guestString(ctx, a[0], /W$/.test(n));
    else if (/^WriteFile/.test(n)) {
      if (ctx && typeof ctx.readGuestBytes === 'function') { try { a[1] = ctx.readGuestBytes(guestPtr(ctx, a[1]), Number(a[2]) || 0); } catch (e) { a[1] = new Uint8Array(0); } }
      a[3] = {};
    }
    else if (/^ReadFile/.test(n)) { a[1] = {}; a[3] = {}; }
    else if (/^(lstrlen|lstrcmp)/.test(n)) { a[0] = guestString(ctx, a[0], /W$/.test(n)); if (n.indexOf('lstrcmp') === 0) a[1] = guestString(ctx, a[1], /W$/.test(n)); }
    else if (/^GetMessage|^PeekMessage/.test(n)) { a[0] = {}; }
    else if (/^Get(Client|Window)Rect/.test(n)) { a[1] = {}; }
    else if (/^BeginPaint/.test(n)) { a[1] = {}; }
    else if (/^TextOut/.test(n)) { a[3] = guestString(ctx, a[3], /W$/.test(n)); }
    else if (/^FillRect/.test(n)) { a[1] = {}; }
    else if (/^MoveToEx/.test(n)) { a[3] = {}; }
    /* Guest pointers are BigInts for PE32+; host handles and scalar Win32
       arguments are ordinary JavaScript numbers.  Pointer arguments that
       need guest-memory access were saved in `args` and/or replaced above,
       so normalizing the call copy here is safe. */
    for (var ai = 0; ai < a.length; ai++) if (typeof a[ai] === 'bigint') a[ai] = Number(BigInt.asIntN(32, a[ai]));
    var ret = { args: a, after: function (value) {
      if (/^GetCommandLine/.test(n) && ctx && typeof ctx.allocGuest === 'function') {
        var cmd = String(value || ''), cb = encodeGuestText(cmd, /W$/.test(n));
        var cp = ctx.allocGuest(cb.length, /W$/.test(n) ? 2 : 1); writeGuestStruct(ctx, cp, cb); return cp;
      }
      if (/^(VirtualAlloc|HeapAlloc)$/.test(n) && ctx && typeof ctx.allocGuest === 'function') {
        var requested = n === 'VirtualAlloc' ? Number(args[1]) : Number(args[2]);
        var gp = ctx.allocGuest(Math.max(1, requested || 1), 16);
        self._guestAllocs[String(gp)] = { address: gp, size: Math.max(1, requested || 1), cpu: ctx };
        try { ctx.writeGuestBytes(gp, new Uint8Array(Math.max(1, requested || 1))); } catch (e) {}
        return gp;
      }
      if (/^GetEnvironmentVariable/.test(n)) {
        /* The host API returns the required character count.  Recover the
           actual value from the runtime environment for the guest buffer. */
        var ev = text(self._env[text(a[0])] || ''), cap = Number(args[2]) || 0, ew = /W$/.test(n), eb = encodeGuestText(ev.slice(0, Math.max(0, cap - 1)), ew);
        if (args[1]) writeGuestStruct(ctx, args[1], eb); return ew ? Math.max(0, eb.length / 2 - 1) : Math.max(0, eb.length - 1);
      }
      if (/^GetMessage|^PeekMessage/.test(n)) {
        var m = a[0], ptr = args[0], b = new Uint8Array(24); writeU32(b, 0, m.hwnd); writeU32(b, 4, m.message); writeU32(b, 8, m.wParam); writeU32(b, 12, m.lParam); writeU32(b, 16, m.time || 0); writeGuestStruct(ctx, ptr, b);
      } else if (/^Get(Client|Window)Rect/.test(n)) outRect(args[1], a[1]);
      else if (/^BeginPaint/.test(n)) { var ps = a[1], b2 = new Uint8Array(72); writeU32(b2, 0, ps.hdc || value); writeU32(b2, 4, ps.fErase || 0); writeU32(b2, 8, 0); writeU32(b2, 12, 0); writeU32(b2, 16, ps.rcPaint ? ps.rcPaint.right : 0); writeU32(b2, 20, ps.rcPaint ? ps.rcPaint.bottom : 0); writeGuestStruct(ctx, args[1], b2); }
      else if (/^GetWindowText/.test(n)) { var s = self._windows[args[0]] ? self._windows[args[0]].title : '', capText = Number(args[2]) || 0; if (capText > 0) s = s.slice(0, Math.max(0, capText - 1)); if (ctx && args[1]) writeGuestStruct(ctx, args[1], encodeGuestText(s, /W$/.test(n))); }
      else if (/^WriteConsole|^WriteFile/.test(n)) { if (args[3]) outCount(args[3], a[3] && a[3].value != null ? a[3].value : (value && value.written != null ? value.written : 0)); }
      else if (/^ReadConsole/.test(n) && args[1] && ctx && typeof ctx.writeGuestBytes === 'function') { var inp = self._console.input.join('').slice(0, Number(args[2]) || 0), bb = encodeGuestText(inp, /W$/.test(n)); writeGuestStruct(ctx, args[1], bb); outCount(args[3], a[3] && a[3].value != null ? a[3].value : inp.length); }
      else if (/^ReadFile/.test(n) && args[1] && ctx && typeof ctx.writeGuestBytes === 'function') { var rb = a[1] && a[1].data ? a[1].data : new Uint8Array(0); writeGuestStruct(ctx, args[1], rb); outCount(args[3], a[3] && a[3].value != null ? a[3].value : rb.length); }
      else if (/^MoveToEx/.test(n) && args[3]) { var old = a[3] || {}; var ob = new Uint8Array(8); writeU32(ob, 0, old.x || 0); writeU32(ob, 4, old.y || 0); writeGuestStruct(ctx, args[3], ob); }
      return value;
    }};
    return ret;
  };
  Runtime.prototype.resolveImport = function (dll, name, ordinal) {
    var fn = this.resolve(dll, name || ('#' + ordinal)); if (!fn) return null;
    /* Import libraries may spell x86 stdcall names as _Foo@N.  Use the same
       canonical name for marshalling and signature lookup that `resolve`
       uses for the host export table. */
    var n = text(name).replace(/^_/, '').replace(/@[0-9]+$/, ''), argc = SIGNATURES[n] ? SIGNATURES[n].length : (/^(GetStdHandle|GetLastError|GetTickCount|Sleep|ExitProcess|ShowWindow|UpdateWindow|GetDC|ReleaseDC|EndPaint|PostQuitMessage|DefWindowProc|DispatchMessage|TranslateMessage)$/.test(n) ? 4 : 8);
    var self = this;
    return { argCount: argc, stackBytes: argc * 4, fn: function () {
      var raw = Array.prototype.slice.call(arguments), ctx = raw.pop(), m = self._importArgs(dll, n, raw, ctx), value;
      self._cpu = ctx || self._cpu;
      value = fn.apply(self, m.args); value = m.after(value);
      if (ctx && self.exited) { ctx.terminated = true; ctx.terminatedCode = self.exitCode; }
      return value;
    }};
  };
  Runtime.prototype.call = function (dll, name, args) { var fn = this.resolve(dll, name); if (!fn) { this._fail(C.ERROR_PROC_NOT_FOUND); return 0; } try { this._ok(); return fn.apply(this, Array.isArray(args) ? args : []); } catch (e) { this._fail(C.ERROR_INVALID_PARAMETER); return 0; } };
  Runtime.prototype.surface = function (hwnd) { var w = this._windows[hwnd || this._defaultWindow]; return w ? w.surface : null; };
  Runtime.prototype.consoleText = function () { return this._console.output; };
  Runtime.prototype.destroy = function () { var ids = Object.keys(this._windows), i; for (i = 0; i < ids.length; i++) this._destroyWindow(Number(ids[i]), false); this._objects = Object.create(null); };

  var TABLES = {
    user32: ['RegisterClassExA','RegisterClassExW','CreateWindowExA','CreateWindowExW','DestroyWindow','ShowWindow','UpdateWindow','GetMessageA','GetMessageW','PeekMessageA','PeekMessageW','TranslateMessage','DispatchMessageA','DispatchMessageW','DefWindowProcA','DefWindowProcW','PostMessageA','PostMessageW','SendMessageA','SendMessageW','PostQuitMessage','SetWindowTextA','SetWindowTextW','GetWindowTextA','GetWindowTextW','GetWindowTextLengthA','GetWindowTextLengthW','GetClientRect','GetWindowRect','GetDC','GetWindowDC','ReleaseDC','BeginPaint','EndPaint','InvalidateRect','ValidateRect','MessageBoxA','MessageBoxW','GetForegroundWindow','SetForegroundWindow','GetSystemMetrics'],
    gdi32: ['CreateCompatibleDC','DeleteDC','CreateCompatibleBitmap','CreateBitmap','DeleteObject','SelectObject','CreateSolidBrush','CreateHatchBrush','CreatePen','CreateFontA','CreateFontW','GetStockObject','SetPixel','GetPixel','MoveToEx','LineTo','FillRect','PatBlt','Rectangle','TextOutA','TextOutW','GetDeviceCaps','BitBlt'],
    kernel32: ['GetLastError','SetLastError','GetModuleHandleA','GetModuleHandleW','LoadLibraryA','LoadLibraryW','GetProcAddress','GetTickCount','GetTickCount64','Sleep','QueryPerformanceCounter','QueryPerformanceFrequency','GetStdHandle','WriteConsoleA','WriteConsoleW','ReadConsoleA','ReadConsoleW','WriteFile','ReadFile','CreateFileA','CreateFileW','CloseHandle','SetFilePointer','GetCommandLineA','GetCommandLineW','GetEnvironmentVariableA','GetEnvironmentVariableW','lstrlenA','lstrlenW','lstrcmpA','lstrcmpW','VirtualAlloc','VirtualFree','HeapAlloc','HeapFree','ExitProcess']
  };
  var SIGNATURES = {
    RegisterClassExA: ['spec'], RegisterClassExW: ['spec'], RegisterClassA: ['spec'], RegisterClassW: ['spec'], UnregisterClassA: ['className','instance'], UnregisterClassW: ['className','instance'],
    CreateWindowExA: ['exStyle','className','title','style','x','y','width','height','parent','menu','instance','param'],
    CreateWindowExW: ['exStyle','className','title','style','x','y','width','height','parent','menu','instance','param'],
    DestroyWindow: ['hwnd'], ShowWindow: ['hwnd','command'], UpdateWindow: ['hwnd'],
    GetMessageA: ['message','hwnd','minFilter','maxFilter'], GetMessageW: ['message','hwnd','minFilter','maxFilter'],
    PeekMessageA: ['message','hwnd','minFilter','maxFilter','remove'], PeekMessageW: ['message','hwnd','minFilter','maxFilter','remove'],
    TranslateMessage: ['message'], DispatchMessageA: ['message'], DispatchMessageW: ['message'],
    DefWindowProcA: ['hwnd','message','wParam','lParam'], DefWindowProcW: ['hwnd','message','wParam','lParam'],
    PostMessageA: ['hwnd','message','wParam','lParam'], PostMessageW: ['hwnd','message','wParam','lParam'],
    SendMessageA: ['hwnd','message','wParam','lParam'], SendMessageW: ['hwnd','message','wParam','lParam'],
    PostQuitMessage: ['exitCode'], SetWindowTextA: ['hwnd','text'], SetWindowTextW: ['hwnd','text'],
    GetWindowTextA: ['hwnd','text','capacity'], GetWindowTextW: ['hwnd','text','capacity'],
    GetWindowTextLengthA: ['hwnd'], GetWindowTextLengthW: ['hwnd'], GetClientRect: ['hwnd','rect'], GetWindowRect: ['hwnd','rect'],
    GetDC: ['hwnd'], GetWindowDC: ['hwnd'], ReleaseDC: ['hwnd','hdc'], BeginPaint: ['hwnd','paint'], EndPaint: ['hwnd','paint'],
    InvalidateRect: ['hwnd','rect','erase'], ValidateRect: ['hwnd','rect'], MessageBoxA: ['hwnd','text','caption','type'], MessageBoxW: ['hwnd','text','caption','type'],
    GetForegroundWindow: [], SetForegroundWindow: ['hwnd'], GetSystemMetrics: ['index'],
    CreateCompatibleDC: ['hdc'], DeleteDC: ['hdc'], CreateCompatibleBitmap: ['hdc','width','height'], CreateBitmap: ['width','height','planes','bits','data'],
    DeleteObject: ['object'], SelectObject: ['hdc','object'], CreateSolidBrush: ['color'], CreateHatchBrush: ['style','color'], CreatePen: ['style','width','color'],
    CreateFontA: ['height','width','escapement','orientation','weight','italic','underline','strike','charset','outPrecision','clipPrecision','quality','pitch','face'],
    CreateFontW: ['height','width','escapement','orientation','weight','italic','underline','strike','charset','outPrecision','clipPrecision','quality','pitch','face'],
    GetStockObject: ['object'], SetPixel: ['hdc','x','y','color'], GetPixel: ['hdc','x','y'], MoveToEx: ['hdc','x','y','point'], LineTo: ['hdc','x','y'],
    FillRect: ['hdc','rect','brush'], PatBlt: ['hdc','x','y','width','height','rop'], Rectangle: ['hdc','left','top','right','bottom'],
    GetDeviceCaps: ['hdc','index'],
    BitBlt: ['destDC','x','y','width','height','srcDC','srcX','srcY','rop'],
    TextOutA: ['dc','x','y','text'], TextOutW: ['dc','x','y','text'], FillRect: ['dc','rect','brush'],
    GetLastError: [], SetLastError: ['error'], GetModuleHandleA: ['name'], GetModuleHandleW: ['name'], LoadLibraryA: ['name'], LoadLibraryW: ['name'], GetProcAddress: ['module','name'],
    GetTickCount: [], GetTickCount64: [], Sleep: ['milliseconds'], QueryPerformanceCounter: ['value'], QueryPerformanceFrequency: ['value'], GetStdHandle: ['which'],
    WriteConsoleA: ['handle','buffer','chars','written'], WriteConsoleW: ['handle','buffer','chars','written'], ReadConsoleA: ['handle','buffer','chars','read'], ReadConsoleW: ['handle','buffer','chars','read'],
    WriteFile: ['handle','buffer','bytes','written'], ReadFile: ['handle','buffer','bytes','read'], CreateFileA: ['path','access','share','security','creation','flags','template'], CreateFileW: ['path','access','share','security','creation','flags','template'],
    CloseHandle: ['handle'], SetFilePointer: ['handle','distance','high','method'], GetCommandLineA: [], GetCommandLineW: [], GetEnvironmentVariableA: ['name','buffer','capacity'], GetEnvironmentVariableW: ['name','buffer','capacity'],
    lstrlenA: ['string'], lstrlenW: ['string'], lstrcmpA: ['a','b'], lstrcmpW: ['a','b'], VirtualAlloc: ['address','bytes','type','protect'], VirtualFree: ['address','bytes','type'], HeapAlloc: ['heap','flags','bytes'], HeapFree: ['heap','flags','address'], ExitProcess: ['code']
  };
  var API = {
    version: '1.0', constants: C, tables: TABLES, signatures: SIGNATURES,
    createRuntime: function (options) { return new Runtime(options); },
    createHost: function (options) { return new Runtime(options); },
    resolve: function (runtime, dll, name) {
      /* PE loaders traditionally call resolve(dll, name, ordinal, import).
         Keep that form alongside the explicit runtime form so a loader can
         bind imports before it has constructed its process object. */
      var implicit = false;
      if (!runtime || typeof runtime.resolve !== 'function') {
        implicit = true;
        name = dll; dll = runtime;
        runtime = API._default || (API._default = new Runtime());
      }
      return implicit && runtime.resolveImport ? runtime.resolveImport(dll, name) : runtime.resolve(dll, name);
    },
    resolveImport: function (dll, name, ordinal, imp) {
      var runtime = API._default || (API._default = new Runtime());
      return runtime.resolveImport(dll, name, ordinal, imp);
    },
    presentResult: function (path, result, options) {
      var runtime = (result && result.runtime) || API._default;
      if (!runtime || !result) return result;
      if (result.status !== 'exited' && result.status !== 'halted') {
        API.reportError(path, { code: result.status, message: result.message || result.status });
        return result;
      }
      /* GUI processes paint directly into their W98 shell window. Console
         processes get the same small modal surface used by the built-in
         command tools, with their captured WriteConsole output preserved. */
      if (result.console && W98 && W98.dialog && W98.dialog.alert) {
        var out = runtime.consoleText();
        if (!out) out = result.status === 'exited' ? 'Process exited with code ' + (result.exitCode || 0) + '.' : (result.message || result.status);
        try { W98.dialog.alert('Console — ' + String(path || 'program'), out, result.exitCode ? 'info' : 'info'); } catch (e) {}
      }
      return result;
    },
    reportError: function (path, error) {
      var msg = error && (error.message || error.code) || String(error || 'unknown error');
      if (W98 && W98.dialog && W98.dialog.alert) { try { W98.dialog.alert('Windows', 'Cannot run ' + String(path || 'program') + '.\n' + msg, 'error'); } catch (e) {} }
      return false;
    },
    call: function (runtime, dll, name, args) {
      /* `call(dll,name,args)` is accepted for small embedders; it uses a
         private runtime.  Production PE runners should pass their runtime. */
      if (typeof runtime === 'string') { args = name; name = dll; dll = runtime; runtime = API._default || (API._default = new Runtime()); }
      return runtime && runtime.call ? runtime.call(dll, name, args) : 0;
    },
    getExports: function (dll) { return (TABLES[low(dll)] || []).slice(); },
    Runtime: Runtime
  };
  function facade(dll) {
    var names = TABLES[dll].slice();
    names.names = names.slice();
    names.resolve = function (name) { return API.resolve(dll, name); };
    names.call = function (name, args) { return API.call(dll, name, args); };
    names.forEach(function (name) {
      names[name] = function () { return API.call(dll, name, Array.prototype.slice.call(arguments)); };
    });
    return names;
  }
  /* The facade is both an export-name list (useful to import binders) and a
     callable table for tiny embedders that do not need an explicit runtime. */
  API.user32 = facade('user32'); API.gdi32 = facade('gdi32'); API.kernel32 = facade('kernel32');
  global.W98Win32 = API;
  if (global.W98) global.W98.Win32 = API;
})(typeof window !== 'undefined' ? window : globalThis);
