# Device Manager integration

This repository's Device Manager (`web/js/apps/devmgr.js`) is a shell-level
view of a small, deterministic hardware model.  It is intentionally useful
when either WebAssembly image is unavailable: a browser's physical keyboard,
display, disk, network card, and other devices are never opened or changed by
this application.

## Boundaries

The app is loaded as a classic script after `hv.js` and registers the
`devmgr` application with `W98.registerApp`.  It uses the application contract
in `CONTRACT.md` and only the public `W98` API.  In particular, it persists
state with `W98.reg` and does not use `localStorage`, IndexedDB directly, DOM
internals of the shell, or browser hardware APIs.

`W98HV` is an optional information source.  When the Hyper-V image reports a
partition, VP, VMBus, or heartbeat, the model may annotate the corresponding
synthetic bus/guest entries with that information.  The model still supplies
the complete bounded tree if `W98HV` is missing, fails to load, or reports no
guest.  A Device Manager action never issues a hypercall and never claims to
have changed a real browser device.

The merged kernel contains an NT-style PnP and I/O model (`PNP_ADDED`,
`PNP_STARTED`, `PNP_QUERY_REMOVE`, `PNP_REMOVED`, power states, device handles,
and cancellable/completable IRPs).  This worktree does not expose a documented
W98 application wrapper for those device or IRP calls: the shell's public
contract provides `W98.reg`, while `W98.kernel`/raw WASM exports are not an app
bridge.  Device Manager therefore keeps its lifecycle fields explicit in the
virtual adapter.  Enabled records are `PNP_STARTED`/`D0`; disabled records stay
started but use `D3`; removal records become `PNP_REMOVED`/`D3`, and a rescan
walks `PNP_ADDED` back to `PNP_STARTED`.  The adapter's bounded
`openVirtualHandle`, `closeVirtualHandle`, and `queryRemove` helpers model the
open-handle refusal (`DEVICE_BUSY`) locally so the refusal path is testable
without pretending that a browser or kernel handle was opened.  IRP cancellation
and completion remain kernel-only behavior and are not duplicated in the app.

Every initial entry is a **modeled virtual device**.  The UI labels that fact
explicitly (for example, “Modeled virtual device” or “Virtual hardware”) and
uses a separate unavailable/driver-warning status for a device whose model is
not present.  “Physical hardware” means only information exposed by the
hypervisor surface; it does not mean the host's hardware was enumerated.

## Persistent model

The device model is stored below the Windows-style registry key

```
HKEY_LOCAL_MACHINE\System\CurrentControlSet\Enum
```

The adapter serializes one bounded record per stable device identifier.  A
record contains the hardware ID, friendly name, class, driver version, status,
enabled state, resource list, optional parent bus, and optional problem code.
It also keeps a compact model snapshot under the _W98DeviceModel metadata
key as a restore fallback for a boot where nested registry instance keys are
not queryable yet; the per-device Enum records remain the authoritative visible
layout.
The expanded/collapsed tree, selected view, and “show hidden devices” choice
may also be stored beneath the Device Manager software key.  Values are plain
strings (JSON is allowed for the resource list or other structured values),
so the existing `W98.reg` persistence and registry inspection tools can read
them.  A reload reconstructs the same device IDs and applies saved enabled,
removed, and conflict states before rendering.

Removing a device marks its record as removed in the registry and hides it from
the normal view.  It does not delete unrelated registry values or touch a
physical device.  **Scan for hardware changes** deterministically re-adds the
initial model entries marked removed and refreshes optional W98HV information;
it does not probe the host.  Disable/enable writes the enabled state and
recomputes status/problem code, so the transition is visible after a reload.

## Resource conflicts

Resources are descriptive virtual assignments (IRQ, DMA, I/O, and memory
ranges).  A simulated conflict fixture is raised when the UI assigns the same
resource to two modeled records.  The model reports a deterministic
warning/problem code and the UI displays the Windows 98 yellow warning icon.
The conflict fixture is
created through the UI by assigning an occupied resource to a selected device
(or by enabling the supplied conflict test action, when present). Resolving it
restores the two devices' previous resource assignments and clears the warning.
A rescan restores removed records and refreshes the optional W98HV annotations;
it does not probe browser hardware.

## Views and actions

The tree supports the three Device Manager arrangements:

* **By type** groups records under device classes.
* **By connection** follows each record's optional parent bus.
* **By resources** groups the IRQ/DMA/I/O/memory claims.

The root and group rows can be expanded/collapsed.  Device rows expose
Properties, Disable/Enable, Remove, Update Driver, and the rescan command.
Properties shows the complete persisted record, including the model/source
label, resources, PnP/power state, virtual open-handle count, and any problem
code.  Update Driver is a local-only mock wizard: it changes the deterministic
driver-version string and re-evaluates status; it does not download or install
software.  Hidden/removed records are shown only after **Show hidden devices**
is selected.

## Verification

Run syntax checks from the repository root after changing the app or adapter:

```
node --check web/js/apps/devmgr.js
node --check web/js/devices.js       # when the adapter is present
```

For a browser smoke test, start `./run.sh`, launch Device Manager, and verify:

1. all initial entries are present and marked virtual;
2. changing view and expanding/collapsing groups preserves selection;
3. Disable then Enable changes the icon/status and survives a reload;
4. Remove hides a device, Show hidden devices reveals it, and Scan for hardware
   changes restores it;
5. the local mock driver wizard completes without network access;
6. assigning a duplicate resource produces a yellow warning, and Resolve
   Resource Conflict clears it;
7. the same flows remain usable with `W98HV` unavailable.
8. `openVirtualHandle` followed by Remove returns the deterministic
   `DEVICE_BUSY` refusal; `closeVirtualHandle` then allows query-remove and
   Remove, after which Scan for hardware changes restores the record.

The app remains bounded: it only owns the fixed initial device list plus
records restored from that list, and all generated IDs/resources are stable so
the smoke test is repeatable.
