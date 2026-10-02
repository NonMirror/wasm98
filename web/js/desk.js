/* ============================================================================
   desk.js — the desktop, taskbar, Start menu, tray, boot/shutdown and the
   screen savers.  This is the layer that makes the shell feel like the OS.
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.W98Kernel;
  var W98 = global.W98;
  var S = global.W98Icons;
  var Sound = W98.sound;
  var U = W98.util;
  var $ = U.$, el = U.el, clamp = U.clamp, pad2 = U.pad2, esc = U.escapeHtml, mlabel = U.menuLabel;
  function on(e, ev, fn, opt) { e.addEventListener(ev, fn, opt); return fn; }
  function off(e, ev, fn) { e.removeEventListener(ev, fn); }

  var DESK = 'HKEY_CURRENT_USER\\Control Panel\\Desktop';
  var HKCU = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion';
  var POSKEY = 'HKEY_CURRENT_USER\\Software\\W98\\IconPos';

  var desktop, holder, taskbar, tasks, tray, clockEl, startBtn, startMenu, quickLaunch;
  var iconEls = {};
  var selIcons = [];
  var startOpen = false;
  var GRID = 75, GRIDY = 75;

  function reg(path, name, dflt) { return W98.reg.get(path, name, dflt); }
  function setreg(path, name, v) { return W98.reg.set(path, name, v); }

  /* ==================================================================== */
  /* wallpaper                                                            */
  /* ==================================================================== */
  function wallpaperList() {
    var man = S.manifest();
    var out = [{ name: '(None)', file: null }];
    if (man && man.wallpapers) {
      Object.keys(man.wallpapers).forEach(function (k) {
        var w = man.wallpapers[k];
        out.push({ name: prettify(k) + ' (' + k + ')', file: 'assets/' + w.file, tile: !!w.tile, key: k });
      });
    } else {
      ['clouds', 'setup', 'waves', 'straw-mat', 'blue-rivets', 'slate', 'bubbles', 'forest', 'tiles'].forEach(function (k) {
        out.push({ name: prettify(k), file: 'assets/wallpapers/' + k + '.png', tile: true, key: k });
      });
    }
    /* .bmp files sitting in C:\WINDOWS are also wallpapers, as on Windows */
    (W98.fs.list('C:\\WINDOWS') || []).forEach(function (e) {
      if (!e.dir && /\.bmp$/i.test(e.name)) out.push({ name: e.name, file: null, path: 'C:\\WINDOWS\\' + e.name, tile: true });
    });
    return out;
  }
  function prettify(k) {
    return k.replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  W98.wallpaperList = wallpaperList;

  function applyDesktop() {
    var wp = reg(DESK, 'Wallpaper', null);
    var style = reg(DESK, 'WallpaperStyle', '0');   /* 0 center, 1 tile, 2 stretch */
    var color = reg(DESK, 'Color', reg('HKEY_CURRENT_USER\\Control Panel\\Colors', 'Background', '0 128 128'));
    var rgb = String(color).trim().split(/\s+/).map(Number);
    if (rgb.length === 3 && rgb.every(function (n) { return !isNaN(n); })) {
      desktop.style.backgroundColor = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    }
    if (!wp || wp === '(None)') {
      desktop.style.backgroundImage = 'none';
      return;
    }
    var url = null, tile = false;
    var man = S.manifest();
    var found = wallpaperList().filter(function (w) { return w.name === wp || w.key === wp; })[0];
    if (found) { url = found.file; tile = found.tile; }
    if (!url && /\.bmp$/i.test(wp)) {
      var bytes = W98.fs.readBytes(wp);
      if (bytes) {
        var blob = new Blob([bytes], { type: 'image/bmp' });
        url = URL.createObjectURL(blob);
        tile = true;
      }
    }
    if (!url) { desktop.style.backgroundImage = 'none'; return; }
    desktop.style.backgroundImage = 'url("' + url + '")';
    desktop.style.backgroundRepeat = (style === '1' || (style === '0' && tile && found && found.key)) ? 'repeat' : 'no-repeat';
    if (style === '2') {
      desktop.style.backgroundSize = '100% 100%';
      desktop.style.backgroundRepeat = 'no-repeat';
    } else if (style === '1' || tile) {
      desktop.style.backgroundSize = 'auto';
    } else {
      desktop.style.backgroundSize = 'auto';
      desktop.style.backgroundPosition = 'center center';
    }
  }
  W98.applyDesktop = applyDesktop;

  /* ==================================================================== */
  /* desktop icons                                                        */
  /* ==================================================================== */
  function shortcutTarget(text) {
    if (!text) return null;
    var m = /^app:([a-z0-9_-]+)/i.exec(text.trim());
    if (m) return { app: m[1] };
    var p = /^path:(.+)$/m.exec(text.trim());
    if (p) return { path: p[1].trim() };
    return null;
  }

  function desktopItems() {
    var items = [];
    items.push({ id: 'my-computer', label: 'My Computer', icon: 'my-computer', open: function () { W98.launch('explorer', { path: 'C:\\', special: 'computer' }); } });
    items.push({ id: 'my-documents', label: 'My Documents', icon: 'documents', open: function () { W98.launch('explorer', { path: 'C:\\My Documents' }); } });
    items.push({ id: 'ie', label: 'Internet Explorer', icon: 'ie', open: function () { W98.launch('ie'); } });
    items.push({ id: 'network', label: 'Network Neighborhood', icon: 'network', open: function () { W98.launch('explorer', { path: 'C:\\', special: 'network' }); } });
    items.push({ id: 'recycle', label: 'Recycle Bin', icon: recycleCount() ? 'recycle-bin-full' : 'recycle-bin', open: function () { W98.launch('recycle'); } });

    /* registered apps that asked for a desktop icon */
    W98.registry.forEach(function (a) {
      if (a.desktop) {
        items.push({
          id: 'app-' + a.id, label: a.title || a.id, icon: a.icon || 'unknown-file',
          open: function () { W98.launch(a.id); }
        });
      }
    });
    /* shortcuts and files on C:\WINDOWS\Desktop */
    (W98.fs.list('C:\\WINDOWS\\Desktop') || []).forEach(function (e) {
      if (e.name.charAt(0) === '~') return;
      if (/\.lnk$/i.test(e.name)) {
        var t = shortcutTarget(W98.fs.readText('C:\\WINDOWS\\Desktop\\' + e.name));
        var label = e.name.replace(/\.lnk$/i, '').replace(/-/g, ' ');
        var icon = 'unknown-file', open = null;
        if (t && t.app) {
          var def = W98.getApp(t.app);
          icon = (def && def.icon) || 'exe-file';
          open = (function (id) { return function () { W98.launch(id); }; })(t.app);
        } else if (t && t.path) {
          icon = W98.iconForFile(t.path);
          open = (function (p) { return function () { openPath(p); }; })(t.path);
        }
        items.push({ id: 'lnk-' + e.name, label: label, icon: icon, open: open, path: 'C:\\WINDOWS\\Desktop\\' + e.name, shortcut: true });
      } else {
        items.push({
          id: 'file-' + e.name, label: e.name.replace(/\.[^.]+$/, ''), icon: W98.iconForEntry(e),
          path: 'C:\\WINDOWS\\Desktop\\' + e.name,
          open: (function (p) { return function () { openPath(p); }; })(e.name)
        });
      }
    });
    return items;
  }
  W98.desktopItems = desktopItems;

  function recycleCount() {
    var list = W98.fs.list('C:\\Recycled') || [];
    return list.length;
  }

  function openPath(p) {
    var full = W98.fs.join('C:\\WINDOWS\\Desktop', p);
    if (W98.fs.isDir(full)) { W98.launch('explorer', { path: full }); return; }
    var ext = (p.split('.').pop() || '').toLowerCase();
    if (ext === 'txt' || ext === 'ini' || ext === 'log' || ext === 'bat' || ext === 'sys') W98.launch('notepad', { path: full });
    else if (ext === 'bmp' || ext === 'dib' || ext === 'png') W98.launch('paint', { path: full });
    else if (ext === 'wav' || ext === 'mp3' || ext === 'mid') W98.launch('mplayer', { path: full });
    else if (ext === 'htm' || ext === 'html' || ext === 'url') W98.launch('ie', { path: full });
    else if (ext === 'scr') W98.launch('display', { tab: 3 });
    else if (ext === 'exe' || ext === 'com') W98.dialog.alert('Windows', 'Cannot run ' + p + '.\nThis file is not a valid Windows application.', 'error');
    else W98.launch('notepad', { path: full });
  }

  function iconPos(id) {
    var v = W98.reg.get(POSKEY, id, null);
    if (!v) return null;
    var a = v.split(',');
    return { x: parseInt(a[0], 10), y: parseInt(a[1], 10) };
  }
  function saveIconPos(id, x, y) { W98.reg.set(POSKEY, id, x + ',' + y); }

  function buildDesktopIcons() {
    var items = desktopItems();
    Object.keys(iconEls).forEach(function (k) { if (iconEls[k].parentNode) iconEls[k].parentNode.removeChild(iconEls[k]); });
    iconEls = {};
    var col = 0, row = 0;
    var maxRows = Math.max(1, Math.floor((desktop.clientHeight - 8) / GRIDY));
    items.forEach(function (it) {
      var e = el('div', 'dicon');
      e.dataset.id = it.id;
      var ic = el('span', 'ic');
      ic.appendChild(S.el(it.icon, 32));
      e.appendChild(ic);
      var lbl = el('div', 'lbl', esc(it.label));
      e.appendChild(lbl);
      var pos = iconPos(it.id);
      if (!pos) {
        pos = { x: 4 + col * GRID, y: 4 + row * GRIDY };
        row++;
        if (row >= maxRows) { row = 0; col++; }
      }
      e.style.left = pos.x + 'px';
      e.style.top = pos.y + 'px';
      e._item = it;
      holder.appendChild(e);
      iconEls[it.id] = e;
      wireIcon(e, it);
    });
  }
  W98.rebuildDesktopIcons = buildDesktopIcons;
  W98.onRebuildDesktop = function () { buildDesktopIcons(); };

  function selectIcon(e, additive) {
    if (!additive) selIcons.forEach(function (i) { i.classList.remove('sel'); selIcons = []; });
    if (selIcons.indexOf(e) < 0) { selIcons.push(e); e.classList.add('sel'); }
  }
  function deselectAll() {
    selIcons.forEach(function (i) { i.classList.remove('sel'); });
    selIcons = [];
  }

  function wireIcon(e, it) {
    on(e, 'mousedown', function (ev) {
      if (ev.button === 2) { if (selIcons.indexOf(e) < 0) selectIcon(e, false); return; }
      selectIcon(e, ev.ctrlKey);
      var sx = ev.clientX, sy = ev.clientY;
      var ox = e.offsetLeft, oy = e.offsetTop;
      var moved = false, dragged = false;
      function move(mv) {
        var dx = mv.clientX - sx, dy = mv.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true; dragged = true;
        e.classList.add('dragging');
        e.style.left = (ox + dx) + 'px';
        e.style.top = (oy + dy) + 'px';
      }
      function up() {
        off(document, 'mousemove', move); off(document, 'mouseup', up);
        e.classList.remove('dragging');
        if (dragged) {
          var gx = Math.round(e.offsetLeft / GRID) * GRID + 4;
          var gy = Math.round(e.offsetTop / GRIDY) * GRIDY + 4;
          gx = clamp(gx, 0, desktop.clientWidth - 74);
          gy = clamp(gy, 0, desktop.clientHeight - 74);
          e.style.left = gx + 'px';
          e.style.top = gy + 'px';
          saveIconPos(it.id, gx, gy);
        }
      }
      on(document, 'mousemove', move);
      on(document, 'mouseup', up);
    });
    on(e, 'dblclick', function () { if (it.open) it.open(); });
    on(e, 'contextmenu', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (selIcons.indexOf(e) < 0) selectIcon(e, false);
      iconContextMenu(it, ev);
    });
    on(e, 'keydown', function (ev) {
      if (ev.key === 'F2' && it.shortcut) renameIcon(it);
      if (ev.key === 'Delete') deleteIcon(it);
    });
  }

  function iconContextMenu(it, ev) {
    var items = [];
    if (it.open) items.push({ label: '&Open', onclick: it.open });
    items.push({ type: 'sep' });
    if (it.path) {
      items.push({
        label: '&Rename', onclick: function () { renameIcon(it); }
      });
      items.push({
        label: '&Delete', onclick: function () { deleteIcon(it); }
      });
    }
    items.push({
      label: 'Create &Shortcut', onclick: function () {
        var name = it.label + ' Shortcut.lnk';
        var content = it.path ? ('W98LNK1\npath:' + it.path) : ('W98LNK1\napp:' + (it.id || '').replace(/^app-/, ''));
        W98.fs.writeText('C:\\WINDOWS\\Desktop\\' + name, content);
        buildDesktopIcons();
      }
    });
    items.push({ type: 'sep' });
    items.push({
      label: 'P&roperties', onclick: function () {
        var text = it.path
          ? ('Type: ' + (W98.fs.isDir(it.path) ? 'File Folder' : 'File') + '\nLocation: ' + W98.fs.parent(it.path) +
            '\nSize: ' + (W98.fs.stat(it.path) || {}).size + ' bytes\nMS-DOS name: ' + it.label.slice(0, 8).toUpperCase())
          : 'Type: System Folder\nLocation: Desktop\nSize: n/a\nContains: file system information about the object.';
        W98.dialog.alert(it.label + ' Properties', text, 'info');
      }
    });
    W98.menu.contextMenu(items, ev);
  }

  function renameIcon(it) {
    if (!it.path) return;
    var cur = it.path.split('\\').pop();
    W98.dialog.prompt('Rename', 'New name:', cur).then(function (name) {
      if (!name || name === cur) return;
      W98.fs.rename(it.path, W98.fs.parent(it.path) + '\\' + name);
      buildDesktopIcons();
    });
  }
  function deleteIcon(it) {
    if (!it.path) return;
    W98.dialog.confirm('Confirm File Delete', 'Are you sure you want to send \'' + it.label + '\' to the Recycle Bin?')
      .then(function (yes) {
        if (!yes) return;
        var base = it.path.split('\\').pop();
        W98.fs.rename(it.path, 'C:\\Recycled\\' + base);
        W98.reg.set('HKEY_CURRENT_USER\\Software\\W98\\Recycle', base, it.path);
        Sound.play('Recycle');
        buildDesktopIcons();
      });
  }

  /* desktop background behaviour: rubber band, context menu */
  function wireDesktop() {
    on(holder, 'mousedown', function (ev) {
      if (ev.button !== 0) return;
      /* holder contains every window frame.  Only a press whose top-level
         target is the desktop surface can begin a desktop selection; a
         bubbled press from a window must never install document-wide drag
         listeners or create a marquee behind that window. */
      if (ev.target !== holder) return;
      deselectAll();
      W98.closeMenus();
      var band = el('div');
      band.style.cssText = 'position:absolute;border:1px dotted #fff;background:rgba(0,0,128,.25);pointer-events:none;z-index:50';
      var sx = ev.clientX, sy = ev.clientY;
      var r = holder.getBoundingClientRect();
      var started = false;
      function move(mv) {
        var x = Math.min(sx, mv.clientX) - r.left, y = Math.min(sy, mv.clientY) - r.top;
        var w = Math.abs(mv.clientX - sx), h = Math.abs(mv.clientY - sy);
        if (!started && w + h < 5) return;
        if (!started) { started = true; holder.appendChild(band); }
        band.style.left = x + 'px'; band.style.top = y + 'px';
        band.style.width = w + 'px'; band.style.height = h + 'px';
        var bx1 = x, by1 = y, bx2 = x + w, by2 = y + h;
        Object.keys(iconEls).forEach(function (k) {
          var e2 = iconEls[k];
          var ex1 = e2.offsetLeft, ey1 = e2.offsetTop, ex2 = ex1 + 75, ey2 = ey1 + 64;
          var hit = !(ex2 < bx1 || ex1 > bx2 || ey2 < by1 || ey1 > by2);
          if (hit) { if (selIcons.indexOf(e2) < 0) { selIcons.push(e2); e2.classList.add('sel'); } }
          else if (!mv.ctrlKey) { e2.classList.remove('sel'); selIcons = selIcons.filter(function (i) { return i !== e2; }); }
        });
      }
      function up() {
        off(document, 'mousemove', move); off(document, 'mouseup', up);
        if (band.parentNode) band.parentNode.removeChild(band);
      }
      on(document, 'mousemove', move);
      on(document, 'mouseup', up);
    });
    on(holder, 'contextmenu', function (ev) {
      ev.preventDefault();
      W98.menu.contextMenu(desktopContextItems(), ev);
    });
  }

  function desktopContextItems() {
    return [
      { label: 'Active &Desktop', items: [{ label: 'View As Web Page', type: 'check', checked: false, onclick: function () { } }, { type: 'sep' }, { label: 'Customize my Desktop...', onclick: function () { W98.launch('display'); } }] },
      { type: 'sep' },
      {
        label: 'Arrange &Icons', items: [
          { label: 'by &Name', onclick: function () { arrangeIcons('name'); } },
          { label: 'by &Type', onclick: function () { arrangeIcons('type'); } },
          { label: 'by &Size', onclick: function () { arrangeIcons('size'); } },
          { label: 'by &Date', onclick: function () { arrangeIcons('date'); } },
          { type: 'sep' },
          { label: '&Auto Arrange', type: 'check', checked: reg('HKEY_CURRENT_USER\\Software\\W98', 'AutoArrange', '0') === '1', onclick: function () { var on2 = reg('HKEY_CURRENT_USER\\Software\\W98', 'AutoArrange', '0') === '1'; setreg('HKEY_CURRENT_USER\\Software\\W98', 'AutoArrange', on2 ? '0' : '1'); } }
        ]
      },
      { label: 'Li&ne up Icons', onclick: function () { lineUpIcons(); } },
      { label: '&Refresh', onclick: function () { buildDesktopIcons(); } },
      { type: 'sep' },
      {
        label: '&New', items: [
          {
            label: '&Folder', onclick: function () {
              nameNew('New Folder', function (name) { W98.fs.mkdir('C:\\WINDOWS\\Desktop\\' + name); });
            }
          },
          {
            label: '&Shortcut', onclick: function () {
              W98.dialog.prompt('Create Shortcut', 'Type the name of the program, folder, document or Internet resource\nthat you want Windows to create a shortcut to.', 'C:\\WINDOWS\\NOTEPAD.EXE').then(function (target) {
                if (!target) return;
                var base = target.split('\\').pop().replace(/\.[^.]+$/, '');
                W98.fs.writeText('C:\\WINDOWS\\Desktop\\' + base + '.lnk', 'W98LNK1\npath:' + target);
                buildDesktopIcons();
              });
            }
          },
          { label: '&Text Document', onclick: function () { nameNew('New Text Document.txt', function (name) { W98.fs.writeText('C:\\WINDOWS\\Desktop\\' + name, ''); }); } },
          { label: '&Bitmap Image', onclick: function () { nameNew('New Bitmap Image.bmp', function (name) { W98.fs.writeBytes('C:\\WINDOWS\\Desktop\\' + name, new Uint8Array(0)); }); } },
          { label: '&Wave Sound', onclick: function () { nameNew('New Wave Sound.wav', function (name) { W98.fs.writeBytes('C:\\WINDOWS\\Desktop\\' + name, new Uint8Array(0)); }); } }
        ]
      },
      { type: 'sep' },
      { label: 'P&roperties', onclick: function () { W98.launch('display'); } }
    ];
  }
  function nameNew(defName, fn) {
    W98.dialog.prompt('New', 'Name:', defName).then(function (name) {
      if (!name) return;
      fn(name);
      buildDesktopIcons();
    });
  }
  function arrangeIcons(by) {
    var items = desktopItems();
    var key = { name: function (i) { return i.label.toLowerCase(); }, type: function (i) { return i.icon; }, size: function (i) { return 0; }, date: function (i) { return 0; } }[by];
    items.sort(function (a, b) { return key(a) < key(b) ? -1 : 1; });
    var maxRows = Math.max(1, Math.floor((desktop.clientHeight - 8) / GRIDY));
    var col = 0, row = 0;
    items.forEach(function (it) {
      var e = iconEls[it.id];
      if (!e) return;
      var x = 4 + col * GRID, y = 4 + row * GRIDY;
      e.style.left = x + 'px'; e.style.top = y + 'px';
      saveIconPos(it.id, x, y);
      row++; if (row >= maxRows) { row = 0; col++; }
    });
  }
  function lineUpIcons() {
    Object.keys(iconEls).forEach(function (k) {
      var e = iconEls[k];
      var gx = Math.round(e.offsetLeft / GRID) * GRID + 4;
      var gy = Math.round(e.offsetTop / GRIDY) * GRIDY + 4;
      e.style.left = gx + 'px'; e.style.top = gy + 'px';
      saveIconPos(k, gx, gy);
    });
  }
  W98.arrangeIcons = arrangeIcons;
  W98.lineUpIcons = lineUpIcons;

  /* ==================================================================== */
  /* taskbar                                                              */
  /* ==================================================================== */
  function buildTaskbar() {
    taskbar.innerHTML = '';
    startBtn = el('button', 'noselect');
    startBtn.id = 'startbtn';
    startBtn.appendChild(S.el('startflag', 16));
    startBtn.appendChild(el('span', '', 'Start'));
    on(startBtn, 'mousedown', function (e) { e.preventDefault(); e.stopPropagation(); toggleStart(); });
    taskbar.appendChild(startBtn);

    quickLaunch = el('div', 'noselect');
    quickLaunch.id = 'quicklaunch';
    quickLaunch.title = 'Quick Launch';
    var q1 = quickBtn('folder', 'Show Desktop', showDesktop);
    var q2 = quickBtn('ie', 'Launch Internet Explorer Browser', function () { W98.launch('ie'); });
    var q3 = quickBtn('media-player', 'Windows Media Player', function () { W98.launch('mplayer'); });
    quickLaunch.appendChild(q1); quickLaunch.appendChild(q2); quickLaunch.appendChild(q3);
    taskbar.appendChild(quickLaunch);

    tasks = el('div');
    tasks.id = 'tasks';
    taskbar.appendChild(tasks);

    tray = el('div', 'noselect');
    tray.id = 'tray';
    var vol = S.el('volume', 16);
    vol.className = 'tray-ic cur-hand';
    vol.title = 'Volume';
    on(vol, 'click', function (e) { e.stopPropagation(); showVolumePopup(vol); });
    tray.appendChild(vol);
    clockEl = el('div', '', '');
    clockEl.id = 'clock';
    clockEl.className = 'cur-hand';
    on(clockEl, 'click', function () { showDatePopup(clockEl); });
    on(clockEl, 'dblclick', function () { W98.launch('datetime'); });
    tray.appendChild(clockEl);
    taskbar.appendChild(tray);
  }
  function quickBtn(icon, title, fn) {
    var b = el('button');
    b.style.minWidth = '16px'; b.style.minHeight = '16px'; b.style.padding = '0';
    b.style.boxShadow = 'none'; b.style.background = 'transparent';
    b.appendChild(S.el(icon, 16));
    b.title = title;
    on(b, 'click', fn);
    on(b, 'mouseenter', function () { b.style.boxShadow = 'inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px grey, inset 2px 2px #dfdfdf'; });
    on(b, 'mouseleave', function () { b.style.boxShadow = 'none'; });
    return b;
  }
  function showDesktop() {
    W98.shell.windows.forEach(function (w) { if (!w.minimized && !w.modal) w.minimize(); });
  }

  function updateTaskbar() {
    var wins = W98.shell.windows.slice().sort(function (a, b) { return a.pid - b.pid; });
    /* drop buttons for closed windows */
    [].slice.call(tasks.children).forEach(function (b) {
      var found = wins.some(function (w) { return String(w.pid) === b.dataset.pid; });
      if (!found) tasks.removeChild(b);
    });
    wins.forEach(function (w) {
      var b = W98.shell.taskButtonFor(w);
      if (!b) {
        b = el('button', 'tbtn noselect');
        b.dataset.pid = String(w.pid);
        var ic = el('span', 'tbi');
        ic.appendChild(S.el(w.iconKey || 'unknown-file', 16));
        b.appendChild(ic);
        b.appendChild(el('span', 'lb', esc(w.title || w.def.title)));
        on(b, 'click', function () {
          if (w.minimized) w.restore();
          else if (W98.shell.activeWindow() === w) w.minimize();
          else w.focus();
        });
        on(b, 'contextmenu', function (ev) {
          ev.preventDefault();
          W98.menu.contextMenu([
            { label: '&Restore', disabled: !w.minimized, onclick: function () { w.restore(); } },
            { label: '&Minimize', onclick: function () { w.minimize(); } },
            { label: 'Ma&ximize', disabled: w.def.maximizable === false, onclick: function () { w.maximize(); } },
            { type: 'sep' },
            { label: '&Close', accel: 'Alt+F4', onclick: function () { w.close(); } }
          ], ev);
        });
        tasks.appendChild(b);
      }
      var active = W98.shell.activeWindow() === w && !w.minimized;
      b.classList.toggle('active', active);
      b.classList.toggle('min', !!w.minimized);
      var lb = b.querySelector('.lb');
      if (lb && lb.textContent !== w.title) lb.textContent = w.title;
    });
  }
  W98.onTaskbarUpdate = updateTaskbar;

  /* ---- tray popups */
  function popupAt(anchor, content, width) {
    var p = $('#traypopup');
    p.innerHTML = '';
    p.appendChild(content);
    p.style.display = 'block';
    var r = anchor.getBoundingClientRect();
    p.style.left = Math.max(2, r.left - (width ? width - r.width : 0)) + 'px';
    p.style.top = (r.top - p.offsetHeight - 4) + 'px';
  }
  function closePopup() { $('#traypopup').style.display = 'none'; }
  function showVolumePopup(anchor) {
    var wrap = el('div', 'volctrl w98-raised');
    var slider = el('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '100';
    slider.value = String(Math.round(Sound.volume() * 100));
    slider.style.width = '90px';
    var mute = el('label', '', 'Mute');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Sound.muted();
    on(slider, 'input', function () { Sound.setVolume(slider.value / 100); });
    on(cb, 'change', function () { Sound.setMuted(cb.checked); });
    var cbox = el('div', 'row');
    cbox.appendChild(cb); cbox.appendChild(mute);
    wrap.appendChild(slider);
    wrap.appendChild(cbox);
    popupAt(anchor, wrap, 0);
  }
  function showDatePopup(anchor) {
    var d = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var box = el('div', 'datepopup w98-raised');
    box.innerHTML = '<b>' + days[d.getDay()] + '</b><br>' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    popupAt(anchor, box, 0);
  }
  on(document, 'mousedown', function (e) {
    var p = $('#traypopup');
    if (p.style.display === 'block' && !p.contains(e.target) && !(tray && tray.contains(e.target))) closePopup();
  });

  /* ==================================================================== */
  /* Start menu                                                           */
  /* ==================================================================== */
  /* Windows 98's Start menu only ever listed a handful of programs under
     Programs. Applets that live in Control Panel, and commands that sit at the
     top level of the Start menu (Run, Find, Help) or on the desktop, must not
     be repeated inside Programs. */
  var START_EXCLUDE = {
    run: 1, find: 1, help: 1, winver: 1, recycle: 1, taskmgr: 1, explorer: 1, cmd: 1, ie: 1, outlook: 1,
    display: 1, system: 1, datetime: 1, sounds: 1, mouse: 1, keyboard: 1, addremove: 1, control: 1,
    accessibility: 1, gamepad: 1, internetoptions: 1, modems: 1, multimedia: 1, networkconfig: 1,
    power: 1, regional: 1, users: 1, addhardware: 1, taskbarsettings: 1, folderoptions: 1, restore: 1
  };
  var GROUP_OVERRIDE = { dosgame: 'DOS Games' };
  var GROUP_ORDER = ['Accessories', 'Games', 'DOS Games', 'System Tools', 'StartUp'];
  var GROUP_ICON = {
    'Accessories': 'programs', 'Games': 'jezzball', 'DOS Games': 'dos',
    'System Tools': 'system', 'StartUp': 'scheduled-tasks'
  };

  function submenuItemsForGroups() {
    var groups = {};
    W98.registry.forEach(function (a) {
      if (START_EXCLUDE[a.id]) return;
      var g = GROUP_OVERRIDE[a.id] || a.startMenuGroup || 'Programs';
      (groups[g] = groups[g] || []).push(a);
    });
    var out = [];
    GROUP_ORDER.forEach(function (g) {
      if (!groups[g] || !groups[g].length) {
        /* Windows 98 always shows a StartUp folder, empty or not */
        if (g === 'StartUp') {
          out.push({
            label: 'StartUp', icon: GROUP_ICON[g] || 'programs',
            items: [{ label: '(Empty)', disabled: true }]
          });
        }
        return;
      }
      out.push({
        label: g, icon: GROUP_ICON[g] || 'programs',
        items: groups[g].map(function (a) {
          return { label: a.title || a.id, icon: a.icon || 'programs', onclick: function () { W98.launch(a.id); } };
        })
      });
    });
    var rest = Object.keys(groups).filter(function (g) { return GROUP_ORDER.indexOf(g) < 0; });
    rest.forEach(function (g) {
      if (g === 'Programs' && groups[g].length) return;   /* folded into the entries below */
      out.push({
        label: g, icon: 'programs',
        items: groups[g].map(function (a) {
          return { label: a.title || a.id, icon: a.icon || 'programs', onclick: function () { W98.launch(a.id); } };
        })
      });
    });
    /* the classic Programs entries every Windows 98 has */
    out.push({ type: 'sep' });
    out.push({ label: 'MS-DOS Prompt', icon: 'dos-prompt', onclick: function () { W98.launch('cmd'); } });
    out.push({ label: 'Windows Explorer', icon: 'explorer', onclick: function () { W98.launch('explorer', { path: 'C:\\', special: 'computer' }); } });
    out.push({
      label: 'Online Services', icon: 'ie', items: [
        { label: 'America Online', icon: 'ie', onclick: function () { W98.launch('ie', { url: 'http://www.aol.com' }); } },
        { label: 'CompuServe', icon: 'ie', onclick: function () { W98.launch('ie', { url: 'http://www.compuserve.com' }); } },
        { label: 'Prodigy Internet', icon: 'ie', onclick: function () { W98.launch('ie', { url: 'http://www.prodigy.com' }); } }
      ]
    });
    out.push({ label: 'Internet Explorer', icon: 'ie', onclick: function () { W98.launch('ie'); } });
    /* anything still unplaced (a third-party app) goes here */
    if (groups.Programs && groups.Programs.length) {
      out.push({ type: 'sep' });
      out.push({
        label: 'Programs', icon: 'programs',
        items: groups.Programs.map(function (a) {
          return { label: a.title || a.id, icon: a.icon || 'programs', onclick: function () { W98.launch(a.id); } };
        })
      });
    }
    return out;
  }

  function docsItems() {
    var list = W98.fs.list('C:\\My Documents') || [];
    var out = list.slice(0, 12).map(function (e) {
      return {
        label: e.name, icon: e.dir ? 'folder' : 'text-file',
        onclick: function () {
          var p = 'C:\\My Documents\\' + e.name;
          if (e.dir) W98.launch('explorer', { path: p });
          else openDoc(p);
        }
      };
    });
    if (!out.length) out.push({ label: '(Empty)', disabled: true });
    return out;
  }
  function openDoc(p) {
    var ext = (p.split('.').pop() || '').toLowerCase();
    if (ext === 'bmp') return W98.launch('paint', { path: p });
    if (ext === 'wav') return W98.launch('mplayer', { path: p });
    return W98.launch('notepad', { path: p });
  }
  function favoritesItems() {
    var list = W98.fs.list('C:\\WINDOWS\\Favorites') || [];
    var out = [{ label: 'Add to Favorites...', icon: 'ie', onclick: function () { W98.dialog.alert('Favorites', 'The Favorites folder is empty. Add a channel from Internet Explorer.', 'info'); } }];
    if (list.length) {
      out.push({ type: 'sep' });
      list.forEach(function (e) {
        out.push({ label: e.name.replace(/\.[^.]+$/, ''), icon: 'ie', onclick: function () { W98.launch('ie', { path: 'C:\\WINDOWS\\Favorites\\' + e.name }); } });
      });
    }
    return out;
  }

  function startItems() {
    return [
      { label: 'Windows Update', icon: 'windows-update', onclick: function () { W98.launch('ie', { url: 'http://windowsupdate.microsoft.com' }); } },
      { type: 'sep' },
      { label: 'Programs', icon: 'programs', items: submenuItemsForGroups() },
      { label: 'Favorites', icon: 'web-folders', items: favoritesItems() },
      { label: 'Documents', icon: 'documents', items: docsItems() },
      {
        label: 'Settings', icon: 'settings', items: [
          { label: 'Control Panel', icon: 'control-panel', onclick: function () { W98.launch('control'); } },
          { label: 'Printers', icon: 'printer', onclick: function () { W98.launch('explorer', { path: 'C:\\WINDOWS\\Printers' }); } },
          { label: 'Taskbar && Start Menu...', icon: 'settings', onclick: function () { W98.launch('control', { applet: 'taskbar' }); } },
          { label: 'Folder Options...', icon: 'folder', onclick: function () { W98.launch('control', { applet: 'folder' }); } },
          { label: 'Active Desktop', icon: 'display', items: [{ label: 'View As Web Page', onclick: function () { } }, { label: 'Customize my Desktop...', onclick: function () { W98.launch('display'); } }] },
          { label: 'Windows Update', icon: 'ie', onclick: function () { W98.launch('ie', { url: 'http://windowsupdate.microsoft.com' }); } }
        ]
      },
      { label: 'Find', icon: 'find', items: [
        { label: 'Files or Folders...', icon: 'find', onclick: function () { W98.launch('find'); } },
        { label: 'Computer...', icon: 'my-computer', onclick: function () { W98.launch('find', { mode: 'computer' }); } },
        { label: 'On the Internet...', icon: 'ie', onclick: function () { W98.launch('ie', { url: 'http://search.msn.com' }); } }
      ] },
      { label: 'Help', icon: 'help', onclick: function () { W98.launch('help'); } },
      { label: 'Run...', icon: 'run', onclick: function () { W98.launch('run'); } },
      { type: 'sep' },
      { label: 'Log Off ' + W98.shell.USER + '...', icon: 'logoff', onclick: logOff },
      { label: 'Shut Down...', icon: 'shutdown', onclick: function () { W98.shutDown(); } }
    ];
  }

  function toggleStart() {
    if (startOpen) { closeStart(); return; }
    openStart();
  }
  function openStart() {
    startOpen = true;
    startBtn.classList.add('open');
    startMenu.style.display = 'flex';
    Sound.play('MenuPopup');
  }
  function closeStart() {
    startOpen = false;
    startBtn.classList.remove('open');
    startMenu.style.display = 'none';
    W98.closeMenus();
  }
  W98.closeStart = closeStart;

  function buildStartMenu() {
    startMenu = el('div');
    startMenu.id = 'startmenu';
    startMenu.style.display = 'none';
    var main = el('div', 'sm-main');
    var band = el('div', 'sm-band');
    band.innerHTML = '<span class="hi">Windows</span><span class="low">98</span>';
    var items = el('div', 'sm-items');
    main.appendChild(band);
    main.appendChild(items);
    startMenu.appendChild(main);
    document.body.appendChild(startMenu);

    var defs = startItems();
    defs.forEach(function (it) {
      if (it.type === 'sep') { items.appendChild(el('div', 'sm-sep')); return; }
      var row = el('div', 'w98-menu-item');
      var ic = el('span', 'mi-icon');
      ic.appendChild(S.el(it.icon || 'programs', 24));
      row.appendChild(ic);
      row.appendChild(el('span', 'mi-label', mlabel(it.label)));
      if (it.items) row.appendChild(el('span', 'mi-arrow', '&#9654;'));
      on(row, 'mouseenter', function () {
        items.querySelectorAll('.w98-menu-item').forEach(function (n) { n.classList.remove('hover'); });
        row.classList.add('hover');
        W98.closeMenus();
        clearTimeout(row._t);
        if (it.items) {
          row._t = setTimeout(function () {
            var r = row.getBoundingClientRect();
            W98.menu.show(it.items, r.right - 3, r.top - 3, { minWidth: 150, onPick: function () { closeStart(); } });
          }, 220);
        }
      });
      on(row, 'mouseup', function (e) {
        e.stopPropagation();
        if (it.items) return;
        closeStart();
        Sound.play('MenuCommand');
        if (it.onclick) it.onclick();
      });
      items.appendChild(row);
    });
    on(startMenu, 'mouseleave', function () {
      clearTimeout(startMenu._t);
      startMenu._t = setTimeout(function () {
        items.querySelectorAll('.w98-menu-item').forEach(function (n) { n.classList.remove('hover'); });
      }, 600);
    });
    on(startMenu, 'mousedown', function (e) { e.stopPropagation(); });
  }

  function logOff() {
    W98.dialog.confirm('Log Off Windows', 'Are you sure you want to log off?').then(function (yes) {
      if (!yes) return;
      Sound.play('SystemLogoff');
      W98.shutDown({ logoff: true });
    });
  }

  /* ==================================================================== */
  /* Shut down / boot screens                                             */
  /* ==================================================================== */
  var bootEl, bsodEl;
  function buildBootScreen() {
    bootEl = el('div');
    bootEl.id = 'bootscreen';
    var inner = el('div', 'bs-inner');
    var img = el('img');
    var man = S.manifest();
    if (man && man.boot && man.boot.splash) {
      img.src = 'assets/' + man.boot.splash.file;
      img.style.imageRendering = 'pixelated';
      img.style.maxWidth = '640px';
    }
    inner.appendChild(img);
    bootEl.appendChild(inner);
    var log = el('div', 'bs-log');
    bootEl.appendChild(log);
    bootEl._log = log;
    document.body.appendChild(bootEl);
    void img;
  }
  function showBootScreen(lines) {
    bootEl.classList.add('on');
    if (bootEl._log) {
      bootEl._log.innerHTML = lines.map(function (l) { return esc(l); }).join('<br>');
    }
  }
  function hideBootScreen() { bootEl.classList.remove('on'); }

  W98.shutDown = function (opts) {
    if (W98.shutdownInProgress) return;
    opts = opts || {};
    var st = W98.stats();
    W98.dialog.messageBox('Shut Down Windows', '', {
      kind: 'question',
      icon: 'shutdown',
      width: 340,
      buttons: ['OK', 'Cancel'],
      results: ['ok', null],
      buildExtra: function (box) {
        box.appendChild(el('div', '', esc(opts.logoff ? 'Are you sure you want to log off?' : 'What do you want the computer to do?')));
        var optsList = opts.logoff ? [['Log off ' + W98.shell.USER, true]]
          : [['Stand &by', false], ['&Shut down', true], ['&Restart', false], ['Restart in &MS-DOS mode', false]];
        optsList.forEach(function (o, i) {
          var row = el('label', 'field-row');
          row.style.marginTop = '6px';
          var rb = el('input');
          rb.type = 'radio';
          rb.name = 'shutopt';
          rb.checked = !!o[1];
          rb.value = o[0].replace(/&/g, '');
          row.appendChild(rb);
          row.appendChild(el('span', '', o[0].replace('&', '')));
          box.appendChild(row);
        });
        box._radios = function () {
          var r = box.querySelectorAll('input[type=radio]');
          for (var i = 0; i < r.length; i++) if (r[i].checked) return r[i].value;
          return 'Shut down';
        };
        /* keep the promise chain simple: remember the box for the caller */
        W98._shutBox = box;
      }
    }).then(function (r) {
      if (r !== 'ok') return;
      var choice = W98._shutBox && W98._shutBox._radios ? W98._shutBox._radios() : 'Shut down';
      W98._shutBox = null;
      if (opts.logoff) choice = 'Log off';
      if (choice === 'Restart' || choice === 'Restart in MS-DOS mode') {
        W98.shutdownInProgress = true;
        Sound.play('SystemExit');
        showBootScreen(['Windows is shutting down...', 'The computer will restart.']);
        K.flush().then(function () { setTimeout(function () { location.reload(); }, 1600); });
        return;
      }
      if (choice === 'Stand by') {
        showBootScreen(['Windows is going to sleep...', 'Move the mouse or press a key to wake up.']);
        var wake = function () {
          off(document, 'mousemove', wake); off(document, 'keydown', wake); off(document, 'mousedown', wake);
          hideBootScreen();
        };
        on(document, 'mousemove', wake); on(document, 'keydown', wake); on(document, 'mousedown', wake);
        return;
      }
      W98.shutdownInProgress = true;
      Sound.play('SystemExit');
      var man = S.manifest();
      bootEl.classList.add('on');
      bootEl._log.innerHTML = '';
      var inner = bootEl.querySelector('.bs-inner');
      inner.innerHTML = '';
      if (man && man.boot && man.boot.shutdown) {
        var im = el('img');
        im.src = 'assets/' + man.boot.shutdown.file;
        im.style.imageRendering = 'pixelated';
        im.style.maxWidth = '640px';
        inner.appendChild(im);
      } else {
        var t = el('div', 'bs-off');
        t.innerHTML = 'It&#39;s now safe to turn off<br>your computer.';
        inner.appendChild(t);
      }
      K.flush();
      void st;
    });
  };

  /* ==================================================================== */
  /* Ctrl+Alt+Del: the Close Program dialog                               */
  /* ==================================================================== */
  function closeProgramDialog() {
    var procs = K.procs.list().filter(function (p) { return p.state === K.PS.RUNNING || p.state === K.PS.MIN; });
    var list = procs.map(function (p) { return p.name + ' (' + String(p.pid).padStart(4, '0').slice(-4) + ')'; });
    var w = W98.dialog.custom({ title: 'Close Program', width: 300, height: 220, icon: 'task-manager' });
    w.box.style.padding = '10px';
    w.box.appendChild(el('div', '', 'Press Ctrl+Alt+Del again to restart your computer. You will<br>lose any unsaved information in all programs.'));
    var box = el('div', 'w98-listbox cp-list');
    list.forEach(function (l, i) {
      var row = el('div', 'w98-listitem' + (i === 0 ? ' selected' : ''), esc(l));
      row.dataset.pid = procs[i].pid;
      on(row, 'click', function () {
        box.querySelectorAll('.w98-listitem').forEach(function (n) { n.classList.remove('selected'); });
        row.classList.add('selected');
      });
      box.appendChild(row);
    });
    w.box.appendChild(box);
    var btns = el('div', 'dlg-buttons');
    btns.style.justifyContent = 'flex-end';
    var endB = el('button', 'default', 'End Task');
    var shutB = el('button', '', 'Shut Down');
    var cancelB = el('button', '', 'Cancel');
    [endB, shutB, cancelB].forEach(function (b) { b.style.minWidth = '70px'; btns.appendChild(b); });
    w.box.appendChild(btns);
    function close() { w.close(); }
    on(endB, 'click', function () {
      var sel = box.querySelector('.selected');
      if (!sel) return;
      var pid = parseInt(sel.dataset.pid, 10);
      var win = W98.windowByPid(pid);
      if (win) win.close();
      else K.procs.destroy(pid);
      close();
    });
    on(shutB, 'click', function () { close(); W98.shutDown(); });
    on(cancelB, 'click', close);
  }
  W98.closeProgramDialog = closeProgramDialog;

  /* ==================================================================== */
  /* screen savers                                                        */
  /* ==================================================================== */
  var ss = { active: false, raf: 0, canvas: null, ctx: null, state: null };
  var SAVER_NAMES = {
    'C:\\WINDOWS\\SYSTEM\\WIN98.SCR': 'Windows 98',
    'C:\\WINDOWS\\SYSTEM\\MYSTIFY.SCR': 'Mystify',
    'C:\\WINDOWS\\SYSTEM\\STARFIELD.SCR': 'Starfield Simulation',
    'C:\\WINDOWS\\SYSTEM\\FLYINGWINDOWS.SCR': 'Flying Windows',
    'C:\\WINDOWS\\SYSTEM\\BLANK.SCR': '(Blank)'
  };
  W98.saverNames = SAVER_NAMES;

  function startSaver(which) {
    var name = which || reg(DESK, 'SCRNSAVE.EXE', 'C:\\WINDOWS\\SYSTEM\\WIN98.SCR');
    var draw = SAVERS[name] || SAVERS['C:\\WINDOWS\\SYSTEM\\WIN98.SCR'];
    var host = $('#screensaver');
    host.innerHTML = '';
    host.classList.add('on');
    var cv = el('canvas');
    cv.width = global.innerWidth; cv.height = global.innerHeight;
    cv.style.width = '100%'; cv.style.height = '100%';
    host.appendChild(cv);
    ss.active = true;
    ss.canvas = cv;
    ss.ctx = cv.getContext('2d');
    ss.state = { t: 0 };
    ss.ctx.imageSmoothingEnabled = false;
    function loop() {
      if (!ss.active) return;
      ss.state.t += 16;
      try { draw(ss.ctx, cv, ss.state); } catch (e) { ss.active = false; throw e; }
      ss.raf = requestAnimationFrame(loop);
    }
    loop();
  }
  function stopSaver() {
    if (!ss.active) return;
    ss.active = false;
    cancelAnimationFrame(ss.raf);
    $('#screensaver').classList.remove('on');
  }
  function logoCanvas() {
    if (global.__ssLogo) return global.__ssLogo;
    var c = document.createElement('canvas');
    c.width = 200; c.height = 90;
    var g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 200, 90);
    var colors = ['#e23b2e', '#3fa63f', '#2f6fd0', '#f0c419'];
    var geo = [[0, 0], [1, 0], [0, 1], [1, 1]];
    colors.forEach(function (col, i) {
      var x = 10 + geo[i][0] * 30, y = 16 + geo[i][1] * 28;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, y + 4); g.lineTo(x + 26, y); g.lineTo(x + 26, y + 22); g.lineTo(x, y + 26);
      g.closePath(); g.fill();
    });
    g.fillStyle = '#fff';
    g.font = 'bold 13px "Pixelated MS Sans Serif", Tahoma, sans-serif';
    g.fillText('Microsoft', 76, 32);
    g.font = 'bold 26px "Pixelated MS Sans Serif", Tahoma, sans-serif';
    g.fillText('Windows', 76, 58);
    g.font = 'bold 16px "Pixelated MS Sans Serif", Tahoma, sans-serif';
    g.fillText('98', 76 + 104, 74);
    global.__ssLogo = c;
    return c;
  }
  function savLogo(ctx, cv, st) {
    if (!st.x) { st.x = 40; st.y = 40; st.dx = 1.7; st.dy = 1.3; }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    var w = 200, h = 90;
    st.x += st.dx; st.y += st.dy;
    if (st.x < 0 || st.x + w > cv.width) { st.dx *= -1; st.x = clamp(st.x, 0, cv.width - w); }
    if (st.y < 0 || st.y + h > cv.height) { st.dy *= -1; st.y = clamp(st.y, 0, cv.height - h); }
    ctx.drawImage(logoCanvas(), st.x, st.y, w, h);
  }
  function savMystify(ctx, cv, st) {
    if (!st.polys) {
      st.polys = [];
      for (var i = 0; i < 3; i++) {
        var pts = [];
        for (var j = 0; j < 4; j++) {
          pts.push({ x: Math.random() * cv.width, y: Math.random() * cv.height, vx: (Math.random() - .5) * 4, vy: (Math.random() - .5) * 4 });
        }
        st.polys.push({ pts: pts, hue: i * 110, trail: [] });
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    st.polys.forEach(function (p) {
      p.pts.forEach(function (q) {
        q.x += q.vx; q.y += q.vy;
        if (q.x < 0 || q.x > cv.width) { q.vx *= -1; q.x = clamp(q.x, 0, cv.width); }
        if (q.y < 0 || q.y > cv.height) { q.vy *= -1; q.y = clamp(q.y, 0, cv.height); }
      });
      p.hue = (p.hue + 0.6) % 360;
      p.trail.push(p.pts.map(function (q) { return [q.x, q.y]; }));
      if (p.trail.length > 14) p.trail.shift();
      p.trail.forEach(function (t, i) {
        ctx.strokeStyle = 'hsl(' + Math.round((p.hue + i * 9) % 360) + ',95%,' + (14 + i * 5) + '%)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        t.forEach(function (q, j) { j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
        ctx.closePath(); ctx.stroke();
      });
    });
  }
  function savStarfield(ctx, cv, st) {
    if (!st.stars) {
      st.stars = [];
      for (var i = 0; i < 420; i++) {
        st.stars.push({ x: (Math.random() - .5) * cv.width, y: (Math.random() - .5) * cv.height, z: Math.random() * cv.width + 1 });
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    var cx = cv.width / 2, cy = cv.height / 2;
    for (var k = 0; k < st.stars.length; k++) {
      var s = st.stars[k];
      s.z -= 10;
      if (s.z < 1) { s.z = cv.width; s.x = (Math.random() - .5) * cv.width; s.y = (Math.random() - .5) * cv.height; }
      var f = 200 / s.z;
      var px = Math.round(s.x * f + cx), py = Math.round(s.y * f + cy);
      if (px < 0 || px > cv.width || py < 0 || py > cv.height) continue;
      var b = Math.max(60, Math.min(255, 255 - s.z * 0.6)) | 0;
      ctx.fillStyle = 'rgb(' + b + ',' + b + ',' + b + ')';
      ctx.fillRect(px, py, 2, 2);
    }
  }
  function savFlying(ctx, cv, st) {
    if (!st.items) {
      st.items = [];
      for (var i = 0; i < 24; i++) {
        st.items.push({ x: Math.random() * cv.width, y: Math.random() * cv.height, z: Math.random() * 320 + 40, spin: Math.random() * 6 });
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    var logo = logoCanvas();
    var t = st.t;
    for (var k = 0; k < st.items.length; k++) {
      var it = st.items[k];
      it.z -= 1.7;
      if (it.z < 30) { it.z = 340; it.x = Math.random() * cv.width; it.y = Math.random() * cv.height; }
      var f = 320 / it.z;
      var w = 150 * f, h = 66 * f;
      var px = it.x - w / 2 + Math.sin(t / 900 + it.spin) * 40, py = it.y - h / 2;
      ctx.globalAlpha = Math.max(0.05, Math.min(1, f * 1.4));
      ctx.drawImage(logo, px, py, w, h);
      ctx.globalAlpha = 1;
    }
  }
  var SAVERS = {
    'C:\\WINDOWS\\SYSTEM\\WIN98.SCR': savLogo,
    'C:\\WINDOWS\\SYSTEM\\MYSTIFY.SCR': savMystify,
    'C:\\WINDOWS\\SYSTEM\\STARFIELD.SCR': savStarfield,
    'C:\\WINDOWS\\SYSTEM\\FLYINGWINDOWS.SCR': savFlying,
    'C:\\WINDOWS\\SYSTEM\\BLANK.SCR': function (ctx, cv) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); }
  };
  W98.startSaver = startSaver;
  W98.stopSaver = stopSaver;
  var idleMs = 0, lastInput = Date.now();
  ['mousemove', 'mousedown', 'keydown', 'wheel'].forEach(function (ev) {
    on(document, ev, function () {
      lastInput = Date.now();
      if (ss.active) stopSaver();
    }, true);
  });
  setInterval(function () {
    if (W98.shutdownInProgress) return;
    if (ss.active) return;
    var active = reg(DESK, 'ScreenSaveActive', '1') === '1';
    if (!active) return;
    var timeout = parseInt(reg(DESK, 'ScreenSaveTimeOut', '600'), 10) || 600;
    idleMs = (Date.now() - lastInput) / 1000;
    if (idleMs >= timeout) startSaver();
  }, 2000);

  /* ==================================================================== */
  /* keyboard shortcuts                                                   */
  /* ==================================================================== */
  var altTab = { on: false, idx: 0, panel: null };
  function typingInField(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  }
  on(document, 'keydown', function (e) {
    if (e.ctrlKey && e.key === 'Escape') { e.preventDefault(); toggleStart(); return; }
    if (e.ctrlKey && e.altKey && e.key === 'Delete') { e.preventDefault(); closeProgramDialog(); return; }
    if (typingInField(e)) return;
    if (e.key === 'F5') { e.preventDefault(); buildDesktopIcons(); }
    if (e.key === 'Escape') {
      if (startOpen) { closeStart(); }
      return;
    }
    if (e.key === 'F2' && selIcons.length === 1 && selIcons[0]._item.shortcut) {
      renameIcon(selIcons[0]._item);
    }
    if (e.key === 'Enter' && selIcons.length === 1 && selIcons[0]._item.open) {
      selIcons[0]._item.open();
    }
    if (e.key === 'Delete' && selIcons.length === 1) deleteIcon(selIcons[0]._item);
    if (e.key === 'F10' && W98.shell.activeWindow()) {
      var w = W98.shell.activeWindow();
      if (w.menuButtons && w.menuButtons[0]) { e.preventDefault(); }
    }
    /* Alt+Tab window switching */
    if (e.altKey && e.key === 'Tab') {
      e.preventDefault();
      var wins = W98.shell.windows.filter(function (w) { return !w.modal; });
      if (wins.length < 2) return;
      if (!altTab.on) { altTab.on = true; altTab.idx = 0; showAltPanel(wins); }
      altTab.idx = (altTab.idx + (e.shiftKey ? -1 : 1) + wins.length) % wins.length;
      highlightAltPanel(wins);
    }
  }, true);
  on(document, 'keyup', function (e) {
    if (e.key === 'Alt' && altTab.on) {
      altTab.on = false;
      var wins = W98.shell.windows.filter(function (w) { return !w.modal; });
      var target = wins[altTab.idx];
      hideAltPanel();
      if (target) target.focus();
    }
  });

  function showAltPanel(wins) {
    var p = el('div', 'w98-raised');
    p.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#c0c0c0;padding:8px;z-index:12500;display:flex;gap:8px';
    wins.forEach(function (w, i) {
      var cell = el('div');
      cell.style.cssText = 'width:74px;text-align:center;padding:4px;display:flex;flex-direction:column;align-items:center;gap:4px';
      cell.appendChild(S.el(w.iconKey || 'unknown-file', 32));
      cell.appendChild(el('div', '', esc((w.title || '').slice(0, 12))));
      p.appendChild(cell);
    });
    document.body.appendChild(p);
    altTab.panel = p;
  }
  function highlightAltPanel(wins) {
    if (!altTab.panel) return;
    [].slice.call(altTab.panel.children).forEach(function (c, i) {
      c.style.background = i === altTab.idx ? '#000080' : 'transparent';
      c.style.color = i === altTab.idx ? '#fff' : '#000';
    });
  }
  function hideAltPanel() {
    if (altTab.panel) {
      altTab.panel.parentNode.removeChild(altTab.panel);
      altTab.panel = null;
    }
  }

  /* ==================================================================== */
  /* boot                                                                 */
  /* ==================================================================== */
  function buildDom() {
    desktop = el('div');
    desktop.id = 'desktop';
    holder = el('div');
    holder.style.cssText = 'position:absolute;inset:0;z-index:1';
    desktop.appendChild(holder);
    document.body.appendChild(desktop);

    taskbar = el('div');
    taskbar.id = 'taskbar';
    document.body.appendChild(taskbar);

    var pop = el('div');
    pop.id = 'traypopup';
    pop.style.display = 'none';
    document.body.appendChild(pop);
  }

  function welcomeDialog() {
    var w = W98.dialog.custom({ title: 'Welcome to Windows 98', width: 400, height: 250, icon: 'ie' });
    w.setIcon('win-flag');
    var box = w.box;
    box.style.padding = '10px';
    box.innerHTML =
      '<div style="display:flex;gap:10px">' +
      '<div style="flex:0 0 auto"></div>' +
      '<div style="flex:1 1 auto;line-height:15px">' +
      '<b style="font-size:14px;color:#000080">Welcome</b><br>' +
      'to the exciting new world of Windows 98.' +
      '<hr class="w98-hr">' +
      '<span style="color:#000080">Did you know...</span><br>' +
      'You can run real MS-DOS games here. Open <b>Start &gt; Programs &gt; MS-DOS Prompt</b> ' +
      'and type <b>DOOM</b>, or look in <b>Start &gt; Programs &gt; DOS Games</b>.' +
      '<hr class="w98-hr">' +
      '<small>Every window is a process in <b>kernel.wasm</b>. Open Task Manager to watch it.</small>' +
      '</div></div>';
    var btns = el('div', 'dlg-buttons');
    btns.style.justifyContent = 'flex-end';
    var closeB = el('button', 'default', 'Close');
    var nextB = el('button', '', 'Next Tip');
    btns.appendChild(closeB); btns.appendChild(nextB);
    box.appendChild(btns);
    on(closeB, 'click', function () { Sound.play('MenuCommand'); w.close(); });
    on(nextB, 'click', function () { Sound.play('MenuCommand'); var t = box.querySelector('small'); t.textContent = tips[Math.floor(Math.random() * tips.length)]; });
    var tips = [
      'Press Ctrl+Alt+Del to see the Close Program dialog, just like 1998.',
      'Right-click the desktop to arrange or create new icons.',
      'The Recycle Bin keeps deleted files in C:\\RECYCLED.',
      'Try Start > Run and type WINVER, CALC, MSPAINT or COMMAND.',
      'Display Properties can change the wallpaper and start a screen saver.',
      'Task Manager shows real CPU time charged by the kernel scheduler.',
      'Type CRASH98 in the Run dialog if you miss the blue screen.'
    ];
  }

  function trace(msg) {
    (W98.__bootTrace = W98.__bootTrace || []).push(Math.round(performance.now()) + 'ms ' + msg);
  }
  function boot() {
    trace('boot start, readyState=' + document.readyState);
    if (W98.__bootStarted) return; W98.__bootStarted = true;
    buildDom();
    buildTaskbar();
    buildStartMenu();
    buildBootScreen();
    var ss = el('div');
    ss.id = 'screensaver';
    document.body.appendChild(ss);
    bsodEl = el('div');
    bsodEl.id = 'bsod';
    document.body.appendChild(bsodEl);

    W98.shell.setWindowRefs({ desktop: desktop, taskbar: taskbar, tasks: tasks, holder: holder, clock: clockEl });
    W98.bootWallClock = Date.now();
    try { applyDesktop(); } catch (e) { console.warn('wallpaper', e); }

    trace('dom built');
    S.loadAssets().then(function () {
      trace('assets loaded: ' + (S.manifest() ? 'manifest' : 'none'));
      return K.boot();
    }).then(function () {
      trace('kernel ready: ' + K.mode);
      W98.reg.flushEarly();
      if (W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'MuteSounds', '0') === '1') Sound.setMuted(true);
      var vol = parseInt(W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'Volume', '70'), 10);
      if (!isNaN(vol)) Sound.setVolume(vol / 100);
      var schemeName = W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Desktop', 'ColorScheme', 'Windows Standard');
      if (W98.applyScheme) W98.applyScheme(schemeName);
      var st = K.stats();
      showBootScreen([
        'Windows 98 (kernel.wasm ' + (K.mode === 'wasm' ? 'wasm32' : 'shim') + ')',
        'kernel heap ' + Math.round(st.HEAP_FREE / 1024) + ' KB free / ' + Math.round(st.HEAP_SIZE / 1024) + ' KB',
        'volume: ' + st.FILES + ' files, ' + st.BYTES + ' bytes',
        'registry: ' + st.REG + ' values',
        'processors: 1 (WebAssembly, ' + (K.mode === 'wasm' ? Math.round(K.moduleBytes / 1024) + ' KB image' : 'fallback') + ')'
      ]);
      trace('desktop build');
      try { applyDesktop(); } catch (e) { console.warn('wallpaper', e); }
      try { W98.shell.seedSampleFiles(); } catch (e) { console.warn('seed extras', e); }
      try { buildDesktopIcons(); } catch (e) { console.warn('desktop icons', e); }
      try { updateTaskbar(); } catch (e) { console.warn('taskbar', e); }
      try { wireDesktop(); } catch (e) { console.warn('desktop input', e); }
      W98.shell.startLoop();
      /* seeding copies the sound scheme into C:\WINDOWS\MEDIA; it must never
         hold up the desktop, so it is time-boxed */
      return Promise.race([
        W98.shell.seedMedia().catch(function (e) { console.warn('media', e); return 0; }),
        new Promise(function (res) { setTimeout(function () { res('timeout'); }, 5000); })
      ]);
    }).then(function () {
      trace('media seeded');
      try { applyDesktop(); } catch (e) { console.warn('wallpaper', e); }
      var man = S.manifest();
      void man;
      return new Promise(function (res) { setTimeout(res, 1700); });
    }).then(function () {
      hideBootScreen();
      /* unlock audio on the first user gesture, then greet */
      var unlock = function () {
        Sound.resume();
        off(document, 'mousedown', unlock); off(document, 'keydown', unlock);
      };
      on(document, 'mousedown', unlock); on(document, 'keydown', unlock);
      Sound.startup();
      W98.booted = true;
      if (K.mode !== 'wasm') {
        W98.dialog.alert('Windows', 'kernel.wasm could not be started, so Windows is running the reduced\n' +
          'JavaScript fallback. Files and registry values will not all persist.\n\nReason: ' + (K.error || 'unknown'), 'error');
      }
      try { W98.setPointerTrails(W98.reg.get('HKEY_CURRENT_USER\\Control Panel\\Mouse', 'Trails', '0') === '1'); }
      catch (e) { console.warn('trails', e); }
      var seen = W98.reg.get('HKEY_CURRENT_USER\\Software\\W98', 'WelcomeShown', null);
      if (!seen) {
        W98.reg.set('HKEY_CURRENT_USER\\Software\\W98', 'WelcomeShown', '1');
        welcomeDialog();
      }
      trace('desktop ready');
      refreshDesktopSoon();
    }).catch(function (e) {
      trace('FAILED: ' + (e && e.message));
      console.error('boot sequence failed: ' + (e && e.message), e);
      hideBootScreen();
      W98.dialog.alert('Windows', 'A problem occurred while starting Windows:\n' + (e && e.message),
        'error');
    });
  }

  function refreshDesktopSoon() {
    if (recycleCount() !== refreshDesktopSoon._last) {
      refreshDesktopSoon._last = recycleCount();
      buildDesktopIcons();
    }
    setTimeout(refreshDesktopSoon, 1500);
  }

  /* ==================================================================== */
  /* BSOD easter egg (via Start > Run: crash98)                           */
  /* ==================================================================== */
  W98.crash = function () {
    K.panic(0x0000000E);
    var st = K.stats();
    bsodEl.innerHTML =
      '<div class="bsod-t">Windows</div>' +
      '<p>A fatal exception 0E has occurred at 0028:C0034B32 in VXD VMM(01) + 00010E32. ' +
      'The current application will be terminated.</p>' +
      '<p>*  Press any key to terminate the current application.<br>' +
      '*  Press CTRL+ALT+DEL again to restart your computer. You will lose any unsaved information in all applications.</p>' +
      '<p>panic code 0x' + st.PANIC.toString(16).toUpperCase() + ' &nbsp; syscalls ' + st.SYSCALLS +
      ' &nbsp; kernel heap ' + Math.round(st.HEAP_USED / 1024) + ' KB of ' + Math.round(st.HEAP_SIZE / 1024) + ' KB</p>' +
      '<p style="text-align:center">Press any key to continue _</p>';
    bsodEl.classList.add('on');
    Sound.play('SystemHand');
    var away = function () {
      off(document, 'keydown', away);
      bsodEl.classList.remove('on');
      location.reload();
    };
    setTimeout(function () { on(document, 'keydown', away); }, 400);
  };

  /* ==================================================================== */
  /* STOP screen — the kernel's bugcheck dump, on the blue background      */
  /* ==================================================================== */
  W98.stopScreen = function (dump, code) {
    var title = 'STOP: 0x' + ((code >>> 0) || 0).toString(16).toUpperCase().replace(/^0+(?=.)/, '');
    var text = String(dump || '').replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
    bsodEl.innerHTML =
      '<div class="bsod-t">Windows</div>' +
      '<p>' + title + '</p>' +
      '<pre style="white-space:pre-wrap;margin:0 0 10px 0;background:transparent;color:#ffffff;' +
      'font-family:Lucida Console,monospace;font-size:12px">' +
      text + '</pre>' +
      '<p style="text-align:center">Press any key to restart your computer _</p>';
    bsodEl.classList.add('on');
    Sound.play('SystemHand');
    var away = function () {
      off(document, 'keydown', away);
      bsodEl.classList.remove('on');
      location.reload();
    };
    setTimeout(function () { on(document, 'keydown', away); }, 400);
  };

  W98.__boot = boot;
  trace('desk.js loaded, readyState=' + document.readyState);
  if (document.readyState === 'loading') on(document, 'DOMContentLoaded', boot);
  else boot();
})(window);
