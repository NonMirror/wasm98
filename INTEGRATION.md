# Local dial-up and intranet integration

This branch supplies the deterministic network model and the two shell windows. It does not change `web/js/apps/shellapps.js`; the integration worktree owns the Internet Explorer edit.

## Script order

Load the three new classic scripts after `shell.js` (and after `explorer.js`, so the application registry and Explorer icon helpers exist) and before `desk.js` starts the desktop:

```html
<script src="js/local-intranet.js"></script>
<script src="js/apps/dialup.js"></script>
<script src="js/apps/network-neighborhood.js"></script>
```

`local-intranet.js` has no runtime dependency on the browser network stack. Its page catalog is a versioned local model and is copied to the kernel VFS by `W98.localIntranet.ensureSeeded()`.

## Internet Explorer adapter

Before IE classifies an address as `http:`, `https:`, or another remote protocol, ask the adapter to resolve it:

```js
var local = window.W98.localIntranet && window.W98.localIntranet.resolve(input);
if (local && local.ok) return local;
if (local && !local.ok) return { kind: 'intranet-error', error: local };
```

Handle that target before the ordinary local-file/remote branches in `renderTarget`:

```js
if (t.kind === 'intranet-error') {
  stopLoading();
  errorPage(t.error.error && t.error.error.message || 'Cannot find server or DNS Error', t.error.status);
  return;
}
```

This keeps the existing IE page renderer and makes the `busy`, `timeout`, `connection-failed`, and `connection-dropped` statuses visible in the detail line.

`resolve` returns an `{ok:false, status, error}` result for an unknown host, a missing page, or a disconnected/busy/dropped connection. For a known intranet address it returns an IE target object:

```js
{
  kind: 'file',
  path: 'C:\\WINDOWS\\INTRANET\\welcome.html',
  input: 'http://intranet.w98.local/',
  label: 'W98 Company Intranet'
}
```

The returned `path`/`filesystemPath` is backed by `W98.fs`; IE should continue through its existing local-file renderer. The adapter accepts these deterministic forms:

- `http://intranet.w98.local/` and `intranet://home` for the welcome page;
- `http://intranet.w98.local/<page>` and `intranet://<page>` for catalog pages;
- `C:\\WINDOWS\\INTRANET\\<page>.HTM` for direct VFS access.

Intranet links are local `data-href` links. The adapter does not create `<script>` elements, evaluate page scripts, or fetch URLs. Unknown names carry a `dns-error` or `not-found` status, allowing IE's existing “Cannot find server or DNS Error” page to represent a simulated DNS failure. A disconnected dial-up session can be represented by the existing IE error path using the result of `W98.localIntranet.connectionError(input)`.

## Public local APIs

`W98.dialup` exposes `getState()`, `profiles()`, `getPhoneBook()`, `createProfile(profile)`, `saveProfile(profile)`, `updateProfile(id, patch)`, `connect(id, options)`, `disconnect(reason)`, `redial()`, and `subscribe(fn)`. `getState()` reports the visible state (`disconnected`, `dialing`, `connected`, `busy`, `failed`, or `dropped`), selected profile, speed, start time, elapsed duration, and last error. Profiles and modem/preferences are persisted through the registry under `HKEY_CURRENT_USER\\Software\\W98\\DialUp` (with `Profiles`, `PhoneBook`, `Preferences`, and `Modem` subkeys).

`W98.networkNeighborhood` exposes `getState()`, `listPeers({includeOffline})`, `listShares(peerId)`, `getPeer(peerId)`, `connectPeer(peerId)`, `disconnectPeer(peerId)`, `setPeerConnected(peerId, bool)`, `syncFromDialup(source)`, and `subscribe(fn)`. Peer and shared-folder metadata are a versioned local model; connection changes are reflected immediately and persisted under `HKEY_CURRENT_USER\\Software\\W98\\NetworkNeighborhood`. The Network Neighborhood window listens for model events so a peer that is connected or disconnected appears without a page reload.

`W98.localIntranet` exposes `ensureSeeded()`, `resolve(input)`, `pages()`, `read(path)`, `search(query)`, `status()`, and `connectionError(input)`. The catalog contains the welcome page, internal directory, Windows 98 help, system status, shared files, bulletin board, and local document search. `ensureSeeded()` is idempotent and writes only to the virtual filesystem.

## Offline behavior

The model intentionally has no `fetch`, XHR, WebSocket, CDN, modem, or host network interface dependency. Keep external network access disabled when testing. Dial-up animation uses the shell timer API and the existing local sound scheme; all transitions remain deterministic. Reloading the desktop restores profiles, preferences, and the last selected local network state from the kernel registry/snapshot.
