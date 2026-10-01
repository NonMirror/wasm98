# HV_ABI.md — the NT-style kernel layer and the minimal Hyper-V

Two additions to the existing `kernel.wasm`:

    kernel/nt.c        -> linked into kernel.wasm: the NT-ish executive layer
                          (objects, handles, threads, dispatcher, IRQL, DPC/APC,
                          IRPs, memory manager, tokens, registry hive, bugcheck)
    hypervisor/hv.c    -> web/wasm/hypervisor.wasm: a type-1 style hypervisor
                          (partitions, virtual processors, SLAT, hypercalls,
                          SynIC, synthetic timer, VMBus, CPUID/MSR virtualisation)
    guest/guest.c      -> linked into hypervisor.wasm: the guest image that runs
                          inside a child partition
    web/js/hv.js       -> glue + the `W98.hv` API the desktop uses

Both are freestanding wasm32 images built by `tools/build_kernel.sh`.

---

## 1. NT-style kernel layer (`kernel/nt.c`)

Modelled on the Windows NT design: **everything is an object**, reached through
**handles** held by a process, protected by a **token**, scheduled as
**threads**, deferred to **DPCs/APCs** at an **IRQL**, driven through **IRPs**
by layered drivers, backed by a **memory manager** with sections and a commit
limit, configured by a **hive**.

### 1.1 Object manager

```c
u32 k_obj_create(u32 type, u32 name_ptr, u32 name_len, u32 dacl);
i32 k_obj_ref(u32 obj);            /* +1 reference, returns new count     */
i32 k_obj_deref(u32 obj);          /* -1, deletes at 0                    */
u32 k_obj_type(u32 obj);
u32 k_obj_count(void);             /* live objects                        */
u32 k_obj_field(u32 obj, u32 f);   /* 0 ptr, 1 type, 2 refcount, 3 dacl, 4 name len, 5 name ptr, 6 handles */
```

Types: `1 Process, 2 Thread, 3 File, 4 Key, 5 Section, 6 Event, 7 Mutant,
8 Semaphore, 9 Timer, 10 Driver, 11 Device, 12 Port, 13 VmbusChannel`.

Access bits: `READ 1, WRITE 2, EXEC 4, DELETE 8, ALL 15`.
A DACL is one u32: a granted-access mask plus two flags —
`DACL_PUBLIC 0x10000` (no check), `DACL_SYSTEM_ONLY 0x20000` (token must carry
the `System` privilege).

### 1.2 Handles (per process)

```c
i32 k_handle_open(u32 pid, u32 obj, u32 access);   /* -> handle, negative = error */
i32 k_handle_close(u32 pid, i32 h);
i32 k_handle_dup(u32 pid, i32 h, u32 access);
i32 k_handle_obj(u32 pid, i32 h);                  /* -> object id or negative */
u32 k_handle_count(u32 pid);
u32 k_handle_access(u32 pid, i32 h);
```
`k_handle_open` performs a real access check against the caller's token; a
denied open returns `-5` (`STATUS_ACCESS_DENIED`) and bumps the deny counter.

### 1.3 Security

```c
u32 k_token_create(u32 sid, u32 privileged);   /* privileged: bypasses DACLs */
u32 k_token_of(u32 pid);
i32 k_token_set(u32 pid, u32 token);
i32 k_access_check(u32 token, u32 obj, u32 access);   /* 0 ok, -5 denied */
u32 k_sid_of(u32 token);
```
Tokens have SIDs (`1000 User, 2000 Admin, 3000 System, 4000 Guest`) and a
privilege bit. Counters: grants, denies.

### 1.4 Threads and the scheduler

```c
u32 k_thread_create(u32 pid, u32 priority, u32 name_ptr, u32 name_len);
i32 k_thread_terminate(u32 tid);
u32 k_thread_count(void);
u32 k_thread_field(u32 tid, u32 f);   /* 0 pid 1 state 2 priority 3 base 4 cpu_us
                                         5 waits 6 wait_obj 7 quantum 8 id 9 boosts */
u32 k_thread_ready_index(u32 level);  /* head of the ready queue at a priority */
i32 k_thread_set_priority(u32 tid, u32 prio);
i32 k_thread_boost(u32 tid, u32 amount);
i32 k_thread_wait(u32 tid, u32 obj, u32 timeout_ms, u32 alertable);
i32 k_thread_alert(u32 tid);
```
Priorities 0..31. States: `0 empty, 1 Ready, 2 Running, 3 Waiting, 4 Terminated`.
The ready queue is a bitmask-scanned 32-level structure; `k_tick` picks the
highest-priority ready thread, charges the quantum, and ages (boosts) threads
that have waited too long so they cannot starve.

### 1.5 Dispatcher objects (waits and signals)

```c
u32 k_event_create(u32 manual_reset, u32 initial);
i32 k_event_set(u32 ev);
i32 k_event_reset(u32 ev);
u32 k_mutant_create(u32 owner_tid);
i32 k_mutant_release(u32 m, u32 tid);
u32 k_semaphore_create(u32 initial, u32 limit);
i32 k_semaphore_release(u32 s, u32 count);
i32 k_obj_signal(u32 obj);          /* any dispatcher object */
i32 k_obj_wait_test(u32 obj, u32 tid);
u32 k_wait_count(u32 obj);          /* threads blocked on it */
```
Waiting on a mutant gives **priority inheritance** (the owner is boosted to the
waiter's priority); releasing a semaphore/event wakes the *highest priority*
waiter (not FIFO).

### 1.6 IRQL, DPCs and APCs

```c
u32 k_irql(void);
u32 k_irql_raise(u32 level);        /* returns previous */
u32 k_irql_lower(u32 level);        /* back to level */
u32 k_irql_violations(void);        /* illegal operations attempted */
i32 k_dpc_queue(u32 proc_id, u32 data);
u32 k_dpc_drained(void);
i32 k_apc_queue(u32 tid, u32 proc_id, u32 data, u32 user_mode);
u32 k_apc_pending(void);
u32 k_apc_pop(void);                /* tid<<16 | proc_id, 0 when empty */
```
Levels: `PASSIVE 0, APC 1, DISPATCH 2, DEVICE 3, HIGH 15`.
Operations that must be at `PASSIVE_LEVEL` (paged-pool allocation, waiting with
a timeout) return `-1073741802` (`STATUS_INVALID_DEVICE_REQUEST`) and record a
violation when attempted at `>= DISPATCH_LEVEL`. `k_tick` drains the DPC queue
at `DISPATCH_LEVEL` and hands ready user APCs to JS through `k_apc_pop`.

### 1.7 I/O manager and IRPs

```c
u32 k_driver_create(u32 name_ptr, u32 name_len, u32 dispatch_id, u32 flags);   /* obj type 10 */
u32 k_device_create(u32 driver, u32 name_ptr, u32 name_len, u32 type);         /* obj type 11 */
i32 k_devices_link(u32 device, u32 lower_device);                              /* device stack   */
u32 k_irp_create(u32 device, u32 major, u32 minor, u32 in_len, u32 out_len);
i32 k_io_call_driver(u32 irp);      /* pushes a stack location, dispatches    */
u32 k_io_complete(u32 irp, u32 status, u32 bytes);
u32 k_irp_field(u32 irp, u32 f);    /* 0 status 1 device 2 major 3 minor 4 in_len
                                        5 out_len 6 stack_depth 7 completed 8 bytes */
u32 k_irp_queue_depth(u32 device);
u32 k_io_counts(u32 which);         /* 0 created 1 completed 2 failed 3 stack overflows
                                        4 cancelled 5 queued */
```
Real semantics kept: the per-IRP stack of location entries (max 8; exceeding it
fails the IRP and bumps the overflow counter), a completion routine that may
return `STATUS_MORE_PROCESSING_REQUIRED (0x100000000-ish -> use 0xC0000016)` to
keep ownership, and cancellation.

### 1.8 Memory manager

```c
u32 k_process_create(u32 name_ptr, u32 name_len, u32 token);   /* replaces k_proc_create */
i32 k_process_terminate(u32 pid);
i32 k_vm_reserve(u32 pid, u32 bytes, u32 protect);   /* VAD region, no commit  */
i32 k_vm_commit(u32 pid, u32 vaddr, u32 bytes);
i32 k_vm_free(u32 pid, u32 vaddr, u32 bytes);
i32 k_vm_touch(u32 pid, u32 vaddr);                  /* demand-zero page fault */
u32 k_vm_region_count(u32 pid);
u32 k_vm_field(u32 pid, u32 f);   /* 0 virtual size 1 committed 2 working set
                                      3 page faults 4 regions */
u32 k_section_create(u32 bytes, u32 protect);
i32 k_section_map(u32 pid, u32 section, u32 vaddr);  /* shared memory */
u32 k_pool_alloc(u32 bytes, u32 paged, u32 tag);     /* paged pool needs PASSIVE */
u32 k_pool_field(u32 f);   /* 0 paged used 1 paged peak 2 nonpaged used 3 nonpaged peak */
u32 k_commit_field(u32 f); /* 0 charge 1 limit 2 peak 3 failures */
```
Commit is charged against a limit; exceeding it fails (`-1073741670`,
`STATUS_INSUFFICIENT_RESOURCES`) and bumps the failure counter. Paged-pool work
at `>= DISPATCH_LEVEL` is refused, which is what makes the IRQL tracking matter.

### 1.9 Registry hive

```c
u32 k_reg2_root(u32 hive);                                    /* 0 HKLM 1 HKCU 2 HKCR 3 HKU */
i32 k_reg2_create_key(u32 parent, u32 name_ptr, u32 name_len);
u32 k_reg2_open_key(u32 parent, u32 name_ptr, u32 name_len);
i32 k_reg2_set_value(u32 key, u32 name_ptr, u32 name_len, u32 type, u32 data, u32 len);
i32 k_reg2_get_value(u32 key, u32 name_ptr, u32 name_len);     /* value -> TMP, type/len read back */
u32 k_reg2_value_type(void);
u32 k_reg2_value_len(void);
u32 k_reg2_enum_value(u32 key, u32 idx);                       /* publishes name into TMP-prefixed buf */
u32 k_reg2_enum_key(u32 key, u32 idx);
i32 k_reg2_delete_key(u32 key);                                /* refuses non-empty */
u32 k_reg2_tx_begin(void);
i32 k_reg2_tx_commit(u32 tx);
i32 k_reg2_tx_rollback(u32 tx);
u32 k_reg2_stats(u32 which);   /* 0 keys 1 values 2 depth 3 tx committed 4 tx rolled back */
```
Types: `REG_SZ 1, REG_EXPAND_SZ 2, REG_BINARY 3, REG_DWORD 4, REG_MULTI_SZ 7`.
The **legacy flat `k_reg_*` API keeps working**: `(path, name)` is stored in the
hive as key `path` with value `name`, so nothing in the existing desktop
changes, and the hive is what gets persisted.

### 1.10 Bugcheck

```c
u32 k_bugcheck(u32 code, u32 p1, u32 p2, u32 p3, u32 p4);
u32 k_bugcheck_state(u32 which);   /* 0 code 1..4 params 5 halted 6 count */
u32 k_bugcheck_dump_ptr(void);
u32 k_bugcheck_dump_len(void);
```
A bugcheck halts the scheduler (no thread is dispatched, no DPC drained) and
writes a text "minidump" (loaded drivers, device stack, wait chains, counters)
that the BSOD window shows.

### 1.11 Counters for the UI

`k_stat(idx)` above 100 delegates to `nt_stat(idx - 100)`:
objects, handles, threads per state, ready depth, waits, mutants held,
DPCs queued/drained, APCs queued/delivered, IRPs by outcome, IRQL violations,
commit charge/limit/peak/failures, page faults, pool splits, tokens, access
checks/denies, hive size, bugcheck count, and the scheduler's current thread.

---

## 2. Minimal Hyper-V (`hypervisor/hv.c`)

A type-1 style hypervisor: it owns the machine and the partitions run on top.
It is a separate wasm image with its own linear memory; that memory **is the
machine's physical memory**, and `SLAT` maps guest-physical addresses (GPA)
into it. Everything a partition can touch is validated against SLAT, so a bad
guest access is contained and reported, not tolerated.

### 2.1 Partitions and virtual processors

```c
u32 hv_init(u32 ref_time_ms, u32 max_partitions, u32 max_vps, u32 phys_bytes);
u32 hv_partition_create(u32 name_ptr, u32 name_len);            /* -> partition id */
i32 hv_partition_init(u32 part);                                /* parent=root, child=guest */
i32 hv_partition_start(u32 part);
i32 hv_partition_pause(u32 part);
i32 hv_partition_resume(u32 part);
i32 hv_partition_stop(u32 part);
i32 hv_partition_delete(u32 part);
u32 hv_partition_field(u32 part, u32 f);
u32 hv_partition_count(void);
u32 hv_vp_create(u32 part, u32 index);
u32 hv_vp_field(u32 vp, u32 f);   /* 0 part 1 index 2 state 3 run_ns 4 hypercalls
                                     5 faults 6 instr 7 slice_left 8 preempts */
u32 hv_vp_count(void);
u32 hv_vp_register(u32 vp, u32 which);          /* 0..3 rdx/r8/r9/rip-style */
i32 hv_vp_set_register(u32 vp, u32 which, u32 value);
```
Partition states: `0 empty, 1 created, 2 initialised, 3 running, 4 paused,
5 stopped, 6 faulted, 7 deleted`. Hardware `max_partitions = 8`,
`max_vps = 16`, physical memory 16 MB split into 4 KB pages (a PFN array).

### 2.2 Guest physical memory and SLAT

```c
i32 hv_map_gpa(u32 part, u32 gpa, u32 page_count, u32 flags);   /* flags bit0 writable, bit1 present */
i32 hv_unmap_gpa(u32 part, u32 gpa, u32 page_count);
u32 hv_gpa_state(u32 part, u32 gpa);            /* 0 unmapped 1 mapped 2 ro 3 rw */
u32 hv_read_gpa(u32 part, u32 gpa, u32 dst, u32 len);   /* into hv memory  */
u32 hv_write_gpa(u32 part, u32 gpa, u32 src, u32 len);
u32 hv_slat_faults(u32 part);
u32 hv_page_field(u32 page, u32 f);             /* 0 owner 1 gpa 2 flags 3 mapped_count */
u32 hv_memory_stats(u32 which);  /* 0 total 1 mapped 2 reserved 3 free 4 deposits */
```
`hv_read_gpa`/`hv_write_gpa` are the only ways in and out: JS uses them to read
the guest's framebuffer and to inject keystrokes. A guest access to an unmapped
page inside `hv_vmcall`'s buffer validation produces a SLAT fault: the fault
count rises, the partition state becomes `faulted`, and the hypervisor logs the
GPA.

### 2.3 Hypercalls

The guest writes a call frame into its hypercall page (GPA `0xE000` by
convention here) and calls `hv_vmcall(vp)`. The frame:

```c
struct HvCallFrame {          /* little-endian u32 fields, 32 bytes */
  u32 code;        /* 0  */
  u32 status;      /* 4  */
  u32 in_gpa;      /* 8  input   structure in guest memory */
  u32 out_gpa;     /* 12 output  structure in guest memory */
  u32 arg0;        /* 16 */
  u32 arg1;        /* 20 */
  u32 arg2;        /* 24 */
  u32 arg3;        /* 28 */
};
```

Call codes (the shapes Hyper-V uses; numbers are ours but stable):

| code | name | in | out |
|---|---|---|---|
| 0x0011 | HvCallGetHypervisorInfo | – | vendor, signature, version |
| 0x0012 | HvCallGetReferenceTime | – | ms since boot |
| 0x0013 | HvCallGetVpIndex | – | vp index |
| 0x0040 | HvCallCreatePartition | – | partition id |
| 0x0041 | HvCallInitializePartition | – | status |
| 0x0043 | HvCallDepositMemory | gpa, pages | pages deposited |
| 0x0047 | HvCallCreateVp | index | vp id |
| 0x0050 | HvCallSetVpRegisters | index, value | status |
| 0x0053 | HvCallMapGpaPages | gpa, pages, flags | status |
| 0x005C | HvCallPostMessage | gpa of message | status (SynIC) |
| 0x005D | HvCallSignalEvent | sint, flag | status |
| 0x0060 | HvCallEnableHypercallPage | gpa, msr | status |
| 0x0061 | HvCallVmbusOpenChannel | offer id lo/hi | channel id |
| 0x0062 | HvCallVmbusCloseChannel | channel | status |
| 0x0063 | HvCallVmbusSignal | channel, bytes | status |
| 0x0070 | HvCallQueryMsr | msr | value |
| 0x0071 | HvCallSetMsr | msr, value | status |
| 0x0072 | HvCallCpuid | leaf, subleaf | eax/ebx/ecx/edx |
| 0x0090 | HvCallHalt | – | never returns (partition stopped) |

Status: `0 HV_STATUS_SUCCESS`, `2 HV_STATUS_INVALID_PARAMETER`,
`3 HV_STATUS_ACCESS_DENIED`, `4 HV_STATUS_INSUFFICIENT_MEMORY`,
`5 HV_STATUS_INVALID_PARTITION_STATE`, `6 HV_STATUS_SLAT_FAULT`,
`7 HV_STATUS_NOT_IMPLEMENTED`.

### 2.4 Virtual MSRs and CPUID

| MSR | value | meaning |
|---|---|---|
| 0x40000000 | HV_X64_MSR_GUEST_OS_ID | set by the guest to declare itself |
| 0x40000001 | HV_X64_MSR_HYPERCALL | enable flag + hypercall page GPA |
| 0x40000002 | HV_X64_MSR_VP_INDEX | this VP's index |
| 0x40000020 | HV_X64_MSR_TIME_REF_COUNT | reference time in 100 ns units |
| 0x40000021 | HV_X64_MSR_REFERENCE_TSC | synthetic TSC page GPA |
| 0x40000080 | HV_X64_MSR_SCONTROL | SynIC global enable |
| 0x40000082 | HV_X64_MSR_SIEFP | event flags page GPA |
| 0x40000083 | HV_X64_MSR_SIMP | message page GPA |
| 0x40000084 | HV_X64_MSR_EOM | end of message |
| 0x40000090+n | HV_X64_MSR_SINT0+n | SINT vector + masked |

CPUID: leaf `0x40000000` returns vendor `"Microsoft Hv"` (ebx/ecx/edx) and
`eax = 0x40000004` (max leaf), leaf `0x40000001` returns `"Hv#1"`,
`0x40000002` a version, `0x40000003` the privilege mask, `0x40000004` the
recommendations, `0x40000005` the implementation limits, `0x40000006` the
hardware features. Hypervisor-present bit: CPUID.1.ECX[31].

### 2.5 SynIC, synthetic timer, VMBus

```c
u32 hv_synic_field(u32 vp, u32 which);   /* 0 scontrol 1 simp 2 siefp 3 eom 4 messages
                                             5 dropped 6 events */
u32 hv_sint_field(u32 vp, u32 sint, u32 which);  /* 0 vector 1 masked 2 count */
u32 hv_message_pop(u32 vp, u32 dst, u32 max);    /* drain one SynIC message */
u32 hv_timer_set(u32 vp, u32 sint, u32 period_ms, u32 oneshot);
u32 hv_timer_field(u32 vp, u32 which);  /* 0 fire count 1 last 2 pending */
u32 hv_vmbus_channel_field(u32 ch, u32 f);
u32 hv_vmbus_channel_count(void);
u32 hv_vmbus_drain(u32 ch, u32 dst, u32 max);    /* guest -> root messages */
u32 hv_vmbus_inject(u32 ch, u32 src, u32 len);   /* root -> guest messages */
u32 hv_vmbus_stats(u32 which);
```
SynIC messages are 256 bytes: `{u32 type, u32 size, u32 flags, u8 payload[244]}`.
VMBus ring: in the guest's GPA, `{u32 write, u32 read, u32 bytes, u32 state}`
followed by 4 KB of framed messages `{u32 type, u32 len, u8 data[]}`;
types `1 offer, 2 offer-accepted, 3 gpadl, 4 data, 5 close`. Channels are
created by the hypervisor and offered to the guest.

### 2.6 Scheduling

```c
u32 hv_schedule(u32 elapsed_ms);   /* run VPs for their slices, returns runs */
u32 hv_sched_field(u32 which);     /* 0 slices, 1 preemptions, 2 context switches,
                                      3 idle slices, 4 running vps, 5 quantum_ms */
```
The hypervisor time-slices VPs (10 ms default), a VP runs until it hypercalls,
halts or its slice expires; `hv_schedule` is driven from the desktop heartbeat.

---

## 3. The guest (`guest/guest.c`)

A deliberately small guest kernel (`guest_main(vp)`) that behaves like a real
enlightened guest:

1. reads CPUID `0x40000000` — if the vendor is not `"Microsoft Hv"` it halts;
2. sets `HV_X64_MSR_GUEST_OS_ID = 0x00319831` ("our guest");
3. enables the hypercall page and validates the call frame at `0xE000`;
4. queries the reference time and its VP index;
5. sets `SIMP`/`SIEFP`/`SCONTROL` and unmasks `SINT0`/`SINT2`;
6. sets a 100 ms synthetic timer on `SINT2`;
7. opens the VMBus channel the hypervisor offered and completes the
   offer-accepted handshake in the ring;
8. draws its boot log into the synthetic framebuffer
   (`0x10000`, 400x120, 32bpp) and keeps a heartbeat counter;
9. on each timer interrupt: bumps the heartbeat, drains SynIC messages, writes
   log lines, and posts a "heartbeat" message to the root partition;
10. honours injected commands from the root (`ping`, `log <text>`, `halt`).

Everything it prints is visible in the desktop's VM console window.

---

## 4. The JS surface (`web/js/hv.js`, global `W98HV`)

```js
W98HV.ready                    // Promise, resolves to the hv info object
W98HV.mode                     // 'wasm' | 'none'
W98HV.info()                   // { version, vendor, signature, maxPartitions,
                               //   maxVps, refTimeMs, hypercallCount, slatFaults, moduleBytes }
W98HV.partitions()             // [{ id, name, state, stateName, vps, memoryBytes,
                               //    mappedPages, deposits, hypercalls, faults, runs }]
W98HV.createPartition(name, opts)     // opts { memoryBytes, cpus }  -> id
W98HV.startPartition(id) / pausePartition(id) / resumePartition(id)
W98HV.stopPartition(id) / resetPartition(id) / deletePartition(id)
W98HV.vps()                    // [{ id, partition, index, state, runMs, hypercalls,
                               //    faults, instr, sliceLeft, preempts }]
W98HV.memoryMap(id)            // [{ gpa, pages, mapped, writable, present }]
W98HV.framebuffer(id)          // { gpa, width, height, rgba: Uint8Array } (null if none)
W98HV.synic(id)                // { scontrol, simp, siefp, messages, dropped, sints: [...] }
W98HV.msrLog(id)               // [{ msr, value, write }]  last 32 accesses
W98HV.vmbus()                  // [{ id, offerLo, offerHi, state, stateName, inBytes,
                               //    outBytes, messages, ringGpa }]
W98HV.sendToGuest(id, bytes)   // enqueue a command for the guest
W98HV.onGuestMessage(fn)       // fn({ partition, bytes, text })
W98HV.step(elapsedMs)          // called every desktop heartbeat
W98HV.stats()                  // raw counter object
W98HV.hypervisorLog()          // text log from the hypervisor
```

`W98.hv` (the kernel side) additionally exposes, backed by `nt.c`:

```js
W98.hv.objects() / handles(pid) / threads() / readyQueue()
W98.hv.irpStats() / dpcStats() / apcStats() / irqlState()
W98.hv.memory(pid) / commit() / pool()
W98.hv.registry('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services')
W98.hv.bugcheck()               // { code, params, halted, dump }
W98.hv.checkAccess(pid, obj, access)
```

---

## 5. Acceptance criteria

1. `node tools/kernel_test.mjs` stays green and gains assertions for every
   mechanism in section 1 (objects/handles/denials, priorities and starvation,
   dispatcher waits and inheritance, IRQL refusals, DPC/APC delivery, IRP stack
   overflow and completion, commit-limit failures, hive values and transactions,
   bugcheck).
2. `node tools/hv_test.mjs` drives the hypervisor in isolation: create two
   partitions, map/unmap GPA, provoke a SLAT fault, run hypercalls, check SynIC
   message delivery, VMBus offer/accept/data, synthetic timer firing, MSR/CPUID
   virtualisation, and VP time-slicing.
3. In the browser: the guest boots inside a child partition, its framebuffer is
   visible in the desktop's console window, heartbeat messages reach the root
   partition's VMBus driver, and Hyper-V Manager shows live partition/VP/
   hypercall/SLAT/VMBus state. Pausing the partition freezes its heartbeat.
4. Nothing loads from the network at runtime; the desktop keeps working with
   the hypervisor absent (the manager then says "hypervisor not available").
