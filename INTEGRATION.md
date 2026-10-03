

## Entertainment Pack games

Load `js/apps/hearts.js`, `js/apps/spider.js`, and `js/apps/hover.js` after the
other application scripts and before `desk.js`. Each is a classic
`W98.registerApp` game in the `Games` Start-menu group, uses bounded
window-scoped timers and keyboard claims, and stores preferences/deals through
`W98.reg`. They have no network dependencies and preserve existing games.
