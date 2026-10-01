/* ===========================================================================
 * notepad.js — Notepad (Windows 98 accessory)
 *
 * Classic script (NOT a module).  Registers itself with W98.registerApp().
 * Uses only the documented W98 / win API from CONTRACT.md.
 * =========================================================================*/
(function () {
  'use strict';

  var ID = 'notepad';
  var REG_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Notepad';
  var TIMEDATE_FMT = 0;

  /* ------------------------------------------------------------- styling */
  var CSS = [
    '.np-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
    '  min-width:0;min-height:0;background:#c0c0c0;overflow:hidden}',
    '.np-root,.np-root *{box-sizing:border-box}',
    '.np-editor{flex:1 1 auto;width:100%;min-width:0;min-height:0;margin:0;padding:2px 3px;',
    '  background:#ffffff;color:#000000;resize:none;outline:none;border-radius:0;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000,inset -1px -1px 0 #dfdfdf;overflow:auto;',
    '  font:12px/1.25 "Lucida Console","Fixedsys","Courier New",monospace}',
    '.np-editor.np-nowrap{white-space:pre;overflow-x:auto}',
    '.np-modal{position:absolute;left:0;top:0;right:0;bottom:0;z-index:40;outline:none;',
    '  display:flex;align-items:center;justify-content:center}',
    '.np-dlg{background:#c0c0c0;padding:0;border:1px solid #dfdfdf;border-right-color:#000000;',
    '  border-bottom-color:#000000;box-shadow:1px 1px 0 #000000,inset -1px -1px 0 #808080}',
    '.np-dlgbar{height:18px;line-height:18px;padding:0 2px 0 4px;color:#ffffff;',
    '  background:linear-gradient(90deg,#000080,#1084d0);font:bold 11px Tahoma,"MS Sans Serif",sans-serif;',
    '  display:flex;align-items:center;justify-content:space-between;-webkit-user-select:none;user-select:none}',
    '.np-dlgbar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.np-x{width:16px;height:14px;line-height:12px;text-align:center;color:#000000;background:#c0c0c0;',
    '  border:1px solid #ffffff;border-right-color:#000000;border-bottom-color:#000000;',
    '  font:bold 11px Tahoma,sans-serif;cursor:default;flex:none}',
    '.np-x:active{border-color:#000000 #ffffff #ffffff #000000}',
    '.np-dlgbody{padding:10px 12px 11px}',
    '.np-msg{font:11px Tahoma,"MS Sans Serif",sans-serif;white-space:pre-wrap;margin:0 0 14px;max-width:340px}',
    '.np-btns{display:flex;justify-content:flex-end;gap:6px}',
    '.np-btns button{min-width:74px;font:11px Tahoma,"MS Sans Serif",sans-serif;padding:2px 8px;border-radius:0}',
    '.np-row{display:flex;align-items:center;margin:0 0 8px}',
    '.np-row>label{font:11px Tahoma,sans-serif;margin-right:6px}',
    '.np-field{flex:1 1 auto;min-width:0;font:11px Tahoma,sans-serif;height:18px;padding:1px 3px;',
    '  background:#ffffff;color:#000000;border:1px solid #808080;border-right-color:#ffffff;',
    '  border-bottom-color:#ffffff;box-shadow:inset 1px 1px 0 #000000;outline:none;border-radius:0}',
    '.np-chk,.np-radio{display:flex;align-items:center;font:11px Tahoma,sans-serif}',
    '.np-chk{margin:0 0 8px}',
    '.np-chk input,.np-radio input{margin:0 5px 0 0;flex:none}',
    '.np-group{border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #ffffff;padding:11px 9px 5px;margin:0 0 10px;position:relative}',
    '.np-group>b{position:absolute;top:-7px;left:7px;background:#c0c0c0;padding:0 3px;',
    '  font:11px Tahoma,sans-serif;font-weight:400}',
    '.np-grid2{display:grid;grid-template-columns:auto 52px auto 52px;gap:6px 8px;align-items:center;',
    '  font:11px Tahoma,sans-serif}',
    '.np-grid2 input{width:52px;font:11px Tahoma,sans-serif;padding:1px 3px}',
    '.np-sel{background:#000080;color:#ffffff}',
    '.np-right{text-align:right}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style');
    st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------- helpers */
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }
  /* Render a Win98 label: '&x' underlines the accelerator key (the shell does
     this for menu items, but app-built dialogs have to do it themselves). */
  function accel(el, text) {
    var parts = String(text).split('&');
    el.textContent = '';
    for (var i = 0; i < parts.length; i++) {
      if (i > 0 && parts[i].length) {
        var u = document.createElement('u');
        u.textContent = parts[i].charAt(0);
        el.appendChild(u);
        el.appendChild(document.createTextNode(parts[i].slice(1)));
      } else {
        el.appendChild(document.createTextNode(parts[i]));
      }
    }
    return el;
  }
  function lab(cls, text) {
    return accel(mk('label', cls, ''), text);
  }
  function baseName(p) {
    var a = String(p || '').split(/[\\/]/);
    return a[a.length - 1] || String(p || '');
  }
  function dirName(p) {
    var s = String(p || ''), i = s.lastIndexOf('\\');
    return i > 0 ? s.slice(0, i) : 'C:\\My Documents';
  }
  function nowTick() { try { return W98.tick(); } catch (e) { return Date.now(); } }
  function stamp(d) {
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM', m = d.getMinutes();
    h = h % 12; if (h === 0) { h = 12; }
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap + ' ' +
      (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ================================================================ app ==*/
  W98.registerApp({
    id: ID,
    title: 'Untitled - Notepad',
    icon: 'notepad',
    width: 560,
    height: 360,
    minWidth: 240,
    minHeight: 140,
    resizable: true,
    maximizable: true,
    startMenuGroup: 'Accessories',
    create: create
  });

  function create(win, args) {
    ensureCss();

    win.el.style.display = 'flex';
    win.el.style.overflow = 'hidden';
    var root = mk('div', 'np-root');
    root.style.flex = '1 1 auto';
    win.el.appendChild(root);

    var ta = mk('textarea', 'np-editor');
    ta.spellcheck = false;
    ta.setAttribute('wrap', 'soft');
    ta.setAttribute('aria-label', 'Notepad text');
    root.appendChild(ta);

    var S = {
      path: null, name: 'Untitled', dirty: false, wrap: true,
      undo: [], redo: [], known: null, lastPush: -1e9,
      clip: '', modal: null, closing: false, returnFocus: null,
      find: { dlg: null, input: null, mc: null, dir: 'down', last: '', lastCase: false, dirEls: {} },
      page: { size: 'Letter', landscape: false, left: 0.75, right: 0.75, top: 1.0, bottom: 1.0 }
    };

    /* ------------------------------------------------------- page setup */
    try {
      var raw = W98.reg.get(REG_KEY, 'PageSetup', '');
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          if (o.size) { S.page.size = o.size; }
          S.page.landscape = !!o.landscape;
          if (typeof o.left === 'number') { S.page.left = o.left; }
          if (typeof o.right === 'number') { S.page.right = o.right; }
          if (typeof o.top === 'number') { S.page.top = o.top; }
          if (typeof o.bottom === 'number') { S.page.bottom = o.bottom; }
        }
      }
      var w = W98.reg.get(REG_KEY, 'WordWrap', '1');
      S.wrap = String(w) !== '0';
    } catch (e) { /* registry unavailable — keep defaults */ }
    applyWrap();

    /* --------------------------------------------------------- title bar */
    function setTitle() {
      win.setTitle(S.name + ' - Notepad');
    }
    function markDirty(v) {
      S.dirty = (v === undefined) ? true : !!v;
    }

    /* ------------------------------------------------------------ editor */
    function state() {
      return { text: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
    }
    function apply(st) {
      S.suppress = true;
      ta.value = st.text;
      try { ta.setSelectionRange(st.s, st.e); } catch (e2) { /* ignore */ }
      S.suppress = false;
      S.known = state();
    }
    ta.addEventListener('input', function () {
      if (S.suppress) { return; }
      var t = nowTick();
      if (S.known === null) { S.known = { text: '', s: 0, e: 0 }; }
      if (t - S.lastPush > 700 || S.undo.length === 0) {
        S.undo.push(S.known);
        if (S.undo.length > 200) { S.undo.shift(); }
        S.lastPush = t;
      }
      S.redo.length = 0;
      S.known = state();
      markDirty(true);
    });

    function doUndo() {
      if (!S.undo.length) { return; }
      var cur = state();
      var st = S.undo.pop();
      S.redo.push(cur);
      apply(st);
      markDirty(true);
    }
    function doRedo() {
      if (!S.redo.length) { return; }
      var cur = state();
      var st = S.redo.pop();
      S.undo.push(cur);
      apply(st);
      markDirty(true);
    }

    function applyWrap() {
      if (S.wrap) {
        ta.setAttribute('wrap', 'soft');
        ta.classList.remove('np-nowrap');
      } else {
        ta.setAttribute('wrap', 'off');
        ta.classList.add('np-nowrap');
      }
    }

    /* --------------------------------------------------------- clipboard */
    function setClip(text) {
      S.clip = text == null ? '' : String(text);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var p = navigator.clipboard.writeText(S.clip);
          if (p && p['catch']) { p['catch'](function () { }); }
        }
      } catch (e) { /* clipboard blocked — local buffer still works */ }
    }
    function getClip(cb) {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (t) {
            cb(t == null ? S.clip : t);
          }, function () { cb(S.clip); });
          return;
        }
      } catch (e) { /* fall through */ }
      cb(S.clip);
    }
    function insertText(str) {
      if (!str) { return; }
      var s = ta.selectionStart, e = ta.selectionEnd;
      var before = ta.value.slice(0, s), after = ta.value.slice(e);
      var t = nowTick();
      S.undo.push({ text: ta.value, s: s, e: e });
      if (S.undo.length > 200) { S.undo.shift(); }
      S.lastPush = t;
      ta.value = before + str + after;
      try { ta.setSelectionRange(s + str.length, s + str.length); } catch (e2) { /* ignore */ }
      S.known = state();
      markDirty(true);
      focusEditor();
    }
    function focusEditor() {
      try { ta.focus(); } catch (e) { /* ignore */ }
    }

    function doCopy() {
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (e <= s) { return; }
      setClip(ta.value.slice(s, e));
    }
    function doCut() {
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (e <= s) { return; }
      setClip(ta.value.slice(s, e));
      insertTextInternal('', s, e);
    }
    function insertTextInternal(str, s, e) {
      var before = ta.value.slice(0, s), after = ta.value.slice(e);
      S.undo.push({ text: ta.value, s: s, e: e });
      if (S.undo.length > 200) { S.undo.shift(); }
      S.lastPush = nowTick();
      ta.value = before + str + after;
      try { ta.setSelectionRange(s + str.length, s + str.length); } catch (e2) { /* ignore */ }
      S.known = state();
      markDirty(true);
      focusEditor();
    }
    function doPaste() {
      getClip(function (t) { insertText(t); });
    }
    function doDelete() {
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (e > s) { insertTextInternal('', s, e); return; }
      if (s < ta.value.length) { insertTextInternal('', s, s + 1); }
    }
    function doSelectAll() {
      focusEditor();
      try { ta.setSelectionRange(0, ta.value.length); } catch (e) { /* ignore */ }
    }
    function insertDate() {
      insertText(stamp(new Date()));
    }

    /* ------------------------------------------------------------ modals */
    function closeModal(value) {
      if (!S.modal) { return; }
      var m = S.modal;
      S.modal = null;
      try { m.ov.parentNode.removeChild(m.ov); } catch (e) { /* ignore */ }
      try { if (m.resolve) { m.resolve(value); } } catch (e2) { /* ignore */ }
      if (S.returnFocus) {
        try { S.returnFocus.focus(); } catch (e3) { /* ignore */ }
      }
    }

    function modal(opts) {
      return new Promise(function (resolve) {
        if (S.modal) { closeModal(null); }
        var ov = mk('div', 'np-modal');
        ov.tabIndex = -1;
        var dlg = mk('div', 'np-dlg');
        dlg.setAttribute('role', 'dialog');
        var bar = mk('div', 'np-dlgbar');
        bar.appendChild(mk('span', '', opts.title || 'Notepad'));
        var x = null;
        if (opts.closable) {
          x = mk('div', 'np-x', '\u00D7');
          bar.appendChild(x);
        }
        var body = mk('div', 'np-dlgbody');
        dlg.appendChild(bar);
        dlg.appendChild(body);
        ov.appendChild(dlg);
        root.appendChild(ov);
        if (opts.build) { opts.build(body); }
        var row = mk('div', 'np-btns');
        var def = null;
        (opts.buttons || []).forEach(function (b) {
          var btn = mk('button', b.primary ? 'default' : '', b.label);
          btn.type = 'button';
          btn.addEventListener('click', function () { closeModal(b.value); });
          row.appendChild(btn);
          if (b.primary) { def = btn; }
        });
        body.appendChild(row);

        var r = S.modal = { ov: ov, resolve: resolve, opts: opts };
        function onKey(ev) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            closeModal(opts.escape === undefined ? null : opts.escape);
          } else if (ev.key === 'Enter' && !opts.noEnter &&
                     (ev.target === ov || ev.target === dlg || (ev.target && ev.target.tagName === 'BUTTON'))) {
            ev.preventDefault();
            if (def) { def.click(); }
          }
        }
        ov.addEventListener('keydown', onKey);
        if (x) { x.addEventListener('click', function () { closeModal(opts.escape === undefined ? null : opts.escape); }); }
        try { S.returnFocus = document.activeElement; } catch (e) { S.returnFocus = null; }
        try {
          var first = body.querySelector('input,select,button');
          (def || first || ov).focus();
        } catch (e2) { /* ignore */ }
        r.kill = closeModal;
      });
    }

    /* Yes / No / Cancel, exactly like the Win98 "save changes?" prompt. */
    function askSave(reason) {
      return modal({
        title: 'Notepad',
        escape: 'cancel',
        build: function (b) {
          var p = mk('div', 'np-msg',
            'The text in the ' + S.name + ' file has changed.\n\n' +
            'Do you want to save the changes?');
          b.appendChild(p);
          var note = mk('div', 'np-msg',
            reason === 'close' ? '' : '');
          if (note.textContent) { b.appendChild(note); }
        },
        buttons: [
          { label: 'Yes', value: 'yes', primary: true },
          { label: 'No', value: 'no' },
          { label: 'Cancel', value: 'cancel' }
        ]
      });
    }

    /* ------------------------------------------------------- file verbs */
    function wantOk() {
      // Guard: is it safe to discard the current document?
      if (!S.dirty) { return Promise.resolve(true); }
      if (S.closing) {
        // Window is going away — the shell dialog still works.
        return W98.dialog.confirm('Notepad',
          'The text in the ' + S.name + ' file has changed.\n\nDo you want to save the changes?')
          .then(function (yes) {
            if (!yes) { return true; }
            return saveDocumentAsNeeded().then(function () { return true; });
          }, function () { return true; });
      }
      return askSave().then(function (choice) {
        if (choice === 'cancel' || choice === null) { return false; }
        if (choice === 'no') { return true; }
        return saveDocumentAsNeeded().then(function (ok) { return !!ok; });
      });
    }

    function setDoc(path, text) {
      S.path = path || null;
      S.name = path ? baseName(path) : 'Untitled';
      apply({ text: text == null ? '' : String(text), s: 0, e: 0 });
      S.undo.length = 0;
      S.redo.length = 0;
      markDirty(false);
      setTitle();
      if (path) {
        try { win.saveTo(path); } catch (e) { /* ignore */ }
      }
    }

    function doNew() {
      wantOk().then(function (ok) {
        if (!ok) { return; }
        setDoc(null, '');
        try { win.saveTo(''); } catch (e) { /* ignore */ }
        focusEditor();
      });
    }

    function doOpen() {
      wantOk().then(function (ok) {
        if (!ok) { return; }
        var dir = S.path ? dirName(S.path) : 'C:\\My Documents';
        Promise.resolve(W98.dialog.fileOpen({ path: dir, filter: '*.txt' })).then(function (p) {
          if (!p) { return; }
          var txt = null;
          try { txt = W98.fs.readText(p); } catch (e) { txt = null; }
          if (txt === null) {
            W98.dialog.confirm('Notepad',
              'Cannot find the file ' + p + '.\n\nDo you want to create a new file?')
              .then(function (yes) {
                if (yes) { setDoc(p, ''); markDirty(true); }
              });
            return;
          }
          setDoc(p, txt);
          focusEditor();
        }, function () { /* dialog aborted */ });
      });
    }

    function saveToPath(path) {
      try {
        W98.fs.writeText(path, ta.value);
      } catch (e) {
        W98.dialog.alert('Notepad', 'Cannot create the file ' + path + '.\n\n' +
          'Make sure the path and file name are correct.', 'error');
        return Promise.resolve(false);
      }
      S.path = path;
      S.name = baseName(path);
      markDirty(false);
      setTitle();
      try { win.saveTo(path); } catch (e2) { /* ignore */ }
      return Promise.resolve(true);
    }

    function saveDocumentAsNeeded() {
      if (S.path) { return saveToPath(S.path); }
      return doSaveAs();
    }

    function doSave() {
      if (!S.path) { return doSaveAs(); }
      return saveToPath(S.path);
    }

    function doSaveAs() {
      var dir = S.path ? dirName(S.path) : 'C:\\My Documents';
      var name = S.path ? S.name : 'Untitled.txt';
      return Promise.resolve(W98.dialog.fileSave({ path: dir, name: name, filter: '*.txt' }))
        .then(function (p) {
          if (!p) { return false; }
          return saveToPath(p);
        }, function () { return false; });
    }

    function doExit() {
      wantOk().then(function (ok) {
        if (!ok) { return; }
        S.closing = true;
        win.close();
      });
    }

    /* ------------------------------------------------------- find dialog */
    function openFind() {
      if (S.find.dlg) {
        try { S.find.input.focus(); S.find.input.select(); } catch (e) { /* ignore */ }
        return;
      }
      var ov = mk('div', 'np-modal');
      ov.style.alignItems = 'flex-start';
      ov.style.justifyContent = 'flex-end';
      var dlg = mk('div', 'np-dlg');
      dlg.style.margin = '12px 14px 0 0';
      var bar = mk('div', 'np-dlgbar');
      bar.appendChild(mk('span', '', 'Find'));
      var x = mk('div', 'np-x', '\u00D7');
      bar.appendChild(x);
      var body = mk('div', 'np-dlgbody');
      dlg.appendChild(bar); dlg.appendChild(body);
      ov.appendChild(dlg);
      root.appendChild(ov);

      var row1 = mk('div', 'np-row');
      row1.appendChild(lab('', 'Fi&nd what:'));
      var input = mk('input', 'np-field');
      input.type = 'text';
      input.value = S.find.last;
      row1.appendChild(input);
      body.appendChild(row1);

      var chk = mk('label', 'np-chk');
      var mcb = document.createElement('input');
      mcb.type = 'checkbox';
      mcb.checked = S.find.lastCase;
      chk.appendChild(mcb);
      chk.appendChild(accel(mk('span', '', ''), 'Match &case'));
      body.appendChild(chk);

      var grp = mk('div', 'np-group');
      var legend = mk('b', '', 'Direction');
      grp.appendChild(legend);
      var upId = 'np-up-' + Math.random().toString(36).slice(2);
      var dnId = 'np-dn-' + Math.random().toString(36).slice(2);
      var up = mk('label', 'np-radio');
      var upi = document.createElement('input');
      upi.type = 'radio'; upi.name = 'npdir' + upId; upi.id = upId;
      upi.checked = S.find.dir === 'up';
      up.appendChild(upi);
      up.appendChild(accel(mk('span', '', ''), '&Up'));
      var dn = mk('label', 'np-radio');
      var dni = document.createElement('input');
      dni.type = 'radio'; dni.name = 'npdir' + upId; dni.id = dnId;
      dni.checked = S.find.dir !== 'up';
      dn.appendChild(dni);
      dn.appendChild(accel(mk('span', '', ''), 'Do&wn'));
      grp.appendChild(up);
      grp.appendChild(dn);
      body.appendChild(grp);

      var btns = mk('div', 'np-btns');
      var nextBtn = mk('button', 'default', 'Find Next');
      var cancelBtn = mk('button', '', 'Cancel');
      btns.appendChild(nextBtn);
      btns.appendChild(cancelBtn);
      body.appendChild(btns);

      function close() {
        S.find.dlg = null;
        try { ov.parentNode.removeChild(ov); } catch (e) { /* ignore */ }
        focusEditor();
      }
      function run() {
        S.find.last = input.value;
        S.find.lastCase = mcb.checked;
        S.find.dir = upi.checked ? 'up' : 'down';
        if (!S.find.last) { try { W98.sound.beep(); } catch (e) { } input.focus(); return; }
        findNext();
      }
      nextBtn.addEventListener('click', run);
      cancelBtn.addEventListener('click', close);
      x.addEventListener('click', close);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); run(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      });
      ov.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      });

      S.find.dlg = { ov: ov };
      S.find.input = input;
      S.find.mc = mcb;
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) { } }, 0);
    }

    function findNext() {
      var q = S.find.last;
      if (!q) { openFind(); return; }
      var text = ta.value;
      var hay = S.find.lastCase ? text : text.toLowerCase();
      var needle = S.find.lastCase ? q : q.toLowerCase();
      var idx = -1, wrapped = false;
      if (S.find.dir === 'up') {
        var from = ta.selectionStart;
        idx = from > 0 ? hay.lastIndexOf(needle, from - 1) : -1;
        if (idx < 0) { idx = hay.lastIndexOf(needle); wrapped = true; }
      } else {
        var start = ta.selectionEnd;
        idx = hay.indexOf(needle, start);
        if (idx < 0 && start > 0) { idx = hay.indexOf(needle, 0); wrapped = true; }
      }
      if (idx < 0) {
        try { W98.sound.beep(); } catch (e) { }
        W98.dialog.alert('Notepad', 'Cannot find "' + q + '"', 'info');
        return;
      }
      focusEditor();
      try { ta.setSelectionRange(idx, idx + needle.length); } catch (e2) { /* ignore */ }
      S.find.wrapped = wrapped;
    }

    /* ------------------------------------------------- page setup / print */
    function paperDims(size) {
      switch (size) {
        case 'A4': return { w: 8.27, h: 11.69 };
        case 'A5': return { w: 5.83, h: 8.27 };
        case 'Legal': return { w: 8.5, h: 14 };
        case 'Executive': return { w: 7.25, h: 10.5 };
        case 'Tabloid': return { w: 11, h: 17 };
        case 'B5': return { w: 7.17, h: 10.12 };
        default: return { w: 8.5, h: 11 };
      }
    }

    function pageSetup(done) {
      var local = {};
      return modal({
        title: 'Page Setup',
        escape: null,
        build: function (b) {
          var p = S.page;
          var f1 = mk('div', 'np-row');
          f1.appendChild(lab('', 'Paper Si&ze:'));
          var sel = document.createElement('select');
          ['Letter', 'Legal', 'A4', 'A5', 'B5', 'Executive', 'Tabloid'].forEach(function (n) {
            var o = document.createElement('option');
            o.value = n; o.textContent = n;
            if (n === p.size) { o.selected = true; }
            sel.appendChild(o);
          });
          sel.style.font = '11px Tahoma,sans-serif';
          f1.appendChild(sel);
          b.appendChild(f1);

          var grp = mk('div', 'np-group');
          grp.appendChild(mk('b', '', 'Orientation'));
          var r1 = mk('label', 'np-radio');
          var po = document.createElement('input'); po.type = 'radio'; po.name = 'npori';
          po.checked = !p.landscape;
          r1.appendChild(po); r1.appendChild(accel(mk('span', '', ''), 'Po&rtrait'));
          var r2 = mk('label', 'np-radio');
          var lo = document.createElement('input'); lo.type = 'radio'; lo.name = 'npori';
          lo.checked = !!p.landscape;
          r2.appendChild(lo); r2.appendChild(accel(mk('span', '', ''), '&Landscape'));
          grp.appendChild(r1); grp.appendChild(r2);
          b.appendChild(grp);

          var grp2 = mk('div', 'np-group');
          grp2.appendChild(mk('b', '', 'Margins (inches)'));
          var g = mk('div', 'np-grid2');
          function num(label, val) {
            var l = lab('', label);
            var i = document.createElement('input');
            i.type = 'text';
            i.value = String(val);
            g.appendChild(l); g.appendChild(i);
            return i;
          }
          var iL = num('&Left:', p.left), iR = num('&Right:', p.right),
            iT = num('&Top:', p.top), iB = num('&Bottom:', p.bottom);
          grp2.appendChild(g);
          b.appendChild(grp2);

          var f2 = mk('div', 'np-row');
          var prev = document.createElement('button');
          prev.type = 'button';
          prev.textContent = 'Printer\u2026';
          var dim = mk('span', '', '');
          dim.style.cssText = 'font:11px Tahoma,sans-serif;margin-left:8px;color:#000';
          f2.appendChild(prev); f2.appendChild(dim);
          b.appendChild(f2);

          var self = {
            commit: function () {
              p.size = sel.value;
              p.landscape = lo.checked;
              function f(v, dflt) {
                var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
                return isFinite(n) ? n : dflt;
              }
              p.left = f(iL.value, p.left);
              p.right = f(iR.value, p.right);
              p.top = f(iT.value, p.top);
              p.bottom = f(iB.value, p.bottom);
              try { W98.reg.set(REG_KEY, 'PageSetup', JSON.stringify(p)); } catch (e) { }
            },
            update: function () {
              var d = paperDims(sel.value);
              if (lo.checked) { var t = d.w; d.w = d.h; d.h = t; }
              dim.textContent = d.w.toFixed(2) + '" x ' + d.h.toFixed(2) + '"';
            }
          };
          sel.addEventListener('change', self.update);
          lo.addEventListener('change', self.update);
          po.addEventListener('change', self.update);
          self.update();
          prev.addEventListener('click', function () {
            W98.dialog.alert('Page Setup', 'No printer is currently selected.');
          });
          local.hooks = self;
        },
        buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }]
      }).then(function (v) {
        if (done) { done(v, local.hooks); }
        return v;
      });
    }

    function runPageSetup() {
      pageSetup(function (v, hooks) {
        if (v === 'ok' && hooks) {
          try { hooks.commit(); } catch (e) { /* ignore */ }
        }
      });
    }

    function printJobText() {
      var lines = ta.value.replace(/\r\n/g, '\n').split('\n');
      var dims = paperDims(S.page.size);
      var w = S.page.landscape ? dims.h : dims.w;
      var h = S.page.landscape ? dims.w : dims.h;
      var usableW = Math.max(1, w - S.page.left - S.page.right);
      var usableH = Math.max(1, h - S.page.top - S.page.bottom);
      var cpl = Math.max(10, Math.floor(usableW * 10));   // 10 chars per inch (Fixedsys-ish)
      var cpp = Math.max(5, Math.floor(usableH * 6));     // 6 lines per inch
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (!S.wrap && ln.length > cpl) {
          for (var k = 0; k < ln.length; k += cpl) { out.push(ln.substr(k, cpl)); }
        } else {
          out.push(ln);
        }
      }
      var pages = [];
      for (var p = 0; p < out.length; p += cpp) { pages.push(out.slice(p, p + cpp)); }
      if (!pages.length) { pages = [[]]; }
      return { pages: pages, cpl: cpl, cpp: cpp };
    }

    var printState = null;

    function printDoc() {
      printState = null;
      return modal({
        title: 'Print',
        escape: null,
        build: function (b) {
          var job = printJobText();
          var f1 = mk('div', 'np-row');
          f1.appendChild(lab('', '&Name:'));
          var sel = document.createElement('select');
          ['HP LaserJet 6L', 'Generic / Text Only', 'Microsoft Fax'].forEach(function (n) {
            var o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o);
          });
          sel.style.cssText = 'flex:1 1 auto;font:11px Tahoma,sans-serif';
          f1.appendChild(sel);
          b.appendChild(f1);

          var grp = mk('div', 'np-group');
          grp.appendChild(mk('b', '', 'Print range'));
          var ids = 'np' + Math.random().toString(36).slice(2);
          function rlab(txt, checked, name) {
            var l = mk('label', 'np-radio');
            var i = document.createElement('input');
            i.type = 'radio'; i.name = ids + name;
            i.checked = !!checked;
            l.appendChild(i); l.appendChild(accel(mk('span', '', ''), txt));
            grp.appendChild(l);
            return i;
          }
          var rAll = rlab('&All', true, 'r');
          var rowP = mk('div', 'np-row');
          var rP = document.createElement('input');
          rP.type = 'radio'; rP.name = ids + 'r';
          var lP = mk('label', 'np-radio', '');
          lP.style.margin = '0';
          lP.appendChild(rP);
          lP.appendChild(accel(mk('span', '', ''), 'Pa&ges from'));
          rowP.appendChild(lP);
          var from = document.createElement('input');
          from.type = 'text'; from.value = '1';
          from.style.cssText = 'width:34px;font:11px Tahoma,sans-serif;margin:0 4px';
          rowP.appendChild(from);
          rowP.appendChild(mk('span', '', 'to'));
          var to = document.createElement('input');
          to.type = 'text'; to.value = String(job.pages.length);
          to.style.cssText = 'width:34px;font:11px Tahoma,sans-serif;margin:0 0 0 4px';
          rowP.appendChild(to);
          grp.appendChild(rowP);
          var rSel = rlab('&Selection', false, 'r');
          b.appendChild(grp);

          var f2 = mk('div', 'np-row');
          f2.appendChild(lab('', '&Copies:'));
          var copies = document.createElement('input');
          copies.type = 'text'; copies.value = '1';
          copies.style.cssText = 'width:40px;font:11px Tahoma,sans-serif';
          f2.appendChild(copies);
          var pv = mk('span', '', 'Printable pages: ' + job.pages.length);
          pv.style.cssText = 'font:11px Tahoma,sans-serif;margin-left:10px';
          f2.appendChild(pv);
          b.appendChild(f2);

          printState = {
            job: { pages: job.pages, printer: sel },
            ranges: { all: rAll, pages: rP, sel: rSel, from: from, to: to, copies: copies }
          };
        },
        buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }]
      }).then(function (v) {
        if (v !== 'ok') { return; }
        doSpool();
      });
    }

    function doSpool() {
      if (!printState) { return; }
      var job = printState.job;
      var r = printState.ranges || {};
      var body = [];
      if (r.sel && r.sel.checked) {
        var s = ta.selectionStart, e = ta.selectionEnd;
        body = ta.value.slice(s, e);
      } else if (r.pages && r.pages.checked) {
        var a = parseInt(r.from.value, 10) || 1;
        var b = parseInt(r.to.value, 10) || a;
        for (var i = a - 1; i < b && i < job.pages.length; i++) {
          if (i >= 0) { body.push(job.pages[i]); }
        }
      } else {
        body = job.pages.map(function (pg) { return pg; });
      }
      var printer = job.printer ? job.printer.value : 'Generic / Text Only';
      printViaBrowser(body, printer);
    }

    function printViaBrowser(pages, printer) {
      var html = '';
      var sz = (S.page.landscape ? 'landscape' : 'portrait');
      var pagesArr = Array.isArray(pages[0]) ? pages : [pages];
      html += '<!doctype html><html><head><meta charset="utf-8"><title>' +
        esc(S.name) + '</title><style>' +
        '@page{size:' + sz + ';margin:' + S.page.top + 'in ' + S.page.right + 'in ' +
        S.page.bottom + 'in ' + S.page.left + 'in}' +
        'body{font:12px/1.25 "Lucida Console",monospace;white-space:pre-wrap;margin:0}' +
        '.pg{page-break-after:always}.pg:last-child{page-break-after:auto}' +
        '.hd{font:9px Tahoma,sans-serif;text-align:right;margin-bottom:6px}' +
        '</style></head><body>';
      pagesArr.forEach(function (pg, n) {
        html += '<div class="pg"><div class="hd">' + esc(S.name) + '  Page ' + (n + 1) +
          '</div>' + esc(Array.isArray(pg) ? pg.join('\n') : String(pg)) + '</div>';
      });
      html += '</body></html>';
      var frame = null;
      try {
        frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0';
        document.body.appendChild(frame);
        var d = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (!d) { throw new Error('no doc'); }
        d.open(); d.write(html); d.close();
        var printed = false;
        try {
          if (frame.contentWindow && typeof frame.contentWindow.print === 'function') {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            printed = true;
          }
        } catch (pe) { printed = false; }
        if (!printed) {
          W98.dialog.alert('Notepad', 'The document could not be sent to ' + printer + '.');
        }
      } catch (e) {
        W98.dialog.alert('Notepad', 'The document could not be sent to ' + printer + '.');
      }
      if (frame) {
        setTimeout(function () { try { frame.parentNode.removeChild(frame); } catch (e) { } }, 60000);
      }
    }

    /* --------------------------------------------------------- help/about */
    function helpTopics() {
      W98.dialog.alert('Notepad Help',
        'Notepad Help Topics\n\n' +
        '\u2022 To create a new document, click File, then New.\n' +
        '\u2022 To open a document, click File, then Open.\n' +
        '\u2022 To save a document, click File, then Save.\n' +
        '\u2022 To find text, click Search, then Find.\n' +
        '\u2022 To turn word wrap on or off, click Edit, then Word Wrap.\n\n' +
        'Keyboard: Ctrl+N New, Ctrl+O Open, Ctrl+S Save, Ctrl+Z Undo,\n' +
        'Ctrl+X Cut, Ctrl+C Copy, Ctrl+V Paste, Ctrl+A Select All,\n' +
        'F3 Find Next, F5 Time/Date.', 'info');
    }
    function about() {
      var def = {
        id: ID, title: 'About Notepad', icon: 'notepad',
        name: 'Notepad',
        text: 'Microsoft Windows 98\nVersion 4.10.1998\n\n' +
          'This product is licensed to:\n  A Windows 98 User\n\n' +
          'Physical memory available to Windows: 65,308 KB'
      };
      try {
        if (typeof W98.aboutDialog === 'function') { W98.aboutDialog(def); return; }
      } catch (e) { /* fall through */ }
      W98.dialog.alert('About Notepad', def.text, 'info');
    }

    /* ---------------------------------------------------------- menu bar */
    function menu() {
      win.setMenu([
        {
          label: '&File', items: [
            { label: '&New', accel: 'Ctrl+N', onclick: doNew },
            { label: '&Open\u2026', accel: 'Ctrl+O', onclick: doOpen },
            { label: '&Save', accel: 'Ctrl+S', onclick: function () { doSave(); } },
            { label: 'Save &As\u2026', onclick: function () { doSaveAs(); } },
            { type: 'sep' },
            { label: 'Page Set&up\u2026', onclick: runPageSetup },
            { label: '&Print\u2026', accel: 'Ctrl+P', onclick: function () { printDoc(); } },
            { type: 'sep' },
            { label: 'E&xit', onclick: doExit }
          ]
        },
        {
          label: '&Edit', items: [
            { label: '&Undo', accel: 'Ctrl+Z', onclick: doUndo },
            { type: 'sep' },
            { label: 'Cu&t', accel: 'Ctrl+X', onclick: doCut },
            { label: '&Copy', accel: 'Ctrl+C', onclick: doCopy },
            { label: '&Paste', accel: 'Ctrl+V', onclick: doPaste },
            { label: 'De&lete', accel: 'Del', onclick: doDelete },
            { type: 'sep' },
            { label: 'Select &All', accel: 'Ctrl+A', onclick: doSelectAll },
            { label: 'Time/&Date', accel: 'F5', onclick: insertDate },
            { type: 'sep' },
            { label: '&Word Wrap', type: 'check', checked: S.wrap, onclick: toggleWrap }
          ]
        },
        {
          label: '&Search', items: [
            { label: '&Find\u2026', accel: 'Ctrl+F', onclick: openFind },
            { label: 'Find &Next', accel: 'F3', onclick: findNext }
          ]
        },
        {
          label: '&Help', items: [
            { label: '&Help Topics', onclick: helpTopics },
            { type: 'sep' },
            { label: '&About Notepad', onclick: about }
          ]
        }
      ]);
    }

    function toggleWrap() {
      S.wrap = !S.wrap;
      applyWrap();
      try { W98.reg.set(REG_KEY, 'WordWrap', S.wrap ? '1' : '0'); } catch (e) { }
      menu();
      focusEditor();
    }

    /* ------------------------------------------------------ key handling */
    function onKey(e) {
      var mod = e.ctrlKey || e.metaKey;
      var k = e.key;
      if (mod && !e.altKey) {
        var lk = String(k).toLowerCase();
        if (lk === 'n') { e.preventDefault(); doNew(); return; }
        if (lk === 'o') { e.preventDefault(); doOpen(); return; }
        if (lk === 's') { e.preventDefault(); doSave(); return; }
        if (lk === 'p') { e.preventDefault(); printDoc(); return; }
        if (lk === 'z') { e.preventDefault(); if (e.shiftKey) { doRedo(); } else { doUndo(); } return; }
        if (lk === 'y') { e.preventDefault(); doRedo(); return; }
        if (lk === 'x') { e.preventDefault(); doCut(); return; }
        if (lk === 'c') { e.preventDefault(); doCopy(); return; }
        if (lk === 'v') { e.preventDefault(); doPaste(); return; }
        if (lk === 'a') { e.preventDefault(); doSelectAll(); return; }
        if (lk === 'f') { e.preventDefault(); openFind(); return; }
        if (lk === 'g') { e.preventDefault(); findNext(); return; }
        return;
      }
      if (k === 'F3') { e.preventDefault(); findNext(); return; }
      if (k === 'F5') { e.preventDefault(); insertDate(); return; }
      if (k === 'Escape' && S.find.dlg) {
        e.preventDefault();
        try { S.find.dlg.ov.parentNode.removeChild(S.find.dlg.ov); } catch (e2) { }
        S.find.dlg = null;
        focusEditor();
      }
    }
    win.el.addEventListener('keydown', onKey);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        insertText('\t');
      }
    });

    /* ---------------------------------------------------------- start up */
    menu();
    setDoc(null, '');
    var argPath = null;
    if (typeof args === 'string') { argPath = args; }
    else if (args && typeof args === 'object' && typeof args.path === 'string') { argPath = args.path; }
    if (argPath) {
      var t = null;
      try { t = W98.fs.readText(argPath); } catch (e) { t = null; }
      if (t !== null) { setDoc(argPath, t); }
      else { setDoc(argPath, ''); markDirty(true); }
    }
    setTitle();

    var hook = {
      onClose: function () {
        S.closing = true;
        if (!S.dirty) { return; }
        // The window is already going away: use the shell's own dialog.
        var p = W98.dialog.confirm('Notepad',
          'The text in the ' + S.name + ' file has changed.\n\nDo you want to save the changes?');
        Promise.resolve(p).then(function (yes) {
          if (!yes) { return; }
          if (S.path) {
            try { W98.fs.writeText(S.path, ta.value); } catch (e) { }
          } else {
            Promise.resolve(W98.dialog.fileSave({
              path: 'C:\\My Documents', name: 'Untitled.txt', filter: '*.txt'
            })).then(function (np) {
              if (!np) { return; }
              try { W98.fs.writeText(np, ta.value); } catch (e) { }
            }, function () { });
          }
        }, function () { });
      },
      onResize: function () { /* the editor is flex-sized */ },
      onFocus: function () { }
    };
    return hook;
  }
})();
