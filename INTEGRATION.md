# Event Viewer and Performance Monitor integration

The two diagnostic applications are classic scripts. They register with the
existing shell and read snapshots from the kernel and hypervisor; they do not
add exports, mutate kernel state, or create a second timer/telemetry ABI.

## Script load order

Load the applications after `js/kernel.js`, `js/shell.js`, and `js/hv.js`, and
before `js/desk.js` builds the desktop and Start menu:

```html
<script src="js/apps/eventviewer.js"></script>
<script src="js/apps/perfmon.js"></script>
```

Each file is a non-module script and calls `W98.registerApp` exactly once. The
applications can also be loaded by a test harness that supplies a compatible
`window.W98`; no browser globals beyond the normal app contract are required at
registration time.

## Read-only data sources

The apps sample only the documented surfaces below. Every call is wrapped by a
small safe adapter so a missing WASM image or an unavailable optional method
returns an empty value instead of escaping an exception into the shell.

| Signal | Surface | Notes |
| --- | --- | --- |
| Clock | `W98.tick()` | Kernel monotonic milliseconds (`stats().UPTIME`), suitable for event timestamps and rate deltas. |
| Kernel totals | `W98.stats()` | Current glue returns uppercase keys (`SYSCALLS`, `TICKS`, `QUEUE`, `NDESC`, `HEAP_USED`, `HEAP_SIZE`, `HEAP_FREE`, `FILES`, `BYTES`, `REG`, `FIRED`, `SWITCHES`, and so on). Adapters accept the documented lower-case aliases when a fixture supplies them. |
| Processes | `W98.kernelProcs()` | Snapshot records include `pid`, `name`, `state`, `cpuUs`, and `started`. Process snapshots are compared between polls to report creation, exit, and state changes. |
| Kernel text log | `W98.logText()` where supplied, otherwise `W98.kernelLog()` | The current shell exports `kernelLog`; the adapter checks both names. Log lines are treated as read-only evidence and are deduplicated by cursor. |
| Registry | `W98.regEnum(i)` with `W98.regCount()` | Enumeration is optional. A failed or missing enumerator produces an explicit unavailable message. |
| NT executive | `W98.kernel.exec()` | Optional counters include dispatcher/timer activity, I/O, registry hive, bugchecks, and VMBus messages. |
| Kernel VMBus | `W98.kernel.vmbusStats(which)` | Available only on the WASM kernel build. The adapter labels the signal unavailable when the shim is active. |
| Hypervisor totals | `W98HV.stats()` or `W98.hv.stats()` | `W98HV` is the safe public hypervisor facade. Its `mode` is `none` when `hypervisor.wasm` failed to load. |
| Hyper-V details | `partitions()`, `vps()`, `vmbus()`, `vmbusStats()`, `guestFields()`, `guestLog()`, `log()` | These methods are optional and already return empty/safe shapes when the hypervisor is absent. No partition lifecycle method is called by either diagnostic app. |

## Event and sample semantics

There is no kernel event-stream ABI in this first implementation. Event Viewer
uses bounded polling snapshots:

* process creation, removal, and state changes come from successive process
  snapshots;
* timer, filesystem, registry, syscall, tick, and bugcheck entries are emitted
  only when their real counters or log text change;
* hypercalls, VMBus traffic, guest heartbeat changes, and hypervisor log lines
  use the corresponding `W98HV` counters/details when available;
* an unavailable signal stays an explicit empty or unavailable readout rather
  than becoming a fabricated zero event; the status line also identifies when
  Hyper-V is unavailable.

The in-memory event list is a fixed-size ring. Clearing the view drops the
current rows and polling resumes from the current cursors. Save View creates a
plain-text download through the browser's local `Blob`/URL support and never
mutates the kernel. Performance Monitor keeps short bounded
series for each graph and computes per-second rates from monotonic counter
deltas. Sampling can be paused without stopping other shell timers.

## Validation

Run the syntax gate for the application scripts:

```sh
node --check web/js/apps/eventviewer.js
node --check web/js/apps/perfmon.js
```

The kernel and hypervisor smoke tests remain the authority for their WASM
images. The diagnostic applications do not require a rebuilt image and should
remain usable when either image is unavailable (kernel shim or
`W98HV.mode === 'none'`).
