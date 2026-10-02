# Pitfalls

Ordered roughly by how often they bite. Each entry gives the symptom you'll see and what to do about it.

## Build and verification

1. **A failed build deletes the binary.** When `wasm-ld` is missing or fails, clang removes `web/wasm/*.wasm`, and `git status` shows `D`. The tests then fail to load, or, if you restore it, they pass against the *old* binary. Fix: restore with `git checkout -- web/wasm/X.wasm`, get a working linker, and never count a green test run as verification after a failed build.
2. **Homebrew `llvm` has no `wasm-ld`.** You'll see `posix_spawn failed: No such file or directory` at link time. Install `lld`.
3. **The tests are the spec. Keep the count rising.** Both suites print `ALL GREEN — N checks passed`. If N drops, you deleted or skipped assertions. Don't loosen an existing assertion to make new code pass; fix the code or flag an ABI change to the user.
4. **Doc drift.** HV_ABI.md says `build_kernel.sh` builds both images, but it doesn't: the hypervisor uses `build_hv.sh`. When you touch HV_ABI.md, fix any drift you find, and keep the doc in sync with field numbers.

## wasm32 / freestanding C

5. **`--export-all` leaks internals.** Any non-`static` helper becomes ABI and can collide across the two TUs of an image (kernel.c+nt.c, hv.c+guest.c). Default to `static`.
6. **64-bit across the boundary.** A `u64` export means BigInt in JS. Older glue does `x >>> 0` on it and throws a `TypeError`, or truncates silently. Keep the boundary 32-bit.
7. **Implicit memcpy/memset.** Struct assignment (`SynicMsg m = *src;`) and `= {0}` on large locals emit calls. With `-nostdlib` they must be defined within the image, or the link fails. An unresolved import also makes `instantiate(bytes, {})` throw.
8. **Stack size is 1 MB.** Big locals (a 256-byte `SynicMsg`, line buffers, VMCS structs) inside a recursive walk (object namespace, registry enumeration, nested VMs) can overflow silently into static data. There's no guard page, so this corrupts state rather than trapping. Use iteration and keep large buffers static.
9. **Memory budget.** hypervisor.wasm is fixed at 32 MB (initial = max). `PHYS` alone takes 16 MB. Adding per-VP state such as VMCS, VTL contexts, or virtual APICs × 16 VPs × N VTLs adds up fast. Do the arithmetic before adding a struct to `Vp`.
10. **Stale typed-array views.** kernel.wasm can grow, which detaches `memory.buffer`. Any `Uint8Array` cached across calls then reads zeros or throws. Re-take the view every time.
11. **Integer semantics.** NTSTATUS values like `0xC0000022` come out of an `i32` export as negative numbers in JS. The existing tests compare against negatives (`-1073741790`). Pick one convention per export and document it; mixing `u32` and `i32` returns for status is a recurring source of failed asserts.

## Modelling semantics

12. **Main-thread, no blocking.** A "wait" that spins until it is signalled freezes the desktop. Waits register the thread as Waiting on the dispatcher object, and the signal, timeout or alert path wakes it in `k_tick`. The same applies to the hypervisor: a VP that "halts" sets a state; it doesn't loop.
13. **Unbounded work per tick.** DPC drains, APC delivery, VM entries and timer catch-up after a backgrounded tab (huge `elapsed`) must all be budgeted. A tab returning from the background with `elapsed = 600000` must not run 60 000 timer callbacks. Clamp and record it as missed ticks.
14. **IRQL rules have to be enforced, not just documented.** New mechanisms must hook into the existing IRQL checks: pushlocks and paged-pool work only below DISPATCH, spinlocks raise to DISPATCH, and waiting at or above DISPATCH bugchecks (`IRQL_NOT_LESS_OR_EQUAL 0x0A`) or returns the refusal status. Reuse the violation counter.
15. **Reference counting.** Every new object type must go through `k_obj_create`/`ref`/`deref`. Handles hold references; waits, timers and IRPs in flight hold references. Classic leak symptom: `k_obj_count()` keeps climbing in a loop test. Classic UAF symptom: a slot is reused while a waiter still points at it. Write a create/close loop test that asserts the object count returns to baseline.
16. **Fixed tables recycle ids.** IDs are slot indexes, so a stale id from JS can silently hit a new object. Where it matters (handles, partitions, channels), add a generation/sequence number to the id and reject mismatches, the way NT handle tables do.
17. **Snapshot format.** `KFS1`/`KREG1` are persisted in users' IndexedDB. Adding hive features (new value types, security descriptors on keys, transactions in the snapshot) needs a new version tag and backward-compatible loading. Test this by loading a snapshot string produced by the current HEAD build.
18. **Don't fake counters.** UI-visible counters (Task Manager, Hyper-V Manager) must count real events in the model. Incrementing a counter without the event happening is a mock, and this project explicitly rejects mocks (see CONTRACT.md "not a mock").

## Hypervisor-specific

19. **The guest shares the hypervisor's linear memory.** guest.c is linked into hv.c's image. Its isolation holds only because guest.c voluntarily uses `hv_g_load`/`hv_g_store` (22 call sites) and never takes a raw pointer into `PHYS`. Canary pages detect *some* violations after the fact. Any new guest code that dereferences a host pointer breaks the security model invisibly. See vbs-vtx.md §1.
20. **Missing privilege checks.** The hypercall dispatcher (`hv_vmcall`, `hypervisor/hv.c` around line 1354) doesn't check partition privileges for create/deposit/map/create-VP. Any new privileged hypercall copied from those cases inherits the hole.
21. **SLAT encoding is 2 bits.** `(pfn << 2) | flags`. Adding an execute bit means changing the shift, and every `>> 2` and `& 3u` site must change in the same commit. Grep for them all, then add a test that reads back each documented `hv_gpa_state` value.
22. **GPA space is small.** `GPA_PAGES = 176` (704 KB per partition), and the fixed layout (hypercall page 0xE000, FB 0x10000, rings 0x80000/0x88000, SIMP 0x90000, SIEFP 0x91000, TSC 0x92000) is hard-coded in both hv.c and guest.c. Moving anything means changing both, plus hv_test.mjs. Allocate new pages (VTL1 memory, VMCS regions, APIC page) above the existing ones and record them in HV_ABI.md.
23. **Real TLFS numbers vs. local numbers.** Existing hypercall codes are "Hyper-V shaped" but not all real (real `HvCallPostMessage` is 0x005C, but `HvCallCreatePartition` is 0x0040 here only by convention). For new calls use the real TLFS code. If it collides with an existing local code, keep the local one and add a DEVIATION note; don't renumber.
24. **Root vs. child roles.** The root partition is index 1 and is special-cased (`is_root` returns early in start/stop/delete). New lifecycle code (save/restore, checkpoints, VTL enable) must decide what it means for the root and refuse explicitly when it doesn't apply.
