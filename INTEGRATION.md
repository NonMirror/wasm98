

## Local intranet

Load `js/local-intranet.js`, `js/apps/dialup.js`, and
`js/apps/network-neighborhood.js` after `shell.js` (and after `explorer.js`
when Explorer helpers are needed) and before `desk.js`. The adapter seeds the
versioned fixture catalog into `C:\\WINDOWS\\INTRANET` through `W98.fs`; it
never calls fetch, XHR, WebSocket, a modem, or a host network interface.
Internet Explorer must ask `W98.localIntranet.resolve()` before its ordinary
remote URL path so connected local pages render through the existing filesystem
renderer and disconnected, busy, timeout, DNS, and not-found results use the
existing error page. Dial-Up Networking and Network Neighborhood persist their
profiles and peer state through `W98.reg`, and remain usable in shim mode.
