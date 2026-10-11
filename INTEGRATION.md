# wasm98 integration notes

The integration worktree keeps the classic script architecture. Support modules
load after `kernel.js`, `icons.js`, `shell.js`, and `hv.js`; applications load
after their support modules and before `desk.js`. Every application registers
through `W98.registerApp()` and tolerates an unavailable optional provider.

## Snapshot and persistence support

`snapshot.js` registers `W98Snapshot` and `W98.snapshot` with `capture`,
`create`, `list`, `get`, `restore`, `remove`, `export`, `download`, and `import`.
`kernel.js` owns the persistence bridge. WASM state is serialized as KFS1/KREG1
from the mounted filesystem and registry, so large user images do not depend on
the kernel diagnostic temporary buffer. The shim keeps the same API and stores
session state when IndexedDB or WASM is unavailable. System Restore is a Control
Panel entry and is deliberately excluded from Programs.

## Diagnostics and device state

`eventviewer.js` and `perfmon.js` are read-only `System Tools` applications.
They consume the kernel and hypervisor counters through documented W98 APIs and
continue to render when Hyper-V is absent. `devices.js` exposes the modeled PnP
surface through `W98.devices` and `W98.pnp`; `devmgr.js` is the read-only,
stateful Device Manager UI in `System Tools`. Device Manager changes are routed
through that support module and remain visible to the diagnostics views.

## Recovery and boot profiles

`boot-profile.js` exposes `W98.bootProfile` with `load`, `save`,
`getSelectedProfile`, `consumeNextProfile`, `runBoot`,
`captureLastKnownGood`, and `getBootLog`. `desk.js` calls the guarded hook during
startup and records staged results without making recovery a boot dependency.
`recovery.js` is the `System Tools` UI for Normal, Safe, Safe Command, and
Last Known Good profiles. The normal path remains the default when the module
is missing or a profile is invalid.

## Local intranet and host exchange

`local-intranet.js` exposes `W98.localIntranet` (`resolve`, `status`, `connect`,
`disconnect`, `onChange`) and seeds deterministic pages under
`C:\\WINDOWS\\INTRANET`. `shellapps.js` resolves the local hostname and
`intranet://` aliases before its remote URL guard; Internet Explorer therefore
opens the fixture pages from the virtual filesystem after Dial-Up connects.

`host-file-bridge.js` exposes the explicit-selection `W98.hostFiles` boundary
for import/export. `transfer.js` and `floppy.js` are Accessories/System Tools
surfaces that open browser pickers only after the user chooses a file, folder,
or image. The desktop also accepts a deliberate host file drop and copies the
files to `C:\WINDOWS\Desktop`; Explorer and File Transfer keep their own drop
targets for copying into a selected guest folder. A drop is accepted only when
the browser supplies a `FileList`, and no host path is inferred or scanned.
`dialup.js` and `network-neighborhood.js` are Programs entries; the network
adapter remains local and deterministic. No runtime network fetch is
introduced.

## Kernel lab and games

`kernel-lab.js` is a read-only `System Tools` diagnostic surface. Its Crash Lab
controls are the only path to the existing controlled panic demonstration and
require an explicit confirmation. `hearts.js`, `spider.js`, and `hover.js` are
the Entertainment Pack games in the Games group; Hover! uses the existing
JezzBall icon because the icon set has no dedicated Hover! glyph.

The final `web/index.html` script order is support first, applications second,
and `desk.js` last. Optional WASM/HV or host providers are always feature
guards, so a missing optional asset cannot prevent desktop startup.

## Win32 import bridge

`win32-api.js` is a support script loaded after `shell.js` and before any PE
runner. It exposes `W98Win32.createRuntime()` and the generic
`runtime.call(dll, name, args)`/`runtime.resolve(dll, name)` boundary for
`kernel32`, `user32`, and `gdi32`. A browser runtime creates a canvas inside a
W98 shell window; a worker or Node runtime uses the same message queue and a
bounded in-memory RGBA surface. The bridge does not decode or execute PE
machine code; the PE runner owns instruction emulation and guest-memory
marshalling.

## PE execution

`pe-loader.js` is loaded after `win32-api.js` and exposes `W98PE` plus
`W98.PE`. `W98PE.parse/load` accepts an `ArrayBuffer` or `Uint8Array`, maps
PE32/PE32+ sections, applies HIGHLOW/DIR64 relocations, and resolves imports
through an explicit callback or `W98Win32`. `W98PE.runConsole` and `runGui`
execute bounded x86/x86_64 images; `runPath` reads a guest filesystem path.
The interpreter returns a deterministic status (`exited`, `step_limit`, or
`unsupported_instruction`) so the shell can report unsupported binaries without
bringing down the desktop. `pe-loader.js` must remain before `desk.js`; callers
should keep arbitrary host bytes behind the explicit file picker.
