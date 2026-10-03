/* ============================================================================
   control.js — Control Panel and the property sheets behind it.
   The sheets write to the kernel registry / filesystem, so the settings they
   change (wallpaper, colour scheme, screen saver, sound scheme, installed
   programs) really take effect.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98, I = window.W98Icons, U = W98.util;
  var el = U.el, esc = U.escapeHtml;

  var DESK = 'HKEY_CURRENT_USER\\Control Panel\\Desktop';
  var COLORS = 'HKEY_CURRENT_USER\\Control Panel\\Colors';
  var HKCU = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion';
  var APPLETS = 'HKEY_CURRENT_USER\\Software\\W98\\ControlPanel';

  /* ==================================================================== */
  /* colour schemes (really applied through an injected stylesheet)       */
  /* ==================================================================== */
  var SCHEMES = {
    'Windows Standard': { face: '#c0c0c0', light: '#dfdfdf', shadow: '#808080', dark: '#0a0a0a', titleA: '#000080', titleB: '#1084d0', text: '#000000', desktop: '0 128 128' },
    'Desert': { face: '#cc9966', light: '#ddbb99', shadow: '#996633', dark: '#000000', titleA: '#804000', titleB: '#d0a070', text: '#000000', desktop: '48 96 48' },
    'Rose': { face: '#d8b0a8', light: '#e8c8c0', shadow: '#a08078', dark: '#000000', titleA: '#800040', titleB: '#c08090', text: '#000000', desktop: '96 48 48' },
    'Slate': { face: '#a8b0b8', light: '#c8d0d8', shadow: '#788088', dark: '#000000', titleA: '#303850', titleB: '#8090a8', text: '#000000', desktop: '48 48 64' },
    'Eggplant': { face: '#b0a0b8', light: '#d0c0d8', shadow: '#807088', dark: '#000000', titleA: '#400060', titleB: '#9060b0', text: '#000000', desktop: '48 0 64' },
    'Plum (high contrast)': { face: '#000000', light: '#808080', shadow: '#404040', dark: '#ffffff', titleA: '#000080', titleB: '#0000ff', text: '#ffffff', desktop: '000000' },
    'Wheat': { face: '#d8c8a0', light: '#f0e0b8', shadow: '#a89870', dark: '#000000', titleA: '#404020', titleB: '#a09050', text: '#000000', desktop: '112 96 48' },
    'Marine (high contrast)': { face: '#000000', light: '#00ffff', shadow: '#008080', dark: '#ffffff', titleA: '#000080', titleB: '#0080c0', text: '#ffffff', desktop: '000040' }
  };
  function scheme() {
    return SCHEMES[W98.reg.get(DESK, 'ColorScheme', 'Windows Standard')] || SCHEMES['Windows Standard'];
  }
  function applyScheme(name) {
    var s = SCHEMES[name] || SCHEMES['Windows Standard'];
    W98.reg.set(DESK, 'ColorScheme', name);
    W98.reg.set(COLORS, 'ButtonFace', hexToRgb(s.face));
    W98.reg.set(COLORS, 'ActiveTitle', hexToRgb(s.titleA));
    W98.reg.set(COLORS, 'GradientActiveTitle', hexToRgb(s.titleB));
    var st = document.getElementById('w98-scheme') || el('style');
    st.id = 'w98-scheme';
    var desktopColor = W98.reg.get(COLORS, 'Background', null);
    st.textContent =
      'body{background:' + s.face + '}' +
      '.window,.w98-menu,#taskbar,.w98-toolbar,.w98-dialog,.w98-menubar,.w98-statusbar{background:' + s.face + ' !important}' +
      '.w98-window,.w98-window .window-body{background:' + s.face + '}' +
      'button,input[type=reset],input[type=submit]{background:' + s.face + ' !important}' +
      'button,input,label,legend,li[role=tab],option,select,table,textarea,ul.tree-view{color:' + s.text + '}' +
      '.title-bar{background:linear-gradient(90deg,' + s.titleA + ',' + s.titleB + ')}' +
      '.sm-band{background:linear-gradient(180deg,' + s.titleA + ',' + s.titleB + ')}' +
      '.w98-statusbar>.field{background:' + s.face + '}' +
      (desktopColor ? '#desktop{background-color:rgb(' + desktopColor.replace(/ /g, ',') + ')}' : '');
    if (!st.parentNode) document.head.appendChild(st);
    applyDesktopColor();
  }
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return '192 192 192';
    return parseInt(m[1], 16) + ' ' + parseInt(m[2], 16) + ' ' + parseInt(m[3], 16);
  }
  function applyDesktopColor() {
    var c = W98.reg.get(COLORS, 'Background', null);
    if (!c) return;
    var d = document.getElementById('desktop');
    if (d) d.style.backgroundColor = 'rgb(' + String(c).replace(/ /g, ',') + ')';
  }
  W98.applyScheme = applyScheme;
  W98.colorSchemes = SCHEMES;

  /* ==================================================================== */
  /* property sheet framework                                            */
  /* ==================================================================== */
  function makeSheet(win, title, tabs, opts) {
    opts = opts || {};
    var cur = opts.tab || 0;
    var bar = el('div', 'w98-tabs');
    var pages = el('div', 'w98-tabpage');
    var host = el('div', 'col grow');
    host.style.cssText = 'padding:8px;gap:0';
    host.appendChild(bar);
    host.appendChild(pages);
    var btns = el('div', 'row');
    btns.style.cssText = 'justify-content:flex-end;gap:6px;padding:8px';
    win.el.style.display = 'flex';
    win.el.style.flexDirection = 'column';
    win.el.appendChild(host);
    win.el.appendChild(btns);
    var builders = [];
    tabs.forEach(function (t, i) {
      var b = el('button', 'w98-tab');
      b.textContent = t.label;
      b.style.minWidth = '0';
      b.onclick = function () { show(i); };
      bar.appendChild(b);
      builders.push(t.build);
    });
    function show(i) {
      cur = i;
      [].slice.call(bar.children).forEach(function (b, j) { b.classList.toggle('active', j === i); });
      pages.innerHTML = '';
      var body = el('div', 'col');
      body.style.cssText = 'gap:8px;height:100%;overflow:auto';
      pages.appendChild(body);
      builders[i](body);
    }
    var okB = el('button', 'default', 'OK');
    var cancelB = el('button', '', 'Cancel');
    var applyB = el('button', '', 'Apply');
    okB.style.minWidth = '70px'; cancelB.style.minWidth = '70px'; applyB.style.minWidth = '70px';
    if (opts.noApply) applyB.disabled = true;
    btns.appendChild(okB); btns.appendChild(cancelB); btns.appendChild(applyB);
    var callbacks = [];
    function applyAll() {
      callbacks.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
      if (W98.shell && W98.shell.updateTaskbar) W98.shell.updateTaskbar();
    }
    okB.onclick = function () { applyAll(); win.close(); };
    cancelB.onclick = function () { win.close(); };
    applyB.onclick = function () { applyAll(); W98.sound.play('MenuCommand'); };
    show(cur);
    win.setTitle(title);
    return { onApply: function (f) { callbacks.push(f); }, showTab: show };
  }

  function field(label, control, hint) {
    var row = el('div', 'row');
    row.style.gap = '6px';
    row.style.alignItems = 'flex-start';
    var l = el('div', '', esc(label));
    l.style.cssText = 'flex:0 0 92px;padding-top:1px';
    row.appendChild(l);
    var c = el('div', 'col grow');
    c.style.gap = '4px';
    c.appendChild(control);
    if (hint) c.appendChild(el('div', '', esc(hint)));
    row.appendChild(c);
    return row;
  }
  function combo(options, value, onchange) {
    var sel = el('select');
    options.forEach(function (o) {
      var op = el('option', '', esc(o.value !== undefined ? o.label : o));
      op.value = o.value !== undefined ? o.value : o;
      sel.appendChild(op);
    });
    if (value != null) sel.value = value;
    if (onchange) sel.onchange = function () { onchange(sel.value); };
    return sel;
  }
  function checkbox(label, checked) {
    var wrap = el('label', 'field-row');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    wrap.appendChild(cb);
    wrap.appendChild(el('span', '', esc(label)));
    wrap._box = cb;
    return wrap;
  }
  function radio(label, checked, name) {
    var wrap = el('label', 'field-row');
    var rb = el('input');
    rb.type = 'radio';
    rb.name = name || 'radio';
    rb.checked = !!checked;
    wrap.appendChild(rb);
    wrap.appendChild(el('span', '', esc(label)));
    wrap._box = rb;
    return wrap;
  }

  /* ==================================================================== */
  /* Display Properties                                                   */
  /* ==================================================================== */
  var previewScreens = [];
  function monitorPreview(w, h) {
    var host = el('div');
    host.style.cssText = 'width:190px;height:150px;position:relative;flex:0 0 190px';
    var scr = el('div');
    scr.style.cssText = 'position:absolute;left:8px;top:6px;width:174px;height:118px;border:6px solid #c0c0c0;' +
      'box-shadow:inset 0 0 0 1px #404040;background:#008080;overflow:hidden;background-position:center;background-size:auto';
    var bd = el('div');
    bd.style.cssText = 'position:absolute;inset:0';
    scr.appendChild(bd);
    var foot = el('div');
    foot.style.cssText = 'position:absolute;left:60px;top:130px;width:70px;height:10px;background:#c0c0c0;border-radius:0';
    var base = el('div');
    base.style.cssText = 'position:absolute;left:40px;top:138px;width:110px;height:6px;background:#a0a0a0';
    host.appendChild(scr); host.appendChild(foot); host.appendChild(base);
    host._screen = bd;
    host._scr = scr;
    previewScreens.push(bd);
    return host;
  }
  function wallpaperPreviewDetach() { /* nothing to clean up: previews are DOM only */ }

  W98.registerApp({
    id: 'display', title: 'Display Properties', icon: 'display',
    width: 420, height: 420, minWidth: 420, minHeight: 420, resizable: false, singleton: true,
    create: function (win, args) {
      args = args || {};
      var pending = {
        wallpaper: W98.reg.get(DESK, 'Wallpaper', '(None)'),
        style: W98.reg.get(DESK, 'WallpaperStyle', '0'),
        saver: W98.reg.get(DESK, 'SCRNSAVE.EXE', 'C:\\WINDOWS\\SYSTEM\\WIN98.SCR'),
        timeout: W98.reg.get(DESK, 'ScreenSaveTimeOut', '600'),
        active: W98.reg.get(DESK, 'ScreenSaveActive', '1'),
        scheme: W98.reg.get(DESK, 'ColorScheme', 'Windows Standard')
      };
      var sheet = makeSheet(win, 'Display Properties', [
        {
          label: 'Background', build: function (b) {
            var monitor = monitorPreview();
            b.appendChild(monitor);
            var list = el('div', 'w98-listbox');
            list.style.cssText = 'height:130px';
            var wps = W98.wallpaperList();
            wps.forEach(function (w) {
              var row = el('div', 'w98-listitem', esc(w.name));
              if (w.name === pending.wallpaper) row.classList.add('selected');
              row.onclick = function () {
                list.querySelectorAll('.w98-listitem').forEach(function (n) { n.classList.remove('selected'); });
                row.classList.add('selected');
                pending.wallpaper = w.name;
                pending.key = w.key;
                updatePreview();
              };
              row.ondblclick = function () { sheet.onApply && null; };
              list.appendChild(row);
            });
            b.appendChild(field('Wallpaper:', list));
            var styleCombo = combo([
              { value: '0', label: 'Center' }, { value: '1', label: 'Tile' }, { value: '2', label: 'Stretch' }
            ], pending.style, function (v) { pending.style = v; updatePreview(); });
            styleCombo.style.width = '140px';
            b.appendChild(field('Display:', comboWrap(styleCombo)));
            var patternB = el('button', '', 'Pattern...');
            patternB.style.minWidth = '80px';
            patternB.onclick = function () {
              W98.dialog.alert('Pattern', 'No pattern is defined for this wallpaper.\nPatterns are tiny 8x8 bitmaps; this desktop ships tiled wallpaper instead.', 'info');
            };
            b.appendChild(field('', patternB));
            updatePreview();
          }
        },
        {
          label: 'Screen Saver', build: function (b) {
            var monitor = monitorPreview();
            b.appendChild(monitor);
            var names = Object.keys(W98.saverNames).map(function (k) { return k; });
            var sc = combo(names.map(function (k) { return { value: k, label: W98.saverNames[k] }; }), pending.saver, function (v) {
              pending.saver = v;
              updatePreview();
            });
            b.appendChild(field('Screen Saver', comboWrap(sc)));
            var rowB = el('div', 'row');
            rowB.style.gap = '6px';
            var setB = el('button', '', 'Settings...');
            setB.style.minWidth = '80px';
            setB.onclick = function () {
              W98.dialog.alert('Settings for ' + (W98.saverNames[pending.saver] || 'Screen Saver'),
                'This screen saver has no options you can set.\n\nThe effect is drawn by the desktop shell\n(Mystify, Starfield, Flying Windows or the Windows 98 logo).', 'info');
            };
            var prevB = el('button', '', 'Preview');
            prevB.style.minWidth = '80px';
            prevB.onclick = function () { W98.startSaver(pending.saver); };
            rowB.appendChild(setB); rowB.appendChild(prevB);
            b.appendChild(field('', rowB));
            var waitRow = el('div', 'row');
            var wait = el('input');
            wait.type = 'number'; wait.min = '1'; wait.max = '9999';
            wait.value = Math.round(parseInt(pending.timeout, 10) / 60);
            wait.style.width = '60px';
            wait.onchange = function () { pending.timeout = String(Math.max(1, parseInt(wait.value, 10) || 10) * 60); };
            waitRow.appendChild(wait);
            waitRow.appendChild(el('span', '', 'minutes'));
            b.appendChild(field('Wait:', waitRow));
            var pw = checkbox('Password protected', false);
            pw._box.disabled = true;
            pw.style.opacity = '.6';
            b.appendChild(field('', pw));
          }
        },
        {
          label: 'Appearance', build: function (b) {
            var preview = el('div');
            preview.style.cssText = 'height:90px;background:#c0c0c0;box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #dfdfdf,inset -2px -2px grey,inset 2px 2px #fff;padding:6px';
            var inner = el('div');
            inner.style.cssText = 'height:100%;background:#c0c0c0';
            var tb = el('div');
            tb.style.cssText = 'height:16px;color:#fff;font-weight:bold;padding:2px 4px;background:linear-gradient(90deg,#000080,#1084d0)';
            tb.textContent = 'Active Window';
            var body = el('div');
            body.style.cssText = 'padding:6px;background:#c0c0c0';
            body.appendChild(el('div', '', 'Inactive Window'));
            inner.appendChild(tb); inner.appendChild(body);
            preview.appendChild(inner);
            b.appendChild(preview);
            b.appendChild(field('Scheme:', combo(Object.keys(SCHEMES), pending.scheme, function (v) {
              pending.scheme = v;
              var s = SCHEMES[v];
              tb.style.background = 'linear-gradient(90deg,' + s.titleA + ',' + s.titleB + ')';
              preview.style.background = s.face;
              inner.style.background = s.face;
              body.style.background = s.face;
            })));
            b.appendChild(field('Item:', combo([
              'Desktop', 'Active Title Bar', 'Inactive Title Bar', 'Menu', 'Window', 'Button Face'
            ], 'Desktop', function () { })));
            var colCombo = combo(['Teal', 'Black', 'White', 'Navy Blue', 'Dark Grey', 'Custom...'], 'Teal', function (v) {
              var map = { 'Teal': '0 128 128', 'Black': '0 0 0', 'White': '255 255 255', 'Navy Blue': '0 0 128', 'Dark Grey': '64 64 64' };
              if (map[v]) { W98.reg.set(COLORS, 'Background', map[v]); applyDesktopColor(); }
              else pickColor(function (rgb) { W98.reg.set(COLORS, 'Background', rgb); applyDesktopColor(); });
            });
            colCombo.style.width = '120px';
            b.appendChild(field('Color:', comboWrap(colCombo)));
            b.appendChild(field('Font:', combo(['MS Sans Serif 8', 'MS Sans Serif 10', 'Tahoma 8', 'Lucida Console 10'], 'MS Sans Serif 8', function (v) {
              var size = /=?(\d+)/.exec(v);
              var px = v.indexOf('10') >= 0 ? 12 : 11;
              document.documentElement.style.fontSize = px + 'px';
              void size;
            })));
          }
        },
        {
          label: 'Effects', build: function (b) {
            b.appendChild(checkbox('Use large icons', true));
            b.appendChild(checkbox('Show icons using all possible colors', true));
            b.appendChild(checkbox('Animate windows when minimizing and maximizing', true));
            b.appendChild(checkbox('Smooth edges of screen fonts', false));
            b.appendChild(checkbox('Show window contents while dragging', W98.reg.get(DESK, 'DragFullWindows', '1') === '1'))._box;
            b.appendChild(checkbox('Hide icons when the desktop is viewed as a Web page', false));
          }
        },
        {
          label: 'Web', build: function (b) {
            b.appendChild(el('div', '', 'View this folder\'s Web content:'));
            b.appendChild(checkbox('My Current Home Page', false));
            b.appendChild(el('div', '', 'Windows Desktop Update lets you add Web content to your desktop.\n' +
              'This desktop runs offline, so channels are disabled.'));
            var b2 = el('button', '', 'New...');
            b2.onclick = function () { W98.dialog.alert('Web', 'Active Desktop channels are not available offline.', 'info'); };
            b.appendChild(b2);
          }
        }
      ], { tab: args.tab != null ? args.tab : 0 });

      function comboWrap(c) { var w = el('div', 'row'); w.style.gap = '4px'; c.style.width = '160px'; w.appendChild(c); return w; }
      function updatePreview() {
        previewScreens.forEach(applyPreview);
      }
      function applyPreview(node) {
        var w = W98.wallpaperList().filter(function (x) { return x.name === pending.wallpaper; })[0];
        node.style.backgroundColor = 'rgb(' + String(W98.reg.get(COLORS, 'Background', '0 128 128')).replace(/ /g, ',') + ')';
        if (w && w.file) {
          node.style.backgroundImage = 'url("' + w.file + '")';
          node.style.backgroundSize = pending.style === '2' ? '100% 100%' : (pending.style === '1' ? 'auto' : 'auto');
          node.style.backgroundRepeat = pending.style === '0' ? 'no-repeat' : 'repeat';
          node.style.backgroundPosition = pending.style === '0' ? 'center' : '0 0';
        } else {
          node.style.backgroundImage = 'none';
        }
      }
      sheet.onApply(function () {
        W98.reg.set(DESK, 'Wallpaper', pending.wallpaper);
        W98.reg.set(DESK, 'WallpaperStyle', pending.style);
        W98.reg.set(DESK, 'SCRNSAVE.EXE', pending.saver);
        W98.reg.set(DESK, 'ScreenSaveTimeOut', pending.timeout);
        W98.reg.set(DESK, 'ScreenSaveActive', pending.active);
        applyScheme(pending.scheme);
        W98.applyDesktop();
      });
      function pickColor(cb) {
        var colors = ['#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080', '#800080',
          '#c0c0c0', '#ffffff', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff',
          '#804000', '#ff8000', '#004000', '#00ff80', '#004080', '#0080ff', '#400080', '#8000ff'];
        var body = el('div');
        body.style.cssText = 'display:grid;grid-template-columns:repeat(8,24px);gap:2px';
        var chosen = null;
        colors.forEach(function (c) {
          var cell = el('div');
          cell.style.cssText = 'width:24px;height:24px;background:' + c + ';border:1px solid #000';
          cell.onclick = function () { chosen = c; };
          body.appendChild(cell);
        });
        W98.dialog.messageBox('Color', '', {
          buttons: ['OK', 'Cancel'], results: ['ok', null], width: 240,
          buildExtra: function (box) {
            box.appendChild(el('div', '', 'Basic colors:'));
            box.appendChild(body);
          }
        }).then(function (r) {
          if (r === 'ok' && chosen) {
            cb(hexToRgb(chosen));
          }
        });
      }
      if (args.preview) updatePreview();
      return { onClose: function () { } };
    }
  });

  /* ==================================================================== */
  /* System Properties                                                    */
  /* ==================================================================== */
  W98.registerApp({
    id: 'system', title: 'System Properties', icon: 'system',
    width: 400, height: 420, resizable: false, singleton: true,
    create: function (win, args) {
      args = args || {};
      var DEVICES = [
        ['Computer', ['Plug and Play BIOS', 'APM (Advanced Power Management)']],
        ['Disk drives', ['GENERIC IDE DISK TYPE47']],
        ['Display adapters', ['WebGL Display Adapter (emulated)']],
        ['Floppy disk controllers', ['Standard Floppy Disk Controller']],
        ['Hard disk controllers', ['Intel 82371AB/EB PCI Bus Master IDE Controller']],
        ['Keyboard', ['Standard 101/102-Key or Microsoft Natural Keyboard']],
        ['Modems', ['Standard 56000 bps Modem']],
        ['Monitors', ['Plug and Play Monitor']],
        ['Mouse', ['PS/2 Compatible Mouse Port']],
        ['Network adapters', ['Dial-Up Adapter', 'NE2000 Compatible (not present)']],
        ['Ports (COM & LPT)', ['Communications Port (COM1)', 'ECP Printer Port (LPT1)']],
        ['Sound, video and game controllers', ['Sound Blaster 16 (Web Audio emulated)', 'Audio Codecs']],
        ['System devices', ['Advanced Programmable Interrupt Controller', 'Direct Memory Access Controller',
          'WebAssembly Virtual Machine (kernel.wasm)', 'System CMOS/real time clock', 'System timer']]
      ];
      var st = W98.stats();
      makeSheet(win, 'System Properties', [
        {
          label: 'General', build: function (b) {
            var box = el('div');
            box.style.cssText = 'display:flex;gap:12px;padding:4px';
            var flag = el('div');
            flag.appendChild(I.el('win-flag', 48));
            box.appendChild(flag);
            var info = el('div');
            info.innerHTML =
              '<b>System:</b><br>' +
              '&nbsp;&nbsp;&nbsp;Microsoft Windows 98<br>' +
              '&nbsp;&nbsp;&nbsp;4.10.1998<br>' +
              '&nbsp;&nbsp;&nbsp;WebAssembly build, kernel.wasm (' + (W98.kernelMode() === 'wasm' ? Math.round(W98.moduleBytes() / 1024) + ' KB image' : 'reduced JS fallback') + ')<br><br>' +
              '<b>Computer:</b><br>' +
              '&nbsp;&nbsp;&nbsp;' + 'GenuineIntel Pentium(r) II Processor (emulated)<br>' +
              '&nbsp;&nbsp;&nbsp;' + Math.round(st.HEAP_SIZE / 1024) + ' KB physically available to the kernel<br>' +
              '&nbsp;&nbsp;&nbsp;' + Math.round(st.HEAP_USED / 1024) + ' KB in use, ' + Math.round(st.HEAP_FREE / 1024) + ' KB free<br><br>' +
              '<b>Registered to:</b><br>&nbsp;&nbsp;&nbsp;' + esc(W98.shell.USER) + '<br>' +
              '&nbsp;&nbsp;&nbsp;Windows 98 Web Edition<br>' +
              '&nbsp;&nbsp;&nbsp;Product ID: 1998-0528-OEM-0000000-00000';
            box.appendChild(info);
            b.appendChild(box);
            var more = el('div');
            more.innerHTML = '<br>kernel ABI 0x' + (st.VERSION >>> 0).toString(16) + ' &nbsp; ' + st.SYSCALLS + ' syscalls so far';
            b.appendChild(more);
          }
        },
        {
          label: 'Device Manager', build: function (b) {
            var tree = el('ul', 'w98-tree');
            tree.style.height = '230px';
            DEVICES.forEach(function (group) {
              var li = el('li');
              var tw = el('div', 'tw', '+');
              li.appendChild(tw);
              li.appendChild(I.el('my-computer', 16));
              li.appendChild(el('span', '', group[0]));
              var ul = el('ul');
              group[1].forEach(function (d) {
                var sub = el('li');
                sub.appendChild(el('div', 'tw empty'));
                sub.appendChild(I.el(group[0] === 'System devices' ? 'system' : 'hard-disk', 16));
                sub.appendChild(el('span', '', d));
                sub.onclick = function () { showDevice(d); };
                ul.appendChild(sub);
              });
              li.appendChild(ul);
              ul.style.display = 'none';
              tw.onclick = function () {
                var open = ul.style.display !== 'none';
                ul.style.display = open ? 'none' : 'block';
                tw.textContent = open ? '+' : '-';
              };
              tree.appendChild(li);
            });
            b.appendChild(tree);
            function showDevice(name) {
              W98.dialog.alert(name + ' Properties',
                'General\n\n' + name + '\n\nDevice type: System device\nManufacturer: (Standard system devices)\n' +
                'Hardware version: 1.0\nLocation: on the WebAssembly virtual machine\n\n' +
                'Device Status\nThis device is working properly.\n\n' +
                'It is emulated inside kernel.wasm in your browser; no real hardware is touched.', 'info');
            }
          }
        },
        {
          label: 'Performance', build: function (b) {
            var st2 = W98.stats();
            function gauge(label, pct, note) {
              var row = el('div');
              row.appendChild(el('div', '', esc(label)));
              var bar = el('div', 'w98-progress');
              bar.style.width = '200px';
              var inner = el('i');
              inner.style.width = Math.round(pct) + '%';
              bar.appendChild(inner);
              row.appendChild(bar);
              if (note) row.appendChild(el('div', '', esc(note)));
              b.appendChild(row);
              return row;
            }
            var heapTotal = Math.max(1, st2.HEAP_SIZE);
            gauge('Memory: ' + Math.round(st2.HEAP_USED / 1024) + ' KB used of ' + Math.round(heapTotal / 1024) + ' KB',
              (st2.HEAP_USED / heapTotal) * 100,
              'kernel heap, peak ' + Math.round(W98.heapPeak() / 1024) + ' KB');
            gauge('System Resources: ' + Math.round((st2.HEAP_FREE / heapTotal) * 100) + '% free',
              100 - (st2.HEAP_USED / heapTotal) * 100,
              st2.NDESC + ' processes, ' + st2.QUEUE + ' timers queued');
            gauge('Volume: ' + Math.round(st2.BYTES / 1024) + ' KB in ' + st2.FILES + ' files',
              Math.min(100, (st2.BYTES / (2 * 1024 * 1024)) * 100),
              st2.NODES + ' filesystem nodes');
            var adv = el('button', '', 'Advanced...');
            adv.onclick = function () {
              W98.dialog.alert('Advanced', 'The WebAssembly kernel has no swap file and no virtual memory.\n' +
                'Everything it owns lives in ' + Math.round(st2.HEAP_SIZE / 1024) + ' KB of linear memory.', 'info');
            };
            b.appendChild(adv);
            b.appendChild(el('div', '', 'File System...  Graphics...  Virtual Memory...'));
          }
        }
      ], { tab: args.tab != null ? args.tab : 0 });
      return {};
    }
  });

  /* ==================================================================== */
  /* Control Panel                                                        */
  /* ==================================================================== */
  var CP_APPLETS = [
    ['Accessibility Options', 'accessibility', function () { W98.launch('accessibility'); }],
    ['Add New Hardware', 'add-hardware', function () { W98.launch('addhardware'); }],
    ['Add/Remove Programs', 'add-remove', function () { W98.launch('addremove'); }],
    ['Date/Time', 'datetime', function () { W98.launch('datetime'); }],
    ['Display', 'display', function () { W98.launch('display'); }],
    ['Fonts', 'fonts', function () { W98.launch('explorer', { path: 'C:\\WINDOWS\\FONTS', title: 'Fonts' }); }],
    ['Game Controllers', 'pinball', function () { W98.launch('gamepad'); }],
    ['Internet Options', 'internet-options', function () { W98.launch('internetoptions'); }],
    ['Keyboard', 'keyboard', function () { W98.launch('keyboard'); }],
    ['Modems', 'modems', function () { W98.launch('modems'); }],
    ['Mouse', 'mouse', function () { W98.launch('mouse'); }],
    ['Multimedia', 'multimedia', function () { W98.launch('multimedia'); }],
    ['Network', 'network-config', function () { W98.launch('networkconfig'); }],
    ['Power Management', 'power', function () { W98.launch('power'); }],
    ['Regional Settings', 'regional', function () { W98.launch('regional'); }],
    ['Sounds', 'sounds', function () { W98.launch('sounds'); }],
    ['System Restore', 'system', function () { W98.launch('restore'); }],
    ['System', 'system', function () { W98.launch('system'); }],
    ['Users', 'users', function () { W98.launch('users'); }]
  ];

  W98.registerApp({
    id: 'control', title: 'Control Panel', icon: 'control-panel',
    width: 500, height: 330, minWidth: 400, minHeight: 260,
    desktop: false, startMenuGroup: null,
    create: function (win, args) {
      args = args || {};
      var host = el('div', 'grow');
      host.style.overflow = 'auto';
      host.style.background = '#fff';
      host.style.boxShadow = 'inset -1px -1px #fff, inset 1px 1px grey, inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a';
      host.style.margin = '2px';
      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';
      var toolbar = el('div', 'w98-toolbar');
      var up = el('button', 'w98-toolbtn');
      up.appendChild(I.el('up', 20));
      up.title = 'Up One Level';
      up.onclick = function () { W98.launch('explorer', { path: 'C:\\', special: 'computer' }); };
      toolbar.appendChild(up);
      win.el.appendChild(toolbar);
      win.el.appendChild(host);
      var view = el('div', 'iconview');
      CP_APPLETS.forEach(function (a) {
        var cell = el('div', 'cell');
        var ic = el('span', 'ic');
        ic.appendChild(I.el(a[1], 32));
        cell.appendChild(ic);
        cell.appendChild(el('div', 'lbl', esc(a[0])));
        cell.onmousedown = function () {
          view.querySelectorAll('.cell').forEach(function (c) { c.classList.remove('sel'); });
          cell.classList.add('sel');
        };
        cell.ondblclick = a[2];
        host.appendChild(view);
        view.appendChild(cell);
      });
      win.setMenu([
        { label: '&File', items: [{ label: '&Close', onclick: function () { win.close(); } }] },
        { label: '&Edit', items: [{ label: 'Select &All', onclick: function () { view.querySelectorAll('.cell').forEach(function (c) { c.classList.add('sel'); }); } }] },
        { label: '&View', items: [
          { label: '&Large Icons', type: 'radio', checked: true },
          { label: '&Small Icons', type: 'radio' },
          { label: '&List', type: 'radio' },
          { label: '&Details', type: 'radio' },
          { type: 'sep' },
          { label: '&Refresh', onclick: function () { } }
        ] },
        { label: '&Help', items: [{ label: 'Help Topics', onclick: function () { W98.launch('help'); } }] }
      ]);
      win.setStatus([{ text: CP_APPLETS.length + ' object(s)', width: 200 }, { text: 'Control Panel' }]);
      if (args.applet === 'taskbar') W98.launch('taskbarsettings');
      if (args.applet === 'folder') W98.launch('folderoptions');
      return {};
    }
  });

  /* ==================================================================== */
  /* Date/Time, Sounds, Mouse, Keyboard sheets and the small applets      */
  /* ==================================================================== */
  function simpleSheet(def, tabs, opts) {
    W98.registerApp({
      id: def.id, title: def.title, icon: def.icon,
      width: def.width || 380, height: def.height || 340,
      resizable: !!def.resizable, singleton: true,
      create: function (win, args) {
        args = args || {};
        makeSheet(win, def.title, tabs(win, args), { tab: args.tab || 0, noApply: def.noApply });
        return {};
      }
    });
  }

  simpleSheet({ id: 'datetime', title: 'Date/Time Properties', icon: 'datetime', width: 380, height: 400 }, function (win) {
    return [{
      label: 'Date & Time', build: function (b) {
        var box = el('div');
        box.style.cssText = 'display:flex;gap:10px';
        var cal = el('div', 'w98-raised');
        cal.style.cssText = 'width:150px;padding:6px;text-align:center';
        var monthLabel = el('div');
        var grid = el('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(7,18px);gap:1px;margin-top:4px';
        var d = new Date();
        var y = d.getFullYear(), m = d.getMonth();
        function buildCalendar() {
          var first = new Date(y, m, 1).getDay();
          var days = new Date(y, m + 1, 0).getDate();
          monthLabel.textContent = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
            'September', 'October', 'November', 'December'][m] + ' ' + y;
          grid.innerHTML = '';
          ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (s) {
            var c = el('div', '', s);
            c.style.cssText = 'font-weight:bold;height:14px;color:#808080';
            grid.appendChild(c);
          });
          for (var i = 0; i < first; i++) grid.appendChild(el('div'));
          for (var day = 1; day <= days; day++) {
            var c2 = el('div', '', String(day));
            c2.style.cssText = 'height:16px;line-height:16px;cursor:default';
            if (day === d.getDate()) { c2.style.background = '#000080'; c2.style.color = '#fff'; }
            grid.appendChild(c2);
          }
        }
        buildCalendar();
        var nav = el('div', 'row');
        nav.style.cssText = 'justify-content:center;gap:8px;margin-top:4px';
        var pv = el('button', '', '\u25c0');
        var nx = el('button', '', '\u25b6');
        pv.style.minWidth = '20px'; nx.style.minWidth = '20px';
        pv.onclick = function () { m--; if (m < 0) { m = 11; y--; } buildCalendar(); };
        nx.onclick = function () { m++; if (m > 11) { m = 0; y++; } buildCalendar(); };
        nav.appendChild(pv); nav.appendChild(nx);
        cal.appendChild(monthLabel); cal.appendChild(grid); cal.appendChild(nav);
        box.appendChild(cal);
        var timeBox = el('div', 'col');
        timeBox.style.gap = '4px';
        var clk = el('div', 'w98-field');
        clk.style.cssText = 'font:16px "Lucida Console",monospace;padding:4px 6px;background:#000;color:#c0c0c0';
        function tick() {
          if (win.closed) return;
          clk.textContent = new Date().toLocaleTimeString();
        }
        tick();
        win.setInterval(tick, 500);
        timeBox.appendChild(clk);
        var tz = el('div');
        tz.innerHTML = 'Time Zone<br>';
        var zones = [
          '(GMT-08:00) Pacific Time (US & Canada); Tijuana',
          '(GMT-07:00) Mountain Time (US & Canada)',
          '(GMT-06:00) Central Time (US & Canada)',
          '(GMT-05:00) Eastern Time (US & Canada)',
          '(GMT) Greenwich Mean Time; Dublin, Edinburgh, London',
          '(GMT+01:00) Amsterdam, Berlin, Rome, Vienna'
        ];
        var zc = combo(zones, W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\TimeZone', 'Zone', zones[0]), function (v) {
          W98.reg.set('HKEY_CURRENT_USER\\Control Panel\\TimeZone', 'Zone', v);
        });
        zc.style.width = '100%';
        timeBox.appendChild(zc);
        box.appendChild(timeBox);
        b.appendChild(box);
        b.appendChild(el('div', '', 'This desktop reads the real system clock of your computer.'));
      }
    }];
  });

  simpleSheet({ id: 'sounds', title: 'Sounds Properties', icon: 'sounds', width: 420, height: 380 }, function (win) {
    var sel = null;
    return [{
      label: 'Sounds', build: function (b) {
        var events = [];

        function collect() {
          events = [];
          var n = W98.regCount();
          for (var i = 0; i < n; i++) {
            var r = W98.regEnum(i);
            if (!r) continue;
            if (r.path.indexOf('\\AppEvents\\Schemes\\Apps\\.Default\\') >= 0 && r.name === '.Current') {
              events.push({ ev: r.path.split('\\').pop(), value: r.value });
            }
          }
          events.sort(function (a, c) { return a.ev < c.ev ? -1 : 1; });
        }
        collect();
        var tree = el('ul', 'w98-tree');
        tree.style.height = '120px';
        var rootLi = el('li');
        var tw = el('div', 'tw', '-');
        rootLi.appendChild(tw);
        rootLi.appendChild(el('span', '', 'Windows'));
        var childUl = el('ul');
        events.forEach(function (e) {
          var li = el('li');
          li.appendChild(el('div', 'tw empty'));
          li.appendChild(I.el('sounds', 16));
          li.appendChild(el('span', '', e.ev));
          li.onclick = function () {
            childUl.querySelectorAll('li').forEach(function (x) { x.classList.remove('sel'); });
            li.classList.add('sel');
            sel = e;
            soundsCombo.value = e.value.split('\\').pop();
          };
          childUl.appendChild(li);
        });
        rootLi.appendChild(childUl);
        tree.appendChild(rootLi);
        b.appendChild(tree);

        var wavs = (W98.fs.list('C:\\WINDOWS\\MEDIA') || []).filter(function (x) { return !x.dir && /\.wav$/i.test(x.name); })
          .map(function (x) { return x.name; });
        var soundsCombo = combo(['(None)'].concat(wavs), '(None)', function (v) { });
        soundsCombo.style.width = '220px';
        b.appendChild(field('Sounds:', comboWrap2(soundsCombo)));
        var nameBox = el('input');
        nameBox.type = 'text';
        nameBox.readOnly = true;
        nameBox.value = 'Windows';
        nameBox.style.width = '220px';
        b.appendChild(field('Name:', nameBox));
        var pb = el('button', '', 'Preview');
        pb.style.minWidth = '75px';
        pb.onclick = function () {
          var ev = sel ? sel.ev : 'SystemAsterisk';
          W98.reg.set('HKEY_CURRENT_USER\\AppEvents\\Schemes\\Apps\\.Default\\' + ev, '.Current',
            'C:\\WINDOWS\\MEDIA\\' + (soundsCombo.value || 'DING.WAV'));
          W98.sound.play(ev);
          nameBox.value = soundsCombo.value.replace(/\.wav$/i, '');
        };
        var rb = el('button', '', 'Browse...');
        rb.style.minWidth = '75px';
        rb.onclick = function () {
          W98.dialog.fileOpen({ path: 'C:\\WINDOWS\\MEDIA', filter: '*.wav' }).then(function (p) {
            if (!p) return;
            var base = p.split('\\').pop();
            if (wavs.indexOf(base) < 0) { wavs.push(base); soundsCombo.appendChild(el('option', '', base)); }
            soundsCombo.value = base;
          });
        };
        var row = el('div', 'row');
        row.style.gap = '6px';
        row.appendChild(pb); row.appendChild(rb);
        b.appendChild(row);
        var schemeCombo = combo(['Windows Default'], 'Windows Default', function () { });
        schemeCombo.style.width = '220px';
        b.appendChild(field('Scheme:', comboWrap2(schemeCombo)));
        b.appendChild(el('div', '', 'Sound files live in C:\\WINDOWS\\MEDIA and are read through the kernel filesystem.'));
        resettable(function () { W98.sound.play('SystemAsterisk'); });
      }
    }];
  });

  simpleSheet({ id: 'mouse', title: 'Mouse Properties', icon: 'mouse', width: 380, height: 340 }, function (win) {
    return [
      { label: 'Buttons', build: function (b) {
        var cfg = combo(['Right-handed', 'Left-handed'], W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Mouse', 'SwapButtons', '0') === '1' ? 'Left-handed' : 'Right-handed', function () { });
        cfg.style.width = '140px';
        b.appendChild(field('Button configuration:', comboWrap2(cfg)));
        b.appendChild(checkbox('Double-click speed tester', true));
        b.appendChild(el('div', '', 'Double-click speed is fixed at the host setting: this desktop\nuses the browser\'s own double-click detection.'));
      } },
      { label: 'Pointers', build: function (b) {
        var schemeCombo = combo(['Windows Standard', '(None)'], W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Cursors', 'Scheme', 'Windows Standard'), function (v) {
          W98.reg.set('HKEY_CURRENT_USER\\Control Panel\\Cursors', 'Scheme', v);
          document.documentElement.classList.toggle('cur-none', v === '(None)');
        });
        schemeCombo.style.width = '160px';
        b.appendChild(field('Scheme:', comboWrap2(schemeCombo)));
        var trail = checkbox('Show pointer trails', W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Mouse', 'Trails', '0') === '1');
        trail._box.onchange = function () {
          W98.reg.set('HKEY_CURRENT_USER\\Control Panel\\Mouse', 'Trails', trail._box.checked ? '1' : '0');
          W98.setPointerTrails(trail._box.checked);
        };
        b.appendChild(trail);
        var shadow = checkbox('Show pointer shadow', W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Mouse', 'Shadow', '1') === '1');
        b.appendChild(shadow);
        b.appendChild(checkbox('Show location of pointer when I press the CTRL key', false));
      } },
      { label: 'Motion', build: function (b) {
        b.appendChild(checkbox('Pointer speed: Slow ... Fast (host setting)', true));
        b.appendChild(checkbox('Snap To', false));
        b.appendChild(el('div', '', 'Pointer speed and acceleration are governed by your operating system.'));
      } }
    ];
  });

  simpleSheet({ id: 'keyboard', title: 'Keyboard Properties', icon: 'keyboard', width: 380, height: 300 }, function (win) {
    return [{
      label: 'Speed', build: function (b) {
        b.appendChild(field('Repeat delay:', combo(['Long', 'Medium', 'Short'], 'Medium', function () { })));
        b.appendChild(field('Repeat rate:', combo(['Slow', 'Medium', 'Fast'], 'Fast', function () { })));
        var blink = combo(['No blinking', 'Slow', 'Medium', 'Fast'], W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Desktop', 'CursorBlinkRate', 'Medium'), function (v) {
          W98.reg.set('HKEY_CURRENT_USER\\Control Panel\\Desktop', 'CursorBlinkRate', v);
        });
        blink.style.width = '140px';
        b.appendChild(field('Cursor blink rate:', comboWrap2(blink)));
        b.appendChild(el('div', '', 'The MS-DOS Prompt caret follows this setting.'));
      }
    }];
  });

  simpleSheet({ id: 'addhardware', title: 'Add New Hardware Wizard', icon: 'add-hardware', width: 400, height: 300, noApply: false }, function (win) {
    return [{
      label: 'Add New Hardware', build: function (b) {
        b.innerHTML =
          '<div style="padding:10px;line-height:16px">' +
          '<b>Add New Hardware Wizard</b>' +
          '<hr class="w98-hr">' +
          'This wizard searches the system for new hardware and installs the drivers for it.' +
          '<br><br>Plug and Play hardware is detected automatically. The virtual machine this desktop ' +
          'runs on exposes one WebAssembly CPU, a linear memory, an emulated display adapter backed by ' +
          '<b>&lt;canvas&gt;</b>, an emulated keyboard and mouse, and Web Audio for the sound card.' +
          '<br><br>There is no ISA or PCI bus to probe, so <b>Next</b> would find nothing new.' +
          '</div>';
      }
    }];
  });

  simpleSheet({ id: 'addremove', title: 'Add/Remove Programs', icon: 'add-remove', width: 420, height: 400 }, function (win) {
    return [
      { label: 'Install/Uninstall', build: function (b) {
        var programs = [];
        (W98.fs.list('C:\\Program Files') || []).forEach(function (e) {
          if (e.dir) programs.push({ name: e.name, size: 0, path: 'C:\\Program Files\\' + e.name, system: false });
        });
        W98.registry.forEach(function (a) {
          if (a.desktop || a.startMenuGroup) programs.push({ name: a.title || a.id, app: a.id, size: 0, system: true });
        });
        var list = el('div', 'w98-listbox');
        list.style.height = '200px';
        var selRow = null;
        programs.forEach(function (p) {
          var row = el('div', 'w98-listitem');
          row.appendChild(I.el(p.system ? (p.app && W98.getApp(p.app) ? (W98.getApp(p.app).icon || 'exe-file') : 'exe-file') : 'folder', 16));
          row.appendChild(el('span', '', esc(p.name)));
          row._prog = p;
          row.onclick = function () {
            list.querySelectorAll('.w98-listitem').forEach(function (n) { n.classList.remove('selected'); });
            row.classList.add('selected');
            selRow = row;
          };
          list.appendChild(row);
        });
        b.appendChild(el('div', '', 'To install a new program from a floppy disk or CD-ROM drive,\nclick Install.'));
        b.appendChild(el('div', 'row').appendChild(el('button', '', 'Install...')).parentNode);
        b.appendChild(el('div', '', 'The following software can be automatically removed.'));
        b.appendChild(list);
        var removeB = el('button', '', 'Add/Remove...');
        removeB.style.minWidth = '95px';
        removeB.onclick = function () {
          if (!selRow) { W98.sound.play('DefaultBeep'); return; }
          var p = selRow._prog;
          W98.dialog.confirm('Add/Remove Programs', 'Are you sure you want to remove \'' + p.name + '\'?').then(function (yes) {
            if (!yes) return;
            if (p.path) {
              W98.fs.remove(p.path);
              W98.dialog.alert('Add/Remove Programs', '\'' + p.name + '\' was removed from the kernel volume.', 'info');
            } else {
              W98.dialog.alert('Add/Remove Programs',
                '\'' + p.name + '\' is a built-in Windows component and cannot be removed from here.\n' +
                'Use the Windows Setup tab to add or remove components.', 'info');
            }
            win.close();
            W98.launch('addremove');
          });
        };
        var row2 = el('div', 'row');
        row2.style.marginTop = '8px';
        row2.appendChild(removeB);
        b.appendChild(row2);
      } },
      { label: 'Windows Setup', build: function (b) {
        b.appendChild(el('div', '', 'To add or remove a component, click the checkbox. A shaded box means\nthat only part of the component will be installed.'));
        var comps = [
          ['Accessories', 'notepad,paint,calculator,charmap', true],
          ['Games', 'minesweeper,solitaire,freecell,jezzball,pinball', W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'CompGames', '1') === '1'],
          ['MS-DOS Games (shareware)', 'dosgame', W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'CompDosGames', '1') === '1'],
          ['Communications', 'ie,outlook', true],
          ['System Tools', 'taskmgr', true],
          ['Multimedia', 'mplayer,sounds', true]
        ];
        var list = el('div', 'w98-listbox');
        list.style.height = '170px';
        comps.forEach(function (c) {
          var row = el('div', 'w98-listitem');
          var cb = el('input');
          cb.type = 'checkbox';
          cb.checked = c[2];
          cb.disabled = c[0] === 'Accessories' || c[0] === 'Communications' || c[0] === 'System Tools' || c[0] === 'Multimedia';
          cb.onchange = function () {
            if (c[0] === 'Games') W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'CompGames', cb.checked ? '1' : '0');
            if (c[0].indexOf('MS-DOS') >= 0) W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'CompDosGames', cb.checked ? '1' : '0');
            W98.rebuildDesktopIcons();
          };
          var lab = el('label', '');
          lab.appendChild(cb);
          lab.appendChild(el('span', '', c[0]));
          row.appendChild(lab);
          row.appendChild(el('span', 'grow', ''));
          row.appendChild(el('span', '', '0.0 MB'));
          list.appendChild(row);
        });
        b.appendChild(list);
        b.appendChild(el('div', '', 'Games and MS-DOS Games toggle their Start menu entries and desktop shortcuts.'));
        b.appendChild(el('div', 'row').appendChild(el('button', '', 'Details...')).parentNode);
      } },
      { label: 'Startup Disk', build: function (b) {
        b.appendChild(el('div', '', 'If your computer will not start properly, you can use a startup disk to\nstart it. This writes the MS-DOS startup files to drive A:.'));
        var b1 = el('button', '', 'Create Disk...');
        b1.style.minWidth = '95px';
        b1.onclick = function () {
          W98.fs.writeText('A:\\COMMAND.COM', 'MS-DOS 7.10 command interpreter (stub)\r\n');
          W98.fs.writeText('A:\\AUTOEXEC.BAT', '@ECHO OFF\r\nPROMPT $p$g\r\n');
          W98.fs.writeText('A:\\CONFIG.SYS', 'FILES=40\r\nBUFFERS=20\r\n');
          W98.fs.writeText('A:\\FORMAT.COM', 'MS-DOS 7.10 format utility (stub)\r\n');
          W98.fs.writeText('A:\\SYS.COM', 'MS-DOS 7.10 system transfer utility (stub)\r\n');
          W98.dialog.alert('Startup Disk', 'Startup disk created on drive A:.\n\nCOMMAND.COM, AUTOEXEC.BAT, CONFIG.SYS, FORMAT.COM and SYS.COM were written.', 'info');
        };
        var row = el('div', 'row');
        row.style.gap = '6px';
        row.appendChild(b1);
        b.appendChild(row);
      } }
    ];
  });

  function comboWrap2(c) { var w = el('div', 'row'); w.style.gap = '4px'; w.appendChild(c); return w; }
  function resettable(fn) { return fn; }

  /* ---- smaller applets: honest, authentic message boxes ---------------- */
  var STUB_APPLETS = [
    ['accessibility', 'Accessibility Properties', 'accessibility', 400, 340,
      'Accessibility Options\n\nStickyKeys, FilterKeys and ToggleKeys are not available in this desktop.\n' +
      'Your operating system already provides these features.'],
    ['gamepad', 'Game Controllers', 'pinball', 380, 300,
      'Game Controllers\n\nNo game controller is connected.\n\nYour browser can expose gamepads through the Gamepad API, but this build\n' +
      'does not use it: the games here are played with the keyboard.'],
    ['internetoptions', 'Internet Properties', 'internet-options', 400, 400,
      'Internet Properties\n\nThis desktop is offline. External pages cannot be reached, and Internet\n' +
      'Explorer will show its "page cannot be displayed" error for them.\n\nLocal pages in the kernel filesystem work normally.'],
    ['modems', 'Modems Properties', 'modems', 380, 300,
      'Modems Properties\n\nStandard 56000 bps Modem on COM1\n\n' +
      'There is no telephone line: the dial-up adapter is a stub in the device tree.'],
    ['multimedia', 'Multimedia Properties', 'multimedia', 400, 340,
      'Multimedia Properties\n\nAudio device: Web Audio (emulated Sound Blaster 16)\n' +
      'Preferred device: Sound Blaster 16 (emulated)\n\nSound effects are synthesized or read from C:\\WINDOWS\\MEDIA by the shell.'],
    ['networkconfig', 'Network', 'network-config', 400, 340,
      'Network\n\nThe following network components are installed:\n\n' +
      '  Client for Microsoft Networks\n  Dial-Up Adapter\n  TCP/IP -> Dial-Up Adapter\n  File and printer sharing for Microsoft Networks\n\n' +
      'No network cable is attached.'],
    ['power', 'Power Management Properties', 'power', 400, 300,
      'Power Management Properties\n\nPower schemes: Home/Office Desk\n\n' +
      'The browser tab already throttles itself when hidden, so this desktop\nhas nothing to suspend.'],
    ['regional', 'Regional Settings Properties', 'regional', 400, 340,
      'Regional Settings\n\nLocale: English (United States)\nNumber format: 1,234,567.89\n' +
      'Currency: $\nTime format: h:mm:ss tt\nShort date: M/d/yy\n\n' +
      'Formats follow the locale of your browser.'],
    ['users', 'User Profiles', 'users', 400, 280,
      'Users\n\nThe following users can use this computer:\n\n  ' + W98.shell.USER + ' (current user)\n\n' +
      'Settings are stored per profile in the kernel registry under HKEY_CURRENT_USER.']
  ];
  STUB_APPLETS.forEach(function (a) {
    W98.registerApp({
      id: a[0], title: a[1], icon: a[2], width: a[3], height: a[4], resizable: false, singleton: true,
      create: function (win) {
        win.el.style.padding = '12px';
        var lines = a[5].split('\n');
        win.el.appendChild(el('div', '', esc(lines[0])));
        win.el.appendChild(el('div', 'w98-hr'));
        win.el.appendChild(el('div', '', esc(lines.slice(1).join('\n')).replace(/\n/g, '<br>')));
        var row = el('div', 'row');
        row.style.cssText = 'justify-content:center;margin-top:16px';
        var okB = el('button', 'default', 'OK');
        okB.style.minWidth = '75px';
        okB.onclick = function () { win.close(); };
        row.appendChild(okB);
        win.el.appendChild(row);
        return {};
      }
    });
  });

  /* ---- Taskbar & Start Menu + Folder Options --------------------------- */
  W98.registerApp({
    id: 'taskbarsettings', title: 'Taskbar Properties', icon: 'settings',
    width: 380, height: 380, resizable: false, singleton: true,
    create: function (win) {
      makeSheet(win, 'Taskbar Properties', [
        {
          label: 'Taskbar Options', build: function (b) {
            b.appendChild(checkbox('Always on top', true));
            b.appendChild(checkbox('Auto hide', false));
            var small = checkbox('Show small icons in Start menu', W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'SmallStartIcons', '0') === '1');
            b.appendChild(small);
            var clock = checkbox('Show Clock', W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'ShowClock', '1') === '1');
            clock._box.onchange = function () {
              W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'ShowClock', clock._box.checked ? '1' : '0');
              var c = document.getElementById('clock');
              if (c) c.style.display = clock._box.checked ? '' : 'none';
            };
            b.appendChild(clock);
            var ql = checkbox('Show Quick Launch', W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'ShowQuickLaunch', '1') === '1');
            b.appendChild(ql);
            b.appendChild(el('div', '', 'Tip: use the Quick Launch bar to show the desktop with one click.'));
          }
        },
        {
          label: 'Start Menu Programs', build: function (b) {
            b.appendChild(el('div', '', 'Customize Start menu:'));
            var list = el('div', 'w98-listbox');
            list.style.height = '150px';
            W98.registry.forEach(function (a) {
              if (!a.startMenuGroup) return;
              var row = el('div', 'w98-listitem');
              row.appendChild(I.el(a.icon || 'programs', 16));
              row.appendChild(el('span', '', esc(a.title || a.id)));
              row.appendChild(el('span', 'grow', ''));
              row.appendChild(el('span', '', '\\' + a.startMenuGroup));
              list.appendChild(row);
            });
            b.appendChild(list);
            var adv = el('button', '', 'Advanced...');
            adv.onclick = function () { W98.launch('explorer', { path: 'C:\\WINDOWS\\START MENU\\PROGRAMS' }); };
            b.appendChild(adv);
          }
        },
        {
          label: 'Advanced', build: function (b) {
            b.appendChild(el('div', '', 'Start menu and desktop shortcuts are files:'));
            b.appendChild(el('div', '', '  C:\\WINDOWS\\START MENU\\PROGRAMS\\*'));
            b.appendChild(el('div', '', '  C:\\WINDOWS\\DESKTOP\\*.lnk'));
            b.appendChild(el('div', '', 'They live in the kernel filesystem and survive a reload.'));
          }
        }
      ]);
      return {};
    }
  });

  W98.registerApp({
    id: 'folderoptions', title: 'Folder Options', icon: 'folder',
    width: 380, height: 340, resizable: false, singleton: true,
    create: function (win) {
      makeSheet(win, 'Folder Options', [
        {
          label: 'General', build: function (b) {
            b.appendChild(el('div', '', 'Active Desktop'));
            b.appendChild(radio('Enable Web content in folders', false, 'ad'));
            b.appendChild(radio('Use Windows classic desktop', true, 'ad'));
            b.appendChild(el('div', 'w98-hr'));
            b.appendChild(el('div', '', 'Web View'));
            b.appendChild(radio('Use Windows classic folders', true, 'wv'));
            b.appendChild(radio('Enable Web content in folders', false, 'wv'));
          }
        },
        {
          label: 'View', build: function (b) {
            b.appendChild(checkbox('Display the full path in the title bar', W98.reg.get(W98.regKey('Explorer'), 'FullPath', '0') === '1'));
            b.appendChild(checkbox('Show hidden files and folders', false));
            b.appendChild(checkbox('Remember each folder\'s view settings', true));
            b.appendChild(checkbox('Show file attributes in Detail View', true));
          }
        },
        {
          label: 'File Types', build: function (b) {
            var list = el('div', 'w98-listbox');
            list.style.height = '170px';
            [['TXT', 'Text Document'], ['INI', 'Configuration Settings'], ['BMP', 'Bitmap Image'],
            ['WAV', 'Wave Sound'], ['EXE', 'Application'], ['LNK', 'Shortcut'], ['BAT', 'MS-DOS Batch File'],
            ['LOG', 'Text Document'], ['SYS', 'System file']].forEach(function (t) {
              var row = el('div', 'w98-listitem');
              row.appendChild(el('span', '', t[0] + '  ' + t[1]));
              list.appendChild(row);
            });
            b.appendChild(list);
          }
        }
      ]);
      return {};
    }
  });

  /* apply the saved scheme at load time */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyScheme(W98.reg.get(DESK, 'ColorScheme', 'Windows Standard')); });
  } else {
    applyScheme(W98.reg.get(DESK, 'ColorScheme', 'Windows Standard'));
  }
})();
