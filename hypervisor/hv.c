/* ============================================================================
   hv.c — a minimal type-1 style hypervisor (Hyper-V shaped) on wasm32.
   ----------------------------------------------------------------------------
   The wasm image owns the machine.  Its static BSS arena IS physical memory:
   16 MB, split into 4 KB pages with a PFN array.  SLAT translates each
   partition's guest-physical addresses (GPA) into that memory.  Everything a
   partition can touch goes through the SLAT, so a bad guest access is contained
   and reported rather than tolerated.

   Owned here:
     * partitions (max 8) and virtual processors (max 16)
     * SLAT: GPA -> PFN per partition (4 KB pages, present/writable flags)
     * the hypercall engine (near-Hyper-V call codes), virtual MSRs and CPUID
     * SynIC (message queues, SINTs, EOM), the synthetic timer, VMBus channels
     * VP time-slicing (10 ms quantum) and the run/accounting counters
     * the guest image is linked in from guest/guest.c and is entered ONLY
       through hv_vm_entry(vp), which surrounds the guest's mapped window with
       canary pages and verifies them after every entry.

   Freestanding: no libc, no entry point, no allocation beyond the static
   arenas.  Build: tools/build_hv.sh

   ABI: HV_ABI.md sections 2 and 4.  Deviations are called out in comments
   marked "DEVIATION:".
   ========================================================================== */
#include <stdint.h>

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t  i32;
typedef uint64_t u64;

/* ---------------------------------------------------------------- tunables */
#define MAX_PARTS        8u
#define MAX_VPS          16u
#define MAX_CHANNELS     16u
#define MAX_VPS_PER_PART 4u
#define ID_SLOT_BITS     8u
#define ID_SLOT_MASK     0xFFu
#define PAGE_SHIFT       12u
#define PAGE             (1u << PAGE_SHIFT)          /* 4 KB                */
#define PHYS_MAX         (16u * 1024u * 1024u)       /* 16 MB               */
#define HOST_PAGES       (PHYS_MAX >> PAGE_SHIFT)    /* 4096 PFNs           */

/* the guest's GPA window: 176 pages (0x00000 .. 0xAFFFF).  Everything the
   guest owns lives inside it; the SLAT has no entry outside it, so an
   out-of-window access is a SLAT fault and the canary pages are unreachable. */
#define GPA_PAGES        176u
#define GPA_LIMIT        (GPA_PAGES << PAGE_SHIFT)   /* 0xB0000             */

#define HC_PAGE_GPA      0x0000E000u                 /* hypercall page      */
#define FB_GPA           0x00010000u                 /* 400x120x32bpp       */
#define FB_W             400u
#define FB_H             120u
#define FB_PIXELS        (FB_W * FB_H)
#define FB_BYTES         (FB_PIXELS * 4u)            /* 192000 = 47 pages   */
#define OUT_RING_GPA     0x00080000u                 /* guest -> root ring  */
#define IN_RING_GPA      0x00088000u                 /* root  -> guest ring */
#define SIMP_GPA         0x00090000u                 /* SynIC message page  */
#define SIEFP_GPA        0x00091000u                 /* SynIC event flags   */
#define TSC_GPA          0x00093000u                 /* reference TSC page  */
#define RING_HDR         16u
#define RING_DATA        4096u
#define RING_SIZE        (RING_HDR + RING_DATA)      /* 4112 -> 2 pages     */

#define MSG_SIZE         256u
#define MSG_QUEUE        16u
#define MAX_MSRS         32u
#define MSR_LOG          32u
#define NAME_LEN         48u
#define HLOG_SIZE        (64u * 1024u)
#define GLOG_SIZE        (8u * 1024u)
#define SCRATCH_SIZE     (256u * 1024u)

#define HV_VERSION       0x00060000u
#define HV_SIGNATURE     0x31237648u                 /* "Hv#1"              */
#define HV_MAGIC         0x48560001u                 /* "HV" v1             */
#define MAX_LEAF         0x40000004u
#define VENDOR0          0x7263694Du                 /* "Micr"              */
#define VENDOR1          0x666F736Fu                 /* "osof"              */
#define VENDOR2          0x76482074u                 /* "t Hv"              */

/* partition states (HV_ABI.md 2.1) */
#define PS_EMPTY         0u
#define PS_CREATED       1u
#define PS_INITIALISED   2u
#define PS_RUNNING       3u
#define PS_PAUSED        4u
#define PS_STOPPED       5u
#define PS_FAULTED       6u
#define PS_DELETED       7u

/* VP states (ours; the ABI only fixes the partition states) */
#define VS_EMPTY         0u
#define VS_CREATED       1u
#define VS_RUNNING       2u
#define VS_HALTED        3u

/* hypercall status codes (HV_ABI.md 2.3) */
#define HV_STATUS_SUCCESS           0u
#define HV_STATUS_INVALID_PARAMETER 2u
#define HV_STATUS_ACCESS_DENIED     3u
#define HV_STATUS_INSUFFICIENT_MEM  4u
#define HV_STATUS_BAD_PART_STATE    5u
#define HV_STATUS_SLAT_FAULT        6u
#define HV_STATUS_NOT_IMPLEMENTED   7u
#define HV_STATUS_REP_NOT_COMPLETE  0x10u
#define HV_STATUS_CHECKPOINT_CORRUPT 8u
#define HV_STATUS_CHECKPOINT_UNSUPPORTED 9u
#define HV_STATUS_CHECKPOINT_LIMIT 10u
#define HV_STATUS_CHECKPOINT_RUNNING 11u
#define HV_STATUS_CHECKPOINT_NOT_FOUND 12u
#define HV_STATUS_STALE_ID 13u
#define VTL0 0u
#define VTL1 1u
#define VTL_ACCESS_W 1u
#define VTL_ACCESS_R 2u
#define VTL_ACCESS_X 4u
#define VMX_FAIL_INVALID (-1)
#define VMX_FAIL_VALID   (-2)
#define VMXERR_VMLAUNCH_NONCLEAR 4u
#define VMXERR_VMRESUME_CLEAR 5u
#define VMXERR_BAD_FIELD 12u
#define VMXERR_ENTRY_INVALID_CONTROL 33u
#define VMXERR_ENTRY_INVALID_HOST 34u
#define VMX_EXIT_CPUID 10u
#define VMX_EXIT_HLT 12u
#define VMX_EXIT_VMCALL 18u
#define VMX_EXIT_RDMSR 31u
#define VMX_EXIT_WRMSR 32u
#define VMX_EXIT_EPT_VIOLATION 48u
#define VMX_EXIT_EPT_MISCONFIG 49u
#define VMX_EXIT_PREEMPT_TIMER 52u
#define VMX_EXIT_EXCEPTION 0u
#define VMX_FIELD_GUEST_RIP 0x681Eu
#define VMX_FIELD_EXIT_REASON 0x4402u
#define VMX_FIELD_EXIT_QUAL 0x6400u
#define VMX_FIELD_EPTP 0x201Au
#define VMX_FIELD_VPID 0x0000u
#define VMX_CTRL_PIN 0u
#define VMX_CTRL_PROC 1u
#define VMX_CTRL_EXIT 2u
#define VMX_CTRL_ENTRY 3u
#define VMX_CTRL_PIN_ALLOWED1 0x0000001Fu
#define VMX_CTRL_PROC_ALLOWED1 0x7FFFFFFFu
#define VMX_CTRL_EXIT_ALLOWED1 0x0003FFFFu
#define VMX_CTRL_ENTRY_ALLOWED1 0x000003FFu
#define VMX_NESTED_FIELDS       8u
#define VMX_NESTED_PIN          0u
#define VMX_NESTED_PROC         1u
#define VMX_NESTED_EXIT         2u
#define VMX_NESTED_ENTRY        3u
#define VMX_NESTED_GUEST_RIP    4u
#define VMX_NESTED_EXIT_REASON  5u
#define VMX_NESTED_EXIT_QUAL    6u
#define VMX_NESTED_LAUNCHED     7u

/* Bounded guest register ISA used for VTL1 secure images and nested L2.
   Instructions are fixed eight-byte records: {opcode, rd, ra, rb, imm32}.
   The interpreter never dereferences a guest pointer directly; fetches and
   data accesses use the same SLAT/EPT walk as a hardware guest. */
#define ISA_OP_HALT       0x00u
#define ISA_OP_MOVI       0x01u
#define ISA_OP_ADD        0x02u
#define ISA_OP_SUB        0x03u
#define ISA_OP_XOR        0x04u
#define ISA_OP_LOAD       0x05u
#define ISA_OP_STORE      0x06u
#define ISA_OP_JMP        0x07u
#define ISA_OP_JNZ        0x08u
#define ISA_OP_VMCALL     0x09u
#define ISA_OP_CPUID      0x0Au
#define ISA_OP_RDMSR      0x0Bu
#define ISA_OP_WRMSR      0x0Cu
#define ISA_OP_VTL_CALL   0x0Du
#define ISA_OP_VTL_RETURN 0x0Eu
#define ISA_OP_CMP        0x0Fu
#define ISA_REGS          16u
#define ISA_INSN_BYTES    8u
#define ISA_MAX_CODE_PAGES 16u
#define ISA_MAX_STEPS     0x00100000u
#define ISA_EXIT_ILLEGAL  0x100u
#define ISA_EXIT_SLAT     VMX_EXIT_EPT_VIOLATION

/* HV_PARTITION_PRIVILEGE_MASK (TLFS).  CPUID leaf 0x40000003 returns the
   low 32 bits in EAX and the high 32 bits in EBX.  Keep the two halves
   separate at the wasm boundary: a u64 export would become a BigInt in JS. */
#define HV_PRIV_LO_VP_RUNTIME       (1u << 0)
#define HV_PRIV_LO_REF_COUNTER      (1u << 1)
#define HV_PRIV_LO_SYNIC            (1u << 2)
#define HV_PRIV_LO_STIMER           (1u << 3)
#define HV_PRIV_LO_INTR_CTRL        (1u << 4)
#define HV_PRIV_LO_HYPERCALL_MSRS   (1u << 5)
#define HV_PRIV_LO_VP_INDEX         (1u << 6)
#define HV_PRIV_LO_RESET            (1u << 7)
#define HV_PRIV_LO_STATS            (1u << 8)
#define HV_PRIV_LO_REF_TSC          (1u << 9)
#define HV_PRIV_LO_GUEST_IDLE       (1u << 10)
#define HV_PRIV_LO_FREQUENCY        (1u << 11)
#define HV_PRIV_LO_REENLIGHTEN      (1u << 13)

#define HV_PRIV_HI_CREATE_PARTS     (1u << 0)  /* architectural bit 32 */
#define HV_PRIV_HI_PARTITION_ID     (1u << 1)
#define HV_PRIV_HI_MEMORY_POOL      (1u << 2)
#define HV_PRIV_HI_POST_MESSAGES    (1u << 4)
#define HV_PRIV_HI_SIGNAL_EVENTS    (1u << 5)
#define HV_PRIV_HI_CREATE_PORT      (1u << 6)
#define HV_PRIV_HI_CONNECT_PORT     (1u << 7)
#define HV_PRIV_HI_STATS            (1u << 8)
#define HV_PRIV_HI_DEBUGGING        (1u << 11)
#define HV_PRIV_HI_CPU_MANAGEMENT   (1u << 12)
#define HV_PRIV_HI_VSM              (1u << 16)
#define HV_PRIV_HI_VP_REGISTERS     (1u << 17)
#define HV_PRIV_HI_EXT_HYPERCALLS   (1u << 20)
#define HV_PRIV_HI_START_VP         (1u << 21)

/* A child receives the normal guest-facing privileges only.  In particular,
   it cannot create/manage sibling or child partitions, consume the host
   memory pool, or create virtual processors. */
#define HV_CHILD_PRIV_LO (HV_PRIV_LO_VP_RUNTIME | HV_PRIV_LO_REF_COUNTER | \
                          HV_PRIV_LO_SYNIC | HV_PRIV_LO_STIMER | \
                          HV_PRIV_LO_INTR_CTRL | HV_PRIV_LO_HYPERCALL_MSRS | \
                          HV_PRIV_LO_VP_INDEX | HV_PRIV_LO_REF_TSC)
#define HV_CHILD_PRIV_HI (HV_PRIV_HI_POST_MESSAGES | HV_PRIV_HI_SIGNAL_EVENTS)

#define HV_ROOT_PRIV_LO  (HV_CHILD_PRIV_LO | HV_PRIV_LO_RESET | \
                          HV_PRIV_LO_STATS | HV_PRIV_LO_GUEST_IDLE | \
                          HV_PRIV_LO_FREQUENCY | HV_PRIV_LO_REENLIGHTEN)
#define HV_ROOT_PRIV_HI  (HV_PRIV_HI_CREATE_PARTS | HV_PRIV_HI_PARTITION_ID | \
                          HV_PRIV_HI_MEMORY_POOL | HV_PRIV_HI_POST_MESSAGES | \
                          HV_PRIV_HI_SIGNAL_EVENTS | HV_PRIV_HI_CREATE_PORT | \
                          HV_PRIV_HI_CONNECT_PORT | HV_PRIV_HI_STATS | \
                          HV_PRIV_HI_DEBUGGING | HV_PRIV_HI_CPU_MANAGEMENT | \
                          HV_PRIV_HI_VSM | HV_PRIV_HI_VP_REGISTERS | \
                          HV_PRIV_HI_EXT_HYPERCALLS | HV_PRIV_HI_START_VP)

/* hypercall codes */
#define HC_GET_HV_INFO      0x0011u
#define HC_GET_REF_TIME     0x0012u
#define HC_GET_VP_INDEX     0x0013u
#define HC_CREATE_PART      0x0040u
#define HC_INIT_PART        0x0041u
#define HC_DEPOSIT_MEM      0x0043u
#define HC_WITHDRAW_MEM     0x0044u
#define HC_CREATE_VP        0x0047u
#define HC_SET_VP_REGISTERS 0x0050u
#define HC_MAP_GPA_PAGES    0x0053u
#define HC_POST_MESSAGE     0x005Cu
#define HC_SIGNAL_EVENT     0x005Du
#define HC_ENABLE_HC_PAGE   0x0060u
#define HC_VMBUS_OPEN       0x0061u
#define HC_VMBUS_CLOSE      0x0062u
#define HC_VMBUS_SIGNAL     0x0063u
#define HC_QUERY_MSR        0x0070u
#define HC_SET_MSR          0x0071u
#define HC_CPUID            0x0072u
#define HC_HALT             0x0090u

/* virtual MSRs (HV_ABI.md 2.4) */
#define MSR_GUEST_OS_ID     0x40000000u
#define MSR_HYPERCALL       0x40000001u
#define MSR_VP_INDEX        0x40000002u
#define MSR_TIME_REF_COUNT  0x40000020u
#define MSR_REFERENCE_TSC   0x40000021u
#define MSR_SCONTROL        0x40000080u
#define MSR_SIEFP           0x40000082u
#define MSR_SIMP            0x40000083u
#define MSR_EOM             0x40000084u
#define MSR_SINT0           0x40000090u
#define MSR_TPR             0x40000070u
#define MSR_EOI             0x40000071u
#define MSR_ICR             0x40000072u
#define MSR_APIC_SCONTROL   0x40000073u

/* VMBus frame types (HV_ABI.md 2.5) */
#define VMB_OFFER           1u
#define VMB_OFFER_ACCEPTED  2u
#define VMB_GPADL           3u
#define VMB_DATA            4u
#define VMB_CLOSE           5u

#define CH_CREATED          0u
#define CH_OFFERED          1u
#define CH_OPEN             2u
#define CH_CLOSED           3u

/* scheduling */
#define QUANTUM_MS          10u
#define INSTR_PER_MS        100u          /* 1 ms of guest time = 100 instr */
#define QUANTUM_INSTR       (QUANTUM_MS * INSTR_PER_MS)
#define ENTRY_BUDGET        64u           /* guest instructions per VM entry */
#define NS_PER_INSTR        10000u        /* 10 us per guest instruction    */

/* guest_field() indices (implemented in guest/guest.c) */
#define GF_STAGE       0u
#define GF_BOOT_FLAGS  1u
#define GF_HEARTBEAT   2u
#define GF_TIMER_HITS  3u
#define GF_PENDING     4u
#define GF_VMBUS_MSGS  5u
#define GF_CMDS        6u
#define GF_LAST_CMD    7u
#define GF_HALTED      8u

/* boot flag bits (guest) */
#define BF_CPUID       0x001u
#define BF_OSID        0x002u
#define BF_HYPERCALL   0x004u
#define BF_REFTIME     0x008u
#define BF_VPINDEX     0x010u
#define BF_SYNIC       0x020u
#define BF_TIMER       0x040u
#define BF_VMBUS       0x080u
#define BF_FB          0x100u

/* --------------------------------------------------------------- the arena */
static u8  PHYS[PHYS_MAX];                       /* "physical memory"       */
static u8  CANARY_PAT[PAGE];                     /* expected canary page    */
static u8  SCRATCH[SCRATCH_SIZE];                /* JS staging buffer       */
static char HLOG[HLOG_SIZE];                     /* hypervisor log          */
static u32 HLOG_LEN;
static char VENDOR[16] = "Microsoft Hv";

typedef struct { u32 owner; u32 gpa; u32 flags; u32 mapped; u32 dirty; } HostPage;
static HostPage PAGES[HOST_PAGES];

/* SynIC message (256 bytes, HV_ABI.md 2.5) */
typedef struct {
    u32 type;
    u32 size;
    u32 flags;
    u8  payload[MSG_SIZE - 12u];
} SynicMsg;

typedef struct { u32 msr; u32 lo; u32 hi; u32 valid; } MsrEntry;

typedef struct { u32 armed, sint, period, oneshot, direct, acc, fires, last, pending, masked; } SynthTimer;

typedef struct {
    u32 used;
    u32 part;                 /* partition index (0-based)                  */
    u32 index;                /* VP index inside the partition              */
    u32 state;                /* VS_*                                       */
    u32 run_ms;               /* consumed run time, ms                      */
    u32 run_us_frac;          /* sub-ms remainder, us                       */
    u64 run_ns;
    u32 hypercalls;
    u32 faults;
    u32 instr;
    u32 slice_left;
    u32 preempts;
    u32 regs[32];             /* HV_REGISTER_NAME data model                */
    u32 tpr, eoi, ipi_pending, ipi_vector, ipi_delivered;
    SynthTimer stimer[4];
    /* SynIC */
    u32 scontrol, simp, siefp, eom;
    u32 sint_vec[16], sint_masked[16], sint_auto_eoi[16], sint_count[16], sint_pending[16], sint_dropped[16];
    u32 event_flags[16];
    u32 msg_count, msg_dropped, events, msg_consumed;
    SynicMsg msgs[MSG_QUEUE];
    u32 msg_head, msg_tail;
    /* virtual MSRs */
    MsrEntry msrs[MAX_MSRS];
    /* legacy (root) partition-only convenience */
    u32 timer_fires, timer_last, timer_pending;
    u32 ref_seq, ref_scale, ref_offset_lo, ref_offset_hi;
    u32 rep_code, rep_total, rep_done, rep_start, rep_active, rep_status;
    u32 vmx_on, vmcs, vmcs_state, vmx_exit_reason, vmx_exit_qual, vmx_error, vmx_ept_generation, vmx_tlb_gpa, vmx_tlb_flags, vmx_tlb_valid;
    u32 vmx_interrupt_info, vmx_guest_if, vmx_interrupt_window, vmx_preempt_timer, vmx_nested, vmx_interrupt_delivered;
    u32 vmx_nested_reason, vmx_nested_reflect, vmx_nested_exit, vmx_nested_exit_qual, vmx_nested_merged;
    u32 vmx_vmcs12[VMX_NESTED_FIELDS], vmx_vmcs02[VMX_NESTED_FIELDS];
    u32 vmx_vpid, vmx_tlb_vpid, vmx_controls[4], vmx_host_state, vmx_guest_state;
    u32 vmx_msr_bitmap_msrs[8], vmx_msr_bitmap_flags[8];
    u32 vmx_io_bitmap_ports[8], vmx_io_bitmap_flags[8];
    u32 vtl_sint_vec[2][16], vtl_sint_masked[2][16], vtl_sint_pending[2][16], vtl_sint_count[2][16];
    u32 vtl_interrupt_pending[2], vtl_interrupt_vector[2], vtl_interrupt_delivered[2];
    u32 vtl_regs[2][32];
    /* Tiny guest-ISA context.  This is separate from the staged desktop
       guest state so a secure VTL1 image or nested L2 can be resumed at an
       instruction boundary after an exit. */
    u32 isa_active, isa_vtl, isa_secure, isa_entry, isa_rip, isa_code_end;
    u32 isa_steps, isa_faults, isa_last_exit, isa_last_qual, isa_halted, isa_status;
    u32 isa_regs[ISA_REGS];
} Vp;

typedef struct {
    u32 used;
    u32 state;                /* PS_*                                       */
    u32 is_root;
    u32 parent;               /* partition index of the parent (-1 = none)  */
    u32 generation;           /* external partition-id sequence              */
    u32 priv_lo;              /* CPUID 0x40000003 EAX                     */
    u32 priv_hi;              /* CPUID 0x40000003 EBX                     */
    u32 name_len;
    char name[NAME_LEN];
    u32 vp_count;
    u32 vps[MAX_VPS_PER_PART];
    u32 mapped_pages;
    u32 deposits;
    u32 hypercalls;
    u32 faults;
    u32 canary_faults;
    u32 runs;
    u32 has_guest;
    u32 win_first;            /* first host PFN of window+canaries          */
    u32 canary_lo, canary_hi; /* host PFNs of the guard pages               */
    u32 slat[GPA_PAGES];      /* (pfn << 3) | (W bit0, R bit1, X bit2)     */
    /* synthetic timer (2.5) */
    u32 timer_armed, timer_sint, timer_period, timer_oneshot, timer_acc;
    u32 timer_vp, timer_fires, timer_last, timer_pending, timer_masked;
    /* VMBus */
    u32 channel;
    /* guest console */
    u32 glog_len;
    char glog[GLOG_SIZE];
    /* MSR access log (ring of the last MSR_LOG accesses) */
    u32 msrlog_n, msrlog_head;
    struct { u32 msr, value, write; } msrlog[MSR_LOG];
    u32 weight, vtl_cap;
    u32 sched_left;
    u32 props[4];
    u32 device_tx[6], device_rx[6], device_status[6];
    u32 vtl_enabled, current_vtl, vtl_calls, vtl_returns, vtl_intercepts, vtl_intercept_gpa, vtl_intercept_access;
    u32 hvci_denies, kdp_denies, pcr, hyperguard_denies;
    u32 vsm_code_gpa, vsm_code_hash, vsm_code_ready;
    u8 vtl_perms[2][GPA_PAGES], vtl_perm_valid[2][GPA_PAGES];
    u8 hvci_signed[GPA_PAGES], kdp_protected[GPA_PAGES];
    u32 secret_len; u8 secure_secret[64];
} Partition;

static Partition PARTS[MAX_PARTS];
static Vp        VPS[MAX_VPS];
static u32 VMX_FIELDS[MAX_VPS][64];
static u8 VMX_EPT[MAX_VPS][GPA_PAGES];
static u8 VMX_EPT_AD[MAX_VPS][GPA_PAGES];
static u32 VMX_EPT_TABLE[MAX_VPS][4][512];
static u32 vmx_feature_control_reg;

typedef struct {
    u32 used, part, state, chid, generation;
    u32 offer_lo, offer_hi, ring_gpa;
    u32 in_bytes, out_bytes, messages, dropped;
    u32 version, gpadl_gpa, gpadl_pages, interrupt_mask, pending_send, rescinded;
} Channel;
static Channel CHANS[MAX_CHANNELS];

/* hypercall frame: 32 bytes, HV_ABI.md 2.3 */
typedef struct {
    u32 code, status, in_gpa, out_gpa, arg0, arg1, arg2, arg3;
} HvCallFrame;

/* ------------------------------- implemented in guest/guest.c, same image */
u32  guest_run(u32 part, u32 vp, u32 budget);
void guest_reset(u32 part, u32 vp);
void guest_timer_fire(u32 part);
u32  guest_field(u32 part, u32 f);
void guest_checkpoint_restore(u32 part, u32 stage, u32 heartbeat);
u32  guest_state_size(void);
u32  guest_state_save(u32 part, u32 dst, u32 max);
u32  guest_state_load(u32 part, u32 src, u32 len, u32 vp, u32 channel);
u32  hv_synic_eom(u32 vp);
i32  hv_vmbus_close(u32 ch);
u32  hv_isa_step(u32 vp, u32 budget);
u32  hv_isa_field(u32 vp, u32 field);

/* ------------------------------------------------------------- global state */
static u32 g_inited;
static u32 REF_TIME;                 /* ms since boot                        */
static u32 g_max_parts, g_max_vps, g_phys_bytes;
static u32 g_hypercalls;             /* every hv_vmcall                      */
static u32 g_slat_faults;            /* every SLAT violation                 */
static u32 g_owned, g_present, g_deposits;
static u32 g_slices, g_preemptions, g_ctx_switches, g_idle_slices;
static u32 rr_cursor;
/* One bounded framebuffer/progress sidecar per partition.  The public HVC1
   record remains 64 bytes for old callers; this sidecar supplies the roadmap's
   stronger restore guarantee without changing that record's layout. */
static u8  CHECKPOINT_FB[MAX_PARTS][FB_BYTES];
static u32 CHECKPOINT_VALID[MAX_PARTS], CHECKPOINT_HASH[MAX_PARTS];
static u32 CHECKPOINT_HEARTBEAT[MAX_PARTS], CHECKPOINT_STAGE[MAX_PARTS];

/* --------------------------------------------------------------------------
   Versioned bounded checkpoint store.  The legacy HVC1 save/restore ABI above
   remains unchanged.  This store is the management-facing partition image:
   four 1 MiB slots, generation-tagged handles, and a fixed section table.
   The image contains no host pointers; PFNs are represented as GPA mappings
   and restored into newly owned pages. */
#define CKPT_MAGIC              0x50435648u /* "HVCP" */
#define CKPT_VERSION            1u
#define CKPT_MAX                4u
#define CKPT_MAX_BYTES          (1024u * 1024u)
#define CKPT_HEADER_BYTES       32u
#define CKPT_SECTION_BYTES      16u
#define CKPT_SECTION_MAX        7u
#define CKPT_GUEST_MAX          4096u
#define CKPT_SEC_PARTITION      1u
#define CKPT_SEC_VPS            2u
#define CKPT_SEC_CHANNEL        3u
#define CKPT_SEC_GUEST          4u
#define CKPT_SEC_MAP            5u
#define CKPT_SEC_MEMORY         6u
#define CKPT_SEC_FRAMEBUFFER    7u

typedef struct {
    u32 type, offset, length, checksum;
} CkptSection;
typedef struct {
    u32 used, generation, source_id, source_state, creation_seq;
    u32 bytes, mapped_pages, memory_bytes, guest_bytes, vp_count, name_len;
    char name[NAME_LEN];
    u8 image[CKPT_MAX_BYTES];
} CkptSlot;
static CkptSlot CKPTS[CKPT_MAX];
static u32 CKPT_NEXT_GENERATION, CKPT_SEQUENCE, CKPT_LAST_STATUS;
static Partition CKPT_PART_TMP;
static Vp CKPT_VPS_TMP[MAX_VPS_PER_PART];
static Channel CKPT_CH_TMP;

static void *memcpy(void *dst, const void *src, u32 n);

static u32 ckpt_handle(const CkptSlot *c) {
    return (c->generation << ID_SLOT_BITS) | ((u32)(c - CKPTS) + 1u);
}
static CkptSlot *ckpt_of(u32 id) {
    u32 slot = id & ID_SLOT_MASK, generation;
    CkptSlot *c;
    if (!slot || slot > CKPT_MAX) return 0;
    c = &CKPTS[slot - 1u];
    generation = id >> ID_SLOT_BITS;
    return (c->used && c->generation == generation) ? c : 0;
}
static u32 ckpt_fnv(const u8 *p, u32 n) {
    u32 h = 2166136261u;
    while (n--) { h ^= *p++; h *= 16777619u; }
    return h;
}
static u32 ckpt_u32(const u8 *p) {
    u32 v; memcpy(&v, p, 4u); return v;
}
static void ckpt_put_u32(u8 *p, u32 v) { memcpy(p, &v, 4u); }

static Partition *part_of(u32 id);
static u32 part_id_of(const Partition *p);

/* ------------------------------------------------ freestanding libc subset */
static void *memcpy(void *dst, const void *src, u32 n) {
    u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
    while (n--) *d++ = *s++;
    return dst;
}
static void *memset(void *dst, int c, u32 n) {
    u8 *d = (u8 *)dst;
    while (n--) *d++ = (u8)c;
    return dst;
}
static u32 slen(const char *s) { u32 n = 0; while (s[n]) n++; return n; }

/* ------------------------------------------------------------------ logging */
static void log_char(char c) { if (HLOG_LEN < HLOG_SIZE - 1u) HLOG[HLOG_LEN++] = c; }
static void log_str(const char *s) { while (*s) log_char(*s++); }
static void log_num(u32 v) {
    char b[12]; u32 n = 0;
    if (!v) { log_char('0'); return; }
    while (v) { b[n++] = (char)('0' + (v % 10u)); v /= 10u; }
    while (n) log_char(b[--n]);
}
static void log_hex(u32 v) {
    const char *h = "0123456789ABCDEF";
    i32 i;
    log_char('0'); log_char('x');
    for (i = 28; i >= 0; i -= 4) log_char(h[(v >> (u32)i) & 15u]);
}

void hv_guest_log(u32 part_id, const char *s) {   /* called by the guest */
    Partition *p = part_of(part_id);
    u32 n = slen(s);
    if (!p) return;
    if (p->glog_len + n + 1u < GLOG_SIZE) {
        memcpy(p->glog + p->glog_len, s, n);
        p->glog_len += n;
        p->glog[p->glog_len++] = '\n';
    }
}

/* -------------------------------------------------------------- accessors */
static u32 part_slot(u32 id) {
    u32 slot = id & ID_SLOT_MASK;
    if (!slot || slot > MAX_PARTS) return MAX_PARTS;
    return slot - 1u;
}
static u32 part_id_of(const Partition *p) {
    return (p->generation << ID_SLOT_BITS) | ((u32)(p - PARTS) + 1u);
}
static Partition *part_of(u32 id) {
    u32 slot = part_slot(id), generation;
    Partition *p;
    if (slot >= MAX_PARTS) return 0;
    p = &PARTS[slot];
    generation = id >> ID_SLOT_BITS;
    return (p->used && p->generation == generation) ? p : 0;
}
static u32 part_has_priv(Partition *p, u32 lo, u32 hi) {
    if (!p) return 0u;
    return ((p->priv_lo & lo) == lo && (p->priv_hi & hi) == hi) ? 1u : 0u;
}
static Vp *vp_of(u32 id) {
    if (id < 1u || id > MAX_VPS) return 0;
    Vp *v = &VPS[id - 1u];
    return v->used ? v : 0;
}
static u32 chan_slot(u32 id) {
    u32 slot = id & ID_SLOT_MASK;
    if (!slot || slot > MAX_CHANNELS) return MAX_CHANNELS;
    return slot - 1u;
}
static u32 chan_id_of(const Channel *c) {
    return (c->generation << ID_SLOT_BITS) | ((u32)(c - CHANS) + 1u);
}
static Channel *chan_of(u32 id) {
    u32 slot = chan_slot(id), generation;
    Channel *c;
    if (slot >= MAX_CHANNELS) return 0;
    c = &CHANS[slot];
    generation = id >> ID_SLOT_BITS;
    return (c->used && c->generation == generation) ? c : 0;
}

/* -------------------------------------------------------------------- SLAT */
/* SLAT entry = (PFN << 3) | permissions.  Bit 1 is the legacy "present"
   (read) bit, bit 0 is writable, and bit 2 is executable.  Keeping R/W in
   their old positions preserves hv_gpa_state for existing callers while the
   third bit makes execute checks explicit. */
#define SLAT_W 1u
#define SLAT_R 2u
#define SLAT_X 4u
static u32 slat_pfn(Partition *p, u32 gpa, u32 *flags) {
    u32 e;
    if (gpa >= GPA_LIMIT) return 0;
    e = p->slat[gpa >> PAGE_SHIFT];
    if (!e) return 0;
    if (flags) *flags = e & 7u;
    return e >> 3;
}
static u32 slat_set(Partition *p, u32 gpa, u32 pfn, u32 flags) {
    if (gpa >= GPA_LIMIT) return 0;
    p->slat[gpa >> PAGE_SHIFT] = (pfn << 3) | (flags & 7u);
    return 1;
}
static u32 gpa_state_of(Partition *p, u32 gpa) {
    u32 e, fl;
    if (gpa >= GPA_LIMIT) return 0u;
    e = p->slat[gpa >> PAGE_SHIFT];
    if (!e) return 0u;
    fl = e & 7u;
    if (!(fl & SLAT_R)) return 1u;              /* mapped, not readable    */
    return (fl & SLAT_W) ? 3u : 2u;             /* rw : ro                  */
}

/* host page allocator: first-fit contiguous run of n free pages */
static u32 alloc_run(u32 n) {
    u32 i, run = 0, start = 0;
    if (!n) return 0;
    for (i = 0; i < HOST_PAGES; i++) {
        if (!PAGES[i].owner) {
            if (!run) start = i;
            run++;
            if (run == n) {
                u32 k;
                for (k = start; k < start + n; k++) {
                    PAGES[k].owner = 1u;         /* owner fixed up by caller */
                    PAGES[k].mapped = 0;
                    PAGES[k].gpa = 0;
                    PAGES[k].flags = 0;
                }
                return start;
            }
        } else run = 0;
    }
    return 0;                                    /* 0 = failure (PFN 0 rare) */
}
static void free_run(u32 first, u32 n, u32 part_idx) {
    u32 k, id = part_idx + 1u;
    for (k = first; k < first + n && k < HOST_PAGES; k++) {
        if (PAGES[k].owner != id) continue;
        if (PAGES[k].mapped) g_present--;
        PAGES[k].owner = 0;
        PAGES[k].gpa = 0;
        PAGES[k].flags = 0;
        PAGES[k].mapped = 0;
        if (g_owned) g_owned--;
    }
}
static void pages_own(u32 first, u32 n, u32 part_idx) {
    u32 k, id = part_idx + 1u;
    for (k = first; k < first + n && k < HOST_PAGES; k++) PAGES[k].owner = id;
}

/* ------------------------------------------------------------------ faults */
static void part_fault(Partition *p, u32 gpa, const char *why) {
    p->faults++;
    g_slat_faults++;
    log_str("hv: partition "); log_num(part_id_of(p));
    log_str(" SLAT fault ("); log_str(why); log_str(") gpa ");
    log_hex(gpa); log_char('\n');
    if (p->state != PS_FAULTED && p->state != PS_DELETED) p->state = PS_FAULTED;
}

/* guest-mediated access: the ONLY way the guest touches memory */
u32 hv_g_load(u32 part_id, u32 gpa, u32 dst, u32 len);
u32 hv_g_load(u32 part_id, u32 gpa, u32 dst, u32 len) {
    Partition *p = part_of(part_id);
    u32 off = 0;
    if (!p || !len) return 0;
    while (off < len) {
        u32 a = gpa + off, f, pfn, chunk;
        u8 *hp;
        pfn = slat_pfn(p, a, &f);
        if (!pfn || !(f & SLAT_R)) { part_fault(p, a, "load/read"); return 0; }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        hp = &PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))];
        memcpy((u8 *)(dst + off), hp, chunk);
        off += chunk;
    }
    return len;
}
u32 hv_g_store(u32 part_id, u32 gpa, u32 src, u32 len);
u32 hv_g_store(u32 part_id, u32 gpa, u32 src, u32 len) {
    Partition *p = part_of(part_id);
    u32 off = 0;
    if (!p || !len) return 0;
    while (off < len) {
        u32 a = gpa + off, f, pfn, chunk;
        u8 *hp;
        pfn = slat_pfn(p, a, &f);
        if (!pfn || !(f & SLAT_R)) { part_fault(p, a, "store/read"); return 0; }
        if (!(f & SLAT_W)) { part_fault(p, a, "store to read-only page"); return 0; }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        hp = &PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))];
        memcpy(hp, (const u8 *)(src + off), chunk);
        PAGES[pfn].dirty = 1u;
        off += chunk;
    }
    return len;
}
/* hypervisor-privileged access (JS side / hypercall buffer validation) */
static u32 hv_mem_read(Partition *p, u32 gpa, u32 dst, u32 len, u32 fault) {
    u32 off = 0;
    if (!p || !len) return 0;
    while (off < len) {
        u32 a = gpa + off, f, pfn, chunk;
        pfn = slat_pfn(p, a, &f);
        if (!pfn || !(f & SLAT_R)) {
            if (fault) part_fault(p, a, "read");
            else { log_str("hv: read of unmapped gpa "); log_hex(a); log_char('\n'); }
            return 0;
        }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        memcpy((u8 *)(dst + off), &PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))], chunk);
        off += chunk;
    }
    return len;
}
static u32 hv_mem_write(Partition *p, u32 gpa, u32 src, u32 len, u32 fault) {
    u32 off = 0;
    if (!p || !len) return 0;
    while (off < len) {
        u32 a = gpa + off, f, pfn, chunk;
        pfn = slat_pfn(p, a, &f);
        if (!pfn || !(f & SLAT_R)) {
            if (fault) part_fault(p, a, "write");
            else { log_str("hv: write to unmapped gpa "); log_hex(a); log_char('\n'); }
            return 0;
        }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        memcpy(&PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))], (const u8 *)(src + off), chunk);
        PAGES[pfn].dirty = 1u;
        off += chunk;
    }
    return len;
}
static void publish_reference_tsc(Vp *v) {
    Partition *p = &PARTS[v->part];
    u32 page[4];
    page[0] = v->ref_seq; page[1] = v->ref_scale;
    page[2] = v->ref_offset_lo; page[3] = v->ref_offset_hi;
    if (p->has_guest) (void)hv_mem_write(p, TSC_GPA, (u32)page, sizeof(page), 0u);
}

/* ------------------------------------------------------------------ canary */
static void canary_fill(Partition *p) {
    u32 i;
    for (i = 0; i < PAGE; i++) {
        PHYS[(p->canary_lo << PAGE_SHIFT) + i] = CANARY_PAT[i];
        PHYS[(p->canary_hi << PAGE_SHIFT) + i] = CANARY_PAT[i];
    }
}
static u32 canary_check(Partition *p) {
    u32 i, w, *a, *b;
    if (!p->canary_lo) return 0;
    a = (u32 *)&PHYS[p->canary_lo << PAGE_SHIFT];
    b = (u32 *)CANARY_PAT;
    w = PAGE / 4u;
    for (i = 0; i < w; i++) if (a[i] != b[i]) {
        p->canary_faults++;
        p->faults++;
        g_slat_faults++;
        log_str("hv: GUEST ISOLATION VIOLATION - canary page ");
        log_hex((p->canary_lo << PAGE_SHIFT) + (i * 4u));
        log_str(" under partition "); log_num(part_id_of(p));
        log_str(" was modified; partition faulted (state 6)\n");
        p->state = PS_FAULTED;
        return 1;
    }
    a = (u32 *)&PHYS[p->canary_hi << PAGE_SHIFT];
    for (i = 0; i < w; i++) if (a[i] != b[i]) {
        p->canary_faults++;
        p->faults++;
        g_slat_faults++;
        log_str("hv: GUEST ISOLATION VIOLATION - canary page ");
        log_hex((p->canary_hi << PAGE_SHIFT) + (i * 4u));
        log_str(" under partition "); log_num(part_id_of(p));
        log_str(" was modified; partition faulted (state 6)\n");
        p->state = PS_FAULTED;
        return 1;
    }
    return 0;
}

/* -------------------------------------------------------------------- VPs */
static Vp *vp_alloc(u32 part_idx, u32 index) {
    u32 i;
    for (i = 0; i < MAX_VPS; i++) {
        if (!VPS[i].used) {
            Vp *v = &VPS[i];
            memset(v, 0, sizeof(*v));
            v->used = 1;
            v->part = part_idx;
            v->index = index;
            v->state = VS_CREATED;
            v->slice_left = QUANTUM_INSTR;
            v->ref_seq = 1u; v->ref_scale = 1u;
            for (u32 s = 0; s < 16u; s++) { v->sint_vec[s] = 0x20u + s; v->sint_masked[s] = 1u; }
            return v;
        }
    }
    return 0;
}

/* --------------------------------------------------------------- MSR log */
static void msrlog_add(Partition *p, u32 msr, u32 value, u32 write) {
    u32 slot = p->msrlog_head % MSR_LOG;
    p->msrlog[slot].msr = msr;
    p->msrlog[slot].value = value;
    p->msrlog[slot].write = write;
    p->msrlog_head++;
    if (p->msrlog_n < MSR_LOG) p->msrlog_n++;
}

/* ------------------------------------------------------ virtual MSR access */
static u32 msr_read(Vp *v, u32 msr, u32 *lo, u32 *hi) {
    u32 i;
    Partition *p = &PARTS[v->part];
    *lo = 0; *hi = 0;
    if (msr == MSR_VP_INDEX) {
        if (!part_has_priv(p, HV_PRIV_LO_VP_INDEX, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = v->index; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_HYPERCALL && !part_has_priv(p, HV_PRIV_LO_HYPERCALL_MSRS, 0u)) return HV_STATUS_ACCESS_DENIED;
    if (msr == MSR_TIME_REF_COUNT) {
        if (!part_has_priv(p, HV_PRIV_LO_REF_COUNTER, 0u)) return HV_STATUS_ACCESS_DENIED;
        u64 t = (u64)REF_TIME * 10000ULL;        /* 100 ns units */
        *lo = (u32)(t & 0xFFFFFFFFu);
        *hi = (u32)(t >> 32);
        return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_REFERENCE_TSC) {
        if (!part_has_priv(p, HV_PRIV_LO_REF_TSC, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = TSC_GPA | 1u; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SIMP) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = v->simp; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SIEFP) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = v->siefp; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SCONTROL) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = v->scontrol; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_EOM) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        *lo = v->eom; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_TPR) { *lo = v->tpr; return HV_STATUS_SUCCESS; }
    if (msr == MSR_EOI) { *lo = v->eoi; return HV_STATUS_SUCCESS; }
    if (msr == MSR_ICR) { *lo = v->ipi_vector; return HV_STATUS_SUCCESS; }
    if (msr >= MSR_SINT0 && msr < MSR_SINT0 + 16u) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        u32 k = msr - MSR_SINT0;
        *lo = v->sint_vec[k] | (v->sint_masked[k] ? 0x10000u : 0u) | (v->sint_auto_eoi[k] ? 0x20000u : 0u);
        return HV_STATUS_SUCCESS;
    }
    for (i = 0; i < MAX_MSRS; i++)
        if (v->msrs[i].valid && v->msrs[i].msr == msr) { *lo = v->msrs[i].lo; *hi = v->msrs[i].hi; return HV_STATUS_SUCCESS; }
    return HV_STATUS_NOT_IMPLEMENTED;
}
static u32 msr_write(Vp *v, u32 msr, u32 lo, u32 hi) {
    u32 i;
    Partition *p = &PARTS[v->part];
    if (msr == MSR_VP_INDEX) return HV_STATUS_ACCESS_DENIED;   /* read only */
    if (msr == MSR_HYPERCALL && !part_has_priv(p, HV_PRIV_LO_HYPERCALL_MSRS, 0u)) return HV_STATUS_ACCESS_DENIED;
    if (msr == MSR_SIMP) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        v->simp = lo; msrlog_add(p, msr, lo, 1u); return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SIEFP) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        v->siefp = lo; msrlog_add(p, msr, lo, 1u); return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SCONTROL) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        v->scontrol = lo; msrlog_add(p, msr, lo, 1u); return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_EOM) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        v->eom = lo; return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_TPR) { v->tpr = lo & 0xFFu; return HV_STATUS_SUCCESS; }
    if (msr == MSR_EOI) { v->eoi = lo; return hv_synic_eom((u32)(v - VPS) + 1u); }
    if (msr == MSR_ICR) { v->ipi_vector = lo & 0xFFu; v->ipi_pending = 1u; return HV_STATUS_SUCCESS; }
    if (msr >= MSR_SINT0 && msr < MSR_SINT0 + 16u) {
        if (!part_has_priv(p, HV_PRIV_LO_SYNIC, 0u)) return HV_STATUS_ACCESS_DENIED;
        u32 k = msr - MSR_SINT0;
        v->sint_vec[k] = lo & 0xFFu;
        v->sint_masked[k] = (lo & 0x10000u) ? 1u : 0u;
        v->sint_auto_eoi[k] = (lo & 0x20000u) ? 1u : 0u;
        v->sint_count[k] = 0;
        msrlog_add(p, msr, lo, 1u);
        return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_TIME_REF_COUNT) return HV_STATUS_ACCESS_DENIED;
    for (i = 0; i < MAX_MSRS; i++) {
        if (v->msrs[i].valid && v->msrs[i].msr == msr) {
            v->msrs[i].lo = lo; v->msrs[i].hi = hi;
            msrlog_add(&PARTS[v->part], msr, lo, 1u);
            return HV_STATUS_SUCCESS;
        }
    }
    for (i = 0; i < MAX_MSRS; i++) {
        if (!v->msrs[i].valid) {
            v->msrs[i].valid = 1u; v->msrs[i].msr = msr;
            v->msrs[i].lo = lo; v->msrs[i].hi = hi;
            msrlog_add(&PARTS[v->part], msr, lo, 1u);
            return HV_STATUS_SUCCESS;
        }
    }
    return HV_STATUS_INSUFFICIENT_MEM;
}

/* ------------------------------------------------------------------ CPUID */
static u32 cpuid_leaf(u32 leaf, u32 subleaf, u32 *out, u32 priv_lo, u32 priv_hi) {
    out[0] = out[1] = out[2] = out[3] = 0;
    if (leaf == 0x00000001u) {                     /* hypervisor-present bit */
        out[0] = 0x00000600u;                      /* family/model            */
        out[2] = 0x80000020u;                      /* ECX[5] VMX, ECX[31] HV  */
        return 1u;
    }
    switch (leaf) {
    case 0x40000000u:
        out[0] = MAX_LEAF;
        out[1] = VENDOR0; out[2] = VENDOR1; out[3] = VENDOR2;
        return 1u;
    case 0x40000001u:
        out[0] = HV_SIGNATURE;                     /* "Hv#1"                  */
        out[1] = 0x00000001u;
        return 1u;
    case 0x40000002u:                              /* version                 */
        out[0] = HV_VERSION;
        out[1] = 0x00000080u;                      /* build                   */
        out[2] = 0x00000001u;                      /* major.minor             */
        return 1u;
    case 0x40000003u:                              /* privilege mask          */
        out[0] = priv_lo;
        out[1] = priv_hi;
        return 1u;
    case 0x40000004u:                              /* recommendations         */
        out[0] = 0x00000001u;
        return 1u;
    case 0x40000005u:                              /* implementation limits   */
        out[0] = g_max_vps;
        out[1] = g_max_parts;
        out[2] = HOST_PAGES;
        return 1u;
    case 0x40000006u:                              /* hardware features       */
        out[0] = 0x0000003Fu;
        return 1u;
    default:
        return (leaf == 0u) ? 0u : 0u;
    }
}
u32 hv_cpuid(u32 part, u32 leaf, u32 subleaf, u32 out_ptr);
u32 hv_cpuid(u32 part, u32 leaf, u32 subleaf, u32 out_ptr) {
    u32 v[4];
    Partition *p = part ? part_of(part) : &PARTS[0];
    if (!p) return 0u;
    cpuid_leaf(leaf, subleaf, v, p->priv_lo, p->priv_hi);
    if (out_ptr) memcpy((u8 *)out_ptr, v, 16);
    return v[0] | (v[1] | (v[2] | v[3]));          /* nonzero if any field    */
}

/* ------------------------------------------------------------- SynIC post */
static u32 synic_post(Vp *v, const SynicMsg *m) {
    u32 next = (v->msg_tail + 1u) % MSG_QUEUE;
    if (next == v->msg_head) { v->msg_dropped++; return 0; }
    v->msgs[v->msg_tail] = *m;
    v->msg_tail = next;
    v->msg_count++;
    v->events++;
    if (m->type < 16u) {
        v->sint_pending[m->type] = 1u;
        if (v->sint_masked[m->type]) v->sint_dropped[m->type]++;
        else v->sint_count[m->type]++;
    }
    return 1;
}
static u32 root_vp_id(void) {
    Partition *r = &PARTS[0];
    if (!r->used || !r->vp_count) return 0;
    return r->vps[0];
}

/* ------------------------------------------------------ partition helpers */
static void part_release_window(Partition *p) {
    u32 i;
    if (!p->win_first) return;
    for (i = 0; i < GPA_PAGES; i++) p->slat[i] = 0;
    free_run(p->win_first, GPA_PAGES + 2u, (u32)(p - PARTS));
    p->win_first = p->canary_lo = p->canary_hi = 0;
    p->mapped_pages = 0;
}

/* --------------------------------------------------------- VMBus plumbing */
/* a ring is {u32 write, u32 read, u32 bytes, u32 state} + 4 KB of frames
   {u32 type, u32 len, u8 data[]}; the producer appends at `write`, the
   consumer drains at `read` and both reset when the ring empties.           */
static u32 ring_post(u32 part_id, u32 ring_gpa, u32 type, const u8 *data, u32 len) {
    u32 hdr[4], frame[2];
    u32 off, need;
    u8 tmp[256];
    if (len > 248u) return 0;
    if (!hv_g_load(part_id, ring_gpa, (u32)hdr, RING_HDR)) return 0;
    need = 8u + len;
    off = hdr[0];
    if (off + need > RING_DATA) return 0;                     /* drop */
    frame[0] = type; frame[1] = len;
    if (!hv_g_store(part_id, ring_gpa + RING_HDR + off, (u32)frame, 8)) return 0;
    if (len) {
        memcpy(tmp, data, len);
        if (!hv_g_store(part_id, ring_gpa + RING_HDR + off + 8u, (u32)tmp, len)) return 0;
    }
    hdr[0] = off + need;
    hdr[2] += need;
    if (!hv_g_store(part_id, ring_gpa, (u32)hdr, RING_HDR)) return 0;
    return len;
}
static u32 ring_pop(u32 part_id, u32 ring_gpa, u32 *type, u32 dst, u32 max) {
    u32 hdr[4], frame[2], off, need, n;
    if (!hv_g_load(part_id, ring_gpa, (u32)hdr, RING_HDR)) return 0;
    if (!hdr[2]) return 0;
    off = hdr[1];
    if (off + 8u > RING_DATA) {                      /* wrap/emptied */
        hdr[1] = 0; hdr[2] = 0; hdr[0] = 0;
        hv_g_store(part_id, ring_gpa, (u32)hdr, RING_HDR);
        return 0;
    }
    if (!hv_g_load(part_id, ring_gpa + RING_HDR + off, (u32)frame, 8)) return 0;
    need = 8u + frame[1];
    if (off + need > RING_DATA) {
        hdr[1] = 0; hdr[2] = 0; hdr[0] = 0;
        hv_g_store(part_id, ring_gpa, (u32)hdr, RING_HDR);
        return 0;
    }
    n = frame[1];
    if (type) *type = frame[0];
    if (n > max) n = max;
    if (n && !hv_g_load(part_id, ring_gpa + RING_HDR + off + 8u, dst, n)) return 0;
    hdr[1] = off + need;
    if (hdr[2] >= need) hdr[2] -= need; else hdr[2] = 0;
    if (!hdr[2]) { hdr[1] = 0; hdr[0] = 0; }
    if (!hv_g_store(part_id, ring_gpa, (u32)hdr, RING_HDR)) return 0;
    return n;
}

/* ------------------------------------------------------------- the timer */
static void timer_fire(Partition *p) {
    Vp *v = vp_of(p->timer_vp);
    p->timer_fires++;
    p->timer_last = REF_TIME;
    p->timer_pending++;
    if (v) { v->timer_fires = p->timer_fires; v->timer_last = p->timer_last; v->timer_pending = p->timer_pending; }
    if (v && v->sint_masked[p->timer_sint & 15u]) { p->timer_masked++; v->sint_dropped[p->timer_sint & 15u]++; }
    else if (v) { v->sint_count[p->timer_sint & 15u]++; v->sint_pending[p->timer_sint & 15u] = 1u; }
    guest_timer_fire(part_id_of(p));
    if (p->timer_fires <= 3u) {
        log_str("hv: synthetic timer (SINT"); log_num(p->timer_sint);
        log_str(") fired for partition "); log_num(part_id_of(p));
        log_str(" at "); log_num(REF_TIME); log_str(" ms\n");
    }
}

/* ----------------------------------------------------------- dispatch */
static Vp *next_vp(void) {
    u32 i, k, any = 0, best = 0, best_left = 0;
    /* Weighted round-robin is deliberately partition based: a four-VP
       partition receives one share of its weight, then its VPs rotate. */
    for (i = 0; i < MAX_PARTS; i++) {
        Partition *p = &PARTS[i];
        u32 j, runnable = 0;
        if (!p->used || p->state != PS_RUNNING || !p->has_guest) continue;
        for (j = 0; j < p->vp_count; j++) {
            Vp *v = vp_of(p->vps[j]);
            if (v && v->state == VS_RUNNING) { runnable = 1; break; }
        }
        if (!runnable) continue;
        any = 1;
        if (p->sched_left > best_left) { best_left = p->sched_left; best = i + 1u; }
    }
    if (!any) return 0;
    if (!best_left) {
        /* A bounded cycle makes the exact integer weight ratio observable and
           also handles a weight change without accumulating stale credit. */
        for (i = 0; i < MAX_PARTS; i++) {
            Partition *p = &PARTS[i];
            u32 j, runnable = 0;
            if (!p->used || p->state != PS_RUNNING || !p->has_guest) continue;
            for (j = 0; j < p->vp_count; j++) {
                Vp *v = vp_of(p->vps[j]);
                if (v && v->state == VS_RUNNING) { runnable = 1; break; }
            }
            if (runnable) p->sched_left = p->weight ? p->weight : 1u;
        }
        best = 0; best_left = 0;
        for (i = 0; i < MAX_VPS; i++) {
            k = (rr_cursor + i) % MAX_VPS;
            if (!VPS[k].used || VPS[k].state != VS_RUNNING) continue;
            if (PARTS[VPS[k].part].state != PS_RUNNING || !PARTS[VPS[k].part].has_guest) continue;
            if (PARTS[VPS[k].part].sched_left > best_left) {
                best_left = PARTS[VPS[k].part].sched_left;
                best = VPS[k].part + 1u;
            }
        }
    }
    if (!best) return 0;
    PARTS[best - 1u].sched_left--;
    for (i = 0; i < MAX_VPS; i++) {
        k = (rr_cursor + i) % MAX_VPS;
        if (!VPS[k].used || VPS[k].state != VS_RUNNING || VPS[k].part != best - 1u) continue;
        if (PARTS[VPS[k].part].state != PS_RUNNING || !PARTS[VPS[k].part].has_guest) continue;
        rr_cursor = (k + 1u) % MAX_VPS;
        return &VPS[k];
    }
    return 0;
}

u32 hv_vm_entry(u32 vp);
u32 hv_vm_entry(u32 vp) {
    Vp *v = vp_of(vp);
    Partition *p;
    u32 ran;
    if (!v || v->state != VS_RUNNING) return 0;
    p = &PARTS[v->part];
    if (p->state != PS_RUNNING || !p->has_guest) return 0;
    if (v->vmx_exit_reason == VMX_EXIT_PREEMPT_TIMER) return 0;
    if (p->vtl_enabled && v->vtl_interrupt_pending[VTL1]) {
        v->vtl_interrupt_delivered[VTL1] = v->vtl_interrupt_vector[VTL1];
        v->vtl_interrupt_pending[VTL1] = 0u;
        p->current_vtl = VTL1;
    }
    if (v->vmx_on && v->vmcs_state == 2u && v->vmx_guest_if && v->ipi_pending) {
        v->vmx_interrupt_delivered = v->vmx_interrupt_info;
        v->ipi_pending = 0u; v->vmx_interrupt_window = 0u;
    }
    if (v->ipi_pending) { v->ipi_delivered = v->ipi_vector; v->ipi_pending = 0u; }
    publish_reference_tsc(v);
    if (v->isa_active) {
        /* The ISA path is resumable at every instruction boundary.  The
           legacy staged image remains available for the desktop boot, while
           secure VTL1 and nested L2 images take this mediated path. */
        ran = hv_isa_step((u32)(v - VPS) + 1u, ENTRY_BUDGET);
    } else {
        ran = guest_run(part_id_of(p), (u32)(v - VPS) + 1u, ENTRY_BUDGET);
    }
    v->instr += ran;
    /* isolation check: the guest's guard pages must be untouched */
    if (canary_check(p)) return 0;
    if ((v->isa_active && v->isa_halted) || (!v->isa_active && guest_field(part_id_of(p), GF_HALTED))) {
        v->state = VS_HALTED;
        if (p->state == PS_RUNNING) p->state = PS_STOPPED;
    }
    return (v->state == VS_RUNNING && p->state == PS_RUNNING) ? 1u : 0u;
}
static u32 vm_entry_batch(Vp *v, u32 budget) {
    u32 used = 0;
    while (used < budget) {
        u32 before = v->instr;
        u32 d;
        if (!hv_vm_entry((u32)(v - VPS) + 1u)) break;
        d = v->instr - before;
        if (!d) d = 1u;
        used += d;
        if (PARTS[v->part].state != PS_RUNNING) break;
    }
    return used;
}

/* =========================================================================
   Exported API — HV_ABI.md 2.1 .. 2.6
   ========================================================================= */

/* --------------------------------------------------------------------- init */
u32 hv_init(u32 ref_time_ms, u32 max_partitions, u32 max_vps, u32 phys_bytes);
u32 hv_init(u32 ref_time_ms, u32 max_partitions, u32 max_vps, u32 phys_bytes) {
    u32 i;
    Partition *r;
    u32 pfn;
    memset(PARTS, 0, sizeof(PARTS));
    memset(VPS, 0, sizeof(VPS));
    memset(VMX_FIELDS, 0, sizeof(VMX_FIELDS)); memset(VMX_EPT, 0, sizeof(VMX_EPT)); memset(VMX_EPT_AD, 0, sizeof(VMX_EPT_AD)); memset(VMX_EPT_TABLE, 0, sizeof(VMX_EPT_TABLE));
    memset(CHANS, 0, sizeof(CHANS));
    memset(CKPTS, 0, sizeof(CKPTS));
    memset(PAGES, 0, sizeof(PAGES));
    HLOG_LEN = 0;
    REF_TIME = ref_time_ms;
    g_max_parts = max_partitions ? max_partitions : MAX_PARTS;
    if (g_max_parts > MAX_PARTS) g_max_parts = MAX_PARTS;
    g_max_vps = max_vps ? max_vps : MAX_VPS;
    if (g_max_vps > MAX_VPS) g_max_vps = MAX_VPS;
    g_phys_bytes = phys_bytes ? phys_bytes : PHYS_MAX;
    if (g_phys_bytes > PHYS_MAX) g_phys_bytes = PHYS_MAX;
    g_hypercalls = g_slat_faults = g_owned = g_present = g_deposits = 0;
    g_slices = g_preemptions = g_ctx_switches = g_idle_slices = 0;
    rr_cursor = 0;
    vmx_feature_control_reg = 0;
    CKPT_NEXT_GENERATION = 1u;
    CKPT_SEQUENCE = 0u;
    CKPT_LAST_STATUS = HV_STATUS_SUCCESS;
    for (i = 0; i < PAGE; i++) CANARY_PAT[i] = (u8)(0xA5u ^ (u8)(i * 7u));
    /* the root partition: created here and never deletable */
    r = &PARTS[0];
    r->used = 1;
    r->state = PS_RUNNING;
    r->is_root = 1;
    r->parent = 0xFFFFFFFFu;
    r->priv_lo = HV_ROOT_PRIV_LO;
    r->priv_hi = HV_ROOT_PRIV_HI;
    r->weight = 1u; r->sched_left = 0; r->props[0] = r->priv_lo; r->props[1] = r->priv_hi;
    memcpy(r->name, "ROOT", 4);
    r->name_len = 4;
    /* reserve PFN 0 so that alloc_run()'s 0 return is unambiguously a failure */
    PAGES[0].owner = 0xFFu;
    PAGES[0].flags = 0;
    g_owned = 1u;
    r->win_first = alloc_run(2u);                     /* root guard pages only */
    if (r->win_first) {
        pages_own(r->win_first, 2u, 0u);
        g_owned += 2u;
        r->canary_lo = r->win_first;
        r->canary_hi = r->win_first + 1u;
        canary_fill(r);
        /* the root partition gets a small identity window so JS can deposit */
        for (i = 0; i < 8u; i++) {
            pfn = alloc_run(1u);
            if (pfn) { pages_own(pfn, 1u, 0u); PAGES[pfn].mapped = 1; PAGES[pfn].gpa = i * PAGE; PAGES[pfn].flags = SLAT_R | SLAT_W | SLAT_X; r->slat[i] = (pfn << 3) | (SLAT_R | SLAT_W | SLAT_X); g_owned++; g_present++; g_deposits++; r->mapped_pages++; r->deposits++; }
        }
    }
    g_inited = 1;
    {
        Vp *rv = vp_alloc(0u, 0u);          /* the root partition's VP 0     */
        if (rv) {
            rv->state = VS_CREATED;         /* never dispatched: no guest     */
            r->vps[r->vp_count++] = (u32)(rv - VPS) + 1u;
        }
    }
    log_str("hv: hypervisor up - magic "); log_hex(HV_MAGIC);
    log_str(" vendor \"Microsoft Hv\" maxparts "); log_num(g_max_parts);
    log_str(" maxvps "); log_num(g_max_vps);
    log_str(" phys "); log_num(g_phys_bytes); log_str(" bytes\n");
    log_str("hv: root partition created (id 1), cannot be deleted\n");
    return HV_MAGIC;
}

u32 hv_root_partition(void);
u32 hv_root_partition(void) { return 1u; }

/* ------------------------------------------------------------- partitions */
u32 hv_partition_create(u32 name_ptr, u32 name_len);
u32 hv_partition_create(u32 name_ptr, u32 name_len) {
    u32 i, n = 0, generation = 0;
    Partition *p = 0;
    const char *nm = (const char *)name_ptr;
    for (i = 0; i < MAX_PARTS; i++) {
        if (PARTS[i].used) n++;
        else if (!p) p = &PARTS[i];
    }
    if (n >= g_max_parts) return 0;
    if (!p) return 0;
    generation = p->generation;
    memset(p, 0, sizeof(*p));
    p->used = 1;
    p->state = PS_CREATED;
    p->parent = 0;
    p->generation = generation;
    p->priv_lo = HV_CHILD_PRIV_LO;
    p->priv_hi = HV_CHILD_PRIV_HI;
    p->weight = 1u; p->sched_left = 0; p->props[0] = p->priv_lo; p->props[1] = p->priv_hi;
    if (name_len > NAME_LEN - 1u) name_len = NAME_LEN - 1u;
    if (name_ptr && name_len) memcpy(p->name, nm, name_len);
    else { memcpy(p->name, "PARTITION", 9); name_len = 9; }
    p->name[name_len] = 0;
    p->name_len = name_len;
    log_str("hv: partition "); log_num(part_id_of(p));
    log_str(" created (\""); log_str(p->name); log_str("\")\n");
    return part_id_of(p);
}

i32 hv_partition_init(u32 part);
i32 hv_partition_init(u32 part) {
    Partition *p = part_of(part);
    u32 first, i, pfn;
    Channel *c;
    u32 offer[4];
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->state != PS_CREATED && p->state != PS_INITIALISED) return HV_STATUS_BAD_PART_STATE;
    if (p->is_root) { p->state = PS_RUNNING; return 0; }
    if (!p->vp_count) {
        Vp *v = vp_alloc((u32)(p - PARTS), 0);
        if (!v) return HV_STATUS_INSUFFICIENT_MEM;
        p->vps[p->vp_count++] = (u32)(v - VPS) + 1u;
    }
    if (!p->win_first) {
        /* the guest's window plus one guard page on each side */
        first = alloc_run(GPA_PAGES + 2u);
        if (!first) return HV_STATUS_INSUFFICIENT_MEM;
        pages_own(first, GPA_PAGES + 2u, (u32)(p - PARTS));
        g_owned += GPA_PAGES + 2u;
        g_deposits += GPA_PAGES;
        p->win_first = first;
        p->canary_lo = first;
        p->canary_hi = first + GPA_PAGES + 1u;
        canary_fill(p);
        for (i = 0; i < GPA_PAGES; i++) {
            pfn = first + 1u + i;
            PAGES[pfn].mapped = 1;
            PAGES[pfn].gpa = i << PAGE_SHIFT;
            PAGES[pfn].flags = SLAT_R | SLAT_W | SLAT_X;
            p->slat[i] = (pfn << 3) | (SLAT_R | SLAT_W | SLAT_X); /* R/W/X */
            g_present++;
        }
        p->mapped_pages = GPA_PAGES;
        p->deposits += GPA_PAGES;
    }
    /* zero the guest window */
    for (i = 0; i < GPA_PAGES; i++) memset(&PHYS[((p->canary_lo + 1u + i) << PAGE_SHIFT)], 0, PAGE);
    p->has_guest = 1;
    p->state = PS_INITIALISED;
    guest_reset(part_id_of(p), p->vps[0]);
    {
        Vp *v = vp_of(p->vps[0]);
        if (v) { v->simp = SIMP_GPA; v->siefp = SIEFP_GPA; v->scontrol = 1u; }
    }
    /* offer a VMBus channel into the guest's out ring */
    c = 0;
    for (i = 0; i < MAX_CHANNELS; i++) if (!CHANS[i].used) { c = &CHANS[i]; break; }
    if (c) {
        u32 generation = c->generation;
        memset(c, 0, sizeof(*c));
        c->used = 1;
        c->generation = generation;
        c->chid = chan_id_of(c);
        c->part = part_id_of(p);
        c->state = CH_OFFERED;
        c->ring_gpa = OUT_RING_GPA;
        c->offer_lo = 0x98C00000u | c->chid;
        c->offer_hi = 0x00000001u;
        p->channel = c->chid;
        offer[0] = c->chid;
        offer[1] = c->offer_lo;
        offer[2] = c->offer_hi;
        offer[3] = 1u;
        ring_post(part_id_of(p), OUT_RING_GPA, VMB_OFFER, (const u8 *)offer, 16u);
        log_str("hv: VMBus channel "); log_num(c->chid);
        log_str(" offered to partition "); log_num(part_id_of(p)); log_char('\n');
    }
    log_str("hv: partition "); log_num(part_id_of(p));
    log_str(" initialised: window 0x0.."); log_hex(GPA_LIMIT);
    log_str(" plus canary pages at "); log_hex(p->canary_lo << PAGE_SHIFT);
    log_char(' '); log_hex(p->canary_hi << PAGE_SHIFT); log_char('\n');
    return 0;
}

i32 hv_partition_start(u32 part);
i32 hv_partition_start(u32 part) {
    Partition *p = part_of(part);
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->state != PS_INITIALISED && p->state != PS_CREATED && p->state != PS_PAUSED && p->state != PS_STOPPED)
        return HV_STATUS_BAD_PART_STATE;
    if (p->state == PS_CREATED) {
        i32 r = hv_partition_init(part);
        if (r) return r;
    }
    p->state = PS_RUNNING;
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (v && v->state != VS_HALTED) { v->state = VS_RUNNING; v->slice_left = QUANTUM_INSTR; }
    }
    log_str("hv: partition "); log_num(part); log_str(" started\n");
    return 0;
}
i32 hv_partition_pause(u32 part);
i32 hv_partition_pause(u32 part) {
    Partition *p = part_of(part);
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->state != PS_RUNNING) return HV_STATUS_BAD_PART_STATE;
    p->state = PS_PAUSED;
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (v) v->state = VS_CREATED;
    }
    log_str("hv: partition "); log_num(part); log_str(" paused\n");
    return 0;
}
i32 hv_partition_resume(u32 part);
i32 hv_partition_resume(u32 part) {
    Partition *p = part_of(part);
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->state != PS_PAUSED) return HV_STATUS_BAD_PART_STATE;
    p->state = PS_RUNNING;
    p->timer_acc = 0;
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (v && v->state != VS_HALTED) { v->state = VS_RUNNING; v->slice_left = QUANTUM_INSTR; }
    }
    log_str("hv: partition "); log_num(part); log_str(" resumed\n");
    return 0;
}
i32 hv_partition_stop(u32 part);
i32 hv_partition_stop(u32 part) {
    Partition *p = part_of(part);
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->is_root) return HV_STATUS_ACCESS_DENIED;
    if (p->state == PS_DELETED || p->state == PS_STOPPED) return HV_STATUS_BAD_PART_STATE;
    p->state = PS_STOPPED;
    p->timer_armed = 0;
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (v) v->state = VS_HALTED;
    }
    log_str("hv: partition "); log_num(part); log_str(" stopped\n");
    return 0;
}
i32 hv_partition_delete(u32 part);
i32 hv_partition_delete(u32 part) {
    Partition *p = part_of(part);
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->is_root) { log_str("hv: refusing to delete the root partition\n"); return HV_STATUS_ACCESS_DENIED; }
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (v) { v->used = 0; v->state = VS_EMPTY; v->part = 0xFFFFFFFFu; }
    }
    p->vp_count = 0;
    for (i = 0; i < MAX_CHANNELS; i++)
        if (CHANS[i].used && CHANS[i].part == part) {
            CHANS[i].state = CH_CLOSED;
            CHANS[i].used = 0;
            CHANS[i].generation++;
        }
    part_release_window(p);
    log_str("hv: partition "); log_num(part); log_str(" deleted (memory returned)\n");
    p->state = PS_DELETED;
    p->used = 0;
    p->has_guest = 0;
    p->generation++;
    return 0;
}

i32 hv_partition_reset(u32 part);   /* JS resetPartition() support (4) */
i32 hv_partition_reset(u32 part) {
    Partition *p = part_of(part);
    Vp *v;
    u32 i;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (p->is_root) return hv_partition_start(part);
    part_release_window(p);
    for (i = 0; i < p->vp_count; i++) {
        v = vp_of(p->vps[i]);
        if (v) { memset(v->msrs, 0, sizeof(v->msrs)); v->instr = 0; v->state = VS_CREATED; v->simp = SIMP_GPA; v->siefp = SIEFP_GPA; v->scontrol = 1u; v->msg_head = v->msg_tail = 0; v->msg_count = v->msg_dropped = v->events = 0; }
    }
    p->timer_armed = 0; p->timer_acc = 0; p->timer_pending = 0;
    p->timer_fires = 0; p->timer_last = 0; p->timer_masked = 0;
    p->glog_len = 0;
    p->state = PS_CREATED;
    p->has_guest = 0;
    log_str("hv: partition "); log_num(part); log_str(" reset\n");
    return hv_partition_init(part);
}

/* partition_field:
   0 id  1 state  2 name ptr  3 name len  4 vp count  5 mapped pages
   6 memory bytes  7 deposits  8 hypercalls  9 faults  10 runs  11 is_root
   12 parent  13 canary faults  14 has guest  15 vmbus channel
   16 privilege mask low  17 privilege mask high                           */
u32 hv_partition_field(u32 part, u32 f);
u32 hv_partition_field(u32 part, u32 f) {
    Partition *p = part_of(part);
    if (!p) return 0;
    switch (f) {
    case 0: return part_id_of(p);
    case 1: return p->state;
    case 2: return (u32)(uintptr_t)p->name;
    case 3: return p->name_len;
    case 4: return p->vp_count;
    case 5: return p->mapped_pages;
    case 6: return p->mapped_pages << PAGE_SHIFT;
    case 7: return p->deposits;
    case 8: return p->hypercalls;
    case 9: return p->faults;
    case 10: return p->runs;
    case 11: return p->is_root;
    case 12: return p->parent;
    case 13: return p->canary_faults;
    case 14: return p->has_guest;
    case 15: return p->channel;
    case 16: return p->priv_lo;
    case 17: return p->priv_hi;
    case 18: return p->weight;
    case 19: return p->vtl_cap;
    default: return 0;
    }
}
i32 hv_partition_set_property(u32 part, u32 property, u32 value) {
    Partition *p = part_of(part), *root = &PARTS[0];
    if (!p || property > 3u) return HV_STATUS_INVALID_PARAMETER;
    if (property <= 1u) {
        if (!root->is_root || (p->is_root == 0u && value & ~((property == 0u) ? HV_ROOT_PRIV_LO : HV_ROOT_PRIV_HI)))
            return HV_STATUS_ACCESS_DENIED;
        if (property == 0u) p->priv_lo = value; else p->priv_hi = value;
        p->props[property] = value;
    } else if (property == 2u) {
        if (!value || value > 100u) return HV_STATUS_INVALID_PARAMETER;
        p->weight = value; p->sched_left = 0; p->props[2] = value;
    } else { p->vtl_cap = value ? 1u : 0u; p->props[3] = p->vtl_cap; }
    return HV_STATUS_SUCCESS;
}
u32 hv_partition_set_weight(u32 part, u32 weight) { return hv_partition_set_property(part, 2u, weight); }
u32 hv_partition_get_property(u32 part, u32 property) {
    Partition *p = part_of(part);
    if (!p || property > 3u) return 0;
    return p->props[property];
}
u32 hv_partition_count(void);
u32 hv_partition_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_PARTS; i++) if (PARTS[i].used) n++;
    return n;
}
/* Enumerate the external id for a slot.  Callers must use this instead of
   guessing that the slot number is still a live id after deletion/reuse. */
u32 hv_partition_id_at(u32 slot);
u32 hv_partition_id_at(u32 slot) {
    if (slot >= MAX_PARTS || !PARTS[slot].used) return 0;
    return part_id_of(&PARTS[slot]);
}
u32 hv_partition_vp(u32 part, u32 idx);
u32 hv_partition_vp(u32 part, u32 idx) {
    Partition *p = part_of(part);
    if (!p || idx >= p->vp_count) return 0;
    return p->vps[idx];
}
u32 hv_partition_name(u32 part);          /* ptr */

/* -------------------------------------------------------------------- VPs */
u32 hv_vp_create(u32 part, u32 index);
u32 hv_vp_create(u32 part, u32 index) {
    Partition *p = part_of(part);
    Vp *v;
    if (!p) return 0;
    if (p->vp_count >= MAX_VPS_PER_PART) return 0;
    v = vp_alloc((u32)(p - PARTS), index);
    if (!v) return 0;
    p->vps[p->vp_count++] = (u32)(v - VPS) + 1u;
    log_str("hv: vp "); log_num((u32)(v - VPS) + 1u);
    log_str(" created for partition "); log_num(part);
    log_str(" index "); log_num(index); log_char('\n');
    return (u32)(v - VPS) + 1u;
}
/* vp_field: 0 part 1 index 2 state 3 run ms 4 hypercalls 5 faults 6 instr
   7 slice left 8 preempts   (see DEVIATION note in the header)              */
u32 hv_vp_field(u32 vp, u32 f);
u32 hv_vp_field(u32 vp, u32 f) {
    Vp *v = vp_of(vp);
    if (!v) return 0;
    switch (f) {
    case 0: return v->part + 1u;
    case 1: return v->index;
    case 2: return v->state;
    case 3: return v->run_ms;
    case 4: return v->hypercalls;
    case 5: return v->faults;
    case 6: return v->instr;
    case 7: return v->slice_left;
    case 8: return v->preempts;
    default: return 0;
    }
}
u32 hv_vp_count(void);
u32 hv_vp_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_VPS; i++) if (VPS[i].used) n++;
    return n;
}
u32 hv_vp_register(u32 vp, u32 which);
u32 hv_vp_register(u32 vp, u32 which) {
    Vp *v = vp_of(vp);
    if (!v || which > 31u) return 0;
    return v->regs[which];
}
i32 hv_vp_set_register(u32 vp, u32 which, u32 value);
i32 hv_vp_set_register(u32 vp, u32 which, u32 value) {
    Vp *v = vp_of(vp);
    if (!v || which > 31u) return HV_STATUS_INVALID_PARAMETER;
    v->regs[which] = value;
    return 0;
}
u32 hv_vp_run_ns(u32 vp);
u32 hv_vp_run_ns(u32 vp) {
    Vp *v = vp_of(vp);
    if (!v) return 0;
    return (u32)(v->run_ns & 0xFFFFFFFFu);
}
u32 hv_vp_timer_fires(u32 vp);
u32 hv_vp_timer_fires(u32 vp) {
    Vp *v = vp_of(vp);
    if (!v) return 0;
    return v->timer_fires;
}

/* ------------------------------------------------------- GPA memory / SLAT */
i32 hv_map_gpa(u32 part, u32 gpa, u32 page_count, u32 flags);
i32 hv_map_gpa(u32 part, u32 gpa, u32 page_count, u32 flags) {
    Partition *p = part_of(part);
    u32 i;
    if (!p || !page_count || (gpa & (PAGE - 1u)) || flags == 0u) return HV_STATUS_INVALID_PARAMETER;
    if (flags > (SLAT_R | SLAT_W | SLAT_X)) return HV_STATUS_INVALID_PARAMETER;
    if (gpa + (page_count << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < page_count; i++) {
        u32 a = gpa + (i << PAGE_SHIFT);
        u32 cur = p->slat[a >> PAGE_SHIFT];
        u32 pfn;
        if (cur) {
            pfn = cur >> 3;
        } else {
            pfn = alloc_run(1u);
            if (!pfn) return HV_STATUS_INSUFFICIENT_MEM;
            pages_own(pfn, 1u, (u32)(p - PARTS));
            g_owned++;
            g_deposits++;
            p->deposits++;
            PAGES[pfn].gpa = a;
        }
        slat_set(p, a, pfn, flags);
        if (flags & SLAT_R) {
            if (!PAGES[pfn].mapped) { PAGES[pfn].mapped = 1; g_present++; p->mapped_pages++; }
        } else {
            if (PAGES[pfn].mapped) { PAGES[pfn].mapped = 0; g_present--; if (p->mapped_pages) p->mapped_pages--; }
        }
        PAGES[pfn].flags = flags;
    }
    return 0;
}
i32 hv_unmap_gpa(u32 part, u32 gpa, u32 page_count);
i32 hv_unmap_gpa(u32 part, u32 gpa, u32 page_count) {
    Partition *p = part_of(part);
    u32 i;
    if (!p || !page_count || (gpa & (PAGE - 1u))) return HV_STATUS_INVALID_PARAMETER;
    if (gpa + (page_count << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < page_count; i++) {
        u32 a = gpa + (i << PAGE_SHIFT);
        u32 e = p->slat[a >> PAGE_SHIFT];
        u32 pfn;
        if (!e) continue;
        pfn = e >> 3;
        p->slat[a >> PAGE_SHIFT] = 0;
        if (PAGES[pfn].mapped) { PAGES[pfn].mapped = 0; g_present--; if (p->mapped_pages) p->mapped_pages--; }
        if (PAGES[pfn].owner == (u32)(p - PARTS) + 1u) {
            PAGES[pfn].owner = 0;
            PAGES[pfn].gpa = 0;
            PAGES[pfn].flags = 0;
            if (g_owned) g_owned--;
        }
    }
    return 0;
}
i32 hv_withdraw_memory(u32 part, u32 pfn);
i32 hv_withdraw_memory(u32 part, u32 pfn) {
    Partition *p = part_of(part);
    if (!p || !pfn || pfn >= HOST_PAGES) return HV_STATUS_INVALID_PARAMETER;
    if (PAGES[pfn].owner != (u32)(p - PARTS) + 1u) return HV_STATUS_ACCESS_DENIED;
    if (PAGES[pfn].mapped) return HV_STATUS_BAD_PART_STATE;
    PAGES[pfn].dirty = 0;
    free_run(pfn, 1u, (u32)(p - PARTS));
    if (p->deposits) p->deposits--;
    return HV_STATUS_SUCCESS;
}
u32 hv_gpa_state(u32 part, u32 gpa);
u32 hv_gpa_state(u32 part, u32 gpa) {
    Partition *p = part_of(part);
    if (!p) return 0;
    return gpa_state_of(p, gpa);
}
u32 hv_read_gpa(u32 part, u32 gpa, u32 dst, u32 len);
u32 hv_read_gpa(u32 part, u32 gpa, u32 dst, u32 len) {
    Partition *p = part_of(part);
    if (!p) return 0;
    return hv_mem_read(p, gpa, dst, len, 0u);
}
u32 hv_write_gpa(u32 part, u32 gpa, u32 src, u32 len);
u32 hv_write_gpa(u32 part, u32 gpa, u32 src, u32 len) {
    Partition *p = part_of(part);
    if (!p) return 0;
    return hv_mem_write(p, gpa, src, len, 0u);
}
/* the guest-access probes: these DO fault the partition, as 2.2 requires */
u32 hv_probe_read_gpa(u32 part, u32 gpa);
u32 hv_probe_read_gpa(u32 part, u32 gpa) {
    Partition *p = part_of(part);
    u32 f;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (!slat_pfn(p, gpa, &f) || !(f & SLAT_R)) { part_fault(p, gpa, "probe read"); return HV_STATUS_SLAT_FAULT; }
    return 0;
}
u32 hv_probe_write_gpa(u32 part, u32 gpa);
u32 hv_probe_write_gpa(u32 part, u32 gpa) {
    Partition *p = part_of(part);
    u32 f;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (!slat_pfn(p, gpa, &f) || !(f & SLAT_R)) { part_fault(p, gpa, "probe write/read"); return HV_STATUS_SLAT_FAULT; }
    if (!(f & SLAT_W)) { part_fault(p, gpa, "probe write to read-only page"); return HV_STATUS_SLAT_FAULT; }
    return 0;
}
u32 hv_probe_execute_gpa(u32 part, u32 gpa);
u32 hv_probe_execute_gpa(u32 part, u32 gpa) {
    Partition *p = part_of(part);
    u32 f;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (!slat_pfn(p, gpa, &f) || !(f & SLAT_X)) {
        part_fault(p, gpa, "probe execute");
        return HV_STATUS_SLAT_FAULT;
    }
    return HV_STATUS_SUCCESS;
}
u32 hv_slat_faults(u32 part);
u32 hv_slat_faults(u32 part) {
    Partition *p = part_of(part);
    return p ? p->faults : 0;
}
u32 hv_slat_faults_total(void);
u32 hv_slat_faults_total(void) { return g_slat_faults; }
/* page_field: 0 owner 1 gpa 2 flags 3 mapped */
u32 hv_page_field(u32 page, u32 f);
u32 hv_page_field(u32 page, u32 f) {
    if (page >= HOST_PAGES) return 0;
    switch (f) {
    case 0: return PAGES[page].owner;
    case 1: return PAGES[page].gpa;
    case 2: return PAGES[page].flags;
    case 3: return PAGES[page].mapped;
    case 4: return PAGES[page].dirty;
    default: return 0;
    }
}
u32 hv_gpa_access_state(u32 part, u32 gpa, u32 page_count, u32 dst) {
    Partition *p = part_of(part); u32 i, out = 0;
    if (!p || !page_count || !dst || (gpa & (PAGE - 1u)) || gpa + (page_count << PAGE_SHIFT) > GPA_LIMIT)
        return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < page_count; i++) {
        u32 a = gpa + (i << PAGE_SHIFT), e = p->slat[a >> PAGE_SHIFT], d = 0;
        if (e) { u32 pf = e >> 3; d = PAGES[pf].dirty ? 1u : 0u; PAGES[pf].dirty = 0; }
        ((u8 *)dst)[i] = (u8)d; out += d;
    }
    return out;
}
/* memory_stats: 0 total 1 mapped 2 reserved 3 free 4 deposits */
u32 hv_memory_stats(u32 which);
u32 hv_memory_stats(u32 which) {
    switch (which) {
    case 0: return HOST_PAGES << PAGE_SHIFT;
    case 1: return g_present << PAGE_SHIFT;
    case 2: return (g_owned - g_present) << PAGE_SHIFT;
    case 3: return (HOST_PAGES - g_owned) << PAGE_SHIFT;
    case 4: return g_deposits;
    default: return 0;
    }
}

/* -------------------------------------------------------------- hypercalls */
static u32 hc_validate(Partition *p, u32 gpa, u32 len) {
    u32 off = 0;
    if (!len) return 1u;
    while (off < len) {
        u32 a = gpa + off, f;
        if (!slat_pfn(p, a, &f) || !(f & SLAT_R)) {
            part_fault(p, a, "hypercall buffer");
            return 0u;
        }
        off += PAGE - (a & (PAGE - 1u));
    }
    return 1u;
}

u32 hv_vmcall(u32 vp);
u32 hv_vmcall(u32 vp) {
    Vp *v = vp_of(vp);
    u32 pid;
    Partition *p;
    HvCallFrame f;
    u32 st = HV_STATUS_SUCCESS;
    if (!v) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    pid = part_id_of(p);
    v->hypercalls++;
    p->hypercalls++;
    g_hypercalls++;
    if (!hv_g_load(pid, HC_PAGE_GPA, (u32)&f, 32u)) {
        part_fault(p, HC_PAGE_GPA, "hypercall page unreadable");
        return HV_STATUS_SLAT_FAULT;
    }
    if (f.in_gpa && !hc_validate(p, f.in_gpa, 32u)) st = HV_STATUS_SLAT_FAULT;
    else if (f.out_gpa && !hc_validate(p, f.out_gpa, 4u)) st = HV_STATUS_SLAT_FAULT;
    else switch (f.code) {
    case HC_GET_HV_INFO: {
        u32 out[8];
        if (!f.out_gpa) { st = HV_STATUS_INVALID_PARAMETER; break; }
        out[0] = VENDOR0; out[1] = VENDOR1; out[2] = VENDOR2; out[3] = 0;
        out[4] = HV_SIGNATURE;
        out[5] = HV_VERSION;
        out[6] = MAX_LEAF;
        out[7] = 0;
        if (!hv_g_store(pid, f.out_gpa, (u32)out, 32u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_GET_REF_TIME: {
        u32 out[1];
        if (!f.out_gpa) { st = HV_STATUS_INVALID_PARAMETER; break; }
        out[0] = REF_TIME;
        if (!hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_GET_VP_INDEX: {
        u32 out[1];
        if (!f.out_gpa) { st = HV_STATUS_INVALID_PARAMETER; break; }
        out[0] = v->index;
        if (!hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_CREATE_PART: {
        u32 out[1], np;
        if (!part_has_priv(p, 0u, HV_PRIV_HI_CREATE_PARTS)) { st = HV_STATUS_ACCESS_DENIED; break; }
        np = hv_partition_create(0u, 0u);
        if (!np) { st = HV_STATUS_INSUFFICIENT_MEM; break; }
        out[0] = np;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) { st = HV_STATUS_SLAT_FAULT; break; }
        st = HV_STATUS_SUCCESS;
        break;
    }
    case HC_INIT_PART: {
        u32 target = f.arg0 ? f.arg0 : part_id_of(p);
        i32 r = hv_partition_init(target);
        st = r ? (u32)r : HV_STATUS_SUCCESS;
        break;
    }
    case HC_DEPOSIT_MEM: {
        u32 out[1], n = 0, i;
        if (!part_has_priv(p, 0u, HV_PRIV_HI_MEMORY_POOL)) { st = HV_STATUS_ACCESS_DENIED; break; }
        if (!f.arg1) { st = HV_STATUS_INVALID_PARAMETER; break; }
        for (i = 0; i < f.arg1; i++) {
            u32 a = f.arg0 + (i << PAGE_SHIFT), pfn, cur;
            if (a >= GPA_LIMIT) break;
            cur = p->slat[a >> PAGE_SHIFT];
            if (!cur) {
                pfn = alloc_run(1u);
                if (!pfn) break;
                pages_own(pfn, 1u, (u32)(p - PARTS));
                g_owned++;
                g_deposits++;
                p->deposits++;
                PAGES[pfn].gpa = a;
                p->slat[a >> PAGE_SHIFT] = (pfn << 3);
            }
            n++;
        }
        out[0] = n;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_WITHDRAW_MEM:
        if (!part_has_priv(p, 0u, HV_PRIV_HI_MEMORY_POOL)) st = HV_STATUS_ACCESS_DENIED;
        else st = (u32)hv_withdraw_memory(part_id_of(p), f.arg0);
        break;
    case HC_CREATE_VP: {
        u32 out[1], nv;
        if (!part_has_priv(p, 0u, HV_PRIV_HI_START_VP)) { st = HV_STATUS_ACCESS_DENIED; break; }
        nv = hv_vp_create(part_id_of(p), f.arg0);
        if (!nv) { st = HV_STATUS_INSUFFICIENT_MEM; break; }
        out[0] = nv;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_SET_VP_REGISTERS:
        if (!part_has_priv(p, 0u, HV_PRIV_HI_VP_REGISTERS)) { st = HV_STATUS_ACCESS_DENIED; break; }
        if (f.arg0 > 31u) { st = HV_STATUS_INVALID_PARAMETER; break; }
        v->regs[f.arg0] = f.arg1;
        break;
    case HC_MAP_GPA_PAGES: {
        if (!part_has_priv(p, 0u, HV_PRIV_HI_CREATE_PARTS)) { st = HV_STATUS_ACCESS_DENIED; break; }
        i32 r = hv_map_gpa(part_id_of(p), f.arg0, f.arg1, f.arg2 & (SLAT_R | SLAT_W | SLAT_X));
        st = r ? (u32)r : HV_STATUS_SUCCESS;
        break;
    }
    case HC_POST_MESSAGE: {
        SynicMsg m;
        u32 rv = root_vp_id();
        if (!part_has_priv(p, 0u, HV_PRIV_HI_POST_MESSAGES)) { st = HV_STATUS_ACCESS_DENIED; break; }
        if (!f.arg0) { st = HV_STATUS_INVALID_PARAMETER; break; }
        if (!hc_validate(p, f.arg0, MSG_SIZE)) { st = HV_STATUS_SLAT_FAULT; break; }
        if (!hv_g_load(pid, f.arg0, (u32)&m, MSG_SIZE)) { st = HV_STATUS_SLAT_FAULT; break; }
        if (m.size > MSG_SIZE) m.size = MSG_SIZE;
        if (rv) {
            Vp *rvp = vp_of(rv);
            if (rvp) { if (!synic_post(rvp, &m)) st = HV_STATUS_INSUFFICIENT_MEM; }
        }
        break;
    }
    case HC_SIGNAL_EVENT: {
        u32 flag[1];
        if (!part_has_priv(p, 0u, HV_PRIV_HI_SIGNAL_EVENTS)) { st = HV_STATUS_ACCESS_DENIED; break; }
        v->events++;
        if (f.arg0 >= 16u || f.arg1 >= 16u) { st = HV_STATUS_INVALID_PARAMETER; break; }
        v->event_flags[f.arg1] = 1u; v->sint_pending[f.arg0] = 1u;
        if (!v->sint_masked[f.arg0]) v->sint_count[f.arg0]++;
        if (v->siefp) {
            flag[0] = 1u << (f.arg1 & 31u);
            hv_g_store(pid, v->siefp, (u32)flag, 4u);
        }
        break;
    }
    case HC_ENABLE_HC_PAGE:
        (void)msr_write(v, MSR_HYPERCALL, (f.arg0 << 12) | 1u, 0u);
        msrlog_add(p, MSR_HYPERCALL, (f.arg0 << 12) | 1u, 1u);
        break;
    case HC_VMBUS_OPEN: {
        u32 i, out[1];
        st = HV_STATUS_INVALID_PARAMETER;
        for (i = 0; i < MAX_CHANNELS; i++) {
            Channel *c = &CHANS[i];
            if (!c->used) continue;
            if (c->part != part_id_of(p)) continue;
            if (c->offer_lo != f.arg0 || c->offer_hi != f.arg1) continue;
            c->state = CH_OPEN;
            out[0] = c->chid;
            if (!f.out_gpa || hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SUCCESS;
            else st = HV_STATUS_SLAT_FAULT;
            break;
        }
        break;
    }
    case HC_VMBUS_CLOSE: {
        st = (u32)hv_vmbus_close(f.arg0);
        break;
    }
    case HC_VMBUS_SIGNAL: {
        Channel *c = chan_of(f.arg0);
        if (!c) { st = HV_STATUS_INVALID_PARAMETER; break; }
        c->messages++;
        c->out_bytes += f.arg1;
        break;
    }
    case HC_QUERY_MSR: {
        u32 lo = 0, hi = 0, out[2];
        u32 r = msr_read(v, f.arg0, &lo, &hi);
        if (r != HV_STATUS_SUCCESS && r != HV_STATUS_NOT_IMPLEMENTED) { st = r; break; }
        msrlog_add(p, f.arg0, lo, 0u);
        out[0] = lo; out[1] = hi;
        if (!f.out_gpa || !hv_g_store(pid, f.out_gpa, (u32)out, 8u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_SET_MSR: {
        u32 r = msr_write(v, f.arg0, f.arg1, f.arg2);
        if (r != HV_STATUS_SUCCESS) st = r;
        break;
    }
    case HC_CPUID: {
        u32 out[4];
        if (!f.out_gpa) { st = HV_STATUS_INVALID_PARAMETER; break; }
        cpuid_leaf(f.arg0, f.arg1, out, p->priv_lo, p->priv_hi);
        if (!hv_g_store(pid, f.out_gpa, (u32)out, 16u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_HALT:
        v->state = VS_HALTED;
        p->state = PS_STOPPED;
        log_str("hv: partition "); log_num(part_id_of(p)); log_str(" halted by guest\n");
        break;
    default:
        st = HV_STATUS_NOT_IMPLEMENTED;
        break;
    }
    f.status = st;
    hv_g_store(pid, HC_PAGE_GPA + 4u, (u32)&f.status, 4u);
    return st;
}

u32 hv_hypercall_count(void);
u32 hv_hypercall_count(void) { return g_hypercalls; }

/* TLFS control-word path.  The legacy frame above remains the compatibility
   path; this bounded path models repeatable signal/notify hypercalls and
   exposes partial progress exactly as a real rep hypercall does. */
u32 hv_hypercall_control(u32 vp, u32 control_lo, u32 control_hi,
                         u32 in_gpa, u32 out_gpa, u32 arg0, u32 arg1,
                         u32 arg2, u32 arg3) {
    Vp *v = vp_of(vp); u32 code, total, start, budget = 4u;
    (void)in_gpa; (void)out_gpa; (void)arg2; (void)arg3;
    if (!v) return HV_STATUS_INVALID_PARAMETER;
    code = control_lo & 0xFFFFu;
    total = control_hi & 0xFFFFu; start = control_hi >> 16;
    if (!total) return HV_STATUS_INVALID_PARAMETER;
    if (!v->rep_active || v->rep_code != code || start == 0u) {
        v->rep_code = code; v->rep_total = total; v->rep_done = start; v->rep_start = start;
        v->rep_active = 1u; v->rep_status = HV_STATUS_REP_NOT_COMPLETE;
    }
    while (v->rep_done < v->rep_total && budget--) {
        if (code == HC_SIGNAL_EVENT) {
            if (arg0 >= 16u || arg1 >= 16u) { v->rep_status = HV_STATUS_INVALID_PARAMETER; break; }
            v->events++; v->event_flags[arg1] = 1u; v->sint_pending[arg0] = 1u;
            if (!v->sint_masked[arg0]) v->sint_count[arg0]++;
            else v->sint_dropped[arg0]++;
        }
        else if (code == HC_VMBUS_SIGNAL) { Channel *c = chan_of(arg0); if (!c) { v->rep_status = HV_STATUS_INVALID_PARAMETER; break; } c->messages++; c->out_bytes += arg1; }
        else { v->rep_status = HV_STATUS_NOT_IMPLEMENTED; break; }
        v->rep_done++;
    }
    if (v->rep_status == HV_STATUS_NOT_IMPLEMENTED || v->rep_status == HV_STATUS_INVALID_PARAMETER) { v->rep_active = 0; return v->rep_status; }
    if (v->rep_done >= v->rep_total) { v->rep_status = HV_STATUS_SUCCESS; v->rep_active = 0; return HV_STATUS_SUCCESS; }
    return HV_STATUS_REP_NOT_COMPLETE;
}
u32 hv_rep_field(u32 vp, u32 f) {
    Vp *v = vp_of(vp); if (!v) return 0;
    switch (f) { case 0: return v->rep_done; case 1: return v->rep_total; case 2: return v->rep_active; case 3: return v->rep_status; default: return 0; }
}

/* ---------------------------------------------------------- MSR / CPUID API */
u32 hv_query_msr(u32 vp, u32 msr, u32 out_ptr);
u32 hv_query_msr(u32 vp, u32 msr, u32 out_ptr) {
    Vp *v = vp_of(vp);
    u32 lo = 0, hi = 0, r;
    if (!v) return HV_STATUS_INVALID_PARAMETER;
    r = msr_read(v, msr, &lo, &hi);
    msrlog_add(&PARTS[v->part], msr, lo, 0u);
    if (out_ptr) { ((u32 *)out_ptr)[0] = lo; ((u32 *)out_ptr)[1] = hi; }
    return r;
}
u32 hv_set_msr(u32 vp, u32 msr, u32 lo, u32 hi);
u32 hv_set_msr(u32 vp, u32 msr, u32 lo, u32 hi) {
    Vp *v = vp_of(vp);
    if (!v) return HV_STATUS_INVALID_PARAMETER;
    return msr_write(v, msr, lo, hi);
}
u32 hv_msr_log_count(u32 part);
u32 hv_msr_log_count(u32 part) {
    Partition *p = part_of(part);
    return p ? p->msrlog_n : 0;
}
/* msr_log_field(part, i, f): f 0 msr 1 value 2 write ; i newest-last */
u32 hv_msr_log_field(u32 part, u32 i, u32 f);
u32 hv_msr_log_field(u32 part, u32 i, u32 f) {
    Partition *p = part_of(part);
    u32 start, slot;
    if (!p || i >= p->msrlog_n) return 0;
    start = (p->msrlog_head + MSR_LOG - p->msrlog_n) % MSR_LOG;
    slot = (start + i) % MSR_LOG;
    switch (f) {
    case 0: return p->msrlog[slot].msr;
    case 1: return p->msrlog[slot].value;
    case 2: return p->msrlog[slot].write;
    default: return 0;
    }
}
i32 hv_reference_tsc_set(u32 vp, u32 sequence, u32 scale, u32 offset_lo, u32 offset_hi) {
    Vp *v = vp_of(vp);
    if (!v || !scale) return HV_STATUS_INVALID_PARAMETER;
    v->ref_seq = sequence; v->ref_scale = scale; v->ref_offset_lo = offset_lo; v->ref_offset_hi = offset_hi;
    return HV_STATUS_SUCCESS;
}
u32 hv_reference_tsc_read(u32 vp, u32 dst) {
    Vp *v = vp_of(vp); u64 t, off;
    u32 out[3];
    if (!v || !v->ref_scale || !dst) return HV_STATUS_INVALID_PARAMETER;
    t = (u64)REF_TIME * 10000ULL * (u64)v->ref_scale;
    off = ((u64)v->ref_offset_hi << 32) | v->ref_offset_lo;
    t += off; out[0] = v->ref_seq; out[1] = (u32)t; out[2] = (u32)(t >> 32);
    memcpy((u8 *)dst, out, 12u); return HV_STATUS_SUCCESS;
}

/* ------------------------------------------------- SynIC / timer / VMBus */
u32 hv_synic_field(u32 vp, u32 which);
u32 hv_synic_field(u32 vp, u32 which) {
    Vp *v = vp_of(vp);
    if (!v) return 0;
    switch (which) {
    case 0: return v->scontrol;
    case 1: return v->simp;
    case 2: return v->siefp;
    case 3: return v->eom;
    case 4: return v->msg_count;
    case 5: return v->msg_dropped;
    case 6: return v->events;
    case 7: return (v->msg_tail + MSG_QUEUE - v->msg_head) % MSG_QUEUE;
    case 8: { u32 n = 0, s; for (s = 0; s < 16u; s++) n += v->sint_pending[s] ? 1u : 0u; return n; }
    case 9: { u32 n = 0, s; for (s = 0; s < 16u; s++) n += v->event_flags[s] ? 1u : 0u; return n; }
    case 10: return v->msg_head != v->msg_tail;
    default: return 0;
    }
}
u32 hv_sint_field(u32 vp, u32 sint, u32 which);
u32 hv_sint_field(u32 vp, u32 sint, u32 which) {
    Vp *v = vp_of(vp);
    if (!v || sint > 15u) return 0;
    switch (which) {
    case 0: return v->sint_vec[sint];
    case 1: return v->sint_masked[sint];
    case 2: return v->sint_count[sint];
    case 3: return v->sint_auto_eoi[sint];
    case 4: return v->sint_dropped[sint];
    default: return 0;
    }
}
u32 hv_message_pop(u32 vp, u32 dst, u32 max);
u32 hv_message_pop(u32 vp, u32 dst, u32 max) {
    Vp *v = vp_of(vp);
    u32 n;
    if (!v || v->msg_head == v->msg_tail) return 0;
    n = MSG_SIZE;
    if (max && max < n) n = max;
    if (dst) memcpy((u8 *)dst, &v->msgs[v->msg_head], n);
    v->msg_head = (v->msg_head + 1u) % MSG_QUEUE;
    v->msg_consumed = 1u;
    return n;
}
u32 hv_message_push(u32 vp, u32 src, u32 len);
u32 hv_message_push(u32 vp, u32 src, u32 len) {
    Vp *v = vp_of(vp);
    if (!v) return 0;
    if (len > MSG_SIZE) len = MSG_SIZE;
    {
        SynicMsg m;
        memset(&m, 0, sizeof(m));
        memcpy(&m, (const u8 *)src, len);
        return synic_post(v, &m);
    }
}
u32 hv_synic_eom(u32 vp) {
    Vp *v = vp_of(vp); u32 s, redeliver = 16u;
    if (!v) return HV_STATUS_INVALID_PARAMETER;
    v->eom++;
    if (v->msg_consumed && v->msg_head != v->msg_tail) redeliver = v->msgs[v->msg_head].type & 15u;
    for (s = 0; s < 16u; s++) if (v->sint_pending[s]) {
        if (!v->sint_masked[s]) v->sint_count[s]++;
        v->sint_pending[s] = 0;
    }
    if (redeliver < 16u) {
        v->sint_pending[redeliver] = 1u;
        if (!v->sint_masked[redeliver]) v->sint_count[redeliver]++;
    }
    v->msg_consumed = 0u;
    return HV_STATUS_SUCCESS;
}
u32 hv_synic_event_field(u32 vp, u32 flag) {
    Vp *v = vp_of(vp);
    if (!v || flag >= 16u) return 0;
    return v->event_flags[flag];
}
u32 hv_synic_event_clear(u32 vp, u32 flag) {
    Vp *v = vp_of(vp);
    if (!v || flag >= 16u) return HV_STATUS_INVALID_PARAMETER;
    v->event_flags[flag] = 0;
    return HV_STATUS_SUCCESS;
}
u32 hv_send_ipi(u32 src_vp, u32 dst_vp, u32 vector) {
    Vp *s = vp_of(src_vp), *d = vp_of(dst_vp);
    if (!s || !d || vector > 255u || s->part != d->part) return HV_STATUS_INVALID_PARAMETER;
    d->ipi_vector = vector; d->ipi_pending = 1u; return HV_STATUS_SUCCESS;
}
u32 hv_apic_field(u32 vp, u32 f) {
    Vp *v = vp_of(vp); if (!v) return 0;
    switch (f) { case 0: return v->tpr; case 1: return v->eoi; case 2: return v->ipi_pending; case 3: return v->ipi_vector; case 4: return v->ipi_delivered; default: return 0; }
}
u32 hv_apic_eoi(u32 vp) { Vp *v = vp_of(vp); if (!v) return HV_STATUS_INVALID_PARAMETER; v->eoi++; v->ipi_pending = 0; return HV_STATUS_SUCCESS; }
u32 hv_flush_virtual_address_space(u32 part, u32 gpa) {
    Partition *p = part_of(part); u32 i; (void)gpa;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < p->vp_count; i++) if (vp_of(p->vps[i])) {
        Vp *v = vp_of(p->vps[i]); v->vmx_tlb_valid = 0; v->vmx_ept_generation++;
    }
    return HV_STATUS_SUCCESS;
}
u32 hv_signal_event(u32 part, u32 connection, u32 flag) {
    Partition *p = part_of(part); Vp *v;
    u32 bit = 1u;
    if (!p || connection >= p->vp_count || flag >= 16u) return HV_STATUS_INVALID_PARAMETER;
    v = vp_of(p->vps[connection]); if (!v) return HV_STATUS_INVALID_PARAMETER;
    v->events++; v->event_flags[flag] = 1u; v->sint_pending[flag] = 1u;
    if (v->sint_masked[flag]) { bit = 0; v->sint_dropped[flag]++; }
    if (bit) v->sint_count[flag]++;
    if (v->siefp) (void)hv_mem_write(p, v->siefp + ((flag >> 5) << 2), (u32)&bit, 4u, 0u);
    return HV_STATUS_SUCCESS;
}
u32 hv_post_message(u32 part, u32 port, u32 src, u32 len) {
    Partition *p = part_of(part); Vp *v;
    SynicMsg m;
    if (!p || !p->vp_count || port >= 16u || len > MSG_SIZE) return HV_STATUS_INVALID_PARAMETER;
    v = vp_of(p->vps[0]); if (!v) return HV_STATUS_INVALID_PARAMETER;
    memset(&m, 0, sizeof(m)); if (len) memcpy(&m, (const u8 *)src, len);
    return synic_post(v, &m) ? HV_STATUS_SUCCESS : HV_STATUS_INSUFFICIENT_MEM;
}
u32 hv_timer_set(u32 vp, u32 sint, u32 period_ms, u32 oneshot);
u32 hv_timer_set(u32 vp, u32 sint, u32 period_ms, u32 oneshot) {
    Vp *v = vp_of(vp);
    Partition *p;
    if (!v || sint > 3u) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    p->timer_armed = 1u;
    p->timer_sint = sint & 3u;
    p->timer_period = period_ms ? period_ms : 100u;
    p->timer_oneshot = oneshot ? 1u : 0u;
    p->timer_acc = 0;
    p->timer_vp = vp;
    log_str("hv: timer armed for vp "); log_num(vp);
    log_str(" SINT"); log_num(p->timer_sint);
    log_str(" every "); log_num(p->timer_period); log_str(" ms\n");
    return 0;
}
/* timer_field: 0 fire count 1 last 2 pending */
u32 hv_timer_field(u32 vp, u32 which);
u32 hv_timer_field(u32 vp, u32 which) {
    Vp *v = vp_of(vp);
    Partition *p;
    if (!v) return 0;
    p = &PARTS[v->part];
    switch (which) {
    case 0: return p->timer_fires;
    case 1: return p->timer_last;
    case 2: return p->timer_pending;
    case 3: return p->timer_armed;
    case 4: return p->timer_masked;
    default: return 0;
    }
}
/* the guest consumes one pending timer interrupt (interrupt delivery is
   modelled as a pending count rather than a real asynchronous signal) */
u32 hv_guest_timer_take(u32 part);
u32 hv_guest_timer_take(u32 part) {
    Partition *p = part_of(part);
    Vp *v;
    if (!p || !p->timer_pending) return 0;
    p->timer_pending--;
    v = vp_of(p->timer_vp);
    if (v) { v->timer_pending = p->timer_pending; v->timer_fires = p->timer_fires; }
    return 1;
}
u32 hv_timer_set_n(u32 vp, u32 timer, u32 sint, u32 period_ms, u32 oneshot) {
    Vp *v = vp_of(vp); SynthTimer *t;
    if (!v || timer > 3u || sint > 15u || !period_ms) return HV_STATUS_INVALID_PARAMETER;
    t = &v->stimer[timer]; memset(t, 0, sizeof(*t)); t->armed = 1u; t->sint = sint; t->period = period_ms; t->oneshot = oneshot ? 1u : 0u;
    return HV_STATUS_SUCCESS;
}
u32 hv_timer_n_set_direct(u32 vp, u32 timer, u32 direct) {
    Vp *v = vp_of(vp);
    if (!v || timer > 3u) return HV_STATUS_INVALID_PARAMETER;
    v->stimer[timer].direct = direct ? 1u : 0u;
    return HV_STATUS_SUCCESS;
}
u32 hv_timer_n_field(u32 vp, u32 timer, u32 f) {
    Vp *v = vp_of(vp); SynthTimer *t;
    if (!v || timer > 3u) return 0; t = &v->stimer[timer];
    switch (f) { case 0: return t->armed; case 1: return t->fires; case 2: return t->last; case 3: return t->pending; case 4: return t->masked; case 5: return t->sint; case 6: return t->direct; default: return 0; }
}

u32 hv_vmbus_channel_field(u32 ch, u32 f);
u32 hv_vmbus_channel_field(u32 ch, u32 f) {
    Channel *c = chan_of(ch);
    if (!c) return 0;
    switch (f) {
    case 0: return c->part;
    case 1: return c->state;
    case 2: return c->offer_lo;
    case 3: return c->offer_hi;
    case 4: return c->ring_gpa;
    case 5: return c->in_bytes;
    case 6: return c->out_bytes;
    case 7: return c->messages;
    case 8: return c->dropped;
    case 9: return c->chid;
    case 10: return IN_RING_GPA;
    case 11: return c->version;
    case 12: return c->gpadl_gpa;
    case 13: return c->gpadl_pages;
    case 14: return c->interrupt_mask;
    case 15: return c->pending_send;
    case 16: return c->rescinded;
    default: return 0;
    }
}
i32 hv_vmbus_negotiate(u32 ch, u32 version) {
    Channel *c = chan_of(ch);
    if (!c || c->state == CH_CLOSED || (version != 1u && version != 2u)) return HV_STATUS_INVALID_PARAMETER;
    c->version = version; return HV_STATUS_SUCCESS;
}
i32 hv_vmbus_gpadl(u32 ch, u32 gpa, u32 pages) {
    Channel *c = chan_of(ch);
    if (!c || c->state != CH_OPEN || !pages || (gpa & (PAGE - 1u)) || gpa + (pages << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    c->gpadl_gpa = gpa; c->gpadl_pages = pages; return HV_STATUS_SUCCESS;
}
i32 hv_vmbus_close(u32 ch) {
    Channel *c = chan_of(ch);
    if (!c || c->state == CH_CLOSED) return HV_STATUS_INVALID_PARAMETER;
    c->state = CH_CLOSED;
    return HV_STATUS_SUCCESS;
}
i32 hv_vmbus_reopen(u32 ch) {
    Channel *c = chan_of(ch);
    if (!c || c->rescinded || c->state != CH_CLOSED) return HV_STATUS_INVALID_PARAMETER;
    c->state = CH_OPEN; c->version = 0; c->gpadl_gpa = 0; c->gpadl_pages = 0;
    c->interrupt_mask = 0; c->pending_send = 0;
    return HV_STATUS_SUCCESS;
}
i32 hv_vmbus_rescind(u32 ch) {
    Channel *c = chan_of(ch);
    if (!c) return HV_STATUS_INVALID_PARAMETER;
    c->rescinded = 1u; c->state = CH_CLOSED; return HV_STATUS_SUCCESS;
}
u32 hv_vmbus_channel_count(void);
u32 hv_vmbus_channel_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_CHANNELS; i++) if (CHANS[i].used) n++;
    return n;
}
u32 hv_vmbus_channel_id_at(u32 slot);
u32 hv_vmbus_channel_id_at(u32 slot) {
    if (slot >= MAX_CHANNELS || !CHANS[slot].used) return 0;
    return CHANS[slot].chid;
}
u32 hv_vmbus_drain(u32 ch, u32 dst, u32 max);
/* writes one framed message {u32 type, u32 len, u8 payload[]} into dst and
   returns the payload length (0 when the ring is empty) */
u32 hv_vmbus_drain(u32 ch, u32 dst, u32 max) {
    Channel *c = chan_of(ch);
    u32 t = 0, n;
    if (!c || !dst) return 0;
    n = ring_pop(c->part, OUT_RING_GPA, &t, dst + 8u, max > 8u ? max - 8u : 0u);
    if (!n) return 0;
    ((u32 *)dst)[0] = t;
    ((u32 *)dst)[1] = n;
    c->in_bytes += n;
    return n;
}
u32 hv_vmbus_inject(u32 ch, u32 src, u32 len);
u32 hv_vmbus_inject(u32 ch, u32 src, u32 len) {
    Channel *c = chan_of(ch);
    u32 n;
    if (!c || c->state != CH_OPEN) return 0;
    n = ring_post(c->part, IN_RING_GPA, VMB_DATA, (const u8 *)src, len);
    if (n) { c->out_bytes += n; c->pending_send = 0; } else { c->dropped++; c->pending_send = len; }
    return n;
}
/* vmbus_stats: 0 channels 1 messages 2 dropped 3 in bytes 4 out bytes 5 open */
u32 hv_vmbus_stats(u32 which);
u32 hv_vmbus_stats(u32 which) {
    u32 i, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
    for (i = 0; i < MAX_CHANNELS; i++) {
        if (!CHANS[i].used) continue;
        a++;
        b += CHANS[i].messages;
        c += CHANS[i].dropped;
        d += CHANS[i].in_bytes;
        e += CHANS[i].out_bytes;
        if (CHANS[i].state == CH_OPEN) f++;
    }
    switch (which) {
    case 0: return a; case 1: return b; case 2: return c;
    case 3: return d; case 4: return e; case 5: return f;
    default: return 0;
    }
}
u32 hv_device_field(u32 part, u32 device, u32 field) {
    Partition *p = part_of(part);
    if (!p || device >= 6u) return 0;
    switch (field) { case 0: return p->has_guest && !p->device_status[device]; case 1: return p->device_tx[device]; case 2: return p->device_rx[device]; case 3: return p->device_status[device]; case 4: return device; default: return 0; }
}
u32 hv_device_send(u32 part, u32 device, u32 src, u32 len) {
    Partition *p = part_of(part); u32 n;
    if (!p || device >= 6u || !p->has_guest || len > MSG_SIZE) return HV_STATUS_INVALID_PARAMETER;
    if (p->state != PS_RUNNING) return HV_STATUS_BAD_PART_STATE;
    if (p->device_status[device]) return HV_STATUS_BAD_PART_STATE;
    p->device_tx[device]++;
    if (device == 5u) {
        p->device_status[device] = 1u; p->state = PS_STOPPED;
        for (n = 0; n < p->vp_count; n++) if (vp_of(p->vps[n])) vp_of(p->vps[n])->state = VS_HALTED;
        return HV_STATUS_SUCCESS;
    }
    if (device == 0u || device == 3u) {
        n = hv_vmbus_inject(p->channel, src, len);
        if (n) p->device_rx[device]++; else return HV_STATUS_INSUFFICIENT_MEM;
    } else {
        p->device_rx[device]++;
    }
    return HV_STATUS_SUCCESS;
}
static u32 vtl_perm(Partition *p, u32 vtl, u32 page) {
    u32 e, f;
    if (vtl < 2u && p->vtl_perm_valid[vtl][page]) return p->vtl_perms[vtl][page];
    e = p->slat[page]; if (!e) return 0;
    f = e & 7u; return f;
}
i32 hv_enable_partition_vtl(u32 part, u32 vtl) {
    Partition *p = part_of(part);
    if (!p || vtl != VTL1 || !part_has_priv(&PARTS[0], 0u, HV_PRIV_HI_VSM)) return HV_STATUS_ACCESS_DENIED;
    p->vtl_enabled = 1u;
    p->vtl_perms[0][0] = 7u; p->vtl_perms[1][0] = 7u;
    p->vtl_perm_valid[0][0] = 1u; p->vtl_perm_valid[1][0] = 1u;
    return HV_STATUS_SUCCESS;
}
i32 hv_enable_vp_vtl(u32 vp, u32 vtl) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl != VTL1) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part]; if (!p->vtl_enabled) return HV_STATUS_ACCESS_DENIED;
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_call(u32 vp, u32 call_id, u32 arg) {
    Vp *v = vp_of(vp); Partition *p; (void)call_id; (void)arg;
    if (!v) return HV_STATUS_INVALID_PARAMETER; p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != VTL0) return HV_STATUS_ACCESS_DENIED;
    p->current_vtl = VTL1; p->vtl_calls++; return HV_STATUS_SUCCESS;
}
u32 hv_vtl_return(u32 vp) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v) return HV_STATUS_INVALID_PARAMETER; p = &PARTS[v->part];
    if (p->current_vtl != VTL1) return HV_STATUS_BAD_PART_STATE;
    p->current_vtl = VTL0; p->vtl_returns++; return HV_STATUS_SUCCESS;
}
i32 hv_vtl_set_register(u32 vp, u32 vtl, u32 which, u32 value) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || which > 31u) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != vtl) return HV_STATUS_ACCESS_DENIED;
    v->vtl_regs[vtl][which] = value;
    return HV_STATUS_SUCCESS;
}
i32 hv_vtl_get_register(u32 vp, u32 vtl, u32 which, u32 dst) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || which > 31u || !dst) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != vtl) return HV_STATUS_ACCESS_DENIED;
    *(u32 *)dst = v->vtl_regs[vtl][which];
    return HV_STATUS_SUCCESS;
}
i32 hv_vtl_synic_config(u32 vp, u32 vtl, u32 sint, u32 vector, u32 masked) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || sint > 15u || vector > 255u) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != vtl) return HV_STATUS_ACCESS_DENIED;
    v->vtl_sint_vec[vtl][sint] = vector;
    v->vtl_sint_masked[vtl][sint] = masked ? 1u : 0u;
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_synic_field(u32 vp, u32 vtl, u32 sint, u32 field) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || sint > 15u || field > 3u) return 0u;
    p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != vtl) return 0u;
    switch (field) {
    case 0: return v->vtl_sint_vec[vtl][sint];
    case 1: return v->vtl_sint_masked[vtl][sint];
    case 2: return v->vtl_sint_pending[vtl][sint];
    case 3: return v->vtl_sint_count[vtl][sint];
    default: return 0u;
    }
}
i32 hv_vtl_inject_interrupt(u32 vp, u32 vtl, u32 vector) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || vector > 255u) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    if (!p->vtl_enabled) return HV_STATUS_ACCESS_DENIED;
    v->vtl_interrupt_vector[vtl] = vector;
    v->vtl_interrupt_pending[vtl] = 1u;
    if (vtl > p->current_vtl) p->current_vtl = vtl;
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_interrupt_field(u32 vp, u32 vtl, u32 field) {
    Vp *v = vp_of(vp); Partition *p;
    if (!v || vtl > VTL1 || field > 2u) return 0u;
    p = &PARTS[v->part];
    if (!p->vtl_enabled || p->current_vtl != vtl) return 0u;
    switch (field) { case 0: return v->vtl_interrupt_pending[vtl]; case 1: return v->vtl_interrupt_vector[vtl]; case 2: return v->vtl_interrupt_delivered[vtl]; default: return 0u; }
}
i32 hv_modify_vtl_protection_mask(u32 part, u32 gpa, u32 pages, u32 mask) {
    Partition *p = part_of(part); u32 i;
    if (!p || !p->vtl_enabled || !pages || (gpa & (PAGE - 1u)) || mask > 7u || gpa + (pages << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < pages; i++) {
        p->vtl_perms[0][(gpa >> PAGE_SHIFT) + i] = (u8)mask;
        p->vtl_perm_valid[0][(gpa >> PAGE_SHIFT) + i] = 1u;
    }
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_access(u32 part, u32 vtl, u32 gpa, u32 access) {
    Partition *p = part_of(part); u32 page, allowed;
    if (!p || vtl > VTL1 || gpa >= GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    page = gpa >> PAGE_SHIFT; allowed = vtl_perm(p, vtl, page);
    if ((allowed & access) != access || (vtl == VTL0 && p->kdp_protected[page] && (access & VTL_ACCESS_W))) {
        if (vtl == VTL0) { p->vtl_intercepts++; p->vtl_intercept_gpa = gpa; p->vtl_intercept_access = access; p->current_vtl = VTL1; }
        return HV_STATUS_ACCESS_DENIED;
    }
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_field(u32 part, u32 f) {
    Partition *p = part_of(part); if (!p) return 0;
    switch (f) { case 0: return p->vtl_enabled; case 1: return p->current_vtl; case 2: return p->vtl_calls; case 3: return p->vtl_returns; case 4: return p->vtl_intercepts; case 5: return p->vtl_intercept_gpa; case 6: return p->vtl_intercept_access; case 7: return p->hvci_denies; case 8: return p->kdp_denies; case 9: return p->secret_len; case 10: return p->pcr; case 11: return p->hyperguard_denies; case 12: return p->vsm_code_gpa; case 13: return p->vsm_code_hash; case 14: return p->vsm_code_ready; default: return 0; }
}
u32 hv_page_hash(u32 part, u32 gpa);
i32 hv_vsm_set_code(u32 part, u32 gpa, u32 hash) {
    Partition *p = part_of(part);
    if (!p || !p->vtl_enabled || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u)) || !p->slat[gpa >> PAGE_SHIFT]) return HV_STATUS_INVALID_PARAMETER;
    if (hv_page_hash(part, gpa) != hash) return HV_STATUS_ACCESS_DENIED;
    p->vsm_code_gpa = gpa; p->vsm_code_hash = hash; p->vsm_code_ready = 1u; return HV_STATUS_SUCCESS;
}
u32 hv_vsm_field(u32 part, u32 field) {
    Partition *p = part_of(part); if (!p || field > 2u) return 0u;
    switch (field) { case 0: return p->vsm_code_gpa; case 1: return p->vsm_code_hash; case 2: return p->vsm_code_ready; default: return 0u; }
}
u32 hv_page_hash(u32 part, u32 gpa) {
    Partition *p = part_of(part); u32 e, pf, i, h = 2166136261u;
    if (!p || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u))) return 0;
    e = p->slat[gpa >> PAGE_SHIFT]; if (!e) return 0; pf = e >> 3;
    for (i = 0; i < PAGE; i++) { h ^= PHYS[(pf << PAGE_SHIFT) + i]; h *= 16777619u; }
    return h;
}
i32 hv_hvci_sign_page(u32 part, u32 gpa, u32 hash) {
    Partition *p = part_of(part); u32 page;
    if (!p || !p->vtl_enabled || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u))) return HV_STATUS_INVALID_PARAMETER;
    page = gpa >> PAGE_SHIFT; if (hv_page_hash(part, gpa) != hash) { p->hvci_denies++; return HV_STATUS_ACCESS_DENIED; }
    p->hvci_signed[page] = 1u; return HV_STATUS_SUCCESS;
}
i32 hv_hvci_set_execute(u32 part, u32 gpa) {
    Partition *p = part_of(part); u32 page;
    if (!p || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u))) return HV_STATUS_INVALID_PARAMETER;
    page = gpa >> PAGE_SHIFT; if (!p->hvci_signed[page]) { p->hvci_denies++; return HV_STATUS_ACCESS_DENIED; }
    p->vtl_perms[0][page] = VTL_ACCESS_R | VTL_ACCESS_X;
    p->vtl_perm_valid[0][page] = 1u;
    return HV_STATUS_SUCCESS;
}
i32 hv_kdp_protect(u32 part, u32 gpa, u32 pages) {
    Partition *p = part_of(part); u32 i;
    if (!p || !p->vtl_enabled || !pages || (gpa & (PAGE - 1u)) || gpa + (pages << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < pages; i++) {
        p->kdp_protected[(gpa >> PAGE_SHIFT) + i] = 1u;
        p->vtl_perms[0][(gpa >> PAGE_SHIFT) + i] = VTL_ACCESS_R;
        p->vtl_perm_valid[0][(gpa >> PAGE_SHIFT) + i] = 1u;
    }
    return HV_STATUS_SUCCESS;
}
i32 hv_lsa_store_secret(u32 part, u32 src, u32 len) {
    Partition *p = part_of(part); if (!p || !src || !len || len > sizeof(p->secure_secret)) return HV_STATUS_INVALID_PARAMETER;
    memcpy(p->secure_secret, (const u8 *)src, len); p->secret_len = len; return HV_STATUS_SUCCESS;
}
i32 hv_lsa_call(u32 part, u32 op, u32 src, u32 len, u32 dst) {
    Partition *p = part_of(part); u32 i, h = 2166136261u; (void)op;
    if (!p || !p->secret_len || !dst || len > 64u) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < p->secret_len; i++) { h ^= p->secure_secret[i]; h *= 16777619u; }
    if (src && len) for (i = 0; i < len; i++) { h ^= ((const u8 *)src)[i]; h *= 16777619u; }
    ((u32 *)dst)[0] = h; return HV_STATUS_SUCCESS;
}
i32 hv_lsa_unseal(u32 part, u32 component, u32 expected_pcr, u32 dst) {
    Partition *p = part_of(part); u32 h;
    if (!p || !p->secret_len || !dst) return HV_STATUS_INVALID_PARAMETER;
    if (p->pcr != expected_pcr) return HV_STATUS_ACCESS_DENIED;
    h = p->pcr ^ component ^ 0xC6A4A793u;
    *(u32 *)dst = h;
    return HV_STATUS_SUCCESS;
}
u32 hv_vtl_scan(u32 part, u32 src, u32 len) {
    Partition *p = part_of(part); u8 *needle = (u8 *)src; u32 i, j, n, hits = 0;
    if (!p || !src || !len || len > 64u) return 0;
    for (i = 0; i < GPA_PAGES; i++) if (p->slat[i] && (vtl_perm(p, VTL0, i) & VTL_ACCESS_R)) {
        n = PAGE; for (j = 0; j + len <= n; j++) { u32 k; for (k = 0; k < len; k++) if (PHYS[((p->slat[i] >> 3) << PAGE_SHIFT) + j + k] != needle[k]) break; if (k == len) hits++; }
    }
    return hits;
}
u32 hv_measure_boot(u32 part, u32 component, u32 hash) { Partition *p = part_of(part); if (!p) return 0; p->pcr = (p->pcr << 5) ^ hash ^ component; return p->pcr; }
u32 hv_pcr_field(u32 part) { Partition *p = part_of(part); return p ? p->pcr : 0; }
i32 hv_hyperguard_write(u32 part, u32 reg, u32 value) { Partition *p = part_of(part); if (!p) return HV_STATUS_INVALID_PARAMETER; if ((reg == 0u || reg == 4u) && value == 0u) { p->hyperguard_denies++; return HV_STATUS_ACCESS_DENIED; } return HV_STATUS_SUCCESS; }

u32 hv_partition_state_hash(u32 part) {
    Partition *p = part_of(part); u32 i, h = 2166136261u;
    if (!p) return 0;
    h ^= p->state; h *= 16777619u; h ^= p->mapped_pages; h *= 16777619u; h ^= p->runs; h *= 16777619u;
    h ^= p->timer_fires; h *= 16777619u; h ^= p->channel; h *= 16777619u;
    for (i = 0; i < p->vp_count; i++) { Vp *v = vp_of(p->vps[i]); if (v) { h ^= v->instr; h *= 16777619u; h ^= v->msg_count; h *= 16777619u; h ^= v->regs[0]; h *= 16777619u; } }
    return h;
}
u32 hv_checkpoint_save(u32 part, u32 dst, u32 cap) {
    Partition *p = part_of(part); u32 out[16], i, slot;
    if (!p || !dst || cap < sizeof(out)) return 0;
    out[0] = 0x31435648u; out[1] = 1u; out[2] = part; out[3] = p->state; out[4] = p->vp_count;
    out[5] = p->mapped_pages; out[6] = p->timer_fires; out[7] = p->runs; out[8] = p->channel;
    out[9] = hv_partition_state_hash(part); out[10] = p->weight; out[11] = p->priv_lo; out[12] = p->priv_hi;
    for (i = 0; i < 3u; i++) out[13u + i] = (i < p->vp_count && vp_of(p->vps[i])) ? vp_of(p->vps[i])->instr : 0u;
    slot = (u32)(p - PARTS);
    CHECKPOINT_VALID[slot] = 0u;
    if (p->has_guest && hv_mem_read(p, FB_GPA, (u32)CHECKPOINT_FB[slot], FB_BYTES, 0u) == FB_BYTES) {
        CHECKPOINT_HASH[slot] = out[9];
        CHECKPOINT_HEARTBEAT[slot] = guest_field(part, GF_HEARTBEAT);
        CHECKPOINT_STAGE[slot] = guest_field(part, GF_STAGE);
        CHECKPOINT_VALID[slot] = 1u;
    }
    memcpy((u8 *)dst, out, sizeof(out)); return sizeof(out);
}
u32 hv_checkpoint_field(u32 part, u32 field) {
    Partition *p = part_of(part); u32 slot;
    if (!p || field > 3u) return 0;
    slot = (u32)(p - PARTS);
    switch (field) {
    case 0: return CHECKPOINT_VALID[slot];
    case 1: return CHECKPOINT_VALID[slot] ? FB_BYTES : 0u;
    case 2: return CHECKPOINT_VALID[slot] ? CHECKPOINT_HEARTBEAT[slot] : 0u;
    case 3: return CHECKPOINT_VALID[slot] ? CHECKPOINT_HASH[slot] : 0u;
    default: return 0;
    }
}
i32 hv_checkpoint_restore(u32 part, u32 src, u32 len) {
    Partition *p = part_of(part); u32 in[16], i, slot;
    if (!p || !src || len < sizeof(in)) return HV_STATUS_INVALID_PARAMETER;
    memcpy(in, (const u8 *)src, sizeof(in));
    if (in[0] != 0x31435648u || in[1] != 1u) return HV_STATUS_INVALID_PARAMETER;
    p->state = in[3]; p->timer_fires = in[6]; p->runs = in[7]; p->weight = in[10]; p->sched_left = 0;
    for (i = 0; i < p->vp_count && i < 3u; i++) if (vp_of(p->vps[i])) vp_of(p->vps[i])->instr = in[13u + i];
    slot = (u32)(p - PARTS);
    if (CHECKPOINT_VALID[slot] && CHECKPOINT_HASH[slot] == in[9]) {
        (void)hv_mem_write(p, FB_GPA, (u32)CHECKPOINT_FB[slot], FB_BYTES, 0u);
        guest_checkpoint_restore(part, CHECKPOINT_STAGE[slot], CHECKPOINT_HEARTBEAT[slot]);
    }
    return HV_STATUS_SUCCESS;
}

/* --------------------------------------------------------------------------
   Management-facing bounded checkpoint store (HVCP v1).  These names are
   intentionally separate from the legacy hv_checkpoint_save/restore ABI. */
static CkptSection *ckpt_sections(CkptSlot *c) {
    return (CkptSection *)(c->image + CKPT_HEADER_BYTES);
}
static u32 ckpt_add_section(CkptSlot *c, u32 *n, u32 type, const void *src, u32 len, u32 *off) {
    CkptSection *s;
    if (*n >= CKPT_SECTION_MAX || *off + len > CKPT_MAX_BYTES) return 0u;
    s = &ckpt_sections(c)[*n];
    s->type = type; s->offset = *off; s->length = len;
    if (len) memcpy(c->image + *off, src, len);
    s->checksum = ckpt_fnv(c->image + *off, len);
    *off += len; (*n)++;
    return 1u;
}
static CkptSection *ckpt_find_section(CkptSlot *c, u32 type) {
    u32 i, n = ckpt_u32(c->image + 28u);
    CkptSection *s = ckpt_sections(c);
    for (i = 0; i < n && i < CKPT_SECTION_MAX; i++) if (s[i].type == type) return &s[i];
    return 0;
}
static u32 ckpt_validate(CkptSlot *c) {
    u32 i, j, total, n, overall, seen = 0u;
    CkptSection *s;
    if (!c || !c->used) return HV_STATUS_CHECKPOINT_NOT_FOUND;
    if (ckpt_u32(c->image) != CKPT_MAGIC) return HV_STATUS_CHECKPOINT_CORRUPT;
    if (ckpt_u32(c->image + 4u) != CKPT_VERSION) return HV_STATUS_CHECKPOINT_UNSUPPORTED;
    if (ckpt_u32(c->image + 8u) != CKPT_HEADER_BYTES) return HV_STATUS_CHECKPOINT_CORRUPT;
    total = ckpt_u32(c->image + 12u);
    n = ckpt_u32(c->image + 28u);
    if (total != c->bytes || total < CKPT_HEADER_BYTES + CKPT_SECTION_BYTES * CKPT_SECTION_MAX ||
        total > CKPT_MAX_BYTES || n != CKPT_SECTION_MAX ||
        ckpt_u32(c->image + 20u) != c->source_id || ckpt_u32(c->image + 24u) != c->source_state)
        return HV_STATUS_CHECKPOINT_CORRUPT;
    overall = ckpt_fnv(c->image + 20u, total - 20u);
    if (overall != ckpt_u32(c->image + 16u)) return HV_STATUS_CHECKPOINT_CORRUPT;
    s = ckpt_sections(c);
    for (i = 0; i < n; i++) {
        if (s[i].type < CKPT_SEC_PARTITION || s[i].type > CKPT_SEC_FRAMEBUFFER ||
            (seen & (1u << s[i].type)) ||
            s[i].offset < CKPT_HEADER_BYTES + CKPT_SECTION_BYTES * n ||
            s[i].offset > total || s[i].length > total - s[i].offset ||
            ckpt_fnv(c->image + s[i].offset, s[i].length) != s[i].checksum) return HV_STATUS_CHECKPOINT_CORRUPT;
        for (j = 0; j < i; j++) {
            if (s[i].offset < s[j].offset + s[j].length &&
                s[j].offset < s[i].offset + s[i].length) return HV_STATUS_CHECKPOINT_CORRUPT;
        }
        seen |= 1u << s[i].type;
    }
    if (seen != 0xFEu) return HV_STATUS_CHECKPOINT_CORRUPT;
    if (!ckpt_find_section(c, CKPT_SEC_PARTITION) || !ckpt_find_section(c, CKPT_SEC_VPS) ||
        !ckpt_find_section(c, CKPT_SEC_GUEST) || !ckpt_find_section(c, CKPT_SEC_MAP) ||
        !ckpt_find_section(c, CKPT_SEC_MEMORY) || !ckpt_find_section(c, CKPT_SEC_FRAMEBUFFER))
        return HV_STATUS_CHECKPOINT_CORRUPT;
    return HV_STATUS_SUCCESS;
}
static void ckpt_set_status(u32 st) { CKPT_LAST_STATUS = st; }
static u32 ckpt_bad_handle_status(u32 id) {
    return id ? HV_STATUS_STALE_ID : HV_STATUS_CHECKPOINT_NOT_FOUND;
}
static CkptSlot *ckpt_free_slot(void) {
    u32 i;
    for (i = 0; i < CKPT_MAX; i++) if (!CKPTS[i].used) return &CKPTS[i];
    return 0;
}

u32 hv_ckpt_create(u32 part, u32 name_ptr, u32 name_len) {
    Partition *p = part_of(part); CkptSlot *c; CkptSection *s;
    u32 i, n = 0, off, total, guest_bytes, map[GPA_PAGES];
    u32 vp_bytes, part_bytes = (u32)sizeof(Partition), ch_bytes = (u32)sizeof(Channel);
    Channel *ch = 0;
    if (!p) { ckpt_set_status(HV_STATUS_INVALID_PARAMETER); return 0u; }
    if (p->is_root) { ckpt_set_status(HV_STATUS_ACCESS_DENIED); return 0u; }
    c = ckpt_free_slot();
    if (!c) { ckpt_set_status(HV_STATUS_CHECKPOINT_LIMIT); return 0u; }
    guest_bytes = guest_state_size();
    if (!guest_bytes || guest_bytes > CKPT_GUEST_MAX) { ckpt_set_status(HV_STATUS_CHECKPOINT_LIMIT); return 0u; }
    vp_bytes = p->vp_count * (u32)sizeof(Vp);
    total = CKPT_HEADER_BYTES + CKPT_SECTION_BYTES * CKPT_SECTION_MAX + part_bytes + vp_bytes + ch_bytes + guest_bytes +
            GPA_PAGES * 4u + GPA_PAGES * PAGE + FB_BYTES;
    if (total > CKPT_MAX_BYTES) { ckpt_set_status(HV_STATUS_CHECKPOINT_LIMIT); return 0u; }
    memset(c, 0, sizeof(*c));
    c->used = 1u;
    c->generation = CKPT_NEXT_GENERATION++;
    if (!c->generation) c->generation = CKPT_NEXT_GENERATION++;
    c->source_id = part_id_of(p);
    c->source_state = p->state;
    c->creation_seq = ++CKPT_SEQUENCE;
    if (name_len > NAME_LEN - 1u) name_len = NAME_LEN - 1u;
    if (name_ptr && name_len) memcpy(c->name, (const void *)name_ptr, name_len);
    else { memcpy(c->name, "Checkpoint", 10u); name_len = 10u; }
    c->name[name_len] = 0; c->name_len = name_len;
    off = CKPT_HEADER_BYTES + CKPT_SECTION_BYTES * CKPT_SECTION_MAX;
    if (!ckpt_add_section(c, &n, CKPT_SEC_PARTITION, p, part_bytes, &off)) goto limit;
    for (i = 0; i < p->vp_count; i++) {
        Vp *v = vp_of(p->vps[i]);
        if (!v) goto invalid;
        memcpy(CKPT_VPS_TMP + i, v, sizeof(Vp));
    }
    if (!ckpt_add_section(c, &n, CKPT_SEC_VPS, CKPT_VPS_TMP, vp_bytes, &off)) goto limit;
    ch = chan_of(p->channel);
    if (ch) { if (!ckpt_add_section(c, &n, CKPT_SEC_CHANNEL, ch, ch_bytes, &off)) goto limit; }
    else { memset(&CKPT_CH_TMP, 0, sizeof(CKPT_CH_TMP)); if (!ckpt_add_section(c, &n, CKPT_SEC_CHANNEL, &CKPT_CH_TMP, ch_bytes, &off)) goto limit; }
    if (n >= CKPT_SECTION_MAX || off + guest_bytes > CKPT_MAX_BYTES) goto limit;
    s = &ckpt_sections(c)[n++];
    s->type = CKPT_SEC_GUEST; s->offset = off; s->length = guest_bytes;
    if (guest_state_save(part, (u32)(uintptr_t)(c->image + off), guest_bytes) != guest_bytes) goto invalid;
    s->checksum = ckpt_fnv(c->image + off, guest_bytes); off += guest_bytes;
    for (i = 0; i < GPA_PAGES; i++) map[i] = p->slat[i];
    if (!ckpt_add_section(c, &n, CKPT_SEC_MAP, map, GPA_PAGES * 4u, &off)) goto limit;
    {
        u8 *mem = c->image + off;
        for (i = 0; i < GPA_PAGES; i++) {
            u32 e = p->slat[i], pf = e >> 3u;
            if (e && pf < HOST_PAGES) memcpy(mem + i * PAGE, &PHYS[pf << PAGE_SHIFT], PAGE);
            else memset(mem + i * PAGE, 0, PAGE);
        }
        if (!ckpt_add_section(c, &n, CKPT_SEC_MEMORY, mem, GPA_PAGES * PAGE, &off)) goto limit;
    }
    /* Keep a separately checksummed framebuffer copy even though the pixels
       also occur in the general memory section. */
    {
        CkptSection *ms = n ? &ckpt_sections(c)[n - 1u] : 0;
        if (!ms || FB_GPA + FB_BYTES > ms->length ||
            !ckpt_add_section(c, &n, CKPT_SEC_FRAMEBUFFER,
                              c->image + ms->offset + FB_GPA, FB_BYTES, &off)) goto limit;
    }
    ckpt_put_u32(c->image, CKPT_MAGIC); ckpt_put_u32(c->image + 4u, CKPT_VERSION);
    ckpt_put_u32(c->image + 8u, CKPT_HEADER_BYTES); ckpt_put_u32(c->image + 12u, off);
    ckpt_put_u32(c->image + 16u, 0u); ckpt_put_u32(c->image + 20u, c->source_id);
    ckpt_put_u32(c->image + 24u, c->source_state); ckpt_put_u32(c->image + 28u, n);
    ckpt_put_u32(c->image + 16u, ckpt_fnv(c->image + 20u, off - 20u));
    c->bytes = off; c->mapped_pages = p->mapped_pages; c->memory_bytes = p->mapped_pages * PAGE;
    c->guest_bytes = guest_bytes; c->vp_count = p->vp_count;
    ckpt_set_status(HV_STATUS_SUCCESS);
    return ckpt_handle(c);
limit:
    c->used = 0u; ckpt_set_status(HV_STATUS_CHECKPOINT_LIMIT); return 0u;
invalid:
    c->used = 0u; ckpt_set_status(HV_STATUS_INVALID_PARAMETER); return 0u;
}

u32 hv_ckpt_count(void) { u32 i, n = 0; for (i = 0; i < CKPT_MAX; i++) if (CKPTS[i].used) n++; return n; }
u32 hv_ckpt_slot(u32 slot) { return slot < CKPT_MAX && CKPTS[slot].used ? ckpt_handle(&CKPTS[slot]) : 0u; }
u32 hv_ckpt_field(u32 id, u32 f) {
    CkptSlot *c = ckpt_of(id);
    if (!c) return 0u;
    switch (f) {
    case 0: return id; case 1: return c->source_id; case 2: return (u32)(uintptr_t)c->name;
    case 3: return c->name_len; case 4: return CKPT_VERSION; case 5: return c->bytes;
    case 6: return c->memory_bytes; case 7: return c->mapped_pages; case 8: return c->vp_count;
    case 9: return c->source_state; case 10: return c->creation_seq; case 11: return CKPT_LAST_STATUS;
    default: return 0u;
    }
}
u32 hv_ckpt_data_ptr(u32 id) { CkptSlot *c = ckpt_of(id); return c ? (u32)(uintptr_t)c->image : 0u; }
u32 hv_ckpt_data_len(u32 id) { CkptSlot *c = ckpt_of(id); return c ? c->bytes : 0u; }
u32 hv_ckpt_last_status(void) { return CKPT_LAST_STATUS; }
u32 hv_ckpt_max_bytes(void) { return CKPT_MAX_BYTES; }
u32 hv_ckpt_format_version(void) { return CKPT_VERSION; }
u32 hv_partition_identity(u32 part) { Partition *p = part_of(part); return p ? part_id_of(p) : 0u; }

static i32 ckpt_restore_into(CkptSlot *c, Partition *target, u32 target_id, u32 force_stopped) {
    CkptSection *sp, *sv, *sc, *sg, *sm, *smm, *sf;
    u32 i, old_present, old_vps[MAX_VPS_PER_PART], old_chid, slot;
    u32 old_win, old_lo, old_hi, old_parent, old_gen, old_isroot;
    u32 old_offer_lo = 0, old_offer_hi = 0, old_chgen = 0;
    const u8 *map, *mem;
    Channel *tc;
    u32 st = ckpt_validate(c);
    if (st != HV_STATUS_SUCCESS) { ckpt_set_status(st); return (i32)st; }
    sp = ckpt_find_section(c, CKPT_SEC_PARTITION); sv = ckpt_find_section(c, CKPT_SEC_VPS);
    sc = ckpt_find_section(c, CKPT_SEC_CHANNEL); sg = ckpt_find_section(c, CKPT_SEC_GUEST);
    sm = ckpt_find_section(c, CKPT_SEC_MAP); smm = ckpt_find_section(c, CKPT_SEC_MEMORY);
    sf = ckpt_find_section(c, CKPT_SEC_FRAMEBUFFER);
    if (!sp || !sv || !sc || !sg || !sm || !smm || !sf || sp->length != sizeof(Partition) ||
        sv->length != c->vp_count * sizeof(Vp) || sg->length != c->guest_bytes ||
        sm->length != GPA_PAGES * 4u || smm->length != GPA_PAGES * PAGE || sf->length != FB_BYTES) {
        ckpt_set_status(HV_STATUS_CHECKPOINT_CORRUPT); return HV_STATUS_CHECKPOINT_CORRUPT;
    }
    memcpy(&CKPT_PART_TMP, c->image + sp->offset, sizeof(Partition));
    memcpy(CKPT_VPS_TMP, c->image + sv->offset, sv->length);
    memcpy(&CKPT_CH_TMP, c->image + sc->offset, sizeof(Channel));
    if (target->vp_count != c->vp_count || !target->win_first) { ckpt_set_status(HV_STATUS_INSUFFICIENT_MEM); return HV_STATUS_INSUFFICIENT_MEM; }
    for (i = 0; i < target->vp_count; i++) old_vps[i] = target->vps[i];
    old_chid = target->channel; tc = chan_of(old_chid);
    if (tc) { old_offer_lo = tc->offer_lo; old_offer_hi = tc->offer_hi; old_chgen = tc->generation; }
    old_win = target->win_first; old_lo = target->canary_lo; old_hi = target->canary_hi;
    old_parent = target->parent; old_gen = target->generation; old_isroot = target->is_root;
    old_present = target->mapped_pages;
    if (g_present >= old_present) g_present -= old_present; else g_present = 0;
    slot = (u32)(target - PARTS);
    memcpy(target, &CKPT_PART_TMP, sizeof(Partition));
    target->used = 1u; target->is_root = old_isroot; target->parent = old_parent;
    target->generation = old_gen; target->win_first = old_win; target->canary_lo = old_lo; target->canary_hi = old_hi;
    for (i = 0; i < target->vp_count; i++) target->vps[i] = old_vps[i];
    target->channel = old_chid; target->state = force_stopped ? PS_STOPPED : CKPT_PART_TMP.state;
    target->mapped_pages = 0u;
    map = c->image + sm->offset; mem = c->image + smm->offset;
    for (i = 0; i < GPA_PAGES; i++) {
        u32 e = ckpt_u32(map + i * 4u), pf = old_win + 1u + i;
        /* The image stores source PFNs only as a description of the mapping.
           The target owns a fresh, fixed GPA window, so rebuild each SLAT
           entry with its new PFN while preserving permissions. */
        target->slat[i] = e ? ((pf << 3u) | (e & 7u)) : 0u;
        PAGES[pf].owner = slot + 1u; PAGES[pf].gpa = i << PAGE_SHIFT; PAGES[pf].flags = e & 7u;
        PAGES[pf].mapped = e && (e & SLAT_R) ? 1u : 0u;
        if (PAGES[pf].mapped) { g_present++; target->mapped_pages++; }
        memcpy(&PHYS[pf << PAGE_SHIFT], mem + i * PAGE, PAGE);
    }
    canary_fill(target);
    for (i = 0; i < target->vp_count; i++) {
        Vp *v = vp_of(old_vps[i]);
        if (v) { memcpy(v, &CKPT_VPS_TMP[i], sizeof(Vp)); v->used = 1u; v->part = slot; }
        /* A clone from a running or paused image is stopped at the partition
           boundary, while its VPs remain startable.  Preserve an explicitly
           stopped/guest-halted image as halted. */
        if (v && force_stopped && CKPT_PART_TMP.state != PS_STOPPED && v->state != VS_HALTED)
            v->state = VS_CREATED;
    }
    if (tc) {
        memcpy(tc, &CKPT_CH_TMP, sizeof(Channel));
        tc->used = 1u; tc->part = target_id; tc->chid = old_chid; tc->generation = old_chgen;
        tc->offer_lo = old_offer_lo; tc->offer_hi = old_offer_hi;
        target->channel = old_chid;
    }
    if (target->timer_vp) target->timer_vp = old_vps[0];
    (void)guest_state_load(target_id, (u32)(uintptr_t)(c->image + sg->offset), sg->length, old_vps[0], old_chid);
    ckpt_set_status(HV_STATUS_SUCCESS);
    return HV_STATUS_SUCCESS;
}

i32 hv_ckpt_restore(u32 id, u32 part) {
    CkptSlot *c = ckpt_of(id); Partition *p;
    i32 st;
    if (!c) { u32 bad = ckpt_bad_handle_status(id); ckpt_set_status(bad); return (i32)bad; }
    p = part_of(part ? part : c->source_id);
    if (!p) { ckpt_set_status(HV_STATUS_INVALID_PARAMETER); return HV_STATUS_INVALID_PARAMETER; }
    if (p->is_root) { ckpt_set_status(HV_STATUS_ACCESS_DENIED); return HV_STATUS_ACCESS_DENIED; }
    if (p->state == PS_RUNNING) { ckpt_set_status(HV_STATUS_CHECKPOINT_RUNNING); return HV_STATUS_CHECKPOINT_RUNNING; }
    st = ckpt_restore_into(c, p, part_id_of(p), 0);
    return st;
}

i32 hv_ckpt_delete(u32 id) {
    CkptSlot *c = ckpt_of(id);
    if (!c) { u32 bad = ckpt_bad_handle_status(id); ckpt_set_status(bad); return (i32)bad; }
    c->used = 0u; ckpt_set_status(HV_STATUS_SUCCESS); return HV_STATUS_SUCCESS;
}

u32 hv_ckpt_clone(u32 id, u32 name_ptr, u32 name_len) {
    CkptSlot *c = ckpt_of(id); u32 part, i; i32 st;
    if (!c) { ckpt_set_status(ckpt_bad_handle_status(id)); return 0u; }
    st = (i32)ckpt_validate(c); if (st != HV_STATUS_SUCCESS) { ckpt_set_status((u32)st); return 0u; }
    part = hv_partition_create(name_ptr, name_len);
    if (!part) { ckpt_set_status(HV_STATUS_INSUFFICIENT_MEM); return 0u; }
    for (i = 0; i < c->vp_count; i++) if (!hv_vp_create(part, i)) { hv_partition_delete(part); ckpt_set_status(HV_STATUS_INSUFFICIENT_MEM); return 0u; }
    st = hv_partition_init(part);
    if (st != HV_STATUS_SUCCESS) { hv_partition_delete(part); ckpt_set_status((u32)st); return 0u; }
    st = ckpt_restore_into(c, part_of(part), part, 1u);
    if (st != HV_STATUS_SUCCESS) { hv_partition_delete(part); return 0u; }
    ckpt_set_status(HV_STATUS_SUCCESS);
    return part;
}
u32 hv_migrate_precopy(u32 src, u32 dst, u32 budget_pages) {
    Partition *s = part_of(src), *d = part_of(dst); u32 i, n = 0;
    if (!s || !d || !budget_pages) return 0;
    for (i = 0; i < GPA_PAGES && n < budget_pages; i++) if (s->slat[i]) {
        u32 sp = s->slat[i] >> 3, dp;
        if (!PAGES[sp].dirty) continue;
        if (!d->slat[i]) (void)hv_map_gpa(dst, i << PAGE_SHIFT, 1u, s->slat[i] & 7u);
        dp = d->slat[i] >> 3; memcpy(&PHYS[dp << PAGE_SHIFT], &PHYS[sp << PAGE_SHIFT], PAGE); PAGES[sp].dirty = 0; n++;
    }
    return n;
}

static u32 vmx_field_ok(u32 field) { return field == VMX_FIELD_GUEST_RIP || field == VMX_FIELD_EXIT_REASON || field == VMX_FIELD_EXIT_QUAL || field == VMX_FIELD_EPTP || field == VMX_FIELD_VPID; }
u32 hv_ept_walk_flags(u32 vp, u32 gpa);
static u32 vmx_control_allowed1(u32 which) {
    switch (which) {
    case VMX_CTRL_PIN: return VMX_CTRL_PIN_ALLOWED1;
    case VMX_CTRL_PROC: return VMX_CTRL_PROC_ALLOWED1;
    case VMX_CTRL_EXIT: return VMX_CTRL_EXIT_ALLOWED1;
    case VMX_CTRL_ENTRY: return VMX_CTRL_ENTRY_ALLOWED1;
    default: return 0u;
    }
}
static u32 vmx_control_allowed0(u32 which) {
    (void)which;
    return 0u;
}
u32 hv_vmx_basic(void) { return 0x00000001u; }
u32 hv_vmx_control_limits(u32 which, u32 dst) {
    u32 out[2];
    if (which > VMX_CTRL_ENTRY || !dst) return HV_STATUS_INVALID_PARAMETER;
    out[0] = vmx_control_allowed0(which); out[1] = vmx_control_allowed1(which);
    memcpy((u8 *)dst, out, 8u); return HV_STATUS_SUCCESS;
}
u32 hv_vmx_control(u32 vp, u32 which) {
    Vp *v = vp_of(vp);
    if (!v || which > VMX_CTRL_ENTRY) return 0;
    return v->vmx_controls[which];
}
i32 hv_vmx_set_control(u32 vp, u32 which, u32 value) {
    Vp *v = vp_of(vp);
    if (!v || which > VMX_CTRL_ENTRY) return HV_STATUS_INVALID_PARAMETER;
    if ((value & vmx_control_allowed0(which)) != vmx_control_allowed0(which) ||
        (value & ~vmx_control_allowed1(which))) return HV_STATUS_INVALID_PARAMETER;
    v->vmx_controls[which] = value;
    return HV_STATUS_SUCCESS;
}
u32 hv_vmx_feature_control(void) { return vmx_feature_control_reg; }
i32 hv_vmx_set_feature_control(u32 value) {
    if ((vmx_feature_control_reg & 1u) && value != vmx_feature_control_reg) return VMX_FAIL_VALID;
    vmx_feature_control_reg = value; return HV_STATUS_SUCCESS;
}
i32 hv_vmx_on(u32 vp) {
    Vp *v = vp_of(vp); if (!v) return HV_STATUS_INVALID_PARAMETER;
    if (!(vmx_feature_control_reg & 1u) || !(vmx_feature_control_reg & 4u)) return HV_STATUS_ACCESS_DENIED;
    if (v->vmx_on) return VMX_FAIL_VALID; v->vmx_on = 1u; return HV_STATUS_SUCCESS;
}
i32 hv_vmx_off(u32 vp) { Vp *v = vp_of(vp); if (!v || !v->vmx_on) return VMX_FAIL_INVALID; v->vmx_on = 0; v->vmcs_state = 0; v->vmcs = 0; return HV_STATUS_SUCCESS; }
i32 hv_vmclear(u32 vp, u32 vmcs) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || !v->vmx_on || !vmcs) return VMX_FAIL_INVALID;
    v->vmcs = vmcs; v->vmcs_state = 0; v->vmx_error = 0; v->vmx_exit_reason = 0;
    v->vmx_host_state = 1u; v->vmx_guest_state = 1u;
    for (i = 0; i < 4u; i++) v->vmx_controls[i] = 0u;
    return HV_STATUS_SUCCESS;
}
i32 hv_vmptrld(u32 vp, u32 vmcs) { Vp *v = vp_of(vp); if (!v || !v->vmx_on || !vmcs) return VMX_FAIL_INVALID; v->vmcs = vmcs; return HV_STATUS_SUCCESS; }
u32 hv_vmptrst(u32 vp) { Vp *v = vp_of(vp); return v ? v->vmcs : 0; }
i32 hv_vmwrite(u32 vp, u32 field, u32 value) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || !v->vmx_on || !v->vmcs) return VMX_FAIL_INVALID;
    if (!vmx_field_ok(field)) { v->vmx_error = VMXERR_BAD_FIELD; return VMX_FAIL_VALID; }
    if (field == VMX_FIELD_EPTP && ((value & 7u) > 6u || ((value >> 3) & 7u) != 3u)) {
        v->vmx_error = VMXERR_BAD_FIELD; return VMX_FAIL_VALID;
    }
    i = field & 63u; VMX_FIELDS[vp - 1u][i] = value;
    if (field == VMX_FIELD_EPTP) v->vmx_ept_generation = value;
    return HV_STATUS_SUCCESS;
}
i32 hv_vmread(u32 vp, u32 field, u32 dst) {
    Vp *v = vp_of(vp); if (!v || !v->vmx_on || !v->vmcs || !dst) return VMX_FAIL_INVALID;
    if (!vmx_field_ok(field)) { v->vmx_error = VMXERR_BAD_FIELD; return VMX_FAIL_VALID; }
    *(u32 *)dst = VMX_FIELDS[vp - 1u][field & 63u]; return HV_STATUS_SUCCESS;
}
i32 hv_vmlaunch(u32 vp) {
    Vp *v = vp_of(vp); if (!v || !v->vmx_on || !v->vmcs) return VMX_FAIL_INVALID;
    if (v->vmcs_state != 0u) { v->vmx_error = VMXERR_VMLAUNCH_NONCLEAR; return VMX_FAIL_VALID; }
    {
        u32 i;
        for (i = 0; i < 4u; i++) if ((v->vmx_controls[i] & ~vmx_control_allowed1(i)) ||
                                      (v->vmx_controls[i] & vmx_control_allowed0(i)) != vmx_control_allowed0(i)) {
            v->vmx_error = VMXERR_ENTRY_INVALID_CONTROL; v->vmx_exit_reason = VMXERR_ENTRY_INVALID_CONTROL;
            return VMX_FAIL_VALID;
        }
        if (!v->vmx_host_state) { v->vmx_error = VMXERR_ENTRY_INVALID_HOST; v->vmx_exit_reason = VMXERR_ENTRY_INVALID_HOST; return VMX_FAIL_VALID; }
        if (!v->vmx_guest_state) { v->vmx_error = VMXERR_ENTRY_INVALID_CONTROL; v->vmx_exit_reason = VMXERR_ENTRY_INVALID_CONTROL; return VMX_FAIL_VALID; }
    }
    v->vmcs_state = 2u; return HV_STATUS_SUCCESS;
}
i32 hv_vmresume(u32 vp) {
    Vp *v = vp_of(vp); if (!v || !v->vmx_on || !v->vmcs) return VMX_FAIL_INVALID;
    if (v->vmcs_state != 2u) { v->vmx_error = VMXERR_VMRESUME_CLEAR; return VMX_FAIL_VALID; }
    v->vmx_exit_reason = 0; v->vmx_exit_qual = 0; return HV_STATUS_SUCCESS;
}
i32 hv_vmx_set_state(u32 vp, u32 which, u32 valid) {
    Vp *v = vp_of(vp);
    if (!v || which > 1u) return HV_STATUS_INVALID_PARAMETER;
    if (which == 0u) v->vmx_host_state = valid ? 1u : 0u;
    else v->vmx_guest_state = valid ? 1u : 0u;
    return HV_STATUS_SUCCESS;
}
u32 hv_vmx_field(u32 vp, u32 f) {
    Vp *v = vp_of(vp); if (!v) return 0;
    switch (f) { case 0: return v->vmx_on; case 1: return v->vmcs_state; case 2: return v->vmx_exit_reason; case 3: return v->vmx_exit_qual; case 4: return v->vmx_error; case 5: return VMX_FIELDS[vp - 1u][VMX_FIELD_EPTP & 63u]; case 6: return VMX_FIELDS[vp - 1u][VMX_FIELD_VPID & 63u]; case 7: return v->vmx_interrupt_info; case 8: return v->vmx_interrupt_window; case 9: return v->vmx_preempt_timer; case 10: return v->vmx_nested; case 11: return v->vmx_interrupt_delivered; case 12: return v->vmx_nested_exit; case 13: return v->vmx_nested_reflect; case 14: return v->vmx_nested_exit_qual; case 15: return v->vmx_nested_merged; default: return 0; }
}
u32 hv_vmx_guest_action(u32 vp, u32 action, u32 arg) {
    Vp *v = vp_of(vp); u32 reason = action, qual = 0, page, access, flags;
    if (!v || !v->vmx_on || v->vmcs_state != 2u) return HV_STATUS_BAD_PART_STATE;
    if ((action == VMX_EXIT_RDMSR || action == VMX_EXIT_WRMSR)) {
        u32 i, want = action == VMX_EXIT_RDMSR ? 1u : 2u; reason = 0;
        for (i = 0; i < 8u; i++) if (v->vmx_msr_bitmap_msrs[i] == arg && (v->vmx_msr_bitmap_flags[i] & want)) { reason = action; break; }
    } else if (action == 30u) {
        u32 i;
        reason = 0;
        for (i = 0; i < 8u; i++) if (v->vmx_io_bitmap_ports[i] == (arg & 0xFFFFu) && v->vmx_io_bitmap_flags[i]) { reason = 30u; break; }
    } else if (action == VMX_EXIT_EPT_MISCONFIG) reason = VMX_EXIT_EPT_MISCONFIG;
    else if (action == VMX_EXIT_EPT_VIOLATION) {
        page = (arg & ~7u) >> PAGE_SHIFT; access = arg & 7u;
        if (page >= GPA_PAGES) { reason = VMX_EXIT_EPT_VIOLATION; qual = access; }
        else {
            if (!v->vmx_tlb_valid || v->vmx_tlb_gpa != page) { v->vmx_tlb_gpa = page; v->vmx_tlb_flags = hv_ept_walk_flags(vp, page << PAGE_SHIFT); v->vmx_tlb_vpid = v->vmx_vpid; v->vmx_tlb_valid = 1u; }
            flags = v->vmx_tlb_flags;
            if ((flags & 1u) && !(flags & 2u)) { reason = VMX_EXIT_EPT_MISCONFIG; qual = flags; }
            else if ((flags & access) != access) { reason = VMX_EXIT_EPT_VIOLATION; qual = access | ((flags & 7u) << 3); }
            else { reason = 0; VMX_EPT_AD[vp - 1u][page] |= 1u; if (access & VTL_ACCESS_W) VMX_EPT_AD[vp - 1u][page] |= 2u; }
        }
    }
    v->vmx_exit_reason = reason; v->vmx_exit_qual = qual;
    VMX_FIELDS[vp - 1u][VMX_FIELD_EXIT_REASON & 63u] = reason;
    VMX_FIELDS[vp - 1u][VMX_FIELD_EXIT_QUAL & 63u] = qual;
    return reason;
}
i32 hv_ept_map(u32 vp, u32 gpa, u32 pfn, u32 flags) {
    Vp *v = vp_of(vp); if (!v || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u)) || !pfn || !flags || (flags & ~7u)) return HV_STATUS_INVALID_PARAMETER;
    {
        u32 x = gpa >> PAGE_SHIFT;
        u32 l4 = 0u, l3 = (gpa >> 30) & 511u, l2 = (gpa >> 21) & 511u, l1 = (gpa >> 12) & 511u;
        VMX_EPT_TABLE[vp - 1u][0][l4] = 1u;
        VMX_EPT_TABLE[vp - 1u][1][l3] = 1u;
        VMX_EPT_TABLE[vp - 1u][2][l2] = 1u;
        /* Keep the synthetic present bit out of the PFN: unlike a real EPT
           entry this model also exposes a compact present marker, so use a
           four-bit low field before shifting the host PFN. */
        VMX_EPT_TABLE[vp - 1u][3][l1] = (pfn << 4) | (flags & 7u) | 8u;
        VMX_EPT[vp - 1u][x] = (u8)flags; VMX_EPT_AD[vp - 1u][x] = 0;
    }
    return HV_STATUS_SUCCESS;
}
u32 hv_ept_walk_flags(u32 vp, u32 gpa) {
    Vp *v = vp_of(vp); u32 l4, l3, l2, l1, leaf;
    if (!v || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u))) return 0;
    l4 = 0u; l3 = (gpa >> 30) & 511u; l2 = (gpa >> 21) & 511u; l1 = (gpa >> 12) & 511u;
    if (!VMX_EPT_TABLE[vp - 1u][0][l4] || !VMX_EPT_TABLE[vp - 1u][1][l3] || !VMX_EPT_TABLE[vp - 1u][2][l2]) return 0;
    leaf = VMX_EPT_TABLE[vp - 1u][3][l1];
    return (leaf & 8u) ? (leaf & 7u) : 0u;
}
u32 hv_ept_field(u32 vp, u32 gpa, u32 field) {
    Vp *v = vp_of(vp); u32 page;
    if (!v || gpa >= GPA_LIMIT || (gpa & (PAGE - 1u)) || field > 2u) return 0;
    page = gpa >> PAGE_SHIFT;
    if (field == 0u) return VMX_EPT[vp - 1u][page] & 7u;
    return (VMX_EPT_AD[vp - 1u][page] >> (field - 1u)) & 1u;
}
i32 hv_invept(u32 vp, u32 global) { Vp *v = vp_of(vp); (void)global; if (!v) return HV_STATUS_INVALID_PARAMETER; v->vmx_tlb_valid = 0; v->vmx_ept_generation++; return HV_STATUS_SUCCESS; }
i32 hv_vmx_set_vpid(u32 vp, u32 vpid) {
    Vp *v = vp_of(vp);
    if (!v || !vpid || vpid > 0xFFFFu) return HV_STATUS_INVALID_PARAMETER;
    v->vmx_vpid = vpid; VMX_FIELDS[vp - 1u][VMX_FIELD_VPID & 63u] = vpid;
    return HV_STATUS_SUCCESS;
}
i32 hv_invvpid(u32 vp, u32 global, u32 vpid) {
    Vp *v = vp_of(vp);
    if (!v || (!global && (!vpid || vpid != v->vmx_vpid))) return HV_STATUS_INVALID_PARAMETER;
    if (global || v->vmx_tlb_vpid == vpid) v->vmx_tlb_valid = 0;
    return HV_STATUS_SUCCESS;
}
i32 hv_vmx_inject_interrupt(u32 vp, u32 vector) { Vp *v = vp_of(vp); if (!v || vector > 255u) return HV_STATUS_INVALID_PARAMETER; v->vmx_interrupt_info = vector; if (v->vmx_guest_if) v->ipi_pending = 1u; else v->vmx_interrupt_window = 1u; return HV_STATUS_SUCCESS; }
i32 hv_vmx_set_guest_if(u32 vp, u32 enabled) { Vp *v = vp_of(vp); if (!v) return HV_STATUS_INVALID_PARAMETER; v->vmx_guest_if = enabled ? 1u : 0u; if (v->vmx_guest_if && v->vmx_interrupt_info) { v->ipi_pending = 1u; v->vmx_interrupt_window = 0; } return HV_STATUS_SUCCESS; }
i32 hv_vmx_set_msr_bitmap(u32 vp, u32 msr, u32 read_exit, u32 write_exit) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || msr > 0xFFFFFFFFu) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < 8u; i++) if (v->vmx_msr_bitmap_msrs[i] == msr || !v->vmx_msr_bitmap_flags[i]) { v->vmx_msr_bitmap_msrs[i] = msr; v->vmx_msr_bitmap_flags[i] = (read_exit ? 1u : 0u) | (write_exit ? 2u : 0u); return HV_STATUS_SUCCESS; }
    return HV_STATUS_INSUFFICIENT_MEM;
}
i32 hv_vmx_set_io_bitmap(u32 vp, u32 port, u32 read_exit, u32 write_exit) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || port > 0xFFFFu) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < 8u; i++) if (v->vmx_io_bitmap_ports[i] == port || !v->vmx_io_bitmap_flags[i]) {
        v->vmx_io_bitmap_ports[i] = port;
        v->vmx_io_bitmap_flags[i] = (read_exit ? 1u : 0u) | (write_exit ? 2u : 0u);
        return HV_STATUS_SUCCESS;
    }
    return HV_STATUS_INSUFFICIENT_MEM;
}
i32 hv_vmx_set_preemption_timer(u32 vp, u32 ticks) { Vp *v = vp_of(vp); if (!v) return HV_STATUS_INVALID_PARAMETER; v->vmx_preempt_timer = ticks; return HV_STATUS_SUCCESS; }
i32 hv_vmx_nested_enter(u32 vp) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || !v->vmx_on || v->vmx_nested) return VMX_FAIL_VALID;
    v->vmx_nested = 1u; v->vmx_nested_exit = 0u; v->vmx_nested_exit_qual = 0u; v->vmx_nested_merged = 0u;
    for (i = 0; i < VMX_NESTED_FIELDS; i++) { v->vmx_vmcs12[i] = 0u; v->vmx_vmcs02[i] = 0u; }
    return HV_STATUS_SUCCESS;
}
i32 hv_vmx_nested_set_vmcs12(u32 vp, u32 field, u32 value) {
    Vp *v = vp_of(vp);
    if (!v || !v->vmx_nested || field >= VMX_NESTED_FIELDS) return HV_STATUS_INVALID_PARAMETER;
    v->vmx_vmcs12[field] = value; v->vmx_nested_merged = 0u; return HV_STATUS_SUCCESS;
}
i32 hv_vmx_nested_merge(u32 vp) {
    Vp *v = vp_of(vp); u32 i;
    if (!v || !v->vmx_nested || !v->vmx_on) return HV_STATUS_BAD_PART_STATE;
    for (i = 0; i < 4u; i++) if (v->vmx_vmcs12[i] & ~vmx_control_allowed1(i)) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < 4u; i++) v->vmx_vmcs02[i] = v->vmx_vmcs12[i] & vmx_control_allowed1(i);
    v->vmx_vmcs02[VMX_NESTED_GUEST_RIP] = v->vmx_vmcs12[VMX_NESTED_GUEST_RIP];
    v->vmx_vmcs02[VMX_NESTED_EXIT_REASON] = 0u; v->vmx_vmcs02[VMX_NESTED_EXIT_QUAL] = 0u;
    v->vmx_vmcs02[VMX_NESTED_LAUNCHED] = 1u; v->vmx_nested_merged = 1u;
    return HV_STATUS_SUCCESS;
}
u32 hv_vmx_nested_field(u32 vp, u32 bank, u32 field) {
    Vp *v = vp_of(vp);
    if (!v || bank > 1u || field >= VMX_NESTED_FIELDS) return 0u;
    return bank ? v->vmx_vmcs02[field] : v->vmx_vmcs12[field];
}
i32 hv_vmx_nested_set_reflect(u32 vp, u32 reason, u32 reflect) {
    Vp *v = vp_of(vp);
    if (!v || !v->vmx_nested || reason > 63u) return HV_STATUS_INVALID_PARAMETER;
    v->vmx_nested_reason = reason; v->vmx_nested_reflect = reflect ? 1u : 0u; return HV_STATUS_SUCCESS;
}
u32 hv_vmx_nested_action(u32 vp, u32 action, u32 arg) {
    Vp *v = vp_of(vp); u32 r;
    if (!v || !v->vmx_nested || v->vmcs_state != 2u) return HV_STATUS_BAD_PART_STATE;
    if (!v->vmx_nested_merged && hv_vmx_nested_merge(vp) != HV_STATUS_SUCCESS) return HV_STATUS_INVALID_PARAMETER;
    r = hv_vmx_guest_action(vp, action, arg);
    v->vmx_vmcs02[VMX_NESTED_EXIT_REASON] = v->vmx_exit_reason;
    v->vmx_vmcs02[VMX_NESTED_EXIT_QUAL] = v->vmx_exit_qual;
    if (v->vmx_nested_reflect && action == v->vmx_nested_reason) {
        v->vmx_nested_exit = r; v->vmx_nested_exit_qual = v->vmx_exit_qual;
        v->vmx_vmcs12[VMX_NESTED_EXIT_REASON] = v->vmx_exit_reason;
        v->vmx_vmcs12[VMX_NESTED_EXIT_QUAL] = v->vmx_exit_qual;
        v->vmx_nested_reflect = 0u;
    } else { v->vmx_nested_exit = 0u; v->vmx_nested_exit_qual = 0u; }
    return r;
}
i32 hv_vmx_nested_exit(u32 vp) { Vp *v = vp_of(vp); if (!v || !v->vmx_nested) return VMX_FAIL_INVALID; v->vmx_nested = 0; v->vmx_nested_merged = 0; return HV_STATUS_SUCCESS; }

/* ------------------------------------------------------ guest register ISA */
/*
   This is intentionally a small, fixed-width instruction set rather than a
   second C guest.  The code bytes live in the partition's GPA space.  A
   fetch, load, and store all resolve a page through the partition SLAT and,
   when the VP is in VMX/nested mode, through its EPT walk as well.  A failed
   access records a VM exit and leaves RIP at the faulting instruction so the
   VTL or L1 handler can decide what to do before resuming.
*/
static u32 isa_ept_pfn(Vp *v, u32 gpa) {
    u32 l1, leaf;
    if (!v || gpa >= GPA_LIMIT) return 0;
    l1 = (gpa >> PAGE_SHIFT) & 511u;
    leaf = VMX_EPT_TABLE[(u32)(v - VPS)][3][l1];
    return (leaf & 8u) ? ((leaf & ~0xFu) >> 4) : 0u;
}

static u32 isa_fail(Vp *v, Partition *p, u32 gpa, u32 access, u32 flags, u32 reason) {
    if (!v || !p) return 0;
    v->isa_faults++;
    v->isa_last_exit = reason ? reason : ISA_EXIT_SLAT;
    v->isa_last_qual = access | ((flags & 7u) << 3);
    v->isa_status = (reason == VMX_EXIT_EPT_MISCONFIG) ? HV_STATUS_BAD_PART_STATE : HV_STATUS_SLAT_FAULT;
    p->faults++; g_slat_faults++;
    if (v->isa_vtl == VTL0 && p->vtl_enabled) {
        p->vtl_intercepts++;
        p->vtl_intercept_gpa = gpa;
        p->vtl_intercept_access = access;
        p->current_vtl = VTL1;
    }
    return 0;
}

static u32 isa_translate(Vp *v, Partition *p, u32 gpa, u32 access, u32 *pfn) {
    u32 flags = 0, page, allowed, ept_flags, reason;
    if (!v || !p || gpa >= GPA_LIMIT || !slat_pfn(p, gpa, &flags))
        return isa_fail(v, p, gpa, access, flags, VMX_EXIT_EPT_VIOLATION);
    page = gpa >> PAGE_SHIFT;

    if ((access & VTL_ACCESS_X) && p->vtl_enabled &&
        !p->hvci_signed[page] && !(p->vsm_code_ready && p->vsm_code_gpa == (page << PAGE_SHIFT))) {
        p->hvci_denies++;
        return isa_fail(v, p, gpa, access, flags, VMX_EXIT_EPT_VIOLATION);
    }

    /* Nested L2 accesses use the effective VMCS02 EPT and retain the normal
       stale-TLB behaviour until INVEPT/INVVPID is called. */
    if (v->vmx_on && v->vmcs_state == 2u) {
        reason = v->vmx_nested ? hv_vmx_nested_action((u32)(v - VPS) + 1u,
                    VMX_EXIT_EPT_VIOLATION, (gpa & ~(PAGE - 1u)) | access)
                              : hv_vmx_guest_action((u32)(v - VPS) + 1u,
                    VMX_EXIT_EPT_VIOLATION, (gpa & ~(PAGE - 1u)) | access);
        if (reason) return isa_fail(v, p, gpa, access, v->vmx_exit_qual >> 3, reason);
        ept_flags = v->vmx_tlb_flags & 7u;
        if (!(ept_flags & access)) return isa_fail(v, p, gpa, access, ept_flags, VMX_EXIT_EPT_VIOLATION);
        *pfn = isa_ept_pfn(v, gpa);
        if (!*pfn || *pfn >= HOST_PAGES) return isa_fail(v, p, gpa, access, ept_flags, VMX_EXIT_EPT_VIOLATION);
        return 1u;
    }

    /* VTL0 sees the secure kernel's protection overlay.  VTL1 executes with
       the underlying SLAT permissions, but code still has to be admitted by
       HVCI/VSM before an execute fetch is allowed. */
    if (v->isa_vtl == VTL0 && p->vtl_enabled) {
        allowed = vtl_perm(p, VTL0, page);
        if ((allowed & access) != access)
            return isa_fail(v, p, gpa, access, allowed, VMX_EXIT_EPT_VIOLATION);
    }
    if (!(flags & access)) return isa_fail(v, p, gpa, access, flags, VMX_EXIT_EPT_VIOLATION);
    *pfn = flags ? (slat_pfn(p, gpa, &flags)) : 0u;
    return *pfn != 0u;
}

static u32 isa_read32(Vp *v, Partition *p, u32 gpa, u32 access, u32 *out) {
    u32 pfn, off;
    if (!isa_translate(v, p, gpa, access, &pfn) || gpa + 4u > GPA_LIMIT) return 0;
    off = gpa & (PAGE - 1u);
    if (off + 4u > PAGE) {
        u8 b[4]; u32 i;
        for (i = 0; i < 4u; i++) if (!isa_translate(v, p, gpa + i, access, &pfn)) return 0;
        for (i = 0; i < 4u; i++) b[i] = PHYS[(pfn << PAGE_SHIFT) + ((gpa + i) & (PAGE - 1u))];
        *out = (u32)b[0] | ((u32)b[1] << 8) | ((u32)b[2] << 16) | ((u32)b[3] << 24);
        return 1u;
    }
    *out = *(u32 *)&PHYS[(pfn << PAGE_SHIFT) + off];
    return 1u;
}

static u32 isa_write32(Vp *v, Partition *p, u32 gpa, u32 value) {
    u32 pfn, off;
    if (!isa_translate(v, p, gpa, VTL_ACCESS_W, &pfn) || gpa + 4u > GPA_LIMIT) return 0;
    off = gpa & (PAGE - 1u);
    if (off + 4u > PAGE) {
        u32 i;
        for (i = 0; i < 4u; i++) if (!isa_translate(v, p, gpa + i, VTL_ACCESS_W, &pfn)) return 0;
        for (i = 0; i < 4u; i++) PHYS[(pfn << PAGE_SHIFT) + ((gpa + i) & (PAGE - 1u))] = (u8)(value >> (i * 8u));
    } else *(u32 *)&PHYS[(pfn << PAGE_SHIFT) + off] = value;
    PAGES[pfn].dirty = 1u;
    return 1u;
}

static u32 isa_fetch(Vp *v, Partition *p, u32 gpa, u8 *ins) {
    u32 pfn, i, off;
    if (gpa < v->isa_entry || gpa + ISA_INSN_BYTES > v->isa_code_end || (gpa & 3u)) {
        isa_fail(v, p, gpa, VTL_ACCESS_X, 0u, ISA_EXIT_ILLEGAL); return 0;
    }
    for (i = 0; i < ISA_INSN_BYTES; i++) {
        if (!isa_translate(v, p, gpa + i, VTL_ACCESS_X, &pfn)) return 0;
        off = (gpa + i) & (PAGE - 1u);
        ins[i] = PHYS[(pfn << PAGE_SHIFT) + off];
    }
    return 1u;
}

static void isa_exit(Vp *v, u32 reason, u32 qual) {
    v->isa_last_exit = reason; v->isa_last_qual = qual;
    if (v->vmx_on) {
        v->vmx_exit_reason = reason;
        v->vmx_exit_qual = qual;
        VMX_FIELDS[(u32)(v - VPS)][VMX_FIELD_EXIT_REASON & 63u] = reason;
        VMX_FIELDS[(u32)(v - VPS)][VMX_FIELD_EXIT_QUAL & 63u] = qual;
    }
}

i32 hv_isa_reset(u32 vp, u32 entry_gpa, u32 code_pages, u32 vtl) {
    Vp *v = vp_of(vp); Partition *p; u32 i, pfn, code_end;
    if (!v || vtl > VTL1 || !code_pages || code_pages > ISA_MAX_CODE_PAGES ||
        (entry_gpa & (ISA_INSN_BYTES - 1u))) return HV_STATUS_INVALID_PARAMETER;
    p = &PARTS[v->part];
    if (vtl == VTL1 && !p->vtl_enabled) return HV_STATUS_ACCESS_DENIED;
    code_end = entry_gpa + code_pages * PAGE;
    if (code_end < entry_gpa || code_end > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < code_pages; i++) {
        if (!slat_pfn(p, entry_gpa + i * PAGE, 0)) return HV_STATUS_SLAT_FAULT;
        pfn = slat_pfn(p, entry_gpa + i * PAGE, 0);
        if (!pfn || !(p->slat[(entry_gpa >> PAGE_SHIFT) + i] & 4u)) return HV_STATUS_ACCESS_DENIED;
    }
    memset(v->isa_regs, 0, sizeof(v->isa_regs));
    v->isa_active = 1u; v->isa_vtl = vtl; v->isa_secure = (vtl == VTL1);
    v->isa_entry = entry_gpa; v->isa_rip = entry_gpa; v->isa_code_end = code_end;
    v->isa_steps = v->isa_faults = v->isa_last_exit = v->isa_last_qual = 0u;
    v->isa_halted = 0u; v->isa_status = HV_STATUS_SUCCESS;
    v->vmx_exit_reason = 0u; v->vmx_exit_qual = 0u;
    return HV_STATUS_SUCCESS;
}

i32 hv_isa_stop(u32 vp) {
    Vp *v = vp_of(vp); if (!v) return HV_STATUS_INVALID_PARAMETER;
    v->isa_active = 0u; v->isa_halted = 1u; return HV_STATUS_SUCCESS;
}

u32 hv_isa_step(u32 vp, u32 budget) {
    Vp *v = vp_of(vp); Partition *p; u32 n = 0, imm, a, target, st, out[4];
    u8 ins[ISA_INSN_BYTES]; u32 rd, ra, rb, op; i32 simm;
    if (!v || !v->isa_active || v->isa_halted) return 0u;
    p = &PARTS[v->part]; if (!budget) return 0u; if (budget > 1024u) budget = 1024u;
    while (n < budget && !v->isa_halted) {
        if (v->isa_steps >= ISA_MAX_STEPS) { v->isa_status = HV_STATUS_BAD_PART_STATE; v->isa_halted = 1u; isa_exit(v, ISA_EXIT_ILLEGAL, 0u); break; }
        if (!isa_fetch(v, p, v->isa_rip, ins)) { v->isa_halted = 1u; break; }
        op = ins[0]; rd = ins[1] & 15u; ra = ins[2] & 15u; rb = ins[3] & 15u;
        imm = (u32)ins[4] | ((u32)ins[5] << 8) | ((u32)ins[6] << 16) | ((u32)ins[7] << 24);
        simm = (i32)(int16_t)(imm & 0xFFFFu);
        v->isa_rip += ISA_INSN_BYTES; v->isa_steps++; n++;
        switch (op) {
        case ISA_OP_HALT: v->isa_halted = 1u; v->isa_status = HV_STATUS_SUCCESS; isa_exit(v, VMX_EXIT_HLT, 0u); break;
        case ISA_OP_MOVI: v->isa_regs[rd] = imm; break;
        case ISA_OP_ADD: v->isa_regs[rd] = v->isa_regs[ra] + v->isa_regs[rb]; break;
        case ISA_OP_SUB: v->isa_regs[rd] = v->isa_regs[ra] - v->isa_regs[rb]; break;
        case ISA_OP_XOR: v->isa_regs[rd] = v->isa_regs[ra] ^ v->isa_regs[rb]; break;
        case ISA_OP_CMP: v->isa_regs[rd] = (v->isa_regs[ra] == v->isa_regs[rb]) ? 1u : 0u; break;
        case ISA_OP_LOAD:
            a = v->isa_regs[ra] + (u32)simm;
            if (!isa_read32(v, p, a, VTL_ACCESS_R, &v->isa_regs[rd])) v->isa_halted = 1u;
            break;
        case ISA_OP_STORE:
            a = v->isa_regs[ra] + (u32)simm;
            if (!isa_write32(v, p, a, v->isa_regs[rb])) v->isa_halted = 1u;
            break;
        case ISA_OP_JMP:
            target = (u32)((i32)v->isa_rip + simm * (i32)ISA_INSN_BYTES);
            if (target < v->isa_entry || target + ISA_INSN_BYTES > v->isa_code_end || (target & 3u)) { isa_fail(v, p, target, VTL_ACCESS_X, 0u, ISA_EXIT_ILLEGAL); v->isa_halted = 1u; }
            else v->isa_rip = target;
            break;
        case ISA_OP_JNZ:
            if (v->isa_regs[ra]) { target = (u32)((i32)v->isa_rip + simm * (i32)ISA_INSN_BYTES); if (target < v->isa_entry || target + ISA_INSN_BYTES > v->isa_code_end || (target & 3u)) { isa_fail(v, p, target, VTL_ACCESS_X, 0u, ISA_EXIT_ILLEGAL); v->isa_halted = 1u; } else v->isa_rip = target; }
            break;
        case ISA_OP_VMCALL: isa_exit(v, VMX_EXIT_VMCALL, imm); st = hv_vmcall(vp); v->isa_status = st; break;
        case ISA_OP_CPUID: cpuid_leaf(v->isa_regs[ra], v->isa_regs[rb], out, p->priv_lo, p->priv_hi); v->isa_regs[0] = out[0]; v->isa_regs[1] = out[1]; v->isa_regs[2] = out[2]; v->isa_regs[3] = out[3]; isa_exit(v, VMX_EXIT_CPUID, v->isa_regs[ra]); break;
        case ISA_OP_RDMSR: isa_exit(v, VMX_EXIT_RDMSR, v->isa_regs[ra]); st = msr_read(v, v->isa_regs[ra], &v->isa_regs[rd], &v->isa_regs[(rd + 1u) & 15u]); v->isa_status = st; break;
        case ISA_OP_WRMSR: isa_exit(v, VMX_EXIT_WRMSR, v->isa_regs[ra]); st = msr_write(v, v->isa_regs[ra], v->isa_regs[rd], v->isa_regs[(rd + 1u) & 15u]); v->isa_status = st; break;
        case ISA_OP_VTL_CALL: st = hv_vtl_call(vp, v->isa_regs[ra], v->isa_regs[rb]); v->isa_status = st; if (!st) v->isa_vtl = VTL1; break;
        case ISA_OP_VTL_RETURN: st = hv_vtl_return(vp); v->isa_status = st; if (!st) v->isa_vtl = VTL0; break;
        default: v->isa_status = HV_STATUS_NOT_IMPLEMENTED; isa_fail(v, p, v->isa_rip - ISA_INSN_BYTES, 0u, 0u, ISA_EXIT_ILLEGAL); v->isa_halted = 1u; break;
        }
        if (v->isa_halted && v->isa_status == HV_STATUS_SUCCESS) break;
    }
    return n;
}

u32 hv_isa_field(u32 vp, u32 field) {
    Vp *v = vp_of(vp); if (!v) return 0u;
    switch (field) {
    case 0: return v->isa_active; case 1: return v->isa_vtl; case 2: return v->isa_rip;
    case 3: return v->isa_last_exit; case 4: return v->isa_last_qual; case 5: return v->isa_halted;
    case 6: return v->isa_steps; case 7: return v->isa_faults; case 8: return v->isa_status;
    case 9: return v->isa_entry; case 10: return v->isa_code_end; case 11: return v->isa_secure;
    default: return 0u;
    }
}
u32 hv_isa_reg(u32 vp, u32 reg) { Vp *v = vp_of(vp); return (v && reg < ISA_REGS) ? v->isa_regs[reg] : 0u; }
i32 hv_isa_set_reg(u32 vp, u32 reg, u32 value) { Vp *v = vp_of(vp); if (!v || reg >= ISA_REGS) return HV_STATUS_INVALID_PARAMETER; v->isa_regs[reg] = value; return HV_STATUS_SUCCESS; }
i32 hv_isa_load(u32 part, u32 gpa, u32 src, u32 len) {
    Partition *p = part_of(part);
    if (!p || !src || !len || gpa + len < gpa || gpa + len > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    return hv_mem_write(p, gpa, src, len, 0u) == len ? HV_STATUS_SUCCESS : HV_STATUS_SLAT_FAULT;
}

/* -------------------------------------------------------------- scheduling */
u32 hv_schedule(u32 elapsed_ms);
u32 hv_schedule(u32 elapsed_ms) {
    u32 i, budget, runs = 0;
    if (!g_inited) return 0;
    REF_TIME += elapsed_ms;
    g_slices++;
    /* synthetic timers first: fire for every running partition */
    for (i = 0; i < MAX_PARTS; i++) {
        Partition *p = &PARTS[i];
        if (!p->used || p->state != PS_RUNNING || !p->has_guest || !p->timer_armed) continue;
        p->timer_acc += elapsed_ms;
        while (p->timer_acc >= p->timer_period) {
            p->timer_acc -= p->timer_period;
            timer_fire(p);
            if (p->timer_oneshot) { p->timer_armed = 0; break; }
        }
    }
    for (i = 0; i < MAX_VPS; i++) {
        Vp *v = &VPS[i]; u32 n;
        if (!v->used || v->state != VS_RUNNING || PARTS[v->part].state != PS_RUNNING) continue;
        for (n = 0; n < 4u; n++) {
            SynthTimer *t = &v->stimer[n];
            if (!t->armed || !t->period) continue;
            t->acc += elapsed_ms;
            if (t->acc >= t->period) {
                u32 fires = t->acc / t->period; t->acc %= t->period;
                if (t->oneshot) fires = 1u;
                t->fires += fires; t->last = REF_TIME; t->pending++;
                if (t->direct) {
                    v->ipi_vector = v->sint_vec[t->sint]; v->ipi_pending = 1u;
                } else if (v->sint_masked[t->sint]) t->masked++;
                else { v->sint_count[t->sint]++; v->sint_pending[t->sint] = 1u; }
                if (t->oneshot) t->armed = 0;
            }
        }
    }
    budget = elapsed_ms * INSTR_PER_MS;
    if (!budget) budget = 1u;
    while (budget > 0) {
        Vp *v = next_vp();
        u32 n, ran;
        if (!v) { g_idle_slices++; break; }
        n = v->slice_left < budget ? v->slice_left : budget;
        ran = vm_entry_batch(v, n);
        if (!ran) { if (v->state != VS_RUNNING) continue; else break; }
        if (ran > n) ran = n;              /* one entry may overshoot by a bit */
        budget -= ran;
        if (ran >= v->slice_left) v->slice_left = 0; else v->slice_left -= ran;
        v->run_ns += (u64)ran * (u64)NS_PER_INSTR;
        v->run_us_frac += ran * (NS_PER_INSTR / 1000u);
        while (v->run_us_frac >= 1000u) { v->run_us_frac -= 1000u; v->run_ms++; }
        if (v->vmx_on && v->vmcs_state == 2u && v->vmx_preempt_timer) {
            if (v->vmx_preempt_timer <= ran) {
                v->vmx_preempt_timer = 0;
                v->vmx_exit_reason = VMX_EXIT_PREEMPT_TIMER;
                v->vmx_exit_qual = 0;
                VMX_FIELDS[(u32)(v - VPS)][VMX_FIELD_EXIT_REASON & 63u] = VMX_EXIT_PREEMPT_TIMER;
                VMX_FIELDS[(u32)(v - VPS)][VMX_FIELD_EXIT_QUAL & 63u] = 0;
            } else v->vmx_preempt_timer -= ran;
        }
        PARTS[v->part].runs++;
        runs++;
        if (!v->slice_left) {
            v->preempts++;
            g_preemptions++;
            v->slice_left = QUANTUM_INSTR;
            g_ctx_switches++;
        } else if (v->state != VS_RUNNING) {
            v->slice_left = QUANTUM_INSTR;
        }
    }
    return runs;
}
/* sched_field: 0 slices 1 preemptions 2 context switches 3 idle slices
   4 running vps 5 quantum ms */
u32 hv_sched_field(u32 which);
u32 hv_sched_field(u32 which) {
    switch (which) {
    case 0: return g_slices;
    case 1: return g_preemptions;
    case 2: return g_ctx_switches;
    case 3: return g_idle_slices;
    case 4: {
        u32 i, n = 0;
        for (i = 0; i < MAX_VPS; i++)
            if (VPS[i].used && VPS[i].state == VS_RUNNING && PARTS[VPS[i].part].state == PS_RUNNING && PARTS[VPS[i].part].has_guest) n++;
        return n;
    }
    case 5: return QUANTUM_MS;
    default: return 0;
    }
}

/* ------------------------------------------------------- info / JS support */
u32 hv_version(void);
u32 hv_version(void) { return HV_VERSION; }
u32 hv_signature(void);
u32 hv_signature(void) { return HV_SIGNATURE; }
u32 hv_magic(void);
u32 hv_magic(void) { return HV_MAGIC; }
u32 hv_vendor_ptr(void);
u32 hv_vendor_ptr(void) { return (u32)(uintptr_t)VENDOR; }
u32 hv_vendor_len(void);
u32 hv_vendor_len(void) { return 12u; }
u32 hv_ref_time_ms(void);
u32 hv_ref_time_ms(void) { return REF_TIME; }
u32 hv_page_size(void);
u32 hv_page_size(void) { return PAGE; }
u32 hv_phys_bytes(void);
u32 hv_phys_bytes(void) { return g_phys_bytes; }
u32 hv_max_partitions(void);
u32 hv_max_partitions(void) { return g_max_parts; }
u32 hv_max_vps(void);
u32 hv_max_vps(void) { return g_max_vps; }
u32 hv_log_ptr(void);
u32 hv_log_ptr(void) { return (u32)(uintptr_t)HLOG; }
u32 hv_log_len(void);
u32 hv_log_len(void) { return HLOG_LEN; }
void hv_log_clear(void);
void hv_log_clear(void) { HLOG_LEN = 0; }
u32 hv_scratch(u32 bytes);
u32 hv_scratch(u32 bytes) { (void)bytes; return (u32)(uintptr_t)SCRATCH; }
u32 hv_scratch_max(void);
u32 hv_scratch_max(void) { return SCRATCH_SIZE; }
u32 hv_guest_log_ptr(u32 part);
u32 hv_guest_log_ptr(u32 part) {
    Partition *p = part_of(part);
    return p ? (u32)(uintptr_t)p->glog : 0u;
}
u32 hv_guest_log_len(u32 part);
u32 hv_guest_log_len(u32 part) {
    Partition *p = part_of(part);
    return p ? p->glog_len : 0u;
}
u32 hv_guest_field(u32 part, u32 f);
u32 hv_guest_field(u32 part, u32 f) {
    Partition *p = part_of(part);
    if (!p) return 0;
    return guest_field(part_id_of(p), f);
}
u32 hv_guest_heartbeat(u32 part);
u32 hv_guest_heartbeat(u32 part) { return hv_guest_field(part, GF_HEARTBEAT); }
u32 hv_channel_of(u32 part);
u32 hv_channel_of(u32 part) {
    Partition *p = part_of(part);
    return p ? p->channel : 0u;
}
u32 hv_canary_lo(u32 part);
u32 hv_canary_lo(u32 part) {
    Partition *p = part_of(part);
    return p ? (p->canary_lo << PAGE_SHIFT) : 0u;
}
u32 hv_canary_hi(u32 part);
u32 hv_canary_hi(u32 part) {
    Partition *p = part_of(part);
    return p ? (p->canary_hi << PAGE_SHIFT) : 0u;
}

/* --------------------------------------------------------- test-only hooks */
/* Simulate a device/DMA write that escapes the guest's mediated window and
   lands in the guard page.  The next VM entry must catch it. */
u32 hv_debug_guest_stray_write(u32 part);
u32 hv_debug_guest_stray_write(u32 part) {
    Partition *p = part_of(part);
    if (!p || !p->canary_lo) return 0;
    PHYS[(p->canary_lo << PAGE_SHIFT)] = 0x5Au;
    PHYS[(p->canary_lo << PAGE_SHIFT) + 17u] = 0x99u;
    log_str("hv: [debug] stray write injected into canary page of partition ");
    log_num(part); log_char('\n');
    return 1u;
}
/* Simulate a guest store outside its window (SLAT catches this one). */
u32 hv_debug_guest_oob_write(u32 part, u32 gpa);
u32 hv_debug_guest_oob_write(u32 part, u32 gpa) {
    u8 v[4];
    v[0] = 1; v[1] = 2; v[2] = 3; v[3] = 4;
    return hv_g_store(part, gpa, (u32)v, 4u);   /* 0 on a SLAT fault */
}
u32 hv_debug_partition_index(u32 part);
u32 hv_debug_partition_index(u32 part) { return part_of(part) ? part : 0u; }
u32 hv_debug_frame_words(void);
u32 hv_debug_frame_words(void) { return (u32)(sizeof(HvCallFrame) / 4u); }
u32 hv_debug_msg_size(void);
u32 hv_debug_msg_size(void) { return MSG_SIZE; }
u32 hv_debug_ring_size(void);
u32 hv_debug_ring_size(void) { return RING_SIZE; }
u32 hv_debug_fb_bytes(void);
u32 hv_debug_fb_bytes(void) { return FB_BYTES; }
u32 hv_debug_gpa_limit(void);
u32 hv_debug_gpa_limit(void) { return GPA_LIMIT; }
u32 hv_debug_guest_window_pfn(u32 part);
u32 hv_debug_guest_window_pfn(u32 part) {
    Partition *p = part_of(part);
    return p ? (p->canary_lo + 1u) : 0u;
}
u32 hv_debug_guest_osid(u32 part);
u32 hv_debug_guest_osid(u32 part) {
    Partition *p = part_of(part);
    Vp *v;
    u32 lo = 0, hi = 0;
    if (!p || !p->vp_count) return 0;
    v = vp_of(p->vps[0]);
    if (!v) return 0;
    if (msr_read(v, MSR_GUEST_OS_ID, &lo, &hi) != HV_STATUS_SUCCESS) return 0;
    return lo;
}
