/* ============================================================================
   kernel.c — a small Windows-9x-flavoured microkernel, compiled to wasm32.
   ----------------------------------------------------------------------------
   Owned by the kernel, not by JS:
     * process table + round-robin scheduler + per-process cpu accounting
     * timer queue (kernel-driven, one-shot and periodic)
     * hierarchical virtual filesystem (FAT-ish, case-insensitive, C:/A: drives)
     * registry (hive path + value name -> bytes)
     * heap (first-fit with coalescing), syscall accounting, kernel log
     * panic facility

   JS owns pixels only. Everything here is exported to JS and this build is
   freestanding: no libc, no entry point, exported as `kernel.wasm`.

   Build: tools/build_kernel.sh
   ========================================================================== */

#include <stdint.h>
#include "nt.h"

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t  i32;
typedef int64_t  i64;

/* ---------------------------------------------------------------- tunables */
#define MAX_NODES    4096u
#define NAME_SLOT    80u
#define TMP_SIZE     (2u * 1024u * 1024u)
#define HEAP_SIZE    (8u * 1024u * 1024u)
#define MAX_PROCS    64u
#define PROC_NAME    64u
#define MAX_TIMERS   512u
#define MAX_REGS     512u
#define MAX_FIRED    256u
#define MAX_DIROPS   16u
#define LOG_SIZE     (48u * 1024u)
#define MAX_SEG      24u
#define SEG_LEN      64u
#define MAX_PATH     260u
#define MAX_FILE     (4u * 1024u * 1024u)
#define MK_FS        "KFS1"
#define MK_REG       "KREG1"
#define KVER         0x0004000Au            /* "4.10" */

/* process states */
#define PS_EMPTY     0u
#define PS_RUNNING   1u   /* alive, has a taskbar button */
#define PS_MIN       2u   /* minimised */
#define PS_HIDDEN    3u   /* alive, no UI (services) */
#define PS_ZOMBIE    4u   /* terminated, awaiting reap */

/* proc field ids for k_proc_field / k_proc_set_field */
#define PF_PID       0u
#define PF_STATE     1u
#define PF_Z         2u
#define PF_CPU_US    3u
#define PF_FLAGS     4u
#define PF_STARTED   5u
#define PF_INDEX     6u

/* stat indices for k_stat */
#define ST_SYSCALLS  0u
#define ST_TICKS     1u
#define ST_TIMERS    2u
#define ST_PROCS     3u
#define ST_HEAP_USED 4u
#define ST_HEAP_SIZE 5u
#define ST_SWITCHES  6u
#define ST_UPTIME    7u
#define ST_QUEUE     8u
#define ST_NDESC     9u
#define ST_NEXT_PID  10u
#define ST_FILES     11u
#define ST_BYTES     12u
#define ST_REG       13u
#define ST_TMP_CAP   14u
#define ST_VERSION   15u
#define ST_PANIC     16u
#define ST_SLICE     17u
#define ST_CURRENT   18u
#define ST_FIRED     19u
#define ST_NODES     20u
#define ST_HEAP_FREE 21u
#define ST_DROPPED   22u
#define ST_COUNT     23u

/* --------------------------------------------------------------- storage */
static u8  HEAP[HEAP_SIZE];
static u8  NAMES[MAX_NODES * NAME_SLOT];
u8  TMP[TMP_SIZE];
static u8  LOG[LOG_SIZE];

/* forward declarations for things defined further down */
static u32 rng_state = 0x1f2e3d4cu;

/* ------------------------------------------------------------------ utils */
static void zero(void *dst, u32 n) {
    u8 *d = (u8 *)dst;
    while (n--) *d++ = 0;
}
void *memset(void *dst, int c, u32 n) {
    u8 *d = (u8 *)dst;
    while (n--) *d++ = (u8)c;
    return dst;
}
void *memcpy(void *dst, const void *src, u32 n) {
    u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
    while (n--) *d++ = *s++;
    return dst;
}
void *memmove(void *dst, const void *src, u32 n) {
    u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
    if (d == s || n == 0) return dst;
    if (d < s) { while (n--) *d++ = *s++; }
    else { d += n; s += n; while (n--) *--d = *--s; }
    return dst;
}
static u32 slen(const char *s) { u32 n = 0; while (s[n]) n++; return n; }

static u8 upper(u8 c) { return (c >= 'a' && c <= 'z') ? (u8)(c - 32) : c; }

static int cieq(const u8 *a, const u8 *b, u32 n) {
    u32 i;
    for (i = 0; i < n; i++) if (upper(a[i]) != upper(b[i])) return 0;
    return 1;
}

/* append helper writing into a caller buffer */
typedef struct { char *b; u32 cap; u32 n; } Str;
static void sput(Str *s, const char *t, u32 len) {
    u32 i;
    if (s->n + len + 1 > s->cap) return;
    for (i = 0; i < len; i++) s->b[s->n++] = t[i];
    s->b[s->n] = 0;
}
static void sputs(Str *s, const char *t) { sput(s, t, slen(t)); }
static void sputc(Str *s, char c) { sput(s, &c, 1); }
static void sputu(Str *s, u32 v) {
    char tmp[12]; u32 i = 0;
    if (v == 0) { sputc(s, '0'); return; }
    while (v && i < 11) { tmp[i++] = (char)('0' + (v % 10u)); v /= 10u; }
    while (i) sputc(s, tmp[--i]);
}
static i32 spari(const char *p, u32 len, u32 *out) {
    u32 v = 0, i = 0, any = 0;
    while (i < len && p[i] >= '0' && p[i] <= '9') { v = v * 10u + (u32)(p[i] - '0'); i++; any = 1; }
    if (!any) return -1;
    *out = v;
    return (i32)i;
}

/* --------------------------------------------------------------- the heap */
typedef struct Blk { u32 sz; u32 pvsz; u32 flags; struct Blk *nf; struct Blk *pf; u32 pad; } Blk;
#define BF_FREE 1u
#define BLK_HDR ((u32)sizeof(Blk))          /* 24 bytes */

static Blk  *fl_head;                       /* free list, address ordered */
static u32   heap_used, heap_peak, heap_frees;

static void heap_init(void) {
    Blk *b = (Blk *)HEAP;
    b->sz = HEAP_SIZE; b->pvsz = 0; b->flags = BF_FREE; b->nf = 0; b->pf = 0;
    fl_head = b;
    heap_used = 0; heap_peak = 0; heap_frees = 0;
}
static u32 align32(u32 n) { return (n + 31u) & ~31u; }

static void fl_remove(Blk *b) {
    if (b->pf) b->pf->nf = b->nf; else fl_head = b->nf;
    if (b->nf) b->nf->pf = b->pf;
    b->nf = b->pf = 0;
}
static void fl_insert(Blk *b) {                       /* address ordered */
    Blk *c = fl_head, *prev = 0;
    while (c && (u8 *)c < (u8 *)b) { prev = c; c = c->nf; }
    b->pf = prev; b->nf = c;
    if (prev) prev->nf = b; else fl_head = b;
    if (c) c->pf = b;
}
static void *heap_alloc(u32 n) {
    u32 need = align32(n + BLK_HDR);
    Blk *b = fl_head;
    if (n == 0) return 0;
    while (b) {
        if (b->sz >= need) {
            u32 rest = b->sz - need;
            fl_remove(b);
            if (rest >= 64u) {                        /* split */
                Blk *nb = (Blk *)((u8 *)b + need);
                nb->sz = rest; nb->pvsz = need; nb->flags = BF_FREE; nb->nf = nb->pf = 0;
                b->sz = need;
                {
                    Blk *after = (Blk *)((u8 *)nb + nb->sz);
                    if ((u8 *)after < HEAP + HEAP_SIZE && after->pvsz) after->pvsz = nb->sz;
                }
                fl_insert(nb);
            }
            b->flags &= ~BF_FREE;
            {
                Blk *after = (Blk *)((u8 *)b + b->sz);
                if ((u8 *)after < HEAP + HEAP_SIZE && after->pvsz) after->pvsz = b->sz;
            }
            heap_used += b->sz;
            if (heap_used > heap_peak) heap_peak = heap_used;
            return (u8 *)b + BLK_HDR;
        }
        b = b->nf;
    }
    return 0;                                          /* out of memory */
}
static void heap_free(void *p) {
    Blk *b, *nb, *pb;
    if (!p) return;
    b = (Blk *)((u8 *)p - BLK_HDR);
    if (b->flags & BF_FREE) return;                    /* double free guard */
    heap_used -= b->sz;
    heap_frees++;
    /* coalesce forward */
    nb = (Blk *)((u8 *)b + b->sz);
    if ((u8 *)nb < HEAP + HEAP_SIZE && (nb->flags & BF_FREE) && nb->sz) {
        fl_remove(nb);
        b->sz += nb->sz;
    }
    /* coalesce backward */
    if (b->pvsz) {
        pb = (Blk *)((u8 *)b - b->pvsz);
        if (((u8 *)pb >= HEAP) && (pb->flags & BF_FREE)) {
            fl_remove(pb);
            pb->sz += b->sz;
            b = pb;
        }
    }
    b->flags |= BF_FREE;
    {
        Blk *after = (Blk *)((u8 *)b + b->sz);
        if ((u8 *)after < HEAP + HEAP_SIZE) after->pvsz = b->sz;
    }
    fl_insert(b);
}
static u32 heap_freebytes(void) {
    Blk *b = fl_head; u32 t = 0;
    while (b) { t += b->sz; b = b->nf; }
    return t;
}

/* ------------------------------------------------- checked heap verification
   A checked build walks the block chain and reports the first structural
   violation instead of silently handing out overlapping memory.  The tests and
   the debugger use it; reasons are numbered so they can be reported compactly. */
static u32 hv_off, hv_reason, hv_blocks, hv_free_blocks;
static u32 heap_verify(void) {
    u32 off = 0, prev_sz = 0, n = 0, viol = 0, frees = 0;
    hv_off = 0; hv_reason = 0; hv_blocks = 0; hv_free_blocks = 0;
    while (off + BLK_HDR <= HEAP_SIZE) {
        Blk *b = (Blk *)(HEAP + off);
        if (b->sz < BLK_HDR) { if (!viol) { hv_off = off; hv_reason = 1; } viol++; break; }
        if (b->sz & 31u)    { if (!viol) { hv_off = off; hv_reason = 2; } viol++; break; }
        if (b->pvsz != prev_sz) { if (!viol) { hv_off = off; hv_reason = 3; } viol++; }
        if (b->flags & BF_FREE) frees++;
        prev_sz = b->sz;
        off += b->sz;
        if (++n > 262144u) { if (!viol) { hv_off = off; hv_reason = 5; } viol++; break; }
    }
    if (off != HEAP_SIZE) { if (!viol) { hv_off = off; hv_reason = 4; } viol++; }
    hv_blocks = n;
    hv_free_blocks = frees;
    return viol;
}
u32 k_heap_verify(void) { return heap_verify(); }
u32 k_heap_violation(u32 which) { return which ? hv_reason : hv_off; }
u32 k_heap_blocks(void) { return hv_blocks; }
u32 k_heap_free_blocks(void) { return hv_free_blocks; }

/* ------------------------------------------------------------ stats + log */
static u32 STATS[ST_COUNT];
static u32 k_uptime, k_last_tick, boot_epoch_ms, k_slice = 10u;
static u32 panic_code;

static u32 LHEAD, LTAIL;
static void log_put(const char *t, u32 len) {
    u32 i;
    char pre[24]; Str s; u32 pl;
    s.b = pre; s.cap = sizeof(pre); s.n = 0;
    sputc(&s, '['); sputu(&s, k_uptime); sputs(&s, "ms] ");
    pl = s.n;
    for (i = 0; i < pl; i++) { LOG[LHEAD] = (u8)pre[i]; LHEAD = (LHEAD + 1u) % LOG_SIZE; }
    for (i = 0; i < len && i < 200u; i++) { LOG[LHEAD] = (u8)t[i]; LHEAD = (LHEAD + 1u) % LOG_SIZE; }
    LOG[LHEAD] = '\n'; LHEAD = (LHEAD + 1u) % LOG_SIZE;
}
static void logs(const char *t) { log_put(t, slen(t)); }

/* ------------------------------------------------------------ the process */
typedef struct {
    u32 used, pid, state, z, cpu_us, started, flags;
    char name[PROC_NAME];
} Proc;
static Proc PROCS[MAX_PROCS];
static u32 next_pid = 1, cur_proc, last_sched, proc_total_count;

static Proc *proc_by_pid(u32 pid) {
    u32 i;
    if (!pid) return 0;
    for (i = 0; i < MAX_PROCS; i++) if (PROCS[i].used && PROCS[i].pid == pid) return &PROCS[i];
    return 0;
}
static Proc *proc_by_index(u32 idx) {
    u32 i, n = 0;
    for (i = 0; i < MAX_PROCS; i++) if (PROCS[i].used) { if (n == idx) return &PROCS[i]; n++; }
    return 0;
}
static u32 proc_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_PROCS; i++) if (PROCS[i].used) n++;
    return n;
}

/* ---------------------------------------------------------- the timer queue */
typedef struct { u32 used, pid, interval, deadline, tid, oneshot; } Timer;
static Timer TIMERS[MAX_TIMERS];
static u32 FIRED[MAX_FIRED], fired_head, fired_tail, fired_drop;

static u32 timer_count(void) {
    u32 i, n = 0;
    for (i = 0; i < MAX_TIMERS; i++) if (TIMERS[i].used) n++;
    return n;
}
static void fired_push(u32 tid) {
    u32 nx = (fired_head + 1u) % MAX_FIRED;
    if (nx == fired_tail) { fired_drop++; return; }     /* queue full: drop */
    FIRED[fired_head] = tid; fired_head = nx;
}

/* --------------------------------------------------------------- filesystem */
typedef struct {
    u32 used, parent, size, data, mtime, is_dir;
    char name[NAME_SLOT];
} Node;
static Node NODES[MAX_NODES];
static u32 fs_files, fs_bytes;
u32 tmp_len;

static Node *node_get(u32 i) { return (i < MAX_NODES && NODES[i].used) ? &NODES[i] : 0; }
static u32 node_alloc(void) {
    u32 i;
    for (i = 1; i < MAX_NODES; i++) if (!NODES[i].used) return i;
    return 0;
}
static Node *node_find_child(u32 parent, const char *name, u32 nlen) {
    u32 i;
    for (i = 1; i < MAX_NODES; i++) {
        Node *n = &NODES[i];
        if (n->used && n->parent == parent && slen(n->name) == nlen && cieq((const u8 *)n->name, (const u8 *)name, nlen))
            return n;
    }
    return 0;
}
static void node_full_path(u32 idx, char *out, u32 cap) {
    char stack[8][NAME_SLOT];
    u32 depth = 0, i;
    Node *n = node_get(idx);
    while (n && idx != 0 && depth < 8) {
        for (i = 0; i < NAME_SLOT; i++) stack[depth][i] = n->name[i];
        depth++;
        idx = n->parent;
        n = node_get(idx);
    }
    {
        Str s; s.b = out; s.cap = cap; s.n = 0;
        if (depth == 0) { sputs(&s, "C:\\"); return; }
        for (i = depth; i-- > 0;) {
            sputs(&s, stack[i]);
            if (i) sputc(&s, '\\');
        }
    }
}
static void fs_recount(void) {
    u32 i;
    fs_files = 0; fs_bytes = 0;
    for (i = 1; i < MAX_NODES; i++)
        if (NODES[i].used && !NODES[i].is_dir) { fs_files++; fs_bytes += NODES[i].size; }
}
static void node_kill(u32 idx) {
    u32 i;
    Node *n = node_get(idx);
    if (!n) return;
    for (i = 1; i < MAX_NODES; i++)
        if (NODES[i].used && NODES[i].parent == idx) node_kill(i);
    if (n->data) heap_free((void *)n->data);
    zero(n, sizeof(Node));
}

/* path parsing -------------------------------------------------------- */
typedef struct { u32 n; char seg[MAX_SEG][SEG_LEN]; } Path;
static Path PP;

static u32 path_parse(const char *in, u32 len) {
    u32 i = 0;
    PP.n = 0;
    while (i < len && PP.n < MAX_SEG) {
        char seg[SEG_LEN];
        u32 j = 0;
        while (i < len && (in[i] == '\\' || in[i] == '/' || in[i] == ' ')) i++;
        if (i >= len) break;
        while (i < len && in[i] != '\\' && in[i] != '/') {
            if (j < SEG_LEN - 1) seg[j++] = in[i];
            i++;
        }
        seg[j] = 0;
        if (j == 0) continue;
        if (j == 1 && seg[0] == '.') continue;
        if (j == 2 && seg[0] == '.' && seg[1] == '.') { if (PP.n) PP.n--; continue; }
        memcpy(PP.seg[PP.n], seg, j + 1);
        PP.n++;
    }
    return PP.n;
}
/* resolve a parsed path; create_missing: 0 none, 1 create leaf file, 2 create dirs */
static Node *path_resolve(int create_missing) {
    u32 i = 0;
    Node *cur;
    if (PP.n == 0) return node_get(0);
    /* drive segment must look like "X:" otherwise assume C: */
    if (!(PP.seg[0][0] && PP.seg[0][1] == ':' && PP.seg[0][2] == 0)) {
        u32 k;
        if (PP.n >= MAX_SEG) return 0;
        for (k = PP.n; k > 0; k--) memcpy(PP.seg[k], PP.seg[k - 1], SEG_LEN);
        PP.seg[0][0] = 'C'; PP.seg[0][1] = ':'; PP.seg[0][2] = 0;
        PP.n++;
    }
    cur = node_get(0);
    for (i = 0; i < PP.n; i++) {
        Node *nxt = node_find_child(cur ? (u32)(cur - NODES) : 0, PP.seg[i], slen(PP.seg[i]));
        if (!nxt) {
            u32 islast = (i + 1u == PP.n);
            u32 as_dir;
            u32 ni;
            Node *nn;
            if (!create_missing) return 0;
            /* intermediate segments always become directories; the last one
               follows the requested mode (CM_FILE -> file, CM_DIR -> dir) */
            as_dir = (!islast || create_missing == 2) ? 1u : 0u;
            ni = node_alloc();
            if (!ni) return 0;
            nn = &NODES[ni];
            zero(nn, sizeof(Node));
            nn->used = 1; nn->parent = (u32)(cur - NODES); nn->mtime = k_uptime;
            nn->is_dir = as_dir;
            memcpy(nn->name, PP.seg[i], slen(PP.seg[i]) + 1);
            nxt = nn;
        }
        cur = nxt;
    }
    return cur;
}
#define CM_NONE 0
#define CM_FILE 1
#define CM_DIR  2
static Node *path_find(const char *p, u32 len) { path_parse(p, len); return path_resolve(CM_NONE); }
static Node *path_ensure(const char *p, u32 len, int mode) {
    path_parse(p, len);
    return path_resolve(mode == CM_DIR ? CM_DIR : CM_FILE);
}

/* base64 ------------------------------------------------------------------ */
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static i32 b64_len_for(u32 n) { return (i32)(((n + 2u) / 3u) * 4u); }
u32 b64_enc(const u8 *src, u32 n, char *dst) {
    u32 i = 0, o = 0;
    while (i + 2u < n) {
        u32 v = ((u32)src[i] << 16) | ((u32)src[i + 1] << 8) | src[i + 2];
        dst[o++] = B64[(v >> 18) & 63]; dst[o++] = B64[(v >> 12) & 63];
        dst[o++] = B64[(v >> 6) & 63];  dst[o++] = B64[v & 63];
        i += 3;
    }
    if (i < n) {
        u32 rem = n - i, v = (u32)src[i] << 16;
        if (rem == 2) v |= (u32)src[i + 1] << 8;
        dst[o++] = B64[(v >> 18) & 63]; dst[o++] = B64[(v >> 12) & 63];
        dst[o++] = (rem == 2) ? B64[(v >> 6) & 63] : '=';
        dst[o++] = '=';
    }
    return o;
}
static i32 b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
u32 b64_dec(const char *src, u32 n, u8 *dst) {
    u32 i = 0, o = 0;
    while (i + 3u < n) {
        i32 a = b64_val(src[i]), b = b64_val(src[i + 1]), c = b64_val(src[i + 2]), d = b64_val(src[i + 3]);
        u32 v;
        if (a < 0 || b < 0) break;
        c = c < 0 ? 0 : c; d = d < 0 ? 0 : d;
        v = ((u32)a << 18) | ((u32)b << 12) | ((u32)c << 6) | (u32)d;
        dst[o++] = (u8)(v >> 16);
        if (src[i + 2] != '=') dst[o++] = (u8)(v >> 8);
        if (src[i + 3] != '=') dst[o++] = (u8)v;
        i += 4;
    }
    return o;
}

/* --------------------------------------------------------------- registry */
/* The flat registry is now a view onto the NT registry hive implemented in
   nt.c: (path, name) is stored as hive key <path> with value <name>, so the
   desktop's existing k_reg_* calls keep working against one real store. */
i32 k_reg_set(u32 path, u32 pl, u32 name, u32 nl, u32 val, u32 vl) {
    STATS[ST_SYSCALLS]++;
    return nt_reg_set(path, pl, name, nl, val, vl);
}
i32 k_reg_get(u32 path, u32 pl, u32 name, u32 nl) {
    STATS[ST_SYSCALLS]++;
    tmp_len = 0;
    return nt_reg_get(path, pl, name, nl);
}
i32 k_reg_del(u32 path, u32 pl, u32 name, u32 nl) {
    STATS[ST_SYSCALLS]++;
    return nt_reg_del(path, pl, name, nl);
}
u32 k_reg_save(void) {
    STATS[ST_SYSCALLS]++;
    return nt_reg_save();
}
i32 k_reg_load(u32 ptr, u32 len) {
    STATS[ST_SYSCALLS]++;
    return nt_reg_load(ptr, len);
}
u32 k_reg_enum_count(void) { STATS[ST_SYSCALLS]++; return nt_reg_count(); }
u32 k_reg_enum(u32 idx) { STATS[ST_SYSCALLS]++; return nt_reg_enum(idx); }
u32 k_reg_enum_path_ptr(void) { return nt_reg_enum_path_ptr(); }
u32 k_reg_enum_path_len(void) { return nt_reg_enum_path_len(); }
u32 k_reg_enum_name_ptr(void) { return nt_reg_enum_name_ptr(); }
u32 k_reg_enum_name_len(void) { return nt_reg_enum_name_len(); }

/* ------------------------------------------------------------- boot seeding */
static void seed_file(const char *path, const char *data) {
    Node *n = path_ensure(path, slen(path), CM_FILE);
    u32 len = slen(data), i;
    if (!n) return;
    if (n->data) { heap_free((void *)n->data); n->data = 0; n->size = 0; }
    if (len) {
        u8 *buf = (u8 *)heap_alloc(len);
        if (!buf) return;
        for (i = 0; i < len; i++) buf[i] = (u8)data[i];
        n->data = (u32)buf; n->size = len;
    }
    n->mtime = k_uptime;
}
static void seed_dir(const char *path) { path_ensure(path, slen(path), CM_DIR); }

static void kernel_seed(void) {
    /* drives live under the invisible root (node 0) */
    seed_dir("C:");
    seed_dir("A:");
    seed_dir("C:\\WINDOWS");
    seed_dir("C:\\WINDOWS\\SYSTEM");
    seed_dir("C:\\WINDOWS\\TEMP");
    seed_dir("C:\\WINDOWS\\FONTS");
    seed_dir("C:\\WINDOWS\\MEDIA");
    seed_dir("C:\\WINDOWS\\START MENU");
    seed_dir("C:\\WINDOWS\\START MENU\\PROGRAMS");
    seed_dir("C:\\WINDOWS\\START MENU\\PROGRAMS\\ACCESSORIES");
    seed_dir("C:\\WINDOWS\\START MENU\\PROGRAMS\\GAMES");
    seed_dir("C:\\WINDOWS\\START MENU\\PROGRAMS\\STARTUP");
    seed_dir("C:\\WINDOWS\\DESKTOP");
    seed_dir("C:\\WINDOWS\\COOKIES");
    seed_dir("C:\\WINDOWS\\HISTORY");
    seed_dir("C:\\WINDOWS\\FAVORITES");
    seed_dir("C:\\Program Files");
    seed_dir("C:\\Program Files\\Accessories");
    seed_dir("C:\\Program Files\\Outlook Express");
    seed_dir("C:\\Program Files\\Internet Explorer");
    seed_dir("C:\\My Documents");
    seed_dir("C:\\My Documents\\My Pictures");
    seed_dir("C:\\Recycled");

    seed_file("C:\\AUTOEXEC.BAT",
        "@ECHO OFF\r\nPROMPT $p$g\r\nPATH C:\\WINDOWS;C:\\WINDOWS\\COMMAND\r\n"
        "SET TEMP=C:\\WINDOWS\\TEMP\r\nLH C:\\WINDOWS\\COMMAND\\MSCDEX.EXE /D:MSCD001\r\n");
    seed_file("C:\\CONFIG.SYS",
        "DEVICE=C:\\WINDOWS\\HIMEM.SYS\r\nDEVICE=C:\\WINDOWS\\EMM386.EXE NOEMS\r\n"
        "DOS=HIGH,UMB\r\nFILES=60\r\nBUFFERS=30\r\nSTACKS=9,256\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM.INI",
        "[boot]\r\nshell=Explorer.exe\r\nsystem.drv=system.drv\r\n"
        "drivers=mmsystem.dll power.drv\r\n\r\n[386Enh]\r\n"
        "device=*vpicd\r\ndevice=*vtd\r\nEMMExclude=A000-FFFF\r\n\r\n"
        "[drivers]\r\nwave=mmdrv.dll\r\ntimer=timer.drv\r\n");
    seed_file("C:\\WINDOWS\\WIN.INI",
        "[windows]\r\nload=\r\nrun=\r\nNullPort=None\r\n\r\n"
        "[Desktop]\r\nWallpaper=(None)\r\nTileWallpaper=1\r\n\r\n"
        "[intl]\r\nsLanguage=ENU\r\ns1159=AM\r\ns2359=PM\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM\\kernel32.dll",
        "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF\x00\x00"
        "This module is emulated by kernel.wasm (wasm32). PE / DLL loader stub.\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM\\user32.dll", "MZ\x90\x00 user32 -> web/js/shell.js (window manager)\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM\\gdi32.dll",  "MZ\x90\x00 gdi32 -> canvas surfaces\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM\\advapi32.dll", "MZ\x90\x00 advapi32 -> registry, lives in wasm\r\n");
    seed_file("C:\\WINDOWS\\SYSTEM.INI.BAK", "; backup of SYSTEM.INI made by ScanDisk\r\n");
    seed_file("C:\\WINDOWS\\WINVER.EXE", "Not a real executable. 4.10.1998\r\n");
    seed_file("C:\\My Documents\\Welcome.txt",
        "Welcome to Windows 98\r\n"
        "=====================\r\n\r\n"
        "This desktop, its windows, its filesystem and the process list you see\r\n"
        "in Task Manager are all served by kernel.wasm -- a 32-bit kernel image\r\n"
        "compiled from C to WebAssembly and executed by your browser.\r\n\r\n"
        "  * the filesystem below C:\\ lives in the kernel's heap\r\n"
        "  * every window is a process in the kernel process table\r\n"
        "  * the kernel runs a timer queue and a round-robin scheduler;\r\n"
        "    open Task Manager and watch the CPU time accumulate\r\n\r\n"
        "Try: Start > Programs > MS-DOS Prompt, then type HELP.\r\n"
        "Try: Start > Programs > Games for Minesweeper, Solitaire,\r\n"
        "     FreeCell, JezzBall, 3D Pinball and real emulated DOS games.\r\n");
    seed_file("C:\\My Documents\\Readme.txt",
        "Important:\r\n"
        "1. Do not turn off your computer while this file is being saved.\r\n"
        "2. The kernel heap is 8 MB. SYSTEM.INI has a 2 MB temp buffer.\r\n"
        "3. Type MEM at the command prompt to see the kernel's memory map.\r\n");
    seed_file("C:\\Program Files\\Accessories\\README.TXT",
        "These applets are registered with the shell on boot.\r\n");
    seed_file("C:\\WINDOWS\\TEMP\\~DF1A2B.TMP", "\x00\x01temporary cluster\r\n");
    fs_recount();
}

/* ----------------------------------------------------------- boot/exports */
u32 k_version(void) {
    STATS[ST_SYSCALLS]++;
    return KVER;
}

void k_init(u32 seed) {
    STATS[ST_SYSCALLS]++;
    zero(STATS, sizeof(STATS));
    zero(PROCS, sizeof(PROCS));
    zero(TIMERS, sizeof(TIMERS));
    zero(NODES, sizeof(NODES));
    zero(LOG, LOG_SIZE);
    zero(NAMES, sizeof(NAMES));
    zero(TMP, TMP_SIZE);
    LHEAD = LTAIL = 0;
    fired_head = fired_tail = fired_drop = 0;
    next_pid = 1; cur_proc = 0; last_sched = 0; proc_total_count = 0;
    k_uptime = 0; k_last_tick = 0; panic_code = 0;
    k_slice = 10;
    heap_init();
    STATS[ST_VERSION] = KVER;
    /* root node: an invisible container holding the drive letters */
    zero(&NODES[0], sizeof(Node));
    NODES[0].used = 1; NODES[0].parent = 0; NODES[0].is_dir = 1;
    NODES[0].name[0] = 0;
    STATS[ST_NODES] = 1;
    kernel_seed();
    nt_init();
    STATS[ST_TMP_CAP] = TMP_SIZE;
    STATS[ST_HEAP_SIZE] = HEAP_SIZE;
    STATS[ST_SLICE] = k_slice;
    STATS[ST_NEXT_PID] = next_pid;
    STATS[ST_UPTIME] = 0;
    logs("wasm32 kernel boot; heap=8MB tmp=2MB nodes=4096");
}

/* the shell's VMBus relay, surfaced to JS as k_vmbus_tx */
u32 k_vmbus_tx(u32 bytes);
u32 k_vmbus_stats(u32 which);

u32 k_alloc(u32 n) { STATS[ST_SYSCALLS]++; return (u32)heap_alloc(n); }
void k_free(u32 p) { STATS[ST_SYSCALLS]++; heap_free((void *)p); }
u32 k_rand(void) {
    STATS[ST_SYSCALLS]++;
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}
void k_seed(u32 v) { STATS[ST_SYSCALLS]++; rng_state = v ? v : 0x1f2e3d4cu; }
u32 k_stat(u32 idx) {
    STATS[ST_SYSCALLS]++;
    switch (idx) {
        case ST_HEAP_USED:  return heap_used;
        case ST_HEAP_FREE:  return heap_freebytes();
        case ST_QUEUE:      return timer_count();
        case ST_NDESC:      return proc_count();
        case ST_NEXT_PID:   return next_pid;
        case ST_UPTIME:     return k_uptime;
        case ST_FILES:      return fs_files;
        case ST_BYTES:      return fs_bytes;
        case ST_REG:        return nt_stat(NS_REG_VALUES);
        case ST_NODES:      { u32 i, n = 0; for (i = 0; i < MAX_NODES; i++) if (NODES[i].used) n++; return n; }
        case ST_FIRED:      return (fired_head + MAX_FIRED - fired_tail) % MAX_FIRED;
        case ST_DROPPED:    return fired_drop;
        case ST_PANIC:      return panic_code;
        case ST_SLICE:      return k_slice;
        case ST_CURRENT:    return cur_proc;
        default:
            if (idx >= 100u) return nt_stat(idx - 100u);   /* NT executive counters */
            if (idx < ST_COUNT) return STATS[idx];
            return 0;
    }
}

/* ------------------------------------------------------------------- log */
u32 k_log_ptr(void) { return (u32)&LOG[0]; }
u32 k_log_len(void) {
    /* chronological: from tail to head */
    return (LHEAD >= LTAIL) ? (LHEAD - LTAIL) : (LOG_SIZE - LTAIL + LHEAD);
}
void k_log_clear(void) { STATS[ST_SYSCALLS]++; LHEAD = LTAIL = 0; }
void k_log(u32 p, u32 len) { STATS[ST_SYSCALLS]++; log_put((const char *)p, len); }

/* --------------------------------------------------------------- processes */
u32 k_proc_create(u32 name_ptr, u32 name_len, u32 flags) {
    u32 i, pid;
    STATS[ST_SYSCALLS]++;
    for (i = 0; i < MAX_PROCS; i++) {
        if (!PROCS[i].used) {
            Proc *p = &PROCS[i];
            zero(p, sizeof(Proc));
            p->used = 1; p->pid = next_pid++; p->state = PS_RUNNING;
            p->started = k_uptime; p->flags = flags; p->z = i;
            memcpy(p->name, (const void *)name_ptr, (name_len < PROC_NAME - 1u) ? name_len : PROC_NAME - 1u);
            p->name[PROC_NAME - 1u] = 0;
            pid = p->pid;
            proc_total_count++;
            nt_on_proc_create(pid, name_ptr, name_len);
            STATS[ST_PROCS] = proc_total_count;
            STATS[ST_NEXT_PID] = next_pid;
            log_put("proc create ", 12);
            log_put(p->name, slen(p->name));
            return pid;
        }
    }
    return 0;
}
i32 k_proc_destroy(u32 pid) {
    Proc *p;
    u32 i;
    STATS[ST_SYSCALLS]++;
    p = proc_by_pid(pid);
    if (!p) return -1;
    for (i = 0; i < MAX_TIMERS; i++) if (TIMERS[i].used && TIMERS[i].pid == pid) TIMERS[i].used = 0;
    log_put("proc exit ", 10);
    log_put(p->name, slen(p->name));
    nt_on_proc_destroy(pid);
    if (cur_proc == pid) cur_proc = 0;
    zero(p, sizeof(Proc));
    return 0;
}
u32 k_proc_count(void) { STATS[ST_SYSCALLS]++; return proc_count(); }
u32 k_proc_pid_at(u32 idx) {
    Proc *p;
    STATS[ST_SYSCALLS]++;
    p = proc_by_index(idx);
    return p ? p->pid : 0;
}
u32 k_proc_field(u32 pid, u32 field) {
    Proc *p;
    STATS[ST_SYSCALLS]++;
    p = proc_by_pid(pid);
    if (!p) return 0;
    switch (field) {
        case PF_PID:     return p->pid;
        case PF_STATE:   return p->state;
        case PF_Z:       return p->z;
        case PF_CPU_US:  return p->cpu_us;
        case PF_FLAGS:   return p->flags;
        case PF_STARTED: return p->started;
        case PF_INDEX:   return (u32)(p - PROCS);
        default: return 0;
    }
}
i32 k_proc_set_field(u32 pid, u32 field, u32 val) {
    Proc *p;
    STATS[ST_SYSCALLS]++;
    p = proc_by_pid(pid);
    if (!p) return -1;
    switch (field) {
        case PF_STATE: p->state = val; break;
        case PF_Z:     p->z = val; break;
        case PF_FLAGS: p->flags = val; break;
        default: return -1;
    }
    return 0;
}
u32 k_proc_name_ptr(u32 pid) {
    Proc *p;
    STATS[ST_SYSCALLS]++;
    p = proc_by_pid(pid);
    return p ? (u32)&p->name[0] : 0;
}
u32 k_proc_name_len(u32 pid) {
    Proc *p;
    STATS[ST_SYSCALLS]++;
    p = proc_by_pid(pid);
    return p ? slen(p->name) : 0;
}
u32 k_focus_get(void) { STATS[ST_SYSCALLS]++; return cur_proc; }
void k_focus_set(u32 pid) {
    STATS[ST_SYSCALLS]++;
    if (!pid || proc_by_pid(pid)) cur_proc = pid;
}
u32 k_sched_current(void) { STATS[ST_SYSCALLS]++; return cur_proc; }
void k_sched_slice(u32 ms) {
    STATS[ST_SYSCALLS]++;
    k_slice = (ms < 2u) ? 2u : (ms > 1000u ? 1000u : ms);
    STATS[ST_SLICE] = k_slice;
}
u32 k_sched_switches(void) { STATS[ST_SYSCALLS]++; return STATS[ST_SWITCHES]; }

/* ------------------------------------------------------------------ timers */
u32 k_timer_set(u32 pid, u32 interval_ms, u32 oneshot) {
    u32 i;
    STATS[ST_SYSCALLS]++;
    for (i = 0; i < MAX_TIMERS; i++) {
        if (!TIMERS[i].used) {
            Timer *t = &TIMERS[i];
            t->used = 1; t->pid = pid; t->tid = i + 1;
            t->interval = interval_ms ? interval_ms : 1u;
            t->deadline = k_uptime + t->interval;
            t->oneshot = oneshot ? 1u : 0u;
            return t->tid;
        }
    }
    return 0;
}
i32 k_timer_kill(u32 tid) {
    STATS[ST_SYSCALLS]++;
    if (tid < 1u || tid > MAX_TIMERS) return -1;
    if (!TIMERS[tid - 1u].used) return -1;
    TIMERS[tid - 1u].used = 0;
    return 0;
}
u32 k_timer_pid(u32 tid) {
    STATS[ST_SYSCALLS]++;
    if (tid >= 1u && tid <= MAX_TIMERS && TIMERS[tid - 1u].used) return TIMERS[tid - 1u].pid;
    return 0;
}
u32 k_timer_count(void) { STATS[ST_SYSCALLS]++; return timer_count(); }
u32 k_timer_next(void) {
    u32 i, best = 0;
    STATS[ST_SYSCALLS]++;
    for (i = 0; i < MAX_TIMERS; i++)
        if (TIMERS[i].used && (!best || TIMERS[i].deadline < best)) best = TIMERS[i].deadline;
    return best;
}
u32 k_fired_pop(void) {
    u32 tid;
    STATS[ST_SYSCALLS]++;
    if (fired_tail == fired_head) return 0;
    tid = FIRED[fired_tail];
    fired_tail = (fired_tail + 1u) % MAX_FIRED;
    return tid;
}

/* the kernel's heartbeat: clock, timer queue, scheduler */
u32 k_tick(u32 now_ms) {
    u32 i, dt, fired = 0;
    STATS[ST_SYSCALLS]++;
    if (now_ms < k_last_tick) now_ms = k_last_tick;     /* no time travel */
    dt = now_ms - k_last_tick;
    k_last_tick = now_ms;
    k_uptime = now_ms;
    STATS[ST_UPTIME] = k_uptime;
    STATS[ST_TICKS]++;

    /* 1. expire timers */
    for (i = 0; i < MAX_TIMERS; i++) {
        Timer *t = &TIMERS[i];
        u32 catchup = 0;
        if (!t->used) continue;
        while (t->deadline <= k_uptime) {
            fired_push(t->tid);
            STATS[ST_TIMERS]++;
            fired++;
            if (t->oneshot) { t->used = 0; break; }
            t->deadline += t->interval;
            if (++catchup >= 4u) { t->deadline = k_uptime + t->interval; break; }
        }
    }

    /* 2. NT executive: DPC drain, APC delivery, wait timeouts, thread aging */
    nt_tick(k_uptime, dt);

    /* 3. round-robin scheduler: charge the elapsed slice to a live process */
    {
        u32 n = proc_count(), k;
        if (n) {
            for (k = 0; k < MAX_PROCS; k++) {
                u32 idx = (last_sched + 1u + k) % MAX_PROCS;
                Proc *p = &PROCS[idx];
                if (p->used && (p->state == PS_RUNNING || p->state == PS_MIN)) {
                    p->cpu_us += dt * 1000u;
                    if (p->pid != last_sched) { STATS[ST_SWITCHES]++; last_sched = p->pid; }
                    if (!cur_proc || !proc_by_pid(cur_proc)) cur_proc = p->pid;
                    break;
                }
            }
        }
    }
    return fired;
}

/* --------------------------------------------------------------- filesystem */
i32 k_fs_mkdir(u32 p, u32 l) {
    Node *n;
    STATS[ST_SYSCALLS]++;
    n = path_ensure((const char *)p, l, CM_DIR);
    if (!n) return -1;
    if (!n->is_dir) return -2;
    log_put("mkdir ", 6); log_put((const char *)p, l);
    return 0;
}
i32 k_fs_write(u32 p, u32 l, u32 data, u32 dlen) {
    Node *n;
    STATS[ST_SYSCALLS]++;
    if (dlen > MAX_FILE) return -3;
    n = path_ensure((const char *)p, l, CM_FILE);
    if (!n) return -1;
    if (n->is_dir) return -2;
    if (n->data) { heap_free((void *)n->data); n->data = 0; n->size = 0; }
    if (dlen) {
        u8 *buf = (u8 *)heap_alloc(dlen);
        if (!buf) { logs("fs: heap exhausted"); return -4; }
        memcpy(buf, (const void *)data, dlen);
        n->data = (u32)buf;
    }
    n->size = dlen;
    n->mtime = k_uptime;
    fs_recount();
    return (i32)dlen;
}
i32 k_fs_read(u32 p, u32 l) {
    Node *n;
    STATS[ST_SYSCALLS]++;
    tmp_len = 0;
    n = path_find((const char *)p, l);
    if (!n || n->is_dir) return -1;
    if (n->size > TMP_SIZE) return -2;
    if (n->size) memcpy(TMP, (const void *)n->data, n->size);
    tmp_len = n->size;
    return (i32)n->size;
}
i32 k_fs_size(u32 p, u32 l) { Node *n; STATS[ST_SYSCALLS]++; n = path_find((const char *)p, l); return n ? (i32)n->size : -1; }
i32 k_fs_exists(u32 p, u32 l) { STATS[ST_SYSCALLS]++; return path_find((const char *)p, l) ? 1 : 0; }
i32 k_fs_is_dir(u32 p, u32 l) { Node *n; STATS[ST_SYSCALLS]++; n = path_find((const char *)p, l); return n ? (i32)n->is_dir : -1; }
i32 k_fs_unlink(u32 p, u32 l) {
    Node *n;
    STATS[ST_SYSCALLS]++;
    path_parse((const char *)p, l);
    n = path_resolve(0);
    if (!n || n == &NODES[0]) return -1;
    node_kill((u32)(n - NODES));
    fs_recount();
    log_put("del ", 4); log_put((const char *)p, l);
    return 0;
}
i32 k_fs_rename(u32 a, u32 al, u32 b, u32 bl) {
    Node *na, *parent, *dst;
    char ppath[MAX_PATH];
    char leaf[SEG_LEN];
    Str s;
    u32 i;
    STATS[ST_SYSCALLS]++;
    na = path_find((const char *)a, al);
    if (!na || na == &NODES[0]) return -1;
    /* parse the destination: last segment is the new name, the rest its parent */
    path_parse((const char *)b, bl);
    if (PP.n == 0) return -1;
    for (i = 0; i < SEG_LEN; i++) leaf[i] = PP.seg[PP.n - 1u][i];
    s.b = ppath; s.cap = MAX_PATH; s.n = 0;
    for (i = 0; i + 1u < PP.n; i++) {
        if (i) sputc(&s, '\\');
        sputs(&s, PP.seg[i]);
    }
    if (s.n == 0) return -1;
    parent = path_ensure(ppath, s.n, CM_DIR);
    if (!parent) return -1;
    if (parent == na) return -2;                       /* refuse moving into itself */
    dst = node_find_child((u32)(parent - NODES), leaf, slen(leaf));
    if (dst && dst != na) node_kill((u32)(dst - NODES));  /* overwrite semantics */
    memcpy(na->name, leaf, slen(leaf) + 1);
    na->parent = (u32)(parent - NODES);
    na->mtime = k_uptime;
    fs_recount();
    log_put("ren ", 4); log_put((const char *)a, al);
    return 0;
}
/* directory iteration */
typedef struct { u32 used, node, iter; } DirOp;
static DirOp DIROPS[MAX_DIROPS];
static u32 d_name_ptr, d_name_len, d_size, d_is_dir, d_mtime;
i32 k_fs_opendir(u32 p, u32 l) {
    Node *n;
    u32 i;
    STATS[ST_SYSCALLS]++;
    n = path_find((const char *)p, l);
    if (!n || !n->is_dir) return -1;
    for (i = 0; i < MAX_DIROPS; i++) {
        if (!DIROPS[i].used) {
            DIROPS[i].used = 1; DIROPS[i].node = (u32)(n - NODES); DIROPS[i].iter = 0;
            return (i32)(i + 1);
        }
    }
    return -2;
}
i32 k_fs_readdir(i32 h) {
    DirOp *d;
    STATS[ST_SYSCALLS]++;
    if (h < 1 || h > (i32)MAX_DIROPS) return -1;
    d = &DIROPS[h - 1];
    if (!d->used) return -1;
    while (d->iter < MAX_NODES) {
        u32 i = d->iter++;
        Node *n = &NODES[i];
        if (n->used && i != 0 && n->parent == d->node) {
            d_name_ptr = (u32)&n->name[0];
            d_name_len = slen(n->name);
            d_size = n->size;
            d_is_dir = n->is_dir;
            d_mtime = n->mtime;
            return 1;
        }
    }
    return 0;
}
i32 k_fs_closedir(i32 h) {
    STATS[ST_SYSCALLS]++;
    if (h < 1 || h > (i32)MAX_DIROPS) return -1;
    DIROPS[h - 1].used = 0;
    return 0;
}
u32 k_dir_name_ptr(void) { return d_name_ptr; }
u32 k_dir_name_len(void) { return d_name_len; }
u32 k_dir_size(void) { return d_size; }
u32 k_dir_is_dir(void) { return d_is_dir; }
u32 k_dir_mtime(void) { return d_mtime; }
u32 k_tmp_ptr(void) { return (u32)&TMP[0]; }
u32 k_tmp_len(void) { return tmp_len; }
u32 k_tmp_cap(void) { return TMP_SIZE; }
u32 k_heap_used(void) { STATS[ST_SYSCALLS]++; return heap_used; }
u32 k_heap_peak(void) { STATS[ST_SYSCALLS]++; return heap_peak; }

/* --------------------------------------------------- filesystem persistence */
u32 k_fs_save(void) {
    u32 i;
    Str s;
    STATS[ST_SYSCALLS]++;
    s.b = (char *)TMP; s.cap = TMP_SIZE; s.n = 0;
    sputs(&s, MK_FS "\n");
    for (i = 1; i < MAX_NODES; i++) {
        Node *n = &NODES[i];
        char full[MAX_PATH];
        if (!n->used) continue;
        node_full_path(i, full, MAX_PATH);
        if (n->is_dir) continue;                       /* dirs are implied by paths */
        sputc(&s, '0'); sputc(&s, '|');
        sputu(&s, n->mtime); sputc(&s, '|');
        sputu(&s, n->size); sputc(&s, '|');
        sputs(&s, full); sputc(&s, '|');
        if (n->size) {
            u32 need = (u32)b64_len_for(n->size);
            if (s.n + need + 2u > s.cap) { break; }
            s.n += b64_enc((const u8 *)n->data, n->size, (char *)(TMP + s.n));
            TMP[s.n] = 0;
        }
        sputc(&s, '\n');
    }
    /* empty directories need explicit records */
    for (i = 1; i < MAX_NODES; i++) {
        Node *n = &NODES[i];
        char full[MAX_PATH];
        u32 has_child = 0, k;
        if (!n->used || !n->is_dir) continue;
        for (k = 1; k < MAX_NODES; k++) if (NODES[k].used && NODES[k].parent == i) { has_child = 1; break; }
        if (has_child) continue;
        node_full_path(i, full, MAX_PATH);
        sputc(&s, '1'); sputc(&s, '|'); sputu(&s, n->mtime); sputs(&s, "|0|");
        sputs(&s, full); sputc(&s, '|'); sputc(&s, '\n');
    }
    tmp_len = s.n;
    return s.n;
}
i32 k_fs_load(u32 ptr, u32 len) {
    const char *p = (const char *)ptr, *end = p + len;
    u32 i = 0, done = 0;
    STATS[ST_SYSCALLS]++;
    /* wipe user tree but keep drives */
    for (i = 1; i < MAX_NODES; i++) {
        Node *n = &NODES[i];
        if (!n->used) continue;
        if (n->parent == 0 && n->is_dir) continue;      /* keep C: / A: */
        if (n->data) { heap_free((void *)n->data); n->data = 0; }
    }
    for (i = 1; i < MAX_NODES; i++) {
        Node *n = &NODES[i];
        if (n->used && !(n->parent == 0 && n->is_dir)) zero(n, sizeof(Node));
    }
    /* skip header line */
    while (p < end && *p != '\n') p++;
    if (p < end) p++;
    while (p < end) {
        u32 mtime = 0, size = 0, pl = 0, fieldno = 0;
        u32 isdir = 0;
        char path[MAX_PATH];
        const char *b64 = 0;
        u32 b64len = 0;
        path[0] = 0;
        /* parse one "isdir|mtime|size|path|base64\n" record */
        while (p < end && *p != '\n') {
            const char *f0 = p;
            u32 fl;
            while (p < end && *p != '|' && *p != '\n') p++;
            fl = (u32)(p - f0);
            switch (fieldno) {
                case 0: isdir = (fl && f0[0] == '1') ? 1u : 0u; break;
                case 1: spari(f0, fl, &mtime); break;
                case 2: spari(f0, fl, &size); break;
                case 3:
                    pl = fl < MAX_PATH - 1u ? fl : MAX_PATH - 1u;
                    memcpy(path, f0, pl);
                    path[pl] = 0;
                    break;
                case 4: b64 = f0; b64len = fl; break;
                default: break;
            }
            fieldno++;
            if (p < end && *p == '|') p++;
        }
        if (p < end && *p == '\n') p++;
        if (pl) {
            if (isdir) {
                path_ensure(path, pl, CM_DIR);
            } else {
                Node *n = path_ensure(path, pl, CM_FILE);
                if (n) {
                    if (n->data) { heap_free((void *)n->data); n->data = 0; n->size = 0; }
                    if (size && b64len) {
                        u8 *buf = (u8 *)heap_alloc(size + 4u);
                        if (buf) {
                            u32 dl = b64_dec(b64, b64len, buf);
                            n->data = (u32)buf;
                            n->size = dl;
                        }
                    }
                    n->mtime = mtime;
                }
            }
        }
        done++;
        if (p >= end) break;
    }
    fs_recount();
    log_put("fs: restored volume", 18);
    return (i32)done;
}

/* ------------------------------------------------------------------ panic */
u32 k_panic(u32 code) {
    STATS[ST_SYSCALLS]++;
    panic_code = code;
    logs("*** STOP: 0x00000000 -- kernel panic requested");
    return code;
}
u32 k_panicked(void) { STATS[ST_SYSCALLS]++; return panic_code; }
u32 k_boot_ms(void) { STATS[ST_SYSCALLS]++; return boot_epoch_ms; }
void k_set_boot(u32 ms) { STATS[ST_SYSCALLS]++; boot_epoch_ms = ms; }
