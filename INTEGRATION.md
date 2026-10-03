# System Restore integration note

`web/index.html` loads `js/snapshot.js` after the kernel and `js/apps/restore.js`
after Control Panel.  `web/js/apps/control.js` links the System Restore applet;
`web/js/desk.js` keeps it out of the default Programs list while allowing the
Control Panel link to launch it.  Applications use the documented
`W98Snapshot`/`W98.snapshot` surface, and persistent images continue through
`W98Kernel.capturePersistentState()` and `W98Kernel.replacePersistentState()`.
