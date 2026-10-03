/* ============================================================================
   boot-profile.js — deterministic Windows 98 startup profiles and recovery data
   ----------------------------------------------------------------------------
   This module owns startup policy and records only.  The desktop integration
   may ask it for a profile, run a staged model, and render the resulting log;
   it never needs to reach into the shell or window manager.

   Registry writes are mirrored to localStorage so profile choices made before
   kernel.wasm is ready are still available on the next reload.  Once the
   kernel is ready W98.reg is authoritative and the mirror is refreshed.
   ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98 || null;
  var REG_PATH = 'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\BootProfile';
  var LKG_PATH = REG_PATH + '\\LastKnownGood';
  var RUN_PATH = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  var LOG_FILE = 'C:\\WINDOWS\\BOOTLOG.TXT';
  var STORE_PREFIX = 'w98.boot-profile.';
  var SCHEMA = 1;

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
  function storageGet(key) {
    try { return global.localStorage ? global.localStorage.getItem(STORE_PREFIX + key) : null; }
    catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { if (global.localStorage) global.localStorage.setItem(STORE_PREFIX + key, String(value)); }
    catch (e) { /* localStorage can be disabled; registry remains canonical */ }
  }
  function regApi() {
    var api = (global.W98 || W98);
    return api && api.reg && typeof api.reg.get === 'function' ? api.reg : null;
  }
  function fsApi() {
    var api = (global.W98 || W98);
    return api && api.fs && typeof api.fs.writeText === 'function' ? api.fs : null;
  }
  function readReg(name, dflt) {
    var r = regApi(), v;
    if (r) {
      try {
        v = r.get(REG_PATH, name, null);
        if (v !== null && v !== undefined) return v;
      } catch (e) { /* local mirror below */ }
    }
    v = storageGet(name);
    return v === null || v === undefined ? dflt : v;
  }
  function writeReg(name, value) {
    var str = value == null ? '' : String(value);
    var r = regApi();
    if (r) {
      try { r.set(REG_PATH, name, str); } catch (e) { /* mirror still records it */ }
    }
    storageSet(name, str);
    return str;
  }
  function deleteReg(name) {
    var r = regApi();
    if (r) { try { r.del(REG_PATH, name); } catch (e) {} }
    try { if (global.localStorage) global.localStorage.removeItem(STORE_PREFIX + name); } catch (e) {}
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
      'W98-REG-001': 'The registry was recovered from the versioned Last Known Good copy; review the boot log.'
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
      if (['passed', 'recovered', 'skipped', 'failed', 'pending'].indexOf(status) < 0) return;
      out[id] = {
        status: status,
        detail: raw.detail == null ? (raw.message == null ? '' : String(raw.message)) : String(raw.detail),
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
      kind: 'service', message: failure
    };
    return {
      code: String(failure.code || ('W98-REAL-' + stage.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-'))),
      kind: String(failure.kind || 'service'),
      message: String(failure.message || failure.detail || 'Stage failed.')
    };
  }

  function formatStageLine(stage) {
    var mark = stage.status === 'passed' ? ' OK ' : (stage.status === 'recovered' ? 'REC ' : (stage.status === 'skipped' ? 'SKIP' : 'FAIL'));
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
      'Result: ' + (record.success ? 'STARTUP COMPLETE' : 'STARTUP FAILED')
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
    out.push('', 'End of startup log.');
    return out.join('\r\n') + '\r\n';
  }
  function persistBootLog(record, text) {
    var fs = fsApi();
    var body = text || formatBootLog(record);
    if (fs) { try { fs.writeText(LOG_FILE, body); } catch (e) {} }
    writeReg('BootLog', body);
    storageSet('LastBootLog', body);
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
        guidance.push(lkgFailure.guidance);
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
        detail: d.detail,
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
          message: d.failure.message,
          guidance: existing ? existing.guidance : guidanceFor(d.failure)
        };
        entry.failure = f;
        if (!existing) failures.push(f);
        if (guidance.indexOf(f.guidance) < 0) guidance.push(f.guidance);
      }
      stageRecords.push(entry);
    });
    Object.keys(sims).sort().forEach(function (id) {
      var note = guidanceForRecovery(id);
      if (note && guidance.indexOf(note) < 0) guidance.push(note);
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
      guidance: guidance
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
    if (fs) { try { var t = fs.readText(LOG_FILE); if (t) return t; } catch (e) {} }
    return storageGet('LastBootLog') || formatBootLog(state.lastRecord);
  }
  function openBootLog() {
    var api = global.W98 || W98;
    var fs = fsApi();
    if (fs) { try { fs.writeText(LOG_FILE, bootLog()); } catch (e) {} }
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
          values.push({ path: path, name: String(item.name || ''), value: String(item.value == null ? '' : item.value) });
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
        if (v !== null && v !== undefined) values.push({ path: k[0], name: k[1], value: String(v) });
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
    storageSet('LastKnownGood', JSON.stringify(snap));
    return clone(snap);
  }
  function getLastKnownGood() { ensureLoaded(); return clone(state.lkg); }
  function restoreLastKnownGood() {
    ensureLoaded();
    var snap = state.lkg;
    if (!snap || !Array.isArray(snap.values)) {
      var raw = storageGet('LastKnownGood');
      snap = json(raw || '', null);
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
      if (f.kind === 'virtual-device') out.devices.push(f.message);
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
