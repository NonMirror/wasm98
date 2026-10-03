/* ============================================================================
   host-file-bridge.js — explicit host file exchange and virtual media
   ----------------------------------------------------------------------------
   The bridge is deliberately small and local.  It never walks a host path and
   it never asks the browser for a file until the caller invokes pickFiles() or
   one of the mountFromPicker helpers from a user gesture.  A mounted medium is
   a deterministic, versioned manifest over File objects; it is not a raw FAT
   image and is therefore not persisted or silently re-opened on a later boot.

   The public object is available as window.W98HostFileBridge and, when the
   shell has already loaded, W98.hostFiles.  The latter assignment is repeated
   when the shell-ready event is observed so script order does not matter.
   ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = 1;
  var MANIFEST_KIND = 'w98-host-media';
  var DEFAULT_FLOPPY_CAPACITY = 1440 * 1024;       /* 1.44 MB */
  var DEFAULT_CDROM_CAPACITY = 700 * 1024 * 1024;  /* 700 MB */
  /* Keep host reads within the kernel's documented filesystem bounds.  These
     are also a guard against a malformed File-like object claiming an
     unbounded size before arrayBuffer() is called. */
  var MAX_FILES = 4096;
  var MAX_FILE_BYTES = 4 * 1024 * 1024;
  var MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
  var MAX_PATH_CHARS = 259;
  var PERSIST_DB = 'w98-host-exchange';
  var PERSIST_STORE = 'guest-files';
  var persistenceStarted = false;
  var textDecoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  var textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  var mediaSerial = 0;
  var activeMedia = Object.create(null);
  var API = null;

  function BridgeError(code, message, path) {
    this.name = 'HostFileBridgeError';
    this.code = code;
    this.path = path || '';
    this.message = message || code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BridgeError);
  }
  BridgeError.prototype = Object.create(Error.prototype);
  BridgeError.prototype.constructor = BridgeError;

  function error(code, message, path) {
    var e = new BridgeError(code, message, path);
    if (API) API.lastError = e;
    return e;
  }

  /* DOS paths are case-insensitive.  We retain the display spelling in the
     manifest but use this canonical form for all lookups. */
  function normPath(path, root) {
    var p = path == null ? '' : String(path);
    p = p.replace(/[\/]+/g, '\\');
    var hasDrive = /^[A-Za-z]:/.test(p);
    if (!hasDrive) p = (root || 'A:\\') + p;
    p = p.replace(/[\\]+/g, '\\');
    var m = p.match(/^([A-Za-z]):(?:\\(.*))?$/);
    if (!m) throw error('INVALID_PATH', 'The path is not a Windows path.', p);
    var drive = m[1].toUpperCase();
    var parts = (m[2] || '').split('\\');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') { if (out.length) out.pop(); continue; }
      /* A colon, NUL, and control characters cannot be represented by FAT. */
      part = part.replace(/[\u0000-\u001f:*?"<>|]/g, '_');
      if (part) out.push(part);
    }
    return drive + ':\\' + out.join('\\');
  }

  function rootPath(drive) { return (String(drive || 'A').charAt(0).toUpperCase()) + ':\\'; }
  function pathKey(path) { return normPath(path).toUpperCase(); }
  function relativePath(path, root) {
    var p = normPath(path, root), r = normPath(root || 'A:\\');
    if (p.toUpperCase() === r.toUpperCase()) return '';
    return p.slice(r.length);
  }
  function joinPath(base, child) {
    var b = normPath(base || 'C:\\');
    if (!child) return b;
    return normPath(b + '\\' + String(child).replace(/^[/\\]+/, ''));
  }
  function cloneBytes(data) {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength));
    if (typeof data === 'string') return textEncoder ? textEncoder.encode(data) : new Uint8Array(data.split('').map(function (c) { return c.charCodeAt(0) & 255; }));
    return new Uint8Array(0);
  }
  function fileName(file) {
    return String(file && (file.name || file.path || 'Untitled')).replace(/^.*[\\/]/, '') || 'Untitled';
  }
  function fileRelativeName(file, directory) {
    var rel = file && file.webkitRelativePath ? String(file.webkitRelativePath) : fileName(file);
    rel = rel.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
    var seg = rel.split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
    /* webkitdirectory includes the selected folder as its first component;
       users expect that folder's contents directly below A:\. */
    if (directory && seg.length > 1) seg.shift();
    return seg.join('\\') || fileName(file);
  }
  function sortRecords(a, b) {
    var aa = String(a.path).toUpperCase(), bb = String(b.path).toUpperCase();
    if (aa < bb) return -1;
    if (aa > bb) return 1;
    if ((a.size || 0) !== (b.size || 0)) return (a.size || 0) - (b.size || 0);
    return String(a.type || '').localeCompare(String(b.type || ''));
  }
  function fnv1a(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function asArray(files) {
    if (!files) return [];
    if (Array.isArray(files)) return files.slice();
    if (typeof files.length === 'number') return Array.prototype.slice.call(files);
    return [files];
  }
  function canonicalManifest(meta) {
    return JSON.stringify({ version: VERSION, kind: MANIFEST_KIND, mediaType: meta.mediaType,
      root: meta.root, label: meta.label, capacity: meta.capacity,
      writeProtected: !!meta.writeProtected,
      files: meta.files.map(function (f) { return { path: f.path, size: f.size || 0,
        lastModified: f.lastModified || 0, type: f.type || '' }; }) });
  }

  function makeManifest(files, options) {
    options = options || {};
    var mediaType = String(options.mediaType || options.kind || 'floppy').toLowerCase() === 'cdrom' ? 'cdrom' : 'floppy';
    var drive = String(options.drive || (mediaType === 'cdrom' ? 'D' : 'A')).charAt(0).toUpperCase();
    var root = rootPath(drive);
    var directory = !!options.directory;
    var source = asArray(files).filter(function (f) { return f && (typeof f === 'object'); });
    /* Stable source order makes duplicate DOS names deterministic even when a
       browser returns a FileList in a different order. */
    source.sort(function (a, b) {
      var ap = fileRelativeName(a, directory).toUpperCase(), bp = fileRelativeName(b, directory).toUpperCase();
      if (ap < bp) return -1; if (ap > bp) return 1;
      var as = Number(a.size) || 0, bs = Number(b.size) || 0;
      if (as !== bs) return as - bs;
      var at = String(a.type || ''), bt = String(b.type || '');
      if (at < bt) return -1; if (at > bt) return 1;
      return (Number(a.lastModified) || 0) - (Number(b.lastModified) || 0);
    });
    var seen = Object.create(null), records = [];
    source.forEach(function (f) {
      var rel = fileRelativeName(f, directory);
      var path = normPath(root + rel);
      var key = path.toUpperCase();
      var size = Number(f.size);
      if (!isFinite(size) || size < 0) size = f.data ? cloneBytes(f.data).length : 0;
      var rec = { path: path, name: rel.split('\\').pop() || fileName(f), relativePath: rel,
        size: size, lastModified: Number(f.lastModified) || 0, type: String(f.type || ''), file: f };
      if (seen[key]) {
        /* Duplicate relative names can occur when a user selects overlapping
           collections. Choose by metadata, so input order cannot change the
           manifest or its id. */
        var oldSig = String(seen[key].size) + '|' + String(seen[key].lastModified) + '|' + seen[key].type;
        var newSig = String(rec.size) + '|' + String(rec.lastModified) + '|' + rec.type;
        if (newSig < oldSig) {
          var oldIndex = records.indexOf(seen[key]);
          if (oldIndex >= 0) records[oldIndex] = rec;
          seen[key] = rec;
        }
        return;
      }
      seen[key] = rec; records.push(rec);
    });
    records.sort(sortRecords);
    var capacity = Number(options.capacity);
    if (!isFinite(capacity) || capacity < 0) capacity = mediaType === 'cdrom' ? DEFAULT_CDROM_CAPACITY : DEFAULT_FLOPPY_CAPACITY;
    var meta = { version: VERSION, kind: MANIFEST_KIND, mediaType: mediaType, root: root,
      label: String(options.label || (mediaType === 'cdrom' ? 'W98 CD-ROM' : 'W98 FLOPPY')).slice(0, 32),
      capacity: Math.floor(capacity), writeProtected: mediaType === 'cdrom' ? true : options.writeProtected !== false,
      files: records.map(function (r) { return { path: r.path, name: r.name, relativePath: r.relativePath,
        size: r.size, lastModified: r.lastModified, type: r.type }; }) };
    meta.used = records.reduce(function (n, r) { return n + (r.size || 0); }, 0);
    meta.free = Math.max(0, meta.capacity - meta.used);
    meta.manifestId = 'v' + VERSION + '-' + fnv1a(canonicalManifest(meta));
    return { meta: meta, records: records };
  }

  function readHostFile(rec) {
    var f = rec.file || rec;
    var declared = Number(f && f.size);
    if (isFinite(declared) && declared > MAX_FILE_BYTES) return Promise.reject(error('FILE_TOO_LARGE', 'The selected file exceeds the 4 MiB Windows 98 file limit.', rec.path));
    function checked(bytes) {
      bytes = cloneBytes(bytes);
      if (bytes.length > MAX_FILE_BYTES) return Promise.reject(error('FILE_TOO_LARGE', 'The selected file exceeds the 4 MiB Windows 98 file limit.', rec.path));
      return Promise.resolve(bytes);
    }
    if (rec.data != null) return checked(rec.data);
    if (f && typeof f.arrayBuffer === 'function') return Promise.resolve(f.arrayBuffer()).then(checked);
    if (f && f.data != null) return checked(f.data);
    return Promise.reject(error('UNREADABLE', 'The selected host file cannot be read.', rec.path));
  }

  function Media(prepared, options) {
    options = options || {};
    var meta = prepared.meta;
    var records = Object.create(null);
    var ordered = [];
    prepared.records.forEach(function (r) {
      var k = pathKey(r.path);
      records[k] = r; ordered.push(r);
    });
    var mounted = true;
    var listeners = [];
    var writable = !meta.writeProtected && options.mutable !== false;
    function ensure() { if (!mounted) throw error('EJECTED', 'The media in drive ' + meta.root.slice(0, 2) + ' has been ejected.'); }
    function inRoot(path) { return pathKey(path).slice(0, 2) === pathKey(meta.root).slice(0, 2); }
    function resolve(path) {
      ensure();
      var p = normPath(path, meta.root), k = pathKey(p);
      if (!inRoot(p)) throw error('INVALID_PATH', 'The path is outside the mounted medium.', p);
      if (k === pathKey(meta.root)) return { path: meta.root, dir: true };
      var r = records[k];
      if (r) return r;
      var pre = k.replace(/\\$/, '') + '\\';
      var has = ordered.some(function (x) { return pathKey(x.path).indexOf(pre) === 0; });
      if (has) return { path: p, dir: true };
      throw error('NOT_FOUND', 'File not found: ' + p, p);
    }
    function children(path) {
      var d = resolve(path);
      if (!d.dir) throw error('NOT_A_DIRECTORY', 'The path is not a directory.', d.path);
      var pkey = pathKey(d.path), pre = pkey.replace(/\\$/, '') + '\\', map = Object.create(null);
      ordered.forEach(function (r) {
        var rk = pathKey(r.path);
        if (rk.indexOf(pre) !== 0) return;
        var rest = rk.slice(pre.length), ix = rest.indexOf('\\');
        var name = ix < 0 ? r.name : rest.slice(0, ix);
        var childPath = normPath(d.path + '\\' + name), ck = pathKey(childPath);
        if (!map[ck]) map[ck] = { name: name, path: childPath, dir: ix >= 0, size: ix >= 0 ? 0 : r.size, mtime: r.lastModified || 0 };
      });
      return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.name.toUpperCase() < b.name.toUpperCase() ? -1 : (a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0);
      });
    }
    function emit(type) { listeners.slice().forEach(function (fn) { try { fn(type, media); } catch (e) {} }); }
    var media = {
      version: VERSION, type: meta.mediaType, mediaType: meta.mediaType, drive: meta.root.slice(0, 2), root: meta.root,
      label: meta.label, capacity: meta.capacity, writeProtected: !!meta.writeProtected,
      manifest: meta, manifestId: meta.manifestId,
      get mounted() { return mounted; },
      onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      status: function () {
        ensure();
        var used = ordered.reduce(function (n, r) { return n + (r.size || 0); }, 0);
        return { version: VERSION, label: meta.label, drive: meta.root.slice(0, 2), mediaType: meta.mediaType,
          writeProtected: !!meta.writeProtected, used: used, free: Math.max(0, meta.capacity - used), capacity: meta.capacity,
          usedBytes: used, freeBytes: Math.max(0, meta.capacity - used), capacityBytes: meta.capacity, fileCount: ordered.length,
          manifestId: meta.manifestId };
      },
      exists: function (path) { try { resolve(path); return true; } catch (e) { if (e.code === 'NOT_FOUND') return false; throw e; } },
      isDir: function (path) { return !!resolve(path).dir; },
      stat: function (path) { var x = resolve(path); return { name: x.name || meta.label, path: x.path, dir: !!x.dir, size: x.size || 0, mtime: x.lastModified || 0 }; },
      list: function (path) { return children(path || meta.root); },
      read: function (path) {
        var x = resolve(path);
        if (x.dir) return Promise.reject(error('IS_DIRECTORY', 'Cannot read a directory.', x.path));
        return readHostFile(x).then(function (bytes) { if (!mounted) throw error('EJECTED', 'The medium was ejected while reading.', x.path); return bytes; });
      },
      readBytes: function (path) { return this.read(path); },
      readText: function (path) { return this.read(path).then(function (b) { return textDecoder ? textDecoder.decode(b) : String.fromCharCode.apply(null, b); }); },
      write: function (path, data) {
        ensure();
        if (!writable || meta.writeProtected) return Promise.reject(error('WRITE_PROTECTED', 'The disk is write-protected.', path));
        var declared = Number(data && data.byteLength != null ? data.byteLength : data && data.length);
        if (isFinite(declared) && declared > MAX_FILE_BYTES) return Promise.reject(error('FILE_TOO_LARGE', 'The file exceeds the 4 MiB Windows 98 file limit.', path));
        var p = normPath(path, meta.root);
        if (!inRoot(p)) return Promise.reject(error('INVALID_PATH', 'The path is outside the mounted medium.', p));
        var bytes = cloneBytes(data);
        if (bytes.length > MAX_FILE_BYTES) return Promise.reject(error('FILE_TOO_LARGE', 'The file exceeds the 4 MiB Windows 98 file limit.', p));
        var old = records[pathKey(p)], oldSize = old ? (old.size || 0) : 0;
        var used = ordered.reduce(function (n, r) { return n + (r.size || 0); }, 0) - oldSize + bytes.length;
        if (used > meta.capacity) return Promise.reject(error('DISK_FULL', 'There is not enough space on the disk.', p));
        var r = old || { path: p, name: p.split('\\').pop(), relativePath: relativePath(p, meta.root), lastModified: Date.now(), type: '', file: null };
        r.data = bytes; r.size = bytes.length; if (!old) { records[pathKey(p)] = r; ordered.push(r); ordered.sort(sortRecords); }
        meta.used = used; meta.free = Math.max(0, meta.capacity - used); emit('write');
        return Promise.resolve(bytes.length);
      },
      eject: function () {
        if (!mounted) return false;
        mounted = false; ordered.length = 0; records = Object.create(null); listeners.slice().forEach(function (fn) { try { fn('eject', media); } catch (e) {} }); listeners.length = 0;
        var mediaDriveKey = meta.root.slice(0, 1).toUpperCase();
        if (activeMedia[mediaDriveKey] === media) delete activeMedia[mediaDriveKey];
        return true;
      },
      close: function () { return this.eject(); },
      toJSON: function () { return JSON.parse(JSON.stringify(meta)); }
    };
    return media;
  }

  function picker(options) {
    options = options || {};
    if (!global.document || !global.document.createElement) return Promise.reject(error('PICKER_UNAVAILABLE', 'A browser file picker is unavailable.'));
    return new Promise(function (resolve, reject) {
      var input = global.document.createElement('input');
      input.type = 'file'; input.multiple = options.multiple !== false;
      if (options.accept) input.accept = String(options.accept);
      if (options.directory) { input.setAttribute('webkitdirectory', ''); input.setAttribute('directory', ''); }
      input.style.position = 'fixed'; input.style.left = '-10000px';
      var done = false;
      function finish(fn, value) { if (done) return; done = true; if (input.parentNode) input.parentNode.removeChild(input); fn(value); }
      input.onchange = function () { finish(resolve, Array.prototype.slice.call(input.files || [])); };
      input.oncancel = function () { finish(resolve, []); };
      input.onerror = function () { finish(reject, error('PICKER_FAILED', 'The browser could not open the file picker.')); };
      (global.document.body || global.document.documentElement).appendChild(input);
      /* click() is the sole point at which this module invokes a host file API. */
      try { input.click(); } catch (e) { finish(reject, error('PICKER_FAILED', e.message || 'The browser rejected the file picker.')); }
    });
  }

  function mount(files, options) {
    if (files && !options && files.files) { options = files; files = files.files; }
    options = options || {};
    var list = asArray(files);
    if (!list.length) return Promise.reject(error('NO_FILES', 'Select at least one file before mounting media.'));
    if (list.length > MAX_FILES) return Promise.reject(error('TRANSFER_LIMIT', 'The selected collection contains too many files.', ''));
    var p = makeManifest(list, options);
    if (p.records.some(function (r) { return r.size > MAX_FILE_BYTES; })) return Promise.reject(error('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.', p.meta.root));
    if (p.records.some(function (r) { return String(r.path).length > MAX_PATH_CHARS; })) return Promise.reject(error('INVALID_PATH', 'A selected file path is too long for the guest filesystem.', p.meta.root));
    if (p.meta.used > p.meta.capacity) {
      return Promise.reject(error('DISK_FULL', 'There is not enough space on the selected medium.', p.meta.root));
    }
    var media = Media(p, options);
    var driveKey = media.drive.charAt(0).toUpperCase();
    if (activeMedia[driveKey] && activeMedia[driveKey] !== media) activeMedia[driveKey].eject();
    activeMedia[driveKey] = media;
    return Promise.resolve(media);
  }
  function mountFromPicker(options) {
    options = options || {};
    return picker({ directory: !!options.directory, multiple: options.multiple !== false, accept: options.accept }).then(function (files) {
      return mount(files, options);
    });
  }

  function fsFor(options) {
    options = options || {};
    /* Accept a filesystem object directly as well as { fs: ... }; this keeps
       the helper usable by the shim and by small tests without a global W98. */
    if (options && typeof options.readBytes === 'function') return options;
    if (options.fs) return options.fs;
    if (global.W98 && global.W98.fs) return global.W98.fs;
    throw error('NO_GUEST_FS', 'The Windows 98 filesystem is not ready.');
  }
  function persistDb() {
    if (!global.indexedDB) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var req;
      try { req = global.indexedDB.open(PERSIST_DB, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(PERSIST_STORE)) db.createObjectStore(PERSIST_STORE, { keyPath: 'path' });
      };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }
  function persistGuestFiles(entries) {
    entries = (entries || []).filter(function (entry) {
      return entry && /^C:\\/i.test(String(entry.path || '')) && entry.bytes && entry.bytes.length <= MAX_FILE_BYTES;
    });
    if (!entries.length) return Promise.resolve(false);
    return persistDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var tx;
        try { tx = db.transaction(PERSIST_STORE, 'readwrite'); } catch (e) { db.close(); resolve(false); return; }
        var store = tx.objectStore(PERSIST_STORE);
        entries.forEach(function (entry) {
          var bytes = cloneBytes(entry.bytes);
          store.put({ path: String(entry.path), bytes: bytes.buffer, size: bytes.length });
        });
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
        tx.onabort = function () { db.close(); resolve(false); };
      });
    });
  }
  function restoreGuestFiles() {
    if (persistenceStarted) return Promise.resolve(false);
    persistenceStarted = true;
    var fs;
    try { fs = fsFor({}); } catch (e) { return Promise.resolve(false); }
    return persistDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var tx;
        try { tx = db.transaction(PERSIST_STORE, 'readonly'); } catch (e) { db.close(); resolve(false); return; }
        var request = tx.objectStore(PERSIST_STORE).getAll ? tx.objectStore(PERSIST_STORE).getAll() : null;
        function apply(rows) {
          var restored = 0;
          (rows || []).slice(0, MAX_FILES).forEach(function (row) {
            if (!row || !/^C:\\/i.test(String(row.path || '')) || String(row.path).length > MAX_PATH_CHARS || fs.exists(row.path)) return;
            var bytes = row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : cloneBytes(row.bytes);
            if (bytes.length > MAX_FILE_BYTES) return;
            try {
              var result = fs.writeBytes(row.path, bytes);
              if (typeof result !== 'number' || result >= 0) restored++;
            } catch (e) { /* a full or malformed guest volume is left unchanged */ }
          });
          db.close(); resolve(restored > 0);
        }
        if (request) {
          request.onsuccess = function () { apply(request.result || []); };
          request.onerror = function () { db.close(); resolve(false); };
        } else {
          var rows = [];
          var cursor = tx.objectStore(PERSIST_STORE).openCursor();
          cursor.onsuccess = function () {
            var c = cursor.result;
            if (!c || rows.length >= MAX_FILES) { apply(rows); return; }
            rows.push(c.value); c.continue();
          };
          cursor.onerror = function () { db.close(); resolve(false); };
        }
      });
    });
  }
  function ensureGuestDir(fs, path) {
    var p = normPath(path), bits = p.split('\\'), cur = bits.shift() + '\\';
    return bits.reduce(function (chain, bit) {
      if (!bit) return chain;
      cur = joinPath(cur, bit);
      return chain.then(function () {
        if (fs.exists && fs.exists(cur)) return;
        var r = fs.mkdir ? fs.mkdir(cur) : 0;
        if (typeof r === 'number' && r < 0) throw error('DISK_FULL', 'Unable to create folder ' + cur, cur);
      });
    }, Promise.resolve());
  }
  function importToGuest(source, destination, options) {
    options = options || {};
    var fs = fsFor(options), dest = destination || options.destination || 'C:\\My Documents';
    var media = source && typeof source.read === 'function' ? source : null;
    var records;
    if (media) records = (media.manifest.files || []).slice();
    else records = makeManifest(asArray(source), options).records;
    if (records.length > MAX_FILES) return Promise.reject(error('TRANSFER_LIMIT', 'The selected collection contains too many files.', dest));
    if (records.some(function (r) { return String(r.path || '').length > MAX_PATH_CHARS; })) return Promise.reject(error('INVALID_PATH', 'A selected file path is too long for the guest filesystem.', dest));
    if (records.some(function (r) { return Number(r.size) > MAX_FILE_BYTES; })) return Promise.reject(error('FILE_TOO_LARGE', 'A selected file exceeds the 4 MiB Windows 98 file limit.', dest));
    var declaredTotal = records.reduce(function (n, r) { return n + Math.max(0, Number(r.size) || 0); }, 0);
    if (declaredTotal > MAX_TRANSFER_BYTES) return Promise.reject(error('TRANSFER_LIMIT', 'The selected transfer exceeds the 8 MiB session limit.', dest));
    records.sort(sortRecords);
    var total = 0, copied = [], persisted = [];
    return records.reduce(function (chain, rec) {
      return chain.then(function () {
        var rel = rec.relativePath || rec.name || String(rec.path).replace(/^.*\\/, '');
        var target = joinPath(dest, rel);
        if (target.length > MAX_PATH_CHARS) throw error('INVALID_PATH', 'A selected file path is too long for the guest filesystem.', target);
        var parent = target.slice(0, target.lastIndexOf('\\')) || dest;
        var read = media ? media.read(rec.path) : readHostFile(rec);
        return ensureGuestDir(fs, parent).then(function () { return Promise.resolve(read); }).then(function (bytes) {
          if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TRANSFER_BYTES) throw error('TRANSFER_LIMIT', 'The selected transfer exceeds the 8 MiB session limit.', target);
          var result = fs.writeBytes(target, bytes);
          if (typeof result === 'number' && result < 0) throw error('DISK_FULL', 'There is not enough space on the hard disk.', target);
          total += bytes.length; copied.push({ source: rec.path, path: target, size: bytes.length });
          if (/^C:\\/i.test(target)) persisted.push({ path: target, bytes: bytes });
        });
      });
    }, Promise.resolve()).then(function () {
      return persistGuestFiles(persisted).then(function (persistent) {
        return { count: copied.length, bytes: total, files: copied, destination: dest, persistent: persistent };
      });
    });
  }

  function downloadBytes(bytes, name, type) {
    if (!global.document || !global.Blob || !global.URL || !global.URL.createObjectURL) throw error('DOWNLOAD_UNAVAILABLE', 'Browser downloads are unavailable.');
    var blob = new Blob([bytes], { type: type || 'application/octet-stream' }), url = global.URL.createObjectURL(blob), a = global.document.createElement('a');
    a.href = url; a.download = String(name || 'download.bin'); a.style.display = 'none';
    (global.document.body || global.document.documentElement).appendChild(a);
    try { a.click(); } finally { if (a.parentNode) a.parentNode.removeChild(a); setTimeout(function () { try { global.URL.revokeObjectURL(url); } catch (e) {} }, 0); }
    return { name: a.download, size: bytes.length };
  }
  function exportVirtualFile(path, options) {
    options = options || {};
    var fs = fsFor(options), p = String(path), name = options.name || p.replace(/^.*[\\/]/, ''), bytes = fs.readBytes(p);
    if (!bytes) return Promise.reject(error('NOT_FOUND', 'File not found: ' + p, p));
    return Promise.resolve(downloadBytes(bytes, name, options.type)).then(function (result) { return { path: p, name: result.name, size: bytes.length }; });
  }
  function exportVirtualFiles(paths, options) {
    /* Historical callers pass (paths, fs, names); newer callers pass
       (paths, {fs, names}).  Keep both forms so the shim remains useful. */
    var names = Array.isArray(arguments[2]) ? arguments[2] : (options && options.names);
    var fs = options && typeof options.readBytes === 'function' ? options : (options && options.fs ? options.fs : null);
    var opts = fs ? { fs: fs } : (options || {}), list = asArray(paths), out = [];
    return list.reduce(function (chain, p, i) { return chain.then(function () {
      var one = Object.assign({}, opts); if (names && names[i]) one.name = names[i];
      return exportVirtualFile(p, one).then(function (r) { out.push(r); });
    }); }, Promise.resolve()).then(function () { return out; });
  }

  function isFileDrop(event) { return !!(event && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length); }
  function installDropTarget(element, options) {
    options = options || {};
    if (!element || !element.addEventListener) throw error('INVALID_DROP_TARGET', 'A drop target element is required.');
    var canRoute = typeof options.canRoute === 'function' ? options.canRoute : function (ev) { return isFileDrop(ev); };
    function over(ev) { if (canRoute(ev)) { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; } }
    function drop(ev) {
      if (!canRoute(ev) || !isFileDrop(ev)) return;
      ev.preventDefault();
      var files = Array.prototype.slice.call(ev.dataTransfer.files);
      importToGuest(files, options.destination || 'C:\\My Documents', options).then(function (result) {
        if (typeof options.onImported === 'function') options.onImported(result);
      }).catch(function (e) { if (typeof options.onError === 'function') options.onError(e); });
    }
    element.addEventListener('dragover', over); element.addEventListener('drop', drop);
    return function () { element.removeEventListener('dragover', over); element.removeEventListener('drop', drop); };
  }

  API = {
    VERSION: VERSION, version: VERSION, MANIFEST_KIND: MANIFEST_KIND,
    limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTransferBytes: MAX_TRANSFER_BYTES, maxPathChars: MAX_PATH_CHARS },
    Error: BridgeError, errors: { EJECTED: 'EJECTED', WRITE_PROTECTED: 'WRITE_PROTECTED', DISK_FULL: 'DISK_FULL', NOT_FOUND: 'NOT_FOUND' },
    normalizePath: normPath, makeManifest: function (files, options) { return makeManifest(files, options || {}).meta; },
    pickFiles: picker, pick: picker, mount: mount, mountMedia: mount,
    mountFloppy: function (files, options) { options = Object.assign({}, options || {}, { mediaType: 'floppy', drive: 'A' }); return mount(files, options); },
    mountCdrom: function (files, options) { options = Object.assign({}, options || {}, { mediaType: 'cdrom', drive: 'D', writeProtected: true }); return mount(files, options); },
    mountFromPicker: mountFromPicker,
    insertFloppy: function (options) { return mountFromPicker(Object.assign({}, options || {}, { mediaType: 'floppy', drive: 'A' })); },
    insertCdrom: function (options) { return mountFromPicker(Object.assign({}, options || {}, { mediaType: 'cdrom', drive: 'D', writeProtected: true })); },
    status: function (drive) {
      var d = String(drive || 'A').charAt(0).toUpperCase(), m = activeMedia[d];
      if (m && m.mounted) return m.status();
      /* The floppy app owns the guest VFS mount when it is installed.  Keep
         the bridge status surface compatible with that optional owner. */
      try {
        var wm = global.W98 && global.W98.media;
        if (wm && typeof wm.state === 'function') {
          var s = wm.state(), value = s[d === 'A' ? 'floppy' : 'cdrom'];
          if (value) return value;
        }
      } catch (e) {}
      return null;
    },
    eject: function (media) {
      if (typeof media === 'string') {
        var d = media.charAt(0).toUpperCase(), active = activeMedia[d];
        if (active) {
          var result = active.eject();
          try {
            var owned = global.W98 && global.W98.media;
            if (owned && typeof owned.eject === 'function') owned.eject(d === 'A' ? 'floppy' : 'cdrom');
          } catch (e0) {}
          return result;
        }
        try {
          var wm = global.W98 && global.W98.media;
          if (wm && typeof wm.eject === 'function') return wm.eject(d === 'A' ? 'floppy' : 'cdrom');
        } catch (e) {}
        return false;
      }
      return media && typeof media.eject === 'function' ? media.eject() : false;
    },
    importToGuest: importToGuest, importFiles: importToGuest,
    downloadBytes: downloadBytes,
    /* Aliases used by the transfer app and by older integrations. */
    download: function (name, bytes, type) { return downloadBytes(cloneBytes(bytes), name, type); },
    readFile: function (file) { return readHostFile({ file: file }); },
    exportVirtualFile: exportVirtualFile, exportVirtualFiles: exportVirtualFiles, exportFiles: exportVirtualFiles,
    isFileDrop: isFileDrop, installDropTarget: installDropTarget,
    lastError: null,
    _mediaSerial: function () { return ++mediaSerial; }
  };
  global.W98HostFileBridge = API;
  global.hostFileBridge = API;
  function attach() { if (global.W98) global.W98.hostFiles = API; }
  attach();
  /* If the Virtual Media app owns the VFS mount, its eject event also
     invalidates any standalone bridge token for the same drive. */
  if (global.addEventListener) global.addEventListener('w98-media-change', function (ev) {
    var d = ev && ev.detail && ev.detail.data && ev.detail.data.type;
    if (ev && ev.detail && ev.detail.kind === 'eject' && d) {
      var key = d === 'cdrom' ? 'D' : 'A';
      if (activeMedia[key]) activeMedia[key].eject();
    }
  });
  if (global.addEventListener) global.addEventListener('w98-shell-ready', attach);
  if (global.addEventListener) global.addEventListener('w98-kernel-ready', function () {
    restoreGuestFiles().catch(function () { return false; });
  });
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
