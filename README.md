# wasm98

Windows 98 in the browser. JS draws the pixels; the operating-system state (processes, scheduler, timers, filesystem, registry, heap, an NT-style executive and a Hyper-V model) lives in **freestanding C images compiled to wasm32**. Everything runs locally, with no network requests at runtime.

```sh
./run.sh            # http://127.0.0.1:8098/
```

## Highlights

- **A real kernel, not a mock.** `kernel.wasm` (~137 KiB) has no libc and no entry point. Every window is a kernel process, every `setTimeout` is a kernel timer, and the CPU time in Task Manager is charged by the scheduler.
- **NT-style executive.** Objects and handles, security descriptors, threads and scheduling, dispatcher objects, IRQL/DPC/APC, lock semantics (spin, fast mutex, ERESOURCE, pushlock), an I/O manager with IRPs, VADs, large pages, paging, prototype sections, tagged pool and bounded segment heaps.
- **A Hyper-V-shaped type-1 hypervisor.** `hypervisor.wasm` (~113 KiB) treats its static BSS as 16 MB of physical memory: partitions and VPs, SLAT/EPT, hypercalls, virtual MSRs and CPUID, SynIC, synthetic timers, VMBus, VTL0/VTL1 with HVCI-signed pages, and nested L2. The guest (`guest.c`) enters only through `hv_vm_entry`, every access walks the SLAT, and its window is fenced by canary pages checked after each exit.
- **Persistence.** The filesystem and registry serialize to line-oriented `KFS1`/`KREG3` formats written in C and stored in IndexedDB, so files, wallpaper, sound scheme and icon positions survive a reload. System Restore adds named restore points and versioned snapshot import/export.
- **A complete desktop.** Explorer, MS-DOS Prompt (`DIR`, `MEM`, `TASKLIST`, `KERNEL`, `REG` read the kernel directly), Control Panel, Task Manager, Notepad, Paint, Media Player, the classic games plus the Entertainment Pack, and DOOM, Duke3D, Wolf3D and others in a self-hosted DOSBox.
- **Windows 98 disk-image VM.** Open **Start → Programs → System Tools → Windows 98 Virtual Machine**, choose one of the built-in ISO images or a local bootable `.img`, `.ima`, `.vhd`, `.vhdx`, `.hdd`, `.raw`, or `.iso`, and run it in the bundled DOSBox-X WebAssembly build. Built-ins are served from `web/games/`; user images are read through the explicit host-file picker and are never uploaded.
- **Boot-path smoke image.** [`web/games/w98-simple.iso`](web/games/w98-simple.iso) is a tiny El Torito ISO that prints a diagnostic message in DOSBox-X. It verifies the local image picker and CD boot path; it is not a Windows 98 installation image.
- **Reverse-engineering challenge ISO.** [`web/games/w98-ctf.iso`](web/games/w98-ctf.iso) boots a small BIOS-level CTF challenge. It reads a candidate flag, XOR-decodes an embedded byte array, compares the decoded bytes, and prints a success or failure message. `CHALLENGE.TXT` inside the ISO gives the participant instructions.
- **Diagnostics and system tools.** Kernel Lab (read-only, WinDbg-style), Hyper-V Manager, Virtual Machine Manager, Event Viewer, Performance Monitor, Device Manager (PnP model stored under `HKLM\...\Enum`), and boot recovery (Safe Mode, boot log, Startup Menu).
- **Offline "networking".** Dial-Up Networking is a registry-backed state machine; intranet pages are served from the guest filesystem; Internet Explorer and Network Neighborhood consume the same model without touching any browser network primitive.
- **Host file exchange.** Host files are read only after a user-initiated picker, and can be mounted as `A:` (floppy) or `D:` (CD-ROM). Ejecting bumps a generation number so stale references are detected.

## Technical challenges

- **A kernel without libc.** All memory comes from static arenas; the name and data pools are first-fit allocators with coalescing. No `memcpy`, `malloc` or `printf`; built with `-fno-builtin -nostdlib`.
- **Verifiable isolation.** The guest holds no pointer into hypervisor memory, and an out-of-window access is reported as a SLAT fault rather than tolerated. Secure VTL1 images and nested L2 run on a bounded register ISA that is resumable at every instruction boundary and reuses the same EPT walk for data access.
- **Executive semantics that are enforced.** Waiting at raised IRQL or acquiring a lock at the wrong IRQL is rejected and counted, not silently allowed, and the tests pin these rules down.
- **JS only moves bytes.** `kernel.js` and `hv.js` instantiate the images, read and write linear memory, and drive the heartbeat. Every promise is time-boxed and no exception escapes to the caller. If the wasm fails to load, the desktop falls back to a JS shim and says so (`W98Kernel.mode` is `wasm` or `shim`).
- **Boot ordering versus persistence.** Several modules load before the kernel is ready; defaults are written only after `w98-kernel-ready`, so they never overwrite a registry just restored from IndexedDB. The loader still reads `KREG1` and `KREG2`.
- **Contract-driven parallel development.** Features were built in separate worktrees against the public `W98`/`W98HV` APIs, then reconciled with the kernel, hypervisor model and registry format at merge time.

## Layout

```
kernel/kernel.c, nt.c, nt.h   Win9x kernel layer and NT executive
hypervisor/hv.c               Hyper-V / VBS / VT-x state-machine model
guest/guest.c                 guest image run inside a child partition
web/js/kernel.js, hv.js       wasm glue
web/js/shell.js, desk.js      window manager, desktop, taskbar, Start menu
web/js/*.js                   boot profiles, devices, intranet, host bridge, snapshots
web/js/apps/*.js              one file per app, registered via W98.registerApp()
web/games/dos/                self-hosted DOS game bundles
tools/                        build scripts, tests, dev server
```

## Development

```sh
./tools/build_kernel.sh            # -> web/wasm/kernel.wasm
./tools/build_hv.sh                # -> web/wasm/hypervisor.wasm
node tools/kernel_test.mjs         # 478 kernel / NT ABI checks
node tools/hv_test.mjs             # 417 Hyper-V / VBS / VT-x checks
node tools/snapshot_test.mjs       # snapshot format checks
python3 tools/serve.py -p 8098     # static server with COOP/COEP and no-store
./tools/build_w98_ctf_iso.sh      # rebuild web/games/w98-ctf.iso from its source
```

Requires a clang with the `wasm32-unknown-unknown` target. COOP/COEP headers let DOSBox-WASM use SharedArrayBuffer.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| Ctrl+Esc | Start menu | Alt+Tab | Switch windows |
| Ctrl+Alt+Del | Close Program | Alt+F4 | Close window |
| F2 | Rename icon | Delete | Send to Recycle Bin |
| F5 | Refresh desktop | Run → `CRASH98` | Kernel panic, blue screen |

The Windows 98 VM has its own DOSBox controls: `Ctrl+F10` captures or releases the mouse, `Esc` releases a captured pointer, `Alt+Enter` toggles fullscreen, `P` pauses, `F5` saves the emulator's changed files, and `F9` restores them. A disk image must already be bootable; installation media still needs a writable hard-disk image for setup.

## Assets and licensing

Icons, cursors, wallpapers and some sounds are 1998-era originals, with sources recorded in `web/assets/MANIFEST.json`; missing pieces were synthesized in the same style. That original artwork is Microsoft copyright, so this project is for local personal use and not for redistribution. The kernel, hypervisor, shell and applications are original code.
