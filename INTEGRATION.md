# Windows 98 Entertainment Pack extension

This extension adds three independent Windows 98 Entertainment Pack style
applications. Each app is a classic, self-registering script and has no runtime
network dependencies:

| App | Script | Registered id | Client size |
| --- | --- | --- | --- |
| Hearts | `web/js/apps/hearts.js` | `hearts` | resizable canvas board |
| Spider Solitaire | `web/js/apps/spider.js` | `spider` | fixed classic board |
| Hover! | `web/js/apps/hover.js` | `hover` | fixed 640×456 canvas |

## Loading the extension

The repository intentionally keeps the existing `web/index.html` unchanged.
To load the extension in a local desktop build, add these script tags after the
other application tags and before `js/desk.js` (or load the files in the same
order from a host page that already loaded `kernel.js`, `icons.js`, and
`shell.js`):

```html
<script src="js/apps/hearts.js"></script>
<script src="js/apps/spider.js"></script>
<script src="js/apps/hover.js"></script>
```

Every file calls `W98.registerApp()` as soon as it is loaded, so the normal
desktop registry, Start menu, and `W98.launch('hearts')`,
`W98.launch('spider')`, and `W98.launch('hover')` paths work independently.

## Behavior and persistence

All three apps provide a Win98-style Game menu with New Game/Reset and a Help
menu with About. They claim keyboard input only while their own window is
focused, stop advancing game state on blur/minimize, and clear their
window-scoped kernel timer on close. Mouse controls remain available on the
canvas; keyboard shortcuts are shown in each app's Help dialog/menu.

Scores, preferences, and deterministic deal/course seeds are stored under
each app's own registry key. Spider also saves its in-progress board. Saved
values are parsed defensively; malformed JSON or out of range values are
discarded in favor of a fresh valid game. Gameplay randomness comes from a
small seeded PRNG, so a saved seed reproduces the same deal/course.

The apps use the monotonic kernel clock (`W98.tick()`) for elapsed time and
animation deltas, driven by `win.setInterval()`. No app calls `Date.now()`,
`Math.random()`, or a browser network API.

## Validation

From the repository root:

```sh
node --check web/js/apps/hearts.js
node --check web/js/apps/spider.js
node --check web/js/apps/hover.js
```

The three commands are the syntax gate for the extension; each new file is
also a standalone classic script and does not require an ES module loader.
