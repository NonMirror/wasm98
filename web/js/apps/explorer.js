/* ============================================================================
   explorer.js — Windows Explorer / My Computer / folder windows.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98, I = window.W98Icons, U = W98.util;
  var el = U.el, esc = U.escapeHtml, clamp = U.clamp;

  /* Host media is optional: Explorer remains usable with the plain VFS. */
  function mediaStatus(drive) {
    var h = W98.hostFiles || window.W98HostFileBridge;
    try {
      if (W98.media && typeof W98.media.status === 'function') {
        var owned = W98.media.status(drive);
        if (owned) return owned;
      }
      if (h && typeof h.status === 'function') return h.status(drive);
      if (W98.media && typeof W98.media.state === 'function') {
        var s = W98.media.state(); return s[drive === 'A' ? 'floppy' : 'cdrom'] || null;
      }
    } catch (e) { /* media may have been ejected between frames */ }
    return null;
  }
  function showFsError(title, path) {
    var h = W98.hostFiles || window.W98HostFileBridge;
    var e = /^[AD]:/i.test(String(path || '')) && W98.media && typeof W98.media.lastError === 'function'
      ? W98.media.lastError() : (h && h.lastError);
    if (e && e.message) W98.dialog.alert(title || 'Windows', e.message, 'error');
    return !!e;
  }
  function mutationFailed(result, title, path) {
    if (typeof result === 'number' && result < 0) { showFsError(title, path); return true; }
    return false;
  }

  var VIEWS = { large: 'Large Icons', small: 'Small Icons', list: 'List', details: 'Details' };
  var clip = { op: null, items: [] };

  function registryIcon(name) {
    var map = {
      'Control Panel': 'control-panel', 'Printers': 'printer', 'Dial-Up Networking': 'dial-up',
      'Scheduled Tasks': 'scheduled-tasks', 'Web Folders': 'web-folders',
      'My Briefcase': 'briefcase', 'Network Neighborhood': 'network', 'My Computer': 'my-computer',
      'My Documents': 'documents'
    };
    return map[name] || 'folder';
  }

  W98.registerApp({
    id: 'explorer',
    title: 'Exploring',
    icon: 'explorer',
    width: 640, height: 420,
    minWidth: 320, minHeight: 200,
    desktop: false,
    startMenuGroup: null,
    create: function (win, args) {
      args = args || {};
      var state = {
        path: args.path || 'C:\\',
        special: args.special || null,
        view: W98.reg.get(W98.regKey('Explorer'), 'View', 'large'),
        history: [],
        hi: -1,
        sel: []
      };
      function ejectFloppy() {
        var h = W98.hostFiles || window.W98HostFileBridge;
        try {
          var r = h && typeof h.eject === 'function' ? h.eject('A') :
            (W98.media && typeof W98.media.eject === 'function' ? W98.media.eject('floppy') : null);
          if (r && typeof r.then === 'function') r.then(function () { render(); });
          else render();
        } catch (e) { W98.dialog.alert('Floppy (A:)', e.message || 'The floppy could not be ejected.', 'error'); }
      }
      if (state.path === 'C:\\' && !args.special) state.special = 'computer';

      /* ---------------- chrome ---------------- */
      var toolbar = el('div', 'w98-toolbar');
      var address = el('div', 'row');
      address.style.cssText = 'height:22px;gap:4px;padding:1px 3px;background:#c0c0c0;flex:0 0 auto';
      address.appendChild(el('div', '', 'Address'));
      var addrBox = el('div', 'w98-field row grow');
      addrBox.style.cssText += 'height:20px;padding:0 2px;overflow:hidden';
      var addrIcon = el('span');
      var addrText = el('div', 'grow nowrap');
      addrText.style.paddingLeft = '2px';
      addrBox.appendChild(addrIcon); addrBox.appendChild(addrText);
      address.appendChild(addrBox);

      var viewHost = el('div', 'grow');
      viewHost.style.position = 'relative';
      viewHost.style.overflow = 'auto';
      viewHost.style.background = '#fff';
      viewHost.style.boxShadow = 'inset -1px -1px #fff, inset 1px 1px grey, inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a';
      viewHost.style.margin = '2px';
      /* A host drop is routed only to an actual guest folder.  No host path is
         inferred or scanned: the browser supplies the File objects in the
         drop event and the bridge consumes exactly those objects. */
      viewHost.addEventListener('dragover', function (e) {
        if (/^[Cc]:\\/.test(state.path) || /^[AaDd]:\\/.test(state.path)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      viewHost.addEventListener('drop', function (e) {
        if (!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) return;
        if (!/^[Cc]:\\/.test(state.path)) return;
        e.preventDefault();
        var h = W98.hostFiles || window.W98HostFileBridge;
        if (!h || typeof h.importToGuest !== 'function') return;
        h.importToGuest(e.dataTransfer.files, state.path).then(function (r) {
          render();
          if (r && r.errors && r.errors.length) W98.dialog.alert('Copy to ' + state.path, r.errors.join('\n'), 'error');
        }).catch(function (err) { W98.dialog.alert('Copy to ' + state.path, err.message || String(err), 'error'); });
      });

      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';
      win.el.appendChild(toolbar);
      win.el.appendChild(address);
      win.el.appendChild(viewHost);

      function toolBtn(icon, title, fn, label) {
        var b = el('button', 'w98-toolbtn');
        b.title = title;
        b.appendChild(I.el(icon, 20));
        if (label) b.appendChild(el('span', '', label));
        b.style.flexDirection = 'column';
        b.style.height = '24px';
        b.style.fontSize = '10px';
        b.style.padding = '0 3px';
        b.onclick = fn;
        return b;
      }
      function sep() { return el('div', 'w98-toolbar-sep'); }

      var bBack = toolBtn('back', 'Back', function () { go(-1); }, 'Back');
      var bFwd = toolBtn('forward', 'Forward', function () { go(1); }, 'Forward');
      var bUp = toolBtn('up', 'Up One Level', function () { upOne(); });
      var bCut = toolBtn('cut', 'Cut', function () { doClip('cut'); });
      var bCopy = toolBtn('copy', 'Copy', function () { doClip('copy'); });
      var bPaste = toolBtn('paste', 'Paste', function () { doPaste(); });
      var bDel = toolBtn('delete', 'Delete', function () { doDelete(); });
      var bProps = toolBtn('props', 'Properties', function () { showProperties(); });
      var bViews = toolBtn('views', 'Views', function () { cycleView(); });
      [bBack, bFwd, bUp, sep(), bCut, bCopy, bPaste, bDel, bProps, sep(), bViews]
        .forEach(function (b) { toolbar.appendChild(b); });
      toolbar.appendChild(el('div', 'grow'));

      /* ---------------- menus ---------------- */
      function refreshMenus() {
        win.setMenu([
          {
            label: '&File', items: [
              { label: '&Open', onclick: openSel },
              { label: 'E&xplore', onclick: openSel },
              { type: 'sep' },
              { label: '&New', items: [{ label: '&Folder', onclick: newFolder }, { label: '&Text Document', onclick: newText }] },
              { label: 'Create &Shortcut', disabled: !state.sel.length, onclick: makeShortcut },
              { label: '&Insert Floppy...', onclick: function () { W98.launch('floppy'); } },
              { label: '&Host File Transfer...', onclick: function () { W98.launch('transfer', { paths: state.sel.map(function (s) { return s.it.path; }) }); } },
              { label: 'E&ject Floppy', onclick: function () { ejectFloppy(); } },
              { type: 'sep' },
              { label: '&Delete', disabled: !state.sel.length, onclick: doDelete },
              { label: 'Rena&me', disabled: state.sel.length !== 1, onclick: renameSel },
              { label: 'P&roperties', onclick: showProperties },
              { type: 'sep' },
              { label: '&Close', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Edit', items: [
              { label: '&Undo', disabled: true },
              { type: 'sep' },
              { label: 'Cu&t', onclick: function () { doClip('cut'); } },
              { label: '&Copy', onclick: function () { doClip('copy'); } },
              { label: '&Paste', disabled: !clip.op, onclick: doPaste },
              { type: 'sep' },
              { label: 'Select &All', onclick: selectAll }
            ]
          },
          {
            label: '&View', items: [
              { label: '&Toolbars', items: [{ label: 'Standard Buttons', type: 'check', checked: true }, { label: 'Address Bar', type: 'check', checked: true }, { label: 'Text Labels', type: 'check', checked: true }] },
              { label: '&Status Bar', type: 'check', checked: true },
              { type: 'sep' }
            ].concat(Object.keys(VIEWS).map(function (v) {
              return {
                label: VIEWS[v], type: 'radio', checked: state.view === v,
                onclick: function () { state.view = v; W98.reg.set(W98.regKey('Explorer'), 'View', v); render(); }
              };
            })).concat([
              { type: 'sep' },
              { label: 'Arrange &Icons', items: [
                { label: 'by &Name', onclick: function () { sortBy('name'); } },
                { label: 'by &Type', onclick: function () { sortBy('type'); } },
                { label: 'by &Size', onclick: function () { sortBy('size'); } }
              ] },
              { label: '&Refresh', onclick: function () { render(); } }
            ])
          },
          {
            label: '&Go', items: [
              { label: '&Back', disabled: state.hi <= 0, onclick: function () { go(-1); } },
              { label: '&Forward', disabled: state.hi >= state.history.length - 1, onclick: function () { go(1); } },
              { label: '&Up One Level', onclick: upOne },
              { type: 'sep' },
              { label: '&Home Page', onclick: function () { W98.launch('ie'); } },
              { type: 'sep' },
              { label: '&My Computer', onclick: function () { navigate('C:\\', 'computer'); } },
              { label: '&Control Panel', onclick: function () { W98.launch('control'); } },
              { label: '&Printers', onclick: function () { W98.dialog.alert('Printers', 'There are no printers installed.\n\nAdd Printer Wizard does not run on this desktop.', 'info'); } },
              { label: '&Taskbar & Start Menu...', onclick: function () { W98.launch('control', { applet: 'taskbar' }); } },
              { label: 'Fol&der Options...', onclick: function () { W98.launch('control', { applet: 'folder' }); } }
            ]
          },
          { label: 'F&avorites', items: [{ label: 'Add to Favorites...', onclick: function () { W98.dialog.alert('Favorites', 'The Favorites folder is empty.', 'info'); } }] },
          { label: '&Help', items: [{ label: 'Help Topics', onclick: function () { W98.launch('help'); } }, { type: 'sep' }, { label: 'About Windows', onclick: function () { W98.launch('winver'); } }] }
        ]);
      }

      /* ---------------- navigation ---------------- */
      function addrLabel() {
        if (state.special === 'computer') return 'My Computer';
        if (state.special === 'network') return 'Network Neighborhood';
        return state.path;
      }
      function navigate(path, special, noHist) {
        if (!noHist) {
          state.history = state.history.slice(0, state.hi + 1);
          state.history.push({ path: path, special: special || null });
          state.hi = state.history.length - 1;
        }
        state.path = path;
        state.special = special || null;
        state.sel = [];
        render();
      }
      function go(d) {
        var t = state.hi + d;
        if (t < 0 || t >= state.history.length) return;
        state.hi = t;
        navigate(state.history[t].path, state.history[t].special, true);
      }
      function upOne() {
        if (state.special) { navigate('C:\\', 'computer'); return; }
        var p = String(state.path).replace(/\\$/, '');
        if (/^[A-Za-z]:$/.test(p)) { navigate('C:\\', 'computer'); return; }
        var i = p.lastIndexOf('\\');
        navigate(i <= 2 ? p.slice(0, 2) + '\\' : p.slice(0, i));
      }

      /* ---------------- item model ---------------- */
      function items() {
        var out = [];
        if (state.special === 'computer') {
          var floppy = mediaStatus('A');
          out.push({ name: floppy && floppy.label ? floppy.label + ' (A:)' : '3\u00bd Floppy (A:)', icon: 'floppy-3-5', kind: 'drive', path: 'A:\\', type: '3\u00bd Inch Floppy Disk', used: floppy && floppy.used, total: floppy && floppy.capacity, media: floppy });
          out.push({ name: '(C:)', icon: 'hard-disk', kind: 'drive', path: 'C:\\', type: 'Local Disk', used: W98.stats().BYTES, total: 2 * 1024 * 1024 * 1024 });
          var cd = mediaStatus('D');
          if (cd && (cd.mounted !== false)) out.push({ name: (cd.label || 'Virtual CD-ROM') + ' (D:)', icon: 'cdrom', kind: 'drive', path: 'D:\\', type: 'Virtual CD-ROM (read-only)', used: cd.used, total: cd.capacity, media: cd });
          ['Control Panel', 'Printers', 'Dial-Up Networking', 'Scheduled Tasks', 'Web Folders'].forEach(function (n) {
            out.push({ name: n, icon: registryIcon(n), kind: 'folder', special: n, type: n === 'Web Folders' ? 'Folder' : 'System Folder' });
          });
          return out;
        }
        if (state.special === 'network') {
          out.push({ name: 'Entire Network', icon: 'network', kind: 'folder', type: 'Network' });
          out.push({ name: 'Microsoft Windows Network', icon: 'network', kind: 'folder', type: 'Network' });
          return out;
        }
        var list = W98.fs.list(state.path) || [];
        list.forEach(function (e) {
          var full = W98.fs.join(state.path, e.name);
          out.push({
            name: e.name, dir: e.dir, size: e.size, mtime: e.mtime, path: full,
            icon: I.has(W98.iconForEntry(e)) ? W98.iconForEntry(e) : W98.iconForEntry(e),
            type: typeOf(e),
            shortcut: /\.lnk$/i.test(e.name)
          });
        });
        return out;
      }
      function typeOf(e) {
        if (e.dir) return 'File Folder';
        var ext = (e.name.split('.').pop() || '').toLowerCase();
        var map = {
          txt: 'Text Document', ini: 'Configuration Settings', exe: 'Application', dll: 'Application Extension',
          bmp: 'Bitmap Image', wav: 'Wave Sound', lnk: 'Shortcut', bat: 'MS-DOS Batch File',
          sys: 'System file', log: 'Text Document', dat: 'Data file', tmp: 'Temporary file'
        };
        return map[ext] || (ext ? ext.toUpperCase() + ' File' : 'File');
      }

      function sortMode() { return W98.reg.get(W98.regKey('Explorer'), 'Sort', 'name'); }
      function sortBy(m) { W98.reg.set(W98.regKey('Explorer'), 'Sort', m); render(); }

      /* ---------------- rendering ---------------- */
      var viewEl = null;
      function render() {
        addrText.textContent = addrLabel();
        addrIcon.innerHTML = '';
        var ai = state.special === 'computer' ? 'my-computer' : (state.special === 'network' ? 'network' : 'folder');
        addrIcon.appendChild(I.el(ai, 16));
        bBack.disabled = state.hi <= 0;
        bFwd.disabled = state.hi >= state.history.length - 1;
        viewHost.innerHTML = '';
        var list = items();
        if (state.view === 'details' || state.view === 'list') {
          viewEl = el('div', 'iconview details');
          var head = el('div', 'row');
          head.style.cssText = 'height:17px;background:#c0c0c0;box-shadow:inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px grey, inset 2px 2px #dfdfdf;font-weight:normal';
          [['Name', 240], ['Size', 90], ['Type', 150], ['Modified', 140]].forEach(function (c) {
            var d = el('div', '', c[0]);
            d.style.cssText = 'flex:0 0 ' + c[1] + 'px;padding:0 6px;border-right:1px solid #dfdfdf';
            head.appendChild(d);
          });
          viewEl.appendChild(head);
        } else {
          viewEl = el('div', 'iconview');
        }
        list.forEach(function (it) {
          var cell;
          if (state.view === 'details' || state.view === 'list') {
            cell = el('div', 'row');
            cell.style.height = '17px';
            var name = el('div', 'row');
            name.style.cssText = 'flex:0 0 240px;gap:4px;padding:0 4px;overflow:hidden';
            name.appendChild(I.el(it.icon, 16));
            name.appendChild(el('span', 'lbl nowrap', esc(it.name)));
            cell.appendChild(name);
            var sz = el('div', '', it.dir ? '' : String(it.size));
            sz.style.cssText = 'flex:0 0 90px;padding:0 6px;text-align:right';
            cell.appendChild(sz);
            var ty = el('div', '', esc(it.type || (it.dir ? 'File Folder' : '')));
            ty.style.cssText = 'flex:0 0 150px;padding:0 6px';
            cell.appendChild(ty);
            var md = el('div', '', it.mtime != null ? W98.fs.timeString(it.mtime) : '');
            md.style.cssText = 'flex:0 0 140px;padding:0 6px';
            cell.appendChild(md);
          } else {
            cell = el('div', 'cell');
            var ic = el('span', 'ic');
            ic.appendChild(I.el(it.icon, state.view === 'small' ? 16 : 32));
            cell.appendChild(ic);
            cell.appendChild(el('div', 'lbl', esc(it.name)));
            if (state.view !== 'small') { cell.style.width = '78px'; }
          }
          cell._it = it;
          wireEntry(cell, it);
          viewEl.appendChild(cell);
        });
        viewHost.appendChild(viewEl);
        updateStatus(list);
        refreshMenus();
      }
      function updateStatus(list) {
        var files = list.filter(function (i) { return !i.dir; });
        var size = files.reduce(function (a, b) { return a + (b.size || 0); }, 0);
        var sel = state.sel;
        var segs;
        var drive = /^[AD]:\\$/i.test(state.path) ? mediaStatus(state.path.charAt(0).toUpperCase()) : null;
        if (sel.length) {
          segs = [{ text: 'Selected ' + sel.length + ' object(s) (' + Math.ceil(sel.reduce(function (a, b) { return a + (b.size || 0); }, 0) / 1024) + ' KB)', width: 300 },
          { text: 'My Computer' }];
        } else {
          segs = [{ text: drive ? (list.length + ' object(s)   ' + Math.ceil(drive.used / 1024) + ' KB used, ' + Math.ceil(drive.free / 1024) + ' KB free') : (list.length + ' object(s) (' + Math.ceil(size / 1024) + ' KB)'), width: 300 }, { text: addrLabel() }];
        }
        win.setStatus(segs);
      }
      function cycleView() {
        var order = ['large', 'small', 'list', 'details'];
        state.view = order[(order.indexOf(state.view) + 1) % order.length];
        W98.reg.set(W98.regKey('Explorer'), 'View', state.view);
        render();
      }
      function sortList(list) {
        var m = sortMode();
        return list.sort(function (a, b) {
          if (a.dir !== b.dir) return a.dir ? -1 : 1;
          if (m === 'size') return (b.size || 0) - (a.size || 0);
          if (m === 'type') return String(a.type) < String(b.type) ? -1 : 1;
          return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
        });
      }

      function select(cell, additive) {
        if (!additive) state.sel.forEach(function (d) { d.el.classList.remove('sel'); });
        state.sel = additive ? state.sel : [];
        if (!state.sel.some(function (s) { return s.el === cell; })) {
          state.sel.push({ el: cell, it: cell._it });
          cell.classList.add('sel');
        }
        updateStatus(items());
      }
      function wireEntry(cell, it) {
        cell.classList.add('noselect');
        onmousedownCell();
        function onmousedownCell() {
          cell.addEventListener('mousedown', function (e) {
            if (e.button === 2) { if (!cell.classList.contains('sel')) select(cell, false); return; }
            select(cell, e.ctrlKey);
          });
          cell.addEventListener('dblclick', function () { open(it); });
          cell.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            if (!cell.classList.contains('sel')) select(cell, false);
            var mi = [
              { label: '&Open', onclick: function () { open(it); } },
              { label: 'E&xplore', disabled: !it.dir, onclick: function () { W98.launch('explorer', { path: it.path }); } },
              { type: 'sep' },
              { label: 'Cu&t', onclick: function () { doClip('cut'); } },
              { label: '&Copy', onclick: function () { doClip('copy'); } },
              { type: 'sep' },
              { label: '&Delete', onclick: doDelete },
              { label: 'Rena&me', onclick: renameSel },
              { label: 'P&roperties', onclick: showProperties }
            ];
            W98.menu.contextMenu(mi, e);
          });
        }
      }
      function open(it) {
        if (it.kind === 'drive') { navigate(it.path); return; }
        if (it.special) {
          if (it.special === 'Control Panel') { W98.launch('control'); return; }
          if (it.special === 'Printers') { W98.dialog.alert('Printers', 'There are no printers installed.', 'info'); return; }
          navigate('C:\\', it.special === 'Web Folders' ? 'network' : it.special);
          return;
        }
        if (it.dir) { navigate(it.path); return; }
        var ext = (it.name.split('.').pop() || '').toLowerCase();
        if (/\.lnk$/i.test(it.name)) {
          var t = String(W98.fs.readText(it.path) || '');
          var m = /^app:([a-z0-9_-]+)/im.exec(t);
          if (m) { W98.launch(m[1]); return; }
          var p = /^path:(.+)$/im.exec(t);
          if (p) { it = { name: p[1].split('\\').pop(), path: p[1].trim(), dir: W98.fs.isDir(p[1].trim()) }; }
        }
        if (it.dir) { navigate(it.path); return; }
        if (ext === 'txt' || ext === 'ini' || ext === 'log' || ext === 'bat' || ext === 'sys') W98.launch('notepad', { path: it.path });
        else if (ext === 'bmp' || ext === 'png' || ext === 'dib') W98.launch('paint', { path: it.path });
        else if (ext === 'wav' || ext === 'mid' || ext === 'mp3' || ext === 'avi') W98.launch('mplayer', { path: it.path });
        else if (ext === 'htm' || ext === 'html' || ext === 'url') W98.launch('ie', { path: it.path });
        else if (ext === 'exe' || ext === 'com') W98.dialog.alert('Windows', 'Cannot run \'' + it.name + '\'.\nThis is not a valid Windows application.', 'error');
        else W98.launch('notepad', { path: it.path });
      }
      function openSel() { if (state.sel[0]) open(state.sel[0].it); }
      function selectAll() { viewEl.querySelectorAll('.cell, .row').forEach(function (c) { if (c._it) select(c, true); }); }

      function doClip(op) {
        if (!state.sel.length) return;
        clip.op = op;
        clip.items = state.sel.map(function (s) { return s.it.path; });
        refreshMenus();
      }
      function doPaste() {
        if (!clip.op || !clip.items.length) return;
        clip.items.forEach(function (p) {
          var name = p.split('\\').pop();
          var dest = W98.fs.join(state.path, name);
          if (dest === p) return;
          var bytes = W98.fs.readBytes(p);
          var result = bytes ? W98.fs.writeBytes(dest, bytes) : W98.fs.mkdir(dest);
          if (mutationFailed(result, 'Copy', dest)) return;
          if (clip.op === 'cut') mutationFailed(W98.fs.remove(p), 'Move', p);
        });
        clip.items = [];
        clip.op = null;
        render();
      }
      function doDelete() {
        if (!state.sel.length) return;
        var names = state.sel.map(function (s) { return s.it.name; }).join(', ');
        W98.dialog.confirm('Confirm Multiple File Delete', 'Are you sure you want to send \'' + names + '\' to the Recycle Bin?')
          .then(function (yes) {
            if (!yes) return;
            state.sel.forEach(function (s) {
              var p = s.it.path;
              if (!p || W98.fs.parent(p) === 'C:\\Recycled') { mutationFailed(W98.fs.remove(p), 'Delete', p); return; }
              var base = p.split('\\').pop();
              if (mutationFailed(W98.fs.rename(p, 'C:\\Recycled\\' + base), 'Delete', p)) return;
              W98.reg.set('HKEY_CURRENT_USER\\Software\\W98\\Recycle', base, p);
            });
            W98.sound.play('Recycle');
            state.sel = [];
            render();
          });
      }
      function renameSel() {
        if (state.sel.length !== 1) return;
        var it = state.sel[0].it;
        W98.dialog.prompt('Rename', 'New name:', it.name).then(function (n) {
          if (!n || n === it.name) return;
          if (mutationFailed(W98.fs.rename(it.path, W98.fs.join(state.path, n)), 'Rename', it.path)) return;
          render();
        });
      }
      function makeShortcut() {
        var it = state.sel[0];
        if (!it) return;
        var target = it.it.path;
        if (mutationFailed(W98.fs.writeText('C:\\WINDOWS\\Desktop\\' + it.it.name.replace(/\.[^.]+$/, '') + ' Shortcut.lnk', 'W98LNK1\npath:' + target), 'Create Shortcut', 'C:\\WINDOWS\\Desktop')) return;
        W98.rebuildDesktopIcons();
        W98.dialog.alert('Shortcut', 'A shortcut to \'' + it.it.name + '\' has been placed on the desktop.', 'info');
      }
      function newFolder() {
        var base = 'New Folder', n = base, i = 2;
        while (W98.fs.exists(W98.fs.join(state.path, n))) n = base + ' (' + (i++) + ')';
        if (mutationFailed(W98.fs.mkdir(W98.fs.join(state.path, n)), 'New Folder', state.path)) return;
        render();
      }
      function newText() {
        var n = 'New Text Document.txt', i = 2;
        while (W98.fs.exists(W98.fs.join(state.path, n))) n = 'New Text Document (' + (i++) + ').txt';
        if (mutationFailed(W98.fs.writeText(W98.fs.join(state.path, n), ''), 'New Text Document', state.path)) return;
        render();
      }
      function showProperties() {
        if (!state.sel.length) {
          var st = W98.stats();
          var media = !state.special && /^[AD]:\\$/i.test(state.path) ? mediaStatus(state.path.charAt(0).toUpperCase()) : null;
          var volume = media
            ? 'Label:\t' + media.label + '\n' + 'Free Space:\t' + Math.round(media.free / 1024) + ' KB\n' +
              'Total Size:\t' + Math.round(media.capacity / 1024) + ' KB\n' + 'Used Space:\t' + Math.round(media.used / 1024) + ' KB\n' +
              'Write protected:\t' + (media.writeProtected ? 'Yes' : 'No') + '\n' + 'Manifest:\tversion ' + media.version + ' (' + (media.manifestId || 'virtual') + ')'
            : state.special === 'computer'
            ? 'Free Space:\t' + Math.round((2 * 1024 * 1024 * 1024 - st.BYTES) / 1024) + ' KB\n' +
              'Total Size:\t2,097,152 KB\n' + 'Files:\t' + st.FILES
            : 'Location:\t' + state.path + '\nFiles:\t' + (W98.fs.list(state.path) || []).length;
          W98.dialog.alert(addrLabel() + ' Properties', 'Type:\tFile Folder\n' + volume +
            '\n\nFilesystem:  kernel.wasm VFS (case-insensitive, FAT-like)', 'info');
          return;
        }
        var it = state.sel[0].it;
        if (it.dir) {
          W98.dialog.alert(it.name + ' Properties', 'Type:\tFile Folder\n' +
            'Location:\t' + W98.fs.parent(it.path) + '\n' +
            'Size:\t' + (W98.fs.list(it.path) || []).length + ' items\n' +
            'Created:\t' + W98.fs.timeString(0), 'info');
        } else {
          var kb = Math.ceil((it.size || 0) / 1024);
          W98.dialog.alert(it.name + ' Properties', 'Type:\t' + it.type + '\n' +
            'Location:\t' + W98.fs.parent(it.path) + '\n' +
            'Size:\t' + (it.size || 0) + ' bytes (' + kb + ' KB)\n' +
            'MS-DOS name:\t' + it.name.slice(0, 8).toUpperCase(), 'info');
        }
      }

      win.on('resize', render);
      var mediaRefresh = function () { if (!win.closed) render(); };
      if (window.addEventListener) window.addEventListener('w98-media-change', mediaRefresh);
      win.on('key', function (e) {
        if (e.key === 'Enter') { openSel(); e.preventDefault(); }
        if (e.key === 'Backspace') { upOne(); e.preventDefault(); }
        if (e.key === 'Delete') { doDelete(); }
      });
      win.on('close', function () { clip.items = []; if (window.removeEventListener) window.removeEventListener('w98-media-change', mediaRefresh); });

      state.history.push({ path: state.path, special: state.special });
      state.hi = 0;
      win.setTitle(args.title || (state.special === 'computer' ? 'My Computer' : (state.special === 'network' ? 'Network Neighborhood' : state.path)));
      win.setIcon(state.special === 'computer' ? 'my-computer' : (state.special === 'network' ? 'network' : 'folder'));
      render();
      return {
        onResize: function () { },
        onClose: function () { }
      };
    }
  });
})();
