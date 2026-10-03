/* ============================================================================
   guest.c — the guest image that runs inside a child partition.
   ----------------------------------------------------------------------------
   Linked into hypervisor.wasm and entered ONLY through hv_vm_entry(vp): there
   is no other way in and no other way out.  The guest has no pointer into the
   hypervisor's memory: every byte it touches goes through hv_g_load /
   hv_g_store, which walk its partition's SLAT.  Anything outside its mapped
   window is a SLAT fault, and its window is fenced with canary pages that
   hv_vm_entry re-verifies after every entry.

   What it does (HV_ABI.md section 3):
     1. reads CPUID 0x40000000 and refuses to boot without "Microsoft Hv"
     2. sets HV_X64_MSR_GUEST_OS_ID
     3. enables the hypercall page and validates the frame at GPA 0xE000
     4. queries the reference time and its VP index
     5. sets SIMP/SIEFP/SCONTROL and unmasks SINT0/SINT2
     6. arms a 100 ms synthetic timer on SINT2
     7. completes the VMBus offer-accepted handshake
     8. draws its boot log into the framebuffer at GPA 0x10000 (400x120x32bpp)
        and keeps a heartbeat
     9. on every timer interrupt: bumps the heartbeat, drains SynIC messages,
        writes log lines, posts a heartbeat message to the root partition
    10. honours injected root commands (ping, log <text>, halt)
   ========================================================================== */
#include <stdint.h>

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t  i32;
typedef uint64_t u64;

/* ------------------------------------------------------------- GPA layout */
#define G_HC_GPA     0x0000E000u     /* hypercall page                        */
#define G_FB_GPA     0x00010000u     /* 400x120x32bpp                         */
#define G_OUT_RING   0x00080000u     /* guest -> root ring                    */
#define G_IN_RING    0x00088000u     /* root -> guest ring (our extension)     */
#define G_SIMP       0x00090000u     /* SynIC message page                    */
#define G_SIEFP      0x00091000u     /* SynIC event flags page                */
#define G_OUTBUF     0x00092000u     /* scratch for hypercall outputs         */
#define G_RING_HDR   16u
#define G_RING_DATA  4096u
#define G_MSG_SIZE   256u

/* hypercall codes / MSRs / frame types (HV_ABI.md 2.3 .. 2.5) */
#define C_GET_HV_INFO      0x0011u
#define C_GET_REF_TIME     0x0012u
#define C_GET_VP_INDEX     0x0013u
#define C_DEPOSIT_MEM      0x0043u
#define C_CREATE_VP        0x0047u
#define C_MAP_GPA_PAGES    0x0053u
#define C_POST_MESSAGE     0x005Cu
#define C_SIGNAL_EVENT     0x005Du
#define C_ENABLE_HC_PAGE   0x0060u
#define C_VMBUS_OPEN       0x0061u
#define C_VMBUS_CLOSE      0x0062u
#define C_VMBUS_SIGNAL     0x0063u
#define C_QUERY_MSR        0x0070u
#define C_SET_MSR          0x0071u
#define C_CPUID            0x0072u
#define C_HALT             0x0090u

#define M_GUEST_OS_ID      0x40000000u
#define M_HYPERCALL        0x40000001u
#define M_VP_INDEX         0x40000002u
#define M_TIME_REF_COUNT   0x40000020u
#define M_REFERENCE_TSC    0x40000021u
#define M_SCONTROL         0x40000080u
#define M_SIEFP            0x40000082u
#define M_SIMP             0x40000083u
#define M_EOM              0x40000084u
#define M_SINT0            0x40000090u

#define T_OFFER            1u
#define T_OFFER_ACCEPTED   2u
#define T_GPADL            3u
#define T_DATA             4u
#define T_CLOSE            5u

#define VENDOR0 0x7263694Du          /* "Micr" */
#define VENDOR1 0x666F736Fu          /* "osof" */
#define VENDOR2 0x76482074u          /* "t Hv" */

/* boot stages */
#define GS_RESET      0u
#define GS_CPUID      1u
#define GS_OSID       2u
#define GS_HYPERCALL  3u
#define GS_TIME       4u
#define GS_VPIDX      5u
#define GS_SYNIC      6u
#define GS_TIMER      7u
#define GS_VMBUS      8u
#define GS_FB         9u
#define GS_RUN        10u
#define GS_REDRAW     11u
#define GS_FAILED     12u

#define FB_W 400u
#define FB_H 120u
#define FB_PX (FB_W * FB_H)
#define FB_BG 0xFF101820u
#define FB_FG 0xFFD0D0D0u
#define FB_TITLE 0xFFFFE0A0u
#define FB_HB 0xFF60FF60u
#define FB_ER 0xFFFF6060u
/* text rows are 10 px apart and must stay above the green status line */
#define MAX_TEXT_LINES ((FB_H - 20u) / 10u)
#define TEXT_AREA_BOTTOM (FB_H - 20u)

#define MAX_LINES 12u
#define LINE_LEN  56u

/* --------------------------------------------------- what the guest calls */
/* implemented by the hypervisor (hypervisor/hv.c), same image */
extern u32  hv_g_load(u32 part, u32 gpa, u32 dst, u32 len);
extern u32  hv_g_store(u32 part, u32 gpa, u32 src, u32 len);
extern u32  hv_vmcall(u32 vp);
extern u32  hv_message_pop(u32 vp, u32 dst, u32 max);
extern u32  hv_timer_set(u32 vp, u32 sint, u32 period_ms, u32 oneshot);
extern u32  hv_guest_timer_take(u32 part);
extern void hv_guest_log(u32 part, const char *s);
extern u32  hv_debug_partition_index(u32 part);

/* guest_field indices (HV_ABI.md internal API used by hv.c and hv.js) */
#define GF_STAGE       0u
#define GF_BOOT_FLAGS  1u
#define GF_HEARTBEAT   2u
#define GF_TIMER_HITS  3u
#define GF_PENDING     4u
#define GF_VMBUS_MSGS  5u
#define GF_CMDS        6u
#define GF_LAST_CMD    7u
#define GF_HALTED      8u

/* boot flags */
#define BF_CPUID       0x001u
#define BF_OSID        0x002u
#define BF_HYPERCALL   0x004u
#define BF_REFTIME     0x008u
#define BF_VPINDEX     0x010u
#define BF_SYNIC       0x020u
#define BF_TIMER       0x040u
#define BF_VMBUS       0x080u
#define BF_FB          0x100u

#define MAX_PARTS 8u

/* --------------------------------------------------------------- 8x8 font */
/* classic 8x8 console font, bit 0 = leftmost pixel, rows top to bottom */
static const u8 FONT[95][8] = {
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00}, /* space */
    {0x18,0x3C,0x3C,0x18,0x18,0x00,0x18,0x00}, /* ! */
    {0x36,0x36,0x00,0x00,0x00,0x00,0x00,0x00}, /* " */
    {0x36,0x36,0x7F,0x36,0x7F,0x36,0x36,0x00}, /* # */
    {0x0C,0x3E,0x03,0x1E,0x30,0x1F,0x0C,0x00}, /* $ */
    {0x00,0x63,0x33,0x18,0x0C,0x66,0x63,0x00}, /* % */
    {0x1C,0x36,0x1C,0x6E,0x3B,0x33,0x6E,0x00}, /* & */
    {0x06,0x06,0x03,0x00,0x00,0x00,0x00,0x00}, /* ' */
    {0x18,0x0C,0x06,0x06,0x06,0x0C,0x18,0x00}, /* ( */
    {0x06,0x0C,0x18,0x18,0x18,0x0C,0x06,0x00}, /* ) */
    {0x00,0x66,0x3C,0xFF,0x3C,0x66,0x00,0x00}, /* * */
    {0x00,0x0C,0x0C,0x3F,0x0C,0x0C,0x00,0x00}, /* + */
    {0x00,0x00,0x00,0x00,0x00,0x0C,0x0C,0x06}, /* , */
    {0x00,0x00,0x00,0x3F,0x00,0x00,0x00,0x00}, /* - */
    {0x00,0x00,0x00,0x00,0x00,0x0C,0x0C,0x00}, /* . */
    {0x60,0x30,0x18,0x0C,0x06,0x03,0x01,0x00}, /* / */
    {0x3E,0x63,0x73,0x7B,0x6F,0x67,0x3E,0x00}, /* 0 */
    {0x0C,0x0E,0x0C,0x0C,0x0C,0x0C,0x3F,0x00}, /* 1 */
    {0x1E,0x33,0x30,0x1C,0x06,0x33,0x3F,0x00}, /* 2 */
    {0x1E,0x33,0x30,0x1C,0x30,0x33,0x1E,0x00}, /* 3 */
    {0x38,0x3C,0x36,0x33,0x7F,0x30,0x78,0x00}, /* 4 */
    {0x3F,0x03,0x1F,0x30,0x30,0x33,0x1E,0x00}, /* 5 */
    {0x1C,0x06,0x03,0x1F,0x33,0x33,0x1E,0x00}, /* 6 */
    {0x3F,0x33,0x30,0x18,0x0C,0x0C,0x0C,0x00}, /* 7 */
    {0x1E,0x33,0x33,0x1E,0x33,0x33,0x1E,0x00}, /* 8 */
    {0x1E,0x33,0x33,0x3E,0x30,0x18,0x0E,0x00}, /* 9 */
    {0x00,0x0C,0x0C,0x00,0x00,0x0C,0x0C,0x00}, /* : */
    {0x00,0x0C,0x0C,0x00,0x00,0x0C,0x0C,0x06}, /* ; */
    {0x18,0x0C,0x06,0x03,0x06,0x0C,0x18,0x00}, /* < */
    {0x00,0x00,0x3F,0x00,0x00,0x3F,0x00,0x00}, /* = */
    {0x06,0x0C,0x18,0x30,0x18,0x0C,0x06,0x00}, /* > */
    {0x1E,0x33,0x30,0x18,0x0C,0x00,0x0C,0x00}, /* ? */
    {0x3E,0x63,0x7B,0x7B,0x7B,0x03,0x1E,0x00}, /* @ */
    {0x0C,0x1E,0x33,0x33,0x3F,0x33,0x33,0x00}, /* A */
    {0x3F,0x66,0x66,0x3E,0x66,0x66,0x3F,0x00}, /* B */
    {0x3C,0x66,0x03,0x03,0x03,0x66,0x3C,0x00}, /* C */
    {0x1F,0x36,0x66,0x66,0x66,0x36,0x1F,0x00}, /* D */
    {0x7F,0x46,0x16,0x1E,0x16,0x46,0x7F,0x00}, /* E */
    {0x7F,0x46,0x16,0x1E,0x16,0x06,0x0F,0x00}, /* F */
    {0x3C,0x66,0x03,0x03,0x73,0x66,0x7C,0x00}, /* G */
    {0x33,0x33,0x33,0x3F,0x33,0x33,0x33,0x00}, /* H */
    {0x1E,0x0C,0x0C,0x0C,0x0C,0x0C,0x1E,0x00}, /* I */
    {0x78,0x30,0x30,0x30,0x33,0x33,0x1E,0x00}, /* J */
    {0x67,0x66,0x36,0x1E,0x36,0x66,0x67,0x00}, /* K */
    {0x0F,0x06,0x06,0x06,0x46,0x66,0x7F,0x00}, /* L */
    {0x63,0x77,0x7F,0x7F,0x6B,0x63,0x63,0x00}, /* M */
    {0x63,0x67,0x6F,0x7B,0x73,0x63,0x63,0x00}, /* N */
    {0x1C,0x36,0x63,0x63,0x63,0x36,0x1C,0x00}, /* O */
    {0x3F,0x66,0x66,0x3E,0x06,0x06,0x0F,0x00}, /* P */
    {0x1E,0x33,0x33,0x33,0x3B,0x1E,0x38,0x00}, /* Q */
    {0x3F,0x66,0x66,0x3E,0x36,0x66,0x67,0x00}, /* R */
    {0x1E,0x33,0x07,0x0E,0x38,0x33,0x1E,0x00}, /* S */
    {0x3F,0x2D,0x0C,0x0C,0x0C,0x0C,0x1E,0x00}, /* T */
    {0x33,0x33,0x33,0x33,0x33,0x33,0x3F,0x00}, /* U */
    {0x33,0x33,0x33,0x33,0x33,0x1E,0x0C,0x00}, /* V */
    {0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x00}, /* W */
    {0x63,0x63,0x36,0x1C,0x1C,0x36,0x63,0x00}, /* X */
    {0x33,0x33,0x33,0x1E,0x0C,0x0C,0x1E,0x00}, /* Y */
    {0x7F,0x63,0x31,0x18,0x4C,0x66,0x7F,0x00}, /* Z */
    {0x1E,0x06,0x06,0x06,0x06,0x06,0x1E,0x00}, /* [ */
    {0x03,0x06,0x0C,0x18,0x30,0x60,0x40,0x00}, /* \ */
    {0x1E,0x18,0x18,0x18,0x18,0x18,0x1E,0x00}, /* ] */
    {0x08,0x1C,0x36,0x63,0x00,0x00,0x00,0x00}, /* ^ */
    {0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xFF}, /* _ */
    {0x0C,0x0C,0x18,0x00,0x00,0x00,0x00,0x00}, /* ` */
    {0x00,0x00,0x1E,0x30,0x3E,0x33,0x6E,0x00}, /* a */
    {0x07,0x06,0x06,0x3E,0x66,0x66,0x3B,0x00}, /* b */
    {0x00,0x00,0x1E,0x33,0x03,0x33,0x1E,0x00}, /* c */
    {0x38,0x30,0x30,0x3E,0x33,0x33,0x6E,0x00}, /* d */
    {0x00,0x00,0x1E,0x33,0x3F,0x03,0x1E,0x00}, /* e */
    {0x1C,0x36,0x06,0x0F,0x06,0x06,0x0F,0x00}, /* f */
    {0x00,0x00,0x6E,0x33,0x33,0x3E,0x30,0x1F}, /* g */
    {0x07,0x06,0x36,0x6E,0x66,0x66,0x67,0x00}, /* h */
    {0x0C,0x00,0x0E,0x0C,0x0C,0x0C,0x1E,0x00}, /* i */
    {0x30,0x00,0x30,0x30,0x30,0x33,0x33,0x1E}, /* j */
    {0x07,0x06,0x66,0x36,0x1E,0x36,0x67,0x00}, /* k */
    {0x0E,0x0C,0x0C,0x0C,0x0C,0x0C,0x1E,0x00}, /* l */
    {0x00,0x00,0x33,0x7F,0x7F,0x6B,0x63,0x00}, /* m */
    {0x00,0x00,0x1F,0x33,0x33,0x33,0x33,0x00}, /* n */
    {0x00,0x00,0x1E,0x33,0x33,0x33,0x1E,0x00}, /* o */
    {0x00,0x00,0x3B,0x66,0x66,0x3E,0x06,0x0F}, /* p */
    {0x00,0x00,0x6E,0x33,0x33,0x3E,0x30,0x78}, /* q */
    {0x00,0x00,0x3B,0x6E,0x66,0x06,0x0F,0x00}, /* r */
    {0x00,0x00,0x3E,0x03,0x1E,0x30,0x1F,0x00}, /* s */
    {0x08,0x0C,0x3E,0x0C,0x0C,0x2C,0x18,0x00}, /* t */
    {0x00,0x00,0x33,0x33,0x33,0x33,0x6E,0x00}, /* u */
    {0x00,0x00,0x33,0x33,0x33,0x1E,0x0C,0x00}, /* v */
    {0x00,0x00,0x63,0x6B,0x7F,0x7F,0x36,0x00}, /* w */
    {0x00,0x00,0x63,0x36,0x1C,0x36,0x63,0x00}, /* x */
    {0x00,0x00,0x33,0x33,0x33,0x3E,0x30,0x1F}, /* y */
    {0x00,0x00,0x3F,0x19,0x0C,0x26,0x3F,0x00}, /* z */
    {0x38,0x0C,0x0C,0x07,0x0C,0x0C,0x38,0x00}, /* { */
    {0x18,0x18,0x18,0x00,0x18,0x18,0x18,0x00}, /* | */
    {0x07,0x0C,0x0C,0x38,0x0C,0x0C,0x07,0x00}, /* } */
    {0x6E,0x3B,0x00,0x00,0x00,0x00,0x00,0x00}  /* ~ */
};

/* ------------------------------------------------------------ guest state */
typedef struct {
    u32 part;                  /* 1-based partition id                      */
    u32 vp;                    /* 1-based vp id                             */
    u32 stage;
    u32 boot_flags;
    u32 heartbeat;
    u32 timer_hits;
    u32 vmbus_msgs;
    u32 vmbus_chid;
    u32 cmds;
    u32 last_cmd;
    u32 error;
    u32 halted;
    u32 fb_cursor;
    u32 fb_lines;
    u32 reftime;
    u32 tsc_lo;
    u32 tsc_hi;
    u32 vpidx;
    u32 osid;
    u32 lines;
    char line[MAX_LINES][LINE_LEN];
    char status[LINE_LEN];
} GState;

static GState GS[MAX_PARTS];

static u32 guest_slot(u32 part) {
    u32 valid = hv_debug_partition_index(part);
    u32 slot = valid & 0xFFu;
    if (!valid || !slot || slot > MAX_PARTS) return MAX_PARTS;
    return slot - 1u;
}

/* ------------------------------------------------------------ tiny strings */
typedef struct { char *buf; u32 len; u32 cap; } Sb;

static void sb_init(Sb *s, char *buf, u32 cap) { s->buf = buf; s->len = 0; s->cap = cap; if (cap) buf[0] = 0; }
static void sb_ch(Sb *s, char c) { if (s->len + 1u < s->cap) { s->buf[s->len++] = c; s->buf[s->len] = 0; } }
static void sb_str(Sb *s, const char *t) { while (*t) sb_ch(s, *t++); }
static void sb_num(Sb *s, u32 v) {
    char b[12]; u32 n = 0;
    if (!v) { sb_ch(s, '0'); return; }
    while (v) { b[n++] = (char)('0' + (v % 10u)); v /= 10u; }
    while (n) sb_ch(s, b[--n]);
}
static void sb_hex(Sb *s, u32 v, u32 digits) {
    const char *h = "0123456789ABCDEF";
    i32 i;
    sb_str(s, "0x");
    for (i = (i32)(digits * 4u) - 4; i >= 0; i -= 4) sb_ch(s, h[(v >> (u32)i) & 15u]);
}
static u32 slen(const char *s) { u32 n = 0; while (s[n]) n++; return n; }
static void smemcpy(char *d, const char *s, u32 n) { while (n--) *d++ = *s++; }

/* --------------------------------------------------------- guest console */
static void glog(GState *g, const char *text) {
    hv_guest_log(g->part, text);
    if (g->lines >= MAX_LINES) {
        u32 i;
        for (i = 1; i < MAX_LINES; i++) smemcpy(g->line[i - 1u], g->line[i], LINE_LEN);
        g->lines = MAX_LINES - 1u;
    }
    {
        u32 n = slen(text);
        if (n > LINE_LEN - 1u) n = LINE_LEN - 1u;
        smemcpy(g->line[g->lines], text, n);
        g->line[g->lines][n] = 0;
        g->lines++;
    }
}

/* --------------------------------------------------------- hypercalls */
typedef struct { u32 code, status, in_gpa, out_gpa, arg0, arg1, arg2, arg3; } Frame;

static u32 gcall(GState *g, u32 code, u32 in_gpa, u32 out_gpa, u32 a0, u32 a1, u32 a2, u32 a3) {
    Frame f;
    f.code = code; f.status = 0; f.in_gpa = in_gpa; f.out_gpa = out_gpa;
    f.arg0 = a0; f.arg1 = a1; f.arg2 = a2; f.arg3 = a3;
    if (!hv_g_store(g->part, G_HC_GPA, (u32)&f, 32u)) return 0xFFFFFFFFu;
    hv_vmcall(g->vp);
    if (!hv_g_load(g->part, G_HC_GPA, (u32)&f, 32u)) return 0xFFFFFFFFu;
    return f.status;
}
static u32 gout(GState *g, u32 idx) {
    u32 v = 0;
    hv_g_load(g->part, G_OUTBUF + idx * 4u, (u32)&v, 4u);
    return v;
}

/* ------------------------------------------------------------- VMBus ring */
static u32 g_ring_post(GState *g, u32 ring, u32 type, const u8 *data, u32 len) {
    u32 hdr[4], fr[2], off, need;
    if (len > 200u) return 0;
    if (!hv_g_load(g->part, ring, (u32)hdr, G_RING_HDR)) return 0;
    need = 8u + len;
    off = hdr[0];
    if (off + need > G_RING_DATA) return 0;
    fr[0] = type; fr[1] = len;
    if (!hv_g_store(g->part, ring + G_RING_HDR + off, (u32)fr, 8u)) return 0;
    if (len && !hv_g_store(g->part, ring + G_RING_HDR + off + 8u, (u32)data, len)) return 0;
    hdr[0] = off + need;
    hdr[2] += need;
    return hv_g_store(g->part, ring, (u32)hdr, G_RING_HDR) ? len : 0;
}
static u32 g_ring_pop(GState *g, u32 ring, u32 *type, u8 *dst, u32 max) {
    u32 hdr[4], fr[2], off, need, n;
    if (!hv_g_load(g->part, ring, (u32)hdr, G_RING_HDR)) return 0;
    if (!hdr[2]) return 0;
    off = hdr[1];
    if (off + 8u > G_RING_DATA) {
        hdr[1] = hdr[0] = hdr[2] = 0;
        hv_g_store(g->part, ring, (u32)hdr, G_RING_HDR);
        return 0;
    }
    if (!hv_g_load(g->part, ring + G_RING_HDR + off, (u32)fr, 8u)) return 0;
    need = 8u + fr[1];
    if (off + need > G_RING_DATA) {
        hdr[1] = hdr[0] = hdr[2] = 0;
        hv_g_store(g->part, ring, (u32)hdr, G_RING_HDR);
        return 0;
    }
    n = fr[1];
    if (n > max) n = max;
    if (type) *type = fr[0];
    if (n && !hv_g_load(g->part, ring + G_RING_HDR + off + 8u, (u32)dst, n)) return 0;
    hdr[1] = off + need;
    hdr[2] = (hdr[2] >= need) ? hdr[2] - need : 0u;
    if (!hdr[2]) { hdr[1] = hdr[0] = 0; }
    if (!hv_g_store(g->part, ring, (u32)hdr, G_RING_HDR)) return 0;
    return n;
}

/* -------------------------------------------------- the framebuffer (SLAT) */
static void fb_fill(GState *g, u32 first, u32 count) {
    u32 px = FB_BG, i;
    for (i = 0; i < count && first + i < FB_PX; i++)
        hv_g_store(g->part, G_FB_GPA + ((first + i) * 4u), (u32)&px, 4u);
}
static void fb_clear_chunk(GState *g, u32 *cursor, u32 count) {
    u32 n = count;
    if (*cursor + n > FB_PX) n = FB_PX - *cursor;
    fb_fill(g, *cursor, n);
    *cursor += n;
}
static void fb_char(GState *g, u32 x, u32 y, char ch, u32 color) {
    u32 c = (u8)ch;
    const u8 *glyph;
    u32 row, col;
    if (c < 0x20u || c > 0x7Eu) c = '?';
    glyph = FONT[c - 0x20u];
    for (row = 0; row < 8u; row++) {
        u8 bits = glyph[row];
        for (col = 0; col < 8u; col++)
            if (bits & (1u << col)) {
                u32 px = color;
                u32 gx = x + col, gy = y + row;
                if (gx < FB_W && gy < FB_H)
                    hv_g_store(g->part, G_FB_GPA + ((gy * FB_W + gx) * 4u), (u32)&px, 4u);
            }
    }
}
static void fb_text(GState *g, u32 x, u32 y, const char *s, u32 color) {
    while (*s) { fb_char(g, x, y, *s, color); x += 8u; if (x + 8u > FB_W) break; s++; }
}

/* --------------------------------------------------------- boot helpers */
static void set_stage(GState *g, u32 s) { g->stage = s; }

static void post_synic_heartbeat(GState *g) {
    /* 256 byte SynIC message {u32 type, u32 size, u32 flags, u8 payload[244]} */
    u8 msg[G_MSG_SIZE];
    Sb s;
    u32 i;
    for (i = 0; i < G_MSG_SIZE; i++) msg[i] = 0;
    sb_init(&s, (char *)msg + 12u, 200u);
    sb_str(&s, "heartbeat ");
    sb_num(&s, g->heartbeat);
    ((u32 *)msg)[0] = 1u;                       /* type: heartbeat            */
    ((u32 *)msg)[1] = 12u + s.len;              /* size                       */
    ((u32 *)msg)[2] = 0u;                       /* flags                      */
    if (hv_g_store(g->part, G_SIMP, (u32)msg, G_MSG_SIZE))
        gcall(g, C_POST_MESSAGE, 0, 0, G_SIMP, 0, 0, 0);
}
static void post_vmbus_data(GState *g, const char *text) {
    u32 n = slen(text);
    if (!g->vmbus_chid) return;
    if (g_ring_post(g, G_OUT_RING, T_DATA, (const u8 *)text, n)) {
        g->vmbus_msgs++;
        gcall(g, C_VMBUS_SIGNAL, 0, 0, g->vmbus_chid, n, 0, 0);
    }
}
static void draw_status(GState *g) {
    Sb s;
    fb_fill(g, (FB_H - 12u) * FB_W, FB_W * 8u);     /* erase the old line first */
    sb_init(&s, g->status, LINE_LEN);
    sb_str(&s, "[hb ");
    sb_num(&s, g->heartbeat);
    sb_str(&s, "] guest pid ");
    sb_num(&s, g->part);
    sb_str(&s, " vp ");
    sb_num(&s, g->vpidx);
    fb_text(g, 4u, FB_H - 12u, g->status, FB_HB);
}
static void redraw_begin(GState *g) { g->fb_cursor = 0; g->fb_lines = 0; g->stage = GS_REDRAW; }

/* -------------------------------------------------------------------------- */
/* a full console repaint: clear the text area, then redraw the stored lines.
   Done as a guest stage so each step stays bounded.                          */

/* ------------------------------------------------------------- one step */
/* returns 2 to stop the guest for good */
static u32 gstep(GState *g) {
    switch (g->stage) {
    case GS_RESET: {
        glog(g, "W98 Guest Kernel 1.0 (Microsoft Hv enlightened)");
        set_stage(g, GS_CPUID);
        return 0;
    }
    case GS_CPUID: {
        u32 v[4], st;
        char vend[13];
        st = gcall(g, C_CPUID, 0, G_OUTBUF, 0x40000000u, 0u, 0u, 0u);
        hv_g_load(g->part, G_OUTBUF, (u32)v, 16u);
        vend[0] = (char)(v[1] & 0xFFu); vend[1] = (char)((v[1] >> 8) & 0xFFu);
        vend[2] = (char)((v[1] >> 16) & 0xFFu); vend[3] = (char)((v[1] >> 24) & 0xFFu);
        vend[4] = (char)(v[2] & 0xFFu); vend[5] = (char)((v[2] >> 8) & 0xFFu);
        vend[6] = (char)((v[2] >> 16) & 0xFFu); vend[7] = (char)((v[2] >> 24) & 0xFFu);
        vend[8] = (char)(v[3] & 0xFFu); vend[9] = (char)((v[3] >> 8) & 0xFFu);
        vend[10] = (char)((v[3] >> 16) & 0xFFu); vend[11] = (char)((v[3] >> 24) & 0xFFu);
        vend[12] = 0;
        if (st != 0u || v[0] != 0x40000004u || v[1] != VENDOR0 || v[2] != VENDOR1 || v[3] != VENDOR2) {
            glog(g, "FATAL: CPUID 0x40000000 vendor is not \"Microsoft Hv\" - refusing to boot");
            g->error = 1;
            set_stage(g, GS_FAILED);
            return 2;
        }
        g->boot_flags |= BF_CPUID;
        {
            char line[LINE_LEN];
            Sb s;
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "cpuid 0x40000000: vendor \"");
            sb_str(&s, vend);
            sb_str(&s, "\" max leaf ");
            sb_hex(&s, v[0], 8u);
            glog(g, line);
        }
        set_stage(g, GS_OSID);
        return 0;
    }
    case GS_OSID: {
        u32 st = gcall(g, C_SET_MSR, 0, 0, M_GUEST_OS_ID, 0x00319831u, 0u, 0u);
        u32 back = 0;
        char line[LINE_LEN];
        Sb s;
        if (st != 0u) { glog(g, "FATAL: HV_X64_MSR_GUEST_OS_ID write refused"); g->error = 2; set_stage(g, GS_FAILED); return 2; }
        gcall(g, C_QUERY_MSR, 0, G_OUTBUF, M_GUEST_OS_ID, 0, 0, 0);
        back = gout(g, 0);
        g->osid = back;
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "HV_X64_MSR_GUEST_OS_ID = ");
        sb_hex(&s, back, 8u);
        sb_str(&s, " (W98 guest)");
        glog(g, line);
        g->boot_flags |= BF_OSID;
        set_stage(g, GS_HYPERCALL);
        return 0;
    }
    case GS_HYPERCALL: {
        Frame f;
        u32 st = gcall(g, C_ENABLE_HC_PAGE, 0, 0, G_HC_GPA, M_HYPERCALL, 0u, 0u);
        char line[LINE_LEN];
        Sb s;
        if (st != 0u) { glog(g, "FATAL: hypercall page not enabled"); g->error = 3; set_stage(g, GS_FAILED); return 2; }
        /* validate the call frame we just left at GPA 0xE000 */
        if (!hv_g_load(g->part, G_HC_GPA, (u32)&f, 32u) || f.code != C_ENABLE_HC_PAGE) {
            glog(g, "FATAL: hypercall frame at 0xE000 unreadable"); g->error = 4; set_stage(g, GS_FAILED); return 2;
        }
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "hypercall page enabled at GPA ");
        sb_hex(&s, G_HC_GPA, 8u);
        sb_str(&s, " frame ");
        sb_num(&s, f.code);
        glog(g, line);
        g->boot_flags |= BF_HYPERCALL;
        set_stage(g, GS_TIME);
        return 0;
    }
    case GS_TIME: {
        char line[LINE_LEN];
        Sb s;
        u32 page[4];
        u64 tsc;
        if (gcall(g, C_GET_REF_TIME, 0, G_OUTBUF, 0, 0, 0, 0) != 0u) {
            glog(g, "FATAL: HvCallGetReferenceTime failed"); g->error = 5; set_stage(g, GS_FAILED); return 2;
        }
        g->reftime = gout(g, 0);
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "reference time ");
        sb_num(&s, g->reftime);
        sb_str(&s, " ms");
        glog(g, line);
        if (gcall(g, C_QUERY_MSR, 0, G_OUTBUF, M_REFERENCE_TSC, 0, 0, 0) != 0u ||
            !hv_g_load(g->part, gout(g, 0) & ~1u, (u32)page, 16u) || !page[1]) {
            glog(g, "FATAL: reference TSC page unavailable"); g->error = 15; set_stage(g, GS_FAILED); return 2;
        }
        tsc = (u64)g->reftime * 10000ULL * (u64)page[1] + (((u64)page[3] << 32) | page[2]);
        g->tsc_lo = (u32)tsc; g->tsc_hi = (u32)(tsc >> 32);
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "reference TSC page seq "); sb_num(&s, page[0]);
        sb_str(&s, " value "); sb_hex(&s, g->tsc_lo, 8u); glog(g, line);
        g->boot_flags |= BF_REFTIME;
        set_stage(g, GS_VPIDX);
        return 0;
    }
    case GS_VPIDX: {
        char line[LINE_LEN];
        Sb s;
        if (gcall(g, C_GET_VP_INDEX, 0, G_OUTBUF, 0, 0, 0, 0) != 0u) {
            glog(g, "FATAL: HvCallGetVpIndex failed"); g->error = 6; set_stage(g, GS_FAILED); return 2;
        }
        g->vpidx = gout(g, 0);
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "virtual processor index ");
        sb_num(&s, g->vpidx);
        glog(g, line);
        g->boot_flags |= BF_VPINDEX;
        set_stage(g, GS_SYNIC);
        return 0;
    }
    case GS_SYNIC: {
        char line[LINE_LEN];
        Sb s;
        gcall(g, C_SET_MSR, 0, 0, M_SIMP, G_SIMP, 0u, 0u);
        gcall(g, C_SET_MSR, 0, 0, M_SIEFP, G_SIEFP, 0u, 0u);
        gcall(g, C_SET_MSR, 0, 0, M_SCONTROL, 1u, 0u, 0u);
        gcall(g, C_SET_MSR, 0, 0, M_SINT0, 0x20u, 0u, 0u);           /* vector 32, unmasked */
        gcall(g, C_SET_MSR, 0, 0, M_SINT0 + 2u, 0x22u, 0u, 0u);      /* vector 34, unmasked */
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "SynIC up: SIMP ");
        sb_hex(&s, G_SIMP, 8u);
        sb_str(&s, " SIEFP ");
        sb_hex(&s, G_SIEFP, 8u);
        sb_str(&s, " SCONTROL 1");
        glog(g, line);
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "SINT0 unmasked (vector 32), SINT2 unmasked (vector 34)");
        glog(g, line);
        g->boot_flags |= BF_SYNIC;
        set_stage(g, GS_TIMER);
        return 0;
    }
    case GS_TIMER: {
        char line[LINE_LEN];
        Sb s;
        if (hv_timer_set(g->vp, 2u, 100u, 0u) != 0u) {
            glog(g, "FATAL: synthetic timer refused"); g->error = 7; set_stage(g, GS_FAILED); return 2;
        }
        sb_init(&s, line, LINE_LEN);
        sb_str(&s, "synthetic timer armed: 100 ms periodic on SINT2");
        glog(g, line);
        g->boot_flags |= BF_TIMER;
        set_stage(g, GS_VMBUS);
        return 0;
    }
    case GS_VMBUS: {
        u8 buf[64];
        u32 type = 0, n;
        n = g_ring_pop(g, G_OUT_RING, &type, buf, sizeof(buf));
        if (!n) return 0;                                  /* retry next entry */
        if (type == T_OFFER && n >= 16u) {
            u32 chid = ((u32 *)buf)[0], lo = ((u32 *)buf)[1], hi = ((u32 *)buf)[2];
            u32 acc[4];
            char line[LINE_LEN];
            Sb s;
            if (gcall(g, C_VMBUS_OPEN, 0, G_OUTBUF, lo, hi, 0u, 0u) != 0u) {
                glog(g, "FATAL: VMBus open refused"); g->error = 8; set_stage(g, GS_FAILED); return 2;
            }
            g->vmbus_chid = gout(g, 0);
            acc[0] = g->vmbus_chid; acc[1] = lo; acc[2] = hi; acc[3] = 1u;
            g_ring_post(g, G_OUT_RING, T_OFFER_ACCEPTED, (const u8 *)acc, 16u);
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "VMBus channel ");
            sb_num(&s, g->vmbus_chid);
            sb_str(&s, " offer ");
            sb_hex(&s, lo, 8u);
            sb_str(&s, " accepted (offer id ");
            sb_num(&s, chid);
            sb_str(&s, ")");
            glog(g, line);
            g->boot_flags |= BF_VMBUS;
            set_stage(g, GS_FB);
        }
        return 0;
    }
    case GS_FB: {
        if (g->fb_cursor < FB_PX) { fb_clear_chunk(g, &g->fb_cursor, 2048u); return 0; }
        if (g->fb_lines < g->lines) {
            u32 i = g->fb_lines++;
            if (i < MAX_TEXT_LINES)
                fb_text(g, 4u, 4u + i * 10u, g->line[i], i == 0 ? FB_TITLE : FB_FG);
            return 0;
        }
        {
            char line[LINE_LEN];
            Sb s;
            fb_text(g, 4u, FB_H - 12u, "[hb 0] guest starting", FB_HB);
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "framebuffer 400x120x32bpp mapped at GPA ");
            sb_hex(&s, G_FB_GPA, 8u);
            glog(g, line);
        }
        g->boot_flags |= BF_FB;
        glog(g, "boot complete - entering service loop");
        set_stage(g, GS_RUN);
        return 0;
    }
    case GS_RUN: {
        u8 buf[260];
        u32 type = 0, n;
        if (hv_guest_timer_take(g->part)) {
            char line[LINE_LEN];
            Sb s;
            g->heartbeat++;
            g->timer_hits++;
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "[");
            sb_num(&s, g->timer_hits);
            sb_str(&s, "] timer interrupt: heartbeat ");
            sb_num(&s, g->heartbeat);
            sb_str(&s, " (SINT2)");
            glog(g, line);
            post_synic_heartbeat(g);
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "heartbeat ");
            sb_num(&s, g->heartbeat);
            post_vmbus_data(g, line);
            draw_status(g);
            return 0;
        }
        n = g_ring_pop(g, G_IN_RING, &type, buf, sizeof(buf) - 1u);
        if (n) {
            buf[n] = 0;
            g->cmds++;
            if (n >= 4u && buf[0] == 'p' && buf[1] == 'i' && buf[2] == 'n' && buf[3] == 'g') {
                char line[LINE_LEN];
                Sb s;
                g->last_cmd = 1u;
                sb_init(&s, line, LINE_LEN);
                sb_str(&s, "pong from partition ");
                sb_num(&s, g->part);
                sb_str(&s, " heartbeat ");
                sb_num(&s, g->heartbeat);
                glog(g, line);
                post_vmbus_data(g, line);
            } else if (n > 4u && buf[0] == 'l' && buf[1] == 'o' && buf[2] == 'g' && buf[3] == ' ') {
                char line[LINE_LEN];
                Sb s;
                u32 i;
                g->last_cmd = 2u;
                sb_init(&s, line, LINE_LEN);
                sb_str(&s, "root says: ");
                for (i = 4u; i < n && s.len + 1u < LINE_LEN; i++) sb_ch(&s, (char)buf[i]);
                glog(g, line);
                redraw_begin(g);
            } else if (n >= 4u && buf[0] == 'h' && buf[1] == 'a' && buf[2] == 'l' && buf[3] == 't') {
                g->last_cmd = 3u;
                glog(g, "halt requested by root partition - stopping");
                draw_status(g);
                gcall(g, C_HALT, 0, 0, 0u, 0u, 0u, 0u);
                g->halted = 1u;
                return 2;
            } else {
                g->last_cmd = 9u;
                glog(g, "unknown command from root ignored");
            }
            return 0;
        }
        if (hv_message_pop(g->vp, (u32)buf, G_MSG_SIZE)) {
            char line[LINE_LEN];
            Sb s;
            u32 mtype = ((u32 *)buf)[0];
            u32 msize = ((u32 *)buf)[1];
            u32 i;
            if (msize > 200u) msize = 200u;
            sb_init(&s, line, LINE_LEN);
            sb_str(&s, "synic: drained message type ");
            sb_num(&s, mtype);
            sb_str(&s, " size ");
            sb_num(&s, msize);
            sb_str(&s, " \"");
            for (i = 12u; i < 12u + msize && i < G_MSG_SIZE && s.len + 1u < LINE_LEN; i++) {
                char c = (char)buf[i];
                if (c >= 0x20 && c < 0x7F) sb_ch(&s, c);
            }
            sb_str(&s, "\"");
            glog(g, line);
            return 0;
        }
        return 0;                                  /* idle instruction */
    }
    case GS_REDRAW: {                         /* full console repaint */
        u32 limit = TEXT_AREA_BOTTOM * FB_W;
        if (g->fb_cursor < limit) { fb_clear_chunk(g, &g->fb_cursor, 2048u); return 0; }
        if (g->fb_lines < g->lines && g->fb_lines < MAX_TEXT_LINES) {
            u32 i = g->fb_lines++;
            fb_text(g, 4u, 4u + i * 10u, g->line[i], i == 0 ? FB_TITLE : FB_FG);
            return 0;
        }
        g->stage = GS_RUN;
        return 0;
    }
    case GS_FAILED:
    default:
        return 2;
    }
}

/* ============================== exported guest entry points =============== */

u32 guest_run(u32 part, u32 vp, u32 budget);
u32 guest_run(u32 part, u32 vp, u32 budget) {
    GState *g;
    u32 n = 0, slot = guest_slot(part);
    if (slot >= MAX_PARTS) return 0;
    g = &GS[slot];
    g->vp = vp;
    while (n < budget) {
        u32 r;
        if (g->halted) break;
        r = gstep(g);
        n++;
        if (r == 2u) break;
    }
    return n;
}
void guest_reset(u32 part, u32 vp);
void guest_reset(u32 part, u32 vp) {
    GState *g;
    u32 i, j, slot = guest_slot(part);
    if (slot >= MAX_PARTS) return;
    g = &GS[slot];
    /* wipe the whole state without libc */
    {
        u8 *p = (u8 *)g;
        for (i = 0; i < (u32)sizeof(GState); i++) p[i] = 0;
    }
    g->part = part;
    g->vp = vp;
    g->stage = GS_RESET;
    for (i = 0; i < MAX_LINES; i++) for (j = 0; j < LINE_LEN; j++) g->line[i][j] = 0;
    glog(g, "guest image loaded, entering reset vector");
}
void guest_timer_fire(u32 part);
void guest_timer_fire(u32 part) {
    if (guest_slot(part) >= MAX_PARTS) return;
    /* interrupt delivery is modelled as a pending count consumed by the guest */
}
void guest_checkpoint_restore(u32 part, u32 stage, u32 heartbeat);
void guest_checkpoint_restore(u32 part, u32 stage, u32 heartbeat) {
    u32 slot = guest_slot(part);
    if (slot >= MAX_PARTS) return;
    GS[slot].stage = stage;
    GS[slot].heartbeat = heartbeat;
    GS[slot].halted = 0u;
}

/* Management checkpoint helpers.  They deliberately expose only a bounded
   byte copy of the staged guest state; all GPA memory (including the
   framebuffer) is serialized by hypervisor/hv.c through the SLAT. */
u32 guest_state_size(void) { return (u32)sizeof(GState); }
u32 guest_state_save(u32 part, u32 dst, u32 max) {
    u32 slot = guest_slot(part);
    if (slot >= MAX_PARTS || !dst || max < (u32)sizeof(GState)) return 0u;
    smemcpy((char *)dst, (const char *)&GS[slot], (u32)sizeof(GState));
    return (u32)sizeof(GState);
}
u32 guest_state_load(u32 part, u32 src, u32 len, u32 vp, u32 channel) {
    u32 slot = guest_slot(part);
    GState *g;
    if (slot >= MAX_PARTS || !src || len != (u32)sizeof(GState)) return 0u;
    g = &GS[slot];
    smemcpy((char *)g, (const char *)src, len);
    g->part = part;
    g->vp = vp;
    if (channel) g->vmbus_chid = channel;
    return len;
}
u32 guest_field(u32 part, u32 f);
u32 guest_field(u32 part, u32 f) {
    GState *g;
    u32 slot = guest_slot(part);
    if (slot >= MAX_PARTS) return 0;
    g = &GS[slot];
    switch (f) {
    case GF_STAGE: return g->stage;
    case GF_BOOT_FLAGS: return g->boot_flags;
    case GF_HEARTBEAT: return g->heartbeat;
    case GF_TIMER_HITS: return g->timer_hits;
    case GF_PENDING: return 0;
    case GF_VMBUS_MSGS: return g->vmbus_msgs;
    case GF_CMDS: return g->cmds;
    case GF_LAST_CMD: return g->last_cmd;
    case GF_HALTED: return g->halted;
    case 9: return g->vmbus_chid;
    case 10: return g->reftime;
    case 11: return g->vpidx;
    case 12: return g->osid;
    case 13: return g->error;
    case 14: return g->lines;
    case 15: return g->tsc_lo;
    case 16: return g->tsc_hi;
    default: return 0;
    }
}
u32 guest_stage_name(u32 part);      /* unused by JS, handy in the debugger */
u32 guest_stage_name(u32 part) {
    static const char *names[13] = { "reset", "cpuid", "osid", "hypercall", "time",
        "vpindex", "synic", "timer", "vmbus", "framebuffer", "run", "redraw", "failed" };
    u32 st, slot = guest_slot(part);
    if (slot >= MAX_PARTS) return 0;
    st = GS[slot].stage;
    if (st > 12u) st = 12u;
    return (u32)(uintptr_t)names[st];
}
u32 guest_font_bytes(void);
u32 guest_font_bytes(void) { return (u32)sizeof(FONT); }
u32 guest_fb_gpa(void);
u32 guest_fb_gpa(void) { return G_FB_GPA; }
