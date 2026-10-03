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

The two diagnostic applications are classic scripts. Load them after
`js/kernel.js`, `js/shell.js`, and `js/hv.js`, and before `js/desk.js`:

```html
<script src="js/apps/eventviewer.js"></script>
<script src="js/apps/perfmon.js"></script>
```

Each file registers once with `W98.registerApp`; both use the `System Tools`
Start-menu group. They are read-only and tolerate either a missing kernel image
or an unavailable hypervisor. They poll bounded snapshots from the documented
`W98` and `W98HV` surfaces, retain a fixed-size event ring/series, and never
mutate kernel state or create a second telemetry ABI.

The applications read `W98.tick()`, `W98.stats()`, `W98.kernelProcs()`,
`W98.kernelLog()`/`W98.logText()`, optional registry/executive counters, and
optional hypervisor partitions, VPs, VMBus, guest, and log data. Missing
optional methods render as unavailable values. Save View uses a local browser
download only.

Validation:

```sh
node --check web/js/apps/eventviewer.js
node --check web/js/apps/perfmon.js
```
