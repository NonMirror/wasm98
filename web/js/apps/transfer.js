/* ============================================================================
 * transfer.js — host/guest file exchange utility.
 *
 * All host access starts with an explicit browser file picker or a user drop.
 * The host-file bridge is preferred when present; the local fallback below uses
 * the same File/Blob APIs and keeps every byte in the guest W98 filesystem.
 * No host paths are ever scanned and no localStorage is used.
 * ========================================================================== */
(function (global) {
  'use strict';
  var W98 = global.W98;
  if (!W98 || typeof W98.registerApp !== 'function') return;
  var U = W98.util || {};
  var el = U.el || function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var esc = U.escapeHtml || function (s) {
    return String(s).replace(/[&<>\"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c];
    });
  };
  function tel(tag, cls, text) { var n = el(tag, cls); if (text != null) n.textContent = String(text); return n; }
  var DEST = 'C:\\My Documents';
  var MAX_IMPORT_FILES = 10000;

  function bridge() {
    return W98.hostFiles || global.W98HostFileBridge || global.hostFileBridge || null;
  }
  function promise(v) { return v && typeof v.then === 'function' ? v : Promise.resolve(v); }
  function bytesOf(v) {
    if (v instanceof Uint8Array) return Promise.resolve(v);
    if (v instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(v));
    if (v && v.buffer instanceof ArrayBuffer && typeof v.byteLength === 'number') {
      return Promise.resolve(new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength));
    }
    if (v && typeof v.arrayBuffer === 'function') return promise(v.arrayBuffer()).then(function (b) { return new Uint8Array(b); });
    if (v && v.bytes != null) return bytesOf(v.bytes);
    if (v && v.data != null) return bytesOf(v.data);
    return Promise.reject(new Error('The selected item has no readable bytes.'));
  }
  function fileName(name) {
    name = String(name || 'Untitled');
    name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '_');
    return name.slice(0, 255) || 'Untitled';
  }
  function relativeName(item) {
    var n = item && (item.relativePath || item.webkitRelativePath || item.path || item.name);
    n = String(n || 'Untitled').replace(/\\/g, '/');
    /* A webkit directory selection has a top-level directory in the relative
       path. Keep that directory out of My Documents, while preserving nested
       folders below it. */
    var seg = n.split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
    if (!seg.length) return 'Untitled';
    if (seg.length > 1 && item && item.webkitRelativePath) seg.shift();
    return seg.map(fileName).join('\\');
  }
  function normDest(path) {
    path = String(path || DEST).replace(/\//g, '\\').replace(/\\+$/, '');
    return /^[A-Za-z]:\\/.test(path) ? path : DEST;
  }
  function pathJoin(dir, name) {
    if (W98.fs && typeof W98.fs.join === 'function') return W98.fs.join(dir, name);
    return String(dir).replace(/\\+$/, '') + '\\' + name;
  }
  function fsErr(e) {
    if (!e) return 'Unknown file system error.';
    var code = e.code || e.name;
    if (code === 'WRITE_PROTECTED' || code === 'EROFS') return 'The disk is write-protected.';
    if (code === 'DISK_FULL' || code === 'ENOSPC') return 'There is not enough space on the disk.';
    if (code === 'EJECTED') return 'The disk is not ready. The media has been ejected.';
    return e.message || String(e);
  }
  function ensureDir(path, fs) {
    var bits = path.split('\\'), cur = bits.shift() + '\\';
    return bits.reduce(function (p, bit) {
      if (!bit) return p;
      cur = pathJoin(cur, bit);
      return p.then(function () {
        if (!fs.exists || !fs.exists(cur)) {
          var r = fs.mkdir(cur);
          if (r != null && Number(r) < 0) throw new Error('Unable to create ' + cur);
        }
      });
    }, Promise.resolve());
  }
  function readHostBytes(item) {
    var b = bridge();
    if (b && typeof b.readFile === 'function') {
      try { return promise(b.readFile(item.file || item)).then(bytesOf); } catch (e) { return Promise.reject(e); }
    }
    return bytesOf(item.file || item);
  }
  function normalise(items) {
    if (!items) return [];
    if (items.files) items = items.files;
    if (typeof items.length === 'number' && !items.name && !items.file) items = Array.prototype.slice.call(items);
    if (!Array.isArray(items)) items = [items];
    return items.filter(Boolean).slice(0, MAX_IMPORT_FILES).map(function (f) {
      var item = f.file ? Object.assign({}, f) : { file: f };
      item.name = item.name || (f && f.name) || 'Untitled';
      item.webkitRelativePath = item.webkitRelativePath || (f && f.webkitRelativePath) || '';
      item.relativePath = item.relativePath || item.webkitRelativePath || (f && f.relativePath) || item.name;
      return item;
    });
  }
  function picker(opts) {
    opts = opts || {};
    var b = bridge();
    if (b && typeof b.pickFiles === 'function') {
      try { return promise(b.pickFiles(opts)).then(normalise); } catch (e) { return Promise.reject(e); }
    }
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = opts.multiple !== false;
      if (opts.directory) {
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
      }
      if (opts.accept) input.accept = opts.accept;
      input.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);
      var done = false;
      function finish(v, err) {
        if (done) return; done = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        if (err) reject(err); else resolve(normalise(v));
      }
      input.addEventListener('change', function () { finish(input.files || []); });
      input.addEventListener('cancel', function () { finish([]); });
      /* click is called synchronously by a button/drop command. Browsers only
         expose host files after this explicit user gesture. */
      try { input.click(); } catch (e) { finish(null, e); }
    });
  }
  function imported(files, destination, fs) {
    files = normalise(files);
    destination = normDest(destination);
    fs = fs || W98.fs;
    if (!fs || typeof fs.writeBytes !== 'function') return Promise.reject(new Error('Guest file system is unavailable.'));
    /* Let the bridge perform the copy when available. It owns the same
       explicit File objects used by the picker and returns a deterministic
       report; the local path below keeps shim mode useful when the bridge is
       unavailable (or when a caller supplies raw bytes). */
    var b = bridge(), source = files.map(function (item) { return item.file || item; });
    if (b && typeof b.importToGuest === 'function' && source.length && source.every(function (x) { return x && (typeof x.arrayBuffer === 'function' || x.data != null || x.bytes != null); })) {
      try {
        return promise(b.importToGuest(source, destination, { fs: fs, directory: source.some(function (x) { return !!x.webkitRelativePath; }) })).then(function (r) {
          r = r || {};
          return bridgeReport(r);
        });
      } catch (e) { return Promise.reject(e); }
    }
    var report = { imported: [], failed: [], bytes: 0 };
    return ensureDir(destination, fs).then(function () {
      return files.reduce(function (chain, item) {
        return chain.then(function () {
          var rel = relativeName(item);
          var parts = rel.split('\\'), name = parts.pop() || 'Untitled';
          var dir = destination;
          parts.forEach(function (part) { dir = pathJoin(dir, part); });
          return ensureDir(dir, fs).then(function () { return readHostBytes(item); }).then(function (data) {
            var path = pathJoin(dir, name), result;
            try { result = fs.writeBytes(path, data); } catch (e) { throw e; }
            if (result != null && Number(result) < 0) {
              var er = new Error(result === -28 ? 'There is not enough space on the disk.' : 'The disk is write-protected.');
              er.code = result === -28 ? 'DISK_FULL' : 'WRITE_PROTECTED';
              throw er;
            }
            report.imported.push({ path: path, name: name, size: data.length });
            report.bytes += data.length;
          }).catch(function (e) {
            report.failed.push({ name: item.name || rel, error: e });
          });
        });
      }, Promise.resolve());
    }).then(function () { return report; });
  }
  function listFiles(paths, fs, prefix, out) {
    out = out || [];
    (paths || []).forEach(function (p) {
      if (!fs.exists(p)) return;
      if (fs.isDir(p)) {
        (fs.list(p) || []).forEach(function (e) { listFiles([pathJoin(p, e.name)], fs, prefix, out); });
      } else out.push({ path: p, name: p.slice((prefix || '').length).replace(/^\\/, '') || p.split('\\').pop() });
    });
    return out;
  }
  function downloadOne(item, fs) {
    var data = fs.readBytes(item.path);
    if (!data) return Promise.reject(new Error('Unable to read ' + item.path));
    var b = bridge();
    if (b && typeof b.download === 'function') {
      try { return promise(b.download(item.name, data, 'application/octet-stream')); } catch (e) { return Promise.reject(e); }
    }
    var blob = new Blob([data], { type: 'application/octet-stream' });
    var url = (global.URL || global.webkitURL).createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fileName(item.name); a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    try { a.click(); } finally {
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); (global.URL || global.webkitURL).revokeObjectURL(url); }, 0);
    }
    return Promise.resolve(true);
  }
  function exported(paths, fs) {
    fs = fs || W98.fs;
    var items = listFiles(paths, fs, DEST, []);
    var b = bridge();
    if (b && typeof b.exportVirtualFiles === 'function') {
      try { return promise(b.exportVirtualFiles(items.map(function (x) { return x.path; }), { fs: fs }, items.map(function (x) { return x.name; }))).then(function () { return items; }); }
      catch (e) { /* fallback below */ }
    }
    return items.reduce(function (p, item) { return p.then(function () { return downloadOne(item, fs); }); }, Promise.resolve()).then(function () { return items; });
  }
  function safeTarget(path) {
    path = normDest(path);
    return /^C:\\MY DOCUMENTS(?:\\|$)/i.test(path);
  }
  function bridgeReport(r) {
    r = r || {};
    return {
      imported: (r.imported || r.files || []).map(function (f) {
        var p = f.path || f.target || f.name || 'Untitled';
        return { path: p, name: String(p).split('\\').pop(), size: Number(f.size) || 0 };
      }),
      failed: r.failed || [], bytes: Number(r.bytes) || 0
    };
  }
  function routeDrop(event, destination, onDone) {
    destination = normDest(destination);
    if (!event || !event.dataTransfer || !safeTarget(destination)) return false;
    var dt = event.dataTransfer;
    if (!dt.files || !dt.files.length) return false;
    event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    imported(dt.files, destination, W98.fs).then(function (r) {
      r = bridgeReport(r);
      if (onDone) onDone(r);
      try { global.dispatchEvent(new CustomEvent('w98-transfer-complete', { detail: r })); } catch (e) { }
    });
    return true;
  }

  /* Public API used by Explorer/the shell and by the media apps. */
  W98.transfer = {
    version: 1,
    destination: DEST,
    pick: picker,
    importFiles: imported,
    importToGuest: imported,
    importFromHost: function (opts) {
      opts = opts || {};
      return picker({ directory: !!opts.directory, multiple: opts.multiple !== false, accept: opts.accept })
        .then(function (files) { return imported(files, opts.destination || DEST, opts.fs || W98.fs); });
    },
    exportFiles: exported,
    exportVirtualFiles: exported,
    routeDrop: routeDrop,
    canRouteDrop: function (path) { return safeTarget(path); },
    installDropTarget: function (node, opts) {
      opts = opts || {};
      if (!node || !node.addEventListener) return function () { };
      var destination = normDest(opts.destination || DEST), b = bridge();
      if (b && typeof b.installDropTarget === 'function') {
        try {
          return b.installDropTarget(node, { fs: W98.fs, destination: destination,
            directory: true,
            canRoute: function (e) { return !!(e && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && safeTarget(destination)); },
            onImported: function (r) { if (opts.onDone) opts.onDone(bridgeReport(r)); },
            onError: function (e) { if (opts.onError) opts.onError(e); }
          });
        } catch (ignore) { /* local listener below remains the shim fallback */ }
      }
      function over(e) { if (e.dataTransfer && e.dataTransfer.types && !safeTarget(destination)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; node.classList.add('w98-transfer-drag'); }
      function leave() { node.classList.remove('w98-transfer-drag'); }
      function drop(e) { leave(); routeDrop(e, destination, opts.onDone); }
      node.addEventListener('dragover', over); node.addEventListener('dragleave', leave); node.addEventListener('drop', drop);
      return function () { node.removeEventListener('dragover', over); node.removeEventListener('dragleave', leave); node.removeEventListener('drop', drop); };
    },
    bridge: bridge
  };

  /* --------------------------------------------------------------- app UI */
  W98.registerApp({
    id: 'transfer', title: 'File Transfer', icon: 'documents', width: 520, height: 360,
    minWidth: 420, minHeight: 280, desktop: false, startMenuGroup: 'Accessories', singleton: true,
    create: function (win, args) {
      args = args || {};
      var destination = normDest(args.destination || DEST), selected = Array.isArray(args.paths) ? args.paths.map(String) : [], status = el('div', 'w98-transfer-status');
      var root = el('div', 'w98-transfer-root');
      var intro = tel('div', 'w98-transfer-intro', 'Move files between this computer and Windows 98. Choose files or a folder when prompted; the host filesystem is never scanned.');
      var buttons = el('div', 'row w98-transfer-buttons');
      var importFilesButton = el('button', 'w98-transfer-button', 'Import Files…');
      var importFolderButton = el('button', 'w98-transfer-button', 'Import Folder…');
      var exportButton = el('button', 'w98-transfer-button', 'Export Selected');
      var refreshButton = el('button', 'w98-transfer-button', 'Refresh');
      buttons.appendChild(importFilesButton); buttons.appendChild(importFolderButton); buttons.appendChild(exportButton); buttons.appendChild(refreshButton);
      var drop = tel('div', 'w98-transfer-drop', 'Drop files here to copy them to ' + destination);
      var list = el('div', 'w98-transfer-list');
      root.appendChild(intro); root.appendChild(buttons); root.appendChild(drop); root.appendChild(list); root.appendChild(status);
      win.el.style.display = 'flex'; win.el.style.flexDirection = 'column'; win.el.style.overflow = 'hidden'; win.el.appendChild(root);
      var cssId = 'w98-transfer-css';
      if (!document.getElementById(cssId)) {
        var st = document.createElement('style'); st.id = cssId;
        st.textContent = '.w98-transfer-root{display:flex;flex:1;flex-direction:column;gap:5px;padding:7px;background:#c0c0c0;font:11px Tahoma,Arial,sans-serif;min-height:0}' +
          '.w98-transfer-intro{line-height:14px;max-width:500px}.w98-transfer-buttons{gap:4px;flex:0 0 auto}.w98-transfer-button{height:23px;padding:1px 8px}' +
          '.w98-transfer-drop{border:1px dashed #555;background:#dfdfdf;text-align:center;padding:9px;color:#404040;flex:0 0 auto}.w98-transfer-drop.w98-transfer-drag{background:#ffffc0;border-color:#000080;color:#000080}' +
          '.w98-transfer-list{background:#fff;border:1px solid #808080;box-shadow:inset 1px 1px #000;overflow:auto;flex:1;min-height:70px;padding:1px}.w98-transfer-row{height:19px;display:flex;align-items:center;gap:4px;padding:0 3px}.w98-transfer-row:hover{background:#e8e8ff}.w98-transfer-row input{margin:0}.w98-transfer-size{margin-left:auto;color:#666}.w98-transfer-status{min-height:16px;white-space:pre;color:#000080}' ;
        (document.head || document.documentElement).appendChild(st);
      }
      function setStatus(s, error) { status.textContent = s; status.style.color = error ? '#800000' : '#000080'; }
      function refresh() {
        var files = W98.fs.list(destination) || [];
        selected = selected.filter(function (p) { return W98.fs.exists(p); });
        list.innerHTML = '';
        var external = selected.filter(function (p) { return p.indexOf(destination + '\\') !== 0; });
        if (external.length) list.appendChild(tel('div', 'w98-transfer-row', 'Selected from Explorer: ' + external.map(function (p) { return p.split('\\').pop(); }).join(', ')));
        if (!files.length) { list.appendChild(tel('div', 'w98-transfer-row', '(folder is empty)')); return; }
        files.forEach(function (it) {
          var row = el('label', 'w98-transfer-row'), cb = document.createElement('input'); cb.type = 'checkbox';
          var p = pathJoin(destination, it.name); cb.checked = selected.indexOf(p) >= 0;
          cb.addEventListener('change', function () { if (cb.checked) selected.push(p); else selected = selected.filter(function (x) { return x !== p; }); });
          row.appendChild(cb); row.appendChild(tel('span', '', it.name)); row.appendChild(tel('span', 'w98-transfer-size', it.dir ? '<DIR>' : String(it.size || 0) + ' bytes')); list.appendChild(row);
        });
      }
      function done(r) {
        var msg = 'Imported ' + r.imported.length + ' file' + (r.imported.length === 1 ? '' : 's') + ' (' + r.bytes + ' bytes).';
        if (r.failed.length) msg += ' ' + r.failed.length + ' item' + (r.failed.length === 1 ? '' : 's') + ' failed: ' + r.failed.map(function (f) { return f.name + ' (' + fsErr(f.error) + ')'; }).join(', ');
        setStatus(msg, !!r.failed.length); refresh();
      }
      importFilesButton.onclick = function () { setStatus('Waiting for a file selection…'); importFromHost(false); };
      importFolderButton.onclick = function () { setStatus('Waiting for a folder selection…'); importFromHost(true); };
      function importFromHost(directory) {
        W98.transfer.importFromHost({ directory: directory, destination: destination }).then(done).catch(function (e) { setStatus(fsErr(e), true); });
      }
      exportButton.onclick = function () {
        if (!selected.length) { setStatus('Select one or more files to export.', true); return; }
        setStatus('Preparing browser download…');
        W98.transfer.exportFiles(selected, W98.fs).then(function (items) { setStatus('Exported ' + items.length + ' file' + (items.length === 1 ? '' : 's') + '.'); }).catch(function (e) { setStatus(fsErr(e), true); });
      };
      refreshButton.onclick = refresh;
      var removeDrop = W98.transfer.installDropTarget(drop, { destination: destination, onDone: done });
      win.setMenu([{ label: '&File', items: [
        { label: '&Import Files…', onclick: importFilesButton.onclick }, { label: 'Import &Folder…', onclick: importFolderButton.onclick },
        { label: '&Export Selected', onclick: exportButton.onclick }, { type: 'sep' }, { label: '&Close', onclick: function () { win.close(); } }
      ] }, { label: '&Help', items: [{ label: '&About File Transfer', onclick: function () { W98.dialog.alert('File Transfer', 'Version 1 media bridge. Host access requires an explicit picker or drop.', 'info'); } }] }]);
      refresh();
      return { onClose: function () { if (removeDrop) removeDrop(); } };
    }
  });
})(window);
