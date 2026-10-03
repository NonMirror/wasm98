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

Both are freestanding wasm32 images: `tools/build_kernel.sh` builds the
kernel image and `tools/build_hv.sh` builds the Hyper-V/guest image.

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
u32 k_obj_field(u32 obj, u32 f);   /* 0 ptr, 1 type, 2 refcount, 3 dacl, 4 name len, 5 name ptr, 6 handles, 7 owner SID, 8 DACL ACE count, 9 integrity, 10 PPL signer */
i32 k_obj_create_named(u32 type, u32 name_ptr, u32 name_len, u32 dacl);
i32 k_obj_open_named(u32 name_ptr, u32 name_len, u32 type);
i32 k_obj_link_named(u32 name_ptr, u32 name_len, u32 target);
i32 k_obj_retarget_named(u32 name_ptr, u32 name_len, u32 target);
u32 k_obj_namespace_count(void);
i32 k_obj_set_owner(u32 obj, u32 sid);
i32 k_obj_add_ace(u32 obj, u32 sid, u32 mask, u32 type);
i32 k_obj_clear_aces(u32 obj);
u32 k_obj_owner(u32 obj);
u32 k_obj_ace_count(u32 obj);
i32 k_obj_add_sacl_ace(u32 token, u32 obj, u32 sid, u32 mask, u32 type);
i32 k_obj_security_add_ace(u32 token, u32 obj, u32 sid, u32 mask, u32 type);
i32 k_obj_security_set_owner(u32 token, u32 obj, u32 sid);
i32 k_obj_set_integrity(u32 obj, u32 level);
u32 k_obj_integrity(u32 obj);
u32 k_token_integrity(u32 token);
i32 k_token_set_integrity(u32 token, u32 level);
i32 k_obj_security_set_integrity(u32 token, u32 obj, u32 level);
u32 k_obj_protection(u32 obj);
i32 k_obj_set_protection(u32 obj, u32 signer);
u32 k_token_signer(u32 token);
i32 k_token_set_signer(u32 token, u32 signer);
i32 k_obj_security_set_protection(u32 token, u32 obj, u32 signer);
u32 k_access_map_generic(u32 access);
```

Types: `1 Process, 2 Thread, 3 File, 4 Key, 5 Section, 6 Event, 7 Mutant,
8 Semaphore, 9 Timer, 10 Driver, 11 Device, 12 Port, 13 VmbusChannel`.

Access bits: `READ 1, WRITE 2, EXEC 4, DELETE 8, ALL 15`.
A DACL is one u32: a granted-access mask plus two flags —
`DACL_PUBLIC 0x10000` (no check), `DACL_SYSTEM_ONLY 0x20000` (token must carry
the `System` privilege).

Named objects use the NT namespace roots `\`, `\Device`,
`\BaseNamedObjects`, `\Sessions\N`, and `\GLOBAL??`. The `\??` alias is
normalized to `\GLOBAL??`. Named create returns
`STATUS_OBJECT_NAME_COLLISION` for an existing name; open returns
`STATUS_OBJECT_NAME_NOT_FOUND` for a missing name and follows symbolic links
with an eight-link limit, returning `STATUS_REPARSE` for a loop. The legacy
unnamed object API remains unchanged.

### 1.2 Handles (per process)

```c
i32 k_handle_open(u32 pid, u32 obj, u32 access);   /* -> handle, negative = error */
i32 k_handle_close(u32 pid, i32 h);
i32 k_handle_dup(u32 pid, i32 h, u32 access);
i32 k_handle_obj(u32 pid, i32 h);                  /* -> object id or negative */
u32 k_handle_count(u32 pid);
u32 k_handle_access(u32 pid, i32 h);
```
Handle values use the low byte for the per-process table slot and the upper
bits for a generation sequence. The first allocation in a slot retains its
legacy value (`1..48`); after close, reusing that slot produces a new value and
all operations with the stale value fail.
`k_handle_open` performs a real access check against the caller's token; a
denied open returns `-5` (`STATUS_ACCESS_DENIED`) and bumps the deny counter.

### 1.3 Security

```c
u32 k_token_create(u32 sid, u32 privileged);   /* privileged: bypasses DACLs */
u32 k_token_of(u32 pid);
i32 k_token_set(u32 pid, u32 token);
i32 k_token_set_privileges(u32 token, u32 privileges);
u32 k_token_privileges(u32 token);
u32 k_token_has_privilege(u32 token, u32 privilege);
i32 k_privilege_check(u32 token, u32 privilege);
i32 k_access_check(u32 token, u32 obj, u32 access);   /* 0 ok, -5 denied */
u32 k_sid_of(u32 token);
```
Tokens have SIDs (`1000 User, 2000 Admin, 3000 System, 4000 Guest`) and a
privilege mask. `TOKEN_PRIV_DEBUG` bypasses discretionary checks,
`TOKEN_PRIV_SECURITY` permits security-descriptor administration, and
`TOKEN_PRIV_SYSTEM` satisfies `DACL_SYSTEM_ONLY`. Passing a non-zero
`privileged` argument to `k_token_create` grants all three bits and preserves
the legacy DACL-bypass behavior. `k_token_set_privileges` replaces the mask;
the query helpers expose the resulting bits.

Objects retain the compact legacy DACL (`ACCESS_*` grants plus
`DACL_PUBLIC`/`DACL_SYSTEM_ONLY`) and can additionally carry a fixed ordered
security descriptor:

```c
i32 k_obj_set_owner(u32 obj, u32 sid);                    /* 0 or NTSTATUS */
i32 k_obj_add_ace(u32 obj, u32 sid, u32 mask, u32 type);  /* ACE_ALLOW/DENY */
i32 k_obj_clear_aces(u32 obj);
u32 k_obj_owner(u32 obj);
u32 k_obj_ace_count(u32 obj);
```

An ACE matches its SID or `ACE_EVERYONE`. Entries are evaluated in insertion
order, an explicit deny wins as soon as it overlaps the requested access, and
matching allows accumulate until all requested bits are present. An object
with ACEs no longer treats `DACL_PUBLIC` as an unconditional bypass; without
ACEs the legacy DACL behavior remains unchanged. Invalid objects, masks, or
ACE types return `STATUS_INVALID_PARAMETER`; counters at indices 30, 31, and
50 report checks, denies, and grants.

`ACE_AUDIT_SUCCESS`, `ACE_AUDIT_FAILURE`, and `ACE_AUDIT_BOTH` are SACL-only
types. Adding one requires `TOKEN_PRIV_SECURITY` (the model of
`SeSecurityPrivilege`); matching successful and failed checks increment the
audit counters at indices 51 and 52. `k_obj_security_add_ace` requires
`WRITE_DAC`, while `k_obj_security_set_owner` accepts the owner SID or
`TOKEN_PRIV_TAKE_OWNERSHIP`. `k_access_map_generic` expands the four generic
rights into the compact object rights plus the standard control rights used by
the model. `TOKEN_PRIV_DEBUG`, `TOKEN_PRIV_SECURITY`, `TOKEN_PRIV_SYSTEM`,
`TOKEN_PRIV_LOAD_DRIVER`, and `TOKEN_PRIV_TAKE_OWNERSHIP` are the supported
privilege bits; a failed `k_privilege_check` returns
`STATUS_PRIVILEGE_NOT_HELD`.

Integrity labels are `IL_UNTRUSTED 0`, `IL_LOW 1`, `IL_MEDIUM 2`, `IL_HIGH 3`,
and `IL_SYSTEM 4`. New tokens default to Medium (High for the Admin SID,
System for the System SID, Low for Guest); objects default to Medium. The
mandatory integrity check runs before DACL evaluation: a token below the
object label may read or execute, but any write, delete, owner, or DACL change
returns `STATUS_ACCESS_DENIED`, even when the DACL allows it. The direct label
setter is used by the model's policy setup; `k_obj_security_set_integrity`
requires `WRITE_DAC` for callers following the security boundary.

Protected-process-light signer levels are `PPL_NONE 0`, `PPL_AUTHENTICODE 1`,
`PPL_CODEGEN 2`, `PPL_ANTIMALWARE 3`, `PPL_LSA 4`, and `PPL_WINDOWS 5`.
Tokens inherit a signer from their SID (ordinary users are Authenticode,
Administrators CodeGen, and System Windows) and can be adjusted by the model
setup API. A protected object refuses execute or write/delete access from a
token with a lower signer, before DACL or SeDebugPrivilege evaluation;
read-only opens remain possible. `k_obj_security_set_protection` requires
`WRITE_DAC`.

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
i32 k_thread_set_affinity(u32 tid, u32 mask);
u32 k_thread_affinity(u32 tid);
i32 k_thread_set_ideal_processor(u32 tid, u32 cpu);
u32 k_thread_ideal_processor(u32 tid);
u32 k_thread_processor(u32 tid);
u32 k_cpu_ready_index(u32 cpu, u32 level);
u32 k_scheduler_cpu(void);
i32 k_scheduler_set_cpu(u32 cpu);
i32 k_process_set_priority_class(u32 pid, u32 class_id);
u32 k_process_priority_class(u32 pid);
```
Priorities 0..31. States: `0 empty, 1 Ready, 2 Running, 3 Waiting, 4 Terminated`.
The ready queue is a bitmask-scanned 32-level structure; `k_tick` picks the
highest-priority ready thread, charges the quantum, and ages (boosts) threads
that have waited too long so they cannot starve.

There are four deterministic logical CPUs. Each thread starts with an
all-processor affinity mask; `k_thread_set_affinity` rejects an empty or
out-of-range mask, and the tick picker skips ready threads that do not include
the selected CPU. `k_scheduler_set_cpu` selects that CPU for the next tick,
while ideal-processor and actual-processor fields are observable through the
thread helpers. Priority classes 0..4 are stored per process and are rejected
outside that range.

### 1.8 Kernel timers

```c
u32 k_timer_set(u32 pid, u32 interval_ms, u32 oneshot);
i32 k_timer_set_ex(u32 pid, u32 interval_ms, u32 oneshot, u32 dpc_id,
                   u32 tolerance_ms, u32 high_res);
i32 k_timer_set_tolerance(u32 timer, u32 tolerance_ms);
u32 k_timer_field(u32 timer, u32 field); /* 0 used, 1 pid, 2 interval, 3 deadline,
                                            4 oneshot, 5 DPC, 6 tolerance,
                                            7 high-resolution, 8 fires, 9 coalesced */
```

The existing one-shot and periodic timer ABI remains unchanged. Extended
timers optionally queue a DPC when they fire, carry a high-resolution marker,
and may fire early within their tolerance window so neighboring expirations
are delivered in one tick batch. Periodic timers retain their phase and cap
catch-up work at four expirations per heartbeat.

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
i32 k_wait_multiple(u32 tid, u32 list_ptr, u32 count, u32 wait_type,
                    u32 timeout_ms, u32 alertable);
u32 k_wait_result(u32 tid);         /* STATUS_* result of the last wait */
```
Waiting on a mutant gives **priority inheritance** (the owner is boosted to the
waiter's priority); releasing a semaphore/event wakes the *highest priority*
waiter (not FIFO).

`WAIT_ANY` is 0 and `WAIT_ALL` is 1. `k_wait_multiple` accepts at most eight
object IDs from the wasm array at `list_ptr`. A wait-all reserves every object
and commits acquisition atomically; a wait-any removes the thread from all
other wait lists when one object wakes it. A terminated mutant owner marks the
mutant abandoned, so the next waiter receives `STATUS_ABANDONED` (`0x80`).
Alertable waits return `STATUS_USER_APC` (`0xC0`) when an APC arrives and
`STATUS_ALERTED` (`0x101`) when `k_thread_alert` is called. A timed wait records
`STATUS_TIMEOUT` (`0x102`) in `k_wait_result`; the initial call still returns
the legacy still-waiting status while the thread is blocked.

### 1.6 Synchronization primitives

```c
i32 k_lock_create(u32 type);
i32 k_lock_acquire(u32 lock, u32 tid, u32 mode);
i32 k_lock_release(u32 lock, u32 tid, u32 mode);
u32 k_lock_field(u32 lock, u32 field); /* 0 type, 1 held, 2 owner, 3 shared count,
                                          4 recursion, 5 refusals, 6 acquires, 7 saved IRQL */
i32 k_spinlock_create(void);
i32 k_spinlock_acquire(u32 lock, u32 tid);
i32 k_spinlock_release(u32 lock, u32 tid);
i32 k_pushlock_create(void);
i32 k_pushlock_acquire(u32 lock, u32 tid, u32 exclusive);
i32 k_pushlock_release(u32 lock, u32 tid, u32 exclusive);
```

`LOCK_SPIN` and `LOCK_QUEUED_SPIN` are exclusive and raise IRQL to DISPATCH;
release restores the saved level. `LOCK_ERESOURCE` and `LOCK_PUSHLOCK` support
shared and exclusive modes, while `LOCK_FAST_MUTEX` and `LOCK_GUARDED_MUTEX`
are exclusive and require PASSIVE_LEVEL. A conflicting acquisition returns
`STATUS_RESOURCE_IN_USE`; a recursive acquisition of a non-recursive lock
returns `STATUS_RECURSIVE_LOCK`; an unowned release returns
`STATUS_ACCESS_DENIED`. Every refusal is counted in field 5, and no call
blocks the browser thread.

### 1.7 Work items and system workers

```c
i32 k_work_queue(u32 proc_id, u32 data);
i32 k_work_drain(void);
u32 k_work_pending(void);
u32 k_work_field(u32 work, u32 field); /* 0 queued, 1 process, 2 data, 3 run IRQL, 4 runs */
```

`k_work_queue` is legal at PASSIVE or DISPATCH and returns a bounded work-item
ID. `k_work_drain` models the system worker thread at PASSIVE_LEVEL; invoking
it at a raised IRQL returns `STATUS_INVALID_DEVICE_REQUEST` and records the
IRQL violation. Each queued item runs once, records run IRQL zero, and is
removed from the pending set.

### 1.8 IRQL, DPCs and APCs

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
i32 k_io_cancel(u32 irp);
u32 k_irp_field(u32 irp, u32 f);    /* 0 status 1 device 2 major 3 minor 4 in_len
                                        5 out_len 6 stack_depth 7 completed 8 bytes */
u32 k_irp_queue_depth(u32 device);
u32 k_io_counts(u32 which);         /* 0 created 1 completed 2 failed 3 stack overflows
                                        4 cancelled 5 queued */
i32 k_device_open(u32 device);
i32 k_device_close(u32 device);
i32 k_pnp_start(u32 device);
i32 k_pnp_query_remove(u32 device);
i32 k_pnp_cancel_remove(u32 device);
i32 k_pnp_remove(u32 device);
i32 k_pnp_set_power(u32 device, u32 state);
u32 k_pnp_field(u32 device, u32 field); /* 0 PnP state, 1 power, 2 opens,
                                            3 starts, 4 query-removes, 5 removes */
```

I/O completion ports add bounded asynchronous delivery:

```c
i32 k_iocp_create(u32 concurrency);
i32 k_iocp_associate(u32 port, u32 device, u32 key);
i32 k_iocp_post(u32 port, u32 key, u32 bytes, u32 status, u32 irp);
i32 k_iocp_get(u32 port, u32 timeout_ms); /* packet id or STATUS_TIMEOUT */
u32 k_iocp_field(u32 port, u32 field);     /* 0 pending, 1 posts, 2 gets,
                                              3 last key, 4 bytes, 5 status, 6 IRP */
u32 k_iocp_packet_field(u32 packet, u32 field); /* 0 port, 1 key, 2 bytes, 3 status, 4 IRP */
i32 k_irp_associate_completion(u32 irp, u32 port, u32 key);
i32 k_io_mark_pending(u32 irp);
```

An IRP associated with a port posts exactly one packet when it completes;
repeated completion or cancellation attempts leave the original packet intact.
`k_io_mark_pending` preserves `STATUS_PENDING`, while `k_iocp_get` returns
`STATUS_TIMEOUT` when the bounded queue is empty. A device association rejects
IRPs for a different device, and a full packet arena returns
`STATUS_INSUFFICIENT_RESOURCES`.

Device nodes use `PNP_ADDED`, `PNP_STARTED`, `PNP_QUERY_REMOVE`, and
`PNP_REMOVED` states. `k_pnp_start` handles the start transition,
`k_pnp_query_remove` refuses while `k_device_open` handles are present, and
`k_pnp_remove` commits removal only after a successful query. A canceled query
returns to Started. Power states `POWER_D0` through `POWER_D3` are accepted
only for started nodes; IRPs sent to a removed node return
`STATUS_DELETE_PENDING`.

### 1.11 ALPC ports

```c
i32 k_alpc_create(u32 owner_pid, u32 max_messages);
i32 k_alpc_connect(u32 client, u32 server);
i32 k_alpc_accept(u32 server, u32 client);
i32 k_alpc_close(u32 port);
i32 k_alpc_send(u32 port, u32 token, u32 data_ptr, u32 data_len, u32 section);
i32 k_alpc_receive(u32 port, u32 timeout_ms); /* message id or STATUS_TIMEOUT/PORT_CLOSED */
i32 k_alpc_reply(u32 port, u32 message, u32 status);
i32 k_alpc_message_release(u32 message);
u32 k_alpc_field(u32 port, u32 field); /* 0 owner, 1 peer, 2 connected, 3 closed,
                                          4 queued, 5 sent, 6 received */
u32 k_alpc_message_field(u32 message, u32 field); /* 0 sender, 1 token, 2 len,
                                                     3 section, 4 reply-to, 5 status,
                                                     6 data ptr */
```

Ports have bounded message queues. A connect/accept pair links a client and
server; sends enqueue on the peer and copy at most 128 bytes. Each message
records the client token, optional section view, and reply target, so the
server can inspect the caller's identity and reply exactly once. A closed port
rejects new sends and returns `STATUS_PORT_CLOSED`; an empty open port returns
`STATUS_TIMEOUT`.

Real semantics kept: the per-IRP stack of location entries (max 8; exceeding it
fails the IRP and bumps the overflow counter), a completion routine that may
return `STATUS_MORE_PROCESSING_REQUIRED (0x100000000-ish -> use 0xC0000016)` to
keep ownership, and cancellation.

### 1.8 Memory manager

```c
u32 k_process_create(u32 name_ptr, u32 name_len, u32 token);   /* replaces k_proc_create */
i32 k_process_terminate(u32 pid);
i32 k_vm_reserve(u32 pid, u32 bytes, u32 protect);   /* VAD region, no commit  */
i32 k_vm_reserve_large(u32 pid, u32 bytes, u32 protect); /* 2 MiB large-page VAD */
i32 k_vm_commit(u32 pid, u32 vaddr, u32 bytes);
i32 k_vm_free(u32 pid, u32 vaddr, u32 bytes);
i32 k_vm_touch(u32 pid, u32 vaddr);                  /* demand-zero page fault */
u32 k_vm_region_field(u32 pid, u32 vaddr, u32 field); /* 0 large, 1 paged out, 2 prototype */
u32 k_vm_region_count(u32 pid);
u32 k_vm_field(u32 pid, u32 f);   /* 0 virtual size 1 committed 2 working set
                                      3 page faults 4 regions */
i32 k_mm_trim(u32 pid, u32 pages);
i32 k_mm_reclaim(u32 pages);
u32 k_mm_pfn_field(u32 state);     /* PFN_FREE, ZEROED, STANDBY, MODIFIED, ACTIVE */
i32 k_mm_pageout(u32 pid, u32 vaddr);
i32 k_mm_pagein(u32 pid, u32 vaddr);
u32 k_mm_pagefile_field(u32 field); /* 0 slots, 1 page-outs, 2 page-ins, 3 failures */
u32 k_section_create(u32 bytes, u32 protect);
i32 k_section_create_ex(u32 bytes, u32 protect, u32 copy_on_write);
i32 k_section_set_cow(u32 section, u32 enabled);
i32 k_section_set_prototype(u32 section, u32 enabled);
i32 k_section_map(u32 pid, u32 section, u32 vaddr);  /* shared memory */
i32 k_vm_cow_write(u32 pid, u32 vaddr);
i32 k_vm_prototype_fault(u32 pid, u32 vaddr);
u32 k_pool_alloc(u32 bytes, u32 paged, u32 tag);     /* paged pool needs PASSIVE */
u32 k_pool_alloc_for(u32 pid, u32 bytes, u32 paged, u32 tag);
i32 k_pool_free(u32 ptr, u32 tag);
i32 k_pool_set_nx(u32 ptr, u32 nx);
u32 k_pool_is_nx(u32 ptr);
i32 k_pool_set_quota(u32 pid, u32 bytes);
u32 k_pool_quota(u32 pid);
u32 k_pool_charge(u32 pid);
u32 k_pool_field(u32 f);   /* 0 paged used 1 paged peak 2 nonpaged used 3 nonpaged peak,
                              4 live allocations 5 bad frees 6 quota failures 7 NX blocks */
i32 k_segment_heap_create(u32 pid, u32 initial_bytes, u32 maximum_bytes, u32 flags);
u32 k_segment_heap_alloc(u32 heap, u32 bytes, u32 tag);
i32 k_segment_heap_free(u32 ptr, u32 tag);
i32 k_segment_heap_destroy(u32 heap);
u32 k_segment_heap_field(u32 heap, u32 f); /* 0 owner 1 initial 2 maximum 3 reserved,
                                              4 committed 5 live 6 allocs 7 frees,
                                              8 segments 9 failures 10 flags 11 closed */
u32 k_commit_field(u32 f); /* 0 charge 1 limit 2 peak 3 failures */
```
Commit is charged against a limit; exceeding it fails (`-1073741670`,
`STATUS_INSUFFICIENT_RESOURCES`) and bumps the failure counter. Paged-pool work
at `>= DISPATCH_LEVEL` is refused, which is what makes the IRQL tracking matter.

Pool allocations carry a tag, owner PID, and `POOL_NX` executable policy. A
quota is charged before allocation and released on `k_pool_free`; an invalid
pointer, double free, or tag mismatch returns `STATUS_BAD_POOL_CALLER` and
increments field 5. This is the bounded model of tagged pool accounting and
`POOL_NX`; the backing arena remains fixed.

Segment heaps model the NT segment-heap path separately from tagged pool. Each
heap starts with one bounded segment, grows in 64 KiB (or request-sized)
segments up to its maximum, and uses a fixed 512 KiB arena. Allocations are
16-byte aligned, split free blocks, and coalesce adjacent frees. The heap
records reserved versus committed bytes, live allocations, growth segments,
tags, and allocation failures. A wrong tag, interior pointer, or double free
returns `STATUS_BAD_POOL_CALLER`; destroying a heap with live blocks returns
`STATUS_RESOURCE_IN_USE`. The arena is intentionally finite, so both maximum
size and global segment capacity refusals remain testable.

### 1.15 Jobs and silos

```c
i32 k_job_create(u32 parent, u32 memory_limit, u32 kill_on_close, u32 silo);
i32 k_job_assign(u32 job, u32 pid);
i32 k_job_set_limit(u32 job, u32 memory_limit);
i32 k_job_close(u32 job);
u32 k_job_field(u32 job, u32 field); /* 0 parent, 1 members, 2 limit, 3 charge,
                                        4 kill-on-close, 5 silo, 6 closed */
```

Jobs provide a bounded process-membership list and optional silo marker.
`memory_limit` is charged by every member's VM commit; a commit that would
cross it returns `STATUS_JOB_LIMIT` before changing global accounting. Closing
a kill-on-close job terminates each member and detaches all others; a closed
job rejects new assignments.

The PFN database tracks bounded `PFN_FREE`, `PFN_ZEROED`, `PFN_STANDBY`,
`PFN_MODIFIED`, and `PFN_ACTIVE` lists. Commit takes active frames; trimming
moves a process's committed frames to standby, and reclaim repurposes standby
frames as free. `k_mm_pageout` moves an owned active frame into a bounded
page-file slot and `k_mm_pagein` restores it; both operations are counted and
refuse invalid or unavailable frames. `k_vm_reserve_large` requires 2 MiB
alignment and marks a large-page VAD. Copy-on-write sections are created with
`k_section_create_ex(..., copy_on_write=1)`: a write through a mapped shared
region returns a private active frame and increments that section's COW-fault
counter, while a second write to the same mapping is a no-op. Prototype-PTE
sections use `k_section_set_prototype`; the first
`k_vm_prototype_fault` materialises a shared prototype frame and subsequent
faults reuse it.

### 1.16 Registry hive

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
u32 k_reg2_cell_field(u32 key, u32 field); /* 0 cell offset, 1 bin offset, 2 cell size, 3 flags */
i32 k_reg2_link_key(u32 parent, u32 name_ptr, u32 name_len, u32 target);
i32 k_reg2_create_app_hive(u32 name_ptr, u32 name_len);
u32 k_reg2_app_hive_root(u32 hive);
u32 k_reg2_app_hive_field(u32 hive, u32 field); /* 0 root, 1 version, 2 cells, 3 closed */
```
Types: `REG_SZ 1, REG_EXPAND_SZ 2, REG_BINARY 3, REG_DWORD 4, REG_MULTI_SZ 7`.
The **legacy flat `k_reg_*` API keeps working**: `(path, name)` is stored in the
hive as key `path` with value `name`, so nothing in the existing desktop
changes, and the hive is what gets persisted.

The hive assigns each key a stable cell and bin location, exposed by
`k_reg2_cell_field`; this is the bounded equivalent of CM hive cells/bins.
Snapshot headers are `KREG3` going forward, while the loader accepts KREG1 and
KREG2. Link keys resolve to their target with a depth limit, and
`k_reg2_create_app_hive` creates a versioned application hive rooted outside
the four built-in hives. App hives and links are part of the snapshot model.

### 1.17 ETW

```c
i32 k_etw_register_provider(u32 name_ptr, u32 name_len);
i32 k_etw_start_session(u32 name_ptr, u32 name_len, u32 capacity);
i32 k_etw_enable_provider(u32 session, u32 provider, u32 level, u32 keywords);
i32 k_etw_write(u32 provider, u32 event_id, u32 level, u32 keywords,
                u32 data, u32 len, u32 tid);
u32 k_etw_drain(u32 session, u32 max_events);
u32 k_etw_event_field(u32 session, u32 field);
u32 k_etw_event_ptr(void);
u32 k_etw_event_len(void);
```

ETW providers and sessions are bounded. A session is a ring buffer with loss
accounting; provider enablement filters by level and keyword mask.
`k_etw_drain` publishes each event's provider, id, level, timestamp, thread,
and payload through `k_etw_event_field`/`k_etw_event_ptr`. The scheduler, I/O
manager, and memory manager emit events through the same path.

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

### 1.18 Driver Verifier and richer bugchecks

```c
i32 k_verifier_enable(u32 driver, u32 rules); /* IRQL, pool, I/O, handle */
i32 k_verifier_check(u32 driver, u32 rule, u32 p1, u32 p2, u32 p3, u32 p4);
u32 k_verifier_field(u32 driver, u32 field);  /* 0 rules, 1 violations,
                                                  2 last code, 3..6 params */
```

An enabled rule turns a provoked contract violation into the corresponding
Windows verifier stop: `0xD1 DRIVER_IRQL_NOT_LESS_OR_EQUAL`, `0x1E
KMODE_EXCEPTION`, or `0xC4 DRIVER_VERIFIER_DETECTED_VIOLATION`. The driver
records the violation and all four bugcheck parameters.

### 1.19 Kernel Patch Protection

```c
i32 k_patchguard_enable(u32 interval_ms);
u32 k_patchguard_tick(u32 now_ms);
i32 k_patchguard_corrupt(u32 driver, u32 dispatch_id); /* test/model hook */
u32 k_patchguard_field(u32 field); /* enabled, checks, interval, baseline,
                                      last hash */
```

PatchGuard periodically hashes the bounded dispatch-table/IDT model. A change
detected at the next interval bugchecks with `0x109
CRITICAL_STRUCTURE_CORRUPTION`; the normal timer path remains deterministic
because callers supply `now_ms`.

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
u32 hv_partition_field(u32 part, u32 f); /* 16 privilege mask low, 17 high */
u32 hv_partition_id_at(u32 slot);       /* slot 0..7 -> current generation-tagged id */
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

Partition field 16 is the low 32 bits and field 17 the high 32 bits of the
partition's `HV_PARTITION_PRIVILEGE_MASK`. CPUID leaf `0x40000003` returns the
same halves in EAX and EBX. The root partition receives the host privileges;
child partitions receive only guest-facing privileges (`AccessVpRunTimeReg`,
`AccessPartitionReferenceCounter`, `AccessSynicRegs`,
`AccessSyntheticTimerRegs`, `AccessIntrCtrlRegs`, `AccessHypercallMsrs`,
`AccessVpIndex`, `AccessPartitionReferenceTsc`, `PostMessages`, and
`SignalEvents`). A child invoking `HvCallCreatePartition`,
`HvCallDepositMemory`, `HvCallMapGpaPages`, or `HvCallCreateVp` is refused with
`HV_STATUS_ACCESS_DENIED` before any state or memory changes.

Partition IDs use the low byte for the table slot and the upper bits for a
generation sequence. `hv_partition_id_at` is the supported enumeration path;
after delete and reuse, the old ID is rejected by every partition API.

### 2.2 Guest physical memory and SLAT

```c
i32 hv_map_gpa(u32 part, u32 gpa, u32 page_count, u32 flags);   /* bit0 W, bit1 R/present, bit2 X */
i32 hv_unmap_gpa(u32 part, u32 gpa, u32 page_count);
u32 hv_gpa_state(u32 part, u32 gpa);            /* 0 unmapped 1 mapped 2 ro 3 rw */
u32 hv_read_gpa(u32 part, u32 gpa, u32 dst, u32 len);   /* into hv memory  */
u32 hv_write_gpa(u32 part, u32 gpa, u32 src, u32 len);
u32 hv_slat_faults(u32 part);
u32 hv_probe_execute_gpa(u32 part, u32 gpa);     /* guest execute permission check */
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
| 0x0044 | HvCallWithdrawMemory | host PFN | status |
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
hardware features. For `0x40000003`, EAX is the low mask and EBX is the high
mask; the values are selected for the partition that issued CPUID.
Hypervisor-present bit: CPUID.1.ECX[31].

### 2.5 SynIC, synthetic timer, VMBus

```c
u32 hv_synic_field(u32 vp, u32 which);   /* 0 scontrol 1 simp 2 siefp 3 eom 4 messages
                                             5 dropped 6 events 7 queue depth
                                             8 pending SINTs 9 event flags
                                             10 message pending */
u32 hv_sint_field(u32 vp, u32 sint, u32 which);  /* 0 vector 1 masked 2 count 3 auto-EOI 4 dropped */
u32 hv_synic_event_field(u32 vp, u32 flag);
u32 hv_synic_event_clear(u32 vp, u32 flag);
u32 hv_message_pop(u32 vp, u32 dst, u32 max);    /* drain one SynIC message */
u32 hv_timer_set(u32 vp, u32 sint, u32 period_ms, u32 oneshot);
u32 hv_timer_field(u32 vp, u32 which);  /* 0 fire count 1 last 2 pending */
u32 hv_vmbus_channel_field(u32 ch, u32 f);
u32 hv_vmbus_channel_count(void);
u32 hv_vmbus_channel_id_at(u32 slot); /* slot 0..15 -> current generation-tagged id */
u32 hv_vmbus_drain(u32 ch, u32 dst, u32 max);    /* guest -> root messages */
u32 hv_vmbus_inject(u32 ch, u32 src, u32 len);   /* root -> guest messages */
u32 hv_vmbus_stats(u32 which);
```
Channel IDs use the same slot-plus-generation encoding as partition IDs;
`hv_vmbus_channel_id_at` enumerates live channels and stale IDs fail lookup
after a channel is closed and its slot is reused.
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

### 2.7 TLFS control words and partition properties

```c
u32 hv_hypercall_control(u32 vp, u32 control_lo, u32 control_hi,
                         u32 in_gpa, u32 out_gpa, u32 arg0, u32 arg1,
                         u32 arg2, u32 arg3);
u32 hv_rep_field(u32 vp, u32 field); /* completed, total, active, status */
u32 hv_partition_get_property(u32 part, u32 property);
i32 hv_partition_set_property(u32 part, u32 property, u32 value);
```

The control word uses bits 0..15 for the call code, bit 16 for the fast-call
flag, and `control_hi` low/high 16-bit halves for repetition count/index. A
repetition is budgeted and returns `HV_STATUS_REP_NOT_COMPLETE` with progress
available through `hv_rep_field`; resubmitting the same word resumes it. The
legacy 32-byte frame remains supported. Partition properties include privilege
halves, weight, and a VTL capability; children cannot raise their own mask.

`hv_withdraw_memory(part, pfn)` returns an un-mapped deposited host page to the
pool. A mapped page or a page owned by another partition is refused.

### 2.8 Dirty GPA access and complete SynIC

```c
u32 hv_gpa_access_state(u32 part, u32 gpa, u32 page_count, u32 dst);
u32 hv_synic_eom(u32 vp);
u32 hv_signal_event(u32 part, u32 connection, u32 flag);
u32 hv_post_message(u32 part, u32 port, u32 src, u32 len);
```

Guest writes set per-page dirty bits. `hv_gpa_access_state` returns one byte
per page and clears the bits after reporting. Each VP has all 16 SINTs; a full
slot increments the pending flag and EOM redelivers a pending interrupt. Masked
SINT delivery is counted and connection/port signalling is validated. Event
flags are visible through `hv_synic_event_field` and explicitly acknowledged
with `hv_synic_event_clear`; direct synthetic timers post their vector through
the VP interrupt path instead of the message path.

### 2.9 Synthetic timers and reference TSC

```c
u32 hv_timer_set_n(u32 vp, u32 timer, u32 sint, u32 period_ms, u32 oneshot);
u32 hv_timer_n_set_direct(u32 vp, u32 timer, u32 direct);
u32 hv_timer_n_field(u32 vp, u32 timer, u32 field);
i32 hv_reference_tsc_set(u32 vp, u32 sequence, u32 scale, u32 offset_lo, u32 offset_hi);
u32 hv_reference_tsc_read(u32 vp, u32 dst); /* sequence, value_lo, value_hi */
```

Timers 0..3 are independent; periodic timers coalesce missed periods into one
pending interrupt. The reference-TSC page carries a sequence, scale, and
split offset, the guest maps and evaluates that page during boot, and the read
path derives time from `TIME_REF_COUNT`.

### 2.10 VP registers, APIC/IPI and SMP weights

`hv_vp_register`/`hv_vp_set_register` accept register names 0..31 (GPRs, CRs,
EFER, and segment state represented as data). `hv_send_ipi`, `hv_apic_field`,
and `hv_apic_eoi` model the synthetic APIC ICR/TPR/EOI path. The bounded
`hv_flush_virtual_address_space` API invalidates the cached translations for
all VPs in a partition. `hv_partition_set_weight` and the partition weight
property bias the deterministic VP picker.

### 2.11 VMBus protocol and synthetic devices

```c
u32 hv_vmbus_negotiate(u32 ch, u32 version);
u32 hv_vmbus_gpadl(u32 ch, u32 gpa, u32 pages);
i32 hv_vmbus_close(u32 ch);
i32 hv_vmbus_reopen(u32 ch);
u32 hv_vmbus_rescind(u32 ch);
```

Channels track version negotiation, GPADL, interrupt masks, pending-send-size,
close and rescind. SynIC EOM clears delivered SINT state but redelivers the
next queued message when the queue remains non-empty; the message-pending and
pending-SINT fields make that state observable. The guest-visible offer/close frames model the synthetic
keyboard, video, block, network, heartbeat, shutdown and time-sync devices.

```c
u32 hv_device_field(u32 part, u32 device, u32 field); /* online, tx, rx, status */
u32 hv_device_send(u32 part, u32 device, u32 src, u32 len);
```

Devices 0..5 are keyboard, video, block, loopback network, heartbeat and
shutdown/time-sync. Device sends are bounded VMBus messages; a shutdown send
transitions the guest partition to `STOPPED`.

### 2.12 Save/restore and migration

```c
u32 hv_checkpoint_save(u32 part, u32 dst, u32 cap);
i32 hv_checkpoint_restore(u32 part, u32 src, u32 len);
u32 hv_checkpoint_field(u32 part, u32 field); /* 0 valid, 1 framebuffer bytes, 2 heartbeat, 3 state hash */
u32 hv_partition_state_hash(u32 part);
u32 hv_migrate_precopy(u32 src, u32 dst, u32 budget_pages);
```

Checkpoints use a versioned `HVC1` record containing partition/VP state and a
state hash. A bounded per-partition sidecar captures the guest framebuffer and
guest stage/heartbeat while preserving the legacy 64-byte record; restoring a
matching record replays those bytes and guest progress. Dirty-page pre-copy
clears each copied page and converges before the destination is resumed with
the same hash.

### 2.13 Bounded checkpoint store and clone

The management checkpoint slice adds a separate, generation-safe store while
leaving the legacy `hv_checkpoint_save`, `hv_checkpoint_restore`, and
`hv_checkpoint_field` exports in 2.12 unchanged. The new exports are:

```c
u32 hv_ckpt_create(u32 part, u32 name_ptr, u32 name_len);
u32 hv_ckpt_count(void);
u32 hv_ckpt_slot(u32 slot);                 /* slot 0..3 -> current handle */
u32 hv_ckpt_field(u32 checkpoint, u32 field);
i32 hv_ckpt_restore(u32 checkpoint, u32 part); /* part 0 = source */
i32 hv_ckpt_delete(u32 checkpoint);
u32 hv_ckpt_clone(u32 checkpoint, u32 name_ptr, u32 name_len);
u32 hv_ckpt_data_ptr(u32 checkpoint);
u32 hv_ckpt_data_len(u32 checkpoint);
u32 hv_ckpt_last_status(void);
u32 hv_ckpt_max_bytes(void);
u32 hv_ckpt_format_version(void);
u32 hv_partition_identity(u32 part);
```

`hv_ckpt_*` handles use the same low-byte slot plus upper generation scheme as
partition IDs. `hv_ckpt_slot` is the only enumeration path; a handle remains
invalid after deletion and slot reuse. Field numbers are append-only:

```
0 handle, 1 source partition ID, 2 name pointer, 3 name length,
4 format version, 5 serialized bytes, 6 mapped memory bytes,
7 mapped pages, 8 VP count, 9 source state, 10 creation sequence, 11 status.
```

Version 1 is a little-endian `HVCP` image with a 32-byte header and seven
bounded section records: raw modeled partition state; VP state and registers;
VMBus channel state; the complete staged guest state including heartbeat;
GPA mappings; all mapped guest memory; and an explicit framebuffer copy. The
memory section is bounded to the fixed 176-page GPA window, and the image is
bounded to 1 MiB. Each section and the complete image use FNV-1a checksums.
Creation is one bounded pass over the seven sections and 176 pages. Restore
validates every header, range, version, and checksum before changing the
target. Restoring a running target returns status 11; status 8 denotes a
corrupt image, status 9 an unsupported version, status 10 a full/oversized
checkpoint store, status 12 a missing handle, and status 13 a stale handle.
Physical-page exhaustion and an unavailable VP or partition slot return the
existing `HV_STATUS_INSUFFICIENT_MEMORY` (4). The clone path allocates fresh
partition, VP, channel, and GPA resources, leaves the clone stopped, and keeps
the source's identity and memory untouched. A clone is made from the image and
does not require the source partition to remain present. Starting the clone
resumes the serialized guest stage and heartbeat deterministically. A root
partition cannot be checkpointed or cloned.

The image also exports `guest_state_size`, `guest_state_save`, and
`guest_state_load`; these are internal, bounded helpers used by the
`hv_ckpt_*` implementation and are not a second management ABI.

**DEVIATION:** real Hyper-V checkpoint files are coordinated by a management
service and normally include VSS or production-checkpoint storage. This model
keeps at most four 1 MiB images inside the 32 MiB hypervisor wasm instance,
does not persist them outside the instance, and intentionally excludes live
migration and disk differencing.

## 3. VBS / VSM policy model

The image uses trust-model A from `references/vbs-vtx.md`: VTL1 secure images
and nested L2 programs run as bounded guest-register ISA bytecode interpreted
by the hypervisor. The desktop's legacy staged guest remains available for its
compatibility boot, but the interpreter is the isolation boundary for code
whose execute permission matters. Every instruction fetch, load, and store
walks the partition SLAT and, for a launched VMX VP, the effective EPT. A
denied fetch records an EPT-style exit at the faulting RIP; it does not read
host memory or silently skip the protection.

The interpreter gives Tier 3.3 a separate VTL1 image context (registers, RIP,
step budget, status and exit state) and gives Tier 4.9 a resumable L2 stream.
The wasm instance is still shared, so this remains a bounded model rather than
a claim of hardware isolation; the important boundary is mechanically checked
at every bytecode memory access.

```c
i32 hv_enable_partition_vtl(u32 part, u32 vtl);
i32 hv_enable_vp_vtl(u32 vp, u32 vtl);
u32 hv_vtl_call(u32 vp, u32 call_id, u32 arg);
u32 hv_vtl_return(u32 vp);
i32 hv_vtl_set_register(u32 vp, u32 vtl, u32 which, u32 value);
i32 hv_vtl_get_register(u32 vp, u32 vtl, u32 which, u32 value_ptr);
i32 hv_vtl_synic_config(u32 vp, u32 vtl, u32 sint, u32 vector, u32 masked);
u32 hv_vtl_synic_field(u32 vp, u32 vtl, u32 sint, u32 field);
i32 hv_vtl_inject_interrupt(u32 vp, u32 vtl, u32 vector);
u32 hv_vtl_interrupt_field(u32 vp, u32 vtl, u32 field);
i32 hv_modify_vtl_protection_mask(u32 part, u32 gpa, u32 pages, u32 mask);
u32 hv_vtl_access(u32 part, u32 vtl, u32 gpa, u32 access);
u32 hv_vtl_field(u32 part, u32 field);
i32 hv_vsm_set_code(u32 part, u32 gpa, u32 hash);
u32 hv_vsm_field(u32 part, u32 field);
i32 hv_isa_load(u32 part, u32 gpa, u32 src, u32 len);
i32 hv_isa_reset(u32 vp, u32 entry_gpa, u32 code_pages, u32 vtl);
i32 hv_isa_stop(u32 vp);
u32 hv_isa_step(u32 vp, u32 budget);
u32 hv_isa_field(u32 vp, u32 field);
u32 hv_isa_reg(u32 vp, u32 reg);
i32 hv_isa_set_reg(u32 vp, u32 reg, u32 value);
```

VTL0 accesses that violate a VTL1 mask enter VTL1 with an intercept record;
the mask is explicit even when it is zero (a deliberate deny-all page), and
they never silently succeed. HVCI, KDP, Credential Guard, measured boot and
HyperGuard are represented by bounded policy calls:

Each enabled VTL has its own bounded SynIC SINT bank. Configuration and reads
of a bank require the VP to be executing in that VTL; a higher-VTL interrupt
injection preempts VTL0 and is returned from with `hv_vtl_return`. The VSM code
page is provisioned separately and is accepted only when its page hash matches
the supplied allowlist value. `hv_vtl_field` fields 12–14 report the VSM code
GPA, accepted hash, and readiness flag.

```c
u32 hv_page_hash(u32 part, u32 gpa);
i32 hv_hvci_sign_page(u32 part, u32 gpa, u32 hash);
i32 hv_hvci_set_execute(u32 part, u32 gpa);
i32 hv_kdp_protect(u32 part, u32 gpa, u32 pages);
i32 hv_lsa_store_secret(u32 part, u32 src, u32 len);
i32 hv_lsa_call(u32 part, u32 op, u32 src, u32 len, u32 dst);
i32 hv_lsa_unseal(u32 part, u32 component, u32 expected_pcr, u32 dst);
u32 hv_vtl_scan(u32 part, u32 src, u32 len);
u32 hv_measure_boot(u32 part, u32 component, u32 hash);
u32 hv_pcr_field(u32 part);
i32 hv_hyperguard_write(u32 part, u32 reg, u32 value);
```

Unsigned pages cannot become executable, executable pages cannot become
writable, KDP pages are write-protected, and LSA secrets remain in VTL1 state;
VTL0 receives only a derived result. VTL register banks can be read or written
only while that VP is executing in the target VTL, and `hv_lsa_unseal` refuses
when the supplied PCR does not match the measured state. PCR extension and
HyperGuard refusal are deterministic.

`hv_isa_load` copies an image into mapped GPA memory through the checked
hypervisor writer. `hv_isa_reset` accepts an 8-byte-aligned entry and at most
16 code pages; VTL1 images require the VTL to be enabled and their code page
to be admitted by the HVCI/VSM allowlist. Each instruction is eight bytes:
`{opcode, destination, source-a, source-b, immediate32}`. The bounded opcode
set includes `MOVI`, `ADD`, `SUB`, `XOR`, `CMP`, `LOAD`, `STORE`, relative
`JMP`/`JNZ`, `VMCALL`, `CPUID`, `RDMSR`, `WRMSR`, `VTL_CALL`, `VTL_RETURN`,
and `HALT`. `hv_isa_step` stops after a VM exit, a fault, or the requested
budget and leaves the next RIP resumable. Fields expose active/VTL/RIP/last
exit/qualification/halted/steps/faults/status/entry/end/secure-context; the
register accessors expose the 16 32-bit guest registers.

## 4. VT-x model

The VMX surface uses Intel names and encodings while remaining a bounded model
over the existing VP state. It maps VMCALL/MSR/CPUID and EPT violations onto
the Hyper-V path; the guest-register interpreter supplies the resumable
instruction stream instead of pretending to execute x86 bytes.

```c
u32 hv_vmx_feature_control(void);
i32 hv_vmx_set_feature_control(u32 value);
u32 hv_vmx_basic(void);
u32 hv_vmx_control_limits(u32 which, u32 limits_ptr);
u32 hv_vmx_control(u32 vp, u32 which);
i32 hv_vmx_set_control(u32 vp, u32 which, u32 value);
i32 hv_vmx_on(u32 vp);
i32 hv_vmx_off(u32 vp);
i32 hv_vmclear(u32 vp, u32 vmcs);
i32 hv_vmptrld(u32 vp, u32 vmcs);
u32 hv_vmptrst(u32 vp);
i32 hv_vmwrite(u32 vp, u32 field, u32 value);
i32 hv_vmread(u32 vp, u32 field, u32 *value);
i32 hv_vmlaunch(u32 vp);
i32 hv_vmresume(u32 vp);
u32 hv_vmx_field(u32 vp, u32 field);
u32 hv_vmx_guest_action(u32 vp, u32 action, u32 arg);
i32 hv_ept_map(u32 vp, u32 gpa, u32 pfn, u32 flags);
u32 hv_ept_walk_flags(u32 vp, u32 gpa);
u32 hv_ept_field(u32 vp, u32 gpa, u32 field); /* 0 permissions, 1 accessed, 2 dirty */
i32 hv_invept(u32 vp, u32 global);
i32 hv_vmx_set_vpid(u32 vp, u32 vpid);
i32 hv_invvpid(u32 vp, u32 global, u32 vpid);
i32 hv_vmx_inject_interrupt(u32 vp, u32 vector);
i32 hv_vmx_set_guest_if(u32 vp, u32 enabled);
i32 hv_vmx_set_msr_bitmap(u32 vp, u32 msr, u32 read_exit, u32 write_exit);
i32 hv_vmx_set_io_bitmap(u32 vp, u32 port, u32 read_exit, u32 write_exit);
i32 hv_vmx_set_preemption_timer(u32 vp, u32 ticks);
i32 hv_vmx_set_state(u32 vp, u32 which, u32 valid);
i32 hv_vmx_nested_enter(u32 vp);
i32 hv_vmx_nested_set_vmcs12(u32 vp, u32 field, u32 value);
i32 hv_vmx_nested_merge(u32 vp);
u32 hv_vmx_nested_field(u32 vp, u32 bank, u32 field);
i32 hv_vmx_nested_set_reflect(u32 vp, u32 reason, u32 reflect);
u32 hv_vmx_nested_action(u32 vp, u32 action, u32 arg);
i32 hv_vmx_nested_exit(u32 vp);
```

VMXON requires the feature-control lock and VMX bit; VMCS clear/loaded/launched
states return VMfailValid errors 4/5/12. Guest actions produce basic exit
reasons (CPUID 10, VMCALL 18, RDMSR 31, WRMSR 32, EPT violation 48,
misconfiguration 49 and preemption timer 52), with EPT R/W/X and invalid
W-without-R checks. CPUID.1 advertises VMX, the feature-control lock is
one-way, and the four control classes expose allowed-0/allowed-1 masks. A
launched VMCS validates host and guest state and reports VM-entry failures 33
and 34. VPID/INVVPID and address-space flushes invalidate the bounded TLB;
EPTP validates the memory type and four-level walk-length fields. MSR and I/O
bitmaps selectively produce exits. EPT entries expose accessed and
dirty bits after successful reads and writes, and W-without-R entries produce
exit 49. Nested action controls model an L2 exit either being consumed by L0
or reflected to L1. The nested surface keeps explicit bounded VMCS12 and VMCS02
banks: `hv_vmx_nested_merge` validates L1's controls against the L0 allowed
masks and materialises the effective VMCS02 state, while
`hv_vmx_nested_field` exposes both banks. An exit is copied into VMCS12 only
when the L1 reflection selector requests that basic reason. The ISA path uses
the effective VMCS02 EPT for each L2 fetch/load/store and leaves the L2 RIP at
the faulting instruction when L0 consumes or reflects the exit. `hv_vmx_field`
fields 14 and 15 expose the reflected qualification and whether the latest
VMCS12→VMCS02 merge is valid. The bounded scheduler applies
each partition's CPU weight
as a weighted round-robin share and stops a launched VP when its VMX
preemption budget reaches zero; `VMRESUME` clears that exit condition.

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
W98HV.checkpoints()            // bounded list of generation-safe checkpoint handles
W98HV.createCheckpoint(part, name) // -> handle or 0
W98HV.restoreCheckpoint(handle, part) // -> status; target must not be running
W98HV.deleteCheckpoint(handle) // -> status
W98HV.cloneCheckpoint(handle, name) // -> fresh stopped partition id or 0
W98HV.clonePartition(part, name) // convenience capture/clone/delete operation
W98HV.checkpointLimits()        // { maxBytes, formatVersion }
W98HV.checkpointStatus()        // { code, name, ok }
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
