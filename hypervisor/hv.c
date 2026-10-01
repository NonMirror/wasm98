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
#define TSC_GPA          0x00092000u                 /* scratch / ref TSC   */
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

/* hypercall codes */
#define HC_GET_HV_INFO      0x0011u
#define HC_GET_REF_TIME     0x0012u
#define HC_GET_VP_INDEX     0x0013u
#define HC_CREATE_PART      0x0040u
#define HC_INIT_PART        0x0041u
#define HC_DEPOSIT_MEM      0x0043u
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

typedef struct { u32 owner; u32 gpa; u32 flags; u32 mapped; } HostPage;
static HostPage PAGES[HOST_PAGES];

/* SynIC message (256 bytes, HV_ABI.md 2.5) */
typedef struct {
    u32 type;
    u32 size;
    u32 flags;
    u8  payload[MSG_SIZE - 12u];
} SynicMsg;

typedef struct { u32 msr; u32 lo; u32 hi; u32 valid; } MsrEntry;

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
    u32 regs[4];              /* 0..3 (rdx/r8/r9/rip-style)                 */
    /* SynIC */
    u32 scontrol, simp, siefp, eom;
    u32 sint_vec[4], sint_masked[4], sint_count[4];
    u32 msg_count, msg_dropped, events;
    SynicMsg msgs[MSG_QUEUE];
    u32 msg_head, msg_tail;
    /* virtual MSRs */
    MsrEntry msrs[MAX_MSRS];
    /* legacy (root) partition-only convenience */
    u32 timer_fires, timer_last, timer_pending;
} Vp;

typedef struct {
    u32 used;
    u32 state;                /* PS_*                                       */
    u32 is_root;
    u32 parent;               /* partition index of the parent (-1 = none)  */
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
    u32 slat[GPA_PAGES];      /* (pfn << 2) | (writable | present << 1)     */
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
} Partition;

static Partition PARTS[MAX_PARTS];
static Vp        VPS[MAX_VPS];

typedef struct {
    u32 used, part, state, chid;
    u32 offer_lo, offer_hi, ring_gpa;
    u32 in_bytes, out_bytes, messages, dropped;
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

/* ------------------------------------------------------------- global state */
static u32 g_inited;
static u32 REF_TIME;                 /* ms since boot                        */
static u32 g_max_parts, g_max_vps, g_phys_bytes;
static u32 g_hypercalls;             /* every hv_vmcall                      */
static u32 g_slat_faults;            /* every SLAT violation                 */
static u32 g_owned, g_present, g_deposits;
static u32 g_slices, g_preemptions, g_ctx_switches, g_idle_slices;
static u32 rr_cursor;
static u32 g_next_chid;

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
    if (part_id < 1u || part_id > MAX_PARTS) return;
    Partition *p = &PARTS[part_id - 1u];
    u32 n = slen(s);
    if (p->glog_len + n + 1u < GLOG_SIZE) {
        memcpy(p->glog + p->glog_len, s, n);
        p->glog_len += n;
        p->glog[p->glog_len++] = '\n';
    }
}

/* -------------------------------------------------------------- accessors */
static Partition *part_of(u32 id) {
    if (id < 1u || id > MAX_PARTS) return 0;
    Partition *p = &PARTS[id - 1u];
    return p->used ? p : 0;
}
static Vp *vp_of(u32 id) {
    if (id < 1u || id > MAX_VPS) return 0;
    Vp *v = &VPS[id - 1u];
    return v->used ? v : 0;
}
static Channel *chan_of(u32 id) {
    if (id < 1u || id > MAX_CHANNELS) return 0;
    Channel *c = &CHANS[id - 1u];
    return c->used ? c : 0;
}

/* -------------------------------------------------------------------- SLAT */
/* entry = 0            -> unmapped
   entry & 2 == 0       -> "mapped" but not present (accesses fault)
   entry & 2, !(entry&1) -> read-only
   entry & 3            -> read/write                                            */
static u32 slat_pfn(Partition *p, u32 gpa, u32 *flags) {
    u32 e;
    if (gpa >= GPA_LIMIT) return 0;
    e = p->slat[gpa >> PAGE_SHIFT];
    if (!e) return 0;
    if (flags) *flags = e & 3u;
    return e >> 2;
}
static u32 slat_set(Partition *p, u32 gpa, u32 pfn, u32 flags) {
    if (gpa >= GPA_LIMIT) return 0;
    p->slat[gpa >> PAGE_SHIFT] = (pfn << 2) | (flags & 3u);
    return 1;
}
static u32 gpa_state_of(Partition *p, u32 gpa) {
    u32 e, fl;
    if (gpa >= GPA_LIMIT) return 0u;
    e = p->slat[gpa >> PAGE_SHIFT];
    if (!e) return 0u;
    fl = e & 3u;
    if (!(fl & 2u)) return 1u;                  /* mapped, not present      */
    return (fl & 1u) ? 3u : 2u;                 /* rw : ro                  */
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
    log_str("hv: partition "); log_num(p - PARTS + 1u);
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
        if (!pfn || !(f & 2u)) { part_fault(p, a, "load"); return 0; }
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
        if (!pfn || !(f & 2u)) { part_fault(p, a, "store"); return 0; }
        if (!(f & 1u)) { part_fault(p, a, "store to read-only page"); return 0; }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        hp = &PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))];
        memcpy(hp, (const u8 *)(src + off), chunk);
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
        if (!pfn || !(f & 2u)) {
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
        if (!pfn || !(f & 2u)) {
            if (fault) part_fault(p, a, "write");
            else { log_str("hv: write to unmapped gpa "); log_hex(a); log_char('\n'); }
            return 0;
        }
        chunk = PAGE - (a & (PAGE - 1u));
        if (chunk > len - off) chunk = len - off;
        memcpy(&PHYS[(pfn << PAGE_SHIFT) + (a & (PAGE - 1u))], (const u8 *)(src + off), chunk);
        off += chunk;
    }
    return len;
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
        log_str(" under partition "); log_num(p - PARTS + 1u);
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
        log_str(" under partition "); log_num(p - PARTS + 1u);
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
            v->sint_vec[0] = 0x20u;
            v->sint_vec[1] = 0x21u;
            v->sint_vec[2] = 0x22u;
            v->sint_vec[3] = 0x23u;
            v->sint_masked[0] = 1u;
            v->sint_masked[1] = 1u;
            v->sint_masked[2] = 1u;
            v->sint_masked[3] = 1u;
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
    *lo = 0; *hi = 0;
    if (msr == MSR_VP_INDEX) { *lo = v->index; return HV_STATUS_SUCCESS; }
    if (msr == MSR_TIME_REF_COUNT) {
        u64 t = (u64)REF_TIME * 10000ULL;        /* 100 ns units */
        *lo = (u32)(t & 0xFFFFFFFFu);
        *hi = (u32)(t >> 32);
        return HV_STATUS_SUCCESS;
    }
    if (msr == MSR_SIMP) { *lo = v->simp; return HV_STATUS_SUCCESS; }
    if (msr == MSR_SIEFP) { *lo = v->siefp; return HV_STATUS_SUCCESS; }
    if (msr == MSR_SCONTROL) { *lo = v->scontrol; return HV_STATUS_SUCCESS; }
    if (msr == MSR_EOM) { *lo = v->eom; return HV_STATUS_SUCCESS; }
    if (msr >= MSR_SINT0 && msr < MSR_SINT0 + 4u) {
        u32 k = msr - MSR_SINT0;
        *lo = v->sint_vec[k] | (v->sint_masked[k] ? 0x10000u : 0u);
        return HV_STATUS_SUCCESS;
    }
    for (i = 0; i < MAX_MSRS; i++)
        if (v->msrs[i].valid && v->msrs[i].msr == msr) { *lo = v->msrs[i].lo; *hi = v->msrs[i].hi; return HV_STATUS_SUCCESS; }
    return HV_STATUS_NOT_IMPLEMENTED;
}
static u32 msr_write(Vp *v, u32 msr, u32 lo, u32 hi) {
    u32 i;
    if (msr == MSR_VP_INDEX) return HV_STATUS_ACCESS_DENIED;   /* read only */
    if (msr == MSR_SIMP) { v->simp = lo; msrlog_add(&PARTS[v->part], msr, lo, 1u); return HV_STATUS_SUCCESS; }
    if (msr == MSR_SIEFP) { v->siefp = lo; msrlog_add(&PARTS[v->part], msr, lo, 1u); return HV_STATUS_SUCCESS; }
    if (msr == MSR_SCONTROL) { v->scontrol = lo; msrlog_add(&PARTS[v->part], msr, lo, 1u); return HV_STATUS_SUCCESS; }
    if (msr == MSR_EOM) { v->eom = lo; return HV_STATUS_SUCCESS; }
    if (msr >= MSR_SINT0 && msr < MSR_SINT0 + 4u) {
        u32 k = msr - MSR_SINT0;
        v->sint_vec[k] = lo & 0xFFu;
        v->sint_masked[k] = (lo & 0x10000u) ? 1u : 0u;
        v->sint_count[k] = 0;
        msrlog_add(&PARTS[v->part], msr, lo, 1u);
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
static u32 cpuid_leaf(u32 leaf, u32 subleaf, u32 *out) {
    out[0] = out[1] = out[2] = out[3] = 0;
    if (leaf == 0x00000001u) {                     /* hypervisor-present bit */
        out[0] = 0x00000600u;                      /* family/model            */
        out[2] = 0x80000000u;                      /* ECX[31] = hypervisor    */
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
        out[0] = 0x00000001u;                      /* VP privilege            */
        out[1] = 0x0000000Fu;
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
    (void)part;
    cpuid_leaf(leaf, subleaf, v);
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
    if (m->type < 4u) v->sint_count[m->type]++;
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
    if (v && v->sint_masked[p->timer_sint & 3u]) p->timer_masked++;
    else if (v) v->sint_count[p->timer_sint & 3u]++;
    guest_timer_fire((u32)(p - PARTS) + 1u);
    if (p->timer_fires <= 3u) {
        log_str("hv: synthetic timer (SINT"); log_num(p->timer_sint);
        log_str(") fired for partition "); log_num(p - PARTS + 1u);
        log_str(" at "); log_num(REF_TIME); log_str(" ms\n");
    }
}

/* ----------------------------------------------------------- dispatch */
static Vp *next_vp(void) {
    u32 i;
    for (i = 0; i < MAX_VPS; i++) {
        u32 k = (rr_cursor + i) % MAX_VPS;
        Vp *v = &VPS[k];
        Partition *p;
        if (!v->used || v->state != VS_RUNNING) continue;
        p = &PARTS[v->part];
        if (p->state != PS_RUNNING || !p->has_guest || !p->used) continue;
        rr_cursor = (k + 1u) % MAX_VPS;
        return v;
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
    ran = guest_run((u32)(p - PARTS) + 1u, (u32)(v - VPS) + 1u, ENTRY_BUDGET);
    v->instr += ran;
    /* isolation check: the guest's guard pages must be untouched */
    if (canary_check(p)) return 0;
    if (guest_field((u32)(p - PARTS) + 1u, GF_HALTED)) {
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
    memset(CHANS, 0, sizeof(CHANS));
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
    g_next_chid = 1;
    for (i = 0; i < PAGE; i++) CANARY_PAT[i] = (u8)(0xA5u ^ (u8)(i * 7u));
    /* the root partition: created here and never deletable */
    r = &PARTS[0];
    r->used = 1;
    r->state = PS_RUNNING;
    r->is_root = 1;
    r->parent = 0xFFFFFFFFu;
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
            if (pfn) { pages_own(pfn, 1u, 0u); PAGES[pfn].mapped = 1; PAGES[pfn].gpa = i * PAGE; PAGES[pfn].flags = 3; r->slat[i] = (pfn << 2) | 3u; g_owned++; g_present++; g_deposits++; r->mapped_pages++; r->deposits++; }
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
    u32 i, n = 0;
    Partition *p = 0;
    const char *nm = (const char *)name_ptr;
    for (i = 0; i < MAX_PARTS; i++) {
        if (PARTS[i].used) n++;
        else if (!p) p = &PARTS[i];
    }
    if (n >= g_max_parts) return 0;
    if (!p) return 0;
    memset(p, 0, sizeof(*p));
    p->used = 1;
    p->state = PS_CREATED;
    p->parent = 0;
    if (name_len > NAME_LEN - 1u) name_len = NAME_LEN - 1u;
    if (name_ptr && name_len) memcpy(p->name, nm, name_len);
    else { memcpy(p->name, "PARTITION", 9); name_len = 9; }
    p->name[name_len] = 0;
    p->name_len = name_len;
    log_str("hv: partition "); log_num(p - PARTS + 1u);
    log_str(" created (\""); log_str(p->name); log_str("\")\n");
    return (u32)(p - PARTS) + 1u;
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
            PAGES[pfn].flags = 3;
            p->slat[i] = (pfn << 2) | 3u;             /* present + writable  */
            g_present++;
        }
        p->mapped_pages = GPA_PAGES;
        p->deposits += GPA_PAGES;
    }
    /* zero the guest window */
    for (i = 0; i < GPA_PAGES; i++) memset(&PHYS[((p->canary_lo + 1u + i) << PAGE_SHIFT)], 0, PAGE);
    p->has_guest = 1;
    p->state = PS_INITIALISED;
    guest_reset((u32)(p - PARTS) + 1u, p->vps[0]);
    {
        Vp *v = vp_of(p->vps[0]);
        if (v) { v->simp = SIMP_GPA; v->siefp = SIEFP_GPA; v->scontrol = 1u; }
    }
    /* offer a VMBus channel into the guest's out ring */
    c = 0;
    for (i = 0; i < MAX_CHANNELS; i++) if (!CHANS[i].used) { c = &CHANS[i]; break; }
    if (c) {
        memset(c, 0, sizeof(*c));
        c->used = 1;
        c->chid = g_next_chid++;
        c->part = (u32)(p - PARTS) + 1u;
        c->state = CH_OFFERED;
        c->ring_gpa = OUT_RING_GPA;
        c->offer_lo = 0x98C00000u | c->chid;
        c->offer_hi = 0x00000001u;
        p->channel = c->chid;
        offer[0] = c->chid;
        offer[1] = c->offer_lo;
        offer[2] = c->offer_hi;
        offer[3] = 1u;
        ring_post((u32)(p - PARTS) + 1u, OUT_RING_GPA, VMB_OFFER, (const u8 *)offer, 16u);
        log_str("hv: VMBus channel "); log_num(c->chid);
        log_str(" offered to partition "); log_num(p - PARTS + 1u); log_char('\n');
    }
    log_str("hv: partition "); log_num(p - PARTS + 1u);
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
        if (CHANS[i].used && CHANS[i].part == part) { CHANS[i].state = CH_CLOSED; CHANS[i].used = 0; }
    part_release_window(p);
    log_str("hv: partition "); log_num(part); log_str(" deleted (memory returned)\n");
    p->state = PS_DELETED;
    p->used = 0;
    p->has_guest = 0;
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
   12 parent  13 canary faults  14 has guest  15 vmbus channel                */
u32 hv_partition_field(u32 part, u32 f);
u32 hv_partition_field(u32 part, u32 f) {
    Partition *p = part_of(part);
    if (!p) return 0;
    switch (f) {
    case 0: return part;
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
    default: return 0;
    }
}
u32 hv_partition_count(void);
u32 hv_partition_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_PARTS; i++) if (PARTS[i].used) n++;
    return n;
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
    if (!v || which > 3u) return 0;
    return v->regs[which];
}
i32 hv_vp_set_register(u32 vp, u32 which, u32 value);
i32 hv_vp_set_register(u32 vp, u32 which, u32 value) {
    Vp *v = vp_of(vp);
    if (!v || which > 3u) return HV_STATUS_INVALID_PARAMETER;
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
    if (flags > 3u) return HV_STATUS_INVALID_PARAMETER;
    if (gpa + (page_count << PAGE_SHIFT) > GPA_LIMIT) return HV_STATUS_INVALID_PARAMETER;
    for (i = 0; i < page_count; i++) {
        u32 a = gpa + (i << PAGE_SHIFT);
        u32 cur = p->slat[a >> PAGE_SHIFT];
        u32 pfn;
        if (cur) {
            pfn = cur >> 2;
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
        if (flags & 2u) {
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
        pfn = e >> 2;
        p->slat[a >> PAGE_SHIFT] = 0;
        if (PAGES[pfn].mapped) { PAGES[pfn].mapped = 0; g_present--; if (p->mapped_pages) p->mapped_pages--; }
        if (PAGES[pfn].owner == part) {
            PAGES[pfn].owner = 0;
            PAGES[pfn].gpa = 0;
            PAGES[pfn].flags = 0;
            if (g_owned) g_owned--;
        }
    }
    return 0;
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
    if (!slat_pfn(p, gpa, &f) || !(f & 2u)) { part_fault(p, gpa, "probe read"); return HV_STATUS_SLAT_FAULT; }
    return 0;
}
u32 hv_probe_write_gpa(u32 part, u32 gpa);
u32 hv_probe_write_gpa(u32 part, u32 gpa) {
    Partition *p = part_of(part);
    u32 f;
    if (!p) return HV_STATUS_INVALID_PARAMETER;
    if (!slat_pfn(p, gpa, &f) || !(f & 2u)) { part_fault(p, gpa, "probe write"); return HV_STATUS_SLAT_FAULT; }
    if (!(f & 1u)) { part_fault(p, gpa, "probe write to read-only page"); return HV_STATUS_SLAT_FAULT; }
    return 0;
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
    default: return 0;
    }
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
        if (!slat_pfn(p, a, &f) || !(f & 2u)) {
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
    pid = (u32)(p - PARTS) + 1u;
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
        np = hv_partition_create(0u, 0u);
        if (!np) { st = HV_STATUS_INSUFFICIENT_MEM; break; }
        out[0] = np;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) { st = HV_STATUS_SLAT_FAULT; break; }
        st = HV_STATUS_SUCCESS;
        break;
    }
    case HC_INIT_PART: {
        u32 target = f.arg0 ? f.arg0 : (u32)(p - PARTS) + 1u;
        i32 r = hv_partition_init(target);
        st = r ? (u32)r : HV_STATUS_SUCCESS;
        break;
    }
    case HC_DEPOSIT_MEM: {
        u32 out[1], n = 0, i;
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
                p->slat[a >> PAGE_SHIFT] = (pfn << 2);
            }
            n++;
        }
        out[0] = n;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_CREATE_VP: {
        u32 out[1], nv = hv_vp_create((u32)(p - PARTS) + 1u, f.arg0);
        if (!nv) { st = HV_STATUS_INSUFFICIENT_MEM; break; }
        out[0] = nv;
        if (f.out_gpa && !hv_g_store(pid, f.out_gpa, (u32)out, 4u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_SET_VP_REGISTERS:
        if (f.arg0 > 3u) { st = HV_STATUS_INVALID_PARAMETER; break; }
        v->regs[f.arg0] = f.arg1;
        break;
    case HC_MAP_GPA_PAGES: {
        i32 r = hv_map_gpa((u32)(p - PARTS) + 1u, f.arg0, f.arg1, f.arg2 & 3u);
        st = r ? (u32)r : HV_STATUS_SUCCESS;
        break;
    }
    case HC_POST_MESSAGE: {
        SynicMsg m;
        u32 rv = root_vp_id();
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
        v->events++;
        if (f.arg0 < 4u) v->sint_count[f.arg0]++;
        if (v->siefp) {
            flag[0] = f.arg1;
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
            if (c->part != (u32)(p - PARTS) + 1u) continue;
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
        Channel *c = chan_of(f.arg0);
        if (!c) { st = HV_STATUS_INVALID_PARAMETER; break; }
        c->state = CH_CLOSED;
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
        cpuid_leaf(f.arg0, f.arg1, out);
        if (!hv_g_store(pid, f.out_gpa, (u32)out, 16u)) st = HV_STATUS_SLAT_FAULT;
        break;
    }
    case HC_HALT:
        v->state = VS_HALTED;
        p->state = PS_STOPPED;
        log_str("hv: partition "); log_num(p - PARTS + 1u); log_str(" halted by guest\n");
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
    default: return 0;
    }
}
u32 hv_sint_field(u32 vp, u32 sint, u32 which);
u32 hv_sint_field(u32 vp, u32 sint, u32 which) {
    Vp *v = vp_of(vp);
    if (!v || sint > 3u) return 0;
    switch (which) {
    case 0: return v->sint_vec[sint];
    case 1: return v->sint_masked[sint];
    case 2: return v->sint_count[sint];
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
    default: return 0;
    }
}
u32 hv_vmbus_channel_count(void);
u32 hv_vmbus_channel_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_CHANNELS; i++) if (CHANS[i].used) n++;
    return n;
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
    if (n) c->out_bytes += n; else c->dropped++;
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
    return guest_field((u32)(p - PARTS) + 1u, f);
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
