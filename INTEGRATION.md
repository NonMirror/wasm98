# Integration notes

## System Restore

`web/index.html` loads `js/snapshot.js` after the kernel and
`js/apps/restore.js` after Control Panel. `web/js/apps/control.js` links the
System Restore applet, while `web/js/desk.js` keeps it out of the default
Programs list and still allows the Control Panel link to launch it. Applications
use the documented `W98Snapshot`/`W98.snapshot` surface, and persistent images
continue through `W98Kernel.capturePersistentState()` and
`W98Kernel.replacePersistentState()`.

## Event Viewer and Performance Monitor

Load `js/apps/eventviewer.js` and `js/apps/perfmon.js` after the kernel, shell,
and hypervisor scripts and before `js/desk.js`. Each registers once in the
`System Tools` Start-menu group. They are read-only, use bounded polling of the
public `W98`/`W98HV` surfaces, and tolerate a missing kernel or hypervisor.

## Device Manager

`js/devices.js` is a support module loaded after `hv.js`, and
`js/apps/devmgr.js` is loaded after it and before `desk.js`. Device Manager is a
classic `W98.registerApp` application in `System Tools`. It models bounded
virtual hardware and persists lifecycle, resource, and view state under
`HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Enum` and the Device Manager
software key. It never probes or changes host hardware. Disable/enable, remove,
rescan, the local driver wizard, resource-conflict fixture, and bounded virtual
handle refusal remain usable in shim mode and when Hyper-V is unavailable.

## Boot recovery

`js/boot-profile.js` is a classic support module loaded after `shell.js`/`hv.js`
and before `js/apps/recovery.js`. The recovery app registers under the
`System Tools` Start-menu group and uses only the public `W98.bootProfile` and
`W98.launch` APIs. The integration should let `desk.js` call
`load()`, `consumeNextProfile()`, and `runBoot()` with the ten canonical stage
IDs, then capture Last Known Good after a successful normal boot. Failed-startup
flags and bounded `BOOTLOG.TXT` remain owned by the profile model; recovery
simulations do not alter shell internals.

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

## Host exchange and virtual media

`js/host-file-bridge.js` is loaded after `shell.js` and before the transfer and
floppy applications. A browser file or directory picker is the only source of
host bytes; the bridge never scans host paths, fetches a URL, or stores bytes in
`localStorage`. Selected imports are bounded and may be restored to C: from a
local IndexedDB record after reload. `Transfer` imports to and exports from the
virtual filesystem only after explicit user selection or an explicit drop on
its import target. The Floppy app materializes deterministic manifests on `A:`
and `D:` as virtual, write-protected media by default, checks capacity on mount
and write, and invalidates stale tokens on eject. Explorer and DOS see the
same ordinary VFS entries, and all operations remain available with the shim.

Validation:

```sh
node --check web/js/apps/eventviewer.js
node --check web/js/apps/perfmon.js
node --check web/js/apps/devmgr.js
node --check web/js/devices.js
node --check web/js/boot-profile.js
node --check web/js/apps/recovery.js
node --check web/js/host-file-bridge.js
node --check web/js/apps/transfer.js
node --check web/js/apps/floppy.js
```
