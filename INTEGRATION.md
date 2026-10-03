# Kernel Lab integration

Kernel Lab is a classic Windows 98 shell application.  The source lives at
`web/js/apps/kernel-lab.js` (and, when present, its help text at
`web/js/apps/kernel-lab-help.js`).  It must be loaded as a regular script after
`kernel.js`, `shell.js`, and `hv.js`, and before `desk.js` boots the desktop:

```html
<script src="js/apps/kernel-lab.js"></script>
```

The app registers itself with `W98.registerApp` under the `kernel-lab` id,
using the **System Tools** Start-menu group and a singleton diagnostic window.
The desktop builds the Start menu from registered app definitions, so no
separate menu entry or desktop code is required.  The app can also be opened
from another app or from the Run dialog with:

```js
W98.launch('kernel-lab');
```

## Data contract

The window reads through the public shell/kernel surfaces only.  The current
shell aliases the kernel log as `W98.kernelLog()`; builds that provide
`W98.logText()` are accepted as well.  It does not inspect DOM nodes owned by
the shell, call private WebAssembly exports, or read shell implementation
state.

| Kernel Lab view | Public source |
| --- | --- |
| `!process` | `W98.kernelProcs()` and `W98.stats()` |
| `!thread`, `!handle`, `!timer`, `!pool`, `!irp`, `!object` | `W98.exec()` executive snapshot, including expanded dispatcher, memory-manager, security, and object counters when exposed |
| `!registry` | `W98.regEnum(index)` and exposed hive/transaction counters |
| `!partition` | `W98.hv`/`W98HV` partition, guest, VP, SynIC, and `memoryMap` (SLAT) accessors when exposed |
| `!vmbus` | `W98.vmbusStats()` and the hypervisor VMBus/channel, statistics, and log surfaces when exposed |
| `!bugcheck` and crash-lab log | `W98.logText()` when provided by the host, otherwise `W98.kernelLog()`/`W98.kernel.logText()`, plus `W98.exec().bugcheckDump()` or `W98.hv.bugcheck()` and exposed bugcheck fields |

`W98.tick()` is used for timestamps and refresh scheduling.  Hypervisor values
are read conditionally: a build without `W98.hv` or `W98HV`, or with a
hypervisor whose mode is not `wasm`, is reported as unavailable.  Individual
fields that an API does not expose are shown as **not exposed by this build**;
Kernel Lab never substitutes a guessed value.

Partition and channel identifiers come from live records returned by the
high-level API.  The app does not synthesize a dense ID range or use an
enumeration slot as an ID.  Registry enumeration remains compatible with the
loader's `KREG3` snapshot format, which continues to accept `KREG1` and
`KREG2` data.

## Read-only and crash-lab rules

All command views and links are snapshots.  They do not create, delete, open,
close, or mutate kernel objects, processes, registry values, partitions, VPs,
or VMBus channels.  Links only change the selected diagnostic object in the
window.

The crash-lab controls have one explicit exception: the existing controlled
panic/bugcheck entry point may be called only after the user confirms the native
Windows dialog.  The action is never run while rendering a view or polling a
counter.  After a bugcheck, the app reads the code, parameters, and dump from
the public kernel API.  The NT executive dispatcher is halted; this build's
legacy kernel clock, timer queue, and process accounting may still advance.
The last log and snapshot stay available while the page remains alive.  A
reload recreates volatile process, thread, timer, hypervisor, and dump state,
while persisted filesystem and registry data can be restored.  Values that
were not exposed by the build are left marked as unavailable.

## Output and refresh guidance

Command output is bounded to a finite number of lines and characters and
rendered in a scrollable pane.  Refreshes are scheduled with the window's
kernel-backed timer
(`win.setInterval`) and are cancelled by the app's close hook.  Unknown commands
return the command list and usage examples rather than throwing.  This keeps
the application usable with both the WebAssembly kernel and the reduced
JavaScript fallback.

## Validation

Run the syntax check from the repository root after changing the app:

```sh
node --check web/js/apps/kernel-lab.js
```

A browser smoke test should load the page with and without `hypervisor.wasm`,
open **Kernel Lab** from Start → Programs → System Tools, run each command,
verify that long output scrolls, and confirm that the crash-lab confirmation is
the only path that invokes the existing panic/bugcheck action.
