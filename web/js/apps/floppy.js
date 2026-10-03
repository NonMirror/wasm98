/* ============================================================================
 * floppy.js — Virtual removable media manager.
 *
 * The medium is deliberately a versioned, in-memory manifest.  Browser File
 * objects enter the guest only after a picker click; no host path is scanned.
 * Files are copied to A:\\ (floppy) or D:\\ (CD-ROM), which means Explorer and
 * DOS Prompt see ordinary guest files.  Eject removes those paths and bumps a
 * generation number so stale references can be detected by callers.
 * ========================================================================== */
(function (global) {
  'use strict';
  var W98 = global.W98;
  if (!W98 || !W98.registerApp) return;

  var el = W98.util.el;
  var ICONS = W98.icons || global.W98Icons || {};
  var VERSION = 1;
  var MANIFEST_KIND = 'w98-host-media';
  var FLOPPY = 'floppy';
  var CDROM = 'cdrom';
  var ROOT = { floppy: 'A:\\', cdrom: 'D:\\' };
  var CAPACITY = { floppy: 1474560, cdrom: 700 * 1024 * 1024 };
  var MAX_FILES = 4096;
  var MAX_FILE_BYTES = 4 * 1024 * 1024;
  var MAX_PATH_CHARS = 259;
  var oldFs = W98.fs;
  var internalWrite = false;
  var listeners = [];
  var state = {
    floppy: null,
    cdrom: null,
    generation: 0,
    lastError: null
  };

  function clone(o) {
    if (!o) return null;
    var out = {};
    Object.keys(o).forEach(function (k) {
      if (k === 'files') out[k] = (o[k] || []).map(function (f) { return Object.assign({}, f); });
      else if (k === 'paths' || k === 'dirs') out[k] = (o[k] || []).slice();
      else out[k] = o[k];
    });
    return out;
  }
  function driveType(type) { return type === CDROM || type === 'D' || type === 'd' ? CDROM : FLOPPY; }
  function rootOf(type) { return ROOT[driveType(type)]; }
  function toBytes(n) {
    n = Number(n);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  function fmtBytes(n) {
    n = toBytes(n);
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  function err(code, message, extra) {
    var e = Object.assign({ code: code, message: message }, extra || {});
    state.lastError = e;
    notify('error', e);
    return e;
  }
  function notify(kind, data) {
    var payload = { kind: kind, state: snapshot(), data: data || null };
    listeners.slice().forEach(function (fn) { try { fn(payload); } catch (e) {} });
    try {
      global.dispatchEvent(new CustomEvent('w98-media-change', { detail: payload }));
    } catch (e2) { /* old browsers may not expose CustomEvent */ }
    if (typeof W98.onMediaChange === 'function') {
      try { W98.onMediaChange(payload); } catch (e3) {}
    }
  }
  function snapshot() {
    return {
      version: VERSION,
      generation: state.generation,
      lastError: state.lastError,
      floppy: clone(state.floppy),
      cdrom: clone(state.cdrom)
    };
  }
  function isDrivePath(p) {
    return /^[ADad]:\\/.test(String(p || '')) || /^[ADad]:$/.test(String(p || ''));
  }
  function mediumForPath(p) {
    var s = String(p || '');
    if (/^A:/i.test(s)) return state.floppy;
    if (/^D:/i.test(s)) return state.cdrom;
    return null;
  }
  function removablePath(p) { return /^A:/i.test(String(p || '')) || /^D:/i.test(String(p || '')); }
  function relativeName(file, index) {
    var raw = '';
    if (file && (file.webkitRelativePath || file.relativePath)) raw = file.webkitRelativePath || file.relativePath;
    if (!raw && file && file.file) raw = file.relativePath || file.file.webkitRelativePath || file.file.name;
    if (!raw && file && file.name) raw = file.name;
    raw = String(raw || ('FILE' + (index + 1) + '.BIN')).replace(/\\/g, '/');
    var parts = raw.split('/');
    /* webkitdirectory prepends the selected directory name; A:\ models its
       contents, so keep that directory itself out of the mounted root. */
    if (file && file.webkitRelativePath && parts.length > 1) parts.shift();
    var clean = [];
    parts.forEach(function (part) {
      part = part.trim();
      if (!part || part === '.' || part === '..' || /^[A-Za-z]:$/.test(part)) return;
      part = part.replace(/[<>:"|?*]/g, '_');
      if (part) clean.push(part.slice(0, 255));
    });
    if (!clean.length) clean.push('UNTITLED.BIN');
    return clean.join('\\');
  }
  function uniqueNames(files) {
    var used = {};
    var ordered = files.slice().sort(function (a, b) {
      var an = relativeName(a, 0).toUpperCase(), bn = relativeName(b, 0).toUpperCase();
      if (an < bn) return -1; if (an > bn) return 1;
      var as = toBytes(a && a.size), bs = toBytes(b && b.size);
      if (as !== bs) return as - bs;
      var at = String(a && a.type || ''), bt = String(b && b.type || '');
      if (at < bt) return -1; if (at > bt) return 1;
      return toBytes(a && a.lastModified) - toBytes(b && b.lastModified);
    });
    var out = ordered.map(function (f, i) {
      var name = relativeName(f, i), base = name, n = 1;
      while (used[name.toUpperCase()]) {
        var slash = base.lastIndexOf('\\');
        var dir = slash < 0 ? '' : base.slice(0, slash + 1);
        var leaf = slash < 0 ? base : base.slice(slash + 1);
        var dot = leaf.lastIndexOf('.');
        var stem = dot > 0 ? leaf.slice(0, dot) : leaf;
        var ext = dot > 0 ? leaf.slice(dot) : '';
        name = dir + stem.slice(0, 240) + '~' + n++ + ext;
      }
      used[name.toUpperCase()] = true;
      return { source: f, path: name, size: toBytes(f && (f.size != null ? f.size : f.file && f.file.size)), name: name.split('\\').pop(), dir: false };
    });
    return out.sort(function (a, b) {
      var aa = a.path.toUpperCase(), bb = b.path.toUpperCase();
      return aa < bb ? -1 : (aa > bb ? 1 : a.size - b.size);
    });
  }
  function manifestId(m) {
    var s = JSON.stringify({ version: m.version, kind: m.kind, type: m.type, root: m.root,
      label: m.label, capacity: m.capacity, writeProtected: !!m.writeProtected,
      files: (m.files || []).map(function (f) { return { path: f.path, size: f.size || 0, sourceName: f.sourceName || '' }; }) });
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'v' + m.version + '-' + ('00000000' + h.toString(16)).slice(-8);
  }
  function parentPath(p) {
    var s = String(p).replace(/\\$/, ''), i = s.lastIndexOf('\\');
    return i <= 2 ? s.slice(0, 3) : s.slice(0, i);
  }
  function ensureDir(path) {
    if (!path || path === rootOf(FLOPPY) || path === rootOf(CDROM)) return;
    if (oldFs.exists(path)) return;
    ensureDir(parentPath(path));
    try { oldFs.mkdir(path); } catch (e) {}
  }
  function removeTree(type) {
    var root = rootOf(type), medium = state[driveType(type)];
    if (!medium) return;
    internalWrite = true;
    try {
      (medium.paths || []).slice().reverse().forEach(function (p) {
        try { oldFs.remove(p); } catch (e) {}
      });
      (medium.dirs || []).slice().reverse().forEach(function (p2) {
        try { oldFs.remove(p2); } catch (e2) {}
      });
      /* A stale path from an earlier session is safe to clear as well. */
      var walk = function (p) {
        var list = oldFs.list(p) || [];
        list.forEach(function (entry) {
          var q = oldFs.join(p, entry.name);
          if (entry.dir) walk(q);
          try { oldFs.remove(q); } catch (e3) {}
        });
      };
      walk(root);
      /* D:\ is created lazily by the manifest. Removing it on eject keeps
         stale CD-ROM paths from looking like an empty mounted drive. A:\ is
         the kernel's built-in floppy root and remains present. */
      if (type === CDROM) { try { oldFs.remove(root); } catch (e4) {} }
    } finally { internalWrite = false; }
  }
  function filesToArray(files) {
    if (!files) return [];
    if (files.files) files = files.files;
    if (typeof files.length === 'number' && typeof files !== 'string') return Array.prototype.slice.call(files);
    return [files];
  }
  function readFileBytes(file) {
    if (file == null) return Promise.resolve(new Uint8Array(0));
    var source = file.file || file;
    var declared = toBytes(file.size != null ? file.size : source && source.size);
    if (declared > MAX_FILE_BYTES) return Promise.reject(err('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.'));
    function checked(bytes) {
      bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (bytes.length > MAX_FILE_BYTES) return Promise.reject(err('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.'));
      return Promise.resolve(bytes);
    }
    function byteLike(v) { return v && typeof v.byteLength === 'number' && v.buffer; }
    if (byteLike(file.data)) return checked(file.data);
    if (byteLike(file.bytes)) return checked(file.bytes);
    if (byteLike(source.data)) return checked(source.data);
    if (byteLike(source.bytes)) return checked(source.bytes);
    if (source.arrayBuffer) return Promise.resolve(source.arrayBuffer()).then(checked);
    if (source.buffer && typeof source.byteLength === 'number') return checked(new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength));
    return Promise.reject(new Error('The selected item is not a browser File.'));
  }
  function insert(type, files, opts) {
    type = driveType(type); opts = opts || {};
    var list = filesToArray(files);
    if (list.length > MAX_FILES) return Promise.reject(err('TRANSFER_LIMIT', 'The selected collection contains too many files.'));
    if (list.some(function (f) { return toBytes(f && (f.size != null ? f.size : f.file && f.file.size)) > MAX_FILE_BYTES; })) {
      return Promise.reject(err('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.'));
    }
    var mediumFiles = uniqueNames(list);
    if (!mediumFiles.length) return Promise.reject(err('NO_MEDIA', 'Please choose at least one file or directory.'));
    if (mediumFiles.some(function (f) { return String(f.path).length > MAX_PATH_CHARS; })) return Promise.reject(err('INVALID_PATH', 'A selected file path is too long for the guest filesystem.'));
    var cap = toBytes(opts.capacity || CAPACITY[type]);
    var total = mediumFiles.reduce(function (n, f) { return n + f.size; }, 0);
    if (total > cap) return Promise.reject(err('DISK_FULL', 'There is not enough space on the disk.', { used: total, capacity: cap }));
    if (state[type]) eject(type);
    var medium = {
      version: VERSION,
      kind: MANIFEST_KIND,
      mediaType: type,
      type: type,
      root: ROOT[type],
      label: String(opts.label || (type === FLOPPY ? 'UNTITLED' : 'W98 CD-ROM')).slice(0, 32),
      capacity: cap,
      used: 0,
      free: cap,
      writeProtected: type === CDROM ? true : opts.writeProtected !== false,
      generation: ++state.generation,
      files: mediumFiles.map(function (f) { return { path: f.path, name: f.name, size: f.size, sourceName: f.source && f.source.name || f.name }; }),
      paths: [], dirs: []
    };
    medium.manifestId = manifestId(medium);
    state[type] = medium;
    var seenDirs = {};
    internalWrite = true;
    var copy = mediumFiles.reduce(function (chain, entry) {
      return chain.then(function () { return readFileBytes(entry.source).then(function (bytes) {
        if (bytes.length > MAX_FILE_BYTES) throw err('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.');
        if (medium.used + bytes.length > medium.capacity) {
          throw err('DISK_FULL', 'There is not enough space on the disk.', { used: medium.used + bytes.length, capacity: medium.capacity });
        }
        var rel = entry.path.split('\\'), cur = ROOT[type];
        for (var i = 0; i < rel.length - 1; i++) {
          cur = oldFs.join(cur, rel[i]);
          if (!seenDirs[cur.toUpperCase()]) { ensureDir(cur); seenDirs[cur.toUpperCase()] = true; medium.dirs.push(cur); }
        }
        var full = oldFs.join(ROOT[type], entry.path);
        var result = oldFs.writeBytes(full, bytes);
        if (result < 0 || (result !== bytes.length && result !== undefined)) throw err('WRITE_FAILED', 'Windows could not write this file to the medium.', { path: full });
        medium.paths.push(full);
        medium.used += bytes.length;
        medium.free = Math.max(0, medium.capacity - medium.used);
      }); });
    }, Promise.resolve());
    return copy.then(function () {
      internalWrite = false;
      state.lastError = null;
      notify('insert', medium);
      return clone(medium);
    }).catch(function (e) {
      internalWrite = false;
      removeTree(type);
      state[type] = null;
      if (!e || !e.code) e = err('READ_FAILED', e && e.message || 'Unable to read the selected files.');
      throw e;
    });
  }
  function eject(type) {
    type = driveType(type);
    if (!state[type]) return false;
    removeTree(type);
    state[type] = null;
    state.generation++;
    state.lastError = null;
    notify('eject', { type: type, generation: state.generation });
    return true;
  }
  function rescanUsed(medium) {
    if (!medium) return 0;
    var total = 0;
    (function walk(p) {
      (oldFs.list(p) || []).forEach(function (e) {
        var q = oldFs.join(p, e.name);
        if (e.dir) walk(q); else total += toBytes(e.size);
      });
    })(medium.root);
    medium.used = total; medium.free = Math.max(0, medium.capacity - total);
    return total;
  }

  /* Route every guest filesystem mutation of removable drives through the
     medium policy.  This keeps Explorer, DOS Prompt, and third-party apps in
     the same write-protection boundary. */
  if (!W98.fs._w98MediaPatched) {
    var write0 = oldFs.writeBytes, text0 = oldFs.writeText, mkdir0 = oldFs.mkdir,
      remove0 = oldFs.remove, rename0 = oldFs.rename;
    function deny(medium, code, message) {
      err(code, message, { drive: medium && medium.root });
      return -1;
    }
    W98.fs.writeBytes = function (p, data) {
      var m = mediumForPath(p);
      if (!removablePath(p) || internalWrite) return write0.call(oldFs, p, data);
      if (!m || !state[m.type]) return deny({ root: /^D:/i.test(String(p || '')) ? 'D:\\' : 'A:\\' }, 'NO_MEDIA', 'Please insert a disk into drive ' + (/^D:/i.test(String(p || '')) ? 'D:' : 'A:') + '.');
      if (m.writeProtected) return deny(m, 'WRITE_PROTECTED', 'The disk in drive ' + m.root.slice(0, 2) + ' is write-protected.');
      var arr = data instanceof Uint8Array ? data : new Uint8Array(data);
      var old = oldFs.stat(p), next = m.used - (old && !old.dir ? toBytes(old.size) : 0) + arr.length;
      if (next > m.capacity) return deny(m, 'DISK_FULL', 'There is not enough space on the disk.');
      var r = write0.call(oldFs, p, arr);
      if (r >= 0) { rescanUsed(m); notify('write', { type: m.type, path: p }); }
      return r;
    };
    W98.fs.writeText = function (p, s) { return W98.fs.writeBytes(p, new TextEncoder().encode(String(s))); };
    W98.fs.mkdir = function (p) {
      var m = mediumForPath(p);
      if (!removablePath(p) || internalWrite) return mkdir0.call(oldFs, p);
      if (!m || !state[m.type]) return deny({ root: /^D:/i.test(String(p || '')) ? 'D:\\' : 'A:\\' }, 'NO_MEDIA', 'Please insert a disk into drive ' + (/^D:/i.test(String(p || '')) ? 'D:' : 'A:') + '.');
      if (m.writeProtected) return deny(m, 'WRITE_PROTECTED', 'The disk in drive ' + m.root.slice(0, 2) + ' is write-protected.');
      var r = mkdir0.call(oldFs, p); if (r >= 0) notify('write', { type: m.type, path: p }); return r;
    };
    W98.fs.remove = function (p) {
      var m = mediumForPath(p);
      if (!removablePath(p) || internalWrite) return remove0.call(oldFs, p);
      if (!m || !state[m.type]) return deny({ root: /^D:/i.test(String(p || '')) ? 'D:\\' : 'A:\\' }, 'NO_MEDIA', 'Please insert a disk into drive ' + (/^D:/i.test(String(p || '')) ? 'D:' : 'A:') + '.');
      if (m.writeProtected) return deny(m, 'WRITE_PROTECTED', 'The disk in drive ' + m.root.slice(0, 2) + ' is write-protected.');
      var r = remove0.call(oldFs, p); if (r >= 0) { rescanUsed(m); notify('write', { type: m.type, path: p }); } return r;
    };
    W98.fs.rename = function (a, b) {
      var ma = mediumForPath(a), mb = mediumForPath(b), m = ma || mb;
      if ((!removablePath(a) && !removablePath(b)) || internalWrite) return rename0.call(oldFs, a, b);
      if (!m || !state[m.type]) return deny({ root: /^D:/i.test(String(a || b || '')) ? 'D:\\' : 'A:\\' }, 'NO_MEDIA', 'Please insert a disk into the removable drive first.');
      if (ma !== mb) return deny(m, 'WRITE_PROTECTED', 'Files cannot be moved across removable media.');
      if (m.writeProtected) return deny(m, 'WRITE_PROTECTED', 'The disk in drive ' + m.root.slice(0, 2) + ' is write-protected.');
      var r = rename0.call(oldFs, a, b); if (r >= 0) notify('write', { type: m.type, path: a }); return r;
    };
    W98.fs._w98MediaPatched = true;
  }

  var media = {
    version: VERSION,
    state: snapshot,
    getState: snapshot,
    insert: insert,
    mount: insert,
    insertFloppy: function (files, opts) { return insert(FLOPPY, files, opts); },
    mountFloppy: function (files, opts) { return insert(FLOPPY, files, opts); },
    insertCdrom: function (files, opts) { return insert(CDROM, files, opts); },
    mountCdrom: function (files, opts) { return insert(CDROM, files, opts); },
    eject: eject,
    ejectDrive: eject,
    ejectFloppy: function () { return eject(FLOPPY); },
    ejectCdrom: function () { return eject(CDROM); },
    isMounted: function (type) { return !!state[driveType(type)]; },
    status: function (type) {
      var m = state[driveType(type)];
      return m ? clone(m) : null;
    },
    list: function (type) { var m = state[driveType(type)]; return m ? (m.files || []).map(function (f) { return Object.assign({}, f); }) : []; },
    read: function (type, path) { var m = state[driveType(type)]; return m && oldFs.readBytes(path); },
    subscribe: function (fn) { if (typeof fn === 'function') listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    formatBytes: fmtBytes,
    lastError: function () { return state.lastError; }
  };
  W98.media = media;
  W98.floppy = media;
  W98.cdrom = media;

  function addLabel(box, text) { var l = el('label'); l.textContent = text; l.style.marginRight = '6px'; return (box.appendChild(l), l); }
  function option(value, text) { var o = el('option'); o.value = value; o.textContent = text; return o; }
  function openInsertDialog(type, owner, onDone) {
    type = driveType(type);
    var isCd = type === CDROM;
    var dlg = W98.dialog.custom({ title: isCd ? 'Insert CD-ROM' : 'Insert Floppy', width: 430, height: 300, owner: owner, icon: isCd ? 'cdrom' : 'floppy-3-5' });
    var box = dlg.box; box.style.padding = '10px'; box.style.gap = '6px';
    var note = el('div', '', 'Choose files or a directory from this computer. The browser will not scan anything until you click a picker button.');
    note.style.lineHeight = '14px'; note.style.marginBottom = '8px'; box.appendChild(note);
    var chosen = el('div', 'w98-field', 'No files selected'); chosen.style.padding = '4px'; chosen.style.minHeight = '21px'; box.appendChild(chosen);
    var fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    var dirInput = el('input'); dirInput.type = 'file'; dirInput.multiple = true; dirInput.style.display = 'none';
    try { dirInput.webkitdirectory = true; dirInput.directory = true; } catch (e) {}
    box.appendChild(fileInput); box.appendChild(dirInput);
    var pickRow = el('div', 'row'); pickRow.style.gap = '6px';
    var pickFiles = el('button', '', 'Select Files...'), pickDir = el('button', '', 'Select Folder...');
    pickRow.appendChild(pickFiles); pickRow.appendChild(pickDir); box.appendChild(pickRow);
    var labelRow = el('div', 'row'); addLabel(labelRow, 'Label:'); var label = el('input'); label.type = 'text'; label.value = isCd ? 'W98 CD-ROM' : 'UNTITLED'; label.maxLength = 32; label.style.flex = '1'; labelRow.appendChild(label); box.appendChild(labelRow);
    var capRow = el('div', 'row'); addLabel(capRow, 'Capacity:'); var cap = el('select'); cap.style.flex = '1';
    if (isCd) cap.appendChild(option(String(CAPACITY.cdrom), '700 MB (data CD)'));
    else { cap.appendChild(option('368640', '360 KB')); cap.appendChild(option('737280', '720 KB')); cap.appendChild(option('1474560', '1.44 MB')); cap.value = String(CAPACITY.floppy); }
    capRow.appendChild(cap); box.appendChild(capRow);
    var wpRow = el('label', 'row'); var wp = el('input'); wp.type = 'checkbox'; wp.checked = true; wp.disabled = isCd; wpRow.appendChild(wp); wpRow.appendChild(document.createTextNode('Write-protected (read-only)')); box.appendChild(wpRow);
    var btns = el('div', 'dlg-buttons'); btns.style.marginTop = '8px'; var ok = el('button', 'default', 'Insert'); var cancel = el('button', '', 'Cancel'); btns.appendChild(ok); btns.appendChild(cancel); box.appendChild(btns);
    var files = [];
    function setFiles(ev) { files = filesToArray(ev.target.files); var total = files.reduce(function (n, f) { return n + toBytes(f.size); }, 0); chosen.textContent = files.length + ' file' + (files.length === 1 ? '' : 's') + ' selected (' + fmtBytes(total) + ')'; }
    pickFiles.onclick = function () { fileInput.click(); }; pickDir.onclick = function () { dirInput.click(); }; fileInput.onchange = setFiles; dirInput.onchange = setFiles;
    cancel.onclick = function () { dlg.close(); };
    ok.onclick = function () {
      if (!files.length) { W98.dialog.alert(isCd ? 'Insert CD-ROM' : 'Insert Floppy', 'Please select files or a directory first.', 'warn'); return; }
      ok.disabled = true; cancel.disabled = true;
      insert(type, files, { label: label.value, capacity: Number(cap.value), writeProtected: wp.checked }).then(function () { dlg.close(); if (onDone) onDone(); }, function (e) { ok.disabled = false; cancel.disabled = false; W98.dialog.alert(isCd ? 'Insert CD-ROM' : 'Insert Floppy', e.message || 'Unable to mount the selected media.', e.code === 'WRITE_PROTECTED' ? 'warn' : 'error'); });
    };
    return dlg;
  }
  function statusCard(type) {
    var m = state[type], card = el('div', 'w98-groupbox'); card.style.padding = '8px'; card.style.marginBottom = '8px';
    var title = type === FLOPPY ? '3½ Floppy Drive (A:)' : 'CD-ROM Drive (D:)'; card.appendChild(el('b', '', title));
    if (!m) { card.appendChild(el('div', '', 'No media inserted.')); return card; }
    card.appendChild(el('div', '', 'Label: ' + m.label));
    card.appendChild(el('div', '', 'Manifest: version ' + m.version + ' (' + (m.manifestId || 'virtual') + ') | ' + (m.writeProtected ? 'Read-only' : 'Read/write')));
    card.appendChild(el('div', '', 'Capacity: ' + fmtBytes(m.capacity) + '    Used: ' + fmtBytes(m.used) + '    Free: ' + fmtBytes(m.free)));
    var bar = el('div'); bar.style.cssText = 'height:10px;background:#fff;border:1px solid #808080;margin-top:5px'; var fill = el('div'); fill.style.height = '100%'; fill.style.background = '#000080'; fill.style.width = (m.capacity ? Math.min(100, m.used * 100 / m.capacity) : 0) + '%'; bar.appendChild(fill); card.appendChild(bar);
    var e = el('div', '', (m.files || []).length + ' file(s) visible to Explorer and MS-DOS Prompt.'); e.style.marginTop = '4px'; card.appendChild(e); return card;
  }

  W98.registerApp({
    id: 'floppy', title: 'Virtual Media', icon: 'floppy-3-5', width: 470, height: 360,
    minWidth: 360, minHeight: 260, resizable: true, desktop: false, startMenuGroup: 'System Tools',
    create: function (win) {
      win.el.style.display = 'flex'; win.el.style.flexDirection = 'column';
      var toolbar = el('div', 'w98-toolbar'); var ins = el('button', 'w98-toolbtn', 'Insert Floppy...'); var cd = el('button', 'w98-toolbtn', 'Insert CD-ROM...'); var ej = el('button', 'w98-toolbtn', 'Eject'); toolbar.appendChild(ins); toolbar.appendChild(cd); toolbar.appendChild(ej); win.el.appendChild(toolbar);
      var body = el('div', 'col'); body.style.padding = '8px'; body.style.overflow = 'auto'; body.style.background = '#c0c0c0'; win.el.appendChild(body);
      var intro = el('div', '', 'Virtual media uses a deterministic manifest (version ' + VERSION + '). Selected browser files are copied into the guest filesystem.'); intro.style.marginBottom = '8px'; body.appendChild(intro);
      var cards = el('div'); body.appendChild(cards); var status = el('div', 'w98-statusbar'); status.style.marginTop = 'auto'; win.el.appendChild(status);
      function render() { cards.innerHTML = ''; cards.appendChild(statusCard(FLOPPY)); cards.appendChild(statusCard(CDROM)); var m = state.lastError; status.textContent = m ? m.code + ': ' + m.message : 'Ready'; ej.disabled = !state.floppy && !state.cdrom; }
      function done() { render(); }
      ins.onclick = function () { openInsertDialog(FLOPPY, win, done); }; cd.onclick = function () { openInsertDialog(CDROM, win, done); }; ej.onclick = function () { if (state.floppy) eject(FLOPPY); else if (state.cdrom) eject(CDROM); render(); };
      win.setMenu([{ label: '&Media', items: [{ label: 'Insert &Floppy...', onclick: ins.onclick }, { label: 'Insert &CD-ROM...', onclick: cd.onclick }, { label: '&Eject', onclick: ej.onclick }] }, { label: '&View', items: [{ label: '&Refresh', onclick: render }] }, { label: '&Help', items: [{ label: 'About Virtual Media', onclick: function () { W98.dialog.alert('Virtual Media', 'Manifest version ' + VERSION + '.\nThe browser only grants access to files you choose.', 'info'); } }] }]);
      var off = media.subscribe(render); render();
      return { onClose: function () { off(); } };
    }
  });
})(window);
