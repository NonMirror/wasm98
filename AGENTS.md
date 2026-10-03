You are working in a dedicated Git worktree for the wasm98 repository.

Read these before changing anything:

- README.md
- CONTRACT.md
- HV_ABI.md if the feature touches the hypervisor
- /Users/nonmirror/Project/wasm98/.agents/skills/wasm98-kernel/SKILL.md if the feature touches kernel, Hyper-V, VBS, guest, ABI, or WASM glue code

This project is a local Windows 98 recreation whose state is modeled in WebAssembly. Runtime network fetches are forbidden. Do not use external CDNs, remote scripts, or network services.

Preserve the existing classic-script architecture. Application files must use W98.registerApp(), use only the documented W98 and win APIs, remain keyboard and mouse usable, and pass node --check.

Work only within the file ownership listed in this prompt. Do not edit web/index.html, web/js/desk.js, web/js/shell.js, web/js/apps/shellapps.js, or shared CSS unless this prompt explicitly grants ownership. Leave a short INTEGRATION.md note describing the script tag, Start menu entry, Control Panel link, or shell hook that the final integration worktree must add.

Do not overwrite unrelated user changes. Inspect git status before editing.

When finished:

1. Run node --check on every changed JavaScript file.
2. Run the relevant kernel or Hyper-V tests.
3. Run the full test gate when C, ABI, or WASM glue code changed.
4. Commit the feature on this branch.
5. Report the commit, changed files, tests run, and integration notes.