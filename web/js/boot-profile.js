/* ============================================================================
   boot-profile.js — deterministic Windows 98 startup profiles and recovery data
   ----------------------------------------------------------------------------
   This module owns startup policy and records only.  The desktop integration
   may ask it for a profile, run a staged model, and render the resulting log;
   it never needs to reach into the shell or window manager.

   Registry and boot-log writes go through W98.reg/W98.fs.  The kernel glue
   owns the persistent snapshot (KREG3, with older loaders retained); this
   module never creates a second browser-side state store.
   ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98 || null;
  var REG_PATH = 'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\BootProfile';
  var LKG_PATH = REG_PATH + '\\LastKnownGood';
  var RUN_PATH = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  var LOG_FILE = 'C:\\WINDOWS\\BOOTLOG.TXT';
  var SCHEMA = 1;
  var MAX_LOG_CHARS = 48 * 1024;
  var MAX_DETAIL_CHARS = 768;
  var MAX_DUMP_CHARS = 16 * 1024;
  var MAX_FAILURES = 24;
  var MAX_GUIDANCE = 24;
  var MAX_LKG_VALUES = 512;

  var PROFILE_LIST = [
    { id: 'normal', label: 'Normal Mode', description: 'Start Windows with all configured devices and startup programs.' },
    { id: 'safe', label: 'Safe Mode', description: 'Start with a minimal display, input, and filesystem set.' },
    { id: 'safe-command', label: 'Safe Mode with Command Prompt', description: 'Start the recovery command prompt without the Windows shell.' },
    { id: 'logged', label: 'Logged Boot', description: 'Start normally and write every startup stage to BOOTLOG.TXT.' },
    { id: 'step-by-step', label: 'Step-by-Step Confirmation', description: 'Expose each startup stage for confirmation by the integration UI.', requiresConfirmation: true },
    { id: 'last-known-good', label: 'Last Known Good Configuration', description: 'Restore the versioned registry subset, then start in Normal Mode.' }
  ];
  var PROFILE_BY_ID = {};
  PROFILE_LIST.forEach(function (p) { PROFILE_BY_ID[p.id] = p; });
  var PROFILE_ALIASES = {
    'normal mode': 'normal', normal: 'normal',
    'safe mode': 'safe', safe: 'safe',
    'safe mode with command prompt': 'safe-command', 'safe-command': 'safe-command', 'safe command': 'safe-command',
    'logged boot': 'logged', logged: 'logged',
    'step-by-step confirmation': 'step-by-step', 'step by step confirmation': 'step-by-step', 'step-by-step': 'step-by-step',
    'last known good configuration': 'last-known-good', 'last-known-good': 'last-known-good', lkg: 'last-known-good'
  };

  /* These IDs and their order are part of the small, deterministic contract.
     A future desk.js integration can replace the stage execution while keeping
     the record shape and recovery UI stable. */
  var STAGE_LIST = [
    { id: 'kernel-initialization', label: 'Kernel initialization', profile: 'all' },
    { id: 'filesystem-restore', label: 'Filesystem restore', profile: 'all' },
    { id: 'registry-restore', label: 'Registry restore', profile: 'all' },
    { id: 'display', label: 'Display', profile: 'all' },
    { id: 'input', label: 'Input', profile: 'all' },
    { id: 'sound', label: 'Sound', profile: 'normal' },
    { id: 'networking', label: 'Networking', profile: 'normal' },
    { id: 'hyperv-integration', label: 'Hyper-V integration', profile: 'normal' },
    { id: 'shell', label: 'Shell', profile: 'normal' },
    { id: 'startup-programs', label: 'Startup programs', profile: 'normal' }
  ];
  var SIMULATIONS = [
    { id: 'disabled-virtual-device', label: 'Disabled virtual device', stage: 'hyperv-integration' },
    { id: 'corrupted-startup-entry', label: 'Corrupted startup entry', stage: 'startup-programs' },
    { id: 'failed-local-driver', label: 'Failed local driver', stage: 'input' },
    { id: 'simulated-registry-recovery', label: 'Simulated registry recovery', stage: 'registry-restore' },
    { id: 'interrupted-restore', label: 'Interrupted restore', stage: 'filesystem-restore' }
  ];
  var SIM_BY_ID = {};
  SIMULATIONS.forEach(function (s) { SIM_BY_ID[s.id] = s; });
  var STAGE_BY_ID = {};
  STAGE_LIST.forEach(function (s) { STAGE_BY_ID[s.id] = s; });

  var state = {
    loaded: false,
    selected: 'normal',
    next: null,
    failedStartup: false,
    lastRecord: null,
    simulations: {},
    lkg: null,
    sequence: 0
  };

  function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }
  function now() { return Date.now(); }
  function json(value, fallback) {
    try { return JSON.parse(value); } catch (e) { return fallback; }
  }
  function clipText(value, limit) {
    var text = String(value == null ? '' : value);
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 28)) + '\n...[truncated]';
  }
  function pushBounded(list, value, limit) {
    if (!value || list.length >= limit) return;
    if (list.indexOf(value) < 0) list.push(clipText(value, MAX_DETAIL_CHARS));
  }
  function regApi() {
    var api = (global.W98 || W98);
    return api && api.reg && typeof api.reg.get === 'function' ? api.reg : null;
  }
  function fsApi() {
    var api = (global.W98 || W98);
    return api && api.fs && (typeof api.fs.readText === 'function' || typeof api.fs.writeText === 'function') ? api.fs : null;
  }
  function readReg(name, dflt) {
    var r = regApi(), v;
    if (r) {
      try {
        v = r.get(REG_PATH, name, null);
        if (v !== null && v !== undefined) return v;
      } catch (e) {}
    }
    return dflt;
  }
  function writeReg(name, value) {
    var str = value == null ? '' : String(value);
    var r = regApi();
    if (r) {
      try { r.set(REG_PATH, name, str); } catch (e) {}
    }
    return str;
  }
  function deleteReg(name) {
    var r = regApi();
    if (r) { try { r.del(REG_PATH, name); } catch (e) {} }
  }
  function normalizeProfile(id) {
    if (id == null) return null;
    if (typeof id === 'object') id = id.id || id.label || id.name;
    var key = String(id).trim().toLowerCase().replace(/\s+/g, ' ');
    return PROFILE_BY_ID[key] ? key : (PROFILE_ALIASES[key] || null);
  }
  function normalizeSimulation(id) {
    var key = String(id == null ? '' : id).trim().toLowerCase().replace(/[_ ]+/g, '-');
    return SIM_BY_ID[key] ? key : null;
  }
  function selectedProfile() {
    return PROFILE_BY_ID[state.selected] || PROFILE_BY_ID.normal;
  }

  function optionalCall(object, name, args, dflt) {
    if (!object || typeof object[name] !== 'function') return dflt;
    try { return object[name].apply(object, args || []); } catch (e) { return dflt; }
  }
  function arrayValue(value, property) {
    if (Array.isArray(value)) return value;
    return value && Array.isArray(value[property]) ? value[property] : [];
  }
  function kernelObservation() {
    var api = global.W98 || W98;
    var stateOut = { halted: false, code: null, params: [], dump: '', source: null };
    var hv = api && api.hv;
    var bug = optionalCall(hv, 'bugcheck', [], null);
    if (bug && typeof bug === 'object') {
      stateOut.halted = !!(bug.halted || bug.haltedFlag);
      stateOut.code = bug.code == null ? null : bug.code;
      stateOut.params = Array.isArray(bug.params) ? bug.params.slice(0, 4) : [];
      stateOut.dump = clipText(bug.dump || '', MAX_DUMP_CHARS);
      stateOut.source = 'W98.hv.bugcheck';
    }
    /* Current kernel.js exposes the NT executive through W98.kernel.exec().
       It is a documented high-level surface used by Task Manager and the VM
       console; do not inspect the raw WASM exports here. */
    var kernel = api && api.kernel;
    var exec = optionalCall(kernel, 'exec', [], null);
    if (exec && typeof exec === 'object') {
      if (exec.haltedFlag || exec.halted) stateOut.halted = true;
      if (!stateOut.dump && typeof exec.bugcheckDump === 'function') {
        stateOut.dump = clipText(optionalCall(exec, 'bugcheckDump', [], ''), MAX_DUMP_CHARS);
      }
      if (!stateOut.source && stateOut.halted) stateOut.source = 'W98.kernel.exec';
    }
    return stateOut;
  }
  function hypervObservation() {
    var api = global.W98HV || null;
    var result = { status: 'degraded', detail: '', failure: null, partitions: [], channels: [] };
    if (!api) {
      result.detail = 'Hyper-V integration surface is unavailable; Windows will continue in degraded mode.';
      return result;
    }
    if (api.mode === 'none' || api.mode === 'shim') {
      result.detail = 'Hyper-V is unavailable in this boot; Windows will continue in degraded mode.';
      return result;
    }
    var partitions = arrayValue(optionalCall(api, 'partitions', [], []), 'partitions');
    var channels = arrayValue(optionalCall(api, 'vmbus', [], []), 'channels');
    result.partitions = partitions.map(function (p) { return { id: p.id, name: clipText(p.name || '', 80), state: p.stateName || p.state || '', isRoot: !!(p.isRoot || p.root), hasGuest: !!p.hasGuest, faults: Number(p.faults) || 0 }; });
    result.channels = channels.map(function (c) { return { id: c.id, partition: c.partition, state: c.stateName || c.state || '' }; });
    var guests = partitions.filter(function (p) { return p && !(p.isRoot || p.root) && (p.hasGuest || p.guest || p.stateName); });
    if (!guests.length) {
      result.detail = 'Hyper-V is running, but no guest integration partition is ready; Windows will continue in degraded mode.';
      return result;
    }
    var degraded = false;
    for (var i = 0; i < guests.length; i++) {
      var p = guests[i];
      var guest = optionalCall(api, 'guest', [p.id], null);
      var faulted = p.stateName === 'faulted' || Number(p.faults) > 0 ||
        (guest && (guest.halted || guest.stageName === 'failed' || guest.error));
      if (faulted) {
        result.status = 'failed';
        result.failure = {
          code: 'W98-HV-002', kind: 'hyperv',
          message: 'Hyper-V guest partition ' + p.id + ' reported a fault or halted integration state.'
        };
        result.detail = result.failure.message;
        return result;
      }
      var channel = channels.filter(function (c) { return c.partition === p.id; })[0];
      if (!channel || (channel.stateName && channel.stateName === 'closed')) degraded = true;
    }
    if (degraded) {
      result.detail = 'Hyper-V guest partitions are present, but one or more VMBus channels are not open; Windows will continue in degraded mode.';
      return result;
    }
    result.status = 'passed';
    result.detail = 'Hyper-V guest partitions and VMBus channels are ready.';
    return result;
  }

  function load() {
    var selected = normalizeProfile(readReg('SelectedProfile', null));
    var next = normalizeProfile(readReg('NextProfile', null));
    var failed = readReg('FailedStartup', '0') === '1';
    var rec = json(readReg('LastBootResult', ''), null);
    var sims = json(readReg('FailureSimulations', '{}'), {});
    var lkg = json(readReg('LastKnownGood', ''), null);
    state.selected = selected || 'normal';
    state.next = next;
    state.failedStartup = failed;
    state.lastRecord = rec && typeof rec === 'object' ? rec : null;
    state.simulations = {};
    if (sims && typeof sims === 'object') Object.keys(sims).forEach(function (id) {
      var n = normalizeSimulation(id);
      if (n && sims[id]) state.simulations[n] = true;
    });
    state.lkg = lkg && typeof lkg === 'object' ? lkg : null;
    var seq = parseInt(readReg('BootSequence', '0'), 10);
    state.sequence = isFinite(seq) && seq >= 0 ? seq : 0;
    state.loaded = true;
    return snapshotState();
  }
  function ensureLoaded() { if (!state.loaded) load(); }
  function snapshotState() {
    return {
      selected: state.selected,
      selectedProfile: clone(selectedProfile()),
      next: state.next,
      nextProfile: state.next ? clone(PROFILE_BY_ID[state.next]) : null,
      failedStartup: !!state.failedStartup,
      simulations: Object.keys(state.simulations).sort(),
      lastRecord: clone(state.lastRecord),
      lastKnownGood: clone(state.lkg)
    };
  }

  function setSelectedProfile(id) {
    ensureLoaded();
    var n = normalizeProfile(id);
    if (!n) throw new Error('Unknown boot profile: ' + id);
    state.selected = n;
    writeReg('SelectedProfile', n);
    return clone(PROFILE_BY_ID[n]);
  }
  function setNextProfile(id) {
    ensureLoaded();
    var n = normalizeProfile(id);
    if (!n) throw new Error('Unknown boot profile: ' + id);
    state.next = n;
    writeReg('NextProfile', n);
    return clone(PROFILE_BY_ID[n]);
  }
  function clearNextProfile() {
    ensureLoaded(); state.next = null; deleteReg('NextProfile'); return true;
  }
  function consumeNextProfile() {
    ensureLoaded();
    var p = state.next || state.selected || 'normal';
    state.selected = p;
    state.next = null;
    writeReg('SelectedProfile', p);
    deleteReg('NextProfile');
    return clone(PROFILE_BY_ID[p]);
  }
  function getSelectedProfile() { ensureLoaded(); return clone(selectedProfile()); }
  function getNextProfile() { ensureLoaded(); return state.next ? clone(PROFILE_BY_ID[state.next]) : null; }

  function getSimulations() {
    ensureLoaded();
    return Object.keys(state.simulations).sort();
  }
  function setFailureSimulation(id, enabled) {
    ensureLoaded();
    var n = normalizeSimulation(id);
    if (!n) throw new Error('Unknown failure simulation: ' + id);
    var r = regApi();
    if (enabled === false) {
      delete state.simulations[n];
      if (n === 'corrupted-startup-entry' && r) { try { r.del(RUN_PATH, 'W98CorruptStartup'); } catch (e) {} }
    } else {
      state.simulations[n] = true;
      /* Seed a visibly bad Run entry so Reset startup programs has a real,
         reversible registry item to remove during this simulation. */
      if (n === 'corrupted-startup-entry' && r) {
        try { r.set(RUN_PATH, 'W98CorruptStartup', 'C:\\WINDOWS\\SYSTEM\\CORRUPT.EXE'); } catch (e) {}
      }
    }
    writeReg('FailureSimulations', JSON.stringify(state.simulations));
    return getSimulations();
  }
  function clearFailureSimulations() {
    ensureLoaded();
    var r = regApi();
    if (r) { try { r.del(RUN_PATH, 'W98CorruptStartup'); } catch (e) {} }
    state.simulations = {}; writeReg('FailureSimulations', '{}'); return true;
  }
  function simulationSet(options) {
    ensureLoaded();
    var out = {};
    /* An explicit set is a deterministic integration input.  When omitted,
       use the persisted recovery toggles that the UI controls. */
    var list;
    if (options && options.simulations !== undefined) {
      list = Array.isArray(options.simulations) ? options.simulations :
        (options.simulations && typeof options.simulations === 'object'
          ? Object.keys(options.simulations).filter(function (id) { return options.simulations[id]; }) : []);
    } else {
      list = Object.keys(state.simulations);
    }
    list.forEach(function (id) { var n = normalizeSimulation(id); if (n) out[n] = true; });
    return out;
  }

  function stagePolicy(profile, stage) {
    if (profile === 'safe' || profile === 'safe-command') {
      if (stage.id === 'sound' || stage.id === 'networking' || stage.id === 'hyperv-integration' || stage.id === 'startup-programs') return false;
      if (profile === 'safe-command' && stage.id === 'shell') return false;
    }
    if (profile === 'last-known-good') return true;
    return true;
  }
  function failureFor(stage, sims) {
    if (stage.id === 'hyperv-integration' && sims['disabled-virtual-device']) {
      return { code: 'W98-HV-001', kind: 'virtual-device', message: 'Disabled virtual device (VMBus integration device is disabled).' };
    }
    if (stage.id === 'startup-programs' && sims['corrupted-startup-entry']) {
      return { code: 'W98-START-001', kind: 'startup-service', message: 'Corrupted startup entry in the Run key.' };
    }
    if (stage.id === 'input' && sims['failed-local-driver']) {
      return { code: 'W98-DRV-001', kind: 'local-driver', message: 'Local driver C:\\WINDOWS\\SYSTEM\\FAILDRV.VXD failed to load.' };
    }
    if (stage.id === 'filesystem-restore' && sims['interrupted-restore']) {
      return { code: 'W98-RST-001', kind: 'restore', message: 'Filesystem restore was interrupted before it completed.' };
    }
    return null;
  }
  function guidanceFor(failure) {
    var g = {
      'W98-HV-001': 'Open Device Manager, enable or remove the disabled virtual device, then retry Normal Mode.',
      'W98-START-001': 'Use Reset startup programs, inspect BOOTLOG.TXT, and remove the damaged Run entry.',
      'W98-DRV-001': 'Restart in Safe Mode and remove or replace the failing local VxD driver.',
      'W98-RST-001': 'Run Last Known Good Configuration or repeat the filesystem restore from Recovery.',
      'W98-REG-001': 'The registry was recovered from the versioned Last Known Good copy; review the boot log.',
      'W98-HV-002': 'Review Hyper-V guest and VMBus diagnostics, then retry Normal Mode after the partition is healthy.',
      'W98-KERNEL-HALTED': 'Preserve the bugcheck dump, restart in Safe Mode, and review BOOTLOG.TXT before changing drivers or registry state.'
    };
    return g[failure.code] || 'Use Safe Mode or Last Known Good Configuration, then review BOOTLOG.TXT.';
  }
  function guidanceForRecovery(id) {
    var g = {
      'simulated-registry-recovery': 'Registry restore completed from a versioned known-good copy.',
      'disabled-virtual-device': 'Enable or remove the disabled virtual device before returning to Normal Mode.',
      'corrupted-startup-entry': 'Reset startup programs and inspect the Run key for the damaged entry.',
      'failed-local-driver': 'Use Safe Mode to replace the failing local driver.',
      'interrupted-restore': 'Repeat restore or use Last Known Good Configuration.'
    };
    return g[id];
  }

  function stageDetail(stage, profile, sims) {
    if (!stagePolicy(profile, stage)) return { status: 'skipped', detail: 'Skipped by ' + PROFILE_BY_ID[profile].label + '.' };
    if (stage.id === 'registry-restore' && sims['simulated-registry-recovery']) {
      return { status: 'recovered', detail: 'Recovered registry hive from Last Known Good copy (simulated).' };
    }
    var f = failureFor(stage, sims);
    if (f) return { status: 'failed', detail: f.message, failure: f };
    if (stage.id === 'shell' && profile === 'safe-command') return { status: 'skipped', detail: 'Windows shell skipped; command prompt recovery path selected.' };
    if (stage.id === 'startup-programs' && (profile === 'safe' || profile === 'safe-command')) return { status: 'skipped', detail: 'Startup programs skipped in Safe Mode.' };
    return { status: 'passed', detail: 'Stage completed.' };
  }
  function realStageMap(stages) {
    var out = {};
    if (!Array.isArray(stages)) return out;
    stages.forEach(function (raw) {
      if (!raw) return;
      var id = String(raw.id || raw.stageId || '').toLowerCase();
      if (!STAGE_BY_ID[id]) return;
      var status = String(raw.status || '').toLowerCase();
      if (status === 'ok' || status === 'complete' || status === 'completed' || status === 'success') status = 'passed';
      if (status === 'error' || status === 'fail' || status === 'failure') status = 'failed';
      if (['passed', 'recovered', 'skipped', 'failed', 'degraded', 'pending'].indexOf(status) < 0) return;
      out[id] = {
        status: status,
        detail: clipText(raw.detail == null ? (raw.message == null ? '' : String(raw.message)) : String(raw.detail), MAX_DETAIL_CHARS),
        durationMs: Number(raw.durationMs),
        failure: raw.failure || null
      };
    });
    return out;
  }
  function normalizeRealFailure(failure, stage) {
    if (!failure) return null;
    if (typeof failure === 'string') return {
      code: 'W98-REAL-' + stage.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-'),
      kind: 'service', message: clipText(failure, MAX_DETAIL_CHARS)
    };
    return {
      code: String(failure.code || ('W98-REAL-' + stage.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-'))),
      kind: String(failure.kind || 'service'),
      message: clipText(failure.message || failure.detail || 'Stage failed.', MAX_DETAIL_CHARS)
    };
  }

  function formatStageLine(stage) {
    var mark = stage.status === 'passed' ? ' OK ' : (stage.status === 'recovered' ? 'REC ' : (stage.status === 'degraded' ? 'WARN' : (stage.status === 'skipped' ? 'SKIP' : 'FAIL')));
    return '[' + mark + '] ' + stage.label + (stage.detail ? ' - ' + stage.detail : '');
  }
  function formatBootLog(record) {
    if (!record) return 'Windows 98 Startup Log\r\nNo staged boot has been recorded.\r\n';
    var stamp;
    try { stamp = new Date(record.startedAt).toISOString(); } catch (e) { stamp = String(record.startedAt); }
    var out = [
      'Windows 98 Startup Log',
      '=======================',
      'Record: ' + record.id,
      'Profile: ' + record.profile.label,
      'Started: ' + stamp,
      'Result: ' + (record.success ? (record.degradations && record.degradations.length ? 'STARTUP COMPLETE (DEGRADED)' : 'STARTUP COMPLETE') : 'STARTUP FAILED')
    ];
    record.stages.forEach(function (stage) { out.push(formatStageLine(stage)); });
    if (record.failures.length) {
      out.push('', 'Recovery guidance:');
      record.failures.forEach(function (f) { out.push('- ' + f.message + ' ' + f.guidance); });
    }
    if (record.guidance && record.guidance.length) {
      out.push('', 'Notes:');
      record.guidance.forEach(function (g) { out.push('- ' + g); });
    }
    if (record.kernelState && record.kernelState.halted) {
      out.push('', 'Kernel recovery:', '- Kernel halted after a bugcheck. Preserve the dump and restart in Safe Mode.');
    }
    out.push('', 'End of startup log.');
    return clipText(out.join('\r\n') + '\r\n', MAX_LOG_CHARS);
  }
  function persistBootLog(record, text) {
    var fs = fsApi();
    var body = clipText(text || formatBootLog(record), MAX_LOG_CHARS);
    if (fs && typeof fs.writeText === 'function') { try { fs.writeText(LOG_FILE, body); } catch (e) {} }
    writeReg('BootLog', body);
    return body;
  }
  function writeRecord(record) {
    state.lastRecord = record;
    state.failedStartup = !record.success;
    writeReg('LastBootResult', JSON.stringify(record));
    writeReg('FailedStartup', record.success ? '0' : '1');
    writeReg('LastBootTime', String(record.startedAt));
    writeReg('ActiveProfile', record.profile.id);
    writeReg('BootSequence', String(state.sequence));
    persistBootLog(record, formatBootLog(record));
  }

  function runBoot(options) {
    options = options || {};
    ensureLoaded();
    var requested = normalizeProfile(options.profile || state.next || state.selected) || 'normal';
    var sims = simulationSet(options);
    /* desk.js can feed observations from its real startup promises later.  The
       fixed stage list remains the contract; supplied entries override the
       deterministic model for matching IDs. */
    var realStages = realStageMap(options.stages || options.realStages);
    var stageRecords = [];
    var failures = [];
    var guidance = [];
    var degradations = [];
    var kernelState = kernelObservation();
    var lkgRestore = null;
    if (requested === 'last-known-good') {
      /* The profile is executable as well as selectable: restore the saved
         subset before recording the staged boot.  An integration may still
         call restoreLastKnownGood() explicitly when presenting a confirmation
         dialog; the operation is idempotent. */
      lkgRestore = restoreLastKnownGood();
      if (lkgRestore.missing) {
        var lkgFailure = {
          code: 'W98-LKG-001', kind: 'restore', stageId: 'registry-restore',
          stage: 'Registry restore', message: 'No Last Known Good registry copy is available.',
          guidance: 'Capture a known-good registry copy after a successful boot, then retry Last Known Good Configuration.'
        };
        failures.push(lkgFailure);
        pushBounded(guidance, lkgFailure.guidance, MAX_GUIDANCE);
      }
    }
    var started = options.now == null ? now() : Number(options.now);
    if (!isFinite(started)) started = now();
    state.sequence += 1;
    STAGE_LIST.forEach(function (spec, index) {
      var d = stageDetail(spec, requested, sims);
      if (realStages[spec.id]) {
        var observed = realStages[spec.id];
        d = {
          status: observed.status,
          detail: observed.detail || 'Stage reported by boot integration.',
          failure: normalizeRealFailure(observed.failure, spec)
        };
        if (d.status === 'failed' && !d.failure) {
          d.failure = normalizeRealFailure(observed.detail || 'Stage failed.', spec);
        }
      }
      if (spec.id === 'hyperv-integration' && !realStages[spec.id] && d.status === 'passed') {
        d = hypervObservation();
      }
      if (spec.id === 'kernel-initialization' && kernelState.halted) {
        d = {
          status: 'failed',
          detail: 'Kernel halted after a bugcheck' + (kernelState.code == null ? '.' : ' (0x' + Number(kernelState.code).toString(16).padStart(8, '0') + ').'),
          failure: {
            code: 'W98-KERNEL-HALTED', kind: 'kernel',
            message: clipText(kernelState.dump || 'Kernel halted after a bugcheck.', MAX_DETAIL_CHARS)
          }
        };
      }
      if (spec.id === 'registry-restore' && requested === 'last-known-good' && lkgRestore && !lkgRestore.missing) {
        d = { status: 'recovered', detail: 'Restored Last Known Good registry version ' + lkgRestore.version + '.' };
      } else if (spec.id === 'registry-restore' && requested === 'last-known-good' && lkgRestore && lkgRestore.missing) {
        d = { status: 'failed', detail: 'No Last Known Good registry copy is available.', failure: {
          code: 'W98-LKG-001', kind: 'restore', message: 'No Last Known Good registry copy is available.'
        } };
      }
      var entry = {
        index: index,
        id: spec.id,
        label: spec.label,
        status: d.status,
        detail: clipText(d.detail || '', MAX_DETAIL_CHARS),
        durationMs: isFinite(realStages[spec.id] && realStages[spec.id].durationMs) ? realStages[spec.id].durationMs : (index + 1) * 7,
        requiresConfirmation: requested === 'step-by-step'
      };
      if (d.failure) {
        /* The missing-LKG case is created while preparing the profile.  Keep a
           single failure object in the record and attach it to its stage. */
        var existing = failures.filter(function (f) { return f.code === d.failure.code && f.stageId === spec.id; })[0];
        var f = {
          code: d.failure.code,
          kind: d.failure.kind,
          stageId: spec.id,
          stage: spec.label,
          message: clipText(d.failure.message, MAX_DETAIL_CHARS),
          guidance: existing ? existing.guidance : guidanceFor(d.failure)
        };
        entry.failure = f;
        if (!existing && failures.length < MAX_FAILURES) failures.push(f);
        pushBounded(guidance, f.guidance, MAX_GUIDANCE);
      }
      if (d.status === 'degraded') {
        var degradedMessage = clipText(d.detail || 'Stage completed in degraded mode.', MAX_DETAIL_CHARS);
        if (degradations.length < MAX_FAILURES) degradations.push({ stageId: spec.id, stage: spec.label, message: degradedMessage });
        pushBounded(guidance, degradedMessage, MAX_GUIDANCE);
      }
      stageRecords.push(entry);
    });
    Object.keys(sims).sort().forEach(function (id) {
      var note = guidanceForRecovery(id);
      pushBounded(guidance, note, MAX_GUIDANCE);
    });
    var record = {
      schemaVersion: SCHEMA,
      id: 'BOOT-' + String(state.sequence).padStart(4, '0'),
      profile: clone(PROFILE_BY_ID[requested]),
      confirmationRequired: requested === 'step-by-step',
      startedAt: started,
      completedAt: started + stageRecords.length * 7,
      success: failures.length === 0,
      status: failures.length === 0 ? 'success' : 'failed',
      failedStartup: failures.length !== 0,
      simulations: Object.keys(sims).sort(),
      stages: stageRecords,
      failures: failures,
      guidance: guidance,
      degradations: degradations,
      kernelState: kernelState
    };
    state.selected = requested;
    state.next = null;
    writeReg('SelectedProfile', requested);
    deleteReg('NextProfile');
    writeRecord(record);
    return clone(record);
  }

  function lastBootResult() { ensureLoaded(); return clone(state.lastRecord); }
  function bootLog() {
    ensureLoaded();
    var fs = fsApi();
    if (fs && typeof fs.readText === 'function') { try { var t = fs.readText(LOG_FILE); if (t) return clipText(t, MAX_LOG_CHARS); } catch (e) {} }
    var stored = readReg('BootLog', '');
    return stored ? clipText(stored, MAX_LOG_CHARS) : formatBootLog(state.lastRecord);
  }
  function openBootLog() {
    var api = global.W98 || W98;
    var fs = fsApi();
    if (fs && typeof fs.writeText === 'function') { try { fs.writeText(LOG_FILE, bootLog()); } catch (e) {} }
    if (api && typeof api.launch === 'function' && api.getApp && api.getApp('notepad')) return api.launch('notepad', { path: LOG_FILE });
    return bootLog();
  }
  function clearFailedStartup() {
    ensureLoaded(); state.failedStartup = false; writeReg('FailedStartup', '0'); return true;
  }

  function knownSubset() {
    return [
      'HKEY_CURRENT_USER\\Software\\W98',
      'HKEY_CURRENT_USER\\Control Panel\\Desktop',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Services',
      'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Class'
    ];
  }
  function captureRegistrySubset() {
    var values = [];
    var api = global.W98 || W98;
    if (api && typeof api.regCount === 'function' && typeof api.regEnum === 'function') {
      var count = 0;
      try { count = Number(api.regCount()) || 0; } catch (e) { count = 0; }
      for (var i = 0; i < count; i++) {
        var item = null;
        try { item = api.regEnum(i); } catch (e) {}
        if (!item || !item.path) continue;
        var path = String(item.path);
        if (path.indexOf(REG_PATH) === 0 || LKG_PATH.indexOf(path) === 0) continue;
        if (knownSubset().some(function (prefix) { return path.indexOf(prefix) === 0; })) {
          if (values.length < MAX_LKG_VALUES) values.push({ path: clipText(path, 256), name: clipText(String(item.name || ''), 128), value: clipText(String(item.value == null ? '' : item.value), MAX_DETAIL_CHARS) });
        }
      }
    }
    /* Before kernel enumeration is available, capture the small set most
       useful for recovery.  These reads work through shell's early registry. */
    if (!values.length && api && api.reg && typeof api.reg.get === 'function') {
      [
        ['HKEY_CURRENT_USER\\Software\\W98', 'MuteSounds'],
        ['HKEY_CURRENT_USER\\Software\\W98', 'Volume'],
        ['HKEY_CURRENT_USER\\Control Panel\\Desktop', 'ColorScheme'],
        ['HKEY_CURRENT_USER\\Control Panel\\Desktop', 'Wallpaper']
      ].forEach(function (k) {
        var v = api.reg.get(k[0], k[1], null);
        if (v !== null && v !== undefined && values.length < MAX_LKG_VALUES) values.push({ path: k[0], name: k[1], value: clipText(String(v), MAX_DETAIL_CHARS) });
      });
    }
    values.sort(function (a, b) {
      var ka = a.path + '\\' + a.name, kb = b.path + '\\' + b.name;
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
    return values;
  }
  function captureLastKnownGood(options) {
    ensureLoaded(); options = options || {};
    var previous = state.lkg && Number(state.lkg.version) || 0;
    var snap = {
      schemaVersion: SCHEMA,
      version: previous + 1,
      createdAt: options.now == null ? now() : Number(options.now),
      values: captureRegistrySubset()
    };
    state.lkg = snap;
    writeReg('LastKnownGood', JSON.stringify(snap));
    writeReg('LastKnownGoodVersion', String(snap.version));
    return clone(snap);
  }
  function getLastKnownGood() { ensureLoaded(); return clone(state.lkg); }
  function restoreLastKnownGood() {
    ensureLoaded();
    var snap = state.lkg;
    if (!snap || !Array.isArray(snap.values)) {
      snap = json(readReg('LastKnownGood', ''), null);
    }
    if (!snap || !Array.isArray(snap.values)) return { restored: 0, version: null, missing: true };
    var api = global.W98 || W98, restored = 0;
    snap.values.forEach(function (item) {
      if (!item || !item.path || item.path.indexOf(REG_PATH) === 0) return;
      if (api && api.reg && typeof api.reg.set === 'function') {
        try { api.reg.set(item.path, item.name, item.value); restored++; } catch (e) {}
      }
    });
    writeReg('LastKnownGoodRestoredVersion', String(snap.version));
    writeReg('LastKnownGoodRestoredAt', String(now()));
    clearFailedStartup();
    return { restored: restored, version: snap.version, missing: false, schemaVersion: snap.schemaVersion };
  }

  function resetStartupPrograms() {
    var api = global.W98 || W98, removed = [], names = [];
    if (api && typeof api.regCount === 'function' && typeof api.regEnum === 'function') {
      var n = Number(api.regCount()) || 0;
      for (var i = 0; i < n; i++) {
        var item = null;
        try { item = api.regEnum(i); } catch (e) {}
        if (!item || item.path !== RUN_PATH) continue;
        var name = String(item.name || '');
        names.push(name);
        if (/corrupt|broken|bad|fail/i.test(name) && api.reg && typeof api.reg.del === 'function') {
          try { api.reg.del(RUN_PATH, name); removed.push(name); } catch (e) {}
        }
      }
    }
    if (removed.indexOf('W98CorruptStartup') >= 0) {
      ensureLoaded();
      delete state.simulations['corrupted-startup-entry'];
      writeReg('FailureSimulations', JSON.stringify(state.simulations));
    }
    writeReg('StartupProgramsReset', '1');
    writeReg('StartupProgramsResetAt', String(now()));
    return { removed: removed, inspected: names };
  }
  function commandPromptRecovery(options) {
    var api = global.W98 || W98;
    var result = { profile: setNextProfile('safe-command'), launched: false };
    if (options && options.launch === false) return result;
    if (api && typeof api.launch === 'function' && api.getApp && api.getApp('cmd')) {
      try { api.launch('cmd', { recovery: true }); result.launched = true; } catch (e) { result.error = String(e.message || e); }
    }
    return result;
  }
  function failedComponents(record) {
    record = record || lastBootResult();
    if (!record) return { devices: [], services: [], drivers: [], stages: [] };
    var out = { devices: [], services: [], drivers: [], stages: [] };
    (record.failures || []).forEach(function (f) {
      out.stages.push(f.stage);
      if (f.kind === 'virtual-device' || f.kind === 'hyperv') out.devices.push(f.message);
      else if (f.kind === 'local-driver') {
        /* Keep the explicit drivers bucket for integrations that distinguish
           them, and mirror it in services for the recovery app's simpler
           services-and-drivers list. */
        out.drivers.push(f.message);
        out.services.push(f.message);
      }
      else out.services.push(f.message);
    });
    return out;
  }

  var API = {
    schemaVersion: SCHEMA,
    registryPath: REG_PATH,
    logFile: LOG_FILE,
    PROFILE_IDS: PROFILE_LIST.map(function (p) { return p.id; }),
    PROFILES: PROFILE_LIST.map(clone),
    STAGES: STAGE_LIST.map(clone),
    BOOT_STAGES: STAGE_LIST.map(clone),
    SIMULATIONS: SIMULATIONS.map(clone),
    profiles: function () { return PROFILE_LIST.map(clone); },
    listProfiles: function () { return PROFILE_LIST.map(clone); },
    stages: function () { return STAGE_LIST.map(clone); },
    listStages: function () { return STAGE_LIST.map(clone); },
    simulations: function () { return SIMULATIONS.map(clone); },
    listSimulations: function () { return SIMULATIONS.map(clone); },
    load: load,
    state: snapshotState,
    getState: snapshotState,
    confirmationRequired: function (profile) {
      var n = normalizeProfile(profile || state.selected);
      return n === 'step-by-step';
    },
    getSelectedProfile: getSelectedProfile,
    getProfile: getSelectedProfile,
    getNextProfile: getNextProfile,
    setSelectedProfile: setSelectedProfile,
    setProfile: setSelectedProfile,
    selectProfile: setSelectedProfile,
    setNextProfile: setNextProfile,
    selectNextProfile: setNextProfile,
    setNextBootMode: setNextProfile,
    clearNextProfile: clearNextProfile,
    consumeNextProfile: consumeNextProfile,
    runBoot: runBoot,
    executeBoot: runBoot,
    recordBoot: function (stages, options) {
      options = options || {};
      options.stages = stages;
      return runBoot(options);
    },
    getLastBootResult: lastBootResult,
    getLastBoot: lastBootResult,
    lastBootResult: lastBootResult,
    getBootLog: bootLog,
    bootLog: bootLog,
    formatBootLog: formatBootLog,
    persistBootLog: persistBootLog,
    openBootLog: openBootLog,
    clearFailedStartup: clearFailedStartup,
    clearStartupFailure: clearFailedStartup,
    hasFailedStartup: function () { ensureLoaded(); return !!state.failedStartup; },
    setFailureSimulation: setFailureSimulation,
    simulateFailure: function (id) { return setFailureSimulation(id, true); },
    clearFailureSimulations: clearFailureSimulations,
    getFailureSimulations: getSimulations,
    failedComponents: failedComponents,
    getFailedComponents: failedComponents,
    showFailedDevices: failedComponents,
    captureLastKnownGood: captureLastKnownGood,
    saveLastKnownGood: captureLastKnownGood,
    getLastKnownGood: getLastKnownGood,
    restoreLastKnownGood: restoreLastKnownGood,
    restoreLkg: restoreLastKnownGood,
    restoreLastKnownGoodConfiguration: restoreLastKnownGood,
    resetStartupPrograms: resetStartupPrograms,
    resetStartup: resetStartupPrograms,
    commandPromptRecovery: commandPromptRecovery,
    openCommandPrompt: commandPromptRecovery,
    openCommandPromptRecovery: commandPromptRecovery
  };

  global.W98BootProfile = API;
  global.W98BootProfiles = API;
  if (global.W98) {
    global.W98.bootProfile = API;
    global.W98.bootProfiles = API;
  }
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('w98-kernel-ready', function () {
      /* Registry persistence becomes available when kernel.wasm is ready. */
      W98 = global.W98 || W98;
      if (W98) { W98.bootProfile = API; W98.bootProfiles = API; }
      load();
    });
  }
})(window);
