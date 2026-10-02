/* ============================================================================
   restore.js — the user-facing System Restore application.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98, I = window.W98Icons, U = W98.util;
  var el = U.el, esc = U.escapeHtml;
  var Snap = window.W98Snapshot;

  function formatTime(s) {
    var d = new Date(s);
    return isNaN(d.getTime()) ? String(s || '') : d.toLocaleString();
  }
  function formatSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function errorText(e) {
    return (e && e.message) || String(e || 'The operation could not be completed.');
  }

  W98.registerApp({
    id: 'restore', title: 'System Restore', icon: 'system',
    width: 650, height: 430, minWidth: 520, minHeight: 320,
    resizable: true, singleton: true, desktop: false, startMenuGroup: null,
    create: function (win) {
      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';
      var intro = el('div', '', 'System Restore can help return your computer to an earlier state. Restore points include your files, registry, desktop settings, and application settings.');
      intro.style.cssText = 'padding:8px 8px 5px;line-height:1.25';
      win.el.appendChild(intro);

      var toolbar = el('div', 'w98-toolbar');
      toolbar.style.gap = '4px';
      var createB = el('button', 'w98-toolbtn', 'Create Restore Point...');
      var restoreB = el('button', 'w98-toolbtn', 'Restore My Computer...');
      var deleteB = el('button', 'w98-toolbtn', 'Delete');
      var exportB = el('button', 'w98-toolbtn', 'Export...');
      var importB = el('button', 'w98-toolbtn', 'Import...');
      [createB, restoreB, deleteB, exportB, importB].forEach(function (b) { b.style.minWidth = '0'; toolbar.appendChild(b); });
      win.el.appendChild(toolbar);

      var list = el('div', 'w98-listbox grow');
      list.style.cssText = 'margin:4px;min-height:80px;overflow:auto';
      win.el.appendChild(list);
      var details = el('div', 'w98-sunken');
      details.style.cssText = 'margin:0 4px 4px;padding:5px;min-height:30px;white-space:pre-wrap';
      details.textContent = 'Select a restore point to see its description.';
      win.el.appendChild(details);
      var fileInput = el('input');
      fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.style.display = 'none';
      win.el.appendChild(fileInput);

      var rows = [], selected = null, busy = false;
      function status(text) { win.setStatus([{ text: text, width: 500 }, { text: (W98.kernelMode() === 'wasm' ? 'WASM kernel' : 'shim mode') }]); }
      function setBusy(v) {
        busy = !!v;
        [createB, restoreB, deleteB, exportB, importB].forEach(function (b) { b.disabled = busy; });
        updateButtons();
      }
      function updateButtons() {
        restoreB.disabled = busy || !selected;
        deleteB.disabled = busy || !selected;
        exportB.disabled = busy || !selected;
        createB.disabled = busy; importB.disabled = busy;
      }
      function render(items) {
        rows = items || []; selected = null; list.innerHTML = '';
        var head = el('div', 'row');
        head.style.cssText = 'position:sticky;top:0;background:#c0c0c0;box-shadow:inset -1px -1px #808080,inset 1px 1px #fff;padding:2px 4px;font-weight:bold';
        [['Name', '30%'], ['Date and time', '25%'], ['Size', '15%'], ['Description', '30%']].forEach(function (c) {
          var h = el('div', '', c[0]); h.style.flex = '0 0 ' + c[1]; head.appendChild(h);
        });
        list.appendChild(head);
        if (!rows.length) {
          var empty = el('div', 'w98-listitem', 'There are no restore points. Click “Create Restore Point...” to make one.');
          empty.style.padding = '8px'; list.appendChild(empty); updateButtons(); return;
        }
        rows.forEach(function (r) {
          var row = el('div', 'w98-listitem');
          row.style.cssText = 'display:flex;align-items:flex-start;gap:4px';
          function cell(t, w) { var c = el('div', '', esc(t)); c.style.cssText = 'flex:0 0 ' + w + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; row.appendChild(c); }
          cell(r.name, '30%'); cell(formatTime(r.createdAt), '25%'); cell(formatSize(r.size), '15%'); cell(r.description || '', '30%');
          row.onclick = function () {
            list.querySelectorAll('.w98-listitem.selected').forEach(function (n) { n.classList.remove('selected'); });
            row.classList.add('selected'); selected = r;
            details.textContent = r.description ? r.description : 'No description was provided for this restore point.';
            updateButtons();
          };
          list.appendChild(row);
        });
        updateButtons();
      }
      function refresh() {
        if (!Snap) { status('System Restore is unavailable.'); return; }
        Snap.list().then(function (items) { render(items); status(items.length + ' restore point(s)'); })
          .catch(function (e) { render([]); status(errorText(e)); W98.dialog.error('System Restore', errorText(e)); });
      }
      function createPoint() {
        W98.dialog.prompt('Create Restore Point', 'Type a name for this restore point:', '', { owner: win }).then(function (name) {
          name = String(name || '').trim(); if (!name) return null;
          return W98.dialog.prompt('Create Restore Point', 'Add an optional description:', '', { owner: win }).then(function (description) {
            setBusy(true); status('Creating restore point...');
            return Snap.create(name, description || '').then(function () {
              W98.sound.play('Tada'); refresh();
            }).catch(function (e) { W98.dialog.error('System Restore', errorText(e)); })
              .then(function () { setBusy(false); });
          });
        });
      }
      function restorePoint() {
        if (!selected) return;
        W98.dialog.confirm('Confirm System Restore', 'Your computer will be restored to “' + selected.name + '”.\n\nOpen applications will close when Windows restarts. Are you sure you want to continue?', { owner: win }).then(function (yes) {
          if (!yes) return;
          setBusy(true); status('Restoring...');
          Snap.restore(selected.id).then(function () {
            W98.dialog.alert('System Restore', 'The restore point was applied. Windows will restart now.', 'info').then(function () {
              if (window.location && typeof window.location.reload === 'function') window.location.reload();
            });
          }).catch(function (e) { setBusy(false); W98.dialog.error('System Restore', errorText(e)); });
        });
      }
      function deletePoint() {
        if (!selected) return;
        W98.dialog.confirm('Confirm Restore Point Deletion', 'Are you sure you want to permanently delete “' + selected.name + '”?', { owner: win }).then(function (yes) {
          if (!yes) return;
          setBusy(true); status('Deleting...');
          Snap.remove(selected.id).then(function () { refresh(); }).catch(function (e) { W98.dialog.error('System Restore', errorText(e)); }).then(function () { setBusy(false); });
        });
      }
      function exportPoint() {
        if (!selected) return;
        setBusy(true); status('Preparing download...');
        Snap.download(selected.id).catch(function (e) { W98.dialog.error('System Restore', errorText(e)); }).then(function () { setBusy(false); status('Ready'); });
      }
      createB.onclick = createPoint; restoreB.onclick = restorePoint; deleteB.onclick = deletePoint; exportB.onclick = exportPoint;
      importB.onclick = function () { fileInput.value = ''; fileInput.click(); };
      fileInput.onchange = function () {
        var file = fileInput.files && fileInput.files[0]; if (!file) return;
        setBusy(true); status('Importing...');
        Snap.import(file).then(function () { W98.sound.play('Tada'); refresh(); }).catch(function (e) { W98.dialog.error('System Restore', errorText(e)); }).then(function () { setBusy(false); });
      };
      win.setMenu([{ label: '&File', items: [
        { label: '&Create Restore Point...', onclick: createPoint }, { label: '&Restore My Computer...', onclick: restorePoint },
        { type: 'sep' }, { label: '&Import...', onclick: function () { fileInput.click(); } }, { label: '&Export...', onclick: exportPoint },
        { type: 'sep' }, { label: '&Close', onclick: function () { win.close(); } }
      ] }, { label: '&Help', items: [{ label: 'Help Topics', onclick: function () { W98.launch('help'); } }] }]);
      status('Loading restore points...'); refresh();
      return {};
    }
  });
})();
