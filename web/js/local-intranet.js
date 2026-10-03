/* ===========================================================================
 * local-intranet.js — a deterministic, filesystem-backed company intranet.
 *
 * The adapter deliberately never calls a browser request API or a remote URL.  Fixture pages are embedded below and copied into the virtual W98 file
 * system by ensureSeeded().  Internet Explorer can resolve an intranet URL by
 * calling W98.localIntranet.resolve(url), then reading the returned file path.
 * ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98 = global.W98 || {};
  var ROOT = 'C:\\WINDOWS\\INTRANET';
  var HOST = 'intranet.w98.local';
  var REG = 'HKEY_CURRENT_USER\\Software\\W98\\Network\\Intranet';
  var VERSION = '1';
  var DEFAULT_STATE = 'disconnected';
  var state = DEFAULT_STATE;
  var seeded = false;
  var listeners = [];
  var aliases = {
    '': 'welcome.html', '/': 'welcome.html', '/index.html': 'welcome.html',
    '/index.htm': 'welcome.html', '/default.html': 'welcome.html', '/default.htm': 'welcome.html',
    '/welcome': 'welcome.html', '/directory': 'directory.html', '/help': 'help.html',
    '/status': 'status.html', '/files': 'files.html', '/bulletin': 'bulletin.html',
    '/search': 'search.html'
  };

  /* The source strings mirror the human-readable files in assets/intranet/.
     Embedding them keeps the browser fully functional when the host serves no
     files and prevents a runtime request for local fixtures. */
  var pages = {
    'welcome.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Welcome</title></head><body><h1>W98 Company Intranet</h1><p>Welcome to the local company network. This site is stored on this Windows 98 workstation and works without an Internet connection.</p><h2>Quick links</h2><ul><li><a href="http://intranet.w98.local/directory.html">Employee directory</a></li><li><a href="http://intranet.w98.local/help.html">Windows 98 help desk</a></li><li><a href="http://intranet.w98.local/status.html">System status</a></li><li><a href="http://intranet.w98.local/files.html">Shared files</a></li><li><a href="http://intranet.w98.local/bulletin.html">Bulletin board</a></li><li><a href="http://intranet.w98.local/search.html">Search local documents</a></li></ul><hr><p><small>W98NET/1.0 · Last updated 09/30/1998 · Local only</small></p></body></html>\n',
    'directory.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Directory</title></head><body><h1>Employee Directory</h1><p>Internal extensions for the Redmond office.</p><table border="1"><tr><th>Name</th><th>Department</th><th>Extension</th><th>E-mail</th></tr><tr><td>Alex Johnson</td><td>Information Services</td><td>204</td><td>alexj@w98.local</td></tr><tr><td>Becky Chen</td><td>Human Resources</td><td>218</td><td>beckyc@w98.local</td></tr><tr><td>Chris Patel</td><td>Sales</td><td>231</td><td>chrisp@w98.local</td></tr><tr><td>Pat Smith</td><td>Facilities</td><td>245</td><td>pats@w98.local</td></tr></table><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n',
    'help.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Help</title></head><body><h1>Windows 98 Help Desk</h1><h2>Connecting by modem</h2><ol><li>Open <b>My Computer</b>, then <b>Dial-Up Networking</b>.</li><li>Select the W98 Company Network phone-book entry.</li><li>Click <b>Connect</b> and wait for the modem handshake.</li></ol><h2>Common fixes</h2><ul><li>If the line is busy, wait a minute and redial.</li><li>A dropped call can be reconnected from the Dial-Up Networking window.</li><li>Check Network Neighborhood after connecting to see the available workgroups.</li></ul><h2>Need help?</h2><p>Call the Information Services desk at extension 204. Please include the error number shown by Internet Explorer.</p><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n',
    'status.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Status</title></head><body><h1>Network status</h1><p>This status page describes the local virtual network. It does not contact a remote server.</p><table border="1"><tr><th>Service</th><th>Status</th><th>Notes</th></tr><tr><td>W98 Company Intranet</td><td>Available</td><td>Served from the local virtual file system</td></tr><tr><td>Directory service</td><td>Available</td><td>Static 1998 directory data</td></tr><tr><td>Shared files</td><td>Available</td><td>See the shared files page</td></tr><tr><td>Internet gateway</td><td>Not installed</td><td>This desktop has no external network access</td></tr></table><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n',
    'files.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Shared Files</title></head><body><h1>Shared files</h1><p>These documents are copies in the local W98 virtual file system.</p><ul><li><a href="\\\\SERVER\\PUBLIC\\WELCOME.TXT">\\\\SERVER\\PUBLIC\\WELCOME.TXT</a> — network readme</li><li><a href="\\\\SERVER\\PUBLIC\\W98-TIPS.TXT">\\\\SERVER\\PUBLIC\\W98-TIPS.TXT</a> — Windows 98 tips</li><li><a href="\\\\SERVER\\PUBLIC\\FORMS\\VACATION.TXT">\\\\SERVER\\PUBLIC\\FORMS\\VACATION.TXT</a> — vacation request form</li></ul><p>Open Network Neighborhood to browse the virtual file servers.</p><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n',
    'bulletin.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Bulletin Board</title></head><body><h1>Company bulletin board</h1><h2>September 30, 1998</h2><p><b>System maintenance:</b> The file server is serviced after 6:00 PM on Fridays. Please log off before leaving.</p><h2>September 25, 1998</h2><p><b>New modem pool:</b> Two 56K US Robotics modems are now available. See Information Services for a phone-book entry.</p><h2>September 18, 1998</h2><p><b>Shareware policy:</b> Scan downloaded disks with the company virus checker before opening executables.</p><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n',
    'search.html': '<!doctype html>\n<html><head><meta charset="windows-1252"><title>W98 Intranet - Search</title></head><body><h1>Search local documents</h1><p>Type a word or phrase and choose Search. Results are collected from the local intranet pages and shared-file metadata.</p><form method="get" action="search.html"><label for="q">Search for:</label> <input id="q" name="q" type="text" size="32"><input type="submit" value="Search"></form><hr><p>Try: <a href="search.html?q=modem">modem</a>, <a href="search.html?q=vacation">vacation</a>, or <a href="search.html?q=Windows+98">Windows 98</a>.</p><p><a href="welcome.html">Back to intranet home</a></p></body></html>\n'
  };

  var sharedFiles = [
    { uncPath: '\\\\SERVER\\PUBLIC\\WELCOME.TXT', localPath: 'SHARED\\PUBLIC\\WELCOME.TXT', name: 'WELCOME.TXT', description: 'Network readme', content: 'Welcome to the Acme Company file server.\r\n' },
    { uncPath: '\\\\SERVER\\PUBLIC\\W98-TIPS.TXT', localPath: 'SHARED\\PUBLIC\\W98-TIPS.TXT', name: 'W98-TIPS.TXT', description: 'Windows 98 tips', content: 'Use Network Neighborhood to browse local virtual peers.\r\n' },
    { uncPath: '\\\\SERVER\\PUBLIC\\FORMS\\VACATION.TXT', localPath: 'SHARED\\PUBLIC\\FORMS\\VACATION.TXT', name: 'VACATION.TXT', description: 'Vacation request form', content: 'Vacation request form\r\nEmployee: ____________________\r\nDates: ________________________\r\n' }
  ];

  function pathFor(file) { return ROOT + '\\' + file; }
  function trimPath(path) {
    var p = String(path == null ? '' : path).replace(/\\/g, '/');
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    return p;
  }
  function decodePart(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }
  function normalizeUrl(url) {
    var raw = String(url == null ? '' : url).replace(/^\s+|\s+$/g, '');
    if (!raw) return { host: HOST, path: '/', query: '' };
    /* Accept an IE filesystem path as a convenience for the adapter. */
    if (/^C:\\WINDOWS\\INTRANET(?:\\|$)/i.test(raw)) {
      var local = raw.slice(ROOT.length).replace(/\\/g, '/');
      return { host: HOST, path: local || '/', query: '' };
    }
    var m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(raw);
    if (!m) return { host: '', path: '/', query: '' };
    var protocol = (m[1] || '').toLowerCase();
    var host = (m[2] || '').toLowerCase().replace(/:\d+$/, '');
    var path = m[3] || '/';
    if (protocol === 'intranet') {
      /* The compact intranet://home form is useful to shell shortcuts and
         avoids pretending this adapter is a real network protocol. */
      path = host === 'home' || host === 'welcome' ? '/' : '/' + host;
      host = HOST;
    }
    /* IE supplies relative hrefs (for example, directory.html) when a user
       follows a link. Treat those as local intranet paths, while preserving
       dotted host names such as intranet.w98.local. */
    if (!protocol && m[2] && (m[2].indexOf('.') < 0 || /\.html?$/i.test(m[2]))) {
      host = HOST;
      path = '/' + m[2] + (m[3] || '');
    }
    if (!m[2] && /^\//.test(path)) host = HOST;
    if (!host && protocol === '') host = HOST;
    return { protocol: protocol, host: host, path: path, query: m[4] || '' };
  }
  function pageName(url) {
    var n = normalizeUrl(url);
    var p = n.path || '/';
    var key = aliases[p.toLowerCase()];
    if (!key) {
      key = p.charAt(0) === '/' ? p.slice(1) : p;
      key = decodePart(key);
      if (!/\.html?$/i.test(key)) key += '.html';
    }
    return key.toLowerCase();
  }
  function regGet(name, dflt) {
    try { return W98.reg && W98.reg.get ? W98.reg.get(REG, name, dflt) : dflt; } catch (e) { return dflt; }
  }
  function regSet(name, val) {
    try { if (W98.reg && W98.reg.set) W98.reg.set(REG, name, String(val)); } catch (e) { /* reduced shell */ }
  }
  function providerState() {
    var d = W98.dialup || W98.DialUp || W98.network || W98.Network;
    if (!d) return null;
    try {
      var s = typeof d.getState === 'function' ? d.getState() : (typeof d.state === 'function' ? d.state() : d.state);
      if (s && typeof s === 'object') s = s.state;
      if (s != null && s !== '') return String(s).toLowerCase();
    } catch (e) { /* use local state */ }
    return null;
  }
  function effectiveState() {
    var remote = providerState();
    if (remote) return remote;
    var rs = regGet('ConnectionState', null);
    return rs != null && rs !== '' ? String(rs).toLowerCase() : state;
  }
  function online() { return effectiveState() === 'connected'; }
  function errorResult(code, message, extra) {
    var out = { ok: false, status: code, error: { code: code, message: message } };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  function ensureDir(path) {
    var fs = W98.fs;
    if (!fs || !fs.mkdir) return false;
    var parts = String(path).split('\\');
    var cur = parts.shift() + '\\';
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      cur += parts[i];
      try {
        if (!fs.exists(cur)) {
          var rc = fs.mkdir(cur);
          if (rc === -1 || !fs.exists(cur)) return false;
        }
      } catch (e) { return false; }
      cur += '\\';
    }
    return true;
  }
  function ensureSeeded() {
    if (seeded) return true;
    var fs = W98.fs;
    if (!fs || !fs.writeText || !fs.exists) return false;
    /* W98.fs exists during script loading, but its kernel backing store is
       mounted only after K.boot().  Do not mark the model seeded early. */
    if (W98.kernel && !W98.kernel.fs && !W98.booted) return false;
    if (!ensureDir(ROOT)) return false;
    try {
      Object.keys(pages).forEach(function (name) {
        var p = pathFor(name);
        if (!fs.exists(p)) fs.writeText(p, pages[name]);
      });
      ensureDir(pathFor('SHARED\\PUBLIC'));
      ensureDir(pathFor('SHARED\\PUBLIC\\FORMS'));
      sharedFiles.forEach(function (file) {
        var p = pathFor(file.localPath);
        if (!fs.exists(p)) fs.writeText(p, file.content);
      });
      if (!fs.exists(pathFor('VERSION.TXT'))) fs.writeText(pathFor('VERSION.TXT'), 'W98 local intranet fixture version ' + VERSION + '\r\n');
      seeded = true;
      return true;
    } catch (e) { return false; }
  }
  function notify(next, details) {
    state = String(next || DEFAULT_STATE).toLowerCase();
    regSet('ConnectionState', state);
    var snapshot = status();
    if (details) snapshot.details = details;
    listeners.slice().forEach(function (fn) { try { fn(snapshot); } catch (e) {} });
    return snapshot;
  }
  function status() {
    return { state: effectiveState(), online: online(), host: HOST, root: ROOT, seeded: seeded, version: VERSION };
  }
  function connectionError(url) {
    var s = effectiveState();
    var code = s === 'dialing' ? 'timeout' : (s === 'busy' ? 'busy' : (s === 'failed' ? 'connection-failed' : (s === 'dropped' ? 'connection-dropped' : 'disconnected')));
    return errorResult(code, 'The intranet is unavailable while the dial-up connection is ' + s + '.', { url: url, host: HOST, connectionState: s });
  }
  function resolve(url) {
    var n = normalizeUrl(url);
    if (n.host && n.host !== HOST && n.host !== 'intranet') {
      return errorResult('dns-error', 'Internet Explorer could not find the server ' + n.host + '.', { url: url, host: n.host });
    }
    if (!online()) {
      return connectionError(url);
    }
    var dial = W98.dialup || W98.DialUp;
    if (dial && typeof dial.canResolve === 'function') {
      try {
        if (!dial.canResolve(HOST)) return errorResult('dns-error', 'The local DNS service could not resolve ' + HOST + '.', { url: url, host: HOST, connectionState: effectiveState() });
      } catch (e) { /* the local adapter remains usable if an optional dialer throws */ }
    }
    ensureSeeded();
    var name = pageName(url);
    if (!Object.prototype.hasOwnProperty.call(pages, name)) {
      return errorResult('not-found', 'The requested intranet page was not found.', { url: url, host: HOST, path: pathFor(name) });
    }
    var body = name === 'search.html' ? searchPage(queryValue(n.query, 'q')) : pages[name];
    try { if (!n.query && W98.fs && W98.fs.readText && W98.fs.exists(pathFor(name))) body = W98.fs.readText(pathFor(name)) || body; } catch (e) { /* embedded fixture remains deterministic */ }
    return { ok: true, status: 'ok', kind: 'file', url: 'http://' + HOST + '/' + name,
      host: HOST, path: pathFor(name), filesystemPath: pathFor(name),
      input: String(url == null ? '' : url), label: 'W98 Company Intranet - ' + name,
      html: body, query: n.query };
  }
  function read(url) {
    var r = resolve(url);
    if (!r.ok) return r;
    try {
      if (!r.query && W98.fs && W98.fs.readText && W98.fs.exists(r.filesystemPath)) r.html = W98.fs.readText(r.filesystemPath) || r.html;
    } catch (e) { /* embedded fixture is the deterministic fallback */ }
    return r;
  }
  function queryValue(query, key) {
    var q = String(query || '').split('&');
    for (var i = 0; i < q.length; i++) {
      var pair = q[i].split('=');
      if (decodePart(pair[0] || '').toLowerCase() === key.toLowerCase()) return decodePart((pair.slice(1).join('=') || '').replace(/\+/g, ' '));
    }
    return '';
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function searchPage(query) {
    var q = String(query || '').replace(/^\s+|\s+$/g, '');
    if (!q) return pages['search.html'];
    var results = search(q), list = results.map(function (r) {
      var href = r.filesystemPath || r.url || r.uncPath;
      return '<li><a href="' + escapeHtml(href) + '">' + escapeHtml(r.title || r.name) + '</a></li>';
    }).join('');
    return pages['search.html'].replace('<hr>', '<hr><h2>Search results for &quot;' + escapeHtml(q) + '&quot;</h2>' + (list ? '<ul>' + list + '</ul>' : '<p>No matching local documents were found.</p>'));
  }
  function search(query) {
    ensureSeeded();
    var q = String(query == null ? '' : query).toLowerCase().replace(/^\s+|\s+$/g, '');
    var out = [];
    if (!q) return out;
    Object.keys(pages).forEach(function (name) {
      var text = pages[name].replace(/<[^>]+>/g, ' ').toLowerCase();
      if (text.indexOf(q) >= 0) out.push({ kind: 'page', name: name, title: name.replace(/\.html?$/i, ''), filesystemPath: pathFor(name), url: 'http://' + HOST + '/' + name });
    });
    sharedFiles.forEach(function (file) {
      var text = (file.name + ' ' + file.description + ' ' + file.content).toLowerCase();
      if (text.indexOf(q) >= 0) out.push({ kind: 'file', name: file.name, title: file.description, uncPath: file.uncPath, filesystemPath: pathFor(file.localPath) });
    });
    return out;
  }
  function onStateChange(fn) { if (typeof fn === 'function') listeners.push(fn); return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  function setConnectionState(next, details) { return notify(next, details); }

  function pageCatalog() { return Object.keys(pages); }
  Object.keys(pages).forEach(function (name) { pageCatalog[name] = pages[name]; });
  var api = {
    host: HOST, root: ROOT, version: VERSION, pages: pageCatalog, pageCatalog: pages,
    listPages: pageCatalog,
    normalizeUrl: normalizeUrl, pageName: pageName, resolve: resolve, resolveUrl: resolve,
    read: read, readPage: read, search: search, getSharedFiles: function () { return sharedFiles.map(function (f) { return { uncPath: f.uncPath, localPath: f.localPath, name: f.name, description: f.description, content: f.content }; }); }, ensureSeeded: ensureSeeded, status: status,
    isOnline: online, setConnectionState: setConnectionState, onStateChange: onStateChange,
    pathFor: pathFor, fixturePath: function (name) { return pathFor(String(name)); },
    connectionError: connectionError, resolveForIE: resolve
  };
  W98.localIntranet = api;
  W98.LocalIntranet = api;
  W98.intranet = api;
  W98.resolveIntranetUrl = resolve;

  /* Boot can load this file before kernel.wasm has mounted its file system.
     Retry briefly without doing I/O until the shell reports that it is ready. */
  function retryAfter(ms, fn) {
    if (typeof W98.raf !== 'function') return false;
    var elapsed = 0, cancel = null;
    cancel = W98.raf(function (dt) {
      elapsed += Number(dt) || 16;
      if (elapsed < ms) return;
      if (cancel) cancel();
      fn();
    });
    return true;
  }
  function seedWhenReady(tries) {
    if (ensureSeeded() || tries <= 0) return;
    retryAfter(100, function () { seedWhenReady(tries - 1); });
  }
  seedWhenReady(100);
  global.W98LocalIntranet = api;
}(typeof window !== 'undefined' ? window : this));
