# Roadmap

Work top-down. Each item lists where it lives, what "done" means (the assertions to add), and what it depends on. Real Windows names are given so the model matches the real thing.

## Tier 0: foundations (do before anything else)

| # | item | where | done when |
|---|---|---|---|
| 0.1 | Working toolchain + gate | tools/ | both builds succeed, both suites green, the `.wasm` files show as modified |
| 0.2 | Partition privilege mask enforced | hv.c `hv_vmcall` | a child calling CreatePartition / DepositMemory / MapGpaPages / CreateVp gets `HV_STATUS_ACCESS_DENIED`; the root still succeeds; CPUID 0x40000003 reflects the real per-partition mask |
| 0.3 | Generation-tagged ids | nt.c handles, hv.c partitions/channels | a stale id after delete+recreate is rejected |
| 0.4 | SLAT entry with R/W/X | hv.c | map with each permission combination; read/write/exec checks report the matching fault; `hv_gpa_state` unchanged for old callers |
| 0.5 | Object-count leak test | tests | 1000× create/open/close loops return `k_obj_count()` and handle counts to baseline |

## Tier 1: modern NT executive (kernel/nt.c)

| # | mechanism | done when |
|---|---|---|
| 1.1 | Object Manager namespace (`\`, `\Device`, `\BaseNamedObjects`, `\Sessions\N`, symbolic links, `\??` → `\GLOBAL??`) | named create/open, `STATUS_OBJECT_NAME_COLLISION`, `…_NOT_FOUND`, link resolution with a depth limit (`STATUS_REPARSE` loop refused) |
| 1.2 | Real security descriptors: SID + ACE list, owner, DACL/SACL, `SeAccessCheck` with generic mapping, privileges (`SeDebugPrivilege`, `SeLoadDriverPrivilege` …) as bits in a token | deny ACE beats allow; ordering matters; a privilege check without the privilege fails; keeps the existing one-u32 DACL working as a compatibility form |
| 1.3 | Mandatory Integrity Control (Untrusted/Low/Medium/High/System) with no-write-up | a Low token cannot write to a Medium object even when the DACL allows it |
| 1.4 | Protected processes / PPL (signer levels) | an unprotected caller opening a PPL with `PROCESS_VM_WRITE` is denied even as admin |
| 1.5 | `WaitForMultipleObjects` (wait-any / wait-all), `STATUS_ABANDONED` for mutants, `STATUS_USER_APC` / `STATUS_ALERTED` | all-or-nothing acquisition for wait-all; an owner terminating with a mutant held → the next waiter gets ABANDONED |
| 1.6 | Spinlocks + queued spinlocks, ERESOURCE, pushlocks, fast mutex / guarded mutex | each enforces its IRQL; recursive acquire of a non-recursive lock bugchecks or refuses; shared/exclusive semantics on ERESOURCE and pushlocks |
| 1.7 | Thread scheduling details: quantum reset, foreground boost, priority classes, `KeSetAffinityThread` on N logical processors, idle thread, ideal processor | per-CPU ready queues; affinity is honoured; the starvation boost still works |
| 1.8 | Timers: `KTIMER` with DPC, periodic, high-resolution, timer coalescing (tolerance) | coalesced timers fire in one batch inside the tolerance window |
| 1.9 | Work items / system worker threads (`IoQueueWorkItem`, `ExQueueWorkItem`) | run at PASSIVE; queuing at DISPATCH is allowed, running at DISPATCH is not |
| 1.10 | I/O completion ports + async I/O (`STATUS_PENDING`, `IoMarkIrpPending`, cancel-safe queues) | a pending IRP completes later through the port; cancel races are resolved exactly once |
| 1.11 | ALPC ports (connect / accept / message / reply, port views over sections) | request/reply round trip; the server sees the client token; a closed port fails waiters |
| 1.12 | PnP manager + power IRPs (`IRP_MN_START_DEVICE`, `QUERY_REMOVE`, `REMOVE`, D-states) | the device-node state machine; removal is refused while handles are open |
| 1.13 | Memory manager: PFN database with page lists (free/zeroed/standby/modified/active), working-set trimming, page files (model), copy-on-write sections, VAD tree, large pages, prototype PTEs for shared sections | standby pages are repurposed under pressure; a COW write fault gives a private copy; commit accounting stays exact |
| 1.14 | Pool: tagged pool, pool quota per process, `POOL_NX`, segment heap (model) | double free / bad tag bugchecks `BAD_POOL_CALLER 0xC2`; quota is charged and released |
| 1.15 | Job objects + silos | a job memory limit fails the commit; kill-on-close terminates every member |
| 1.16 | Registry: real hive cells / bins, transactions via KTM, symbolic keys (`CurrentControlSet`), app hives | survives the snapshot round-trip (versioned!); KTM rollback restores values |
| 1.17 | ETW (providers, sessions, ring buffers) | events from the scheduler / IO / MM land in a session buffer that JS can drain |
| 1.18 | Driver Verifier-style checks + richer bugchecks (`DRIVER_IRQL_NOT_LESS_OR_EQUAL 0xD1`, `KMODE_EXCEPTION`, `DRIVER_VERIFIER_DETECTED_VIOLATION 0xC4`) | every rule has a test that provokes it and asserts the code and params |
| 1.19 | Kernel Patch Protection (PatchGuard model) | periodic integrity checks over "critical structures" (dispatch tables, IDT model) → `CRITICAL_STRUCTURE_CORRUPTION 0x109` when one is modified |

## Tier 2: Hyper-V (hypervisor/hv.c, guest/guest.c)

Follow the Hypervisor Top-Level Functional Specification (TLFS).

| # | mechanism | done when |
|---|---|---|
| 2.1 | Real hypercall input format: the 64-bit control word (call code, fast flag, rep count, rep start index), rep hypercalls, `HV_STATUS_*` with the real numbers in a new path | a rep hypercall interrupted by budget returns a partial rep count and resumes; the old 32-byte frame still works (DEVIATION-documented) |
| 2.2 | Partition properties + `HvCallGetPartitionProperty` / `SetPartitionProperty`; partition privilege mask per TLFS | per-partition masks; a child cannot raise its own |
| 2.3 | Memory: deposit/withdraw (`HvCallWithdrawMemory`), GPA mapping with access types, `HvCallGetGpaPagesAccessState` (dirty tracking) | dirty bits are set by guest writes and cleared on query |
| 2.4 | SynIC complete: 16 SINTs, auto-EOI, message pending flag + EOM redelivery, event flags in SIEFP, `HvCallSignalEvent` with connection ids, `HvCallPostMessage` with port ids | a full message slot sets pending; EOM redelivers; masked SINT drops are counted |
| 2.5 | Synthetic timers 0..3 per VP (STIMERn_CONFIG/COUNT MSRs), periodic + one-shot, direct mode | four timers fire independently; with lazy semantics, a missed periodic fire coalesces |
| 2.6 | Reference TSC page (scale/offset, sequence number) | the guest computes time from the page, and it matches TIME_REF_COUNT within tolerance |
| 2.7 | VP registers: full x64 register set by `HV_REGISTER_NAME` via Get/SetVpRegisters | round trip for GPRs, CRs, EFER, segment regs (as data) |
| 2.8 | Virtual APIC / synthetic interrupt controller (EOI, ICR, TPR MSRs 0x40000070-73), IPIs between VPs, `HvCallSendSyntheticClusterIpi`, flush hypercalls (`HvCallFlushVirtualAddressSpace`) | a cross-VP IPI is delivered at that VP's next entry |
| 2.9 | Multi-VP guests + SMP guest scheduling, VP affinity, capping/weight (CPU groups model) | weight changes slice share proportionally within tolerance |
| 2.10 | VMBus protocol: version negotiation (`CHANNELMSG_INITIATE_CONTACT`), offers, GPADL establish/teardown, ring buffers with interrupt masks + pending-send-size, close/rescind | renegotiation after a close; rescind while open → the guest sees it |
| 2.11 | Synthetic devices over VMBus: synthetic keyboard, synthetic video (framebuffer as a GPADL), storvsc-ish block device, netvsc-ish loopback, heartbeat/shutdown/timesync ICs | the integration services show in Hyper-V Manager; a shutdown IC halts the guest cleanly |
| 2.12 | Save/restore & checkpoints (partition state serialised in a versioned format) | restore → identical framebuffer and heartbeat continue |
| 2.13 | Live migration model (pre-copy using dirty tracking between two partitions) | converges; the destination resumes with an identical state hash |

## Tier 3: VBS (needs 0.2, 0.4, 2.1, 2.7). See vbs-vtx.md

| # | mechanism | done when |
|---|---|---|
| 3.1 | VSM capability + VTLs: `HvCallEnablePartitionVtl`, `HvCallEnableVpVtl`, `HvCallVtlCall` / `HvCallVtlReturn`, per-VTL register state, VSM code page | VTL0 cannot read VTL1 registers; enter/return is symmetric; counters per VTL |
| 3.2 | VTL memory protections: `HvCallModifyVtlProtectionMask`, per-VTL R/W/X per GPA page | a VTL0 write to a page VTL1 marked RO → an intercept to VTL1, not a silent success |
| 3.3 | Secure Kernel (VTL1) as a separate guest image with its own state | the normal kernel's requests go through VtlCall only |
| 3.4 | HVCI / memory integrity: W^X enforced by VTL1 via SLAT; code pages become executable only after a "signature" check (model: hash allowlist) | an unsigned page cannot be made X; a page that is X cannot be made W; the attempt is logged and refused |
| 3.5 | Kernel Data Protection (static + dynamic KDP) | a protected region is RO from VTL0 even to the kernel itself |
| 3.6 | Credential Guard / LSAIso as a VTL1 trustlet; IUM trustlets with secure calls | VTL0 gets only a handle/derived blob, never the secret bytes; a test shows a VTL0 memory scan cannot find the secret |
| 3.7 | Secure boot chain + measured boot model (TPM PCR extend, boot log) | changing any "boot component" changes the PCR and VTL1 refuses to unseal |
| 3.8 | HyperGuard / secure-kernel patch protection of critical VTL0 registers (CR0/CR4/MSR intercepts) | VTL0 clearing CR0.WP or CR4.SMEP → intercepted and refused |

## Tier 4: Intel VT-x model (see vbs-vtx.md §3)

| # | mechanism | done when |
|---|---|---|
| 4.1 | Capability MSRs: `IA32_FEATURE_CONTROL` (lock, VMX outside SMX), `IA32_VMX_BASIC`, pin/proc/exit/entry control MSRs with allowed-0/allowed-1 semantics, CPUID.1:ECX.VMX | VMXON without the feature-control lock → #GP(0) modelled as a fault |
| 4.2 | VMXON / VMXOFF, VMCS region with revision id, VMCLEAR / VMPTRLD / VMPTRST, VMREAD / VMWRITE by real field encodings, launch state | VMLAUNCH on a launched VMCS → VMfailValid with error 4 (VMLAUNCH with non-clear VMCS); VMRESUME on a clear one → error 5; bad field → error 12 |
| 4.3 | VM-entry checks (controls, host state, guest state) → VM-entry failure with exit reason 33 / 34 | at least one check per category has a negative test |
| 4.4 | VM exits with real basic exit reasons (0 exception/NMI, 1 ext-int, 10 CPUID, 12 HLT, 18 VMCALL, 28 CR access, 30 I/O, 31 RDMSR, 32 WRMSR, 48 EPT violation, 49 EPT misconfig, 52 preemption timer) + exit qualification | each exit reason is produced by a guest action, and the guest resumes at the right point after the handler |
| 4.5 | EPT: 4-level tables in hypervisor memory, EPTP format (memory type, walk length, A/D enable), R/W/X permissions, EPT violation qualification bits, INVEPT single/global | a misconfigured entry (W without R) → exit 49; A/D bits are set on access |
| 4.6 | VPID + INVVPID; the TLB model (cached translations stay stale until invalidated) | missing INVEPT after remap → the guest observes the stale mapping (yes, really; that's the correct semantics) |
| 4.7 | Interrupt injection (VM-entry interruption info), interrupt-window exiting, posted interrupts | the injection is delivered at the next entry, honouring the guest's IF |
| 4.8 | VMX preemption timer, MSR bitmaps, I/O bitmaps | only bitmapped MSRs exit |
| 4.9 | Nested virtualization: an L1 hypervisor executing VMX instructions → shadow VMCS / VMCS12→VMCS02 merge in L0; enlightened VMCS (Hyper-V's eVMCS) | L2 guest runs; an L2 exit is reflected to L1 only when L1's controls request it |

Map Hyper-V onto VT-x once Tier 4 exists: the existing hypervisor's hypercalls become VMCALL exits (reason 18), MSR accesses become exits 31/32, SLAT becomes EPT, and VTL protections become EPT permission sets per VTL. This mapping is the end goal; don't bolt a second, unrelated "VT-x" next to the hypervisor.
