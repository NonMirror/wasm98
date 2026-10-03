/* ============================================================================
   nt.h — the NT-style executive layer linked into kernel.wasm.

   Modelled on the Windows NT design: objects reached through handles held by a
   process, protected by a token, scheduled as threads, deferred to DPCs/APCs at
   an IRQL, driven through IRPs by layered drivers, backed by a memory manager
   with sections and a commit limit, configured by a hive.
   ========================================================================== */
#ifndef NT_H
#define NT_H

#include <stdint.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int32_t i32;

/* base64 and the scratch buffer are owned by kernel.c and shared with this layer */
u32 b64_enc(const u8 *src, u32 n, char *dst);
u32 b64_dec(const char *src, u32 n, u8 *dst);
extern u8 TMP[];
extern u32 tmp_len;

/* ---------------------------------------------------------------- limits */
#define NT_MAX_OBJ      768
#define NT_MAX_THREAD   128
#define NT_MAX_HANDLE   48
#define NT_MAX_DISP     192
#define NT_MAX_IRP       96
#define NT_MAX_DRIVER    16
#define NT_MAX_DEVICE    40
#define NT_MAX_REGION    48
#define NT_MAX_KEY      256
#define NT_MAX_VALUE    640
#define NT_MAX_SECTION   24
#define NT_MAX_DPC       96
#define NT_MAX_APC       96
#define NT_MAX_PID       80
#define NT_MAX_TX         8
#define NT_MAX_UNDO     256
#define NT_MAX_ACE        512u
#define NT_MAX_LOCK        96u
#define NT_MAX_WORK        96u
#define NT_MAX_IOCP        32u
#define NT_MAX_IOCP_PKT    256u
#define NT_MAX_ALPC         32u
#define NT_MAX_ALPC_MSG    128u
#define NT_ALPC_DATA       128u
#define NT_MAX_PFN       4096u
#define NT_MAX_POOL_ALLOC 512u
#define NT_MAX_SEG_HEAP  16u
#define NT_MAX_SEG_BLOCK 512u
#define NT_MAX_JOB         32u
#define NT_MAX_APP_HIVE    8u
#define NT_MAX_ETW_PROVIDER 32u
#define NT_MAX_ETW_SESSION  8u
#define NT_MAX_ETW_EVENT    256u
#define NT_ETW_PAYLOAD      64u
#define NT_MAX_CPU          4u
#define NT_PAGE        4096
#define NT_PRIO         32
#define NT_NAME_POOL   (256u * 1024u)
#define NT_DATA_POOL   (512u * 1024u)
#define NT_COMMIT_LIMIT (6u * 1024u * 1024u)
#define NT_POOL_BYTES  (4u * 1024u * 1024u)
#define NT_SEGMENT_POOL_BYTES (512u * 1024u)
#define NT_VM_BASE     0x00100000u

/* object types */
#define OT_PROCESS 1u
#define OT_THREAD  2u
#define OT_FILE    3u
#define OT_KEY     4u
#define OT_SECTION 5u
#define OT_EVENT   6u
#define OT_MUTANT  7u
#define OT_SEMAPHORE 8u
#define OT_TIMER   9u
#define OT_DRIVER  10u
#define OT_DEVICE  11u
#define OT_PORT    12u
#define OT_VMBUS   13u
#define OT_DIRECTORY 14u
#define OT_SYMBOLIC_LINK 15u

/* access bits and DACL flags */
#define ACCESS_READ   1u
#define ACCESS_WRITE  2u
#define ACCESS_EXEC   4u
#define ACCESS_DELETE 8u
#define ACCESS_ALL    15u
#define DACL_PUBLIC       0x00010000u
#define DACL_SYSTEM_ONLY  0x00020000u

/* Security descriptor entries.  ACEs are evaluated in insertion order. */
#define ACE_EVERYONE       0xFFFFFFFFu
#define ACE_ALLOW          0u
#define ACE_DENY           1u
#define ACE_AUDIT_SUCCESS  2u
#define ACE_AUDIT_FAILURE  3u
#define ACE_AUDIT_BOTH     4u
#define ACCESS_READ_CONTROL 0x00020000u
#define ACCESS_WRITE_DAC    0x00040000u
#define ACCESS_WRITE_OWNER  0x00080000u
#define ACCESS_SYSTEM_SECURITY 0x01000000u
#define ACCESS_VALID (ACCESS_ALL | ACCESS_READ_CONTROL | ACCESS_WRITE_DAC | ACCESS_WRITE_OWNER | ACCESS_SYSTEM_SECURITY)
#define GENERIC_READ      0x80000000u
#define GENERIC_WRITE     0x40000000u
#define GENERIC_EXECUTE   0x20000000u
#define GENERIC_ALL       0x10000000u
#define TOKEN_PRIV_DEBUG   0x00000001u
#define TOKEN_PRIV_SECURITY 0x00000002u
#define TOKEN_PRIV_SYSTEM  0x00000004u
#define TOKEN_PRIV_LOAD_DRIVER 0x00000008u
#define TOKEN_PRIV_TAKE_OWNERSHIP 0x00000010u
#define TOKEN_PRIV_ALL     0x0000001Fu

/* Mandatory integrity levels used by the MIC write-up rule. */
#define IL_UNTRUSTED 0u
#define IL_LOW       1u
#define IL_MEDIUM    2u
#define IL_HIGH      3u
#define IL_SYSTEM    4u

/* Protected-process-light signer levels. */
#define PPL_NONE         0u
#define PPL_AUTHENTICODE 1u
#define PPL_CODEGEN      2u
#define PPL_ANTIMALWARE  3u
#define PPL_LSA          4u
#define PPL_WINDOWS      5u

/* thread states */
#define TH_EMPTY 0u
#define TH_READY 1u
#define TH_RUN   2u
#define TH_WAIT  3u
#define TH_DEAD  4u

/* IRQL */
#define IRQL_PASSIVE  0u
#define IRQL_APC      1u
#define IRQL_DISPATCH 2u
#define IRQL_DEVICE   3u
#define IRQL_HIGH     15u

/* NTSTATUS values used here */
#define ST_SUCCESS              0x00000000u
#define ST_INVALID_DEVICE_REQ   0xC0000010u  /* not valid for this device / wrong IRQL */
#define ST_MORE_PROCESSING      0xC0000016u
#define ST_ACCESS_DENIED        0xC0000022u
#define ST_INSUFFICIENT_RES     0xC000009Au
#define ST_INVALID_PARAM        0xC000000Du
#define ST_KEY_HAS_CHILDREN     0xC00000F0u
#define ST_NO_MORE_ENTRIES      0x8000001Au
#define ST_PARTIAL_COPY         0x8000000Du
#define ST_OBJECT_NAME_NOT_FOUND 0xC0000034u
#define ST_OBJECT_NAME_COLLISION 0xC0000035u
#define ST_REPARSE              0xC0000275u
#define ST_PRIVILEGE_NOT_HELD   0xC0000061u
#define ST_ABANDONED            0x00000080u
#define ST_USER_APC             0x000000C0u
#define ST_ALERTED              0x00000101u
#define ST_TIMEOUT              0x00000102u
#define BUGCHECK_DRIVER_IRQL    0x000000D1u
#define BUGCHECK_KMODE_EXCEPTION 0x0000001Eu
#define BUGCHECK_VERIFIER       0x000000C4u
#define BUGCHECK_PATCHGUARD     0x00000109u

#define VERIFIER_RULE_IRQL      1u
#define VERIFIER_RULE_POOL      2u
#define VERIFIER_RULE_IO        4u
#define VERIFIER_RULE_HANDLE    8u

#define WAIT_ANY                0u
#define WAIT_ALL                1u

/* Executive synchronization object kinds and acquisition modes. */
#define LOCK_SPIN              1u
#define LOCK_QUEUED_SPIN       2u
#define LOCK_ERESOURCE         3u
#define LOCK_PUSHLOCK          4u
#define LOCK_FAST_MUTEX        5u
#define LOCK_GUARDED_MUTEX     6u
#define LOCK_SHARED             0u
#define LOCK_EXCLUSIVE          1u
#define ST_RESOURCE_IN_USE      0xC0000708u
#define ST_RECURSIVE_LOCK       0xC00000A7u
#define ST_PORT_CLOSED           0xC0000037u
#define ST_DEVICE_BUSY           0xC000009Eu
#define ST_DELETE_PENDING        0xC0000056u
#define ST_BAD_POOL_CALLER       0xC00000C2u
#define ST_JOB_LIMIT             0xC0000411u
#define POOL_NX                  0x80000000u

#define PNP_ADDED                0u
#define PNP_STARTED              1u
#define PNP_QUERY_REMOVE         2u
#define PNP_REMOVED              3u
#define POWER_D0                 0u
#define POWER_D1                 1u
#define POWER_D2                 2u
#define POWER_D3                 3u

#define PFN_FREE                 0u
#define PFN_ZEROED               1u
#define PFN_STANDBY              2u
#define PFN_MODIFIED             3u
#define PFN_ACTIVE               4u
#define VM_LARGE_PAGE            0x40000000u
#define NT_LARGE_PAGE            (2u * 1024u * 1024u)

/* pool tags for the memory manager UI */
#define POOL_PAGED    1u
#define POOL_NONPAGED 0u

/* stat indices exposed through k_stat(idx >= 100) -> nt_stat(idx - 100) */
#define NS_OBJECTS        0u
#define NS_OBJECT_PEAK    1u
#define NS_HANDLES        2u
#define NS_THREADS        3u
#define NS_TH_READY       4u
#define NS_TH_RUN         5u
#define NS_TH_WAIT        6u
#define NS_READY_DEPTH    7u
#define NS_WAITS          8u
#define NS_MUTANTS_HELD   9u
#define NS_DPC_QUEUED     10u
#define NS_DPC_DRAINED    11u
#define NS_APC_QUEUED     12u
#define NS_APC_DELIVERED  13u
#define NS_IRP_CREATED    14u
#define NS_IRP_COMPLETED  15u
#define NS_IRP_FAILED     16u
#define NS_IRP_OVERFLOW   17u
#define NS_IRP_CANCELLED  18u
#define NS_IRQL_VIOLATIONS 19u
#define NS_COMMIT_CHARGE  20u
#define NS_COMMIT_LIMIT   21u
#define NS_COMMIT_PEAK    22u
#define NS_COMMIT_FAILS   23u
#define NS_PAGE_FAULTS    24u
#define NS_POOL_PAGED     25u
#define NS_POOL_PAGED_PEAK 26u
#define NS_POOL_NONPAGED  27u
#define NS_POOL_NP_PEAK   28u
#define NS_TOKENS         29u
#define NS_ACCESS_CHECKS  30u
#define NS_ACCESS_DENIES  31u
#define NS_REG_KEYS       32u
#define NS_REG_VALUES     33u
#define NS_REG_DEPTH      34u
#define NS_TX_COMMITTED   35u
#define NS_TX_ROLLEDBACK  36u
#define NS_BUGCHECKS      37u
#define NS_SECTIONS       38u
#define NS_VM_REGIONS     39u
#define NS_CURRENT_TID    40u
#define NS_SWITCHES       41u
#define NS_BOOSTS         42u
#define NS_AGING          43u
#define NS_VMBUS_MSGS     44u
#define NS_KERNEL_HALTED  45u
#define NS_OBJECT_DELETES 46u
#define NS_WAIT_TIMEOUTS  47u
#define NS_HIVE_QUOTA     48u   /* hive pool allocations that could not be satisfied */
#define NS_HIVE_SKIPS     49u   /* registry values too large to reload from a snapshot */
#define NS_ACCESS_GRANTS  50u
#define NS_AUDIT_SUCCESS  51u
#define NS_AUDIT_FAILURE  52u
#define NS_COUNT          53u

/* dispatcher object state for k_obj_field(obj, 16..) */
#define OF_DSTATE    16u   /* 0 unsignalled, 1 signalled */
#define OF_DMANUAL   17u
#define OF_DCOUNT    18u
#define OF_DLIMIT    19u
#define OF_DOWNER    20u
#define OF_DSIGNALS  21u
#define OF_DWAITS    22u

/* --------------------------------------------------------------- objects */
u32  k_obj_create(u32 type, u32 name_ptr, u32 name_len, u32 dacl);
i32  k_obj_ref(u32 obj);
i32  k_obj_deref(u32 obj);
u32  k_obj_type(u32 obj);
u32  k_obj_count(void);
u32  k_obj_field(u32 obj, u32 f);
u32  k_obj_name_ptr(u32 obj);
u32  k_obj_name_len(u32 obj);
i32  k_obj_create_named(u32 type, u32 name_ptr, u32 name_len, u32 dacl);
i32  k_obj_open_named(u32 name_ptr, u32 name_len, u32 type);
i32  k_obj_link_named(u32 name_ptr, u32 name_len, u32 target);
i32  k_obj_retarget_named(u32 name_ptr, u32 name_len, u32 target);
u32  k_obj_namespace_count(void);
i32  k_obj_set_owner(u32 obj, u32 sid);
i32  k_obj_add_ace(u32 obj, u32 sid, u32 mask, u32 type);
i32  k_obj_clear_aces(u32 obj);
u32  k_obj_owner(u32 obj);
u32  k_obj_ace_count(u32 obj);
i32  k_obj_add_sacl_ace(u32 token, u32 obj, u32 sid, u32 mask, u32 type);
i32  k_obj_security_add_ace(u32 token, u32 obj, u32 sid, u32 mask, u32 type);
i32  k_obj_security_set_owner(u32 token, u32 obj, u32 sid);
i32  k_obj_set_integrity(u32 obj, u32 level);
u32  k_obj_integrity(u32 obj);
u32  k_token_integrity(u32 token);
i32  k_token_set_integrity(u32 token, u32 level);
i32  k_obj_security_set_integrity(u32 token, u32 obj, u32 level);
u32  k_obj_protection(u32 obj);
i32  k_obj_set_protection(u32 obj, u32 signer);
u32  k_token_signer(u32 token);
i32  k_token_set_signer(u32 token, u32 signer);
i32  k_obj_security_set_protection(u32 token, u32 obj, u32 signer);
u32  k_access_map_generic(u32 access);

/* --------------------------------------------------------------- handles */
i32  k_handle_open(u32 pid, u32 obj, u32 access);
i32  k_handle_close(u32 pid, i32 h);
i32  k_handle_dup(u32 pid, i32 h, u32 access);
i32  k_handle_obj(u32 pid, i32 h);
u32  k_handle_access(u32 pid, i32 h);
u32  k_handle_count(u32 pid);

/* -------------------------------------------------------------- security */
u32  k_token_create(u32 sid, u32 privileged);
u32  k_token_of(u32 pid);
i32  k_token_set(u32 pid, u32 token);
i32  k_token_set_privileges(u32 token, u32 privileges);
u32  k_token_privileges(u32 token);
u32  k_token_has_privilege(u32 token, u32 privilege);
i32  k_privilege_check(u32 token, u32 privilege);
i32  k_access_check(u32 token, u32 obj, u32 access);
u32  k_sid_of(u32 token);
u32  k_privileged_of(u32 token);

/* --------------------------------------------------------------- threads */
u32  k_thread_create(u32 pid, u32 priority, u32 name_ptr, u32 name_len);
i32  k_thread_terminate(u32 tid);
u32  k_thread_count(void);
u32  k_thread_field(u32 tid, u32 f);
i32  k_thread_set_priority(u32 tid, u32 prio);
i32  k_thread_boost(u32 tid, u32 amount);
i32  k_thread_wait(u32 tid, u32 obj, u32 timeout_ms, u32 alertable);
i32  k_wait_multiple(u32 tid, u32 list_ptr, u32 count, u32 wait_type, u32 timeout_ms, u32 alertable);
u32  k_wait_result(u32 tid);

/* --------------------------------------------------------- synchronization */
i32  k_lock_create(u32 type);
i32  k_lock_acquire(u32 lock, u32 tid, u32 mode);
i32  k_lock_release(u32 lock, u32 tid, u32 mode);
u32  k_lock_field(u32 lock, u32 field);
i32  k_spinlock_create(void);
i32  k_spinlock_acquire(u32 lock, u32 tid);
i32  k_spinlock_release(u32 lock, u32 tid);
i32  k_pushlock_create(void);
i32  k_pushlock_acquire(u32 lock, u32 tid, u32 exclusive);
i32  k_pushlock_release(u32 lock, u32 tid, u32 exclusive);

/* ----------------------------------------------------------- work items */
i32  k_work_queue(u32 proc_id, u32 data);
i32  k_work_drain(void);
u32  k_work_pending(void);
u32  k_work_field(u32 work, u32 field);
i32  k_thread_alert(u32 tid);
i32  k_thread_set_affinity(u32 tid, u32 mask);
u32  k_thread_affinity(u32 tid);
i32  k_thread_set_ideal_processor(u32 tid, u32 cpu);
u32  k_thread_ideal_processor(u32 tid);
u32  k_thread_processor(u32 tid);
u32  k_cpu_ready_index(u32 cpu, u32 level);
u32  k_scheduler_cpu(void);
i32  k_scheduler_set_cpu(u32 cpu);
i32  k_process_set_priority_class(u32 pid, u32 class_id);
u32  k_process_priority_class(u32 pid);

/* --------------------------------------------------------------- timers */
u32  k_timer_set(u32 pid, u32 interval_ms, u32 oneshot);
i32  k_timer_set_ex(u32 pid, u32 interval_ms, u32 oneshot, u32 dpc_id, u32 tolerance_ms, u32 high_res);
i32  k_timer_set_tolerance(u32 timer, u32 tolerance_ms);
u32  k_timer_field(u32 timer, u32 field);
u32  k_thread_ready_index(u32 level);
u32  k_thread_first(void);
u32  k_thread_of_proc(u32 pid);

/* ------------------------------------------------------------ dispatcher */
u32  k_event_create(u32 manual_reset, u32 initial);
i32  k_event_set(u32 ev);
i32  k_event_reset(u32 ev);
u32  k_mutant_create(u32 owner_tid);
i32  k_mutant_release(u32 m, u32 tid);
u32  k_semaphore_create(u32 initial, u32 limit);
i32  k_semaphore_release(u32 s, u32 count);
i32  k_obj_signal(u32 obj);
i32  k_obj_wait_test(u32 obj, u32 tid);
u32  k_wait_count(u32 obj);

/* ------------------------------------------------------- irql, dpc, apc */
u32  k_irql(void);
u32  k_irql_raise(u32 level);
u32  k_irql_lower(u32 level);
u32  k_irql_violations(void);
i32  k_dpc_queue(u32 proc_id, u32 data);
u32  k_dpc_drained(void);
i32  k_apc_queue(u32 tid, u32 proc_id, u32 data, u32 user_mode);
u32  k_apc_pending(void);
u32  k_apc_pop(void);

/* ------------------------------------------------------------------- io */
u32  k_driver_create(u32 name_ptr, u32 name_len, u32 dispatch_id, u32 flags);
u32  k_device_create(u32 driver, u32 name_ptr, u32 name_len, u32 type);
i32  k_devices_link(u32 device, u32 lower_device);
u32  k_driver_field(u32 drv, u32 f);
u32  k_device_field(u32 dev, u32 f);
i32  k_device_open(u32 dev);
i32  k_device_close(u32 dev);
i32  k_pnp_start(u32 dev);
i32  k_pnp_query_remove(u32 dev);
i32  k_pnp_cancel_remove(u32 dev);
i32  k_pnp_remove(u32 dev);
i32  k_pnp_set_power(u32 dev, u32 state);
u32  k_pnp_field(u32 dev, u32 field);
u32  k_irp_create(u32 device, u32 major, u32 minor, u32 in_len, u32 out_len);
i32  k_io_call_driver(u32 irp);
u32  k_io_complete(u32 irp, u32 status, u32 bytes);
i32  k_io_cancel(u32 irp);
u32  k_irp_field(u32 irp, u32 f);
u32  k_irp_queue_depth(u32 device);
u32  k_io_counts(u32 which);
i32  k_iocp_create(u32 concurrency);
i32  k_iocp_associate(u32 port, u32 device, u32 key);
i32  k_iocp_post(u32 port, u32 key, u32 bytes, u32 status, u32 irp);
i32  k_iocp_get(u32 port, u32 timeout_ms);
u32  k_iocp_field(u32 port, u32 field);
u32  k_iocp_packet_field(u32 packet, u32 field);
i32  k_irp_associate_completion(u32 irp, u32 port, u32 key);
i32  k_io_mark_pending(u32 irp);

/* --------------------------------------------------------------- ALPC */
i32  k_alpc_create(u32 owner_pid, u32 max_messages);
i32  k_alpc_connect(u32 client, u32 server);
i32  k_alpc_accept(u32 server, u32 client);
i32  k_alpc_close(u32 port);
i32  k_alpc_send(u32 port, u32 token, u32 data_ptr, u32 data_len, u32 section);
i32  k_alpc_receive(u32 port, u32 timeout_ms);
i32  k_alpc_reply(u32 port, u32 message, u32 status);
i32  k_alpc_message_release(u32 message);
u32  k_alpc_field(u32 port, u32 field);
u32  k_alpc_message_field(u32 message, u32 field);

/* ------------------------------------------------------ memory manager */
u32  k_process_create(u32 name_ptr, u32 name_len, u32 token);
i32  k_process_terminate(u32 pid);
i32  k_vm_reserve(u32 pid, u32 bytes, u32 protect);
i32  k_vm_commit(u32 pid, u32 vaddr, u32 bytes);
i32  k_vm_free(u32 pid, u32 vaddr, u32 bytes);
i32  k_vm_touch(u32 pid, u32 vaddr);
i32  k_vm_reserve_large(u32 pid, u32 bytes, u32 protect);
u32  k_vm_region_field(u32 pid, u32 vaddr, u32 field); /* 0 large, 1 paged out, 2 prototype */
u32  k_vm_region_count(u32 pid);
u32  k_vm_field(u32 pid, u32 f);
u32  k_vm_region_vaddr(u32 pid, u32 idx);
u32  k_vm_region_bytes(u32 pid, u32 idx);
i32  k_mm_trim(u32 pid, u32 pages);
i32  k_mm_reclaim(u32 pages);
u32  k_mm_pfn_field(u32 state);
i32  k_mm_pageout(u32 pid, u32 vaddr);
i32  k_mm_pagein(u32 pid, u32 vaddr);
u32  k_mm_pagefile_field(u32 field); /* 0 slots, 1 outs, 2 ins, 3 failures */
u32  k_section_create(u32 bytes, u32 protect);
i32  k_section_create_ex(u32 bytes, u32 protect, u32 copy_on_write);
i32  k_section_set_cow(u32 section, u32 enabled);
i32  k_section_set_prototype(u32 section, u32 enabled);
i32  k_section_map(u32 pid, u32 section, u32 vaddr);
i32  k_vm_cow_write(u32 pid, u32 vaddr);
i32  k_vm_prototype_fault(u32 pid, u32 vaddr);
u32  k_section_field(u32 sec, u32 f);
u32  k_pool_alloc(u32 bytes, u32 paged, u32 tag);
u32  k_pool_alloc_for(u32 pid, u32 bytes, u32 paged, u32 tag);
i32  k_pool_free(u32 ptr, u32 tag);
i32  k_pool_set_nx(u32 ptr, u32 nx);
u32  k_pool_is_nx(u32 ptr);
i32  k_pool_set_quota(u32 pid, u32 bytes);
u32  k_pool_quota(u32 pid);
u32  k_pool_charge(u32 pid);
u32  k_pool_field(u32 f);
i32  k_segment_heap_create(u32 pid, u32 initial_bytes, u32 maximum_bytes, u32 flags);
u32  k_segment_heap_alloc(u32 heap, u32 bytes, u32 tag);
i32  k_segment_heap_free(u32 ptr, u32 tag);
i32  k_segment_heap_destroy(u32 heap);
u32  k_segment_heap_field(u32 heap, u32 field);

/* --------------------------------------------------------- jobs / silos */
i32  k_job_create(u32 parent, u32 memory_limit, u32 kill_on_close, u32 silo);
i32  k_job_assign(u32 job, u32 pid);
i32  k_job_set_limit(u32 job, u32 memory_limit);
i32  k_job_close(u32 job);
u32  k_job_field(u32 job, u32 field);
u32  k_commit_field(u32 f);

/* -------------------------------------------------------- registry hive */
u32  k_reg2_root(u32 hive);
i32  k_reg2_create_key(u32 parent, u32 name_ptr, u32 name_len);
u32  k_reg2_open_key(u32 parent, u32 name_ptr, u32 name_len);
i32  k_reg2_set_value(u32 key, u32 name_ptr, u32 name_len, u32 type, u32 data, u32 len);
i32  k_reg2_set_dword(u32 key, u32 name_ptr, u32 name_len, u32 value);
i32  k_reg2_get_value(u32 key, u32 name_ptr, u32 name_len);
u32  k_reg2_value_type(void);
u32  k_reg2_value_len(void);
u32  k_reg2_enum_value(u32 key, u32 idx);
u32  k_reg2_enum_key(u32 key, u32 idx);
i32  k_reg2_delete_key(u32 key);
u32  k_reg2_key_field(u32 key, u32 f);
u32  k_reg2_key_path(u32 key);
u32  k_reg2_name_ptr(void);
u32  k_reg2_name_len(void);
u32  k_reg2_tx_begin(void);
i32  k_reg2_tx_commit(u32 tx);
i32  k_reg2_tx_rollback(u32 tx);
u32  k_reg2_stats(u32 which);
u32  k_reg2_cell_field(u32 key, u32 field);
i32  k_reg2_link_key(u32 parent, u32 name_ptr, u32 name_len, u32 target);
i32  k_reg2_create_app_hive(u32 name_ptr, u32 name_len);
u32  k_reg2_app_hive_root(u32 hive);
u32  k_reg2_app_hive_field(u32 hive, u32 field);

/* --------------------------------------------------------------- ETW */
i32  k_etw_register_provider(u32 name_ptr, u32 name_len);
i32  k_etw_start_session(u32 name_ptr, u32 name_len, u32 capacity);
i32  k_etw_enable_provider(u32 session, u32 provider, u32 level, u32 keywords);
i32  k_etw_write(u32 provider, u32 event_id, u32 level, u32 keywords, u32 data, u32 len, u32 tid);
u32  k_etw_drain(u32 session, u32 max_events);
u32  k_etw_event_field(u32 session, u32 field);
u32  k_etw_event_ptr(void);
u32  k_etw_event_len(void);

/* legacy flat registry, now a view onto the hive (kernel.c delegates here) */
i32  nt_reg_set(u32 path, u32 pl, u32 name, u32 nl, u32 val, u32 vl);
i32  nt_reg_get(u32 path, u32 pl, u32 name, u32 nl);
i32  nt_reg_del(u32 path, u32 pl, u32 name, u32 nl);
u32  nt_reg_save(void);
i32  nt_reg_load(u32 ptr, u32 len);
u32  nt_reg_count(void);
u32  nt_reg_enum(u32 idx);
u32  nt_reg_enum_path_ptr(void);
u32  nt_reg_enum_path_len(void);
u32  nt_reg_enum_name_ptr(void);
u32  nt_reg_enum_name_len(void);
u32  nt_reg_enum_type(void);

/* -------------------------------------------------------------- bugcheck */
u32  k_bugcheck(u32 code, u32 p1, u32 p2, u32 p3, u32 p4);
u32  k_bugcheck_state(u32 which);
u32  k_bugcheck_dump_ptr(void);
u32  k_bugcheck_dump_len(void);

/* ------------------------------------------------ verifier / PatchGuard */
i32  k_verifier_enable(u32 driver, u32 rules);
i32  k_verifier_check(u32 driver, u32 rule, u32 p1, u32 p2, u32 p3, u32 p4);
u32  k_verifier_field(u32 driver, u32 field);
i32  k_patchguard_enable(u32 interval_ms);
u32  k_patchguard_tick(u32 now_ms);
i32  k_patchguard_corrupt(u32 driver, u32 dispatch_id);
u32  k_patchguard_field(u32 field);

/* ---------------------------------------------------------- integration */
void nt_init(void);
void nt_on_proc_create(u32 pid, u32 name_ptr, u32 name_len);
void nt_on_proc_destroy(u32 pid);
u32  nt_tick(u32 now_ms, u32 dt_ms);
u32  nt_stat(u32 idx);
u32  nt_tmp_len(void);
u32  k_vmbus_tx(u32 bytes);
u32  k_vmbus_stats(u32 which);

#endif /* NT_H */
