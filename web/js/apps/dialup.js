/* ============================================================================
 * dialup.js — deterministic, local-only Windows 98 Dial-Up Networking.
 *
 * This app deliberately does not use browser network primitives.  A connection
 * is a small state machine backed
 * by the W98 registry.  The public W98.dialup object is consumed by the local
 * intranet and Network Neighborhood applications.
 * ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98;
  if (!W98 || !W98.registerApp) return;
  var U = W98.util || {};
  var el = U.el || function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  var esc = U.escapeHtml || function (s) {
    return String(s == null ? '' : s).replace(/[&<>\"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c];
    });
  };

  var ROOT = 'HKEY_CURRENT_USER\\Software\\W98\\DialUp';
  var PROFILE_ROOT = ROOT + '\\Profiles';
  var PHONEBOOK_ROOT = ROOT + '\\PhoneBook';
  var PREF_ROOT = ROOT + '\\Preferences';
  var MODEM_ROOT = ROOT + '\\Modem';
  var PROFILE_INDEX = 'ProfileIndex';
  var SCHEMA = 1;
  var STATES = ['disconnected', 'dialing', 'connected', 'busy', 'failed', 'dropped'];

  var DEFAULT_PROFILES = [
    {
      id: 'acme-isp', name: 'Acme Internet', phone: '555-0198', areaCode: '555',
      username: 'guest', password: '', device: 'Standard 56K Modem', speed: 56000,
      delayMs: 1700, outcome: 'connected', dns: true, autoRedial: false,
      peers: ['ACME-FILESERVER', 'SALES-PC', 'RECEPTION']
    },
    {
      id: 'office-lan', name: 'Acme Office LAN', phone: '555-0142', areaCode: '555',
      username: 'employee', password: '', device: 'Standard 56K Modem', speed: 33600,
      delayMs: 1300, outcome: 'connected', dns: true, autoRedial: false,
      peers: ['ACME-FILESERVER', 'SALES-PC', 'RECEPTION', 'ACCOUNTING']
    }
  ];

  function clone(x) {
    try { return JSON.parse(JSON.stringify(x)); } catch (e) { return x; }
  }
  function regGet(path, name, dflt) {
    try { return W98.reg.get(path, name, dflt); } catch (e) { return dflt; }
  }
  function regSet(path, name, value) {
    try { W98.reg.set(path, name, value); } catch (e) { /* registry is optional in early boot */ }
  }
  function regDel(path, name) {
    try { W98.reg.del(path, name); } catch (e) { /* ignored */ }
  }
  function normalizeId(s) {
    var id = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    return id.replace(/^-+|-+$/g, '') || 'connection';
  }
  function now() { return Date.now(); }

  /* The registry stores one JSON value per profile, plus a simple index.  The
     individual phone-book values are written too so old-style registry tools
     can inspect the entries without understanding the JSON envelope. */
  function persistProfiles(profiles) {
    var ids = profiles.map(function (p) { return p.id; });
    regSet(PROFILE_ROOT, PROFILE_INDEX, JSON.stringify(ids));
    profiles.forEach(function (p) {
      var path = PROFILE_ROOT + '\\' + p.id;
      regSet(path, 'Profile', JSON.stringify(p));
      regSet(path, 'Name', p.name);
      regSet(path, 'PhoneNumber', p.phone);
      regSet(path, 'UserName', p.username || '');
      regSet(path, 'Device', p.device || 'Standard 56K Modem');
      regSet(path, 'Speed', p.speed || 56000);
      regSet(PHONEBOOK_ROOT, p.id, p.phone || '');
    });
  }
  function readProfiles() {
    var raw = regGet(PROFILE_ROOT, PROFILE_INDEX, null), ids = [];
    if (raw) {
      try { ids = JSON.parse(raw); } catch (e) { ids = String(raw).split(','); }
      if (!Array.isArray(ids)) ids = [];
    }
    var out = [];
    ids.forEach(function (id) {
      var rawProfile = regGet(PROFILE_ROOT + '\\' + id, 'Profile', null), p = null;
      try { p = rawProfile ? JSON.parse(rawProfile) : null; } catch (e) { p = null; }
      if (!p) {
        p = {
          id: id, name: regGet(PROFILE_ROOT + '\\' + id, 'Name', id),
          phone: regGet(PROFILE_ROOT + '\\' + id, 'PhoneNumber', ''),
          username: regGet(PROFILE_ROOT + '\\' + id, 'UserName', ''),
          device: regGet(PROFILE_ROOT + '\\' + id, 'Device', 'Standard 56K Modem'),
          speed: Number(regGet(PROFILE_ROOT + '\\' + id, 'Speed', 56000)) || 56000,
          delayMs: 1600, outcome: 'connected', dns: true, peers: []
        };
      }
      out.push(p);
    });
    if (!out.length) {
      out = clone(DEFAULT_PROFILES);
      persistProfiles(out);
    }
    return out;
  }

  var profiles = readProfiles();
  var prefs = {
    lastProfile: regGet(PREF_ROOT, 'LastProfile', profiles[0] && profiles[0].id || ''),
    autoConnect: regGet(PREF_ROOT, 'AutoConnect', '0') === '1',
    redial: regGet(PREF_ROOT, 'Redial', '0') === '1',
    timeoutMs: Math.max(1000, Number(regGet(PREF_ROOT, 'TimeoutMs', 8000)) || 8000),
    dialingTone: regGet(PREF_ROOT, 'DialingTone', '1') !== '0'
  };
  var modem = {
    name: regGet(MODEM_ROOT, 'Name', 'Standard 56K Modem'),
    port: regGet(MODEM_ROOT, 'Port', 'COM1'),
    speakerVolume: Number(regGet(MODEM_ROOT, 'SpeakerVolume', 70)) || 70,
    speaker: regGet(MODEM_ROOT, 'Speaker', 'on') !== 'off',
    maxSpeed: Number(regGet(MODEM_ROOT, 'MaxSpeed', 56000)) || 56000,
    flowControl: regGet(MODEM_ROOT, 'FlowControl', 'Hardware')
  };

  var model = {
    state: 'disconnected', profile: null, error: '', startedAt: 0, connectedAt: 0,
    speed: 0, durationMs: 0, sequence: 0
  };
  var timers = { dial: null, duration: null, pulse: null, drop: null };
  var listeners = [];

  function snapshot() {
    var out = clone(model);
    out.state = model.state;
    out.profile = model.profile ? clone(model.profile) : null;
    out.durationMs = model.state === 'connected' && model.connectedAt ? Math.max(0, now() - model.connectedAt) : model.durationMs;
    out.speed = Number(model.speed) || 0;
    out.duration = formatDuration(out.durationMs);
    out.elapsedMs = out.durationMs;
    out.elapsed = out.duration;
    out.connectionSpeed = out.speed;
    out.startTime = model.startedAt;
    out.states = STATES.slice();
    return out;
  }
  function notify(reason) {
    var s = snapshot();
    s.reason = reason || '';
    listeners.slice().forEach(function (fn) { try { fn(s); } catch (e) { /* listener failures do not break dialing */ } });
  }
  /* Keep the other local-only adapters in step with the connection state.  The
     scripts are intentionally loosely coupled because the integration build
     may load them in either order.  A missing adapter is simply ignored. */
  function syncAdapters() {
    var nn = W98.networkNeighborhood;
    try {
      if (nn && typeof nn.syncFromDialup === 'function') {
        nn.syncFromDialup(service);
      } else if (nn && typeof nn.setConnection === 'function') {
        nn.setConnection(model.state, { startedAt: model.connectedAt || model.startedAt || 0 });
      }
    } catch (e) { /* network window is optional */ }
    try {
      if (W98.localIntranet && typeof W98.localIntranet.setConnectionState === 'function') {
        W98.localIntranet.setConnectionState(model.state);
      }
    } catch (e2) { /* intranet adapter is optional */ }
  }
  function clearTimer(k) {
    if (timers[k] != null) { global.clearTimeout(timers[k]); global.clearInterval(timers[k]); timers[k] = null; }
  }
  function clearTimers() { ['dial', 'duration', 'pulse', 'drop'].forEach(clearTimer); }
  function play(ev) { try { if (W98.sound && W98.sound.play) W98.sound.play(ev); } catch (e) { } }
  function tone(freq, ms) { try { if (W98.sound && W98.sound.tone) W98.sound.tone(freq, ms || 70, 'square'); } catch (e) { } }

  function formatDuration(ms) {
    var sec = Math.floor((Number(ms) || 0) / 1000), m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setState(state, detail) {
    if (STATES.indexOf(state) < 0) state = 'failed';
    model.state = state;
    if (detail && detail.error) model.error = String(detail.error);
    if (state !== 'connected') {
      clearTimer('duration');
      if (state !== 'dialing') clearTimer('pulse');
      if (state !== 'dropped') model.durationMs = model.connectedAt ? Math.max(0, now() - model.connectedAt) : 0;
    }
    syncAdapters();
    notify('state');
  }
  function profileFor(p) {
    if (!p) return profiles[0] || null;
    if (typeof p === 'object') return p;
    var id = String(p).toLowerCase();
    for (var i = 0; i < profiles.length; i++) if (profiles[i].id.toLowerCase() === id || String(profiles[i].name).toLowerCase() === id) return profiles[i];
    return null;
  }
  function peersFor(profile) {
    if (!profile || model.state !== 'connected') return [];
    return (profile.peers || []).map(function (name, i) {
      if (typeof name === 'string') return { id: normalizeId(name), name: name, online: true, address: '192.168.98.' + (20 + i), shares: ['PUBLIC'] };
      return clone(name);
    });
  }
  function connect(profileArg, options) {
    options = options || {};
    /* Convenience overload: connect({ outcome: 'busy' }) uses the last
       phone-book entry, which is useful to deterministic tests and the
       troubleshooting menu. */
    if (profileArg && typeof profileArg === 'object' && !profileArg.id && !profileArg.name) {
      options = profileArg; profileArg = options.profile || null;
    }
    var p = profileFor(profileArg || options.profile || prefs.lastProfile);
    if (!p) { model.error = 'No phone-book entry is selected.'; setState('failed', model); return false; }
    clearTimers();
    model.sequence++;
    model.profile = clone(p);
    model.error = '';
    model.startedAt = now();
    model.connectedAt = 0;
    model.durationMs = 0;
    model.speed = 0;
    prefs.lastProfile = p.id;
    regSet(PREF_ROOT, 'LastProfile', p.id);
    setState('dialing');
    play('DialTone');
    var seq = model.sequence;
    if (prefs.dialingTone) {
      var flip = false;
      timers.pulse = global.setInterval(function () {
        if (seq !== model.sequence || model.state !== 'dialing') return;
        flip = !flip; tone(flip ? 420 : 520, 85);
        notify('dialing');
      }, 280);
    }
    var delay = Math.max(250, Number(options.delayMs != null ? options.delayMs : p.delayMs) || 1500);
    if (delay > prefs.timeoutMs && !options.outcome && (!p.outcome || p.outcome === 'connected')) {
      timers.dial = global.setTimeout(function () { if (seq === model.sequence) fail('Connection timed out.'); }, prefs.timeoutMs);
    } else {
      timers.dial = global.setTimeout(function () {
        if (seq !== model.sequence || model.state !== 'dialing') return;
        var outcome = String(options.outcome || options.state || p.outcome || 'connected').toLowerCase();
        if (outcome === 'timeout' || outcome === 'timedout') return fail('The remote computer did not respond.');
        if (outcome === 'busy') { clearTimer('pulse'); model.speed = 0; model.error = 'The line is busy.'; setState('busy'); play('SystemExclamation'); return; }
        if (outcome === 'dns' || outcome === 'dns-error') return fail('The DNS server could not be reached.');
        if (outcome === 'failed' || outcome === 'failure' || outcome === 'error') return fail(options.error || 'Unable to establish a connection.');
        clearTimer('pulse');
        model.speed = Math.min(Number(p.speed) || 56000, Number(modem.maxSpeed) || 56000);
        model.connectedAt = now();
        setState('connected');
        play('Notify');
        timers.duration = global.setInterval(function () {
          if (model.state !== 'connected') return;
          notify('duration');
        }, 1000);
        var drop = Number(options.dropAfterMs != null ? options.dropAfterMs : p.dropAfterMs);
        if (outcome === 'dropped' && !(drop > 0)) drop = 450;
        if (drop > 0) timers.drop = global.setTimeout(function () { if (seq === model.sequence) dropConnection('The connection was dropped.'); }, drop);
      }, delay);
    }
    notify('dial');
    return true;
  }
  function fail(message) {
    clearTimers(); model.speed = 0; model.error = message || 'Connection failed.'; setState('failed'); play('SystemHand');
  }
  function dropConnection(message) {
    clearTimers(); model.durationMs = model.connectedAt ? Math.max(0, now() - model.connectedAt) : model.durationMs;
    model.speed = 0; model.error = message || 'The connection was dropped.'; setState('dropped'); play('SystemExclamation');
  }
  function disconnect(reason) {
    var wasConnected = model.state === 'connected';
    clearTimers();
    if (wasConnected && model.connectedAt) model.durationMs = Math.max(0, now() - model.connectedAt);
    model.speed = 0; model.error = reason ? String(reason) : '';
    setState('disconnected');
    play('MenuCommand');
    return true;
  }
  function redial(options) {
    disconnect();
    return connect(prefs.lastProfile, options || {});
  }

  function createProfile(profile) {
    profile = profile || {};
    var p = {
      id: normalizeId(profile.id || profile.name || 'connection-' + (profiles.length + 1)),
      name: String(profile.name || 'New Connection'), phone: String(profile.phone || ''), areaCode: String(profile.areaCode || ''),
      username: String(profile.username || ''), password: String(profile.password || ''), device: String(profile.device || modem.name),
      speed: Number(profile.speed) || 56000, delayMs: Number(profile.delayMs) || 1500, outcome: profile.outcome || 'connected',
      dns: profile.dns !== false, autoRedial: !!profile.autoRedial, peers: clone(profile.peers || [])
    };
    var base = p.id, n = 2;
    while (profiles.some(function (x) { return x.id === p.id; })) p.id = base + '-' + (n++);
    profiles.push(p); persistProfiles(profiles); notify('profile'); return clone(p);
  }
  function updateProfile(id, patch) {
    var p = profileFor(id); if (!p) return null;
    Object.keys(patch || {}).forEach(function (k) { if (k !== 'id') p[k] = patch[k]; });
    p.id = normalizeId(p.id); persistProfiles(profiles); notify('profile'); return clone(p);
  }
  function removeProfile(id) {
    var p = profileFor(id); if (!p) return false;
    if (model.profile && model.profile.id === p.id) disconnect();
    profiles = profiles.filter(function (x) { return x.id !== p.id; });
    regDel(PROFILE_ROOT + '\\' + p.id, 'Profile'); regDel(PHONEBOOK_ROOT, p.id);
    if (!profiles.length) profiles = clone(DEFAULT_PROFILES);
    persistProfiles(profiles); if (prefs.lastProfile === p.id) { prefs.lastProfile = profiles[0].id; regSet(PREF_ROOT, 'LastProfile', prefs.lastProfile); }
    notify('profile'); return true;
  }

  var service = {
    schema: SCHEMA,
    states: STATES.slice(),
    getState: snapshot,
    status: snapshot,
    state: function () { return model.state; },
    getConnectionState: function () { return model.state; },
    getProfiles: function () { return clone(profiles); },
    profiles: function () { return clone(profiles); },
    getPhoneBook: function () { return clone(profiles); },
    phoneBook: function () { return clone(profiles); },
    getProfile: function (id) { var p = profileFor(id); return p ? clone(p) : null; },
    createProfile: createProfile,
    addProfile: createProfile,
    saveProfile: function (profile) {
      if (!profile) return null;
      return profile.id && profileFor(profile.id) ? updateProfile(profile.id, profile) : createProfile(profile);
    },
    updateProfile: updateProfile,
    removeProfile: removeProfile,
    connect: connect,
    disconnect: disconnect,
    redial: redial,
    fail: fail,
    drop: dropConnection,
    listPeers: function () { return peersFor(model.profile); },
    getPeers: function () { return peersFor(model.profile); },
    isConnected: function () { return model.state === 'connected'; },
    getModem: function () { return clone(modem); },
    setModem: function (patch) {
      var names = { name: 'Name', port: 'Port', speakerVolume: 'SpeakerVolume', speaker: 'Speaker', maxSpeed: 'MaxSpeed', flowControl: 'FlowControl' };
      Object.keys(patch || {}).forEach(function (k) {
        if (!(k in modem)) return;
        modem[k] = patch[k];
        regSet(MODEM_ROOT, names[k] || k, k === 'speaker' ? (modem[k] ? 'on' : 'off') : modem[k]);
      });
      notify('modem'); return clone(modem);
    },
    getPreferences: function () { return clone(prefs); },
    setPreferences: function (patch) { Object.keys(patch || {}).forEach(function (k) { if (k in prefs) { prefs[k] = patch[k]; regSet(PREF_ROOT, k === 'lastProfile' ? 'LastProfile' : k === 'autoConnect' ? 'AutoConnect' : k === 'redial' ? 'Redial' : k === 'timeoutMs' ? 'TimeoutMs' : 'DialingTone', (typeof prefs[k] === 'boolean' ? (prefs[k] ? '1' : '0') : prefs[k])); } }); notify('preferences'); return clone(prefs); },
    subscribe: function (fn) { if (typeof fn !== 'function') return function () { }; listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    on: function (fn) { return this.subscribe(fn); },
    onChange: function (fn) { return this.subscribe(fn); },
    formatDuration: formatDuration,
    /* Adapter used by local-intranet.js: URL resolution is intentionally a
       pure lookup and never leaves the virtual filesystem. */
    canResolve: function (host) {
      var p = model.profile || profileFor(prefs.lastProfile), h = String(host || '').toLowerCase();
      var localName = h === 'intranet' || h === 'intranet.local' || h.indexOf('acme.') === 0 || /\.local$/.test(h);
      return model.state === 'connected' && !!p && p.dns !== false && localName;
    },
    resolveHost: function (host) {
      var h = String(host || '').toLowerCase();
      if (!this.canResolve(h)) return { ok: false, error: model.state !== 'connected' ? 'The dial-up connection is not available.' : 'DNS lookup failed for ' + h + '.' };
      return { ok: true, host: h, address: '192.168.98.10' };
    }
  };
  W98.dialup = service;

  /* ------------------------------ UI ---------------------------------- */
  var CSS = '@keyframes du-spin{to{transform:rotate(360deg)}}' +
    '.du-root{display:flex;flex-direction:column;height:100%;width:100%;font:11px Tahoma,"MS Sans Serif",sans-serif;background:#c0c0c0}' +
    '.du-root *{box-sizing:border-box}.du-body{display:flex;gap:7px;padding:8px;flex:1;min-height:0}.du-list{width:175px;display:flex;flex-direction:column;gap:4px}.du-list select{flex:1;min-height:100px}.du-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}.du-panel{padding:7px;background:#c0c0c0;border:1px solid #808080;box-shadow:inset 1px 1px #fff}.du-row{display:flex;align-items:center;gap:5px}.du-row label{width:92px}.du-grow{flex:1}.du-state{font:bold 13px Tahoma;color:#000080}.du-spinner{display:inline-block;width:11px;height:11px;border:2px dotted #000080;border-radius:50%;margin-right:4px;vertical-align:-1px;animation:du-spin .7s steps(8,end) infinite}.du-buttons{display:flex;justify-content:flex-end;gap:5px;padding:7px}.du-buttons button{min-width:70px}.du-note{color:#404040}.du-error{color:#800000}.du-tabs{display:flex;gap:4px;padding:5px 7px 0}.du-tabs button.active{font-weight:bold}.du-hidden{display:none}';
  function css() {
    if (document.getElementById('w98app-dialup')) return;
    var st = document.createElement('style'); st.id = 'w98app-dialup'; st.textContent = CSS; document.head.appendChild(st);
  }
  function button(label, fn) { var b = el('button', '', esc(label)); b.onclick = fn; return b; }
  function input(value, type) { var i = el('input'); i.type = type || 'text'; i.value = value == null ? '' : value; return i; }

  W98.registerApp({
    id: 'dialup', title: 'Dial-Up Networking', icon: 'dial-up', width: 535, height: 390,
    minWidth: 450, minHeight: 330, desktop: false, singleton: true, startMenuGroup: 'Programs',
    create: function (win, args) {
      css(); args = args || {};
      var selected = profileFor(args.profile || prefs.lastProfile) || profiles[0];
      var root = el('div', 'du-root'); win.el.appendChild(root);
      var tabs = el('div', 'du-tabs'), bConn = button('Connections', function () { showTab('connections'); }), bModem = button('Modem Properties', function () { showTab('modem'); });
      tabs.appendChild(bConn); tabs.appendChild(bModem); root.appendChild(tabs);
      var body = el('div', 'du-body'); root.appendChild(body);
      var list = el('div', 'du-list'), sel = el('select');
      list.appendChild(el('div', 'du-note', 'Phone-book entries:'));
      list.appendChild(sel);
      var add = button('New...', function () { var p = createProfile({ name: 'New Connection', phone: '' }); selected = p; renderProfiles(); sel.value = p.id; renderProfile(); });
      var edit = button('Edit...', function () { editProfile(); });
      list.appendChild(el('div', 'du-row')).appendChild(add); list.lastChild.appendChild(edit);
      body.appendChild(list);
      var main = el('div', 'du-main'); body.appendChild(main);
      var panel = el('div', 'du-panel du-grow'); main.appendChild(panel);
      var buttons = el('div', 'du-buttons'); root.appendChild(buttons);
      var connectBtn = button('Connect', function () { connect(selected && selected.id); });
      var disconnectBtn = button('Disconnect', function () { disconnect(); });
      var closeBtn = button('Close', function () { win.close(); });
      buttons.appendChild(connectBtn); buttons.appendChild(disconnectBtn); buttons.appendChild(closeBtn);
      win.setMenu([
        { label: '&Connection', items: [
          { label: '&Connect', onclick: function () { connect(selected && selected.id); } },
          { label: '&Disconnect', onclick: disconnect },
          { label: '&Redial', onclick: function () { redial(); } },
          { type: 'sep' },
          { label: 'Simulate &Busy', onclick: function () { connect(selected && selected.id, { outcome: 'busy' }); } },
          { label: 'Simulate &Timeout', onclick: function () { connect(selected && selected.id, { outcome: 'timeout' }); } },
          { label: 'Simulate &Failure', onclick: function () { connect(selected && selected.id, { outcome: 'failed' }); } },
          { label: 'Simulate &Drop', onclick: function () { dropConnection('The connection was dropped.'); } }
        ] },
        { label: '&Help', items: [{ label: 'Dial-Up Networking Help', onclick: function () { if (W98.launch) W98.launch('help', { topic: 'network' }); } }] }
      ]);
      function renderProfiles() {
        sel.innerHTML = '';
        profiles.forEach(function (p) { var o = el('option', '', esc(p.name)); o.value = p.id; sel.appendChild(o); });
        if (selected) sel.value = selected.id;
      }
      function renderProfile() {
        selected = profileFor(sel.value) || selected || profiles[0];
        panel.innerHTML = '';
        var p = selected || {};
        panel.appendChild(el('div', 'du-state', model.state === 'dialing' ? '<span class="du-spinner"></span>Dialing...' : esc(model.state.charAt(0).toUpperCase() + model.state.slice(1))));
        panel.appendChild(el('div', 'w98-hr'));
        [['Connection', p.name || '' + ''], ['Phone number', p.phone || ''], ['User name', p.username || ''], ['Device', p.device || modem.name]].forEach(function (r) { var row = el('div', 'du-row'); row.appendChild(el('label', '', esc(r[0]))); row.appendChild(el('span', '', esc(r[1]))); panel.appendChild(row); });
        var speed = model.state === 'connected' ? (model.speed + ' bps') : 'Not connected';
        var row = el('div', 'du-row'); row.appendChild(el('label', '', 'Speed')); row.appendChild(el('span', '', speed)); panel.appendChild(row);
        row = el('div', 'du-row'); row.appendChild(el('label', '', 'Duration')); row.appendChild(el('span', '', formatDuration(snapshot().durationMs))); panel.appendChild(row);
        if (model.error) panel.appendChild(el('div', 'du-error', esc(model.error)));
        panel.appendChild(el('div', 'du-note', model.state === 'connected' ? 'Connected to the local virtual network. No modem or telephone line is used.' : 'Choose a phone-book entry and select Connect.'));
        connectBtn.disabled = model.state === 'dialing' || model.state === 'connected'; disconnectBtn.disabled = model.state === 'disconnected';
      }
      function editProfile() {
        var p = selected || profiles[0]; if (!p) return;
        var ask = W98.dialog && W98.dialog.prompt;
        if (typeof ask !== 'function') return;
        var nameRequest = ask('Edit connection', 'Connection name:', p.name);
        if (!nameRequest || typeof nameRequest.then !== 'function') return;
        nameRequest.then(function (n) {
          if (n == null || n === '') return;
          var phoneRequest = ask('Edit connection', 'Phone number:', p.phone);
          if (!phoneRequest || typeof phoneRequest.then !== 'function') return;
          phoneRequest.then(function (phone) {
            if (phone == null) phone = p.phone;
            updateProfile(p.id, { name: n, phone: phone });
            selected = profileFor(p.id); renderProfiles(); renderProfile();
          });
        });
      }
      function showTab(which) {
        if (which === 'modem') {
          bConn.classList.remove('active'); bModem.classList.add('active');
          panel.innerHTML = '<b>Modem Properties</b><div class="w98-hr"></div>';
          [['Modem', modem.name], ['Port', modem.port], ['Maximum speed', modem.maxSpeed + ' bps'], ['Flow control', modem.flowControl], ['Speaker', modem.speaker ? 'On' : 'Off']].forEach(function (r) { var row = el('div', 'du-row'); row.appendChild(el('label', '', esc(r[0]))); row.appendChild(el('span', '', esc(r[1]))); panel.appendChild(row); });
          panel.appendChild(el('div', 'du-note', 'The modem is emulated locally. Dialing sounds are synthesized by the Windows sound scheme.'));
        } else { bConn.classList.add('active'); bModem.classList.remove('active'); renderProfile(); }
      }
      sel.onchange = function () { selected = profileFor(sel.value); renderProfile(); };
      var unsubscribe = service.subscribe(function () { renderProfile(); });
      renderProfiles(); showTab(args.tab === 'modem' ? 'modem' : 'connections');
      return { onClose: function () { unsubscribe(); } };
    }
  });
})(window);
