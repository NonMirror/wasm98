/* ============================================================================
   network-neighborhood.js -- the Windows 98 Network Neighborhood.

   This is a local, deterministic network model.  It deliberately does not
   inspect host connectivity or make a request: the dial-up app drives the
   connection state and this window only renders the model that lives in the
   registry.  The model is also the small adapter used by the intranet app.
   ========================================================================== */
(function () {
  'use strict';

  var W98 = window.W98;
  if (!W98 || !W98.registerApp) return;
  var I = window.W98Icons;
  var U = W98.util;
  var el = U.el;
  var esc = U.escapeHtml;

  var REG = 'HKEY_CURRENT_USER\\Software\\W98\\NetworkNeighborhood';
  var STATES = ['disconnected', 'dialing', 'connected', 'busy', 'failed', 'dropped'];

  /* ---------------------------------------------------------------------- */
  /* Virtual network model                                                  */
  /* ---------------------------------------------------------------------- */
  var DEFAULT_PEERS = [
    {
      id: 'local', name: 'W98-LOCAL', label: 'My Computer', local: true,
      description: 'This computer', address: '127.0.0.1',
      shares: [
        { id: 'documents', name: 'My Documents', comment: 'Private documents', path: 'C:\\My Documents', files: [] },
        { id: 'public', name: 'Public', comment: 'Files shared from this computer', path: 'C:\\WINDOWS\\Desktop\\Public', files: [] }
      ]
    },
    {
      id: 'mercury', name: 'MERCURY', label: 'Engineering PC',
      description: 'Engineering workstation', address: '10.98.0.21',
      shares: [
        { id: 'public', name: 'Public', comment: 'Team announcements', files: [
          { name: 'README.TXT', size: 1234, type: 'Text Document' },
          { name: 'DRIVERS', dir: true, type: 'File Folder' }
        ] },
        { id: 'projects', name: 'Projects', comment: 'Engineering project files', files: [
          { name: 'ROADMAP.TXT', size: 4321, type: 'Text Document' },
          { name: 'WIN98SDK', dir: true, type: 'File Folder' }
        ] }
      ]
    },
    {
      id: 'orbit', name: 'ORBIT', label: 'Sales PC',
      description: 'Sales and support workstation', address: '10.98.0.32',
      shares: [
        { id: 'public', name: 'Public', comment: 'Sales team drop box', files: [
          { name: 'WELCOME.TXT', size: 880, type: 'Text Document' },
          { name: 'CATALOG', dir: true, type: 'File Folder' }
        ] },
        { id: 'sales', name: 'Sales', comment: 'Sales documents', files: [
          { name: 'PRICE-LIST.TXT', size: 2450, type: 'Text Document' },
          { name: '1998', dir: true, type: 'File Folder' }
        ] }
      ]
    },
    {
      id: 'fileserver', name: 'FILESERVER', label: 'Company File Server',
      description: 'Shared company files', address: '10.98.0.10',
      shares: [
        { id: 'public', name: 'Public', comment: 'Company-wide files', files: [
          { name: 'BULLETIN.HTM', size: 3011, type: 'HTML Document' },
          { name: 'FORMS', dir: true, type: 'File Folder' }
        ] },
        { id: 'documents', name: 'Documents', comment: 'Company documents', files: [
          { name: 'POLICY.TXT', size: 6134, type: 'Text Document' },
          { name: 'ARCHIVE', dir: true, type: 'File Folder' }
        ] },
        { id: 'drivers', name: 'Drivers', comment: 'Windows 98 drivers', files: [
          { name: 'README.TXT', size: 1024, type: 'Text Document' },
          { name: 'MODEM', dir: true, type: 'File Folder' }
        ] }
      ]
    }
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function readJson(name, fallback) {
    var raw = null;
    try { raw = W98.reg.get(REG, name, null); } catch (e) { raw = null; }
    if (!raw) return clone(fallback);
    try { return JSON.parse(String(raw)); } catch (e2) { return clone(fallback); }
  }
  function saveJson(name, value) {
    try { W98.reg.set(REG, name, JSON.stringify(value)); } catch (e) { /* early boot */ }
  }
  function normalizeState(s) {
    s = String(s || 'disconnected').toLowerCase();
    return STATES.indexOf(s) >= 0 ? s : 'disconnected';
  }
  function notify(listeners, event, model) {
    listeners.slice().forEach(function (fn) {
      try { fn(event, model); } catch (e) { /* one listener must not stop another */ }
    });
  }

  function makeModel() {
    var listeners = [];
    var storedPeers = readJson('Peers', null);
    var peers = Array.isArray(storedPeers) && storedPeers.length ? storedPeers : clone(DEFAULT_PEERS);
    var state = normalizeState(readJson('ConnectionState', 'disconnected'));
    var connectedIds = readJson('ConnectedPeers', []);
    var overrides = readJson('PeerOverrides', {});
    if (!Array.isArray(connectedIds)) connectedIds = [];
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) overrides = {};
    var startedAt = Number(readJson('ConnectedAt', 0)) || 0;

    function peerById(id) {
      var key = String(id || '').toLowerCase();
      for (var i = 0; i < peers.length; i++) if (peers[i].id.toLowerCase() === key) return peers[i];
      return null;
    }
    function connectedSet() {
      var set = {};
      connectedIds.forEach(function (id) { set[String(id).toLowerCase()] = true; });
      return set;
    }
    function isPeerOnline(p) {
      if (!p) return false;
      if (p.local) return true;
      if (Object.prototype.hasOwnProperty.call(overrides, p.id)) return !!overrides[p.id];
      return state === 'connected' && !!connectedSet()[p.id.toLowerCase()];
    }
    function persist() {
      saveJson('ConnectionState', state);
      saveJson('ConnectedPeers', connectedIds.slice());
      saveJson('PeerOverrides', overrides);
      saveJson('ConnectedAt', startedAt || 0);
      saveJson('Peers', peers);
    }
    function changed(reason) {
      persist();
      notify(listeners, { type: reason || 'changed', state: state }, api);
    }
    function allRemoteIds() {
      return peers.filter(function (p) { return !p.local; }).map(function (p) { return p.id; });
    }

    var api = {
      __virtualNeighborhood: true,
      schema: 1,
      version: '1',
      states: STATES.slice(),
      peers: function () { return api.listPeers(); },
      getPeers: function (opts) { return api.listPeers(opts); },
      listPeers: function (opts) {
        opts = opts || {};
        var includeOffline = !!opts.includeOffline;
        return peers.filter(function (p) { return p.local || includeOffline || isPeerOnline(p); }).map(function (p) {
          var out = clone(p);
          out.online = isPeerOnline(p);
          out.connected = out.online;
          return out;
        });
      },
      getPeer: function (id) {
        var p = peerById(id);
        if (!p) return null;
        var out = clone(p);
        out.online = isPeerOnline(p);
        out.connected = out.online;
        return out;
      },
      listShares: function (id, opts) {
        var p = peerById(id);
        if (!p || (!p.local && !isPeerOnline(p) && !(opts && opts.includeOffline))) return [];
        return clone(p.shares || []).map(function (s) {
          s.peerId = p.id;
          s.peerName = p.name;
          s.unc = '\\\\' + p.name + '\\' + s.name;
          return s;
        });
      },
      getSharedFolders: function (id, opts) { return api.listShares(id, opts); },
      getShare: function (peerId, shareId) {
        var list = api.listShares(peerId, { includeOffline: true });
        var key = String(shareId || '').toLowerCase();
        for (var i = 0; i < list.length; i++) if (list[i].id.toLowerCase() === key || list[i].name.toLowerCase() === key) return list[i];
        return null;
      },
      getState: function () { return state; },
      getConnectionState: function () { return state; },
      state: function () { return state; },
      isConnected: function () { return state === 'connected'; },
      connectedPeers: function () { return api.listPeers().filter(function (p) { return !p.local && p.online; }); },
      connectedPeerIds: function () { return api.connectedPeers().map(function (p) { return p.id; }); },
      setConnection: function (next, opts) {
        opts = opts || {};
        var old = state;
        state = normalizeState(next);
        if (Array.isArray(opts.peerIds)) connectedIds = opts.peerIds.filter(function (id) { return !!peerById(id) && String(id).toLowerCase() !== 'local'; }).map(String);
        else if (state === 'connected' && !connectedIds.length) connectedIds = allRemoteIds();
        if (state !== 'connected' && !opts.keepPeers) connectedIds = [];
        if (state === 'connected' && old !== 'connected') startedAt = Number(opts.startedAt) || Date.now();
        if (state !== 'connected') startedAt = 0;
        changed(old === state ? 'connection-refresh' : 'connection');
        return state;
      },
      setConnectedPeers: function (ids) {
        ids = Array.isArray(ids) ? ids : [];
        connectedIds = ids.filter(function (id) { return !!peerById(id) && String(id).toLowerCase() !== 'local'; }).map(String);
        if (state === 'connected') changed('peers');
        return api.connectedPeerIds();
      },
      connectPeer: function (id) {
        var p = peerById(id);
        if (!p || p.local) return false;
        overrides[p.id] = true;
        if (connectedIds.indexOf(p.id) < 0) connectedIds.push(p.id);
        if (state === 'disconnected' || state === 'failed' || state === 'dropped') state = 'connected';
        if (!startedAt) startedAt = Date.now();
        changed('peer-connected');
        return true;
      },
      disconnectPeer: function (id) {
        var p = peerById(id);
        if (!p || p.local) return false;
        overrides[p.id] = false;
        connectedIds = connectedIds.filter(function (v) { return String(v).toLowerCase() !== p.id.toLowerCase(); });
        changed('peer-disconnected');
        return true;
      },
      setPeerConnected: function (id, connected) {
        return connected ? api.connectPeer(id) : api.disconnectPeer(id);
      },
      subscribe: function (fn) {
        if (typeof fn !== 'function') return function () {};
        listeners.push(fn);
        return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      },
      on: function (fn) { return api.subscribe(fn); },
      registerPeer: function (peer) {
        if (!peer || !peer.id || peerById(peer.id)) return false;
        var p = clone(peer);
        p.shares = Array.isArray(p.shares) ? p.shares : [];
        p.local = !!p.local;
        peers.push(p);
        changed('peer-added');
        return true;
      },
      removePeer: function (id) {
        var p = peerById(id);
        if (!p || p.local) return false;
        peers = peers.filter(function (x) { return x.id !== p.id; });
        connectedIds = connectedIds.filter(function (x) { return x !== p.id; });
        delete overrides[p.id];
        changed('peer-removed');
        return true;
      },
      /* Import the peer list exposed by Dial-Up Networking.  The adapter is
         intentionally duck-typed so another local connection provider can
         use it as well.  Unknown peers become persistent virtual peers and
         remain available in the model after a reload. */
      syncFromDialup: function (source) {
        source = source || W98.dialup || null;
        if (!source) return false;
        var snap = null, list = [];
        try { snap = typeof source.getState === 'function' ? source.getState() : (typeof source.status === 'function' ? source.status() : null); } catch (e) { snap = null; }
        try { list = typeof source.listPeers === 'function' ? source.listPeers() : (typeof source.getPeers === 'function' ? source.getPeers() : []); } catch (e2) { list = []; }
        if (!Array.isArray(list)) list = [];
        var ids = [];
        list.forEach(function (entry) {
          if (!entry) return;
          var name = String(entry.name || entry.label || entry.id || 'Remote Computer');
          var id = String(entry.id || name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'remote-' + ids.length;
          var existing = peerById(id), shares = Array.isArray(entry.shares) ? entry.shares : [];
          shares = shares.map(function (sh, i) {
            if (typeof sh === 'string') return { id: sh.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name: sh, comment: 'Shared folder', files: [] };
            var out = clone(sh || {}); out.id = out.id || ('share-' + i); out.name = out.name || out.id; out.files = Array.isArray(out.files) ? out.files : []; return out;
          });
          if (!existing) {
            peers.push({ id: id, name: name, label: entry.label || name, description: entry.description || 'Remote computer', address: entry.address || '', shares: shares });
          } else if (shares.length) {
            existing.shares = shares;
          }
          if (entry.online !== false && entry.connected !== false) ids.push(id);
        });
        var nextState = snap && typeof snap === 'object' ? snap.state : snap;
        nextState = normalizeState(nextState || (ids.length ? 'connected' : 'disconnected'));
        state = nextState;
        connectedIds = nextState === 'connected' ? ids : [];
        overrides = {};
        if (snap && typeof snap === 'object' && snap.connectedAt) startedAt = Number(snap.connectedAt) || startedAt;
        if (snap && typeof snap === 'object' && snap.speed) saveJson('ConnectionSpeed', String(Math.round(Number(snap.speed) / 1000) || snap.speed) + 'K');
        if (nextState !== 'connected') startedAt = 0;
        changed('external-peers');
        return api.connectedPeerIds();
      },
      syncDialup: function (source) { return api.syncFromDialup(source); },
      connectionInfo: function () {
        return {
          state: state,
          speed: readJson('ConnectionSpeed', '56K'),
          connectedAt: startedAt,
          durationMs: startedAt && state === 'connected' ? Math.max(0, Date.now() - startedAt) : 0,
          peerCount: api.connectedPeers().length
        };
      },
      setConnectionSpeed: function (speed) { saveJson('ConnectionSpeed', String(speed || '56K')); notify(listeners, { type: 'speed' }, api); }
    };
    return api;
  }

  var MODEL = W98.networkNeighborhood;
  if (!MODEL || !MODEL.__virtualNeighborhood) MODEL = makeModel();
  W98.networkNeighborhood = MODEL;
  /* Keep a short alias for the local intranet and dial-up adapters.  If a
     different app already owns W98.network, leave its API intact. */
  if (!W98.network) W98.network = MODEL;

  /* ---------------------------------------------------------------------- */
  /* Network Neighborhood window                                             */
  /* ---------------------------------------------------------------------- */
  function button(icon, title, label, fn) {
    var b = el('button', 'w98-toolbtn');
    b.title = title;
    if (I && I.el) b.appendChild(I.el(icon, 16));
    if (label) b.appendChild(el('span', '', esc(label)));
    b.onclick = fn;
    return b;
  }

  W98.registerApp({
    id: 'network-neighborhood',
    title: 'Network Neighborhood',
    icon: 'network-neighborhood',
    width: 590, height: 400,
    minWidth: 420, minHeight: 260,
    desktop: true,
    startMenuGroup: 'Programs',
    create: function (win, args) {
      args = args || {};
      var view = { peerId: args.peerId || null, shareId: args.shareId || null, selected: null };
      var root = el('div', 'nn-root');
      root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;background:#c0c0c0;font:11px Tahoma,"MS Sans Serif",sans-serif;color:#000';
      var toolbar = el('div', 'w98-toolbar');
      toolbar.style.flex = '0 0 auto';
      var body = el('div', 'nn-body');
      body.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-height:0;padding:3px';
      var status = el('div', 'nn-status w98-field');
      status.style.cssText = 'display:flex;align-items:center;gap:6px;height:25px;padding:2px 5px;flex:0 0 auto;white-space:nowrap;overflow:hidden';
      var statusLamp = el('span');
      statusLamp.style.cssText = 'width:10px;height:10px;display:inline-block;border:1px solid #404040;background:#808080;box-shadow:inset 1px 1px #fff';
      var statusText = el('span', 'grow');
      status.appendChild(statusLamp); status.appendChild(statusText);
      var crumb = el('div', 'nn-crumb');
      crumb.style.cssText = 'height:19px;line-height:19px;padding:0 5px;flex:0 0 auto';
      var list = el('div', 'w98-listbox');
      list.style.cssText = 'flex:1 1 auto;min-height:50px;overflow:auto;background:#fff';
      body.appendChild(status); body.appendChild(crumb); body.appendChild(list);
      root.appendChild(toolbar); root.appendChild(body);
      win.el.appendChild(root);

      function clearToolbar() { toolbar.innerHTML = ''; }
      function redrawStatus() {
        var info = MODEL.connectionInfo ? MODEL.connectionInfo() : { state: MODEL.getState() };
        var s = info.state || 'disconnected';
        var colors = { connected: '#008000', dialing: '#ffff00', busy: '#ff8000', failed: '#ff0000', dropped: '#ff0000', disconnected: '#808080' };
        statusLamp.style.background = colors[s] || '#808080';
        var text = s.charAt(0).toUpperCase() + s.slice(1);
        if (s === 'connected') {
          text += ' to Company Network';
          if (info.speed) text += ' at ' + info.speed;
          if (info.peerCount != null) text += ' (' + info.peerCount + ' remote computer' + (info.peerCount === 1 ? '' : 's') + ')';
        } else if (s === 'dialing') text += ' — waiting for a connection';
        else if (s === 'busy') text += ' — line is busy';
        else if (s === 'failed') text += ' — no answer';
        else if (s === 'dropped') text += ' — connection was lost';
        statusText.textContent = text;
        win.setStatus([{ text: (MODEL.listPeers ? MODEL.listPeers().length : 0) + ' computer(s)', width: 110 }, { text: s }]);
      }
      function toolbarButton(icon, title, label, fn, disabled) {
        var b = button(icon, title, label, fn);
        b.disabled = !!disabled;
        toolbar.appendChild(b);
        return b;
      }
      function setMenus() {
        win.setMenu([
          { label: '&File', items: [
            { label: '&Open', onclick: openSelected },
            { label: '&Close', onclick: function () { win.close(); } }
          ] },
          { label: '&View', items: [
            { label: '&Refresh', accel: 'F5', onclick: render },
            { label: '&Details', type: 'radio', checked: true, disabled: true }
          ] },
          { label: '&Tools', items: [
            { label: '&Dial-Up Networking...', onclick: function () { W98.launch('dialup'); } },
            { label: 'Connect &Peer...', onclick: connectPeer },
            { label: 'Disconnect P&eer...', onclick: disconnectPeer }
          ] },
          { label: '&Help', items: [
            { label: '&Help Topics', onclick: function () { W98.launch('help'); } },
            { type: 'sep' },
            { label: '&About Network Neighborhood', onclick: function () { W98.aboutDialog('network-neighborhood'); } }
          ] }
        ]);
      }
      function showRoot() { view.peerId = null; view.shareId = null; view.selected = null; render(); }
      function openPeer(id) { view.peerId = id; view.shareId = null; view.selected = null; render(); }
      function openShare(id) { view.shareId = id; view.selected = null; render(); }
      function back() {
        if (view.shareId) { view.shareId = null; render(); }
        else if (view.peerId) showRoot();
      }
      function rowClick(row, item) {
        list.querySelectorAll('.selected').forEach(function (n) { n.classList.remove('selected'); });
        row.classList.add('selected'); view.selected = item;
      }
      function openSelected() {
        if (!view.selected) return;
        if (view.shareId) return;
        if (view.peerId) openShare(view.selected.id);
        else openPeer(view.selected.id);
      }
      function connectPeer() {
        var item = view.selected;
        if (!item || view.peerId || item.local) { if (W98.sound && W98.sound.play) W98.sound.play('DefaultBeep'); return; }
        MODEL.connectPeer(item.id); render();
      }
      function disconnectPeer() {
        var item = view.selected;
        if (!item || view.peerId || item.local) { if (W98.sound && W98.sound.play) W98.sound.play('DefaultBeep'); return; }
        MODEL.disconnectPeer(item.id); render();
      }
      function textCell(row, text, width) {
        var d = el('div', '', esc(text == null ? '' : text));
        d.style.cssText = 'flex:0 0 ' + width + 'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 3px';
        row.appendChild(d);
      }
      function header(labels) {
        var h = el('div', 'nn-head');
        h.style.cssText = 'display:flex;height:18px;line-height:18px;background:#c0c0c0;box-shadow:inset -1px -1px #808080,inset 1px 1px #fff;font-weight:bold;flex:0 0 auto';
        labels.forEach(function (x) { textCell(h, x[0], x[1]); });
        list.appendChild(h);
      }
      function renderRoot() {
        crumb.textContent = 'Network Neighborhood';
        clearToolbar();
        toolbarButton('back', 'Back', 'Back', back, true);
        toolbarButton('refresh', 'Refresh', 'Refresh', render, false);
        toolbarButton('dial-up', 'Dial-Up Networking', 'Dial-Up', function () { W98.launch('dialup'); }, false);
        toolbar.appendChild(el('div', 'grow'));
        header([['Computer', 210], ['Description', 250], ['Status', 100]]);
        /* Keep known offline computers in the list.  This is how a user can
           select one and use Tools > Connect Peer after a simulated drop. */
        var ps = MODEL.listPeers({ includeOffline: true });
        ps.forEach(function (p) {
          var row = el('div', 'w98-listitem nn-row');
          row.style.cssText += ';display:flex;align-items:center;min-height:24px;cursor:default';
          if (!p.online && !p.local) row.style.color = '#808080';
          row.appendChild(I.el(p.local ? 'my-computer' : 'network', 16));
          textCell(row, p.name, 194);
          textCell(row, p.description || p.label || '', 250);
          textCell(row, p.local ? 'This computer' : (p.online ? 'Connected' : 'Offline'), 100);
          row.onclick = function () { rowClick(row, p); };
          row.ondblclick = function () { openPeer(p.id); };
          list.appendChild(row);
        });
        if (!ps.length) list.appendChild(el('div', 'w98-listitem', 'No computers are available.'));
      }
      function renderPeer() {
        var p = MODEL.getPeer(view.peerId);
        if (!p) { showRoot(); return; }
        crumb.textContent = 'Network Neighborhood > ' + p.name;
        clearToolbar();
        toolbarButton('back', 'Back', 'Back', back, false);
        toolbarButton('refresh', 'Refresh', 'Refresh', render, false);
        toolbar.appendChild(el('div', 'grow'));
        header([['Shared resource', 210], ['Comment', 280], ['Type', 70]]);
        var shares = MODEL.listShares(p.id);
        shares.forEach(function (s) {
          var row = el('div', 'w98-listitem nn-row');
          row.style.cssText += ';display:flex;align-items:center;min-height:24px;cursor:default';
          row.appendChild(I.el('folder', 16));
          textCell(row, s.name, 194);
          textCell(row, s.comment || '', 280);
          textCell(row, 'Folder', 70);
          row.onclick = function () { rowClick(row, s); };
          row.ondblclick = function () { openShare(s.id); };
          list.appendChild(row);
        });
        if (!shares.length) list.appendChild(el('div', 'w98-listitem', p.online ? 'This computer has no shared folders.' : 'The computer is offline.'));
      }
      function renderShare() {
        var p = MODEL.getPeer(view.peerId);
        var s = p && MODEL.getShare(p.id, view.shareId);
        if (!p || !s) { if (p) { view.shareId = null; renderPeer(); } else showRoot(); return; }
        crumb.textContent = 'Network Neighborhood > ' + p.name + ' > ' + s.name;
        clearToolbar();
        toolbarButton('back', 'Back', 'Back', back, false);
        toolbarButton('refresh', 'Refresh', 'Refresh', render, false);
        toolbar.appendChild(el('div', 'grow'));
        header([['Name', 260], ['Size', 100], ['Type', 180]]);
        var files = Array.isArray(s.files) ? s.files : [];
        files.forEach(function (f) {
          var row = el('div', 'w98-listitem nn-row');
          row.style.cssText += ';display:flex;align-items:center;min-height:22px';
          row.appendChild(I.el(f.dir ? 'folder' : 'text-file', 16));
          textCell(row, f.name, 244);
          textCell(row, f.dir ? '' : ((Number(f.size) || 0) + ' bytes'), 100);
          textCell(row, f.dir ? 'File Folder' : (f.type || 'File'), 180);
          row.onclick = function () { rowClick(row, f); };
          list.appendChild(row);
        });
        if (!files.length) list.appendChild(el('div', 'w98-listitem', '(This folder is empty)'));
      }
      function render() {
        redrawStatus();
        list.innerHTML = '';
        if (view.shareId) renderShare();
        else if (view.peerId) renderPeer();
        else renderRoot();
      }
      var unsubscribe = MODEL.subscribe(function () { render(); });
      /* Dial-Up Networking is loaded as a sibling app.  Binding here keeps
         the neighborhood live when a user connects or drops a line in the
         other window, while still allowing this app to run by itself. */
      var dialupUnsubscribe = null;
      function bindDialup() {
        var d = W98.dialup;
        if (!d || typeof d.subscribe !== 'function' || dialupUnsubscribe) return;
        dialupUnsubscribe = d.subscribe(function () { MODEL.syncFromDialup(d); });
        try {
          var snap = typeof d.getState === 'function' ? d.getState() : null;
          if (snap && snap.state === 'connected') MODEL.syncFromDialup(d);
        } catch (e) { /* optional adapter */ }
      }
      bindDialup();
      win.on('close', function () {
        if (unsubscribe) unsubscribe();
        if (dialupUnsubscribe) dialupUnsubscribe();
      });
      setMenus();
      render();
    }
  });
})();
