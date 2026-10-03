/* ============================================================================
   hvmanager.js — Hyper-V Manager.  A management console in the 1998 style:
   a tree pane holding the hypervisor and its partitions, and a results pane
   with one tab per aspect of the machine.  Every number on screen is read from
   the W98HV hypervisor API (HV_ABI.md, section 4) on a kernel-scheduled poll;
   with no hypervisor running the console says so and shows nothing else.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98;
  if (!W98) return;
  var I = window.W98Icons;
  var U = W98.util;
  var el = U.el, esc = U.escapeHtml;

  /* HV_ABI.md 2.1 — partition states, in the order hv_partition_field reports */
  var PART_STATE = ['Empty', 'Created', 'Initialized', 'Running', 'Paused', 'Stopped', 'Faulted', 'Deleted'];

  /* HV_ABI.md 2.3 — the hypercall codes, printed as a legend next to the totals */
  var HC_CODES = [
    ['0x0011', 'HvCallGetHypervisorInfo'],
    ['0x0012', 'HvCallGetReferenceTime'],
    ['0x0013', 'HvCallGetVpIndex'],
    ['0x0040', 'HvCallCreatePartition'],
    ['0x0041', 'HvCallInitializePartition'],
    ['0x0043', 'HvCallDepositMemory'],
    ['0x0047', 'HvCallCreateVp'],
    ['0x0050', 'HvCallSetVpRegisters'],
    ['0x0053', 'HvCallMapGpaPages'],
    ['0x005C', 'HvCallPostMessage'],
    ['0x005D', 'HvCallSignalEvent'],
    ['0x0060', 'HvCallEnableHypercallPage'],
    ['0x0061', 'HvCallVmbusOpenChannel'],
    ['0x0062', 'HvCallVmbusCloseChannel'],
    ['0x0063', 'HvCallVmbusSignal'],
    ['0x0070', 'HvCallQueryMsr'],
    ['0x0071', 'HvCallSetMsr'],
    ['0x0072', 'HvCallCpuid'],
    ['0x0090', 'HvCallHalt']
  ];

  /* HV_ABI.md 2.4 — the virtualised MSRs */
  var MSR_NAMES = {
    0x40000000: 'HV_X64_MSR_GUEST_OS_ID',
    0x40000001: 'HV_X64_MSR_HYPERCALL',
    0x40000002: 'HV_X64_MSR_VP_INDEX',
    0x40000020: 'HV_X64_MSR_TIME_REF_COUNT',
    0x40000021: 'HV_X64_MSR_REFERENCE_TSC',
    0x40000080: 'HV_X64_MSR_SCONTROL',
    0x40000082: 'HV_X64_MSR_SIEFP',
    0x40000083: 'HV_X64_MSR_SIMP',
    0x40000084: 'HV_X64_MSR_EOM'
  };

  var TAB_TITLES = ['Summary', 'Memory / SLAT', 'Hypercalls', 'VMBus', 'SynIC', 'MSR Log', 'Framebuffer'];
  var TAB_LABELS = ['&Summary', '&Memory / SLAT', '&Hypercalls', 'V&MBus', 'S&ynIC', 'MS&R Log', '&Framebuffer'];

  /* ---------------------------------------------------------------- helpers */
  /* The documented surface is the global W98HV (HV_ABI.md section 4).  The
     build in web/js/hv.js exposes the same hypervisor as W98.hv with different
     method names, so that object is adapted to the documented shape instead of
     showing a dead console.  Every accessor forwards to the hypervisor: no
     value is invented here, and values this build cannot report stay blank. */
  var adapted = null, adaptedSrc = null;
  function hvSurface() {
    var g;
    try { g = window; } catch (e) { return null; }
    var direct = g.W98HV;
    if (direct && typeof direct.partitions === 'function') return direct;
    var hv = g.W98 && g.W98.hv;
    if (hv && typeof hv.partitionList === 'function' && typeof hv.create === 'function') {
      if (adaptedSrc !== hv) {
        adapted = adaptW98Hv(hv);
        adaptedSrc = hv;
      }
      return adapted;
    }
    return null;
  }
  function adaptW98Hv(hv) {
    function call(fn, dflt) {
      try {
        var v = fn();
        return v === undefined ? dflt : v;
      } catch (e) { return dflt; }
    }
    function ascii(u) {
      if (typeof u !== 'number' || !u) return '';
      var s = '', i, b;
      for (i = 24; i >= 0; i -= 8) {
        b = (u >>> i) & 0xff;
        if (b < 32 || b > 126) return '';
        s += String.fromCharCode(b);
      }
      return s;
    }
    function hex32(x) {
      if (typeof x !== 'number') return '';
      return '0x' + ('00000000' + (x >>> 0).toString(16).toUpperCase()).slice(-8);
    }
    function vpsOf(id) { return call(function () { return hv.vpList(id); }, []) || []; }
    var api = { _adapted: true, ready: hv.ready || null };
    Object.defineProperty(api, 'mode', {
      get: function () { return hv.mode === 'wasm' ? 'wasm' : 'none'; }, enumerable: true
    });
    Object.defineProperty(api, 'error', {
      get: function () { return hv.error || null; }, enumerable: true
    });
    api.info = function () {
      var lim = call(function () { return hv.limits(); }, {}) || {};
      var sig = call(function () { return hv.signature(); }, null);
      return {
        version: hex32(call(function () { return hv.version(); }, null)),
        vendor: call(function () { return hv.vendor(); }, '') || '',
        signature: ascii(sig) || hex32(sig),
        maxPartitions: lim.maxPartitions,
        maxVps: lim.maxVps,
        refTimeMs: call(function () { return hv.refTime(); }, null),
        hypercallCount: call(function () { return hv.hypercalls(); }, null),
        slatFaults: call(function () { return hv.slatFaults(); }, null),
        moduleBytes: typeof hv.moduleBytes === 'number' ? hv.moduleBytes : null
      };
    };
    api.partitions = function () {
      var list = call(function () { return hv.partitionList(); }, []) || [];
      return list.map(function (p) {
        return {
          id: p.id, name: p.name, state: p.state, stateName: p.stateName,
          vps: p.vps, memoryBytes: p.mappedBytes, mappedPages: p.mappedPages,
          deposits: p.deposits, hypercalls: p.hypercalls, faults: p.faults, runs: p.runs,
          mappedBytes: p.mappedBytes, canaryFaults: p.canaryFaults,
          root: p.root, hasGuest: p.hasGuest
        };
      });
    };
    api.vps = function () {
      var out = [];
      api.partitions().forEach(function (p) {
        vpsOf(p.id).forEach(function (v) {
          out.push({
            id: v.id, partition: p.id, index: v.index, state: v.state, stateName: v.stateName,
            runMs: v.runMs, hypercalls: v.hypercalls, faults: v.faults, instr: v.instr,
            sliceLeft: v.sliceLeft, preempts: v.preempts,
            synic: v.synic, sints: v.sints, timer: v.timer, registers: v.registers
          });
        });
      });
      return out;
    };
    api.createPartition = function (name) { return call(function () { return hv.create(name); }, 0); };
    api.startPartition = function (id) { return call(function () { return hv.start(id); }, -1); };
    api.pausePartition = function (id) { return call(function () { return hv.pause(id); }, -1); };
    api.resumePartition = function (id) { return call(function () { return hv.resume(id); }, -1); };
    api.stopPartition = function (id) { return call(function () { return hv.stop(id); }, -1); };
    api.resetPartition = function (id) { return call(function () { return hv.reset(id); }, -1); };
    api.deletePartition = function (id) { return call(function () { return hv.remove(id); }, -1); };
    api.checkpoints = function () { return call(function () {
      return typeof hv.checkpoints === 'function' ? hv.checkpoints() : [];
    }, []) || []; };
    api.checkpointList = api.checkpoints;
    api.createCheckpoint = function (id) { return call(function () {
      return typeof hv.createCheckpoint === 'function' ? hv.createCheckpoint(id) : 0;
    }, 0); };
    api.restoreCheckpoint = function (cp, id) { return call(function () {
      return typeof hv.restoreCheckpoint === 'function' ? hv.restoreCheckpoint(cp, id) : 7;
    }, 7); };
    api.deleteCheckpoint = function (cp) { return call(function () {
      return typeof hv.deleteCheckpoint === 'function' ? hv.deleteCheckpoint(cp) : 7;
    }, 7); };
    api.cloneCheckpoint = function (cp, name) { return call(function () {
      return typeof hv.cloneCheckpoint === 'function' ? hv.cloneCheckpoint(cp, name) : 0;
    }, 0); };
    api.clonePartition = function (id, name) { return call(function () {
      return typeof hv.clonePartition === 'function' ? hv.clonePartition(id, name) : 0;
    }, 0); };
    api.checkpointStatus = function () { return call(function () {
      return typeof hv.checkpointStatus === 'function' ? hv.checkpointStatus() : { code: 7, name: 'not implemented', ok: false };
    }, { code: 7, name: 'not implemented', ok: false }); };
    api.checkpointLimits = function () { return call(function () {
      return typeof hv.checkpointLimits === 'function' ? hv.checkpointLimits() : { maxBytes: 0, formatVersion: 0 };
    }, { maxBytes: 0, formatVersion: 0 }); };
    api.memoryMap = function () { return null; };   /* this build cannot enumerate SLAT mappings */
    api.framebuffer = function (id) {
      var rgba = call(function () { return hv.guestScreen(id); }, null);
      if (!rgba) return null;
      return { gpa: 0x10000, width: hv.FB_W || 400, height: hv.FB_H || 120, rgba: rgba };
    };
    api.synic = function (id) {
      var vps = vpsOf(id);
      if (!vps.length || !vps[0].synic) return null;
      var s = vps[0].synic;
      return {
        scontrol: s.scontrol, simp: s.simp, siefp: s.siefp,
        messages: s.messages, dropped: s.dropped, sints: vps[0].sints || []
      };
    };
    api.msrLog = function (id) { return call(function () { return hv.msrLog(id, 32); }, []) || []; };
    api.vmbus = function () {
      var v = call(function () { return hv.vmbus(); }, null);
      if (!v) return [];
      if (Object.prototype.toString.call(v) === '[object Array]') return v;
      return v.channels || [];
    };
    api.hypervisorLog = function () { return call(function () { return hv.log(); }, '') || ''; };
    api.step = function (ms) { return call(function () { return hv.pump(ms); }, 0); };
    api.stats = function () {
      var mem = call(function () { return hv.memory(); }, {}) || {};
      var sch = call(function () { return hv.sched(); }, {}) || {};
      var vb = call(function () { return hv.vmbus(); }, null) || {};
      var vbs = vb.stats || {};
      var hb = 0, withGuest = 0;
      api.partitions().forEach(function (p) {
        var g = call(function () { return hv.guestFields(p.id); }, null);
        if (g && typeof g.heartbeat === 'number') hb += g.heartbeat;
        if (p.hasGuest) withGuest++;
      });
      return {
        hypercalls: call(function () { return hv.hypercalls(); }, null),
        slatFaults: call(function () { return hv.slatFaults(); }, null),
        heartbeats: hb,
        partitionsWithGuest: withGuest,
        memoryTotal: mem.total, memoryPresent: mem.present,
        memoryDeposited: mem.deposited, memoryFree: mem.free, deposits: mem.deposits,
        slices: sch.slices, preemptions: sch.preemptions, ctxSwitches: sch.ctxSwitches,
        idleSlices: sch.idleSlices, runnable: sch.runnable,
        vmbusMessages: vbs.messages, vmbusInBytes: vbs.inBytes, vmbusOutBytes: vbs.outBytes,
        refTimeMs: call(function () { return hv.refTime(); }, null)
      };
    };
    /* this build has no push callback, so the guest log and the VMBus rings are
       polled and the new lines are handed over in the documented message shape */
    var handlers = [], seenLog = {}, pollTimer = null;
    function emit(msg) {
      handlers.slice().forEach(function (fn) {
        try { fn(msg); } catch (e) { /* ignore */ }
      });
    }
    api.onGuestMessage = function (fn) {
      if (typeof fn !== 'function') return;
      handlers.push(fn);
      if (!pollTimer && typeof setInterval === 'function') pollTimer = setInterval(pump, 300);
    };
    function pump() {
      if (!handlers.length || api.mode !== 'wasm') return;
      api.partitions().forEach(function (p) {
        var text = call(function () { return hv.guestLog(p.id); }, '') || '';
        var prev = seenLog[p.id];
        if (typeof prev === 'string' && text.length > prev.length && text.indexOf(prev) === 0) {
          text.slice(prev.length).split('\n').forEach(function (line) {
            if (line) emit({ partition: p.id, text: line, bytes: null });
          });
        }
        seenLog[p.id] = text;
        var chans = api.vmbus();
        chans.forEach(function (c) {
          if (c.partition !== p.id) return;
          for (var k = 0; k < 4; k++) {
            var m = call(function () { return hv.vmbusDrain(c.id); }, null);
            if (!m) break;
            if (m.payload) emit({ partition: p.id, text: String(m.payload), bytes: null });
          }
        });
      });
    }
    return api;
  }
  function safe(fn, dflt) {
    try {
      var v = fn();
      return (v === undefined || v === null) ? dflt : v;
    } catch (e) { return dflt; }
  }
  function arr(fn) {
    var v = safe(fn, null);
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  }
  function str(x) { return x == null ? '' : String(x); }
  /* the hypervisor may report its signature as a packed 4-character value
     ("Hv#1") or as the raw u32 it lives in; show whichever it gave us */
  function sigText(info) {
    if (!info) return '-';
    if (typeof info.signatureText === 'string' && info.signatureText) {
      return info.signatureText + (num(info.signature) != null ? ' (0x' + (num(info.signature) >>> 0).toString(16).toUpperCase() + ')' : '');
    }
    if (typeof info.signature === 'string' && info.signature) return info.signature;
    var n = num(info.signature);
    if (n == null) return '-';
    var s = '', i, b;
    for (i = 24; i >= 0; i -= 8) {
      b = (n >>> i) & 0xff;
      if (b < 32 || b > 126) { s = ''; break; }
      s += String.fromCharCode(b);
    }
    return s || ('0x' + (n >>> 0).toString(16).toUpperCase());
  }
  function verText(info) {
    if (!info) return '-';
    if (typeof info.versionText === 'string' && info.versionText) return info.versionText;
    if (typeof info.version === 'string' && info.version) return info.version;
    var n = num(info.version);
    return n == null ? '-' : '0x' + (n >>> 0).toString(16).toUpperCase();
  }
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function fmtNum(x) {
    var n = num(x);
    if (n == null) return '-';
    var s = String(n), out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
  }
  function fmtHex(x, width) {
    var n = num(x);
    if (n == null) return '-';
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < (width || 8)) s = '0' + s;
    return '0x' + s;
  }
  function fmtMs(ms) {
    var n = num(ms);
    if (n == null) return '-';
    return n < 1000 ? n + ' ms' : (n / 1000).toFixed(2) + ' s';
  }
  function fmtBytes(b) {
    var n = num(b);
    if (n == null) return '-';
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function partStateCode(p) { return p ? num(p.state) : null; }
  function partStateName(p) {
    if (p && typeof p.stateName === 'string' && p.stateName) return p.stateName;
    var c = partStateCode(p);
    if (c == null) return 'Unknown';
    return PART_STATE[c] != null ? PART_STATE[c] : 'State ' + c;
  }
  function vpStateName(v) {
    if (v && typeof v.stateName === 'string' && v.stateName) return v.stateName;
    var c = v ? num(v.state) : null;
    return c == null ? '-' : String(c);
  }
  function msrName(msr) {
    var n = num(msr);
    if (n == null) return '';
    if (MSR_NAMES[n]) return MSR_NAMES[n];
    if (n >= 0x40000090 && n <= 0x4000009f) return 'HV_X64_MSR_SINT' + (n - 0x40000090);
    return '';
  }
  function bytesToText(b) {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    var out = '', i;
    try {
      for (i = 0; i < b.length && i < 4096; i++) {
        var c = b[i];
        out += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? '' : '.');
      }
    } catch (e) { return out; }
    return out;
  }
  /* W98HV.onGuestMessage may be a single-callback hook (the build in
     web/js/hv.js keeps one), so subscribe through a small fan-out bus: the
     manager and the console then both see every message the guest posts. */
  function subscribeGuest(fn) {
    if (typeof fn !== 'function') return false;
    var h = hvSurface();
    if (!h || typeof h.onGuestMessage !== 'function') return false;
    var g;
    try { g = window; } catch (e) { return false; }
    var bus = g.__w98HvMsgBus;
    if (!bus) {
      bus = g.__w98HvMsgBus = { subs: [], installed: false };
    }
    bus.subs.push(fn);
    if (!bus.installed) {
      bus.installed = true;
      try {
        h.onGuestMessage(function (m) {
          bus.subs.slice().forEach(function (f) {
            try { f(m); } catch (e) { /* a listener must not break delivery */ }
          });
        });
      } catch (e) {
        bus.installed = false;
        bus.subs.pop();
        return false;
      }
    }
    return true;
  }
  function snd(which) {
    try {
      if (W98.sound && typeof W98.sound[which] === 'function') W98.sound[which]();
    } catch (e) { /* silence */ }
  }
  function unavailableReason(h) {
    if (!h) return 'The hypervisor glue (web/js/hv.js) is not loaded in this build.';
    var r = h.reason || h.error || h.message || h.statusText;
    if (typeof r === 'string' && r) return r;
    if (h.mode !== 'wasm') return 'hypervisor.wasm has not been loaded, so no hypervisor is running on this machine.';
    return 'The hypervisor did not report itself as available.';
  }

  W98.registerApp({
    id: 'hvmanager',
    title: 'Hyper-V Manager',
    icon: 'system',
    width: 620, height: 420,
    minWidth: 520, minHeight: 300,
    resizable: true,
    singleton: true,
    startMenuGroup: 'System Tools',
    create: function (win) {

      /* ------------------------------------------------------------ state */
      var tab = 0;
      var sel = { kind: 'root' };            /* {kind:'root'} | {kind:'part',id} | {kind:'vp',id,vpid} */
      var expandedRoot = true;
      var expanded = {};                     /* 'p<id>' -> true while a partition node is open */
      var treeSig = '';
      var menuSig = '';
      var flat = [];                         /* visible tree nodes, in keyboard order */
      var guestLog = [];                     /* messages delivered by W98HV.onGuestMessage */
      var closed = false;
      var loggerHooked = false;
      var readyHooked = false;
      var unavailable = false;
      var lastReason = '';
      var lastParts = [], lastVps = [], lastInfo = null, lastVmbus = [], lastCheckpoints = [];
      var lastCheckpointStatus = null, lastCheckpointLimits = null;

      /* ------------------------------------------------------------- chrome */
      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';

      var toolbar = el('div', 'w98-toolbar');
      win.el.appendChild(toolbar);

      var main = el('div', 'row');
      main.style.cssText = 'flex:1 1 auto;min-height:0;align-items:stretch;padding:2px;gap:2px';
      win.el.appendChild(main);

      var leftCol = el('div', 'col');
      leftCol.style.cssText = 'flex:0 0 200px;min-width:130px;gap:0';
      var treeHead = el('div');
      treeHead.style.cssText = 'height:17px;line-height:17px;padding:0 4px;background:#fff;overflow:hidden;' +
        'white-space:nowrap;text-overflow:ellipsis;' +
        'box-shadow:inset -1px -1px #dfdfdf, inset 1px 1px grey';
      var tree = el('ul', 'w98-tree');
      tree.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;margin:0';
      leftCol.appendChild(treeHead);
      leftCol.appendChild(tree);
      main.appendChild(leftCol);

      var rightCol = el('div', 'col');
      rightCol.style.cssText = 'flex:1 1 auto;min-width:0;min-height:0;gap:0;padding-left:4px';
      var paneHead = el('div');
      paneHead.style.cssText = 'height:17px;line-height:17px;padding:0 4px;font-weight:bold;overflow:hidden;white-space:nowrap';
      var tabs = el('div', 'w98-tabs');
      tabs.style.cssText = 'margin:2px 0 -2px 3px;flex-wrap:wrap;overflow:hidden;flex:0 0 auto';
      var page = el('div', 'w98-tabpage');
      page.style.cssText = 'overflow:auto;padding:8px;min-height:0';
      rightCol.appendChild(paneHead);
      rightCol.appendChild(tabs);
      rightCol.appendChild(page);
      main.appendChild(rightCol);

      TAB_TITLES.forEach(function (title, i) {
        var b = el('button', 'w98-tab', esc(title));
        b.style.cssText = 'min-width:0;padding:0 5px';
        b.onclick = function () { setTab(i); };
        tabs.appendChild(b);
      });

      /* ------------------------------------------------------------ actions */
      function currentPart() {
        if (sel.kind === 'root') return null;
        for (var i = 0; i < lastParts.length; i++) {
          if (lastParts[i] && lastParts[i].id === sel.id) return lastParts[i];
        }
        return null;
      }
      function isRootPart(p) {
        if (!p) return true;
        if (p.isRoot === true || p.root === true) return true;
        return /^root$/i.test(str(p.name));
      }
      function selectedPartId() {
        var p = currentPart();
        if (p) return p.id;
        var i, best = null;
        for (i = 0; i < lastParts.length; i++) {          /* a child with a guest wins */
          if (lastParts[i] && !isRootPart(lastParts[i]) && lastParts[i].hasGuest) return lastParts[i].id;
        }
        for (i = 0; i < lastParts.length; i++) {          /* then any child partition */
          if (lastParts[i] && !isRootPart(lastParts[i])) return lastParts[i].id;
        }
        for (i = 0; i < lastParts.length; i++) {          /* then whatever is there */
          if (lastParts[i]) { best = lastParts[i].id; break; }
        }
        return best;
      }
      function partitionsLimit() {
        var n = num(lastInfo && lastInfo.maxPartitions);
        return n == null ? 8 : n;
      }
      function availability() {
        var p = currentPart();
        var code = partStateCode(p);
        var lim = partitionsLimit();
        var can = {
          create: !unavailable && lastParts.length < lim,
          remove: !unavailable && !!p && code !== 3,
          start: !unavailable && !!p && (code === 0 || code === 1 || code === 2 || code === 5),
          pause: !unavailable && !!p && code === 3,
          resume: !unavailable && !!p && code === 4,
          stop: !unavailable && !!p && (code === 2 || code === 3 || code === 4 || code === 6),
          reset: !unavailable && !!p && (code === 3 || code === 4),
          save: !unavailable && !!p && (code === 2 || code === 3 || code === 4),
          checkpoint: !unavailable && !!p && !isRootPart(p),
          restoreCheckpoint: !unavailable && !!p && !isRootPart(p) && code !== 3,
          clone: !unavailable && !!p && !isRootPart(p) && lastParts.length < lim,
          act: !unavailable && !!p
        };
        return can;
      }
      function canCreate() { return availability().create; }

      function newPartition() {
        var h = hvSurface();
        if (!h || typeof h.createPartition !== 'function') {
          W98.dialog.alert('New Virtual Machine', 'This hypervisor build cannot create partitions (W98HV.createPartition is missing).', 'warn');
          return;
        }
        var defaultName = 'Partition ' + (lastParts.length + 1);
        var nameIn = el('input');
        nameIn.type = 'text';
        nameIn.value = defaultName;
        nameIn.style.width = '150px';
        var cpuSel = el('select');
        [1, 2, 4].forEach(function (n) {
          var o = el('option', '', String(n));
          o.value = String(n);
          cpuSel.appendChild(o);
        });
        cpuSel.style.width = '60px';
        var memIn = el('input');
        memIn.type = 'number';
        memIn.min = '1';
        memIn.max = '256';
        memIn.value = '16';
        memIn.style.width = '60px';

        function row(label, control) {
          var r = el('div', 'dlg-row');
          var l = el('div', '', esc(label));
          l.style.cssText = 'flex:0 0 96px';
          r.appendChild(l);
          r.appendChild(control);
          return r;
        }
        var extra = el('div');
        extra.appendChild(row('Name:', nameIn));
        extra.appendChild(row('Processors:', cpuSel));
        extra.appendChild(row('Memory (MB):', memIn));

        function build(box, dlg) {
          box.appendChild(extra);
          void dlg;
        }
        var p;
        if (typeof W98.dialog.messageBox === 'function') {
          p = W98.dialog.messageBox('New Virtual Machine',
            'Specify the name and the resources for the new partition.\n' +
            'The resources are passed to the hypervisor, which decides what it can give;\n' +
            'what it actually created is shown in the summary afterwards.',
            {
              kind: 'question', icon: 'system', width: 360,
              buttons: ['OK', 'Cancel'], results: ['ok', null],
              buildExtra: build
            });
        } else {
          p = W98.dialog.prompt('New Virtual Machine', 'Name for the new partition:', defaultName)
            .then(function (v) { return v == null ? null : 'ok'; });
        }
        p.then(function (r) {
          if (r !== 'ok') return;
          var name = String(nameIn.value || '').replace(/^\s+|\s+$/g, '') || defaultName;
          var cpus = parseInt(cpuSel.value, 10);
          if (!(cpus > 0)) cpus = 1;
          var mb = parseInt(memIn.value, 10);
          var opts = { cpus: cpus };
          if (mb > 0) opts.memoryBytes = mb * 1024 * 1024;
          var id = null;
          try {
            id = h.createPartition(name, opts);
          } catch (e) {
            W98.dialog.alert('Hyper-V Manager',
              'The hypervisor refused to create the partition.\n\n' + (e && e.message ? e.message : String(e)), 'error');
            return;
          }
          if (id != null) {
            sel = { kind: 'part', id: id };
            expanded['p' + id] = true;
          }
          refresh();
        });
      }

      function runAction(fnName, verb) {
        var h = hvSurface();
        var p = currentPart();
        if (!p) { snd('beep'); return; }
        if (!h || typeof h[fnName] !== 'function') {
          W98.dialog.alert('Hyper-V Manager',
            'This hypervisor build does not implement ' + fnName + '.', 'warn');
          return;
        }
        try {
          h[fnName](p.id);
        } catch (e) {
          W98.dialog.alert('Hyper-V Manager',
            'The hypervisor refused to ' + verb + ' "' + displayName(p) + '".\n\n' +
            (e && e.message ? e.message : String(e)), 'error');
          return;
        }
        refresh();
      }
      function confirmThen(title, text, fn) {
        W98.dialog.confirm(title, text).then(function (yes) { if (yes) fn(); });
      }
      function deletePartition() {
        var p = currentPart();
        if (!p) { snd('beep'); return; }
        confirmThen('Delete Partition',
          'Are you sure you want to delete "' + displayName(p) + '"?\n\n' +
          'The partition and its virtual processors are removed from the hypervisor.\n' +
          'This action cannot be undone.',
          function () { runAction('deletePartition', 'delete'); });
      }
      function checkpointStatusText(h) {
        var s = safe(function () { return h && typeof h.checkpointStatus === 'function' ? h.checkpointStatus() : null; }, null);
        if (!s) return 'The hypervisor did not report a checkpoint status.';
        if (typeof s === 'number') return 'status ' + s;
        return (s.name || ('status ' + (s.code == null ? '?' : s.code)));
      }
      function checkpointFailure(title, operation, h) {
        var status = safe(function () { return h && typeof h.checkpointStatus === 'function' ? h.checkpointStatus() : null; }, null);
        lastCheckpointStatus = status;
        var why = status && typeof status === 'object' ? (status.name || ('status ' + status.code)) : checkpointStatusText(h);
        W98.dialog.alert(title, 'The hypervisor could not ' + operation + '.\n\nReason: ' + why +
          '\n\nCheckpoint memory and serialization limits are enforced by hypervisor.wasm.', 'error');
      }
      function createCheckpoint() {
        var h = hvSurface(), p = currentPart();
        if (!p || !h || typeof h.createCheckpoint !== 'function') { snd('beep'); return; }
        var id = 0;
        try { id = h.createCheckpoint(p.id) >>> 0; } catch (e) { id = 0; }
        if (!id) { checkpointFailure('Create Checkpoint', 'create a checkpoint for "' + displayName(p) + '"', h); return; }
        lastCheckpointStatus = { code: 0, name: 'success', ok: true };
        refresh();
      }
      function checkpointRowsFor(id) {
        return lastCheckpoints.filter(function (c) {
          if (!c) return false;
          if (id == null) return true;
          if (c.partition === id || c.sourcePartition === id) return true;
          for (var i = 0; i < lastParts.length; i++) {
            var p = lastParts[i];
            if (p && p.id === id && p.identity != null && c.partition === p.identity) return true;
          }
          return false;
        });
      }
      function restoreCheckpoint(cp) {
        var h = hvSurface(), p = currentPart();
        if (!cp || !p || !h || typeof h.restoreCheckpoint !== 'function') { snd('beep'); return; }
        confirmThen('Restore Checkpoint',
          'Restore checkpoint ' + str(cp.id) + ' to "' + displayName(p) + '"?\n\n' +
          'The partition must be paused or stopped. Current guest state will be replaced.',
          function () {
            var st;
            try { st = h.restoreCheckpoint(cp.id, p.id); } catch (e) { st = -1; }
            if (st !== 0 && st !== true) { checkpointFailure('Restore Checkpoint', 'restore checkpoint ' + cp.id, h); return; }
            refresh();
          });
      }
      function deleteCheckpoint(cp) {
        var h = hvSurface();
        if (!cp || !h || typeof h.deleteCheckpoint !== 'function') { snd('beep'); return; }
        confirmThen('Delete Checkpoint',
          'Delete checkpoint ' + str(cp.id) + '?\n\nThis serialized state will be discarded.',
          function () {
            var st;
            try { st = h.deleteCheckpoint(cp.id); } catch (e) { st = -1; }
            if (st !== 0 && st !== true) { checkpointFailure('Delete Checkpoint', 'delete checkpoint ' + cp.id, h); return; }
            refresh();
          });
      }
      function clonePartition() {
        var h = hvSurface(), p = currentPart();
        if (!p || !h || typeof h.clonePartition !== 'function') { snd('beep'); return; }
        var defaultName = displayName(p) + ' Clone';
        W98.dialog.prompt('Clone Partition', 'Name for the cloned partition:', defaultName).then(function (name) {
          if (name == null) return;
          name = String(name).replace(/^\s+|\s+$/g, '') || defaultName;
          var id = 0;
          try { id = h.clonePartition(p.id, name) >>> 0; } catch (e) { id = 0; }
          if (!id) { checkpointFailure('Clone Partition', 'clone "' + displayName(p) + '"', h); return; }
          sel = { kind: 'part', id: id };
          expanded['p' + id] = true;
          refresh();
        });
      }
      function saveState() {
        var h = hvSurface();
        var p = currentPart();
        if (!p) { snd('beep'); return; }
        if (h && typeof h.saveState === 'function') { runAction('saveState', 'save the state of'); return; }
        W98.dialog.alert('Save State',
          'This hypervisor build has no save-state call: the API in HV_ABI.md section 4 has\n' +
          'no equivalent of HvCallSavePartitionState.\n\n' +
          'Use Pause to freeze "' + displayName(p) + '" instead.', 'info');
      }
      function about() {
        var lines = ['Microsoft Hyper-V Manager',
          'Version 4.10.1998 (kernel.wasm build)',
          'Copyright \u00a9 1981-1998 Microsoft Corporation', ''];
        if (unavailable) {
          lines.push('The hypervisor is not available on this machine.');
          lines.push('Reason: ' + lastReason);
        } else {
          var info = lastInfo || {};
          lines.push('Hypervisor:   ' + (str(info.vendor) || '-') + ' ' + sigText(info));
          lines.push('Version:      ' + verText(info));
          lines.push('Module:       ' + fmtBytes(num(info.moduleBytes)));
          lines.push('Limits:       ' + (num(info.maxPartitions) == null ? '-' : num(info.maxPartitions)) + ' partitions, ' +
            (num(info.maxVps) == null ? '-' : num(info.maxVps)) + ' virtual processors');
          lines.push('Reference time: ' + (num(info.refTimeMs) == null ? '-' : fmtNum(info.refTimeMs) + ' ms'));
          lines.push('');
          lines.push('Physical memory and partitions are managed inside hypervisor.wasm.');
        }
        W98.dialog.alert('About Hyper-V Manager', lines.join('\n'), 'info');
      }
      function helpTopics() {
        if (W98.getApp && W98.getApp('help')) { W98.launch('help'); return; }
        W98.dialog.alert('Hyper-V Manager Help',
          'Hyper-V Manager\n\nThe tree pane lists the hypervisor and every partition it owns;\n' +
          'open a partition to see its virtual processors.\n\n' +
          'The results pane has one tab per aspect of the machine: the summary, SLAT and\n' +
          'memory deposits, hypercall totals, VMBus channels, the SynIC, the virtual MSR\n' +
          'log and the guest framebuffer.', 'info');
      }

      /* ------------------------------------------------------------- polling */
      function ensureHooks() {
        var h = hvSurface();
        if (!loggerHooked && h && typeof h.onGuestMessage === 'function') {
          loggerHooked = subscribeGuest(onGuestMessage);
        }
        if (!readyHooked && h && h.ready && typeof h.ready.then === 'function') {
          readyHooked = true;
          try {
            h.ready.then(function () { refresh(); },
              function () { refresh(); });
          } catch (e) { /* ignore */ }
        }
      }
      function onGuestMessage(msg) {
        if (closed) return;
        var text = '';
        if (msg && typeof msg.text === 'string' && msg.text) text = msg.text;
        else if (msg && msg.bytes != null) text = bytesToText(msg.bytes);
        var part = msg ? num(msg.partition) : null;
        guestLog.push({
          partition: part,
          text: text || '(empty message)',
          at: num(safe(function () { return W98.tick(); }, null))
        });
        while (guestLog.length > 200) guestLog.shift();
      }

      function refresh() {
        if (closed) return;
        try {
          ensureHooks();
          var h = hvSurface();
          if (!h || typeof h.partitions !== 'function' || h.mode !== 'wasm') {
            unavailable = true;
            lastReason = unavailableReason(h);
            lastParts = []; lastVps = []; lastInfo = null; lastVmbus = []; lastCheckpoints = [];
            renderUnavailable(lastReason);
            syncMenu();
            return;
          }
          unavailable = false;
          lastInfo = safe(function () { return h.info(); }, null);
          lastParts = arr(function () { return h.partitions(); });
          lastVps = arr(function () { return h.vps(); });
          lastVmbus = arr(function () { return h.vmbus(); });
          lastCheckpoints = arr(function () {
            return typeof h.checkpoints === 'function' ? h.checkpoints() : [];
          });
          lastCheckpointLimits = safe(function () {
            return typeof h.checkpointLimits === 'function' ? h.checkpointLimits() : null;
          }, null);
          /* a partition can disappear under us (deleted elsewhere): fall back */
          if (sel.kind !== 'root') {
            var livePart = false, liveVp = false, i;
            for (i = 0; i < lastParts.length; i++) {
              if (lastParts[i] && lastParts[i].id === sel.id) { livePart = true; break; }
            }
            if (!livePart) { sel = { kind: 'root' }; }
            else if (sel.kind === 'vp') {
              for (i = 0; i < lastVps.length; i++) {
                if (lastVps[i] && lastVps[i].id === sel.vpid && lastVps[i].partition === sel.id) { liveVp = true; break; }
              }
              if (!liveVp) sel = { kind: 'part', id: sel.id };
            }
          }
          syncTree();
          renderPane();
          setStatus();
          syncMenu();
        } catch (e) {
          /* the console must never take the desktop down with it */
          try { console.error('hvmanager refresh', e); } catch (e2) { /* ignore */ }
        }
      }

      /* ---------------------------------------------------------- tree pane */
      function treePath() {
        var root = 'Hyper-V Manager\\' + (lastInfo && lastInfo.vendor ? str(lastInfo.vendor) : 'Hyper-V');
        if (sel.kind === 'root') return root;
        var p = currentPart();
        if (!p) return root;
        if (sel.kind === 'part') return root + '\\' + displayName(p);
        var vi = '';
        var i;
        for (i = 0; i < lastVps.length; i++) {
          if (lastVps[i] && lastVps[i].id === sel.vpid) { vi = str(lastVps[i].index); break; }
        }
        return root + '\\' + displayName(p) + '\\Virtual Processor ' + vi;
      }
      function displayName(p) {
        return str(p && (p.name || p.id)) || 'Partition';
      }
      function vpsOf(partId) {
        return lastVps.filter(function (v) { return v && v.partition === partId; });
      }

      function syncTree() {
        var info = lastInfo;
        var sig = 'u' + expandedRoot;
        lastParts.forEach(function (p) {
          if (!p) return;
          sig += '|' + str(p.id) + ':' + displayName(p) + ':' + partStateName(p) + ':' + (expanded['p' + p.id] ? 1 : 0) +
            ':' + vpsOf(p.id).length;
        });
        sig += '#' + str(info && info.vendor) + str(info && info.signature) + str(info && info.version);
        sig += '!' + selKey();
        if (sig === treeSig) { markSelection(); return; }
        treeSig = sig;

        var scroll = tree.scrollTop;
        tree.innerHTML = '';
        flat = [];

        var rootLi = el('li');
        var rtw = el('div', 'tw', partsHaveVps() ? (expandedRoot ? '-' : '+') : '');
        if (!partsHaveVps()) rtw.className = 'tw empty';
        var rIcon = el('span');
        rIcon.appendChild(I.el('system', 16));
        var rLabel = el('span', '', esc(rootLabel()));
        rootLi.appendChild(rtw);
        rootLi.appendChild(rIcon);
        rootLi.appendChild(rLabel);
        rootLi.onclick = function () { select({ kind: 'root' }); };
        rtw.onclick = function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          if (!partsHaveVps()) return;
          expandedRoot = !expandedRoot;
          treeSig = '';
          syncTree();
          renderPane();
        };
        tree.appendChild(rootLi);
        flat.push({ sel: { kind: 'root' }, node: rootLi, hasKids: partsHaveVps(), open: expandedRoot, depth: 0 });

        if (expandedRoot) {
          var ul = el('ul');
          lastParts.forEach(function (p) {
            if (!p) return;
            var open = !!expanded['p' + p.id];
            var vps = vpsOf(p.id);
            var li = el('li');
            var tw = el('div', vps.length ? 'tw' : 'tw empty', vps.length ? (open ? '-' : '+') : '');
            var ic = el('span');
            ic.appendChild(I.el('my-computer', 16));
            li.appendChild(tw);
            li.appendChild(ic);
            li.appendChild(el('span', '', esc(displayName(p) + ' (' + partStateName(p) + ')')));
            li.onclick = function () { select({ kind: 'part', id: p.id }); };
            tw.onclick = function (e) {
              if (e && e.stopPropagation) e.stopPropagation();
              if (!vps.length) return;
              expanded['p' + p.id] = !open;
              if (open && sel.kind === 'vp' && sel.id === p.id) sel = { kind: 'part', id: p.id };
              treeSig = '';
              syncTree();
            };
            var vpUl = el('ul');
            vpUl.style.display = open ? '' : 'none';
            vps.forEach(function (v) {
              var vli = el('li');
              vli.appendChild(el('div', 'tw empty'));
              var vic = el('span');
              vic.appendChild(I.el('task-manager', 16));
              vli.appendChild(vic);
              vli.appendChild(el('span', '', 'Virtual Processor ' + str(v.index)));
              vli.onclick = function () { select({ kind: 'vp', id: p.id, vpid: v.id }); };
              vpUl.appendChild(vli);
              if (open) flat.push({ sel: { kind: 'vp', id: p.id, vpid: v.id }, node: vli, hasKids: false, open: false, depth: 2 });
            });
            li.appendChild(vpUl);
            ul.appendChild(li);
            flat.push({ sel: { kind: 'part', id: p.id }, node: li, hasKids: vps.length > 0, open: open, depth: 1 });
          });
          tree.appendChild(ul);
        }
        tree.scrollTop = scroll;
        markSelection();
      }
      function partsHaveVps() { return lastParts.length > 0; }
      function rootLabel() {
        var info = lastInfo || {};
        var label = str(info.vendor) || 'Hyper-V';
        var extra = [];
        var sig = sigText(info);
        var ver = verText(info);
        if (sig && sig !== '-') extra.push(sig.split(' (')[0]);
        return label + (extra.length ? ' (' + extra.join(' ') + ')' : '');
      }
      function selKey() {
        if (sel.kind === 'root') return 'root';
        if (sel.kind === 'part') return 'p' + sel.id;
        return 'v' + sel.id + '.' + sel.vpid;
      }
      function select(next) {
        sel = next;
        markSelection();
        renderPane();
        setStatus();
        syncMenu();
      }
      function markSelection() {
        var key = selKey();
        flat.forEach(function (node) {
          if (!node.node || !node.node.classList) return;
          node.node.classList.toggle('sel', selKeyOf(node.sel) === key);
        });
      }
      function selKeyOf(s2) {
        if (!s2 || s2.kind === 'root') return 'root';
        if (s2.kind === 'part') return 'p' + s2.id;
        return 'v' + s2.id + '.' + s2.vpid;
      }
      function moveSelection(delta) {
        if (!flat.length) return;
        var key = selKey(), idx = -1, i;
        for (i = 0; i < flat.length; i++) { if (selKeyOf(flat[i].sel) === key) { idx = i; break; } }
        if (idx < 0) idx = 0;
        var next = idx + delta;
        if (next < 0) next = 0;
        if (next >= flat.length) next = flat.length - 1;
        select(flat[next].sel);
      }
      function toggleCurrent() {
        var key = selKey(), i;
        for (i = 0; i < flat.length; i++) {
          if (selKeyOf(flat[i].sel) !== key) continue;
          var n = flat[i];
          if (!n.hasKids) return;
          if (n.sel.kind === 'root') expandedRoot = !n.open;
          else expanded['p' + n.sel.id] = !n.open;
          treeSig = '';
          syncTree();
          return;
        }
      }
      function selectParent() {
        var key = selKey(), idx = -1, i;
        for (i = 0; i < flat.length; i++) { if (selKeyOf(flat[i].sel) === key) { idx = i; break; } }
        if (idx <= 0) { select({ kind: 'root' }); return; }
        var depth = flat[idx].depth;
        for (i = idx - 1; i >= 0; i--) {
          if (flat[i].depth < depth) { select(flat[i].sel); return; }
        }
      }

      /* --------------------------------------------------------- results pane */
      function setTab(i) {
        if (i < 0 || i >= TAB_TITLES.length) return;
        tab = i;
        [].slice.call(tabs.children).forEach(function (b, j) { b.classList.toggle('active', j === i); });
        renderPane();
        syncMenu();
        snd('click');
      }

      function renderUnavailable(reason) {
        treeSig = 'unavailable';
        tree.innerHTML = '';
        flat = [];
        var li = el('li');
        li.appendChild(el('div', 'tw empty'));
        var ic = el('span');
        ic.appendChild(I.el('warning', 16));
        li.appendChild(ic);
        li.appendChild(el('span', '', 'Hypervisor not available'));
        tree.appendChild(li);
        treeHead.textContent = 'Hyper-V Manager';
        paneHead.textContent = 'Hyper-V Manager';

        page.innerHTML = '';
        var box = el('div', 'col');
        box.style.cssText = 'gap:8px;align-items:flex-start';
        var head = el('div', 'row');
        head.style.cssText = 'gap:10px;align-items:flex-start';
        var icon = el('div');
        icon.appendChild(I.el('warning', 32));
        head.appendChild(icon);
        var t = el('div');
        t.innerHTML = '<b>Hyper-V Manager cannot connect to the virtual machine management service.</b>';
        head.appendChild(t);
        box.appendChild(head);
        box.appendChild(el('div', '', 'No hypervisor is running on this machine, so there are no partitions,'));
        box.appendChild(el('div', '', 'no virtual processors, no SLAT mappings and no memory to display.'));
        var reasonBox = el('div', 'w98-field');
        reasonBox.style.cssText = 'padding:5px 6px;background:#fff;max-width:100%;white-space:pre-wrap';
        reasonBox.textContent = 'Reason: ' + reason;
        box.appendChild(reasonBox);
        box.appendChild(el('div', '', 'Start the desktop with the hypervisor build (web/wasm/hypervisor.wasm)'));
        box.appendChild(el('div', '', 'and restart this console to manage partitions here.'));
        page.appendChild(box);

        win.setStatus([
          { text: 'Hyper-V: not available', width: 130 },
          { text: reason }
        ]);
      }

      function sec(title) {
        var d = el('div', 'col');
        d.style.cssText = 'gap:3px;margin:0 0 10px 0';
        var h = el('div', '', esc(title));
        h.style.fontWeight = 'bold';
        d.appendChild(h);
        return d;
      }
      function grid(rows) {
        var box = el('div');
        box.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:1px 10px;align-items:baseline';
        rows.forEach(function (r) {
          var k = el('div', '', esc(r[0]));
          k.style.whiteSpace = 'nowrap';
          var v = el('div', '', esc(r[1]));
          v.style.overflow = 'hidden';
          box.appendChild(k);
          box.appendChild(v);
        });
        return box;
      }
      function table(cols, rows, emptyText) {
        var wrap = el('div', 'col');
        wrap.style.cssText = 'gap:0';
        var head = el('div', 'row');
        head.style.cssText = 'height:17px;flex:0 0 auto;background:#c0c0c0;' +
          'box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px grey,inset 2px 2px #dfdfdf';
        cols.forEach(function (c) {
          var d = el('div', '', esc(c[0]));
          d.style.cssText = 'flex:1 1 ' + c[1] + 'px;min-width:0;padding:0 6px;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap';
          head.appendChild(d);
        });
        var body = el('div', 'w98-listbox');
        body.style.cssText = 'max-height:200px;overflow:auto;flex:1 1 auto;min-height:38px';
        if (!rows.length) body.appendChild(el('div', 'w98-listitem', esc(emptyText || '(none)')));
        rows.forEach(function (r) {
          var row = el('div', 'w98-listitem');
          r.forEach(function (cell, i) {
            var d = el('div', '', esc(cell));
            d.style.cssText = 'flex:1 1 ' + ((cols[i] && cols[i][1]) || 60) + 'px;min-width:0;overflow:hidden;' +
              'text-overflow:ellipsis;white-space:nowrap';
            row.appendChild(d);
          });
          body.appendChild(row);
        });
        wrap.appendChild(head);
        wrap.appendChild(body);
        return wrap;
      }
      function mono(text, maxHeight) {
        var d = el('div', 'w98-field');
        d.style.cssText = 'font:11px "Lucida Console",monospace;padding:3px 5px;background:#fff;' +
          'white-space:pre;overflow:auto;max-height:' + (maxHeight || 130) + 'px';
        d.textContent = text;
        return d;
      }
      function note(text) {
        var d = el('div', '', esc(text));
        d.style.cssText = 'margin:3px 0 8px 0;color:#000';
        return d;
      }
      function partitionIdForCheckpoint(cp) {
        if (!cp) return null;
        for (var i = 0; i < lastParts.length; i++) {
          var p = lastParts[i];
          if (!p) continue;
          if (p.id === cp.partition || p.id === cp.sourcePartition ||
              (p.identity != null && p.identity === cp.partition)) return p.id;
        }
        return null;
      }
      function checkpointBlock(targetId) {
        var h = hvSurface();
        var box = sec('Checkpoints');
        var lim = lastCheckpointLimits || {};
        var limitText = num(lim.maxBytes) == null ? 'unknown' : fmtBytes(num(lim.maxBytes));
        var verText2 = num(lim.formatVersion) == null ? 'unknown' : String(lim.formatVersion);
        box.appendChild(note('Version ' + verText2 + '; serialization limit ' + limitText +
          '. Checkpoints include modeled partition, VP, register, timer, SynIC, MSR, GPA, memory, framebuffer and heartbeat state.'));
        var rows = checkpointRowsFor(targetId);
        var wrap = el('div', 'col');
        wrap.style.cssText = 'gap:0';
        var head = el('div', 'row');
        head.style.cssText = 'height:17px;flex:0 0 auto;background:#c0c0c0;' +
          'box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px grey,inset 2px 2px #dfdfdf';
        [['ID', 48], ['Name', 132], ['Source', 62], ['Bytes', 76], ['Version', 55], ['Actions', 128]].forEach(function (c) {
          var d = el('div', '', c[0]);
          d.style.cssText = 'flex:1 1 ' + c[1] + 'px;min-width:0;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          head.appendChild(d);
        });
        wrap.appendChild(head);
        var body = el('div', 'w98-listbox');
        body.style.cssText = 'max-height:180px;overflow:auto;flex:1 1 auto;min-height:38px';
        if (!rows.length) body.appendChild(el('div', 'w98-listitem', '(no checkpoints)'));
        rows.forEach(function (cp) {
          var row = el('div', 'w98-listitem');
          row.style.alignItems = 'center';
          var srcId = partitionIdForCheckpoint(cp);
          var vals = [str(cp.id), str(cp.name || ('Checkpoint ' + cp.id)), srcId == null ? str(cp.partition || '-') : str(srcId),
            fmtBytes(num(cp.bytes)), num(cp.version) == null ? '-' : String(cp.version)];
          vals.forEach(function (v, i) {
            var d = el('div', '', esc(v));
            d.style.cssText = 'flex:1 1 ' + [48, 132, 62, 76, 55][i] + 'px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px';
            row.appendChild(d);
          });
          var actions = el('div', 'row');
          actions.style.cssText = 'flex:1 1 128px;gap:2px;min-width:128px';
          var rb = el('button', 'w98-toolbtn', 'Restore');
          rb.disabled = !srcId || !h || typeof h.restoreCheckpoint !== 'function' || (currentPart() && partStateCode(currentPart()) === 3);
          rb.title = 'Restore this checkpoint';
          rb.onclick = function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            if (srcId != null) select({ kind: 'part', id: srcId });
            restoreCheckpoint(cp);
          };
          actions.appendChild(rb);
          var db = el('button', 'w98-toolbtn', 'Delete');
          db.disabled = !h || typeof h.deleteCheckpoint !== 'function';
          db.title = 'Delete this checkpoint';
          db.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); deleteCheckpoint(cp); };
          actions.appendChild(db);
          row.appendChild(actions);
          body.appendChild(row);
        });
        wrap.appendChild(body);
        box.appendChild(wrap);
        return box;
      }

      function renderPane() {
        if (unavailable) return;
        try {
          var scroll = page.scrollTop;
          paneHead.textContent = treePath();
          treeHead.textContent = treePath();
          page.innerHTML = '';
          var body = el('div', 'col');
          body.style.cssText = 'gap:2px;align-items:stretch';
          page.appendChild(body);
          if (tab === 0) tabSummary(body);
          else if (tab === 1) tabMemory(body);
          else if (tab === 2) tabHypercalls(body);
          else if (tab === 3) tabVmbus(body);
          else if (tab === 4) tabSynic(body);
          else if (tab === 5) tabMsr(body);
          else tabFramebuffer(body);
          page.scrollTop = scroll;
        } catch (e) {
          try { console.error('hvmanager tab', e); } catch (e2) { /* ignore */ }
        }
      }

      function partRows(list) {
        return list.map(function (p) {
          return [str(p.id), displayName(p), partStateName(p), fmtNum(vpsOf(p.id).length),
            fmtNum(num(p.hypercalls)), fmtNum(num(p.faults))];
        });
      }
      var PART_COLS = [['ID', 34], ['Name', 118], ['State', 74], ['VPs', 36], ['Hypercalls', 74], ['Faults', 56]];

      function vpRows(vps) {
        return vps.map(function (v) {
          return [str(v.id), fmtNum(num(v.index)), vpStateName(v), fmtMs(num(v.runMs)),
            fmtNum(num(v.hypercalls)), fmtNum(num(v.faults)), fmtNum(num(v.preempts))];
        });
      }
      var VP_COLS = [['VP', 40], ['Idx', 34], ['State', 56], ['Run time', 74], ['Hypercalls', 72],
        ['Faults', 54], ['Preempts', 62]];

      function hypervisorGrid() {
        var info = lastInfo || {};
        return grid([
          ['Vendor:', str(info.vendor) || '-'],
          ['Signature:', sigText(info)],
          ['Version:', verText(info)],
          ['Reference time:', num(info.refTimeMs) == null ? '-' : fmtNum(info.refTimeMs) + ' ms'],
          ['Module size:', fmtBytes(num(info.moduleBytes))],
          ['Max partitions:', fmtNum(num(info.maxPartitions))],
          ['Max processors:', fmtNum(num(info.maxVps))],
          ['Hypercalls:', fmtNum(num(info.hypercallCount))],
          ['SLAT faults:', fmtNum(num(info.slatFaults))]
        ]);
      }
      function vpDetailGrid(v) {
        return grid([
          ['Virtual processor:', str(v.id) + ' (index ' + str(v.index) + ')'],
          ['Partition:', str(v.partition)],
          ['State:', vpStateName(v)],
          ['Run time:', fmtMs(num(v.runMs))],
          ['Hypercalls:', fmtNum(num(v.hypercalls))],
          ['Faults:', fmtNum(num(v.faults))],
          ['Instructions:', fmtNum(num(v.instr))],
          ['Slice left:', fmtMs(num(v.sliceLeft))],
          ['Preemptions:', fmtNum(num(v.preempts))]
        ]);
      }
      function partDetailGrid(p) {
        return grid([
          ['Name:', displayName(p)],
          ['Partition ID:', str(p.id)],
          ['State:', partStateName(p)],
          ['Virtual processors:', fmtNum(vpsOf(p.id).length)],
          ['Memory:', fmtBytes(num(p.memoryBytes))],
          ['Deposits:', fmtNum(num(p.deposits))],
          ['Mapped pages:', fmtNum(num(p.mappedPages))],
          ['Hypercalls:', fmtNum(num(p.hypercalls))],
          ['SLAT faults:', fmtNum(num(p.faults))],
          ['Scheduling runs:', fmtNum(num(p.runs))]
        ]);
      }
      function countersBlock() {
        var h = hvSurface();
        var st = safe(function () { return h.stats(); }, null);
        if (!st || typeof st !== 'object') return null;
        var lines = [];
        var keys = [];
        for (var k in st) {
          if (!Object.prototype.hasOwnProperty.call(st, k)) continue;
          if (typeof st[k] !== 'number') continue;
          keys.push(k);
        }
        keys.sort();
        keys.forEach(function (k) { lines.push(k + ' = ' + fmtNum(st[k])); });
        if (!lines.length) return null;
        return mono(lines.join('\n'), 120);
      }

      function tabSummary(body) {
        if (sel.kind === 'root') {
          var s1 = sec('Hypervisor');
          s1.appendChild(hypervisorGrid());
          body.appendChild(s1);

          var s2 = sec('Partitions');
          s2.appendChild(table(PART_COLS, partRows(lastParts), '(the hypervisor owns no partitions)'));
          body.appendChild(s2);

          var s3 = sec('Virtual processors');
          s3.appendChild(table(VP_COLS, vpRows(lastVps), '(no virtual processors)'));
          body.appendChild(s3);
          body.appendChild(checkpointBlock(null));
        } else {
          var p = currentPart();
          if (!p) { body.appendChild(el('div', '', 'The selected partition is no longer present.')); return; }
          var sA = sec(sel.kind === 'vp' ? 'Virtual processor' : 'Partition');
          if (sel.kind === 'vp') {
            var v = null, i;
            for (i = 0; i < lastVps.length; i++) if (lastVps[i] && lastVps[i].id === sel.vpid) v = lastVps[i];
            sA.appendChild(v ? vpDetailGrid(v) : el('div', '', 'The selected virtual processor is no longer present.'));
          } else {
            sA.appendChild(partDetailGrid(p));
          }
          body.appendChild(sA);

          var sB = sec(sel.kind === 'vp' ? 'Parent partition' : 'Virtual processors');
          sB.appendChild(sel.kind === 'vp' ? partDetailGrid(p)
            : table(VP_COLS, vpRows(vpsOf(p.id)), '(this partition has no virtual processors)'));
          body.appendChild(sB);
          if (sel.kind !== 'vp') body.appendChild(checkpointBlock(p.id));
        }

        var sC = sec('Hypervisor counters');
        var counters = countersBlock();
        sC.appendChild(counters || el('div', '', '(the hypervisor reported no counters)'));
        body.appendChild(sC);

        var sCp = sec('Checkpoint service');
        var cpLim = lastCheckpointLimits || {};
        var cpStatus = lastCheckpointStatus;
        sCp.appendChild(grid([
          ['Checkpoints:', fmtNum(lastCheckpoints.length)],
          ['Format version:', num(cpLim.formatVersion) == null ? '-' : String(cpLim.formatVersion)],
          ['Serialization limit:', fmtBytes(num(cpLim.maxBytes))],
          ['Last operation:', cpStatus ? ((cpStatus.ok ? 'success' : 'failed') + ' (' + (cpStatus.name || cpStatus.code) + ')') : 'none']
        ]));
        body.appendChild(sCp);

        var sD = sec('Hypervisor log');
        var h = hvSurface();
        var log = safe(function () { return h.hypervisorLog(); }, '');
        var lines = str(log).split('\n');
        if (lines.length > 12) lines = lines.slice(lines.length - 12);
        sD.appendChild(mono(lines.join('\n') || '(the hypervisor log is empty)', 110));
        body.appendChild(sD);
      }

      function memoryMapOf(id) {
        /* undefined means "this build cannot report its GPA map"; [] means
           "the hypervisor reports nothing mapped" — the two are not the same */
        var h = hvSurface();
        if (!h || typeof h.memoryMap !== 'function') return undefined;
        var v = safe(function () { return h.memoryMap(id); }, null);
        if (v == null || Object.prototype.toString.call(v) !== '[object Array]') return undefined;
        return v;
      }
      function memoryMapRows(map) {
        return map.map(function (m) {
          if (!m) return [];
          return [fmtHex(num(m.gpa)), fmtNum(num(m.pages)),
            m.mapped ? 'yes' : 'no', m.present ? 'yes' : 'no', m.writable ? 'yes' : 'no'];
        }).filter(function (r) { return r.length; });
      }
      var MAP_COLS = [['Guest physical address', 150], ['Pages', 58], ['Mapped', 58], ['Present', 58], ['Writable', 62]];

      function tabMemory(body) {
        var targets = sel.kind === 'root' ? lastParts.filter(function (p) { return p; })
          : lastParts.filter(function (p) { return p && p.id === sel.id; });
        if (!targets.length) { body.appendChild(el('div', '', 'Select a partition to see its memory.')); return; }
        targets.forEach(function (p) {
          var s = sec('Partition ' + str(p.id) + ' \u2014 ' + displayName(p));
          s.appendChild(grid([
            ['Memory:', fmtBytes(num(p.memoryBytes))],
            ['Mapped pages:', fmtNum(num(p.mappedPages))],
            ['Deposits:', fmtNum(num(p.deposits))],
            ['SLAT faults:', fmtNum(num(p.faults))],
            ['Hypervisor SLAT faults (all partitions):', fmtNum(num(lastInfo && lastInfo.slatFaults))]
          ]));
          var map = memoryMapOf(p.id);
          if (map === undefined) {
            s.appendChild(el('div', '', 'This hypervisor build does not report its guest physical address map.'));
          } else {
            var rows = memoryMapRows(map);
            var shown = rows.slice(0, 96);
            s.appendChild(table(MAP_COLS, shown, '(no guest physical addresses are mapped)'));
            if (rows.length > shown.length) s.appendChild(el('div', '', '\u2026 ' + (rows.length - shown.length) + ' more mappings'));
          }
          s.appendChild(note('SLAT maps each guest physical address (GPA) into the hypervisor physical memory.'));
          s.appendChild(note('"Present" and "Writable" are the flags the mapping was created with (HvCallMapGpaPages bit1 present, bit0 writable).'));
          body.appendChild(s);
        });
      }

      function tabHypercalls(body) {
        var targets = sel.kind === 'root' ? lastParts.filter(function (p) { return p; })
          : lastParts.filter(function (p) { return p && p.id === sel.id; });
        var s0 = sec('Totals');
        s0.appendChild(grid([
          ['Hypercalls (hypervisor):', fmtNum(num(lastInfo && lastInfo.hypercallCount))],
          ['Partitions reporting:', fmtNum(targets.length)]
        ]));
        body.appendChild(s0);
        if (targets.length) {
          var s1 = sec('Per partition');
          s1.appendChild(table([['ID', 34], ['Name', 130], ['Hypercalls', 86], ['Faults', 66]],
            targets.map(function (p) {
              return [str(p.id), displayName(p), fmtNum(num(p.hypercalls)), fmtNum(num(p.runs)), fmtNum(num(p.faults))];
            }), '(no partitions)'));
          body.appendChild(s1);
          var vps = targets.reduce(function (acc, p) { return acc.concat(vpsOf(p.id)); }, []);
          var s2 = sec('Per virtual processor');
          s2.appendChild(table([['VP', 40], ['Partition', 68], ['Hypercalls', 80], ['Faults', 58], ['Preempts', 64], ['State', 58]],
            vps.map(function (v) {
              return [str(v.id), str(v.partition), fmtNum(num(v.hypercalls)), fmtNum(num(v.faults)),
                fmtNum(num(v.preempts)), vpStateName(v)];
            }), '(no virtual processors)'));
          body.appendChild(s2);
        }
        var s3 = sec('Hypercall codes');
        s3.appendChild(table([['Code', 66], ['Call', 240]],
          HC_CODES.map(function (c) { return [c[0], c[1]]; }), '(none)'));
        body.appendChild(s3);
        body.appendChild(note('The guest issues these through its hypercall page (GPA 0xE000); the totals above are the counts the hypervisor reports.'));
      }

      function channelRows() {
        return lastVmbus.map(function (c) {
          if (!c) return [];
          return [str(c.id), fmtHex(num(c.offerHi), 8) + ':' + fmtHex(num(c.offerLo), 8),
            str(c.stateName || c.state), fmtNum(num(c.inBytes)), fmtNum(num(c.outBytes)),
            fmtNum(num(c.messages))];
        }).filter(function (r) { return r.length; });
      }
      function tabVmbus(body) {
        var s1 = sec('VMBus channels');
        s1.appendChild(table([['Channel', 54], ['Offer ID (hi:lo)', 150], ['State', 60], ['In bytes', 66],
          ['Out bytes', 66], ['Messages', 66]],
          channelRows(), '(no VMBus channels are offered)'));
        s1.appendChild(note('Channels are offered by the hypervisor; the guest completes the offer handshake in the ring buffer at the channel GPA.'));
        body.appendChild(s1);

        var s2 = sec('Guest messages (W98HV.onGuestMessage)');
        var lines = guestLog.slice(-120).map(function (m) {
          var stamp = m.at == null ? '' : ('[' + (m.at / 1000).toFixed(2) + 's] ');
          return stamp + (m.partition == null ? '' : '(partition ' + m.partition + ') ') + m.text;
        });
        s2.appendChild(mono(lines.join('\n') || '(no messages from the guest yet)', 150));
        s2.appendChild(note('Every message the guest posts to the root partition is logged here as it arrives.'));
        body.appendChild(s2);
      }

      function sintCell(s, names) {
        for (var i = 0; i < names.length; i++) {
          var v = s ? s[names[i]] : null;
          if (typeof v === 'number') return fmtNum(v);
          if (typeof v === 'boolean') return v ? 'yes' : 'no';
          if (typeof v === 'string') return v;
        }
        return '-';
      }
      function tabSynic(body) {
        var h = hvSurface();
        var targets = sel.kind === 'root' ? lastParts.filter(function (p) { return p; })
          : lastParts.filter(function (p) { return p && p.id === sel.id; });
        if (!targets.length) { body.appendChild(el('div', '', 'Select a partition to see its SynIC.')); return; }
        targets.forEach(function (p) {
          var s = sec('SynIC \u2014 Partition ' + str(p.id) + ' \u2014 ' + displayName(p));
          var syn = safe(function () { return h.synic(p.id); }, null);
          if (!syn || typeof syn !== 'object') {
            s.appendChild(el('div', '', 'The hypervisor reported no SynIC for this partition.'));
            body.appendChild(s);
            return;
          }
          s.appendChild(grid([
            ['SCONTROL:', fmtHex(num(syn.scontrol))],
            ['SIMP:', fmtHex(num(syn.simp))],
            ['SIEFP:', fmtHex(num(syn.siefp))],
            ['Messages accepted:', fmtNum(num(syn.messages))],
            ['Messages dropped:', fmtNum(num(syn.dropped))]
          ]));
          var sints = Object.prototype.toString.call(syn.sints) === '[object Array]' ? syn.sints : [];
          var rows = sints.map(function (s2, i) {
            return [sintCell(s2, ['index', 'sint']) === '-' ? str(i) : sintCell(s2, ['index', 'sint']),
              sintCell(s2, ['vector']), sintCell(s2, ['masked']), sintCell(s2, ['count'])];
          });
          s.appendChild(table([['SINT', 44], ['Vector', 60], ['Masked', 58], ['Messages', 66]],
            rows, '(no SINT registers are programmed)'));
          body.appendChild(s);
        });
      }

      function tabMsr(body) {
        var h = hvSurface();
        var targets = sel.kind === 'root' ? lastParts.filter(function (p) { return p; })
          : lastParts.filter(function (p) { return p && p.id === sel.id; });
        if (!targets.length) { body.appendChild(el('div', '', 'Select a partition to see its virtual MSR accesses.')); return; }
        targets.forEach(function (p) {
          var s = sec('Virtual MSR log \u2014 Partition ' + str(p.id) + ' \u2014 ' + displayName(p));
          var log = arr(function () { return h.msrLog(p.id); });
          var rows = log.map(function (e) {
            if (!e) return ['-', '-', '-', '-'];
            return [fmtHex(num(e.msr)), msrName(e.msr), fmtHex(num(e.value)), e.write ? 'write' : 'read'];
          });
          s.appendChild(table([['MSR', 76], ['Name', 168], ['Value', 76], ['Access', 50]],
            rows, '(no virtual MSR accesses have been recorded)'));
          s.appendChild(note('The last 32 accesses the guest made to the virtualised MSRs (HV_ABI.md section 2.4).'));
          body.appendChild(s);
        });
      }

      function tabFramebuffer(body) {
        var id = selectedPartId();
        if (id == null) { body.appendChild(el('div', '', 'There is no partition to look at.')); return; }
        var h = hvSurface();
        var fb = safe(function () { return h.framebuffer(id); }, null);
        var p = null, i;
        for (i = 0; i < lastParts.length; i++) if (lastParts[i] && lastParts[i].id === id) p = lastParts[i];
        var s = sec('Framebuffer \u2014 Partition ' + str(id) + (p ? ' \u2014 ' + displayName(p) : ''));
        if (!fb) {
          s.appendChild(el('div', '', 'No framebuffer is available for this partition'));
          s.appendChild(el('div', '', '(state: ' + partStateName(p) + ').'));
          body.appendChild(s);
          return;
        }
        s.appendChild(grid([
          ['Framebuffer GPA:', fmtHex(num(fb.gpa))],
          ['Size:', str(fb.width) + ' \u00d7 ' + str(fb.height) + ' pixels']
        ]));
        var canvas = el('canvas');
        var w = num(fb.width), hgt = num(fb.height);
        if (!w || !hgt || !fb.rgba || !fb.rgba.length) {
          s.appendChild(el('div', '', 'The guest framebuffer has not been rendered yet.'));
          body.appendChild(s);
          return;
        }
        canvas.width = w;
        canvas.height = hgt;
        canvas.style.cssText = 'image-rendering:pixelated;display:block;max-width:100%;background:#000';
        s.appendChild(canvas);
        s.appendChild(note('The guest screen, 1:1, as the hypervisor holds it in its own memory.'));
        body.appendChild(s);
        try {
          var ctx = canvas.getContext('2d');
          var need = w * hgt * 4;
          var bytes = fb.rgba;
          if (bytes.subarray && bytes.length >= need) bytes = bytes.subarray(0, need);
          if (bytes.length < need) {
            s.appendChild(el('div', '', 'The framebuffer is incomplete (' + bytes.length + ' of ' + need + ' bytes).'));
            return;
          }
          var img = ctx.createImageData(w, hgt);
          img.data.set(bytes);
          ctx.putImageData(img, 0, 0);
        } catch (e) {
          s.appendChild(el('div', '', 'The framebuffer could not be rendered.'));
        }
      }

      /* ------------------------------------------------------ status + menus */
      function setStatus() {
        if (unavailable) return;
        var info = lastInfo || {};
        var hc = num(info.hypercallCount);
        var faults = num(info.slatFaults);
        if (hc == null) {
          hc = 0;
          var haveHc = false;
          lastParts.forEach(function (p) { var v = num(p && p.hypercalls); if (v != null) { hc += v; haveHc = true; } });
          if (!haveHc) hc = null;
        }
        if (faults == null) {
          faults = 0;
          var haveF = false;
          lastParts.forEach(function (p) { var v = num(p && p.faults); if (v != null) { faults += v; haveF = true; } });
          if (!haveF) faults = null;
        }
        var vendor = str(info.vendor) || '-';
        var version = verText(info);
        win.setStatus([
          { text: 'Hypervisor: ' + vendor + (version && version !== '-' ? ' ' + version : ''), width: 218 },
          { text: 'Partitions: ' + lastParts.length, width: 96 },
          { text: 'VPs: ' + lastVps.length, width: 60 },
          { text: 'Checkpoints: ' + lastCheckpoints.length, width: 104 },
          { text: 'Hypercalls: ' + fmtNum(hc), width: 124 },
          { text: 'SLAT faults: ' + fmtNum(faults) }
        ]);
      }

      function menuDef() {
        var can = availability();
        var hasSel = sel.kind !== 'root' && !!currentPart();
        var viewItems = TAB_TITLES.map(function (title, i) {
          return {
            label: TAB_LABELS[i], type: 'radio', checked: tab === i,
            disabled: unavailable,
            onclick: function () { setTab(i); }
          };
        });
        viewItems.push({ type: 'sep' });
        viewItems.push({ label: '&Refresh Now', accel: 'F5', onclick: function () { refresh(); } });
        return [
          {
            label: '&File', items: [
              { label: '&New Partition\u2026', disabled: !can.create, onclick: newPartition },
              { label: '&Delete Partition', disabled: !hasSel || !can.remove, onclick: deletePartition },
              { type: 'sep' },
              { label: '&Refresh', accel: 'F5', onclick: function () { refresh(); } },
              { type: 'sep' },
              { label: 'E&xit', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Action', items: [
              { label: '&Start', disabled: !can.start, onclick: function () { runAction('startPartition', 'start'); } },
              { label: '&Pause', disabled: !can.pause, onclick: function () { runAction('pausePartition', 'pause'); } },
              { label: '&Resume', disabled: !can.resume, onclick: function () { runAction('resumePartition', 'resume'); } },
              { label: 'S&top', disabled: !can.stop, onclick: function () {
                var p = currentPart();
                confirmThen('Stop Partition',
                  'Are you sure you want to stop "' + displayName(p) + '"?\n\n' +
                  'The partition is stopped in the hypervisor and its guest stops running.\n' +
                  'The guest will lose whatever it has not written to disk.',
                  function () { runAction('stopPartition', 'stop'); });
              } },
              { label: '&Reset', disabled: !can.reset, onclick: function () {
                var p = currentPart();
                confirmThen('Reset Partition',
                  'Are you sure you want to reset "' + displayName(p) + '"?\n\n' +
                  'This is like pressing the reset button: the guest restarts\n' +
                  'and its unsaved state is lost.',
                  function () { runAction('resetPartition', 'reset'); });
              } },
              { label: 'Save &State', disabled: !can.save, onclick: saveState },
              { label: 'Create &Checkpoint', disabled: !can.checkpoint, onclick: createCheckpoint },
              { label: '&Clone Partition…', disabled: !can.clone, onclick: clonePartition },
              { type: 'sep' },
              { label: '&Delete', disabled: !hasSel || !can.remove, onclick: deletePartition }
            ]
          },
          { label: '&View', items: viewItems },
          {
            label: '&Help', items: [
              { label: '&Hyper-V Manager Help Topics', onclick: helpTopics },
              { type: 'sep' },
              { label: '&About Hyper-V Manager\u2026', onclick: about }
            ]
          }
        ];
      }
      function syncMenu() {
        var can = availability();
        var sig = [tab, selKey(), unavailable ? 1 : 0, can.create ? 1 : 0, can.remove ? 1 : 0,
          can.start ? 1 : 0, can.pause ? 1 : 0, can.resume ? 1 : 0, can.stop ? 1 : 0,
          can.reset ? 1 : 0, can.save ? 1 : 0, can.checkpoint ? 1 : 0, can.clone ? 1 : 0,
          lastCheckpoints.length].join(',');
        if (sig === menuSig) return;
        menuSig = sig;
        win.setMenu(menuDef());
        updateToolbar();
      }

      /* ------------------------------------------------------------ toolbar */
      function toolButton(label, iconKey, title, onclick) {
        var b = el('button', 'w98-toolbtn');
        if (iconKey) b.appendChild(I.el(iconKey, 16));
        b.appendChild(el('span', '', label));
        b.title = title;
        b.onclick = onclick;
        toolbar.appendChild(b);
        return b;
      }
      var tool = {};
      tool.create = toolButton('New\u2026', 'newfolder', 'Create a new partition', function () { newPartition(); });
      tool.remove = toolButton('Delete', 'delete', 'Delete the selected partition', deletePartition);
      tool.sep1 = el('div', 'w98-toolbar-sep');
      toolbar.appendChild(tool.sep1);
      tool.start = toolButton('Start', null, 'Start the selected partition', function () { runAction('startPartition', 'start'); });
      tool.pause = toolButton('Pause', null, 'Pause the selected partition', function () { runAction('pausePartition', 'pause'); });
      tool.resume = toolButton('Resume', null, 'Resume the selected partition', function () { runAction('resumePartition', 'resume'); });
      tool.stop = toolButton('Stop', 'stop', 'Stop the selected partition', function () { runAction('stopPartition', 'stop'); });
      tool.reset = toolButton('Reset', null, 'Reset the selected partition', function () { runAction('resetPartition', 'reset'); });
      tool.sep2 = el('div', 'w98-toolbar-sep');
      toolbar.appendChild(tool.sep2);
      tool.checkpoint = toolButton('Checkpoint', null, 'Create a checkpoint of the selected partition', createCheckpoint);
      tool.clone = toolButton('Clone', null, 'Clone the selected partition', clonePartition);
      tool.sep3 = el('div', 'w98-toolbar-sep');
      toolbar.appendChild(tool.sep3);
      tool.refresh = toolButton('Refresh', 'refresh', 'Read the hypervisor again', function () { refresh(); });

      function updateToolbar() {
        var can = availability();
        tool.create.disabled = !can.create;
        tool.remove.disabled = !can.remove;
        tool.start.disabled = !can.start;
        tool.pause.disabled = !can.pause;
        tool.resume.disabled = !can.resume;
        tool.stop.disabled = !can.stop;
        tool.reset.disabled = !can.reset;
        tool.checkpoint.disabled = !can.checkpoint;
        tool.clone.disabled = !can.clone;
        tool.refresh.disabled = !!unavailable;
      }

      /* ------------------------------------------------------------- keyboard */
      win.on('key', function (e) {
        if (!e || closed) return;
        var k = e.key;
        if (k === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
        else if (k === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
        else if (k === 'ArrowRight') { e.preventDefault(); toggleCurrent(); }
        else if (k === 'ArrowLeft') { e.preventDefault(); selectParent(); }
        else if (k === 'Enter' || k === ' ') { e.preventDefault(); toggleCurrent(); }
        else if (k === 'F5') { e.preventDefault(); refresh(); }
        else if (k === 'Tab' && e.ctrlKey) { e.preventDefault(); setTab((tab + 1) % TAB_TITLES.length); }
      });

      /* ---------------------------------------------------------------- start */
      [].slice.call(tabs.children).forEach(function (b, j) { b.classList.toggle('active', j === 0); });
      treeHead.textContent = 'Hyper-V Manager';
      var timer = win.setInterval(refresh, 1000);
      /* the poll above is the kernel-scheduled one; this is only a watchdog for
         the case where the kernel's timer queue stops delivering, so the console
         keeps reading the hypervisor instead of freezing on stale numbers */
      var lastRefresh = 0, cancelRaf = null;
      if (typeof W98.raf === 'function') {
        try {
          cancelRaf = W98.raf(function () {
            var now = Date.now();
            if (now - lastRefresh < 1200) return;
            lastRefresh = now;
            refresh();
          });
        } catch (e) { cancelRaf = null; }
      }
      refresh();
      lastRefresh = Date.now();

      return {
        onResize: function () { renderPane(); },
        onClose: function () {
          closed = true;
          try { win.clearInterval(timer); } catch (e) { /* ignore */ }
          if (cancelRaf) { try { cancelRaf(); } catch (e2) { /* ignore */ } cancelRaf = null; }
        }
      };
    }
  });
})();
