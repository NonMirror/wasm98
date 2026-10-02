---
name: wasm98-kernel
description: Use when extending the wasm98 WebAssembly kernel (kernel/kernel.c, kernel/nt.c, kernel/nt.h), the Hyper-V style hypervisor (hypervisor/hv.c), the guest image (guest/guest.c), or their JS glue (web/js/kernel.js, web/js/hv.js) — e.g. adding modern NT kernel mechanisms (object namespace, ALPC, IOCP, pushlocks, PnP, MM lists, integrity levels, PPL, ETW, job objects), Hyper-V features (TLFS hypercalls, SynIC, VMBus, partition privileges), VBS/VSM (VTL0/VTL1, secure kernel, HVCI, Credential Guard, KDP), or an Intel VT-x model (VMXON, VMCS, VM exits, EPT, VPID, nested virtualization). Also use when touching HV_ABI.md or the kernel/hv test suites.
---

# wasm98 kernel / Hyper-V / VBS development

This repo is a Windows 98 desktop in the browser. Its OS state lives in two freestanding wasm32 images built from C:

| image | sources | owns | tests |
|---|---|---|---|
| `web/wasm/kernel.wasm` | `kernel/kernel.c` (Win9x layer), `kernel/nt.c` + `nt.h` (NT executive) | processes, threads, objects, handles, tokens, IRQL/DPC/APC, IRPs, MM, hive, bugcheck | `node tools/kernel_test.mjs` |
| `web/wasm/hypervisor.wasm` | `hypervisor/hv.c` + `guest/guest.c` (same linear memory) | partitions, VPs, SLAT, hypercalls, MSR/CPUID, SynIC, stimer, VMBus | `node tools/hv_test.mjs` |

The contracts are `HV_ABI.md` (kernel and HV ABI) and `CONTRACT.md` (app API). Read both before changing anything. Then read `references/pitfalls.md`. It is short and covers almost every way this work goes wrong.

## What "Windows kernel in wasm" means here (read once, keep in mind)

wasm32 has no MMU, no CPU rings, no interrupts, no traps you can catch, no threads on the main thread, and no way to run x86 code. Every mechanism in this project is therefore a **faithful state-machine model** of the real thing: the same objects, state transitions, status codes, invariants and failure modes. None of it is hardware. That is legitimate, but it has two consequences:

1. **Fidelity is in the semantics.** A mechanism counts as done when its observable behaviour matches Windows: it refuses what Windows refuses, returns the matching NTSTATUS / HV_STATUS, has the same ordering rules, and the same failure counters rise. A struct that is named correctly but has no enforcement is not done.
2. **Security features need a real isolation boundary in the model.** HVCI, VTL1 and Credential Guard mean nothing if the "attacker" side can write the protected bytes with a plain C pointer. See `references/vbs-vtx.md` §1 before starting any VBS work.

Never emit x86 assembly, inline asm, or claims of running real Windows binaries or drivers.

## Workflow (every change)

1. **Scope one mechanism.** Choose one from `references/roadmap.md`, in tier order unless the user says otherwise. Write down its real-Windows behaviour first: states, status codes, invariants, and what it refuses. Use the real names (`KeWaitForMultipleObjects`, `HvCallModifyVtlProtectionMask`, exit reason 48 `EPT_VIOLATION` …).
2. **Design the ABI first.** Add the section to `HV_ABI.md` before writing C: exports, field indices, status codes, counters. Every new export is permanent ABI (see "ABI rules").
3. **Implement in C** inside the right TU, using static arenas, bounded loops, and status returns (see "C rules").
4. **Test.** Add assertions to `tools/kernel_test.mjs` / `tools/hv_test.mjs` for both the happy path and **every refusal**. A mechanism with no negative test is not done.
5. **Glue and UI (optional).** Expose it in `web/js/kernel.js` / `web/js/hv.js`. Task Manager and Hyper-V Manager can show counters. Apps keep using only the documented `W98` API.
6. **Run the gate** (below). Report the check counts from both suites.

Do one mechanism per change, with its tests in the same change. Don't batch five half-mechanisms.

## The gate (must pass before reporting done)

```sh
git status --short web/wasm/                 # note the state before building
./tools/build_kernel.sh && ./tools/build_hv.sh
git status --short web/wasm/                 # both .wasm must now be modified (M), never deleted (D)
node tools/kernel_test.mjs                   # must end with "ALL GREEN — N checks passed"
node tools/hv_test.mjs                       # same; N must not shrink
for f in web/js/*.js web/js/apps/*.js; do node --check "$f"; done
```

- **If a build fails, the linker has deleted the committed `.wasm`.** Run `git checkout -- web/wasm/<file>.wasm` immediately. Otherwise the tests run against a missing binary, or later against a stale one. Never report success when the build step failed, even if the tests are green, because then they tested the old binary.
- Toolchain: this needs `clang` with the wasm32 target and `wasm-ld`. Homebrew `llvm` ships without `wasm-ld`. Fix with `brew install lld` (it provides `wasm-ld`), or put an LLVM that includes lld first on PATH. If you cannot build, stop and tell the user. Don't hand-edit the wasm, and don't "verify" against the old binary.
- Browser smoke test (when glue or UI changed): `python3 tools/serve.py -p 8098`, then load the page. The desktop must boot in `wasm` mode, the VM console must show the guest heartbeat, and the desktop must still boot when `hypervisor.wasm` is missing.
- The user may have uncommitted work in `web/js/*.js`. Check `git status` and `git diff` before editing JS, and never revert or overwrite changes you didn't make.

## ABI rules

- `--export-all` is on, so **every non-`static` function is exported** and becomes ABI. Mark internal helpers `static`. Before adding a non-static symbol, grep both TUs of the image for its name (kernel.c and nt.c link together, as do hv.c and guest.c).
- Exports take and return only `u32`/`i32`. A `u64` parameter or return becomes a JS `BigInt` and silently breaks the glue. Split 64-bit values into lo/hi, as `msr_read(…, *lo, *hi)` already does.
- Field accessors follow the existing pattern `x_field(id, f)` with numbered fields documented in HV_ABI.md. You may append field numbers. Never renumber or reuse them.
- Keep the legacy APIs working: `k_proc_*`, flat `k_reg_*`, the `W98` app API, and the `W98HV` surface. Existing hypercall codes and MSR numbers stay as they are. New ones use the **real TLFS numbers** wherever they exist. Mark any departure from real Windows with a `DEVIATION:` comment and add it to HV_ABI.md.
- JS must re-create typed-array views after every call that can grow memory (`kernel.wasm` can grow to 256 MB). Follow the existing `bytes()` pattern and never cache a `Uint8Array` over `memory.buffer`.

## C rules

- Freestanding: no libc, `-fno-builtin`. Clang still emits `memcpy`/`memset` calls for struct copies and large initialisers, so each image must define them exactly once. In kernel.wasm, `kernel/kernel.c` exports them and nt.c relies on that, so don't redefine them in nt.c (duplicate symbol). hypervisor.wasm has `static` copies in hv.c; guest.c needs its own static copies if it ever relies on them. A missing symbol shows up as a link error or an import, and the image must have **zero imports** because it is instantiated with `{}`.
- No dynamic allocation outside the existing arenas. Every table has a `NT_MAX_*` / `MAX_*` bound. When a table is full, return a status (`STATUS_INSUFFICIENT_RESOURCES`, `HV_STATUS_INSUFFICIENT_MEMORY`) and bump a counter. Never overrun.
- **Nothing may block or loop unboundedly.** Everything runs on the browser main thread, driven by `k_tick` / `hv_schedule` from the heartbeat. A wait is a state plus a later wake. Long work is a staged state machine, like `gstep()` in guest.c. Every loop has a budget.
- Memory budgets are fixed. hypervisor.wasm has `initial = max = 32 MB`, with 16 MB of that being `PHYS`, so growing `PHYS`, `MAX_PARTS` or per-VP structs (each `Vp` embeds 16×256-byte messages) can overflow the image. kernel.wasm statics are capped by `nt.h`. After raising a bound, check the built size and confirm instantiation still succeeds in both tests.
- Determinism: time comes in as an argument (`k_tick(nowMs)`, `hv_schedule(elapsed)`). Never read time any other way. Tests pass explicit times.
- Persistence: the hive and filesystem are saved to IndexedDB in the `KFS1`/`KREG1` text formats. A format change needs a version bump and a parser that still loads the old version, or every existing user's desktop loses its state on reload.

## Hyper-V / VBS / VT-x specifics

Read `references/vbs-vtx.md` before any of this work. The non-negotiables:

- **Partition privileges first.** Today any child partition can successfully call `HvCallCreatePartition`, `HvCallDepositMemory`, `HvCallMapGpaPages` and `HvCallCreateVp`. CPUID `0x40000003` advertises a privilege mask, but nothing checks it. Real Hyper-V gates these on the `HV_PARTITION_PRIVILEGE_MASK` bits (`CreatePartitions`, `AccessMemoryPool`, …) and returns `HV_STATUS_ACCESS_DENIED`. Fix this, with negative tests, before building VSM on top.
- **The SLAT entry format has no room for permissions.** `slat[] = (pfn << 2) | (flags & 3)` has present and writable only. HVCI, KDP, EPT and VTL protections all need R/W/X (and per-VTL masks). Change the encoding in one place, update `slat_pfn`/`slat_set`/`gpa_state_of` and every `& 3u`, and keep `hv_gpa_state` returning its documented values.
- **Hypercalls are synchronous C calls today.** The guest calls `hv_vmcall()` directly. The VT-x model (VM exits, VMCS, exit reasons) requires turning that into "guest stops with an exit reason, hypervisor handles it, VM resumes". This is the biggest refactor in the roadmap, so do it once, deliberately, and as its own change.

## Escalate to the user (don't decide alone)

- Introducing a guest ISA interpreter (needed for real EPT-execute/HVCI semantics, see vbs-vtx.md §3) or splitting partitions or VTL1 into separate wasm instances. These are architecture changes.
- Any change that breaks a documented ABI field, a hypercall code, or the snapshot format.
- Raising the hypervisor's fixed 32 MB memory, or the kernel's 256 MB ceiling.
- Anything that adds a network fetch at runtime. That is not allowed, so the answer is no.

## References

- `references/pitfalls.md` — the difficult and error-prone parts of this work, with concrete symptoms.
- `references/roadmap.md` — prioritised list of modern NT, Hyper-V, VBS and VT-x mechanisms, with acceptance tests for each.
- `references/vbs-vtx.md` — design notes for the isolation boundary, VSM/VTLs, HVCI, the VT-x/VMCS/EPT model, and nested virtualization.
