# Windows 98 — WebAssembly edition

A local website that is a faithful reproduction of the Windows 98 desktop, with
the operating-system state (process table, filesystem, registry, timer queue,
scheduler, NT executive and a bounded Hyper-V model) served by **WebAssembly
images compiled from C**.

    ./run.sh                     # starts the server on http://127.0.0.1:8098/

Nothing is fetched at runtime: the emulator, the filesystem, the sounds and the
games are all local files.

## Why there is a "kernel"

The desktop is not a mock. `kernel/kernel.c` is a freestanding 32-bit kernel
image (no libc, no entry point) compiled with clang to `wasm32` and executed by
the browser's WebAssembly engine. It owns:

| subsystem | what it does | syscalls |
|---|---|---|
| process table | every window is a process: pid, state, z-order, CPU time | `k_proc_*` |
| scheduler | round-robin, charges real elapsed time to the running task | `k_tick`, `k_sched_*` |
| timer queue | `setInterval`/`setTimeout` from every window is a kernel timer | `k_timer_*` |
| filesystem | hierarchical, case-insensitive, `C:` and `A:` drives, 4 096 nodes | `k_fs_*` |
| registry | hive path + value name, editable from Control Panel | `k_reg_*` |
| heap | first-fit allocator with coalescing, 8 MB, peak tracking | `k_alloc` |
| clock, PRNG, log, panic | kernel services + the blue screen | `k_tick`, `k_rand`, `k_log`, `k_panic` |

JS owns pixels only. `js/kernel.js` is the glue: it instantiates the image,
moves bytes in and out of its linear memory, and drives the heartbeat. The
kernel snapshot (filesystem + registry, line-oriented `KFS1`/`KREG3` format
written and parsed in C; the registry loader still accepts `KREG1` and `KREG2`)
is persisted to IndexedDB, so a reload brings your files, wallpaper, sound
scheme and icon positions back.

If `kernel.wasm` cannot be loaded the desktop still starts on a reduced JS
fallback and says so — `W98Kernel.mode` is `wasm` or `shim`, and System
Properties displays which one is live.

    kernel/kernel.c + nt.c     the Win9x and NT-style kernel layers
    hypervisor/hv.c + guest.c  the Hyper-V/VBS/VT-x state-machine model
    tools/build_kernel.sh      clang -> web/wasm/kernel.wasm  (about 137 KiB)
    tools/build_hv.sh          clang -> web/wasm/hypervisor.wasm (about 113 KiB)
    tools/kernel_test.mjs      node tools/kernel_test.mjs      (478 checks)
    tools/hv_test.mjs          node tools/hv_test.mjs          (417 checks)

## What is on the desktop

Start menu: Programs (Accessories / Games / DOS Games / StartUp, MS-DOS Prompt,
Windows Explorer, Online Services, Internet Explorer), Favorites, Documents,
Settings (Control Panel, Printers, Taskbar & Start Menu, Folder Options, Active
Desktop, Windows Update), Find, Help, Run, Log Off, Shut Down.

Built-in: My Computer / Explorer, MS-DOS Prompt, Control Panel (Display,
System, Date/Time, Sounds, Mouse, Keyboard, Add/Remove Programs, Fonts,
Modems, Network, Multimedia, Power, Regional, Users, Accessibility, Internet
Options, Game Controllers, Add New Hardware, Taskbar & Start Menu, Folder
Options), Task Manager, Recycle Bin, Run, Find: All Files, Windows Help,
WinVer, Internet Explorer (offline, renders local pages), Notepad, Calculator,
Character Map, Media Player, Paint, Minesweeper, Solitaire, FreeCell, JezzBall,
3D Pinball (Space Cadet), and MS-DOS games through a self-hosted DOSBox.

Things that really work, end to end:

* **MS-DOS Prompt** — `DIR`, `CD`, `TYPE`, `COPY`, `DEL`, `REN`, `MD`, `RD`,
  `TREE`, `MORE`, `FIND`, `MEM`, `CHKDSK`, `TASKLIST`, `KERNEL`, `REG`, `VER`,
  `VOL`, `DATE`, `TIME`, `SET`, `PROMPT`, `EDIT`, `START`, `WIN`, `HELP`,
  `EXIT`, `FORMAT` (declines, politely), command history, tab completion.
  `DIR` reads the kernel filesystem, `MEM` reports the kernel heap, `TASKLIST`
  walks the kernel process table and `KERNEL` dumps the kernel log.
* **Task Manager** — Applications and Processes come from the kernel process
  table (pid, CPU time charged by the scheduler, state), Performance plots the
  kernel's own counters.
* **Control Panel** — Display (wallpaper, screen saver, colour schemes, effects),
  Sounds (the real `AppEvents` scheme, pointing at WAVs in `C:\WINDOWS\MEDIA`),
  Mouse (cursor schemes, pointer trails), Add/Remove Programs (really removes
  programs from `C:\Program Files`, Windows Setup toggles the games), System
  (kernel heap, device tree).
* **Files** — everything is in the kernel volume and persists: create files and
  folders on the desktop or in Explorer, delete them into the Recycle Bin,
  rename, drag icons around (positions are remembered), open them in Notepad /
  Paint / Media Player / Explorer by extension.
* **Screen savers** — Windows 98 logo, Mystify, Starfield, Flying Windows, with
  the idle timeout from Display Properties; Ctrl+Alt+Del opens the Close
  Program dialog; `CRASH98` in the Run box panics the kernel and shows the blue
  screen.
* **Executive and hypervisor model** — the NT layer covers VADs, large pages,
  paging, prototype sections, tagged pool and bounded segment heaps. The
  Hyper-V image also has a mediated guest-register ISA for signed VTL1 images
  and nested L2 EPT execution; the browser keeps the legacy guest boot for
  compatibility and runs entirely from local files.

## Fidelity notes

* Chrome metrics come from 98.css (MIT), which reproduces the real control
  metrics, and from `css/shell.css` for the desktop, taskbar (28 px), Start menu
  (with the vertical "Windows 98" band), menus, dialogs and cursors. The text
  font is the bitmap "Pixelated MS Sans Serif" at 11 px, the real font of the
  era.
* Client-area sizes match the originals: Solitaire 585x396, FreeCell 632x456,
  JezzBall 592x472, Pinball 300x460, Paint 560x400, Notepad 560x360,
  Calculator 260x340, MS-DOS Prompt 640x400, desktop icons on a 75x75 grid.
* Only the focused window gets the blue title-bar gradient; the rest are grey.
* Icons are drawn in the palette of the period (`js/icons.js`, 112 of them). With
  `web/assets/MANIFEST.json` present, the vendored 32x32 and 16x16 icon set,
  the 16 cursors, the 24 wallpapers and the 20 sounds are used instead, and the
  hand-drawn art is only a fallback.
* Sounds come from `C:\WINDOWS\MEDIA` through the kernel filesystem, addressed
  by the real `HKEY_CURRENT_USER\AppEvents\Schemes` values, so the Sounds applet
  edits a scheme that actually plays.

## Provenance and licensing

The asset pass assembled the set from 1998-era sources and recorded every
original in `web/assets/MANIFEST.json`. In short: the icons are the low-colour
renditions from Alex Meub's Windows 98 icon catalogue; the cursors, the boot
screens, the wallpapers and eleven of the sound files are the originals (the
WAVs and the BMP wallpapers, including the real `Clouds.bmp`); nine sounds with
no 1998 equivalent (click, menu, minimize, logon, …) were synthesised in the
same style, as were a few pattern wallpapers with no surviving original, and
the JezzBall icon and several cursors that never shipped as files.

Note that the original icon, wallpaper and sound artwork is Microsoft
copyright: this is a period-correct reproduction kept local and personal, not
something to redistribute. Everything else here (the kernel, the shell, the
applications) is original code.


## Keyboard

    Ctrl+Esc        Start menu              Alt+Tab     switch windows
    Ctrl+Alt+Del    Close Program dialog    F2          rename selected icon
    F5              refresh desktop         Delete      send icon to Recycle Bin
    Enter           open selected icon      Alt+F4      close focused window

## Layout

    kernel/kernel.c          the kernel (C, ~1 250 lines)
    tools/build_kernel.sh    build + tools/kernel_test.mjs (478 checks)
    tools/serve.py           static server with the COOP/COEP headers WASM wants
    web/index.html           loads the kernel, the shell and the apps
    web/js/kernel.js         syscall glue + snapshot persistence (IndexedDB)
    web/js/shell.js          window manager, menus, dialogs, sounds, W98 API
    web/js/desk.js           desktop, taskbar, Start menu, tray, boot, savers
    web/js/icons.js          icon set (authentic assets if present, else drawn)
    web/js/apps/*.js         one file per application
    web/assets/              authentic assets (icons, cursors, sounds, wallpapers)
    web/games/dos/           self-hosted DOS game bundles + manifest
    CONTRACT.md              the API every application is written against

## Development

    ./tools/build_kernel.sh          # rebuild web/wasm/kernel.wasm
    ./tools/build_hv.sh              # rebuild web/wasm/hypervisor.wasm
    node tools/kernel_test.mjs       # exercise the NT/kernel ABI
    node tools/hv_test.mjs           # exercise the Hyper-V/VBS/VT-x ABI
    python3 tools/serve.py -p 8098   # serve

The server sends `Cache-Control: no-store`, so edit → reload always shows the
change.
