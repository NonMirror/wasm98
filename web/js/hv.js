/* ============================================================================
   hv.js — JS glue for hypervisor.wasm
   ----------------------------------------------------------------------------
   Loads web/wasm/hypervisor.wasm and exposes the `W98HV` surface documented in
   HV_ABI.md section 4.  The wasm image is the machine: it owns physical memory,
   the partitions, the virtual processors, SLAT, the hypercall engine, SynIC and
   VMBus.  JS only moves bytes in and out of its linear memory through
   hv_read_gpa / hv_write_gpa.

   House rules (same as kernel.js): classic script, one global, no modules, no
   network beyond fetching this one wasm file, every promise time-boxed so a
   failure can never hang the desktop, and no exception ever escapes into the
   caller.  When the image cannot be loaded `W98HV.mode` is 'none' and every
   accessor returns an empty but valid shape.

   `W98.hv` (the kernel-side surface listed in HV_ABI.md 4) belongs to the
   kernel glue backed by nt.c, not to this file.
   ========================================================================== */
(function (global) {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  /* guest GPA layout the guest and the manager both know about */
  var FB_GPA = 0x10000, FB_W = 400, FB_H = 120, FB_BYTES = FB_W * FB_H * 4;
  var HC_GPA = 0xE000, GPA_LIMIT = 0xB0000, PAGE = 4096;

  var PART_STATES = ['empty', 'created', 'initialised', 'running', 'paused', 'stopped', 'faulted', 'deleted'];
  var VP_STATES = ['empty', 'created', 'running', 'halted', 'faulted'];
  var CH_STATES = ['created', 'offered', 'open', 'closed'];
  var STAGE_NAMES = ['reset', 'cpuid', 'osid', 'hypercall', 'time', 'vpindex', 'synic',
    'timer', 'vmbus', 'framebuffer', 'run', 'redraw', 'failed'];
  var STATUS = {
    SUCCESS: 0, INVALID_PARAMETER: 2, ACCESS_DENIED: 3, INSUFFICIENT_MEMORY: 4,
    INVALID_PARTITION_STATE: 5, SLAT_FAULT: 6, NOT_IMPLEMENTED: 7
  };

  /* scratch layout inside the module's 256 KB scratch window */
  var STR_MAX = 8192;            /* strings handed to the hypervisor          */
  var READ = 16384;              /* read/staging window (framebuffer + msgs)  */

  var wasm = null, scratchBase = 0, strOff = 0, moduleBytes = 0;
  var msgCb = null, lastDrain = 0, lastSched = 0;
  var fbOut = null;
  var bootTrace = [];

  var API = {
    mode: 'none',
    ready: null,
    error: null,
    version: 0,
    moduleBytes: 0,
    STATE_NAMES: PART_STATES,
    C: {
      PART_STATES: PART_STATES, VP_STATES: VP_STATES, CH_STATES: CH_STATES,
      STAGE_NAMES: STAGE_NAMES, STATUS: STATUS,
      FB_GPA: FB_GPA, FB_WIDTH: FB_W, FB_HEIGHT: FB_H, HC_GPA: HC_GPA, GPA_LIMIT: GPA_LIMIT
    }
  };

  /* ---------------------------------------------------------- memory helpers */
  function refresh() { if (wasm && (!API._u8 || API._u8.buffer !== wasm.memory.buffer)) { API._u8 = new Uint8Array(wasm.memory.buffer); API._dv = new DataView(wasm.memory.buffer); } }
  function u8() { refresh(); return API._u8; }
  function dv() { refresh(); return API._dv; }
  function readText(ptr, len) { return len ? dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)) : ''; }
  function readBytes(ptr, len) { return len ? new Uint8Array(wasm.memory.buffer.slice(ptr, ptr + len)) : new Uint8Array(0); }

  function pushText(s) {
    s = String(s == null ? '' : s);
    var b = enc.encode(s);
    if (strOff + b.length + 1 > STR_MAX) strOff = 0;
    var p = scratchBase + strOff;
    u8().set(b, p);
    u8()[p + b.length] = 0;
    strOff += b.length + 8;
    return { p: p, n: b.length };
  }
  function pushBytes(arr) {
    var b = (arr instanceof Uint8Array) ? arr
      : (typeof arr === 'string' ? enc.encode(arr) : new Uint8Array(arr || []));
    if (b.length > STR_MAX) return null;
    var p = scratchBase;
    u8().set(b, p);
    return { p: p, n: b.length };
  }

  /* never let a wasm trap escape into the desktop */
  function safe(fn, dflt) {
    if (!wasm) return dflt;
    try { return fn(); }
    catch (e) {
      API.error = String((e && e.message) || e);
      if (e && (e.name === 'RuntimeError' || /unreachable/i.test(API.error))) {
        wasm = null;
        API.mode = 'none';
      }
      return dflt;
    }
  }

  /* --------------------------------------------------------------- accessors */
  function info() {
    return safe(function () {
      return {
        mode: API.mode,
        version: wasm.hv_version() >>> 0,
        vendor: readText(wasm.hv_vendor_ptr(), wasm.hv_vendor_len()),
        signature: wasm.hv_signature() >>> 0,
        signatureText: 'Hv#1',
        magic: wasm.hv_magic() >>> 0,
        maxPartitions: wasm.hv_max_partitions(),
        maxVps: wasm.hv_max_vps(),
        pageSize: wasm.hv_page_size(),
        physBytes: wasm.hv_phys_bytes(),
        refTimeMs: wasm.hv_ref_time_ms(),
        hypercallCount: wasm.hv_hypercall_count(),
        slatFaults: wasm.hv_slat_faults_total(),
        partitions: wasm.hv_partition_count(),
        vps: wasm.hv_vp_count(),
        moduleBytes: moduleBytes,
        bootTrace: bootTrace.slice()
      };
    }, {
      mode: API.mode, error: API.error, version: 0, vendor: '', signature: 0, maxPartitions: 0,
      maxVps: 0, pageSize: PAGE, physBytes: 0, refTimeMs: 0, hypercallCount: 0, slatFaults: 0,
      partitions: 0, vps: 0, moduleBytes: moduleBytes
    });
  }

  function partitions() {
    return safe(function () {
      var out = [], max = wasm.hv_max_partitions(), i;
      for (i = 1; i <= max; i++) {
        if (!wasm.hv_partition_field(i, 0)) continue;
        var vps = [], n = wasm.hv_partition_field(i, 4), k;
        for (k = 0; k < n; k++) vps.push(wasm.hv_partition_vp(i, k));
        var st = wasm.hv_partition_field(i, 1);
        out.push({
          id: i,
          name: readText(wasm.hv_partition_field(i, 2), wasm.hv_partition_field(i, 3)),
          state: st,
          stateName: PART_STATES[st] || 'unknown',
          vps: vps,
          vpCount: n,
          memoryBytes: wasm.hv_partition_field(i, 6),
          mappedPages: wasm.hv_partition_field(i, 5),
          mappedBytes: wasm.hv_partition_field(i, 6),
          deposits: wasm.hv_partition_field(i, 7),
          hypercalls: wasm.hv_partition_field(i, 8),
          faults: wasm.hv_partition_field(i, 9),
          runs: wasm.hv_partition_field(i, 10),
          isRoot: wasm.hv_partition_field(i, 11) === 1,
          root: wasm.hv_partition_field(i, 11) === 1,
          parent: wasm.hv_partition_field(i, 12),
          canaryFaults: wasm.hv_partition_field(i, 13),
          hasGuest: wasm.hv_partition_field(i, 14) === 1,
          channel: wasm.hv_partition_field(i, 15),
          heartbeat: wasm.hv_guest_heartbeat(i),
          stage: wasm.hv_guest_field(i, 0),
          canaryLo: wasm.hv_canary_lo(i),
          canaryHi: wasm.hv_canary_hi(i)
        });
      }
      return out;
    }, []);
  }

  function partition(id) {
    var list = partitions();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function vps() {
    return safe(function () {
      var live = {}, ps = partitions(), i;
      for (i = 0; i < ps.length; i++) live[ps[i].id] = true;
      var out = [];
      for (i = 1; i <= wasm.hv_max_vps(); i++) {
        var part = wasm.hv_vp_field(i, 0);
        if (!part || !live[part]) continue;
        var st = wasm.hv_vp_field(i, 2);
        out.push({
          id: i,
          partition: part,
          index: wasm.hv_vp_field(i, 1),
          state: st,
          stateName: VP_STATES[st] || 'unknown',
          runMs: wasm.hv_vp_field(i, 3),
          hypercalls: wasm.hv_vp_field(i, 4),
          faults: wasm.hv_vp_field(i, 5),
          instr: wasm.hv_vp_field(i, 6),
          sliceLeft: wasm.hv_vp_field(i, 7),
          preempts: wasm.hv_vp_field(i, 8),
          runNs: wasm.hv_vp_run_ns(i) >>> 0,
          registers: [wasm.hv_vp_register(i, 0) >>> 0, wasm.hv_vp_register(i, 1) >>> 0,
                      wasm.hv_vp_register(i, 2) >>> 0, wasm.hv_vp_register(i, 3) >>> 0],
          timerFires: wasm.hv_vp_timer_fires(i),
          timer: {
            fires: wasm.hv_timer_field(i, 0), last: wasm.hv_timer_field(i, 1),
            pending: wasm.hv_timer_field(i, 2), armed: wasm.hv_timer_field(i, 3) === 1,
            masked: wasm.hv_timer_field(i, 4)
          },
          synic: {
            scontrol: wasm.hv_synic_field(i, 0), simp: wasm.hv_synic_field(i, 1),
            siefp: wasm.hv_synic_field(i, 2), eom: wasm.hv_synic_field(i, 3),
            messages: wasm.hv_synic_field(i, 4), dropped: wasm.hv_synic_field(i, 5),
            events: wasm.hv_synic_field(i, 6), queued: wasm.hv_synic_field(i, 7)
          },
          sints: [0, 1, 2, 3].map(function (s) {
            return { vector: wasm.hv_sint_field(i, s, 0), masked: wasm.hv_sint_field(i, s, 1) === 1, count: wasm.hv_sint_field(i, s, 2) };
          })
        });
      }
      return out;
    }, []);
  }

  /* SLAT walk: coalesce adjacent pages that share a mapping state */
  function memoryMap(id) {
    return safe(function () {
      var part = id || 1, out = [], runStart = -1, runState = -1, gpa;
      for (gpa = 0; gpa <= GPA_LIMIT; gpa += PAGE) {
        var st = (gpa === GPA_LIMIT) ? -1 : wasm.hv_gpa_state(part, gpa);
        if (st !== runState) {
          if (runState >= 0) {
            out.push({
              gpa: runStart, pages: (gpa - runStart) / PAGE,
              mapped: runState !== 0, writable: runState === 3, present: runState >= 2,
              state: runState
            });
          }
          runStart = gpa; runState = st;
        }
      }
      return out;
    }, []);
  }

  function framebuffer(id) {
    return safe(function () {
      var part = id || 1;
      if (!wasm.hv_partition_field(part, 14)) return null;
      var n = wasm.hv_read_gpa(part, FB_GPA, scratchBase + READ, FB_BYTES);
      if (n !== FB_BYTES) return null;
      var src = new Uint8Array(wasm.memory.buffer, scratchBase + READ, FB_BYTES);
      if (!fbOut || fbOut.length !== FB_BYTES) fbOut = new Uint8Array(FB_BYTES);
      for (var i = 0; i < FB_BYTES; i += 4) {     /* BGRA in wasm -> RGBA for canvas */
        fbOut[i] = src[i + 2];
        fbOut[i + 1] = src[i + 1];
        fbOut[i + 2] = src[i];
        fbOut[i + 3] = src[i + 3];
      }
      return { gpa: FB_GPA, width: FB_W, height: FB_H, rgba: fbOut, partition: part };
    }, null);
  }

  function synic(id) {
    return safe(function () {
      var part = id || 1;
      var vp = wasm.hv_partition_vp(part, 0) || rootVp();
      if (!vp) return null;
      var sints = [], i;
      for (i = 0; i < 4; i++) {
        sints.push({
          index: i, vector: wasm.hv_sint_field(vp, i, 0),
          masked: wasm.hv_sint_field(vp, i, 1) === 1, count: wasm.hv_sint_field(vp, i, 2)
        });
      }
      return {
        vp: vp,
        scontrol: wasm.hv_synic_field(vp, 0),
        simp: wasm.hv_synic_field(vp, 1),
        siefp: wasm.hv_synic_field(vp, 2),
        eom: wasm.hv_synic_field(vp, 3),
        messages: wasm.hv_synic_field(vp, 4),
        dropped: wasm.hv_synic_field(vp, 5),
        events: wasm.hv_synic_field(vp, 6),
        queued: wasm.hv_synic_field(vp, 7),
        sints: sints
      };
    }, null);
  }

  function msrName(msr) {
    switch (msr) {
    case 0x40000000: return 'HV_X64_MSR_GUEST_OS_ID';
    case 0x40000001: return 'HV_X64_MSR_HYPERCALL';
    case 0x40000002: return 'HV_X64_MSR_VP_INDEX';
    case 0x40000020: return 'HV_X64_MSR_TIME_REF_COUNT';
    case 0x40000021: return 'HV_X64_MSR_REFERENCE_TSC';
    case 0x40000080: return 'HV_X64_MSR_SCONTROL';
    case 0x40000082: return 'HV_X64_MSR_SIEFP';
    case 0x40000083: return 'HV_X64_MSR_SIMP';
    case 0x40000084: return 'HV_X64_MSR_EOM';
    default:
      if (msr >= 0x40000090 && msr < 0x40000094) return 'HV_X64_MSR_SINT' + (msr - 0x40000090);
      return 'MSR 0x' + msr.toString(16);
    }
  }

  function msrLog(id) {
    return safe(function () {
      var part = id || 1, n = wasm.hv_msr_log_count(part), out = [], i;
      for (i = 0; i < n; i++) {
        var m = wasm.hv_msr_log_field(part, i, 0) >>> 0;
        out.push({ msr: m, value: wasm.hv_msr_log_field(part, i, 1) >>> 0,
                   write: wasm.hv_msr_log_field(part, i, 2) === 1, name: msrName(m) });
      }
      return out;
    }, []);
  }

  function vmbus() {
    return safe(function () {
      var out = [], i;
      for (i = 1; i <= 16; i++) {
        var part = wasm.hv_vmbus_channel_field(i, 0);
        if (!part) continue;
        var st = wasm.hv_vmbus_channel_field(i, 1);
        out.push({
          id: wasm.hv_vmbus_channel_field(i, 9),
          slot: i,
          partition: part,
          offerLo: wasm.hv_vmbus_channel_field(i, 2) >>> 0,
          offerHi: wasm.hv_vmbus_channel_field(i, 3) >>> 0,
          state: st,
          stateName: CH_STATES[st] || 'unknown',
          inBytes: wasm.hv_vmbus_channel_field(i, 5),
          outBytes: wasm.hv_vmbus_channel_field(i, 6),
          messages: wasm.hv_vmbus_channel_field(i, 7),
          dropped: wasm.hv_vmbus_channel_field(i, 8),
          ringGpa: wasm.hv_vmbus_channel_field(i, 4),
          inRingGpa: wasm.hv_vmbus_channel_field(i, 10)
        });
      }
      return out;
    }, []);
  }
  function vmbusStats() {
    return safe(function () {
      return {
        channels: wasm.hv_vmbus_stats(0), messages: wasm.hv_vmbus_stats(1),
        dropped: wasm.hv_vmbus_stats(2), inBytes: wasm.hv_vmbus_stats(3),
        outBytes: wasm.hv_vmbus_stats(4), open: wasm.hv_vmbus_stats(5)
      };
    }, { channels: 0, messages: 0, dropped: 0, inBytes: 0, outBytes: 0, open: 0 });
  }
  /* one framed VMBus message from a channel's guest -> root ring */
  function vmbusDrain(ch) {
    return safe(function () {
      var n = wasm.hv_vmbus_drain(ch, scratchBase + READ, 256);
      if (!n) return null;
      return { type: dv().getUint32(scratchBase + READ, true), len: n,
               payload: readText(scratchBase + READ + 8, n) };
    }, null);
  }

  function rootVp() { return safe(function () { return wasm.hv_partition_vp(1, 0); }, 0); }
  function channelOf(part) {
    return safe(function () {
      for (var i = 1; i <= 16; i++) if (wasm.hv_vmbus_channel_field(i, 0) === part) return i;
      return 0;
    }, 0);
  }

  /* ----------------------------------------------------- guest console view */
  function guest(id) {
    return safe(function () {
      var part = id || 1;
      return {
        partition: part,
        stage: wasm.hv_guest_field(part, 0),
        stageName: STAGE_NAMES[wasm.hv_guest_field(part, 0)] || '?',
        bootFlags: wasm.hv_guest_field(part, 1),
        booted: (wasm.hv_guest_field(part, 1) & 0x1FF) === 0x1FF,
        heartbeat: wasm.hv_guest_field(part, 2),
        timerHits: wasm.hv_guest_field(part, 3),
        vmbusMessages: wasm.hv_guest_field(part, 5),
        commands: wasm.hv_guest_field(part, 6),
        lastCommand: wasm.hv_guest_field(part, 7),
        halted: wasm.hv_guest_field(part, 8) === 1,
        channel: wasm.hv_guest_field(part, 9),
        refTimeMs: wasm.hv_guest_field(part, 10),
        vpIndex: wasm.hv_guest_field(part, 11),
        osId: wasm.hv_guest_field(part, 12) >>> 0,
        error: wasm.hv_guest_field(part, 13),
        log: readText(wasm.hv_guest_log_ptr(part), wasm.hv_guest_log_len(part))
      };
    }, null);
  }
  function guestLog(id) {
    return safe(function () {
      var part = id || 1;
      return readText(wasm.hv_guest_log_ptr(part), wasm.hv_guest_log_len(part));
    }, '');
  }

  /* ------------------------------------------------------------- lifecycle */
  function createPartition(name, opts) {
    return safe(function () {
      opts = opts || {};
      var cpus = Math.max(1, Math.min(4, opts.cpus | 0 || 1));
      var a = pushText(name || 'Guest');
      var id = wasm.hv_partition_create(a.p, a.n);
      if (!id) return 0;
      for (var i = 0; i < cpus; i++) wasm.hv_vp_create(id, i);
      /* memoryBytes is advisory: every guest gets the hypervisor's 176 page
         GPA window (704 KB), which is what partitions() reports. */
      wasm.hv_partition_init(id);
      return id;
    }, 0);
  }
  function startPartition(id) { return safe(function () { return wasm.hv_partition_start(id) === 0; }, false); }
  function pausePartition(id) { return safe(function () { return wasm.hv_partition_pause(id) === 0; }, false); }
  function resumePartition(id) { return safe(function () { return wasm.hv_partition_resume(id) === 0; }, false); }
  function stopPartition(id) { return safe(function () { return wasm.hv_partition_stop(id) === 0; }, false); }
  function deletePartition(id) { return safe(function () { return wasm.hv_partition_delete(id) === 0; }, false); }
  function resetPartition(id) {
    return safe(function () {
      if (id === 1) return wasm.hv_partition_start(1) === 0;   /* the root just restarts */
      if (wasm.hv_partition_reset(id) !== 0) return false;
      return wasm.hv_partition_start(id) === 0;
    }, false);
  }

  function sendToGuest(id, bytes) {
    return safe(function () {
      var part = id || 1;
      var ch = channelOf(part);
      if (!ch) return false;
      var a = pushBytes(bytes);
      if (!a) return false;
      return wasm.hv_vmbus_inject(ch, a.p, a.n) > 0;
    }, false);
  }

  function onGuestMessage(fn) { msgCb = (typeof fn === 'function') ? fn : null; }

  function deliver(msg) {
    if (!msgCb) return;
    try { msgCb(msg); }
    catch (e) { if (global.console) console.error('hv: onGuestMessage callback threw', e); }
  }

  /* pull everything the guests have said since the last step */
  function drain() {
    if (!wasm) return 0;
    var n = 0, i, k;
    for (i = 1; i <= 16 && n < 48; i++) {
      var part = wasm.hv_vmbus_channel_field(i, 0);
      if (!part) continue;
      for (k = 0; k < 8 && n < 48; k++) {
        var len = wasm.hv_vmbus_drain(i, scratchBase + READ, 256);
        if (!len) break;
        var b = readBytes(scratchBase + READ + 8, len);
        deliver({ partition: part, bytes: b, text: dec.decode(b),
                  type: dv().getUint32(scratchBase + READ, true), kind: 'vmbus' });
        n++;
      }
    }
    var rvp = rootVp();
    for (k = 0; k < 16 && n < 64 && rvp; k++) {
      var m = wasm.hv_message_pop(rvp, scratchBase + READ, 256);
      if (!m) break;
      var mtype = dv().getUint32(scratchBase + READ, true);
      var msize = Math.min(244, dv().getUint32(scratchBase + READ + 4, true));
      var mb = readBytes(scratchBase + READ + 12, msize);
      deliver({ partition: 1, bytes: mb, text: dec.decode(mb), type: mtype, kind: 'synic' });
      n++;
    }
    lastDrain = n;
    return n;
  }

  function step(elapsedMs) {
    var ms = Math.max(1, Math.min(5000, elapsedMs | 0 || 16));
    var runs = safe(function () { return wasm.hv_schedule(ms); }, 0);
    lastSched = runs;
    drain();
    return runs;
  }

  function stats() {
    return safe(function () {
      return {
        mode: API.mode,
        refTimeMs: wasm.hv_ref_time_ms(),
        partitions: wasm.hv_partition_count(),
        vps: wasm.hv_vp_count(),
        runningVps: wasm.hv_sched_field(4),
        slices: wasm.hv_sched_field(0),
        preemptions: wasm.hv_sched_field(1),
        contextSwitches: wasm.hv_sched_field(2),
        idleSlices: wasm.hv_sched_field(3),
        quantumMs: wasm.hv_sched_field(5),
        lastRuns: lastSched,
        lastDrained: lastDrain,
        hypercalls: wasm.hv_hypercall_count(),
        slatFaults: wasm.hv_slat_faults_total(),
        totalBytes: wasm.hv_memory_stats(0),
        mappedBytes: wasm.hv_memory_stats(1),
        reservedBytes: wasm.hv_memory_stats(2),
        freeBytes: wasm.hv_memory_stats(3),
        deposits: wasm.hv_memory_stats(4),
        channels: wasm.hv_vmbus_channel_count(),
        channelMessages: wasm.hv_vmbus_stats(1),
        channelDropped: wasm.hv_vmbus_stats(2),
        channelIn: wasm.hv_vmbus_stats(3),
        channelOut: wasm.hv_vmbus_stats(4),
        openChannels: wasm.hv_vmbus_stats(5),
        logBytes: wasm.hv_log_len(),
        moduleBytes: moduleBytes
      };
    }, { mode: API.mode, error: API.error, partitions: 0, vps: 0, hypercalls: 0, slatFaults: 0 });
  }

  function hypervisorLog() {
    return safe(function () { return readText(wasm.hv_log_ptr(), wasm.hv_log_len()); }, '');
  }
  function clearLog() { return safe(function () { wasm.hv_log_clear(); return true; }, false); }

  /* ------------------------------------------------------------------- boot */
  var DEFAULT_GUEST = 'Windows 98 Guest';
  function autostart() {
    var id = createPartition(DEFAULT_GUEST, { cpus: 1 });
    if (id) startPartition(id);
    return id;
  }

  function load() {
    return fetch('wasm/hypervisor.wasm').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (ab) {
      var mod = new WebAssembly.Module(ab);
      var inst = new WebAssembly.Instance(mod, {});
      wasm = inst.exports;
      if (!wasm.memory || typeof wasm.hv_init !== 'function') throw new Error('not a hypervisor image');
      moduleBytes = ab.byteLength;
      API.moduleBytes = moduleBytes;
      bootTrace.push('hv: image ' + moduleBytes + ' bytes');
      var magic = wasm.hv_init(0, 8, 16, 16 * 1024 * 1024) >>> 0;
      if (magic !== 0x48560001) throw new Error('hv_init returned 0x' + magic.toString(16));
      scratchBase = wasm.hv_scratch(0) | 0;
      API.mode = 'wasm';
      API.version = wasm.hv_version() >>> 0;
      bootTrace.push('hv: up, vendor ' + readText(wasm.hv_vendor_ptr(), wasm.hv_vendor_len()));
      var gid = autostart();
      bootTrace.push('hv: default guest partition ' + gid + ' created and started');
      step(1);                                  /* first entry: the guest boots */
      if (global.W98 && global.W98.__bootTrace) global.W98.__bootTrace.push('hv: ready');
      return info();
    }).catch(function (e) {
      API.error = String((e && e.message) || e);
      API.mode = 'none';
      bootTrace.push('hv: unavailable - ' + API.error);
      if (global.console) console.warn('hypervisor.wasm unavailable:', API.error);
      return { mode: 'none', error: API.error, vendor: '', moduleBytes: moduleBytes };
    });
  }

  API.boot = function () {
    if (API.ready) return API.ready;
    var timeout = new Promise(function (res) {
      setTimeout(function () { res({ mode: 'none', error: API.error || 'timeout', timeout: true }); }, 4000);
    });
    API.ready = Promise.race([load(), timeout]).then(function (r) {
      try { global.dispatchEvent(new CustomEvent('w98-hv-ready', { detail: { mode: API.mode } })); } catch (e) {}
      return r;
    }).catch(function (e) {
      API.error = String((e && e.message) || e);
      API.mode = 'none';
      return { mode: 'none', error: API.error };
    });
    return API.ready;
  };

  /* ---------------------------------------------------------------- exports */
  API.info = info;
  API.partitions = partitions;
  API.partitionList = partitions;          /* convenience alias */
  API.partition = partition;
  API.createPartition = createPartition;
  API.startPartition = startPartition;
  API.pausePartition = pausePartition;
  API.resumePartition = resumePartition;
  API.stopPartition = stopPartition;
  API.resetPartition = resetPartition;
  API.deletePartition = deletePartition;
  API.vps = vps;
  API.vpList = vps;
  API.memoryMap = memoryMap;
  API.framebuffer = framebuffer;
  API.synic = synic;
  API.msrLog = msrLog;
  API.vmbus = vmbus;
  API.vmbusStats = vmbusStats;
  API.vmbusDrain = vmbusDrain;
  API.sendToGuest = sendToGuest;
  API.onGuestMessage = onGuestMessage;
  API.step = step;
  API.stats = stats;
  API.hypervisorLog = hypervisorLog;
  API.log = hypervisorLog;
  API.clearLog = clearLog;
  API.guest = guest;
  API.guestFields = guest;
  API.guestLog = guestLog;
  API.channelOf = channelOf;
  API.rootVp = rootVp;
  API.refTime = function () { return safe(function () { return wasm.hv_ref_time_ms(); }, 0); };
  API.vendor = function () { return safe(function () { return readText(wasm.hv_vendor_ptr(), wasm.hv_vendor_len()); }, ''); };
  API.signature = function () { return safe(function () { return wasm.hv_signature() >>> 0; }, 0); };
  API.magic = function () { return safe(function () { return wasm.hv_magic() >>> 0; }, 0); };
  API.slatFaults = function () { return safe(function () { return wasm.hv_slat_faults_total(); }, 0); };
  API.hypercalls = function () { return safe(function () { return wasm.hv_hypercall_count(); }, 0); };
  API.partitionFaults = function (id) { return safe(function () { return wasm.hv_slat_faults(id); }, 0); };
  API.limits = function () {
    return safe(function () {
      return { partitions: wasm.hv_partition_count(), vps: wasm.hv_vp_count(),
               phys: wasm.hv_phys_bytes(), pageSize: wasm.hv_page_size(),
               maxPartitions: wasm.hv_max_partitions(), maxVps: wasm.hv_max_vps(),
               gpaLimit: wasm.hv_debug_gpa_limit() };
    }, { partitions: 0, vps: 0, phys: 0, pageSize: PAGE, maxPartitions: 0, maxVps: 0, gpaLimit: GPA_LIMIT });
  };
  API.sched = function () {
    return safe(function () {
      return { slices: wasm.hv_sched_field(0), preemptions: wasm.hv_sched_field(1),
               ctxSwitches: wasm.hv_sched_field(2), idleSlices: wasm.hv_sched_field(3),
               runnable: wasm.hv_sched_field(4), quantumMs: wasm.hv_sched_field(5) };
    }, { slices: 0, preemptions: 0, ctxSwitches: 0, idleSlices: 0, runnable: 0, quantumMs: 0 });
  };
  API.memory = function () {
    return safe(function () {
      return { total: wasm.hv_memory_stats(0), present: wasm.hv_memory_stats(1),
               deposited: wasm.hv_memory_stats(2), free: wasm.hv_memory_stats(3),
               deposits: wasm.hv_memory_stats(4) };
    }, { total: 0, present: 0, deposited: 0, free: 0, deposits: 0 });
  };
  API.queryMsr = function (vp, msr) {
    return safe(function () {
      var out = scratchBase + READ;
      var r = wasm.hv_query_msr(vp, msr >>> 0, out) >>> 0;
      return { status: r, lo: dv().getUint32(out, true), hi: dv().getUint32(out + 4, true) };
    }, null);
  };
  API.setMsr = function (vp, msr, lo, hi) {
    return safe(function () { return wasm.hv_set_msr(vp, msr >>> 0, lo >>> 0, (hi || 0) >>> 0) >>> 0; }, 1);
  };
  API.debug = { exports: function () { return wasm; }, scratch: function () { return scratchBase; } };

  /* ------------------------------------------------------------ host clock
     The hypervisor owns no wall clock: the reference time advances only when
     the host drives it, exactly like a hypervisor whose reference timer is
     feed-driven.  The shell therefore steps it from a timer of its own, and
     does nothing at all while no partition has a running guest. */
  var pumpTimer = null, lastPump = 0, pumpBudget = 0;
  API.autoPump = true;
  API.pumpCount = 0;
  API.startPump = function (ms) {
    if (pumpTimer || !API.autoPump) return;
    lastPump = Date.now();
    pumpTimer = setInterval(function () {
      var now = Date.now(), dt = now - lastPump, i, ps, live = 0;
      lastPump = now;
      if (!wasm) return;
      ps = partitions();
      for (i = 0; i < ps.length; i++) if (ps[i].hasGuest && ps[i].state === 3) live++;
      if (!live) return;                       /* idle: no cost, no clock drift */
      if (!(dt > 8) || dt > 500) dt = 50;
      API.step(dt);
      API.pumpCount++;
    }, ms || 50);
  };
  API.stopPump = function () { if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = null; } };

  API.boot();
  if (API.ready && API.ready.then) API.ready.then(function () { if (API.mode === 'wasm') API.startPump(50); });
  global.W98HV = API;
})(window);
