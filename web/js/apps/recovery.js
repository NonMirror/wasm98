/* ============================================================================
 * recovery.js — Windows 98 Startup and Recovery
 *
 * This is deliberately a small shell application.  It only talks to the
 * public W98 registry/filesystem APIs and to W98.bootProfile (when the boot
 * profile service is present).  The adapter below keeps the application
 * useful while that service is being wired into the desktop boot sequence.
 * ========================================================================== */
(function () {
  'use strict';

  var W98 = window.W98;
  if (!W98 || typeof W98.registerApp !== 'function') { return; }

  var ID = 'recovery';
  var REG = 'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\BootProfile';
  var BOOT_LOG = 'C:\\WINDOWS\\BOOTLOG.TXT';
  var PROFILE_NAMES = [
    'Normal Mode',
    'Safe Mode',
    'Safe Mode with Command Prompt',
    'Logged Boot',
    'Step-by-Step Confirmation',
    'Last Known Good Configuration'
  ];
  var STAGE_NAMES = [
    ['kernel-initialization', 'Kernel initialization'],
    ['filesystem-restore', 'Filesystem restore'],
    ['registry-restore', 'Registry restore'],
    ['display', 'Display'],
    ['input', 'Input'],
    ['sound', 'Sound'],
    ['networking', 'Networking'],
    ['hyperv-integration', 'Hyper-V integration'],
    ['shell', 'Shell'],
    ['startup-programs', 'Startup programs']
  ];
  var FAILURE_DEFS = [
    { id: 'disabled-virtual-device', label: 'Disabled virtual device', hint: 'A virtual device was disabled in the hardware profile.' },
    { id: 'corrupted-startup-entry', label: 'Corrupted startup entry', hint: 'A startup command could not be read.' },
    { id: 'failed-local-driver', label: 'Failed local driver', hint: 'A local driver returned an initialization error.' },
    { id: 'simulated-registry-recovery', label: 'Simulated registry recovery', hint: 'The previous registry hive was recovered from a backup.' },
    { id: 'interrupted-restore', label: 'Interrupted restore', hint: 'A restore operation stopped before it completed.' }
  ];

  var CSS = [
    '.rc-root{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:#c0c0c0;color:#000;font:11px Tahoma,"MS Sans Serif",sans-serif;overflow:hidden}',
    '.rc-root *{box-sizing:border-box}',
    '.rc-banner{display:flex;align-items:center;padding:7px 9px;background:#fff;border-bottom:1px solid #808080;min-height:51px}',
    '.rc-flag{width:30px;height:30px;margin-right:9px;position:relative;background:linear-gradient(135deg,#f00 0 24%,#ff0 24% 48%,#00a000 48% 73%,#0080ff 73%);border:1px solid #404040;box-shadow:1px 1px 0 #fff}',
    '.rc-banner-title{font:bold 14px Arial,sans-serif;color:#000080}',
    '.rc-banner-sub{margin-top:2px;color:#404040}',
    '.rc-tabs{display:flex;gap:2px;padding:4px 6px 0;background:#c0c0c0}',
    '.rc-tab{padding:3px 10px 4px;min-width:100px;border-radius:0;border:1px solid #808080;border-bottom-color:#000;background:#c0c0c0;font:11px Tahoma,sans-serif;cursor:default}',
    '.rc-tab.active{border-color:#fff #000 #c0c0c0 #fff;position:relative;font-weight:bold;z-index:1}',
    '.rc-page{display:flex;flex:1 1 auto;min-height:0;overflow:hidden;margin:0 5px 5px;border:1px solid #fff;border-right-color:#404040;border-bottom-color:#404040;background:#c0c0c0;padding:8px}',
    '.rc-page-inner{display:flex;flex-direction:column;min-height:0;min-width:0;flex:1 1 auto;gap:8px}',
    '.rc-group{position:relative;padding:11px 9px 7px;border:1px solid #808080;border-right-color:#fff;border-bottom-color:#fff;box-shadow:inset 1px 1px 0 #000;min-width:0}',
    '.rc-group-title{position:absolute;top:-7px;left:7px;padding:0 3px;background:#c0c0c0;font-weight:normal}',
    '.rc-row{display:flex;align-items:center;gap:7px;min-height:21px}',
    '.rc-grow{flex:1 1 auto;min-width:0}',
    '.rc-label{flex:0 0 108px}',
    '.rc-select{height:21px;min-width:220px;padding:1px 2px;border-radius:0;background:#fff;color:#000;border:1px solid #808080;border-right-color:#fff;border-bottom-color:#fff;font:11px Tahoma,sans-serif}',
    '.rc-button{min-width:88px;height:23px;padding:2px 8px;border-radius:0;font:11px Tahoma,sans-serif;white-space:nowrap}',
    '.rc-button.wide{min-width:150px}',
    '.rc-button:disabled{color:#808080}',
    '.rc-status{padding:5px 7px;background:#fff;border:1px solid #808080;border-right-color:#fff;border-bottom-color:#fff;box-shadow:inset 1px 1px 0 #000;white-space:pre-wrap;line-height:15px;min-height:47px}',
    '.rc-status.ok{color:#006000}',
    '.rc-status.bad{color:#800000}',
    '.rc-list{background:#fff;border:1px solid #808080;border-right-color:#fff;border-bottom-color:#fff;box-shadow:inset 1px 1px 0 #000;overflow:auto;min-height:0}',
    '.rc-list.grow{flex:1 1 auto}',
    '.rc-list-row{display:flex;align-items:center;gap:6px;padding:2px 5px;min-height:20px;border-bottom:1px dotted #c0c0c0}',
    '.rc-list-row:last-child{border-bottom:0}',
    '.rc-stage-name{flex:0 0 143px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.rc-stage-detail{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#404040}',
    '.rc-state{flex:0 0 48px;text-align:right;font-weight:bold}',
    '.rc-state.ok,.rc-state.passed,.rc-state.recovered{color:#006000}.rc-state.failed{color:#800000}.rc-state.degraded,.rc-state.skipped{color:#806000}.rc-state.pending{color:#404040}',
    '.rc-log{font:11px/15px "Lucida Console","Courier New",monospace;white-space:pre;overflow:auto;flex:1 1 auto;min-height:80px;background:#fff;color:#000;border:1px solid #808080;border-right-color:#fff;border-bottom-color:#fff;box-shadow:inset 1px 1px 0 #000;padding:4px}',
    '.rc-note{font-size:10px;color:#404040;line-height:14px}',
    '.rc-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}',
    '.rc-two{display:flex;gap:8px;flex:1 1 auto;min-height:0}',
    '.rc-two>.rc-group{display:flex;flex-direction:column;flex:1 1 50%;min-height:0}',
    '.rc-sim-row{display:flex;align-items:center;gap:6px;padding:2px 0}',
    '.rc-sim-row button{margin-left:auto;min-width:68px;height:20px;padding:1px 4px}',
    '.rc-bulb{width:8px;height:8px;border:1px solid #404040;background:#00a000;flex:none}.rc-bulb.bad{background:#f00}.rc-bulb.warn{background:#ff0}',
    '.rc-empty{padding:8px;color:#404040;font-style:italic}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style');
    st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }
  function regGet(name, dflt) {
    try { return W98.reg && W98.reg.get ? W98.reg.get(REG, name, dflt) : dflt; } catch (e) { return dflt; }
  }
  function regSet(name, value) {
    try { if (W98.reg && W98.reg.set) { W98.reg.set(REG, name, String(value)); } } catch (e) { /* registry is optional */ }
  }
  function jsonGet(name, dflt) {
    var raw = regGet(name, null);
    if (raw === null || raw === undefined || raw === '') { return dflt; }
    try { return JSON.parse(raw); } catch (e) { return dflt; }
  }
  function jsonSet(name, value) { regSet(name, JSON.stringify(value)); }
  function profileService() {
    var b = W98.bootProfile || W98.bootProfiles || W98.bootRecovery || window.W98BootProfile || window.W98BootProfiles;
    return b && typeof b === 'object' ? b : null;
  }
  function callService(names, args) {
    var b = profileService();
    if (!b) { return { found: false, value: undefined }; }
    for (var i = 0; i < names.length; i++) {
      if (typeof b[names[i]] === 'function') {
        try { return { found: true, value: b[names[i]].apply(b, args || []) }; } catch (e) {
          return { found: true, error: e, value: undefined };
        }
      }
    }
    return { found: false, value: undefined };
  }
  function invoke(names, args, done) {
    var r = callService(names, args);
    if (!r.found) { done(undefined, false); return; }
    if (r.value && typeof r.value.then === 'function') {
      r.value.then(function (v) { done(v, true); }, function () { done(undefined, true); });
    } else { done(r.value, true); }
  }
  function nowText() {
    var d = new Date();
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' +
      (d.getHours() % 12 || 12) + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() +
      (d.getHours() < 12 ? ' AM' : ' PM');
  }
  function safeText(v, dflt) { return v == null || v === '' ? dflt : String(v); }
  function boundedText(v, limit) {
    var s = safeText(v, '');
    return s.length > limit ? s.slice(0, limit - 18) + '\n...[truncated]' : s;
  }
  function textList(value, limit) {
    return Array.isArray(value) ? value.slice(0, 24).map(function (x) { return boundedText(x, limit); }) : [];
  }
  function defaultStages() {
    return STAGE_NAMES.map(function (x) {
      return { id: x[0], name: x[1], status: 'ok', detail: 'Completed' };
    });
  }
  function defaultResult() {
    var failed = String(regGet('FailedStartup', '0')) === '1';
    return {
      status: failed ? 'failed' : 'success',
      failedStartup: failed,
      summary: failed ? 'Windows did not start normally. Recovery options are available.' : 'Windows started successfully.',
      timestamp: safeText(regGet('LastBootTime', ''), nowText()),
      profile: safeText(regGet('ActiveProfile', ''), safeText(regGet('SelectedProfile', ''), 'Normal Mode')),
      stages: defaultStages(),
      failures: jsonGet('Failures', { devices: [], services: [] }),
      degradations: [],
      kernelState: { halted: false, code: null, params: [], dump: '' }
    };
  }
  function normalizeStages(stages) {
    var source = Array.isArray(stages) ? stages : defaultStages();
    var byId = {};
    source.forEach(function (s) {
      if (!s) { return; }
      var id = s.id || s.key || String(s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      var status = String(s.status || (s.ok === false ? 'failed' : 'ok')).toLowerCase();
      if (status === 'complete' || status === 'completed' || status === 'success') status = 'passed';
      byId[id] = { id: id, name: s.name || s.label || id, status: status, detail: boundedText(s.detail || s.message, 768) };
    });
    return STAGE_NAMES.map(function (x) {
      return byId[x[0]] || { id: x[0], name: x[1], status: 'pending', detail: 'No record' };
    });
  }
  function normalizeResult(v) {
    var d = defaultResult();
    if (!v || typeof v !== 'object') { return d; }
    var profile = v.profile || v.mode || d.profile;
    if (profile && typeof profile === 'object') profile = profile.label || profile.name || profile.id;
    var stamp = v.timestamp || v.time;
    if (!stamp && v.startedAt != null) {
      try { stamp = new Date(Number(v.startedAt)).toLocaleString(); } catch (e) { stamp = v.startedAt; }
    }
    var result = {
      status: String(v.status || v.result || (v.success === false || v.ok === false ? 'failed' : (v.success === true || v.ok === true ? 'success' : d.status))).toLowerCase(),
      failedStartup: v.failedStartup == null ? d.failedStartup : !!v.failedStartup,
      summary: safeText(v.summary || v.message, d.summary),
      timestamp: safeText(stamp, d.timestamp),
      profile: safeText(profile, d.profile),
      stages: normalizeStages(v.stages || v.stageResults || d.stages),
      failures: v.failures || d.failures,
      degradations: Array.isArray(v.degradations) ? v.degradations.slice(0, 24) : [],
      kernelState: v.kernelState || v.kernel || v.bugcheck || d.kernelState
    };
    if (result.status === 'ok' || result.status === 'passed' || result.status === 'complete') { result.status = 'success'; }
    if (result.status === 'failed' || result.status === 'error') result.status = 'failed';
    if (result.status === 'warn' || result.status === 'degraded') result.status = 'degraded';
    if (result.kernelState && typeof result.kernelState === 'object') {
      result.kernelState = {
        halted: !!(result.kernelState.halted || result.kernelState.haltedFlag),
        code: result.kernelState.code == null ? null : result.kernelState.code,
        params: Array.isArray(result.kernelState.params) ? result.kernelState.params.slice(0, 4) : [],
        dump: safeText(result.kernelState.dump, '').slice(0, 16384)
      };
    } else result.kernelState = d.kernelState;
    if (!v.summary && Array.isArray(v.failures) && v.failures.length) result.summary = v.failures[0].message || 'One or more startup stages failed.';
    return result;
  }
  function normalizeLog(v, result) {
    if (Array.isArray(v)) return boundedText(v.map(String).join('\n'), 49152);
    if (v && typeof v === 'object') {
      if (Array.isArray(v.lines)) return boundedText(v.lines.map(String).join('\n'), 49152);
      if (typeof v.text === 'string') return boundedText(v.text, 49152);
    }
    if (typeof v === 'string' && v) return boundedText(v, 49152);
    return boundedText(result.stages.map(function (s) {
      return '[' + (s.status === 'failed' ? 'FAIL' : s.status.toUpperCase()) + '] ' + s.name + (s.detail ? ' - ' + s.detail : '');
    }).join('\n'), 49152);
  }
  function profiles() {
    var r = callService(['listProfiles', 'getProfiles', 'profiles'], []);
    var p = r.found && Array.isArray(r.value) ? r.value : null;
    if (!p || !p.length) return PROFILE_NAMES.slice();
    return p.map(function (x) { return typeof x === 'string' ? x : (x.label || x.name || x.id); }).filter(Boolean);
  }
  function selectedProfile() {
    var r = callService(['getNextProfile', 'getSelectedProfile', 'getProfile', 'currentProfile'], []);
    if (r.found && (r.value == null || r.value === '')) {
      var selected = callService(['getSelectedProfile', 'getProfile', 'currentProfile'], []);
      if (selected.found && selected.value != null) r = selected;
    }
    if (!r.found) {
      r = callService(['getState', 'state'], []);
      if (r.found && r.value && typeof r.value === 'object') r.value = r.value.nextProfile || r.value.selectedProfile || r.value.selected || null;
    }
    var v = r.found ? r.value : null;
    if (v && typeof v === 'object') v = v.name || v.label || v.id;
    v = safeText(v, safeText(regGet('SelectedProfile', ''), 'Normal Mode'));
    var ids = { normal: 'Normal Mode', safe: 'Safe Mode', 'safe-command': 'Safe Mode with Command Prompt', logged: 'Logged Boot', 'step-by-step': 'Step-by-Step Confirmation', 'last-known-good': 'Last Known Good Configuration' };
    return ids[String(v).toLowerCase()] || v;
  }
  function readResult(done) {
    var r = callService(['getLastBootResult', 'getLastResult', 'lastBootResult', 'lastBoot'], []);
    if (!r.found) {
      r = callService(['getState', 'state'], []);
      if (r.found && r.value && typeof r.value === 'object') r.value = r.value.lastRecord || r.value.lastBootResult || null;
    }
    if (r.found && r.value && typeof r.value.then === 'function') {
      r.value.then(function (v) { applyCurrentFlag(normalizeResult(v), done); }, function () { applyCurrentFlag(defaultResult(), done); });
    } else { applyCurrentFlag(normalizeResult(r.found ? r.value : null), done); }
  }
  function applyCurrentFlag(record, done) {
    var f = callService(['hasFailedStartup', 'failedStartup'], []);
    if (f.found && typeof f.value !== 'object') record.failedStartup = !!f.value;
    else record.failedStartup = String(regGet('FailedStartup', record.failedStartup ? '1' : '0')) === '1';
    done(record);
  }
  function readLog(result, done) {
    var r = callService(['getBootLog', 'bootLog', 'getLog'], []);
    function finish(v) { done(normalizeLog(v, result)); }
    if (r.found && r.value && typeof r.value.then === 'function') r.value.then(finish, function () { finish(null); });
    else finish(r.found ? r.value : jsonGet('BootLog', null));
  }
  function failureData(result) {
    var f = result && result.failures;
    var r = callService(['getFailures', 'getFailedDevicesAndServices', 'getFailedComponents', 'failedComponents'], [result]);
    if (r.found && r.value && typeof r.value === 'object') f = r.value;
    f = f || jsonGet('Failures', { devices: [], services: [] });
    if (Array.isArray(f)) {
      var arr = f, out = { devices: [], services: [] };
      arr.forEach(function (x) {
        if (out.devices.length + out.services.length >= 24) return;
        x = x || {};
        var msg = boundedText(x.message || x.detail || x.stage || x, 768);
        if (x.kind === 'virtual-device' || x.kind === 'device' || x.kind === 'hyperv') out.devices.push(msg);
        else out.services.push(msg);
      });
      return out;
    }
    return {
      devices: textList(f.devices || f.virtualDevices, 768),
      services: textList(f.services || f.drivers, 768)
    };
  }
  function writeBootLog(text) {
    var body = boundedText(text, 49152);
    regSet('BootLog', body);
    try { if (W98.fs && W98.fs.writeText) W98.fs.writeText(BOOT_LOG, body); } catch (e) { /* optional filesystem */ }
  }
  function toast(message, kind) {
    var box = document.querySelector('.rc-status');
    if (!box) return;
    box.textContent = message;
    box.className = 'rc-status ' + (kind || '');
  }
  function alertMessage(title, text) {
    if (W98.dialog && W98.dialog.alert) W98.dialog.alert(title, text, 'info');
    else {
      /* The app contract forbids browser-native dialogs.  This fallback keeps
         the recovery window usable in a reduced test harness without reaching
         into the shell or blocking the page. */
      var box = document.querySelector('.rc-status');
      if (box) {
        box.textContent = title + ': ' + text;
        box.className = 'rc-status';
      }
    }
  }
  function doAction(names, args, fallback, message, refresh) {
    invoke(names, args, function (value, found) {
      if (!found && fallback) { fallback(); }
      if (message) toast(message, 'ok');
      if (refresh) refresh();
    });
  }

  W98.registerApp({
    id: ID,
    title: 'Windows 98 Startup and Recovery',
    icon: 'system',
    width: 650,
    height: 500,
    minWidth: 540,
    minHeight: 380,
    resizable: true,
    startMenuGroup: 'System Tools',
    create: create
  });

  function create(win) {
    ensureCss();
    win.el.style.display = 'flex';
    win.el.style.flexDirection = 'column';
    var root = mk('div', 'rc-root');
    win.el.appendChild(root);
    var banner = mk('div', 'rc-banner');
    banner.appendChild(mk('div', 'rc-flag'));
    var bt = mk('div', 'rc-grow');
    bt.appendChild(mk('div', 'rc-banner-title', 'Windows 98 Startup and Recovery'));
    bt.appendChild(mk('div', 'rc-banner-sub', 'Review the previous startup and choose what Windows should try next.'));
    banner.appendChild(bt);
    root.appendChild(banner);

    var tabs = mk('div', 'rc-tabs');
    var page = mk('div', 'rc-page');
    var inner = mk('div', 'rc-page-inner');
    page.appendChild(inner);
    root.appendChild(tabs); root.appendChild(page);
    var tabNames = ['Boot status', 'Boot log', 'Diagnostics'];
    var currentTab = 0;
    var result = defaultResult();
    var logText = '';
    var refreshTimer = null;

    function setTitle() { win.setTitle('Startup and Recovery'); }
    function button(text, fn, cls) {
      var b = mk('button', 'rc-button' + (cls ? ' ' + cls : ''), text);
      b.type = 'button'; b.onclick = fn; return b;
    }
    function group(title) {
      var g = mk('div', 'rc-group');
      g.appendChild(mk('div', 'rc-group-title', title)); return g;
    }
    function stagesList(stages) {
      var list = mk('div', 'rc-list grow');
      stages.forEach(function (s) {
        var row = mk('div', 'rc-list-row');
        var bulb = mk('span', 'rc-bulb ' + (s.status === 'failed' ? 'bad' : (s.status === 'skipped' || s.status === 'degraded' ? 'warn' : '')));
        row.appendChild(bulb); row.appendChild(mk('span', 'rc-stage-name', s.name));
        row.appendChild(mk('span', 'rc-stage-detail', s.detail || ''));
        row.appendChild(mk('span', 'rc-state ' + (s.status || 'pending'), (s.status || 'pending').toUpperCase()));
        list.appendChild(row);
      });
      return list;
    }
    function buildStatus() {
      inner.innerHTML = '';
      var top = group('Startup profile');
      var row = mk('div', 'rc-row');
      row.appendChild(mk('span', 'rc-label', 'Next boot mode:'));
      var sel = mk('select', 'rc-select');
      var ps = profiles(), selected = selectedProfile();
      ps.forEach(function (p) { var o = mk('option', '', p); o.value = p; sel.appendChild(o); });
      sel.value = selected;
      if (sel.value !== selected && ps.length) sel.value = ps[0];
      sel.onchange = function () {
        var p = sel.value;
        invoke(['setNextProfile', 'selectProfile', 'setProfile'], [p], function (v, found) {
          /* The profile service owns canonical IDs and NextProfile.  Keep a
             small label fallback only when the service has not loaded yet. */
          if (!found) { regSet('SelectedProfile', p); regSet('NextProfile', p); }
          toast('The next boot mode is set to ' + p + '.', 'ok');
        });
      };
      row.appendChild(sel); top.appendChild(row);
      var note = mk('div', 'rc-note', 'The selected mode is saved in the system registry and remains selected after reload.');
      top.appendChild(note);
      inner.appendChild(top);

      var state = group('Last boot result');
      var halted = result.kernelState && result.kernelState.halted;
      var degraded = result.status === 'degraded' || (result.degradations && result.degradations.length);
      var status = mk('div', 'rc-status ' + (result.status === 'failed' || halted ? 'bad' : (degraded ? '' : 'ok')));
      status.textContent = (result.status === 'failed' || halted ? 'FAILED — ' : (degraded ? 'DEGRADED — ' : 'SUCCESS — ')) + result.summary +
        '\nProfile: ' + result.profile + '    Time: ' + result.timestamp +
        '\nFailed-startup flag: ' + (result.failedStartup ? 'SET' : 'CLEAR');
      if (halted) {
        status.textContent += '\nKernel: HALTED after bugcheck' + (result.kernelState.code == null ? '' : ' 0x' + Number(result.kernelState.code).toString(16).padStart(8, '0')) +
          '. Preserve the dump and restart in Safe Mode.';
      }
      if (degraded) status.textContent += '\nHyper-V or another integration stage is running in degraded mode; review Diagnostics.';
      state.appendChild(status);
      var actions = mk('div', 'rc-actions');
      actions.appendChild(button('Clear failed-startup flag', function () {
        doAction(['clearFailedStartup', 'clearFailedFlag', 'clearFailureFlag'], [], function () {
          regSet('FailedStartup', '0');
          result.status = 'success';
          result.summary = 'The failed-startup flag was cleared.';
        }, 'The failed-startup flag has been cleared.', refresh);
      }, 'wide'));
      actions.appendChild(button('Restore Last Known Good', function () {
        invoke(['restoreLastKnownGood', 'restoreLkg', 'restoreLastGood'], [], function (value, found) {
          if (found && value && value.missing) {
            toast('No Last Known Good registry copy is available. Capture one after a successful boot.', 'bad');
            return;
          }
          if (!found) {
            var lkg = jsonGet('LastKnownGood', null);
            if (!lkg) {
              toast('No Last Known Good registry copy is available. Capture one after a successful boot.', 'bad');
              return;
            }
            if (lkg.registry) jsonSet('RegistrySubset', lkg.registry);
          }
          regSet('LastRestore', 'Last Known Good Configuration');
          toast('Last Known Good Configuration has been restored.', 'ok');
          refresh();
        });
      }, 'wide'));
      actions.appendChild(button('Command Prompt', function () {
        var r = callService(['openCommandPrompt', 'commandPrompt', 'recoveryCommandPrompt'], [{ profile: selectedProfile(), recovery: true }]);
        if (!r.found && W98.launch) W98.launch('cmd', { recovery: true, profile: selectedProfile() });
      }));
      state.appendChild(actions); inner.appendChild(state);

      var stages = group('Staged boot record');
      stages.style.flex = '1 1 auto'; stages.style.display = 'flex'; stages.style.flexDirection = 'column'; stages.appendChild(stagesList(result.stages));
      inner.appendChild(stages);
      var foot = mk('div', 'rc-note', 'Green entries completed. Red entries need recovery. Yellow entries were skipped by the selected profile.');
      inner.appendChild(foot);
    }
    function buildLog() {
      inner.innerHTML = '';
      var g = group('BOOTLOG.TXT');
      g.style.flex = '1 1 auto'; g.style.display = 'flex'; g.style.flexDirection = 'column';
      var pre = mk('div', 'rc-log', logText || '(No boot log has been recorded.)');
      g.appendChild(pre);
      var actions = mk('div', 'rc-actions');
      actions.appendChild(button('Open in Notepad', function () {
        writeBootLog(logText);
        if (W98.launch) W98.launch('notepad', { path: BOOT_LOG });
      }, 'wide'));
      actions.appendChild(button('Refresh', refresh));
      g.appendChild(actions); inner.appendChild(g);
      inner.appendChild(mk('div', 'rc-note', 'The log is stored at ' + BOOT_LOG + ' and can be inspected while diagnosing a failed startup.'));
    }
    function failedList(title, items, empty) {
      var g = group(title);
      g.style.flex = '1 1 auto'; g.style.display = 'flex'; g.style.flexDirection = 'column';
      var list = mk('div', 'rc-list grow');
      if (!items.length) list.appendChild(mk('div', 'rc-empty', empty));
      items.forEach(function (x) {
        var row = mk('div', 'rc-list-row'); row.appendChild(mk('span', 'rc-bulb bad')); row.appendChild(mk('span', 'rc-grow', x)); list.appendChild(row);
      });
      g.appendChild(list); return g;
    }
    function buildDiagnostics() {
      inner.innerHTML = '';
      var f = failureData(result);
      var two = mk('div', 'rc-two');
      two.appendChild(failedList('Failed virtual devices', f.devices, 'No virtual devices failed.'));
      two.appendChild(failedList('Failed services and drivers', f.services, 'No services or local drivers failed.'));
      inner.appendChild(two);
      var kernel = group('Kernel state');
      var ks = result.kernelState || {};
      if (ks.halted) {
        kernel.appendChild(mk('div', 'rc-status bad', 'Kernel halted after a bugcheck. The recovery utility has preserved the bounded diagnostic dump.'));
        var dump = mk('pre', 'rc-log', safeText(ks.dump, '(No bugcheck dump was returned by the kernel.)'));
        dump.style.maxHeight = '112px'; dump.style.flex = '0 1 auto';
        kernel.appendChild(dump);
      } else {
        kernel.appendChild(mk('div', 'rc-note', 'The kernel reports a running state. Recovery actions leave kernel and registry state intact.'));
      }
      if (result.degradations && result.degradations.length) {
        var dg = mk('div', 'rc-note', 'Degraded stages: ' + result.degradations.map(function (x) { return x.stage || x.stageId || x.message; }).join('; '));
        kernel.appendChild(dg);
      }
      inner.appendChild(kernel);
      var startup = group('Startup programs');
      startup.appendChild(mk('div', 'rc-note', 'Reset the per-user startup list if a corrupted entry prevents the shell from loading.'));
      var sr = mk('div', 'rc-actions');
      sr.appendChild(button('Reset startup programs', function () {
        doAction(['resetStartupPrograms', 'resetStartup'], [], function () { jsonSet('StartupPrograms', []); }, 'Startup programs were reset. Restart Windows to test the clean list.', refresh);
      }, 'wide'));
      startup.appendChild(sr); inner.appendChild(startup);

      var sim = group('Failure simulation');
      sim.appendChild(mk('div', 'rc-note', 'Use these deterministic tests to verify recovery guidance before a real boot failure occurs.'));
      FAILURE_DEFS.forEach(function (d) {
        var r = mk('div', 'rc-sim-row');
        r.appendChild(mk('span', 'rc-bulb warn')); r.appendChild(mk('span', 'rc-grow', d.label));
        var b = button('Simulate', function () { simulateFailure(d); }); r.appendChild(b); sim.appendChild(r);
      });
      var clear = mk('div', 'rc-actions'); clear.appendChild(button('Clear simulated failures', function () {
        invoke(['clearFailureSimulations', 'clearSimulations'], [], function (v, found) {
          if (!found) {
            jsonSet('Simulations', {}); jsonSet('Failures', { devices: [], services: [] }); regSet('FailedStartup', '0');
            toast('Simulated failures were cleared.', 'ok'); refresh();
            return;
          }
          invoke(['clearFailedStartup', 'clearFailedFlag'], [], function () {
            toast('Simulated failures were cleared.', 'ok'); refresh();
          });
        });
      })); sim.appendChild(clear); inner.appendChild(sim);
    }
    function simulateFailure(def) {
      invoke(['simulateFailure', 'simulateBootFailure', 'setFailureSimulation'], [def.id], function (v, found) {
        if (!found) {
          var sim = jsonGet('Simulations', {}); sim[def.id] = { label: def.label, time: nowText() }; jsonSet('Simulations', sim);
          var f = jsonGet('Failures', { devices: [], services: [] });
          if (def.id === 'disabled-virtual-device') f.devices = ['VIRTUAL_' + 'DEVICE (disabled)'];
          else if (def.id === 'failed-local-driver') f.services = ['LOCALDRV.VXD (initialization failed)'];
          else if (def.id === 'corrupted-startup-entry') f.services = ['Startup entry (corrupted)'];
          else if (def.id === 'simulated-registry-recovery') f.services = ['Registry recovery (simulated)'];
          else if (def.id === 'interrupted-restore') f.services = ['Restore operation (interrupted)'];
          jsonSet('Failures', f); regSet('FailedStartup', '1');
          var stageFor = { 'disabled-virtual-device': 'hyperv-integration', 'corrupted-startup-entry': 'startup-programs', 'failed-local-driver': 'input', 'simulated-registry-recovery': 'registry-restore', 'interrupted-restore': 'filesystem-restore' };
          result.stages.forEach(function (s) { if (s.id === stageFor[def.id]) { s.status = def.id === 'simulated-registry-recovery' ? 'recovered' : 'failed'; s.detail = def.hint; } });
          var lines = normalizeLog(null, result).split('\n'); lines.push('[FAIL] ' + def.label + ' - ' + def.hint); writeBootLog(lines.join('\n'));
          result.status = 'failed'; result.summary = def.hint; result.failures = f;
        }
        /* The deterministic service records a simulation first, then runs a
           normal staged record so the failed stage and guidance are inspectable
           immediately in this window.  An integration can replace runBoot
           with its real stage runner without changing this UI. */
        invoke(['runBoot', 'executeBoot'], [{ profile: 'normal' }], function () {
        alertMessage('Startup Recovery Test', def.label + '\n\n' + def.hint + '\n\nRecovery guidance: select Safe Mode or Logged Boot, review BOOTLOG.TXT, then clear the failed-startup flag after the cause is corrected.');
        refresh();
        });
      });
    }
    function render() {
      tabs.innerHTML = '';
      tabNames.forEach(function (n, i) {
        var b = mk('button', 'rc-tab' + (i === currentTab ? ' active' : ''), n);
        b.type = 'button'; b.onclick = function () { currentTab = i; render(); }; tabs.appendChild(b);
      });
      if (currentTab === 0) buildStatus(); else if (currentTab === 1) buildLog(); else buildDiagnostics();
    }
    function refresh() {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      readResult(function (r) {
        result = r;
        readLog(result, function (l) { logText = l; writeBootLog(logText); render(); });
      });
    }
    setTitle(); render(); refresh();
    return { onResize: function () { }, onFocus: function () { } };
  }
})();
