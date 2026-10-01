# Windows 98 Web — App Contract (v1)

READ THIS FULLY BEFORE WRITING CODE. It is the only interface you get.

## What this is

A local website reproducing the Windows 98 desktop (32-bit era look, 640x480-era
chrome, teal desktop) running in a browser. Authenticity is the top priority:
these components ship in the real OS and should be identifiable behaviorally.

Architecture:

    kernel/kernel.c  --compiled to-->  web/wasm/kernel.wasm   (the "Win9x kernel")
    web/js/kernel.js     JS glue: loads wasm, exposes W98 kernel API
    web/js/shell.js      window manager, taskbar, start menu (the "user32/gdi")
    web/js/icons.js      pixel-art icon renderer
    web/js/apps/*.js     one file per application
    web/vendor/          98.css (global base styles), js-dos (DOS emulator)

The WebAssembly kernel owns: process table, timer queue, virtual FAT filesystem,
registry, monotonic clock, scheduler stats. JS owns pixels only. Apps talk to
the kernel through `W98` (see below) — that is what makes it a real WASM kernel
emulation rather than a mock.

## Rules

1. **One file per app**, classic script (NOT an ES module, no `import`/`export`).
   It must run under `node --check` and register itself on load.
2. Do not touch other apps, `shell.js`, `kernel.c`, `index.html` or shared CSS.
   Your app may only add its own styles inline (`<style>` injected once from JS,
   prefixed with your app id) if the shared classes below are not enough.
3. No external network access at runtime. No CDNs, no `<script src=http...>`.
4. Only use the documented `W98` / `win` API. Do not reach into shell internals
   (`win.el.parentNode`, `document.getElementById('desktop')`, …) — you will
   break. Everything you need is below.
5. Keyboard: listen on `win.el` (it is focusable) or `document`, never `window`.
   Games that take arrows/space must call `win.claimKeys()` once so the shell
   stops acting on them, and must not fire while another window has focus.
6. Everything must be keyboard-and-mouse usable and must not crash on resize.
7. Save state through `W98.fs` / `W98.reg` (they persist). Never `localStorage`
   directly.

## Registration

```js
W98.registerApp({
  id: 'minesweeper',       // unique, lowercase, matches filename
  title: 'Minesweeper',    // default window title
  icon: 'mine',            // key from W98.icons (ask if you need a new one)
  width: 176, height: 260, // default CLIENT (content) size in px, integers
  minWidth: 176, minHeight: 260,
  resizable: false,        // default true
  maximizable: false,      // default true
  desktop: true,           // put an icon on the desktop (default false)
  startMenuGroup: 'Games', // group in Start > Programs (default 'Programs')
  singleton: true,         // default false: one instance max
  create: function (win, args) { /* build UI into win.el */ }
});
```

`create` may return an object of lifecycle hooks — all optional:

```js
{ onClose(){}, onResize(w, h){}, onFocus(){}, onBlur(){}, onKey(e){} }
```

`create(win, args)`: `args` is whatever was passed to `W98.launch(id, args)`,
e.g. a file path for Notepad. May be `undefined`.

## The window (`win`)

| call | meaning |
|---|---|
| `win.el` | your client-area element. `position:relative` already set; append into it. |
| `win.width` / `win.height` | live client size in px (integers) |
| `win.setTitle(text)` | title bar text |
| `win.setIcon(key)` | title bar icon |
| `win.close()` | close (runs your `onClose` first) |
| `win.minimize()` / `win.maximize()` / `win.restore()` | window state |
| `win.focus()` | bring to front + focus |
| `win.saveTo(path)` | set the filename shown in the title bar (e.g. `C:\\AUTOEXEC.BAT`) |
| `win.claimKeys()` | shell stops handling arrows/space/F-keys while you are focused |
| `win.setMenu(menu)` | menu bar; see below |
| `win.setStatus(segments)` | status bar; `[{text:'3 objects', width:120}]` (last may omit width) |
| `win.setIcon`/`win.setToolbar` | see menu/toolbar section |
| `win.setInterval(fn, ms)` / `win.setTimeout(fn, ms)` | **kernel-scheduled** timers. Returns id. |
| `win.clearInterval(id)` / `win.clearTimeout(id)` | cancel either kind |
| `win.on(event, fn)` | `'close'`, `'resize'`, `'focus'`, `'blur'` |
| `win.off(event, fn)` | remove |

Menu bar format (renders exactly like Win98 menus):

```js
win.setMenu([
  { label: '&Game', items: [
      { label: '&New', accel: 'F2', onclick: reset },
      { type: 'sep' },
      { label: '&Beginner', type: 'radio', checked: true, onclick: setBeginner },
      { label: '&Flags',  type: 'check', checked: flags, onclick: toggleFlags },
  ]},
  { label: '&Help', items: [ { label: 'About Minesweeper…', onclick: about } ]},
]);
```
Item types: `item` (default), `sep`, `check`, `radio`. Optional `disabled: true`.
`alt+letter` opens menus, arrow keys navigate — the shell does that for you.

## Menus, toolbars, status bar, dialogs

```js
W98.dialog.alert('Title', 'Message'[, 'warn'|'error'|'info']);        // -> Promise<void>
W98.dialog.confirm('Title', 'Message');                                // -> Promise<bool>
W98.dialog.prompt('Title', 'Message', defaultText);                    // -> Promise<string|null>
W98.dialog.fileOpen({ path:'C:\\My Documents', filter:'*.txt' });      // -> Promise<path|null>
W98.dialog.fileSave({ path:'C:\\My Documents', name:'Untitled.txt',
                      filter:'*.txt' });                              // -> Promise<path|null>
```
All of these are real Win98 modal dialogs, not browser popups. Never call
`alert()`, `confirm()` or `prompt()`.

Shared classes for native chrome (already styled, use them freely):

    .w98-toolbar             horizontal toolbar container
    .w98-toolbtn             toolbar button (contains <img>/<canvas> + <span>)
    .w98-menubar             menu bar (only if you build one by hand — prefer win.setMenu)
    .w98-statusbar           status bar container (prefer win.setStatus)
    .w98-sunken .w98-raised  bevel borders for panels
    .w98-field               white sunken input field / game board backdrop
    .w98-listbox             white sunken scrollable list
      .w98-listitem          selectable row (add .selected)
    .w98-tabs / .w98-tab     tab strip + tab (add .active)
    .w98-progress            progress bar (set style.width on the inner <i>)
    .w98-groupbox            group box (like a fieldset with a title)
    .w98-tooltip             tooltip bubble

Base elements (`button`, `input[type=*]`, `select`, `textarea`, `fieldset`,
`ul.tree-view`, `.window`, `.title-bar`, `.status-bar`, `.sunken-panel`,
`.progress-indicator`, `.slider`) are already skinned by 98.css — plain
`<button>Reset</button>` already looks correct, and `<button class="default">`
marks the default push button. Prefer those over custom CSS.

## Kernel / system API

```js
W98.tick()                    // monotonic ms from the WASM kernel clock
W98.stats()                   // {syscalls, ticks, procs, timersFired, heapUsed, heapSize,
                              //  timerQueue, nextPid, uptimeMs}
W98.raf(fn)                   // requestAnimationFrame loop; fn(dtMs) while visible.
                              // Returns a cancel function. Use for smooth animation.

// Filesystem (persistent, survives reload) — paths are Windows style:
W98.fs.exists(path)           // -> bool
W98.fs.readText(path)         // -> string|null
W98.fs.writeText(path, s)     // create + overwrite, parents auto-created
W98.fs.readBytes(path)        // -> Uint8Array|null
W98.fs.writeBytes(path, u8)
W98.fs.list(path)             // -> [{name, dir, size, mtime}] sorted, dirs first
W98.fs.mkdir(path)  W98.fs.remove(path)  W98.fs.rename(from, to)  W98.fs.stat(path)

// Registry (persistent) — registry paths, no hive prefix:
W98.reg.get('HKEY_CURRENT_USER\\Software\\MyApp', 'Setting', 'default')
W98.reg.set('HKEY_CURRENT_USER\\Software\\MyApp', 'Setting', 'value')
W98.reg.del('HKEY_CURRENT_USER\\Software\\MyApp', 'Setting')

W98.launch(appId, args)        // start another app (also a kernel process)
W98.sound.beep()               // the classic "ding"
W98.sound.click()              // menu/button click
W98.sound.error()              // critical stop
W98.sound.startup() / W98.sound.shutdown()
W98.sound.tone(freqHz, ms, type)  // raw oscillator for game SFX
W98.aboutDialog(appDef)        // standard About box for your app
```

`W98.fs` paths use backslashes (`C:\\WINDOWS\\SYSTEM.INI`). Default folders that
exist at boot: `C:\\WINDOWS`, `C:\\WINDOWS\\SYSTEM`, `C:\\WINDOWS\\DESKTOP`,
`C:\\My Documents`, `C:\\Program Files`, `C:\\Recycled`, `A:\\`.

## Visual language

Use these exact colors so games match the OS chrome:

    face       #c0c0c0     shadow  #808080   dark   #000000
    highlight  #ffffff     light   #dfdfdf
    titlebar   gradient #000080 -> #1084d0 (active)
    desktop    #008080     text    #000000   disabled text #808080
    selection  #000080 background / #ffffff text

Font is Tahoma/MS Sans Serif 11px set by the shell — do not change it except for
game canvases. Adjacent bevels: highlight top/left + dark bottom/right; sunken is
the reverse. A 1px white outer + 1px #808080 inner is the classic "raised" look.

Games must render on `<canvas>` inside `win.el` with
`image-rendering: pixelated` and integer scaling, and should keep the classic
low-resolution feel. Never use `border-radius` or soft shadows: this is 1998.

## Worked example

```js
W98.registerApp({
  id: 'clock', title: 'Clock', icon: 'clock', width: 220, height: 90,
  resizable: false, desktop: false, startMenuGroup: 'Accessories',
  create: function (win) {
    win.el.style.display = 'flex';
    var face = document.createElement('div');
    face.className = 'w98-sunken w98-field';
    face.style.cssText = 'font:bold 28px "Lucida Console",monospace;padding:8px;' +
                         'text-align:center;flex:1';
    win.el.appendChild(face);
    var t = win.setInterval(function () { face.textContent = new Date(W98.now()).toLocaleTimeString(); }, 500);
    var hook = { onClose: function () { win.clearInterval(t); } };
    return hook;
  }
});
```
