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

Validation:

```sh
node --check web/js/apps/eventviewer.js
node --check web/js/apps/perfmon.js
node --check web/js/apps/devmgr.js
node --check web/js/devices.js
```
