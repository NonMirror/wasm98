# VBS, VSM and VT-x: design notes

## 1. The isolation boundary problem (solve this first)

In real hardware, VBS works because VTL0 *physically cannot* address VTL1 memory: SLAT denies it. In this repo the guest is C code linked into the same wasm instance as the hypervisor. Isolation is a convention: guest.c only reaches memory through `hv_g_load` / `hv_g_store`, which walk the SLAT. Canary pages catch some violations after the fact.

That convention is acceptable only if it is **mechanically checked**. Pick one of these, in order of preference, and tell the user which:

- **A. Guest bytecode interpreter (recommended for Tier 3/4).** Guests become programs for a tiny register ISA (or a bounded x86 subset) interpreted by the hypervisor. Every guest load, store and fetch goes through the SLAT/EPT walk, so R/W/X, EPT violations, VM exits and HVCI's "can't execute unsigned code" become *real* properties instead of conventions. This is the only option where "execute permission" means anything. It is an architecture change, so get user approval first.
- **B. Separate wasm instances per partition / per VTL.** Each guest gets its own `WebAssembly.Memory`; JS routes hypercalls between them. This gives true memory isolation from the wasm sandbox. The cost is that every cross-partition access is a JS round trip, and you need a shared-memory model for GPADLs (copy, or a SharedArrayBuffer, which needs COOP/COEP; `tools/serve.py` already sends those headers).
- **C. Keep the shared image but lint it.** A test or CI script that fails if `guest/guest.c` (or any VTL1/guest TU) takes the address of, or names, any hypervisor symbol other than the documented entry points (`hv_g_load`, `hv_g_store`, `hv_vmcall`, `hv_guest_log`). Cheapest, and good enough for Tier 2, but not for claiming HVCI semantics.

Whatever you choose, write it into HV_ABI.md as the trust model, and add a test that **attempts the violation** (VTL0 → VTL1 read, guest → host read) and asserts it is refused or detected.

## 2. VSM / VTL model

State per VTL, per VP (TLFS "VSM"):
- a full register context (VP registers are banked per VTL);
- a SynIC per VTL (VTL1 has its own SINTs);
- per-VTL page protections: an `(R,W,X)` mask per GPA page for each lower VTL.

Transitions:
- `HvCallVtlCall`: VTL0 → VTL1. VTL0 state is saved, VTL1 state is loaded, and the entry reason is "VTL call".
- `HvCallVtlReturn`: VTL1 → VTL0.
- Intercepts: a VTL0 access that violates a VTL1-set protection **enters VTL1 with an intercept message** (memory intercept with GPA + access type). It is never just a failed hypercall. VTL1 decides whether to deny or emulate.
- Higher-VTL interrupts preempt lower-VTL execution.

Enable sequence (all refused unless the partition has the VSM privilege): `HvCallEnablePartitionVtl` → `HvCallEnableVpVtl` (provides the initial VTL1 context) → the VTL1 secure kernel initialises → it applies protections with `HvCallModifyVtlProtectionMask`.

HVCI as a VTL1 policy: VTL0's kernel asks VTL1 to make a page executable. VTL1 checks the page contents against an allowlist (the model for code integrity / signature checks), then sets VTL0's mask to `R+X` without `W`. Any later VTL0 attempt to set `W` on that page → intercept → refused. Tests must cover: unsigned → refused; signed → X; X page write attempt → intercept + refused; W page exec attempt → intercept + refused.

Credential Guard as a trustlet: the secret lives only in VTL1 pages. VTL0 asks LSAIso (via a secure call) for an operation and gets a result. The test scans every VTL0-accessible GPA for the secret bytes and must find nothing.

## 3. VT-x model

Use real Intel SDM names and encodings so the model is checkable against the manual:

- **VMCS** is a region in host (hypervisor) memory with a revision id from `IA32_VMX_BASIC`. Fields are accessed only through VMREAD/VMWRITE using real encodings (e.g. `GUEST_RIP 0x681E`, `VM_EXIT_REASON 0x4402`, `EXIT_QUALIFICATION 0x6400`, `EPT_POINTER 0x201A`, `VIRTUAL_PROCESSOR_ID 0x0000`). Don't expose the struct layout as ABI. Software isn't supposed to know it on real hardware either.
- **Launch state machine**: clear → (VMLAUNCH) → launched; VMCLEAR resets to clear. The VMfailInvalid / VMfailValid distinction and the VM-instruction error numbers come from the SDM.
- **Allowed-0/allowed-1 control bits**: VM entry fails if a required bit is wrong. This is a large source of tests that are cheap to write.
- **Exit flow**: the guest stops at an instruction boundary → the exit reason and qualification are written to the VMCS → the hypervisor handler runs → VMRESUME. That means the guest's execution must be **resumable at an instruction**, which is why the current direct C call `hv_vmcall()` from guest.c must become an exit. With option A (interpreter) this is natural. With the current staged `gstep()` model, a "stage" must be able to stop mid-stage, which is awkward, so this is the strongest argument for option A.
- **EPT** replaces the flat `slat[]` for VT-x mode: a real 4-level walk of 512-entry tables stored in `PHYS`, permission bits R/W/X, memory type, and A/D bits. A violation gives exit 48 with qualification bits (access type + the entry's permissions). An invalid combination (W without R) gives exit 49.
- **TLB semantics**: model a small translation cache keyed by (VPID, EPTP, GPA). Remapping without INVEPT/INVVPID must leave stale entries. Tests assert the stale behaviour *and* the fix after invalidation. Skipping the cache entirely is a fidelity bug, not a simplification.

### Nested (L0/L1/L2)

L1's VMX instructions exit to L0. L0 keeps VMCS12 (L1's view) and builds VMCS02 (what actually runs L2) by merging controls. An L2 exit is handled by L0 if L1 didn't request it, and reflected to L1 (as an L1 VM exit with VMCS12 updated) if it did. Hyper-V's enlightened VMCS (eVMCS) is an optimisation layered on top. Add it only after plain nested works.

## 4. Mapping the existing hypervisor onto VT-x (end state)

| today | VT-x mode |
|---|---|
| `hv_vmcall()` direct call | VMCALL → exit reason 18 → hypercall dispatcher |
| `HC_QUERY_MSR` / `HC_SET_MSR` | RDMSR/WRMSR → exits 31/32 (subject to MSR bitmaps); keep the hypercalls as a DEVIATION fallback |
| `HC_CPUID` | CPUID → exit 10 |
| `slat[]` 2-bit | EPT with R/W/X |
| VTL protections | one EPT per VTL (or permission overlays), switched on VTL transitions |
| `hv_schedule` time slices | VMX preemption timer exit 52 |

Keep the old path working until the new one passes the full hv_test suite. Then switch the guest over in one change, and keep the old hypercall-frame ABI as documented compatibility.
