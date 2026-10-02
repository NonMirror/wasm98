/* ============================================================================
   kernel.js — JS glue for kernel.wasm
   ----------------------------------------------------------------------------
   Loads web/wasm/kernel.wasm, wires its syscalls to the desktop:
     W98Kernel.fs / .reg / .procs / .timers / .stats / .log / .info
   The wasm image owns the process table, timer queue, filesystem and registry.
   JS only moves bytes in and out of its linear memory.

   If the wasm image cannot be loaded a reduced in-memory implementation is used
   so the desktop still comes up; W98Kernel.mode reports 'wasm' or 'shim' and
   System Properties displays which one is live.
   ========================================================================== */
(function (global) {
  'use strict';

  var ST = {
    SYSCALLS: 0, TICKS: 1, TIMERS: 2, PROCS: 3, HEAP_USED: 4, HEAP_SIZE: 5, SWITCHES: 6,
    UPTIME: 7, QUEUE: 8, NDESC: 9, NEXT_PID: 10, FILES: 11, BYTES: 12, REG: 13, TMP_CAP: 14,
    VERSION: 15, PANIC: 16, SLICE: 17, CURRENT: 18, FIRED: 19, NODES: 20, HEAP_FREE: 21,
    DROPPED: 22
  };
  var PF = { PID: 0, STATE: 1, Z: 2, CPU_US: 3, FLAGS: 4, STARTED: 5, INDEX: 6 };
  var PS = { EMPTY: 0, RUNNING: 1, MIN: 2, HIDDEN: 3, ZOMBIE: 4 };

  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64Encode(arr) {
    var out = '', i = 0;
    for (; i + 2 < arr.length; i += 3) {
      var v = (arr[i] << 16) | (arr[i + 1] << 8) | arr[i + 2];
      out += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63];
    }
    if (i < arr.length) {
      var rem = arr.length - i, w = arr[i] << 16;
      if (rem === 2) w |= arr[i + 1] << 8;
      out += B64[(w >>> 18) & 63] + B64[(w >>> 12) & 63] + (rem === 2 ? B64[(w >>> 6) & 63] : '=') + '=';
    }
    return out;
  }
  function b64Decode(s) {
    s = String(s || '');
    if (!s) return new Uint8Array(0);
    var out = [], i = 0;
    function val(c) { return B64.indexOf(c); }
    while (i < s.length) {
      if (i + 3 >= s.length) throw new Error('truncated base64');
      var a = val(s[i++]), b = val(s[i++]), c = s[i++], d = s[i++];
      var cv = c === '=' ? 0 : val(c), dv = d === '=' ? 0 : val(d);
      if (a < 0 || b < 0 || cv < 0 || dv < 0) throw new Error('invalid base64');
      var n = (a << 18) | (b << 12) | (cv << 6) | dv;
      out.push((n >>> 16) & 255);
      if (c !== '=') out.push((n >>> 8) & 255);
      if (d !== '=') out.push(n & 255);
    }
    return new Uint8Array(out);
  }
  var API = {
    mode: 'none',
    version: 0,
    ST: ST, PF: PF, PS: PS,
    ready: null,
    error: null
  };

  var wasm = null;          /* exports */
  var heapPtrs = [];        /* live pushes, for leak detection */
  var timerCbs = new Map();
  var dirty = false, saveTimer = null, flushCount = 0;

  /* ---------------------------------------------------------- memory helpers */
  function bytes() { return new Uint8Array(wasm.memory.buffer); }
  function slice(ptr, len) { return bytes().slice(ptr, ptr + len); }
  function readText(ptr, len) { return dec.decode(slice(ptr, len)); }
  function pushText(str) {
    var b = enc.encode(str);
    var p = wasm.k_alloc(b.length + 1);
    if (!p) throw new Error('kernel heap exhausted (string of ' + b.length + ' bytes)');
    bytes().set(b, p);
    bytes()[p + b.length] = 0;
    return { p: p, n: b.length };
  }
  function pushBytes(arr) {
    var p = wasm.k_alloc(arr.length + 1);
    if (!p) throw new Error('kernel heap exhausted (' + arr.length + ' bytes)');
    bytes().set(arr, p);
    return p;
  }
  var tmpText = function () { return readText(wasm.k_tmp_ptr(), wasm.k_tmp_len()); };
  var tmpBytes = function () { return slice(wasm.k_tmp_ptr(), wasm.k_tmp_len()); };

  /* --------------------------------------------------------------- paths */
  function normPath(p) {
    if (!p) return 'C:\\';
    p = String(p).replace(/\//g, '\\');
    var drv = p.match(/^([A-Za-z]):/);
    var rest = drv ? p.slice(2) : p;
    var parts = rest.split('\\'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === '' || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return (drv ? drv[1].toUpperCase() : 'C') + ':\\' + out.join('\\');
  }
  function withPath(path, fn) {
    var a = pushText(normPath(path));
    try { return fn(a.p, a.n); } finally { wasm.k_free(a.p); }
  }

  /* ------------------------------------------------- filesystem (wasm) */
  function fsWasm() {
    return {
      exists: function (p) { return withPath(p, function (a, n) { return wasm.k_fs_exists(a, n) === 1; }) === true; },
      isDir: function (p) { return withPath(p, function (a, n) { return wasm.k_fs_is_dir(a, n) === 1; }) === true; },
      size: function (p) { return withPath(p, function (a, n) { return wasm.k_fs_size(a, n); }); },
      readBytes: function (p) {
        return withPath(p, function (a, n) {
          var r = wasm.k_fs_read(a, n);
          return r < 0 ? null : tmpBytes();
        });
      },
      readText: function (p) {
        var b = this.readBytes(p);
        if (!b) return null;
        var s = dec.decode(b);
        return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
      },
      writeBytes: function (p, data) {
        var arr = (data instanceof Uint8Array) ? data : new Uint8Array(data);
        var dp = pushBytes(arr);
        var r = withPath(p, function (a, n) { return wasm.k_fs_write(a, n, dp, arr.length); });
        wasm.k_free(dp);
        markDirty();
        return r;
      },
      writeText: function (p, s) { return this.writeBytes(p, enc.encode(s)); },
      list: function (p) {
        return withPath(p, function (a, n) {
          var h = wasm.k_fs_opendir(a, n);
          if (h < 0) return null;
          var out = [], guard = 0;
          while (wasm.k_fs_readdir(h) === 1 && guard++ < 20000) {
            out.push({
              name: readText(wasm.k_dir_name_ptr(), wasm.k_dir_name_len()),
              dir: wasm.k_dir_is_dir() === 1,
              size: wasm.k_dir_size(),
              mtime: wasm.k_dir_mtime()
            });
          }
          wasm.k_fs_closedir(h);
          out.sort(function (x, y) {
            if (x.dir !== y.dir) return x.dir ? -1 : 1;
            return x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1;
          });
          return out;
        });
      },
      mkdir: function (p) { return withPath(p, function (a, n) { var r = wasm.k_fs_mkdir(a, n); markDirty(); return r; }); },
      remove: function (p) { return withPath(p, function (a, n) { var r = wasm.k_fs_unlink(a, n); markDirty(); return r; }); },
      rename: function (from, to) {
        var a = pushText(normPath(from)), b = pushText(normPath(to));
        var r = wasm.k_fs_rename(a.p, a.n, b.p, b.n);
        wasm.k_free(a.p); wasm.k_free(b.p);
        markDirty();
        return r;
      },
      stat: function (p) {
        var b = this.readBytes(p);
        return this.exists(p) ? { name: normPath(p).split('\\').pop(), dir: this.isDir(p), size: b ? b.length : 0 } : null;
      }
    };
  }

  /* ------------------------------------------------- registry (wasm) */
  function regWasm() {
    function key(path, name) {
      var a = pushText(path || 'HKEY_CURRENT_USER\\Software'), b = pushText(name || '');
      return {
        p: a, n: b,
        free: function () { wasm.k_free(a.p); wasm.k_free(b.p); }
      };
    }
    return {
      get: function (path, name, dflt) {
        var k = key(path, name), r;
        try { r = wasm.k_reg_get(k.p.p, k.p.n, k.n.p, k.n.n); } finally { k.free(); }
        if (r < 0) return dflt === undefined ? null : dflt;
        return tmpText();
      },
      set: function (path, name, value) {
        var k = key(path, name);
        var v = pushText(value == null ? '' : String(value));
        try { wasm.k_reg_set(k.p.p, k.p.n, k.n.p, k.n.n, v.p, v.n); } finally { wasm.k_free(v.p); k.free(); }
        markDirty();
        return true;
      },
      del: function (path, name) {
        var k = key(path, name), r;
        try { r = wasm.k_reg_del(k.p.p, k.p.n, k.n.p, k.n.n); } finally { k.free(); }
        markDirty();
        return r === 0;
      }
    };
  }

  /* ---------------------------------------------------- processes (wasm) */
  function procsWasm() {
    return {
      create: function (name, flags) {
        var a = pushText(name);
        var pid = wasm.k_proc_create(a.p, a.n, flags || 0);
        wasm.k_free(a.p);
        return pid;
      },
      destroy: function (pid) { return wasm.k_proc_destroy(pid); },
      count: function () { return wasm.k_proc_count(); },
      list: function () {
        var n = wasm.k_proc_count(), out = [];
        for (var i = 0; i < n; i++) {
          var pid = wasm.k_proc_pid_at(i);
          if (!pid) continue;
          out.push({
            pid: pid,
            name: readText(wasm.k_proc_name_ptr(pid), wasm.k_proc_name_len(pid)),
            state: wasm.k_proc_field(pid, PF.STATE),
            z: wasm.k_proc_field(pid, PF.Z),
            cpuUs: wasm.k_proc_field(pid, PF.CPU_US),
            started: wasm.k_proc_field(pid, PF.STARTED),
            flags: wasm.k_proc_field(pid, PF.FLAGS),
            index: wasm.k_proc_field(pid, PF.INDEX)
          });
        }
        return out;
      },
      setState: function (pid, s) { return wasm.k_proc_set_field(pid, PF.STATE, s); },
      setZ: function (pid, z) { return wasm.k_proc_set_field(pid, PF.Z, z); },
      getField: function (pid, f) { return wasm.k_proc_field(pid, f); },
      focus: function (pid) { wasm.k_focus_set(pid); },
      current: function () { return wasm.k_focus_get(); },
      terminate: function (pid) { return wasm.k_proc_destroy(pid); }
    };
  }

  /* ------------------------------------------------------ timers (wasm) */
  function setTimer(cb, ms, oneshot) {
    var owner = API.procs.current();
    var tid = wasm.k_timer_set(owner, Math.max(1, ms | 0), oneshot ? 1 : 0);
    if (tid) timerCbs.set(tid, { cb: cb, owner: owner });
    return tid;
  }
  function clearTimer(tid) {
    if (!tid) return;
    timerCbs.delete(tid);
    if (wasm) wasm.k_timer_kill(tid);
  }
  function tick(nowMs) {
    if (!wasm) return 0;
    var n = wasm.k_tick(nowMs | 0);
    for (var i = 0; i < n; i++) {
      var tid = wasm.k_fired_pop();
      if (!tid) break;
      var rec = timerCbs.get(tid);
      if (!rec) continue;
      if (rec.oneshot !== false && wasm.k_timer_pid(tid) === 0) timerCbs.delete(tid);
      try { rec.cb(nowMs); }
      catch (e) { console.error('kernel: timer callback threw', e); }
    }
    return n;
  }

  /* ------------------------------------------------------ stats / info */
  function statsWasm() {
    var s = {};
    for (var k in ST) s[k] = wasm.k_stat(ST[k]);
    s.heapPeak = wasm.k_heap_peak();
    s.uptimeMs = wasm.k_stat(ST.UPTIME);
    s.currentPid = wasm.k_stat(ST.CURRENT);
    s.nextPid = wasm.k_stat(ST.NEXT_PID);
    return s;
  }
  /* --------------------------------------------------- the NT executive */
  function executive(m) {
    var ns = function (n) { return m.k_stat(100 + n); };
    return {
      objects: ns(0), objectPeak: ns(1), handles: ns(2), threads: ns(3),
      ready: ns(4), running: ns(5), waiting: ns(6), readyDepth: ns(7),
      waits: ns(8), mutantsHeld: ns(9),
      dpcQueued: ns(10), dpcDrained: ns(11), apcQueued: ns(12), apcDelivered: ns(13),
      irpCreated: ns(14), irpCompleted: ns(15), irpFailed: ns(16),
      irpOverflow: ns(17), irpCancelled: ns(18), irqlViolations: ns(19),
      commitCharge: ns(20), commitLimit: ns(21), commitPeak: ns(22), commitFails: ns(23),
      pageFaults: ns(24), poolPaged: ns(25), poolPagedPeak: ns(26),
      poolNonpaged: ns(27), poolNonpagedPeak: ns(28),
      tokens: ns(29), accessChecks: ns(30), accessDenies: ns(31),
      hiveKeys: ns(32), hiveValues: ns(33), hiveDepth: ns(34),
      txCommitted: ns(35), txRolledBack: ns(36), bugchecks: ns(37), sections: ns(38),
      vmRegions: ns(39), currentTid: ns(40), switches: ns(41), boosts: ns(42),
      aging: ns(43), vmbusMsgs: ns(44), halted: ns(45), objectDeletes: ns(46),
      waitTimeouts: ns(47), hiveQuota: ns(48), hiveSkips: ns(49),
      haltedFlag: !!ns(45),
      /* read the dump lazily: it only exists after a bugcheck, and a bugcheck
         may happen long after this snapshot was taken */
      bugcheckDump: function () {
        var n = m.k_bugcheck_dump_len();
        return n ? readText(m.k_bugcheck_dump_ptr(), n) : '';
      },
      halt: function (code) { return m.k_bugcheck((code >>> 0) || 0x0000007B, 0, 0, 0, 0); },
      /* the live hive, for anything that wants to show the registry tree */
      hiveRoot: function (i) { return m.k_reg2_root(i); },
      keyField: function (k, f) { return m.k_reg2_key_field(k, f); }
    };
  }

  function logText() {
    var len = wasm.k_log_len();
    return len ? readText(wasm.k_log_ptr(), len) : '';
  }

  /* --------------------------------------------------- snapshot store (IDB) */
  var DB_NAME = 'w98-kernel', DB_STORE = 'snap';
  function idbRead(keys) {
    return new Promise(function (resolve) {
      if (!global.indexedDB) return resolve({});
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onerror = function () { resolve({}); };
      req.onblocked = function () { resolve({}); };
      req.onsuccess = function () {
        var db = req.result, out = {}, pending = keys.length;
        if (!pending) { db.close(); return resolve(out); }
        var tx = db.transaction(DB_STORE, 'readonly');
        var st = tx.objectStore(DB_STORE);
        tx.onerror = function () { db.close(); resolve({}); };
        keys.forEach(function (k) {
          var r = st.get(k);
          r.onsuccess = function () { out[k] = r.result; if (--pending === 0) { db.close(); resolve(out); } };
          r.onerror = function () { if (--pending === 0) { db.close(); resolve(out); } };
        });
      };
    });
  }
  function idbWrite(pairs) {
    return new Promise(function (resolve) {
      if (!global.indexedDB) return resolve(false);
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onerror = function () { resolve(false); };
      req.onblocked = function () { resolve(false); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction(DB_STORE, 'readwrite');
        var st = tx.objectStore(DB_STORE);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
        Object.keys(pairs).forEach(function (k) { st.put(pairs[k], k); });
      };
    });
  }
  function markDirty() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, 1200);
  }
  function flush() {
    if (!dirty || !wasm) return Promise.resolve(false);
    dirty = false;
    var fsBlob, regBlob;
    try {
      var n = wasm.k_fs_save();
      fsBlob = readText(wasm.k_tmp_ptr(), n);
      n = wasm.k_reg_save();
      regBlob = readText(wasm.k_tmp_ptr(), n);
    } catch (e) { return Promise.resolve(false); }
    flushCount++;
    return idbWrite({ fs: fsBlob, reg: regBlob, savedAt: Date.now() });
  }
  /* ------------------------------------------------ persistent state bridge */
  /* Restore points use the kernel's own KFS1/KREG serializer.  Keep this
     small bridge here instead of teaching an application how to walk the
     filesystem or hive.  The bridge also gives the JS shim the same shape so
     the System Restore UI can remain usable when WebAssembly is unavailable. */
  function persistentStateWasm() {
    if (!wasm) return null;
    var n = wasm.k_fs_save();
    var fsBlob = readText(wasm.k_tmp_ptr(), n);
    n = wasm.k_reg_save();
    var regBlob = readText(wasm.k_tmp_ptr(), n);
    return { fs: fsBlob, reg: regBlob };
  }
  function replacePersistentStateWasm(state) {
    if (!wasm || !state) return 0;
    var count = 0, a = pushText(state.fs), b = pushText(state.reg);
    try {
      count += wasm.k_fs_load(a.p, a.n);
      count += wasm.k_reg_load(b.p, b.n);
    } finally {
      wasm.k_free(a.p); wasm.k_free(b.p);
    }
    /* Persist the replaced state immediately.  This is deliberately separate
       from the ordinary dirty timer: a subsequent reload must see the point
       even if the browser closes before the next heartbeat. */
    dirty = true;
    return flush().then(function () { return count; });
  }
  function restore() {
    var load = idbRead(['fs', 'reg']).then(function (out) {
      var n = 0;
      if (out && out.fs) { var a = pushText(out.fs); n += wasm.k_fs_load(a.p, a.n); wasm.k_free(a.p); }
      if (out && out.reg) { var b = pushText(out.reg); wasm.k_reg_load(b.p, b.n); wasm.k_free(b.p); }
      return n;
    }).catch(function () { return 0; });
    return Promise.race([
      load,
      new Promise(function (res) {
        setTimeout(function () { API.restoreTimedOut = true; res(0); }, 3000);
      })
    ]);
  }

  /* --------------------------------------------------------------- the shim */
  /* Minimal stand-in used only when kernel.wasm cannot be loaded, so that the
     desktop still starts.  Reports mode='shim' everywhere it is visible. */
  function makeShim() {
    var files = new Map(), dirs = new Set(['C:\\', 'A:\\', 'C:\\WINDOWS', 'C:\\My Documents',
      'C:\\Program Files', 'C:\\Recycled', 'C:\\WINDOWS\\SYSTEM', 'C:\\WINDOWS\\DESKTOP',
      'C:\\WINDOWS\\MEDIA', 'C:\\WINDOWS\\START MENU', 'C:\\WINDOWS\\START MENU\\PROGRAMS']);
    var reg = new Map(), procs = [], nextPid = 1, timers = new Map(), nextTid = 1;
    var st = {}; for (var k in ST) st[k] = 0;
    var started = Date.now();
    function up(p) { return normPath(p); }
    function parent(p) { var i = p.lastIndexOf('\\'); return i <= 2 ? p.slice(0, 3) : p.slice(0, i); }
    var fs = {
      exists: function (p) { p = up(p); return files.has(p) || dirs.has(p) || p === 'C:\\' || p === 'A:\\'; },
      isDir: function (p) { p = up(p); return dirs.has(p) || p === 'C:\\' || p === 'A:\\'; },
      size: function (p) { var b = files.get(up(p)); return b ? b.length : -1; },
      readBytes: function (p) { var b = files.get(up(p)); return b ? b.slice() : null; },
      readText: function (p) { var b = files.get(up(p)); return b ? dec.decode(b) : null; },
      writeBytes: function (p, d) {
        p = up(p);
        var arr = (d instanceof Uint8Array) ? d : new Uint8Array(d);
        dirs.add(parent(p));
        files.set(p, arr);
        markDirty();
        return arr.length;
      },
      writeText: function (p, s) { return this.writeBytes(p, enc.encode(s)); },
      list: function (p) {
        p = up(p);
        if (!this.exists(p) || !this.isDir(p)) return null;
        var pre = p.endsWith('\\') ? p : p + '\\', seen = {}, out = [];
        dirs.forEach(function (d) {
          if (d !== p && d.indexOf(pre) === 0 && d.slice(pre.length).indexOf('\\') < 0)
            seen[d.slice(pre.length)] = { name: d.slice(pre.length), dir: true, size: 0, mtime: 0 };
        });
        files.forEach(function (b, f) {
          if (f.indexOf(pre) === 0 && f.slice(pre.length).indexOf('\\') < 0)
            seen[f.slice(pre.length)] = { name: f.slice(pre.length), dir: false, size: b.length, mtime: 0 };
        });
        for (var k2 in seen) out.push(seen[k2]);
        out.sort(function (x, y) { return x.dir !== y.dir ? (x.dir ? -1 : 1) : (x.name < y.name ? -1 : 1); });
        return out;
      },
      mkdir: function (p) { dirs.add(up(p)); markDirty(); return 0; },
      remove: function (p) {
        p = up(p);
        var pre = p + '\\', n = 0;
        files.forEach(function (v, f) { if (f === p || f.indexOf(pre) === 0) { files.delete(f); n++; } });
        Array.from(dirs).forEach(function (d) { if (d === p || d.indexOf(pre) === 0) dirs.delete(d); });
        markDirty();
        return 0;
      },
      rename: function (from, to) {
        var f = up(from), t = up(to), b = files.get(f);
        if (b) { files.delete(f); files.set(t, b); }
        if (dirs.has(f)) { dirs.delete(f); dirs.add(t); }
        markDirty();
        return 0;
      },
      stat: function (p) { var b = files.get(up(p)); return this.exists(p) ? { name: up(p).split('\\').pop(), dir: this.isDir(p), size: b ? b.length : 0 } : null; }
    };
    var regApi = {
      get: function (path, name, dflt) {
        var v = reg.get(path + '\\' + name);
        if (v === undefined) return dflt === undefined ? null : dflt;
        return v;
      },
      set: function (path, name, v) { reg.set(path + '\\' + name, String(v)); markDirty(); return true; },
      del: function (path, name) { var r = reg.delete(path + '\\' + name); markDirty(); return r; }
    };
    function shimSave() {
      var fs = ['KFS1'];
      Array.from(files.keys()).sort().forEach(function (p) {
        var b = files.get(p) || new Uint8Array(0);
        fs.push('0|0|' + b.length + '|' + p + '|' + b64Encode(b));
      });
      Array.from(dirs).sort().forEach(function (p) {
        if (p === 'C:\\' || p === 'A:\\') return;
        if (!files.has(p)) fs.push('1|0|0|' + p + '|');
      });
      var rs = ['KREG1'];
      Array.from(reg.keys()).sort().forEach(function (key) {
        var at = key.lastIndexOf('\\');
        var path = at < 0 ? key : key.slice(0, at);
        var name = at < 0 ? '' : key.slice(at + 1);
        rs.push(path + '\t' + name + '\t' + b64Encode(enc.encode(String(reg.get(key)))));
      });
      return { fs: fs.join('\n') + '\n', reg: rs.join('\n') + '\n' };
    }
    function shimLoad(state) {
      var fsLines = String(state.fs).split(/\r?\n/), regLines = String(state.reg).split(/\r?\n/);
      var nf = new Map(), nd = new Set(['C:\\', 'A:\\']);
      if (fsLines.shift() !== 'KFS1') throw new Error('unsupported filesystem image');
      fsLines.forEach(function (line) {
        if (!line) return;
        var p = line.split('|');
        if (p.length < 5 || (p[0] !== '0' && p[0] !== '1') || !p[3]) throw new Error('malformed filesystem image');
        var path = up(p[3]), size = Number(p[2]);
        if (!Number.isInteger(size) || size < 0) throw new Error('malformed filesystem size');
        if (p[0] === '1') { nd.add(path); return; }
        var data = b64Decode(p.slice(4).join('|'));
        if (data.length !== size) throw new Error('filesystem size mismatch');
        nf.set(path, data); nd.add(parent(path));
      });
      var regHeader = regLines.shift();
      if (regHeader !== 'KREG1' && regHeader !== 'KREG2') throw new Error('unsupported registry image');
      var nr = new Map();
      regLines.forEach(function (line) {
        if (!line) return;
        var p = line.split('\t');
        var data;
        if (regHeader === 'KREG2') {
          if (p.length < 4 || !p[0]) throw new Error('malformed registry image');
          data = b64Decode(p.slice(3).join('\t'));
        } else {
          if (p.length < 3 || !p[0]) throw new Error('malformed registry image');
          data = b64Decode(p.slice(2).join('\t'));
        }
        nr.set(p[0] + '\\' + p[1], dec.decode(data));
      });
      files = nf; dirs = nd; reg = nr; markDirty();
      return nf.size + nr.size;
    }
    function shimFlush() {
      var state = shimSave();
      return idbWrite({ fs: state.fs, reg: state.reg, savedAt: Date.now() });
    }
    function shimRestore() {
      return idbRead(['fs', 'reg']).then(function (out) {
        if (!out || !out.fs || !out.reg) return 0;
        return shimLoad({ fs: out.fs, reg: out.reg });
      });
    }
    function shimReplace(state) { return Promise.resolve(shimLoad(state)).then(function (n) { return shimFlush().then(function () { return n; }); }); }
    return {
      mode: 'shim',
      fs: fs, reg: regApi,
      procs: {
        create: function (name) { var p = { pid: nextPid++, name: name, state: PS.RUNNING, z: 0, cpuUs: 0, started: Date.now() - started, flags: 0 }; procs.push(p); st.PROCS++; st.NDESC = procs.length; return p.pid; },
        destroy: function (pid) { procs = procs.filter(function (p) { return p && p.pid !== pid; }); st.NDESC = procs.length; return 0; },
        count: function () { return procs.length; },
        list: function () { return procs.map(function (p) { return Object.assign({}, p); }); },
        setState: function (pid, s) { var p = procs.find(function (q) { return q.pid === pid; }); if (p) p.state = s; return 0; },
        setZ: function (pid, z) { var p = procs.find(function (q) { return q.pid === pid; }); if (p) p.z = z; return 0; },
        getField: function (pid, f) { return this.list().find(function (p) { return p.pid === pid; })[f === PF.STATE ? 'state' : 'z'] || 0; },
        focus: function (pid) { st.CURRENT = pid; },
        current: function () { return st.CURRENT; },
        terminate: function (pid) { return this.destroy(pid); }
      },
      setTimer: function (cb, ms, oneshot) {
        var tid = nextTid++;
        var h = oneshot ? setTimeout(fire, ms) : setInterval(fire, ms);
        function fire() { cb(Date.now()); if (oneshot) timers.delete(tid); }
        timers.set(tid, h);
        return tid;
      },
      clearTimer: function (tid) {
        var h = timers.get(tid);
        if (h === undefined) return;
        clearTimeout(h); clearInterval(h); timers.delete(tid);
      },
      tick: function () { st.TICKS++; st.UPTIME = Date.now() - started; return 0; },
      stats: function () { st.HEAP_SIZE = 8 * 1024 * 1024; st.HEAP_USED = 0; st.HEAP_FREE = 8 * 1024 * 1024; st.NODES = dirs.size + files.size; st.FILES = files.size; st.REG = reg.size; st.QUEUE = timers.size; st.TMP_CAP = 0; st.VERSION = 0; st.SYSCALLS = 0; st.HEAP_USED = files.size * 4096; return Object.assign({}, st); },
      logText: function () { return '[shim] kernel.wasm unavailable; running the reduced JS fallback.\n'; },
      flush: shimFlush,
      capturePersistentState: shimSave,
      replacePersistentState: shimReplace,
      restore: shimRestore,
      seedExtras: true
    };
  }

  /* ------------------------------------------------------------------ boot */
  API.boot = function () {
    if (API.ready) return API.ready;
    API.ready = new Promise(function (resolve) {
      var url = 'wasm/kernel.wasm';
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var mod = new WebAssembly.Module(buf);
        var inst = new WebAssembly.Instance(mod, {});
        wasm = inst.exports;
        if (!wasm.memory || typeof wasm.k_init !== 'function') throw new Error('not a kernel image');
        API.moduleBytes = buf.byteLength;
        wasm.k_init((Date.now() ^ 0x1998) >>> 0);
        wasm.k_seed((Date.now() & 0x7fffffff) >>> 0);
        API.mode = 'wasm';
        API.version = wasm.k_version();
        API.normPath = normPath;
        API.regCount = function () { return wasm.k_reg_enum_count(); };
        API.regEnum = function (i) {
          if (wasm.k_reg_enum(i) !== 1) return null;
          return {
            path: readText(wasm.k_reg_enum_path_ptr(), wasm.k_reg_enum_path_len()),
            name: readText(wasm.k_reg_enum_name_ptr(), wasm.k_reg_enum_name_len()),
            value: tmpText()
          };
        };
        API.fs = fsWasm();
        API.reg = regWasm();
        API.procs = procsWasm();
        API.setTimer = setTimer;
        API.clearTimer = clearTimer;
        API.tick = tick;
        API.stats = statsWasm;
        API.logText = logText;
        API.flush = flush;
        API.restore = restore;
        API.capturePersistentState = persistentStateWasm;
        API.replacePersistentState = replacePersistentStateWasm;
        API.exitCode = function (pid) { return wasm.k_proc_destroy(pid); };
        API.panic = function (code) { return wasm.k_panic(code || 7); };
        API.panicked = function () { return wasm.k_panicked(); };
        API.heapPeak = function () { return wasm.k_heap_peak(); };
        API.dbg = function () { return wasm; };
        /* the NT executive inside kernel.wasm: objects, handles, threads,
           dispatcher, IRPs, memory manager, hive, bugcheck.  k_stat indices
           from 100 up are delegated to the executive by the C layer. */
        API.exec = function () { return executive(wasm); };
        /* the kernel's VMBus transport: an IRP through the device stack, so
           messages the shell relays to a hypervisor channel are real I/O */
        API.vmbusTx = function (bytes) { return wasm.k_vmbus_tx(bytes >>> 0) >>> 0; };
        API.vmbusStats = function (which) { return wasm.k_vmbus_stats(which >>> 0) >>> 0; };
        API.halt = function (code) {
          var r = wasm.k_bugcheck((code >>> 0) || 0x0000007B, 0, 0, 0, 0);
          return r;
        };
        if (global.W98) (W98.__bootTrace = W98.__bootTrace || []).push('kernel: instantiated, restoring');
        return restore().then(function (n) {
          API.restoredRecords = n;
          if (global.W98) W98.__bootTrace.push('kernel: restored ' + n);
          return true;
        });
      }).catch(function (e) {
        API.error = String(e && e.message || e);
        var shim = makeShim();
        for (var k in shim) if (k !== 'mode') API[k] = shim[k];
        API.mode = 'shim';
        API.seedExtras = true;
        if (global.console) console.warn('kernel.wasm failed to load, using shim:', API.error);
        return shim.restore().catch(function () { return 0; });
      }).then(function () {
        resolve(API);          /* the boot promise must actually settle */
      });
    }).then(function () {
      if (global.W98) W98.__bootTrace.push('kernel: ready event');
      global.dispatchEvent(new CustomEvent('w98-kernel-ready', { detail: { mode: API.mode } }));
      return API;
    }).catch(function (e) {
      if (global.W98) W98.__bootTrace.push('kernel: boot REJECTED ' + (e && e.message));
      if (global.console) console.error('kernel boot rejected', e);
      return API;
    });
    return API.ready;
  };

  API.normPath = normPath;
  API.regCount = function () { return wasm ? wasm.k_reg_enum_count() : 0; };
  API.regEnum = function (i) {
    if (!wasm || wasm.k_reg_enum(i) !== 1) return null;
    return {
      path: readText(wasm.k_reg_enum_path_ptr(), wasm.k_reg_enum_path_len()),
      name: readText(wasm.k_reg_enum_name_ptr(), wasm.k_reg_enum_name_len()),
      value: tmpText()
    };
  };
  global.W98Kernel = API;
  global.addEventListener('pagehide', function () { if (wasm && dirty) flush(); });
  global.addEventListener('beforeunload', function () { if (wasm && dirty) flush(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && wasm && dirty) flush();
  });
})(window);
