/* ============================================================================
   snapshot.js — user restore points

   Restore points contain only the persistent kernel image (KFS1 + KREG1/2).
   The kernel owns those encodings; this module stores and validates the opaque
   images in a versioned envelope and keeps them separate from automatic boot
   records.  No live windows, timers, processes, or JavaScript closures are
   serialized.
   ========================================================================== */
(function (global) {
  'use strict';

  var DB_NAME = 'w98-kernel', STORE = 'snap', PREFIX = 'restore-point:';
  var FORMAT = 'W98-SNAPSHOT', VERSION = 1, MAX_TEXT = 32 * 1024 * 1024;
  var mem = new Map();
  var enc = new TextEncoder();
  var K = global.W98Kernel;

  function fail(code, message) {
    var e = new Error(message);
    e.name = 'SnapshotError'; e.code = code;
    return e;
  }
  function bytesOf(v) { return enc.encode(typeof v === 'string' ? v : JSON.stringify(v)); }
  function id() {
    var r = global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : null;
    return r || ('rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  }
  function keyFor(i) { return PREFIX + i; }
  function whenReady() {
    if (K && K.ready && typeof K.ready.then === 'function') return K.ready;
    return Promise.resolve(K);
  }

  /* IndexedDB deliberately reuses the existing v1 object store.  Automatic
     records remain fs/reg/savedAt; restore points use a distinct key prefix. */
  function db() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(fail('unavailable', 'IndexedDB is unavailable'));
      var req;
      try { req = global.indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onerror = function () { reject(fail('unavailable', 'Unable to open snapshot storage')); };
      req.onblocked = function () { reject(fail('unavailable', 'Snapshot storage is blocked')); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }
  function readAll() {
    var out = [];
    mem.forEach(function (v) { out.push(v); });
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = d.transaction(STORE, 'readonly'); } catch (e) { d.close(); return reject(e); }
        var st = tx.objectStore(STORE), req = st.openCursor();
        req.onerror = function () { d.close(); reject(req.error || new Error('snapshot read failed')); };
        req.onsuccess = function () {
          var c = req.result;
          if (!c) { d.close(); resolve(out); return; }
          if (typeof c.key === 'string' && c.key.indexOf(PREFIX) === 0 && c.value) {
            /* The in-memory cache is useful when IndexedDB is unavailable,
               but it can also contain a record that has just been written to
               the persistent store.  Merge by stable id so list/get never
               expose a duplicate point after a create or import. */
            var already = out.some(function (x) { return x && x.id === c.value.id; });
            if (!already) out.push(c.value);
          }
          c.continue();
        };
      });
    }).catch(function (e) {
      if (e && e.code === 'unavailable') return out;
      throw e;
    });
  }
  function put(env) {
    mem.set(env.id, env);
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = d.transaction(STORE, 'readwrite'); } catch (e) { d.close(); return reject(e); }
        tx.objectStore(STORE).put(env, keyFor(env.id));
        tx.oncomplete = function () { d.close(); resolve(env); };
        tx.onerror = function () { d.close(); reject(fail('storage', 'Unable to save restore point')); };
        tx.onabort = function () { d.close(); reject(fail('storage', 'Unable to save restore point')); };
      });
    }).catch(function (e) {
      if (e && e.code === 'unavailable') return env; /* session fallback */
      throw e;
    });
  }
  function removeStored(env) {
    mem.delete(env.id);
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = d.transaction(STORE, 'readwrite'); } catch (e) { d.close(); return reject(e); }
        tx.objectStore(STORE).delete(keyFor(env.id));
        tx.oncomplete = function () { d.close(); resolve(true); };
        tx.onerror = function () { d.close(); reject(fail('storage', 'Unable to delete restore point')); };
      });
    }).catch(function (e) {
      if (e && e.code === 'unavailable') return true;
      throw e;
    });
  }

  function validateImage(which, value) {
    if (typeof value !== 'string' || !value || value.length > MAX_TEXT || value.indexOf('\0') >= 0)
      throw fail('malformed', 'Malformed ' + which + ' image');
    var lines = value.replace(/\r/g, '').split('\n');
    var hdr = lines.shift();
    if (which === 'filesystem' && hdr !== 'KFS1') throw fail('unsupported', 'Unsupported filesystem image');
    if (which === 'registry' && hdr !== 'KREG1' && hdr !== 'KREG2') throw fail('unsupported', 'Unsupported registry image');
    /* Validate record framing and base64 without recreating kernel state. */
    lines.forEach(function (line) {
      if (!line) return;
      if (which === 'filesystem') {
        var f = line.split('|');
        if (f.length < 5 || (f[0] !== '0' && f[0] !== '1') || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2]) || !f[3])
          throw fail('malformed', 'Malformed filesystem image record');
        if (f.length !== 5) throw fail('malformed', 'Malformed filesystem image record');
        var data = f[4];
        if (data && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw fail('malformed', 'Malformed filesystem image data');
        var size = Number(f[2]);
        if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) throw fail('malformed', 'Filesystem image is too large');
        var pad = data.endsWith('==') ? 2 : (data.endsWith('=') ? 1 : 0);
        var decoded = data ? (data.length / 4) * 3 - pad : 0;
        if (decoded !== size) throw fail('malformed', 'Filesystem image data length does not match its record');
      } else {
        var r = line.split('\t');
        if (hdr === 'KREG2') {
          if (r.length < 4 || !r[0] || !r[1] || !/^\d+$/.test(r[2])) throw fail('malformed', 'Malformed registry image record');
          r = [r[0], r[1], r[2], r.slice(3).join('\t')];
        } else if (r.length < 2 || !r[0]) throw fail('malformed', 'Malformed registry image record');
        var b = hdr === 'KREG2' ? r[3] : (r.length > 2 ? r.slice(2).join('\t') : '');
        if (b && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b)) throw fail('malformed', 'Malformed registry image data');
      }
    });
    return value;
  }
  function validate(input) {
    var o = input;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (_) { throw fail('malformed', 'Snapshot is not valid JSON'); }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail('malformed', 'Malformed snapshot envelope');
    if (o.format !== FORMAT) throw fail('unsupported', 'Unsupported snapshot format');
    if (!Number.isInteger(o.version) || o.version < 1) throw fail('malformed', 'Malformed snapshot version');
    if (o.version > VERSION) throw fail('future-version', 'Snapshot version ' + o.version + ' is newer than this build supports');
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 200) throw fail('malformed', 'Malformed restore point name');
    if (o.description !== undefined && typeof o.description !== 'string') throw fail('malformed', 'Malformed restore point description');
    if (typeof o.createdAt !== 'string' || isNaN(Date.parse(o.createdAt))) throw fail('malformed', 'Malformed restore point timestamp');
    if (!o.state || typeof o.state !== 'object' || Array.isArray(o.state)) throw fail('malformed', 'Snapshot state is missing');
    validateImage('filesystem', o.state.fs); validateImage('registry', o.state.reg);
    return {
      format: FORMAT, version: VERSION, id: typeof o.id === 'string' && o.id ? o.id : id(),
      createdAt: o.createdAt, name: o.name.trim(), description: o.description || '',
      state: { fs: o.state.fs, reg: o.state.reg }
    };
  }
  function find(ref) {
    return readAll().then(function (all) {
      var wanted = typeof ref === 'string' ? ref : (ref && ref.id);
      var found = all.filter(function (x) { return x && (x.id === wanted || (typeof ref === 'string' && String(x.name).toLowerCase() === ref.toLowerCase())); })[0];
      if (!found) throw fail('not-found', 'Restore point not found');
      return validate(found);
    });
  }

  var API = {
    format: FORMAT, version: VERSION,
    validate: function (x) { return validate(x); },
    capture: function () {
      return whenReady().then(function () {
        if (!K || typeof K.capturePersistentState !== 'function') throw fail('unavailable', 'Kernel persistence is unavailable');
        return Promise.resolve(K.capturePersistentState());
      });
    },
    list: function () {
      return readAll().then(function (all) { return all.map(function (x) { var e = validate(x); return { id: e.id, name: e.name, description: e.description, createdAt: e.createdAt, timestamp: e.createdAt, size: bytesOf(e).length }; }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); }); });
    },
    get: function (ref) { return find(ref); },
    create: function (name, description) {
      return API.capture().then(function (state) {
        var env = validate({ format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), name: name, description: description || '', state: state });
        return readAll().then(function (all) {
          if (all.some(function (x) { return x && String(x.name).toLowerCase() === env.name.toLowerCase(); })) throw fail('duplicate-name', 'A restore point with that name already exists');
          return put(env);
        });
      });
    },
    remove: function (ref) { return find(ref).then(removeStored); },
    'delete': function (ref) { return API.remove(ref); },
    restore: function (ref, options) {
      options = options || {};
      var lookup = ref && ref.state ? Promise.resolve(validate(ref)) : find(ref);
      return lookup.then(function (env) {
        if (!K || typeof K.replacePersistentState !== 'function') throw fail('unavailable', 'Kernel persistence is unavailable');
        return API.capture().then(function (before) {
          return Promise.resolve(K.replacePersistentState(env.state)).then(function (result) {
            global.dispatchEvent(new CustomEvent('w98-snapshot-restored', { detail: env }));
            if (options.reload && global.location && typeof global.location.reload === 'function') global.location.reload();
            return { snapshot: env, result: result };
          }).catch(function (e) {
            try { return Promise.resolve(K.replacePersistentState(before)).then(function () { throw e; }); }
            catch (_) { throw e; }
          });
        });
      });
    },
    export: function (ref, options) {
      options = options || {};
      return find(ref).then(function (env) {
        var text = JSON.stringify(env, null, 2);
        if (options.download !== false && global.document && global.URL && global.Blob) {
          var a = global.document.createElement('a');
          a.href = global.URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          a.download = options.filename || (env.name.replace(/[^A-Za-z0-9._-]+/g, '_') + '.w98snapshot');
          a.click();
          setTimeout(function () { global.URL.revokeObjectURL(a.href); }, 0);
        }
        return text;
      });
    },
    download: function (ref, options) {
      options = Object.assign({}, options || {}, { download: true });
      return API.export(ref, options);
    },
    import: function (source) {
      var p = source && typeof source.text === 'function' ? source.text() : Promise.resolve(typeof source === 'string' ? source : JSON.stringify(source));
      return p.then(function (text) {
        var parsed; try { parsed = JSON.parse(text); } catch (e) { throw fail('malformed', 'Snapshot is not valid JSON'); }
        var env = validate(parsed);
        /* An exported point may carry its source profile's id.  Imports are
           new records, so assign a local id before writing; this also lets a
           user import the same file more than once under distinct names. */
        env.id = id();
        return readAll().then(function (all) {
          if (all.some(function (x) { return x && String(x.name).toLowerCase() === env.name.toLowerCase(); })) throw fail('duplicate-name', 'A restore point with that name already exists');
          return put(env);
        });
      });
    },
    importSnapshot: function (source) { return API.import(source); },
    createRestorePoint: function (name, description) { return API.create(name, description); },
    restorePoint: function (ref, options) { return API.restore(ref, options); },
    deleteRestorePoint: function (ref) { return API.remove(ref); },
    listRestorePoints: function () { return API.list(); },
    getRestorePoint: function (ref) { return API.get(ref); },
    exportSnapshot: function (ref, options) { return API.export(ref, options); }
  };
  global.W98Snapshot = API;
  if (global.W98) global.W98.snapshot = API;
})(window);
