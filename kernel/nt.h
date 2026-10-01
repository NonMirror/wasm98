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
#define NT_PAGE        4096
#define NT_PRIO         32
#define NT_NAME_POOL   (256u * 1024u)
#define NT_DATA_POOL   (512u * 1024u)
#define NT_COMMIT_LIMIT (6u * 1024u * 1024u)
#define NT_POOL_BYTES  (4u * 1024u * 1024u)
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

/* access bits and DACL flags */
#define ACCESS_READ   1u
#define ACCESS_WRITE  2u
#define ACCESS_EXEC   4u
#define ACCESS_DELETE 8u
#define ACCESS_ALL    15u
#define DACL_PUBLIC       0x00010000u
#define DACL_SYSTEM_ONLY  0x00020000u

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
#define NS_COUNT          50u

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
i32  k_thread_alert(u32 tid);
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
u32  k_irp_create(u32 device, u32 major, u32 minor, u32 in_len, u32 out_len);
i32  k_io_call_driver(u32 irp);
u32  k_io_complete(u32 irp, u32 status, u32 bytes);
u32  k_irp_field(u32 irp, u32 f);
u32  k_irp_queue_depth(u32 device);
u32  k_io_counts(u32 which);

/* ------------------------------------------------------ memory manager */
u32  k_process_create(u32 name_ptr, u32 name_len, u32 token);
i32  k_process_terminate(u32 pid);
i32  k_vm_reserve(u32 pid, u32 bytes, u32 protect);
i32  k_vm_commit(u32 pid, u32 vaddr, u32 bytes);
i32  k_vm_free(u32 pid, u32 vaddr, u32 bytes);
i32  k_vm_touch(u32 pid, u32 vaddr);
u32  k_vm_region_count(u32 pid);
u32  k_vm_field(u32 pid, u32 f);
u32  k_vm_region_vaddr(u32 pid, u32 idx);
u32  k_vm_region_bytes(u32 pid, u32 idx);
u32  k_section_create(u32 bytes, u32 protect);
i32  k_section_map(u32 pid, u32 section, u32 vaddr);
u32  k_section_field(u32 sec, u32 f);
u32  k_pool_alloc(u32 bytes, u32 paged, u32 tag);
u32  k_pool_field(u32 f);
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
