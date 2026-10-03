

## Kernel Lab

Load `js/apps/kernel-lab.js` after `kernel.js`, `shell.js`, and `hv.js` and
before `desk.js`. It registers the singleton `kernel-lab` app in `System Tools`.
The command views read only the documented kernel and hypervisor diagnostics,
keep bounded output, and remain usable with either WASM image absent. The
crash-lab action is the sole mutation: it invokes the existing panic/bugcheck
entry point only after the native confirmation dialog; all other views and
links are read-only.
