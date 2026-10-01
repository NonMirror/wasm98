/* ============================================================================
   nt.c — the NT-style executive layer.  Part 1: objects, handles, security,
   threads and the scheduler, dispatcher objects, IRQL, DPCs and APCs.

   See nt.h for the contract and HV_ABI.md section 1 for the design notes.
   Freestanding: no libc, no allocation from outside the static arenas below.
   ========================================================================== */
#include "nt.h"

/* ------------------------------------------------------------- utilities */
static void z(void *d, u32 n) { u8 *p = (u8 *)d; while (n--) *p++ = 0; }
static void cp(void *d, const void *s, u32 n) { u8 *a = (u8 *)d; const u8 *b = (const u8 *)s; while (n--) *a++ = *b++; }
static u32 sl(const char *s) { u32 n = 0; while (s[n]) n++; return n; }
static int cieq(const char *a, const char *b, u32 n) {
    u32 i;
    for (i = 0; i < n; i++) {
        u8 x = (u8)a[i], y = (u8)b[i];
        if (x >= 'a' && x <= 'z') x -= 32;
        if (y >= 'a' && y <= 'z') y -= 32;
        if (x != y) return 0;
    }
    return 1;
}
/* --------------------------------------------------------------- storage */
static u8  NAMES[NT_NAME_POOL];
static u8  DATA[NT_DATA_POOL];
static u32 names_used, data_used;

/* The hive keeps its strings and value bytes in two pools.  Both are
   first-fit allocators with a coalescing free list, because a registry that
   never reuses space runs out while the user is still typing: keys and values
   are freed when deleted or overwritten, and every refusal to allocate is
   counted as a hive quota hit instead of failing silently. */
typedef struct { u32 off, len; } PoolFree;
#define POOL_FREE_SLOTS 48u
static PoolFree nfree[POOL_FREE_SLOTS], dfree[POOL_FREE_SLOTS];
static u32 nfree_n, dfree_n, name_quota_hits, data_quota_hits, pool_frozen;

static u32 pool_take(PoolFree *fr, u32 *frn, u32 *used, u32 cap, u32 len) {
    u32 i;
    for (i = 0; i < *frn; i++) {
        if (fr[i].len >= len) {
            u32 off = fr[i].off;
            if (fr[i].len == len) {
                u32 j;
                for (j = i; j + 1 < *frn; j++) fr[j] = fr[j + 1];
                (*frn)--;
            } else {
                fr[i].off += len;
                fr[i].len -= len;
            }
            return off;
        }
    }
    if (*used + len > cap) return 0;
    {
        u32 off = *used;
        *used += len;
        return off;
    }
}
static void pool_give(PoolFree *fr, u32 *frn, u32 off, u32 len) {
    u32 i, j;
    if (!off || !len) return;
    for (i = 0; i < *frn && fr[i].off < off; i++) {}
    if (*frn >= POOL_FREE_SLOTS) return;              /* free list full: the block leaks */
    for (j = *frn; j > i; j--) fr[j] = fr[j - 1];
    fr[i].off = off;
    fr[i].len = len;
    (*frn)++;
    /* coalesce with the neighbours */
    for (i = 0; i + 1 < *frn;) {
        if (fr[i].off + fr[i].len == fr[i + 1].off) {
            fr[i].len += fr[i + 1].len;
            for (j = i + 1; j + 1 < *frn; j++) fr[j] = fr[j + 1];
            (*frn)--;
        } else {
            i++;
        }
    }
}
static u32 name_store(u32 ptr, u32 len) {
    u32 off;
    if (len > 63u) len = 63u;
    off = pool_take(nfree, &nfree_n, &names_used, NT_NAME_POOL, len + 1u);
    if (!off) { name_quota_hits++; return 0; }
    cp(NAMES + off, (const void *)ptr, len);
    NAMES[off + len] = 0;
    return off;
}
static void name_free(u32 off, u32 len) {
    if (len > 63u) len = 63u;
    pool_give(nfree, &nfree_n, off, len + 1u);
}
static u32 data_store(u32 ptr, u32 len) {
    u32 off = pool_take(dfree, &dfree_n, &data_used, NT_DATA_POOL, len + 4u);
    if (!off) { data_quota_hits++; return 0; }
    cp(DATA + off, (const void *)ptr, len);
    return off;
}
static void data_free(u32 off, u32 len) {
    if (off && len) pool_give(dfree, &dfree_n, off, len + 4u);
}
static const char *N(u32 off) { return (const char *)(NAMES + off); }

/* ---------------------------------------------------------------- objects */
typedef struct {
    u32 used, type, refs, dacl, owner_pid;
    u32 name_off, name_len;
    /* dispatcher payload */
    u32 dstate, dmanual, dcount, dlimit, downer, dsignals;
    u32 waiters[NT_PRIO];         /* thread ids, highest priority first */
    u32 wait_count;
} NtObj;
static NtObj OBJ[NT_MAX_OBJ];
static u32 obj_created, obj_deleted, obj_peak;

static NtObj *obj(u32 id) { return (id && id < NT_MAX_OBJ && OBJ[id].used) ? &OBJ[id] : 0; }

static u32 obj_alloc(void) {
    u32 i;
    for (i = 1; i < NT_MAX_OBJ; i++) if (!OBJ[i].used) return i;
    return 0;
}

u32 k_obj_create(u32 type, u32 name_ptr, u32 name_len, u32 dacl) {
    u32 id = obj_alloc();
    if (!id) return 0;
    z(&OBJ[id], sizeof(NtObj));
    OBJ[id].used = 1;
    OBJ[id].type = type;
    OBJ[id].refs = 1;
    OBJ[id].dacl = dacl ? dacl : DACL_PUBLIC;
    OBJ[id].name_off = name_len ? name_store(name_ptr, name_len) : 0;
    OBJ[id].name_len = name_len ? (name_len > 63u ? 63u : name_len) : 0;
    obj_created++;
    if (obj_created > obj_peak) obj_peak = obj_created;
    return id;
}
i32 k_obj_ref(u32 id) {
    NtObj *o = obj(id);
    if (!o) return -1;
    o->refs++;
    return (i32)o->refs;
}
i32 k_obj_deref(u32 id) {
    NtObj *o = obj(id);
    u32 i, j;
    if (!o) return -1;
    if (--o->refs) return (i32)o->refs;
    /* last reference: drop the waiters and free the slot */
    for (i = 0; i < NT_MAX_PID; i++) (void)i;
    for (j = 0; j < o->wait_count; j++) (void)j;
    z(o, sizeof(NtObj));
    obj_deleted++;
    return 0;
}
u32 k_obj_type(u32 id) { NtObj *o = obj(id); return o ? o->type : 0; }
u32 k_obj_name_ptr(u32 id) { NtObj *o = obj(id); return o ? (u32)(NAMES + o->name_off) : 0; }
u32 k_obj_name_len(u32 id) { NtObj *o = obj(id); return o ? o->name_len : 0; }
u32 k_obj_count(void) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_OBJ; i++) if (OBJ[i].used) n++;
    return n;
}
u32 k_obj_field(u32 id, u32 f) {
    NtObj *o = obj(id);
    u32 i, n = 0;
    if (!o) return 0;
    for (i = 0; i < NT_MAX_OBJ; i++) if (OBJ[i].used) { if (i == id) break; n++; }
    switch (f) {
        case 0: return o->name_off ? (u32)(NAMES + o->name_off) : 0;
        case 1: return o->type;
        case 2: return o->refs;
        case 3: return o->dacl;
        case 4: return o->name_len;
        case 5: return o->name_off ? (u32)(NAMES + o->name_off) : 0;
        case 6: {
            u32 pid, total = 0;
            for (pid = 0; pid < NT_MAX_PID; pid++) total += k_handle_count(pid);
            return total;
        }
        case OF_DSTATE:  return o->dstate;
        case OF_DMANUAL: return o->dmanual;
        case OF_DCOUNT:  return o->dcount;
        case OF_DLIMIT:  return o->dlimit;
        case OF_DOWNER:  return o->downer;
        case OF_DSIGNALS: return o->dsignals;
        case OF_DWAITS:  return o->wait_count;
        default: return n;
    }
}

/* ---------------------------------------------------------------- handles */
typedef struct { u32 used, obj, access; } NtHandle;
static NtHandle HANDLES[NT_MAX_PID][NT_MAX_HANDLE];
u32 handle_total;

u32 k_handle_count(u32 pid) {
    u32 i, n = 0;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_HANDLE; i++) if (HANDLES[pid][i].used) n++;
    return n;
}
static i32 token_check(u32 pid, u32 oid, u32 access) {
    NtObj *o = obj(oid);
    if (!o) return -1;
    if (o->owner_pid == pid) return 0;
    if (o->dacl & DACL_PUBLIC) return 0;
    if (k_access_check(k_token_of(pid), oid, access) == 0) return 0;
    return -5;
}
i32 k_handle_open(u32 pid, u32 oid, u32 access) {
    u32 i;
    NtObj *o = obj(oid);
    if (pid >= NT_MAX_PID || !o) return -1;
    if (token_check(pid, oid, access) != 0) return -5;      /* STATUS_ACCESS_DENIED */
    for (i = 0; i < NT_MAX_HANDLE; i++) {
        if (!HANDLES[pid][i].used) {
            HANDLES[pid][i].used = 1;
            HANDLES[pid][i].obj = oid;
            HANDLES[pid][i].access = access;
            k_obj_ref(oid);
            handle_total++;
            return (i32)(i + 1);
        }
    }
    return -2;
}
i32 k_handle_close(u32 pid, i32 h) {
    if (pid >= NT_MAX_PID || h < 1 || h > (i32)NT_MAX_HANDLE) return -1;
    if (!HANDLES[pid][h - 1].used) return -1;
    k_obj_deref(HANDLES[pid][h - 1].obj);
    z(&HANDLES[pid][h - 1], sizeof(NtHandle));
    if (handle_total) handle_total--;
    return 0;
}
i32 k_handle_dup(u32 pid, i32 h, u32 access) {
    if (pid >= NT_MAX_PID || h < 1 || h > (i32)NT_MAX_HANDLE) return -1;
    if (!HANDLES[pid][h - 1].used) return -1;
    if (access == 0) access = HANDLES[pid][h - 1].access;
    return k_handle_open(pid, HANDLES[pid][h - 1].obj, access);
}
i32 k_handle_obj(u32 pid, i32 h) {
    if (pid >= NT_MAX_PID || h < 1 || h > (i32)NT_MAX_HANDLE) return -1;
    return HANDLES[pid][h - 1].used ? (i32)HANDLES[pid][h - 1].obj : -1;
}
u32 k_handle_access(u32 pid, i32 h) {
    if (pid >= NT_MAX_PID || h < 1 || h > (i32)NT_MAX_HANDLE) return 0;
    return HANDLES[pid][h - 1].used ? HANDLES[pid][h - 1].access : 0;
}

/* --------------------------------------------------------------- security */
typedef struct { u32 used, sid, privileged; } NtToken;
static NtToken TOKENS[NT_MAX_PID + 16];
static u32 PID_TOKEN[NT_MAX_PID];
static u32 access_checks, access_denies;

u32 k_token_create(u32 sid, u32 privileged) {
    u32 i;
    for (i = 1; i < NT_MAX_PID + 16; i++) {
        if (!TOKENS[i].used) {
            TOKENS[i].used = 1; TOKENS[i].sid = sid; TOKENS[i].privileged = privileged ? 1 : 0;
            return i;
        }
    }
    return 0;
}
u32 k_token_of(u32 pid) { return (pid < NT_MAX_PID) ? PID_TOKEN[pid] : 0; }
i32 k_token_set(u32 pid, u32 tok) {
    if (pid >= NT_MAX_PID || tok >= NT_MAX_PID + 16 || !TOKENS[tok].used) return -1;
    PID_TOKEN[pid] = tok;
    return 0;
}
u32 k_sid_of(u32 tok) { return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].sid : 0; }
u32 k_privileged_of(u32 tok) { return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].privileged : 0; }

i32 k_access_check(u32 tok, u32 oid, u32 access) {
    NtObj *o = obj(oid);
    u32 granted;
    access_checks++;
    if (!o) { access_denies++; return -1; }
    if (o->dacl & DACL_PUBLIC) return 0;
    if (tok && TOKENS[tok].used && TOKENS[tok].privileged) return 0;    /* SeDebugPrivilege-like */
    if (o->dacl & DACL_SYSTEM_ONLY) {
        access_denies++;
        return -5;
    }
    granted = o->dacl & ACCESS_ALL;
    if (o->owner_pid && tok && TOKENS[tok].used && TOKENS[tok].sid == 3000u) granted |= ACCESS_READ | ACCESS_WRITE;
    if ((granted & access) == access) return 0;
    access_denies++;
    return -5;
}

/* ---------------------------------------------------------------- threads */
typedef struct {
    u32 used, id, pid, state, prio, base, quantum, quantum_left, boost, aging;
    u32 cpu_us, waits, wait_obj, wait_deadline, wait_started, alertable, apc_pending;
    u32 name_off, name_len, ready_next, started;
} NtThread;
static NtThread TH[NT_MAX_THREAD];
static u32 ready_head[NT_PRIO], ready_tail[NT_PRIO], ready_bitmap, thread_count;
static u32 tid_seq = 1, cur_tid, switch_count, boost_count, aging_count, wait_timeouts, boost_decay;
static u32 waits_total, mutants_held, irql_violations;

static NtThread *th(u32 id) { return (id && id < NT_MAX_THREAD && TH[id].used) ? &TH[id] : 0; }

static void ready_push(NtThread *t) {
    u32 p = t->prio & (NT_PRIO - 1);
    t->ready_next = 0;
    t->state = TH_READY;
    if (ready_tail[p]) TH[ready_tail[p]].ready_next = t->id;
    else ready_head[p] = t->id;
    ready_tail[p] = t->id;
    ready_bitmap |= (1u << p);
}
static void ready_remove(u32 tid) {
    NtThread *t = th(tid);
    u32 p, prev = 0, cur;
    if (!t) return;
    p = t->prio & (NT_PRIO - 1);
    cur = ready_head[p];
    while (cur) {
        if (cur == tid) {
            if (prev) TH[prev].ready_next = t->ready_next;
            else ready_head[p] = t->ready_next;
            if (ready_tail[p] == tid) ready_tail[p] = prev;
            t->ready_next = 0;
            if (!ready_head[p]) ready_bitmap &= ~(1u << p);
            return;
        }
        prev = cur;
        cur = TH[cur].ready_next;
    }
}
static u32 ready_depth(void) {
    u32 p, n = 0;
    for (p = 0; p < NT_PRIO; p++) {
        u32 c = ready_head[p];
        while (c) { n++; c = TH[c].ready_next; }
    }
    return n;
}
u32 k_thread_ready_index(u32 level) {
    return (level < NT_PRIO) ? ready_head[level] : 0;
}
u32 k_thread_first(void) { return cur_tid; }

u32 k_thread_create(u32 pid, u32 priority, u32 name_ptr, u32 name_len) {
    u32 i;
    if (priority >= NT_PRIO) priority = NT_PRIO - 1;
    for (i = 1; i < NT_MAX_THREAD; i++) {
        if (!TH[i].used) {
            NtThread *t = &TH[i];
            z(t, sizeof(NtThread));
            t->used = 1;
            t->id = i;
            t->pid = pid;
            t->prio = priority;
            t->base = priority;
            t->quantum = 10;
            t->quantum_left = 10;
            t->state = TH_READY;
            t->name_off = name_len ? name_store(name_ptr, name_len) : 0;
            t->name_len = name_len ? (name_len > 63u ? 63u : name_len) : 0;
            thread_count++;
            ready_push(t);
            if (!cur_tid) cur_tid = i;
            return i;
        }
    }
    return 0;
}
i32 k_thread_terminate(u32 tid) {
    NtThread *t = th(tid);
    if (!t) return -1;
    if (t->state == TH_READY) ready_remove(tid);
    if (t->wait_obj && t->wait_obj < NT_MAX_OBJ) {
        NtObj *o = obj(t->wait_obj);
        u32 k, j;
        if (o) {
            for (k = 0; k < o->wait_count; k++) {
                if (o->waiters[k] == tid) {
                    for (j = k; j + 1 < o->wait_count; j++) o->waiters[j] = o->waiters[j + 1];
                    o->wait_count--;
                    break;
                }
            }
        }
    }
    if (mutants_held && t->wait_obj == 0) { /* owner bookkeeping is per mutant */ }
    z(t, sizeof(NtThread));
    if (thread_count) thread_count--;
    if (cur_tid == tid) cur_tid = 0;
    return 0;
}
u32 k_thread_count(void) { return thread_count; }
u32 k_thread_field(u32 tid, u32 f) {
    NtThread *t = th(tid);
    if (!t) return 0;
    switch (f) {
        case 0: return t->pid;
        case 1: return t->state;
        case 2: return t->prio;
        case 3: return t->base;
        case 4: return t->cpu_us;
        case 5: return t->waits;
        case 6: return t->wait_obj;
        case 7: return t->quantum;
        case 8: return t->id;
        case 9: return t->boost;
        default: return 0;
    }
}
i32 k_thread_set_priority(u32 tid, u32 prio) {
    NtThread *t = th(tid);
    if (!t || prio >= NT_PRIO) return -1;
    if (t->state == TH_READY) ready_remove(tid);
    t->prio = prio;
    t->base = prio;
    if (t->state == TH_READY) ready_push(t);
    return 0;
}
i32 k_thread_boost(u32 tid, u32 amount) {
    NtThread *t = th(tid);
    if (!t) return -1;
    if (t->prio + amount >= NT_PRIO) amount = NT_PRIO - 1 - t->prio;
    if (!amount) return 0;
    if (t->state == TH_READY) ready_remove(tid);
    t->prio += amount;
    t->boost += amount;
    boost_count++;
    if (t->state == TH_READY) ready_push(t);
    return (i32)t->prio;
}
i32 k_thread_alert(u32 tid) {
    NtThread *t = th(tid);
    if (!t) return -1;
    t->alertable = 1;
    return 0;
}

/* ------------------------------------------------- waiting on dispatchers */
static void wait_add(NtObj *o, u32 tid) {
    u32 i, p = TH[tid].prio;
    for (i = 0; i < o->wait_count; i++) if (TH[o->waiters[i]].prio < p) break;
    if (o->wait_count < NT_PRIO) {
        u32 j;
        for (j = o->wait_count; j > i; j--) o->waiters[j] = o->waiters[j - 1];
        o->waiters[i] = tid;
        o->wait_count++;
    }
    TH[tid].state = TH_WAIT;
    TH[tid].wait_obj = 0;
}
static void wait_remove_at(NtObj *o, u32 idx) {
    u32 j;
    for (j = idx; j + 1 < o->wait_count; j++) o->waiters[j] = o->waiters[j + 1];
    if (o->wait_count) o->wait_count--;
}

i32 k_thread_wait(u32 tid, u32 oid, u32 timeout_ms, u32 alertable) {
    NtThread *t = th(tid);
    NtObj *o = obj(oid);
    if (!t) return -1;
    if (k_irql() >= IRQL_DISPATCH && timeout_ms) { /* waiting at raised IRQL is illegal */
        irql_violations++;
        return (i32)ST_INVALID_DEVICE_REQ;
    }
    if (!o) { t->state = TH_READY; if (t->state == TH_READY) ready_push(t); return ST_INVALID_PARAM; }
    if (alertable) t->alertable = 1;
    t->waits++;
    waits_total++;
    /* already signalled? */
    if (k_obj_wait_test(oid, tid) == 0) return ST_SUCCESS;
    wait_add(o, tid);
    t->wait_obj = oid;
    t->wait_deadline = timeout_ms ? (t->wait_started + timeout_ms) : 0;
    return ST_PARTIAL_COPY;      /* STATUS_TIMEOUT-ish: still waiting */
}

i32 k_obj_wait_test(u32 oid, u32 tid) {
    NtObj *o = obj(oid);
    if (!o) return ST_INVALID_PARAM;
    switch (o->type) {
        case OT_EVENT:
            if (!o->dstate) return ST_PARTIAL_COPY;
            if (!o->dmanual) o->dstate = 0;
            return ST_SUCCESS;
        case OT_MUTANT:
            if (o->dstate == 0) {
                o->dstate = 1;
                o->downer = tid;
                o->dcount = 1;
                mutants_held++;
                return ST_SUCCESS;
            }
            if (o->downer == tid) { o->dcount++; return ST_SUCCESS; }
            /* priority inheritance: the holder runs at the waiter's priority */
            if (th(o->downer) && th(tid) && th(o->downer)->prio < th(tid)->prio) {
                k_thread_boost(o->downer, th(tid)->prio - th(o->downer)->prio);
            }
            return ST_PARTIAL_COPY;
        case OT_SEMAPHORE:
            if (!o->dcount) return ST_PARTIAL_COPY;
            o->dcount--;
            return ST_SUCCESS;
        default:
            return o->dstate ? ST_SUCCESS : ST_PARTIAL_COPY;
    }
}

static u32 wake_obj(NtObj *o, u32 count) {
    u32 woke = 0;
    while (o->wait_count && woke < count) {
        u32 tid = o->waiters[0];
        NtThread *t = th(tid);
        wait_remove_at(o, 0);
        if (!t) continue;
        t->wait_obj = 0;
        t->wait_deadline = 0;
        ready_push(t);
        woke++;
        if (o->type == OT_MUTANT) {                    /* ownership transfers to the waiter */
            o->downer = tid;
            o->dstate = 1;
            o->dcount = 1;
            mutants_held++;
            break;
        }
        if (o->type == OT_SEMAPHORE && o->dcount) o->dcount--;
    }
    return woke;
}

i32 k_obj_signal(u32 oid) {
    NtObj *o = obj(oid);
    if (!o) return ST_INVALID_PARAM;
    o->dstate = 1;
    o->dsignals++;
    switch (o->type) {
        case OT_SEMAPHORE: return (i32)wake_obj(o, o->dcount ? o->dcount : 1);
        case OT_EVENT: {
            u32 woke = wake_obj(o, o->dmanual ? o->wait_count : 1);
            if (!o->dmanual && woke) o->dstate = 0;    /* auto-reset: consumed by the waiter */
            return (i32)woke;
        }
        case OT_MUTANT:    return (i32)wake_obj(o, 1);
        default:           return (i32)wake_obj(o, 1);
    }
}
u32 k_wait_count(u32 oid) { NtObj *o = obj(oid); return o ? o->wait_count : 0; }

u32 k_event_create(u32 manual_reset, u32 initial) {
    u32 id = k_obj_create(OT_EVENT, 0, 0, DACL_PUBLIC);
    if (id) { OBJ[id].dmanual = manual_reset ? 1 : 0; OBJ[id].dstate = initial ? 1 : 0; }
    return id;
}
i32 k_event_set(u32 ev) { return k_obj_signal(ev); }
i32 k_event_reset(u32 ev) { NtObj *o = obj(ev); if (!o || o->type != OT_EVENT) return -1; o->dstate = 0; return 0; }

u32 k_mutant_create(u32 owner_tid) {
    u32 id = k_obj_create(OT_MUTANT, 0, 0, DACL_PUBLIC);
    if (id && owner_tid) { OBJ[id].dstate = 1; OBJ[id].downer = owner_tid; OBJ[id].dcount = 1; mutants_held++; }
    return id;
}
i32 k_mutant_release(u32 m, u32 tid) {
    NtObj *o = obj(m);
    if (!o || o->type != OT_MUTANT) return -1;
    if (o->dstate && o->downer != tid && tid) return -5;
    if (o->dcount > 1) { o->dcount--; return 0; }
    o->dcount = 0;
    o->dstate = 0;
    o->downer = 0;
    if (mutants_held) mutants_held--;
    return (i32)wake_obj(o, 1);
}
u32 k_semaphore_create(u32 initial, u32 limit) {
    u32 id = k_obj_create(OT_SEMAPHORE, 0, 0, DACL_PUBLIC);
    if (id) { OBJ[id].dcount = initial; OBJ[id].dlimit = limit ? limit : 0xFFFFFFFFu; OBJ[id].dstate = initial ? 1 : 0; }
    return id;
}
i32 k_semaphore_release(u32 s, u32 count) {
    NtObj *o = obj(s);
    if (!o || o->type != OT_SEMAPHORE) return -1;
    if (o->dcount + count > o->dlimit) return ST_INVALID_PARAM;
    o->dcount += count;
    o->dstate = 1;
    return (i32)wake_obj(o, count);
}

/* -------------------------------------------------------- IRQL, DPC, APC */
static u32 irql, irql_before[16], irql_sp;

u32 k_irql(void) { return irql; }
u32 k_irql_raise(u32 level) {
    u32 prev = irql;
    if (level > IRQL_HIGH) level = IRQL_HIGH;
    if (irql_sp < 16) irql_before[irql_sp++] = irql;
    if (level > irql) irql = level;
    return prev;
}
u32 k_irql_lower(u32 level) {
    u32 prev = irql;
    if (irql_sp) irql = irql_before[--irql_sp];
    else irql = level;
    if (irql > IRQL_HIGH) irql = IRQL_HIGH;
    return prev;
}
u32 k_irql_violations(void) { return irql_violations; }

typedef struct { u32 used, proc_id, data, ticks; } NtDeferred;
static NtDeferred DPC[NT_MAX_DPC], APC[NT_MAX_APC];
static u32 dip, aip, dpc_queued, dpc_drained, apc_queued, apc_delivered;
static u32 apc_ready[NT_MAX_APC], apc_rh, apc_rt;

i32 k_dpc_queue(u32 proc_id, u32 data) {
    u32 i;
    for (i = 0; i < NT_MAX_DPC; i++) {
        if (!DPC[i].used) {
            DPC[i].used = 1; DPC[i].proc_id = proc_id; DPC[i].data = data; DPC[i].ticks = 0;
            dip++;
            dpc_queued++;
            return (i32)(i + 1);
        }
    }
    return -2;
}
u32 k_dpc_drained(void) { return dpc_drained; }
i32 k_apc_queue(u32 tid, u32 proc_id, u32 data, u32 user_mode) {
    u32 i;
    for (i = 0; i < NT_MAX_APC; i++) {
        if (!APC[i].used) {
            APC[i].used = 1; APC[i].proc_id = proc_id; APC[i].data = (user_mode ? 0x10000u : 0u) | (data & 0xFFFFu);
            APC[i].ticks = tid;
            aip++;
            apc_queued++;
            if (th(tid)) th(tid)->apc_pending++;
            return (i32)(i + 1);
        }
    }
    return -2;
}
u32 k_apc_pending(void) {
    u32 i, n = 0;
    for (i = 0; i < NT_MAX_APC; i++) if (APC[i].used) n++;
    return n;
}
u32 k_apc_pop(void) {
    if (apc_rh == apc_rt) return 0;
    {
        u32 v = apc_ready[apc_rh];
        apc_rh = (apc_rh + 1u) % NT_MAX_APC;
        return v;
    }
}

/* the executive heartbeat: DPC drain at DISPATCH_LEVEL, APC delivery,
   scheduler accounting, wait timeouts and starvation aging. */
static u32 last_tick_ms;
u32 nt_tick(u32 now_ms, u32 dt_ms) {
    u32 i, ran = 0, prev_irql;
    if (k_bugcheck_state(5)) return 0;                 /* halted: nothing runs */
    if (now_ms < last_tick_ms) now_ms = last_tick_ms;
    last_tick_ms = now_ms;

    /* 1. DPCs drain at DISPATCH_LEVEL */
    prev_irql = k_irql_raise(IRQL_DISPATCH);
    for (i = 0; i < NT_MAX_DPC; i++) {
        if (DPC[i].used) {
            DPC[i].used = 0;
            dpc_drained++;
            if (dip) dip--;
        }
    }
    (void)prev_irql;

    /* 2. APC delivery: a pending APC reaches an alertable thread */
    for (i = 0; i < NT_MAX_APC; i++) {
        if (!APC[i].used) continue;
        {
            NtThread *t = th(APC[i].ticks);
            if (t && t->alertable) {
                u32 packed = (APC[i].ticks << 8) | (APC[i].proc_id & 0xFFu);
                if ((apc_rt + 1u) % NT_MAX_APC != apc_rh) {
                    apc_ready[apc_rt] = packed;
                    apc_rt = (apc_rt + 1u) % NT_MAX_APC;
                }
                if (t->apc_pending) t->apc_pending--;
                t->alertable = 0;
                APC[i].used = 0;
                apc_delivered++;
                if (aip) aip--;
            }
        }
    }
    k_irql_lower(IRQL_PASSIVE);

    /* 3. wait timeouts and aging */
    for (i = 1; i < NT_MAX_THREAD; i++) {
        NtThread *t = &TH[i];
        if (!t->used || t->state != TH_WAIT) continue;
        if (t->aging > 8) {                       /* starving: boost it */
            aging_count++;
            k_thread_boost(i, 1);
            t->aging = 0;
        }
        if (t->wait_obj && t->wait_deadline && now_ms >= t->wait_deadline) {
            u32 oid = t->wait_obj;
            NtObj *o = obj(oid);
            if (o) {
                u32 k;
                for (k = 0; k < o->wait_count; k++) if (o->waiters[k] == i) { wait_remove_at(o, k); break; }
            }
            t->wait_obj = 0;
            t->wait_deadline = 0;
            wait_timeouts++;
            ready_push(t);
        }
    }

    /* 4. round-robin the highest ready priority */
    if (ready_bitmap) {
        u32 p;
        for (p = NT_PRIO - 1; p < NT_PRIO; p--) {
            NtThread *t;
            if (!(ready_bitmap & (1u << p))) continue;
            for (i = 0; i < NT_MAX_THREAD; i++) {
                if (TH[i].used && TH[i].state == TH_WAIT) TH[i].aging++;
            }
            t = th(ready_head[p]);
            if (t) {
                if (cur_tid && th(cur_tid) && th(cur_tid)->state == TH_RUN) th(cur_tid)->state = TH_READY;
                t->state = TH_RUN;
                t->quantum_left = t->quantum;
                if (cur_tid != t->id) switch_count++;
                cur_tid = t->id;
                /* charge the elapsed slice to every running thread of that process */
                t->cpu_us += dt_ms * 1000u;
                /* decay boosts so a boosted thread falls back to its base priority */
                if (t->prio > t->base && ((++boost_decay & 3u) == 0u)) {
                    t->prio--;
                    t->boost = t->prio - t->base;
                }
                ran = 1;
            }
            break;
        }
    }
    return ran;
}

/* ============================================================================
   Part 2: I/O manager (drivers, devices, IRPs), memory manager, the registry
   hive with transactions, bugcheck, counters and the integration hooks.
   ========================================================================== */

/* ------------------------------------------------------- drivers/devices */
typedef struct { u32 used, id, dispatch_id, flags, name_off, name_len, irps_created, irps_failed, oid; } NtDriver;
typedef struct { u32 used, id, driver, type, lower, depth, queue_depth, name_off, name_len, irp_total, oid; } NtDevice;
typedef struct {
    u32 used, id, dev, current_dev, major, minor, status, bytes, in_len, out_len;
    u32 depth, completed, cancelled, retried, owner_pid;
    u32 stack[8];
} NtIrp;

static NtDriver DRV[NT_MAX_DRIVER];
static NtDevice DEV[NT_MAX_DEVICE];
static NtIrp IRP[NT_MAX_IRP];
static u32 io_created, io_completed, io_failed, io_overflow, io_cancelled, io_queued;

static NtDriver *drv(u32 id) { return (id && id < NT_MAX_DRIVER && DRV[id].used) ? &DRV[id] : 0; }
static NtDevice *dev(u32 id) { return (id && id < NT_MAX_DEVICE && DEV[id].used) ? &DEV[id] : 0; }
static NtIrp *irp(u32 id) { return (id && id < NT_MAX_IRP && IRP[id].used) ? &IRP[id] : 0; }

u32 k_driver_create(u32 name_ptr, u32 name_len, u32 dispatch_id, u32 flags) {
    u32 i, oid;
    for (i = 1; i < NT_MAX_DRIVER; i++) {
        if (!DRV[i].used) {
            DRV[i].used = 1; DRV[i].id = i; DRV[i].dispatch_id = dispatch_id; DRV[i].flags = flags;
            DRV[i].name_off = name_len ? name_store(name_ptr, name_len) : 0;
            DRV[i].name_len = name_len ? (name_len > 63u ? 63u : name_len) : 0;
            oid = k_obj_create(OT_DRIVER, name_ptr, name_len, DACL_SYSTEM_ONLY | ACCESS_ALL);
            DRV[i].oid = oid;
            return i;                      /* the driver slot, not the object id */
        }
    }
    return 0;
}
u32 k_device_create(u32 driver, u32 name_ptr, u32 name_len, u32 type) {
    u32 i, oid;
    if (!drv(driver)) return 0;
    for (i = 1; i < NT_MAX_DEVICE; i++) {
        if (!DEV[i].used) {
            DEV[i].used = 1; DEV[i].id = i; DEV[i].driver = driver; DEV[i].type = type ? type : 1;
            DEV[i].name_off = name_len ? name_store(name_ptr, name_len) : 0;
            DEV[i].name_len = name_len ? (name_len > 63u ? 63u : name_len) : 0;
            oid = k_obj_create(OT_DEVICE, name_ptr, name_len, DACL_SYSTEM_ONLY | ACCESS_ALL);
            DEV[i].oid = oid;
            return i;                      /* the device slot */
        }
    }
    return 0;
}
static void device_depths(void) {          /* recompute every stack depth */
    u32 i, pass;
    for (pass = 0; pass < NT_MAX_DEVICE; pass++) {
        int changed = 0;
        for (i = 1; i < NT_MAX_DEVICE; i++) {
            u32 want;
            if (!DEV[i].used) continue;
            want = DEV[i].lower ? DEV[DEV[i].lower].depth + 1u : 0u;
            if (want > 11u) want = 11u;
            if (want != DEV[i].depth) { DEV[i].depth = want; changed = 1; }
        }
        if (!changed) break;
    }
}
i32 k_devices_link(u32 device, u32 lower_device) {
    NtDevice *d = dev(device);
    NtDevice *l = dev(lower_device);
    u32 walk, guard = 0;
    if (!d || !l || device == lower_device) return -1;
    walk = lower_device;
    while (walk) {                                   /* refuse to build a cycle */
        if (walk == device) return -1;
        if (++guard > NT_MAX_DEVICE) return -1;
        walk = DEV[walk].lower;
    }
    d->lower = lower_device;
    device_depths();
    if (d->depth > 11) { d->depth = 11; return -2; }  /* stack too deep to attach */
    return 0;
}
u32 k_driver_field(u32 id, u32 f) {
    NtDriver *d = drv(id);
    if (!d) return 0;
    switch (f) {
        case 0: return d->dispatch_id;
        case 1: return d->irps_created;
        case 2: return d->irps_failed;
        case 3: return d->name_off ? (u32)(NAMES + d->name_off) : 0;
        case 4: return d->name_len;
        case 5: return d->oid;
        default: return d->flags;
    }
}
u32 k_device_field(u32 id, u32 f) {
    NtDevice *d = dev(id);
    if (!d) return 0;
    switch (f) {
        case 0: return d->driver;
        case 1: return d->type;
        case 2: return d->lower;
        case 3: return d->depth;
        case 4: return d->queue_depth;
        case 5: return d->irp_total;
        case 6: return d->name_off ? (u32)(NAMES + d->name_off) : 0;
        case 7: return d->name_len;
        case 8: return d->oid;
        default: return 0;
    }
}
u32 k_irp_create(u32 device, u32 major, u32 minor, u32 in_len, u32 out_len) {
    u32 i;
    if (!dev(device)) return 0;
    for (i = 1; i < NT_MAX_IRP; i++) {
        if (!IRP[i].used) {
            NtIrp *r = &IRP[i];
            z(r, sizeof(NtIrp));
            r->used = 1; r->id = i; r->dev = device; r->current_dev = device;
            r->major = major; r->minor = minor; r->in_len = in_len; r->out_len = out_len;
            r->status = 0x00000103u;               /* STATUS_PENDING */
            io_created++;
            DRV[DEV[device].driver].irps_created++;
            DEV[device].irp_total++;
            return i;
        }
    }
    return 0;
}
static void irp_finish(NtIrp *r, u32 status) {
    r->status = status;
    r->completed = 1;
    r->bytes = (status == ST_SUCCESS) ? r->out_len : 0;
    io_completed++;
    if (status != ST_SUCCESS) {
        io_failed++;
        if (drv(DEV[r->dev].driver)) DRV[DEV[r->dev].driver].irps_failed++;
    }
    if (DEV[r->dev].queue_depth) DEV[r->dev].queue_depth--;
}
i32 k_io_call_driver(u32 id) {
    NtIrp *r = irp(id);
    u32 guard = 0;
    if (!r) return -1;
    if (r->completed) return (i32)r->status;
    while (guard++ < 16) {
        NtDevice *d = dev(r->current_dev);
        NtDriver *dr;
        if (!d) { irp_finish(r, ST_INVALID_PARAM); return -1; }
        dr = drv(d->driver);
        if (!dr) { irp_finish(r, ST_INVALID_DEVICE_REQ); return -1; }
        if (r->depth >= 8) {                   /* I/O stack overflow */
            io_overflow++;
            irp_finish(r, ST_INSUFFICIENT_RES);
            return (i32)r->status;
        }
        r->stack[r->depth++] = r->current_dev;
        switch (dr->dispatch_id) {
            case 1:  /* transport driver: completes immediately (VMBus, beep, ...) */
                irp_finish(r, r->cancelled ? ST_INVALID_DEVICE_REQ : ST_SUCCESS);
                return (i32)r->status;
            case 2:  /* filter driver: pass it down the device stack */
                if (d->lower) { r->current_dev = d->lower; continue; }
                irp_finish(r, ST_SUCCESS);
                return (i32)r->status;
            case 3:  /* driver that pends the IRP once, then fails it */
                if (!r->retried) {
                    r->retried = 1;
                    d->queue_depth++;
                    io_queued++;
                    return (i32)ST_MORE_PROCESSING;
                }
                irp_finish(r, ST_INVALID_DEVICE_REQ);
                return (i32)r->status;
            case 4:  /* cancelling driver */
                irp_finish(r, r->cancelled ? ST_INVALID_DEVICE_REQ : ST_SUCCESS);
                return (i32)r->status;
            default:
                irp_finish(r, ST_SUCCESS);
                return (i32)r->status;
        }
    }
    irp_finish(r, ST_INVALID_DEVICE_REQ);
    return -3;
}
u32 k_io_complete(u32 id, u32 status, u32 bytes) {
    NtIrp *r = irp(id);
    if (!r) return 0;
    if (r->completed) return r->status;
    irp_finish(r, status);
    r->bytes = bytes;
    return r->status;
}
u32 k_irp_field(u32 id, u32 f) {
    NtIrp *r = irp(id);
    if (!r) return 0;
    switch (f) {
        case 0: return r->status;
        case 1: return r->dev;
        case 2: return r->major;
        case 3: return r->minor;
        case 4: return r->in_len;
        case 5: return r->out_len;
        case 6: return r->depth;
        case 7: return r->completed;
        case 8: return r->bytes;
        case 9: return r->current_dev;
        default: return 0;
    }
}
u32 k_irp_queue_depth(u32 device) { NtDevice *d = dev(device); return d ? d->queue_depth : 0; }
u32 k_io_counts(u32 which) {
    switch (which) {
        case 0: return io_created;
        case 1: return io_completed;
        case 2: return io_failed;
        case 3: return io_overflow;
        case 4: return io_cancelled;
        default: return io_queued;
    }
}

/* -------------------------------------------------------- memory manager */
typedef struct { u32 used, vaddr, bytes, committed, protect, section; } NtRegion;
static NtRegion REG[NT_MAX_PID][NT_MAX_REGION];
static u32 VM_NEXT[NT_MAX_PID], PID_VSIZE[NT_MAX_PID], PID_COMMIT[NT_MAX_PID];
static u32 PID_WORKING[NT_MAX_PID], PID_FAULTS[NT_MAX_PID];
static u32 commit_charge, commit_limit = NT_COMMIT_LIMIT, commit_peak, commit_failures;
static u32 pool_paged, pool_paged_peak, pool_nonpaged, pool_np_peak;
static u32 hive_skips;                              /* oversized values not loaded */
static u32 pool_free_head;
static u8  POOL[NT_POOL_BYTES];
static u32 vm_regions_total;

typedef struct { u32 used, bytes, protect, refs, mappings, gpa; } NtSection;
static NtSection SEC[NT_MAX_SECTION];

u32 k_process_create(u32 name_ptr, u32 name_len, u32 token) {
    /* process creation itself lives in kernel.c; this wraps it with the
       executive state a Windows process owns */
    u32 pid, tid, objid, tok;
    extern u32 k_proc_create(u32, u32, u32);
    pid = k_proc_create(name_ptr, name_len, 0);
    if (!pid || pid >= NT_MAX_PID) return 0;
    tok = token ? token : k_token_create(1000u, 0);
    k_token_set(pid, tok);
    objid = k_obj_create(OT_PROCESS, name_ptr, name_len, DACL_PUBLIC);
    if (objid) OBJ[objid].owner_pid = pid;
    nt_on_proc_create(pid, name_ptr, name_len);
    tid = k_thread_create(pid, 8u, name_ptr, name_len);      /* main thread, normal */
    (void)objid; (void)tid;
    return pid;
}
i32 k_process_terminate(u32 pid) {
    extern i32 k_proc_destroy(u32);
    nt_on_proc_destroy(pid);
    return k_proc_destroy(pid);
}
static NtRegion *vm_find(u32 pid, u32 vaddr) {
    u32 i;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_REGION; i++) {
        NtRegion *r = &REG[pid][i];
        if (r->used && vaddr >= r->vaddr && vaddr < r->vaddr + r->bytes) return r;
    }
    return 0;
}
i32 k_vm_reserve(u32 pid, u32 bytes, u32 protect) {
    u32 i, vaddr;
    if (pid >= NT_MAX_PID || !bytes) return -1;
    bytes = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (!REG[pid][i].used) {
            if (!VM_NEXT[pid]) VM_NEXT[pid] = NT_VM_BASE;
            vaddr = VM_NEXT[pid];
            VM_NEXT[pid] += bytes;
            REG[pid][i].used = 1;
            REG[pid][i].vaddr = vaddr;
            REG[pid][i].bytes = bytes;
            REG[pid][i].protect = protect ? protect : ACCESS_READ | ACCESS_WRITE;
            PID_VSIZE[pid] += bytes;
            vm_regions_total++;
            return (i32)vaddr;
        }
    }
    return -2;
}
i32 k_vm_commit(u32 pid, u32 vaddr, u32 bytes) {
    NtRegion *r = vm_find(pid, vaddr);
    u32 charge;
    if (!r) return ST_INVALID_PARAM;
    charge = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
    if (charge > r->bytes) charge = r->bytes;
    if (commit_charge + charge > commit_limit) { commit_failures++; return ST_INSUFFICIENT_RES; }
    r->committed += charge;
    if (r->committed > r->bytes) r->committed = r->bytes;
    commit_charge += charge;
    if (commit_charge > commit_peak) commit_peak = commit_charge;
    PID_COMMIT[pid] += charge;
    return 0;
}
i32 k_vm_free(u32 pid, u32 vaddr, u32 bytes) {
    NtRegion *r = vm_find(pid, vaddr);
    u32 release;
    if (!r) return -1;
    release = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
    if (release > r->committed) release = r->committed;
    r->committed -= release;
    commit_charge = (commit_charge > release) ? commit_charge - release : 0;
    PID_COMMIT[pid] = (PID_COMMIT[pid] > release) ? PID_COMMIT[pid] - release : 0;
    if (PID_VSIZE[pid] >= r->bytes) PID_VSIZE[pid] -= r->bytes;
    if (vm_regions_total) vm_regions_total--;
    z(r, sizeof(NtRegion));
    return 0;
}
i32 k_vm_touch(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr);
    if (!r) { PID_FAULTS[pid]++; return ST_INVALID_PARAM; }
    if (!r->committed) PID_FAULTS[pid]++;          /* demand-zero page */
    PID_WORKING[pid] += NT_PAGE;
    return 0;
}
u32 k_vm_region_count(u32 pid) {
    u32 i, n = 0;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_REGION; i++) if (REG[pid][i].used) n++;
    return n;
}
u32 k_vm_region_vaddr(u32 pid, u32 idx) {
    u32 i, n = 0;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used) { if (n == idx) return REG[pid][i].vaddr; n++; }
    }
    return 0;
}
u32 k_vm_region_bytes(u32 pid, u32 idx) {
    u32 i, n = 0;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used) { if (n == idx) return REG[pid][i].bytes; n++; }
    }
    return 0;
}
u32 k_vm_field(u32 pid, u32 f) {
    if (pid >= NT_MAX_PID) return 0;
    switch (f) {
        case 0: return PID_VSIZE[pid];
        case 1: return PID_COMMIT[pid];
        case 2: return PID_WORKING[pid];
        case 3: return PID_FAULTS[pid];
        case 4: return k_vm_region_count(pid);
        default: return 0;
    }
}
u32 k_section_create(u32 bytes, u32 protect) {
    u32 i;
    for (i = 1; i < NT_MAX_SECTION; i++) {
        if (!SEC[i].used) {
            u32 oid;
            SEC[i].used = 1; SEC[i].bytes = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
            SEC[i].protect = protect ? protect : (ACCESS_READ | ACCESS_WRITE);
            SEC[i].refs = 1;
            oid = k_obj_create(OT_SECTION, 0, 0, DACL_PUBLIC);
            SEC[i].gpa = oid;
            return i;
        }
    }
    return 0;
}
i32 k_section_map(u32 pid, u32 sec, u32 vaddr) {
    u32 i;
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return -1;
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used && REG[pid][i].vaddr == vaddr) {
            if (REG[pid][i].section) return -2;
            REG[pid][i].section = sec;
            SEC[sec].mappings++;
            SEC[sec].refs++;
            return 0;
        }
    }
    return -3;
}
u32 k_section_field(u32 sec, u32 f) {
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return 0;
    switch (f) {
        case 0: return SEC[sec].bytes;
        case 1: return SEC[sec].protect;
        case 2: return SEC[sec].refs;
        case 3: return SEC[sec].mappings;
        default: return 0;
    }
}
u32 k_pool_alloc(u32 bytes, u32 paged, u32 tag) {
    u32 need = (bytes + 32u) & ~7u;
    (void)tag;
    if (paged && k_irql() >= IRQL_DISPATCH) {
        /* paged pool is not available at DISPATCH_LEVEL or above */
        irql_violations++;
        return 0;
    }
    if (pool_free_head + need > NT_POOL_BYTES) return 0;
    {
        u32 off = pool_free_head;
        pool_free_head += need;
        if (paged) {
            pool_paged += need;
            if (pool_paged > pool_paged_peak) pool_paged_peak = pool_paged;
        } else {
            pool_nonpaged += need;
            if (pool_nonpaged > pool_np_peak) pool_np_peak = pool_nonpaged;
        }
        return (u32)(POOL + off);
    }
}
u32 k_pool_field(u32 f) {
    switch (f) {
        case 0: return pool_paged;
        case 1: return pool_paged_peak;
        case 2: return pool_nonpaged;
        default: return pool_np_peak;
    }
}
u32 k_commit_field(u32 f) {
    switch (f) {
        case 0: return commit_charge;
        case 1: return commit_limit;
        case 2: return commit_peak;
        default: return commit_failures;
    }
}

/* --------------------------------------------------------- registry hive */
typedef struct { u32 used, parent, name_off, name_len, subkeys, values, in_tx; } NtKey;
typedef struct { u32 used, key, name_off, name_len, type, data_off, data_len; } NtValue;
typedef struct { u32 used, committed, count; } NtTx;
typedef struct { u32 used, tx, kind, key, val, old_type, old_off, old_len, existed, name_off, name_len; } NtUndo;

static NtKey   KEY[NT_MAX_KEY];
static NtValue VAL[NT_MAX_VALUE];
static NtTx    TX[NT_MAX_TX];
static NtUndo  UNDO[NT_MAX_UNDO];
static u32 reg_enum_name_off, reg_enum_name_len;
static u32 tx_committed, tx_rolledback, cur_tx;
static u32 reg_value_len, reg_value_type;

static NtKey *key(u32 id) { return (id && id < NT_MAX_KEY && KEY[id].used) ? &KEY[id] : 0; }
static void key_path_str(u32 id, char *out, u32 cap) {
    char stack[16][40];
    u32 depth = 0, i;
    NtKey *k = key(id);
    while (k && depth < 16) {
        cp(stack[depth], N(k->name_off), k->name_len > 39u ? 39u : k->name_len);
        stack[depth][k->name_len > 39u ? 39u : k->name_len] = 0;
        depth++;
        k = key(k->parent);
    }
    {
        u32 o = 0;
        for (i = depth; i-- > 0;) {
            u32 j = 0;
            while (stack[i][j] && o + 1 < cap) out[o++] = stack[i][j++];
            if (i && o + 1 < cap) out[o++] = '\\';
        }
        out[o] = 0;
    }
}
u32 k_reg2_root(u32 hive) { return (hive < 4) ? (hive + 1) : 0; }
u32 k_reg2_key_field(u32 id, u32 f) {
    NtKey *k = key(id);
    if (!k) return 0;
    switch (f) {
        case 0: return k->parent;
        case 1: return k->subkeys;
        case 2: return k->values;
        case 3: return k->name_len;
        default: return 0;
    }
}
u32 k_reg2_key_path(u32 id) {
    key_path_str(id, (char *)TMP, 260);
    tmp_len = sl((const char *)TMP);
    return (u32)TMP;
}
static u32 key_find_child(u32 parent, u32 name_ptr, u32 name_len) {
    u32 i;
    for (i = 1; i < NT_MAX_KEY; i++) {
        NtKey *k = &KEY[i];
        if (k->used && k->parent == parent && k->name_len == name_len &&
            cieq(N(k->name_off), (const char *)name_ptr, name_len)) return i;
    }
    return 0;
}
i32 k_reg2_create_key(u32 parent, u32 name_ptr, u32 name_len) {
    u32 i, id;
    if (name_len > 63u) return -1;
    if (!key(parent)) return -1;
    id = key_find_child(parent, name_ptr, name_len);
    if (id) return (i32)id;
    for (i = 1; i < NT_MAX_KEY; i++) {
        if (!KEY[i].used) {
            u32 off = name_store(name_ptr, name_len);
            if (!off) return -3;                       /* no room for the name */
            KEY[i].used = 1;
            KEY[i].parent = parent;
            KEY[i].name_off = off;
            KEY[i].name_len = name_len;
            KEY[parent].subkeys++;
            return (i32)i;
        }
    }
    return -2;
}
u32 k_reg2_open_key(u32 parent, u32 name_ptr, u32 name_len) {
    return key_find_child(parent, name_ptr, name_len);
}
static NtValue *val_find(u32 k, u32 name_ptr, u32 name_len) {
    u32 i;
    for (i = 1; i < NT_MAX_VALUE; i++) {
        NtValue *v = &VAL[i];
        if (v->used && v->key == k && v->name_len == name_len &&
            cieq(N(v->name_off), (const char *)name_ptr, name_len)) return v;
    }
    return 0;
}
u32 k_reg2_value_type(void) { return reg_value_type; }
u32 k_reg2_value_len(void) { return reg_value_len; }
u32 k_reg2_name_ptr(void) { return (u32)(NAMES + reg_enum_name_off); }
u32 k_reg2_name_len(void) { return reg_enum_name_len; }

static void tx_record(u32 k, NtValue *v, u32 name_ptr, u32 name_len) {
    u32 i;
    if (!cur_tx) return;
    for (i = 0; i < NT_MAX_UNDO; i++) {
        if (!UNDO[i].used) {
            UNDO[i].used = 1;
            UNDO[i].tx = cur_tx;
            UNDO[i].kind = 1;
            UNDO[i].key = k;
            UNDO[i].existed = v ? 1u : 0u;
            UNDO[i].old_type = v ? v->type : 0u;
            UNDO[i].old_off = v ? v->data_off : 0u;
            UNDO[i].old_len = v ? v->data_len : 0u;
            UNDO[i].name_off = name_store(name_ptr, name_len);
            UNDO[i].name_len = name_len;
            TX[cur_tx].count++;
            return;
        }
    }
}
i32 k_reg2_set_value(u32 k, u32 name_ptr, u32 name_len, u32 type, u32 data, u32 len) {
    NtValue *v;
    u32 off;
    if (!key(k) || name_len > 63u) return -1;
    v = val_find(k, name_ptr, name_len);
    tx_record(k, v, name_ptr, name_len);
    if (v && v->data_off && !pool_frozen) data_free(v->data_off, v->data_len);
    if (!v) {
        u32 i;
        for (i = 1; i < NT_MAX_VALUE; i++) if (!VAL[i].used) { v = &VAL[i]; break; }
        if (!v) return -2;
        z(v, sizeof(NtValue));
        v->used = 1;
        v->key = k;
        v->name_off = name_store(name_ptr, name_len);
        v->name_len = name_len;
        KEY[k].values++;
    }
    off = len ? data_store(data, len) : 0;
    if (len && !off) return -3;
    v->type = type ? type : 1u;
    v->data_off = off;
    v->data_len = len;
    return 0;
}
i32 k_reg2_set_dword(u32 k, u32 name_ptr, u32 name_len, u32 value) {
    u8 b[4];
    b[0] = (u8)(value & 0xFFu); b[1] = (u8)((value >> 8) & 0xFFu);
    b[2] = (u8)((value >> 16) & 0xFFu); b[3] = (u8)((value >> 24) & 0xFFu);
    return k_reg2_set_value(k, name_ptr, name_len, 4u, (u32)b, 4u);
}
i32 k_reg2_get_value(u32 k, u32 name_ptr, u32 name_len) {
    NtValue *v = val_find(k, name_ptr, name_len);
    if (!v) return -1;
    reg_value_type = v->type;
    reg_value_len = v->data_len;
    if (v->data_len) {
        if (v->data_len > 260u * 1024u) return -2;
        cp(TMP, DATA + v->data_off, v->data_len);
    }
    tmp_len = v->data_len;
    return (i32)v->data_len;
}
u32 k_reg2_enum_value(u32 k, u32 idx) {
    u32 i, n = 0;
    if (!key(k)) return 0;
    for (i = 1; i < NT_MAX_VALUE; i++) {
        NtValue *v = &VAL[i];
        if (v->used && v->key == k) {
            if (n == idx) {
                reg_enum_name_off = v->name_off;
                reg_enum_name_len = v->name_len;
                reg_value_type = v->type;
                reg_value_len = v->data_len;
                return 1;
            }
            n++;
        }
    }
    return 0;
}
u32 k_reg2_enum_key(u32 k, u32 idx) {
    u32 i, n = 0;
    if (!key(k)) return 0;
    for (i = 1; i < NT_MAX_KEY; i++) {
        NtKey *c = &KEY[i];
        if (c->used && c->parent == k) {
            if (n == idx) {
                reg_enum_name_off = c->name_off;
                reg_enum_name_len = c->name_len;
                return 1;
            }
            n++;
        }
    }
    return 0;
}
static void value_release(NtValue *v) {
    name_free(v->name_off, v->name_len);
    data_free(v->data_off, v->data_len);
    z(v, sizeof(NtValue));
}
static void key_delete_values(u32 k) {
    u32 i;
    for (i = 1; i < NT_MAX_VALUE; i++) {
        if (VAL[i].used && VAL[i].key == k) {
            value_release(&VAL[i]);
            if (KEY[k].values) KEY[k].values--;
        }
    }
}
i32 k_reg2_delete_key(u32 k) {
    NtKey *c = key(k);
    if (!c || k < 5) return -1;                       /* roots are permanent */
    if (c->subkeys) return (i32)ST_KEY_HAS_CHILDREN;  /* ERROR_KEY_HAS_CHILDREN */
    key_delete_values(k);
    if (KEY[c->parent].subkeys) KEY[c->parent].subkeys--;
    name_free(c->name_off, c->name_len);
    z(c, sizeof(NtKey));
    return 0;
}
u32 k_reg2_tx_begin(void) {
    u32 i;
    for (i = 1; i < NT_MAX_TX; i++) {
        if (!TX[i].used) {
            TX[i].used = 1; TX[i].committed = 0; TX[i].count = 0;
            cur_tx = i;
            pool_frozen++;                             /* no reuse until the tx settles */
            return i;
        }
    }
    return 0;
}
i32 k_reg2_tx_commit(u32 tx) {
    u32 i;
    if (tx >= NT_MAX_TX || !TX[tx].used) return -1;
    for (i = 0; i < NT_MAX_UNDO; i++) {
        if (UNDO[i].used && UNDO[i].tx == tx) {
            name_free(UNDO[i].name_off, UNDO[i].name_len);
            z(&UNDO[i], sizeof(NtUndo));
        }
    }
    TX[tx].used = 0;
    if (pool_frozen) pool_frozen--;
    tx_committed++;
    if (cur_tx == tx) cur_tx = 0;
    return 0;
}
i32 k_reg2_tx_rollback(u32 tx) {
    u32 i;
    if (tx >= NT_MAX_TX || !TX[tx].used) return -1;
    for (i = NT_MAX_UNDO; i-- > 0;) {
        if (UNDO[i].used && UNDO[i].tx == tx) {
            if (UNDO[i].existed) {
                NtValue *v = val_find(UNDO[i].key, (u32)(NAMES + UNDO[i].name_off), (u32)sl(N(UNDO[i].name_off)));
                if (v) {
                    v->type = UNDO[i].old_type;
                    v->data_off = UNDO[i].old_off;     /* still intact: the pool was frozen */
                    v->data_len = UNDO[i].old_len;
                }
            } else {
                u32 k2;
                for (k2 = 1; k2 < NT_MAX_VALUE; k2++) {
                    if (VAL[k2].used && VAL[k2].key == UNDO[i].key &&
                        VAL[k2].name_len == sl(N(UNDO[i].name_off)) &&
                        cieq(N(VAL[k2].name_off), N(UNDO[i].name_off), VAL[k2].name_len)) {
                        z(&VAL[k2], sizeof(NtValue));
                        if (KEY[UNDO[i].key].values) KEY[UNDO[i].key].values--;
                        break;
                    }
                }
            }
            name_free(UNDO[i].name_off, UNDO[i].name_len);
            z(&UNDO[i], sizeof(NtUndo));
        }
    }
    TX[tx].used = 0;
    if (pool_frozen) pool_frozen--;
    tx_rolledback++;
    if (cur_tx == tx) cur_tx = 0;
    return 0;
}
u32 k_reg2_stats(u32 which) {
    u32 i, keys = 0, vals = 0, depth = 0;
    for (i = 1; i < NT_MAX_KEY; i++) {
        if (KEY[i].used) {
            u32 d = 0, p = KEY[i].parent;
            keys++;
            while (p && d < 16) { d++; p = KEY[p].parent; }
            if (d > depth) depth = d;
        }
    }
    for (i = 1; i < NT_MAX_VALUE; i++) if (VAL[i].used) vals++;
    switch (which) {
        case 0: return keys;
        case 1: return vals;
        case 2: return depth;
        case 3: return tx_committed;
        default: return tx_rolledback;
    }
}

/* ------------------------------------- the legacy flat registry as a view */
static u32 flat_key(const char *path, u32 pl, u32 create) {
    char seg[64];
    u32 i = 0, cur = 0;
    while (i <= pl) {
        if (i == pl || path[i] == '\\') {
            if (seg[0] != 0 || cur == 0) {
                u32 root = 0;
                if (cur == 0) {
                    if (cieq(seg, "HKEY_LOCAL_MACHINE", sl(seg))) root = 1;
                    else if (cieq(seg, "HKEY_CURRENT_USER", sl(seg))) root = 2;
                    else if (cieq(seg, "HKEY_CLASSES_ROOT", sl(seg))) root = 3;
                    else if (cieq(seg, "HKEY_USERS", sl(seg))) root = 4;
                    else if (cieq(seg, "HKLM", sl(seg))) root = 1;
                    else if (cieq(seg, "HKCU", sl(seg))) root = 2;
                    else root = 2;                       /* default hive */
                    cur = k_reg2_root(root - 1u);
                } else {
                    u32 nxt = k_reg2_open_key(cur, (u32)seg, sl(seg));
                    if (!nxt) {
                        if (!create) return 0;
                        nxt = (u32)k_reg2_create_key(cur, (u32)seg, sl(seg));
                    }
                    if (!nxt) return 0;
                    cur = nxt;
                }
                seg[0] = 0;
            }
            i++;
            continue;
        }
        if (sl(seg) < 63u) { u32 l = sl(seg); seg[l] = path[i]; seg[l + 1] = 0; }
        i++;
    }
    return cur;
}
i32 nt_reg_set(u32 path, u32 pl, u32 name, u32 nl, u32 val, u32 vl) {
    u32 k = flat_key((const char *)path, pl, 1);
    if (!k) return -1;
    return k_reg2_set_value(k, name, nl, 1u, val, vl);
}
i32 nt_reg_get(u32 path, u32 pl, u32 name, u32 nl) {
    u32 k = flat_key((const char *)path, pl, 0);
    if (!k) return -1;
    return k_reg2_get_value(k, name, nl);
}
i32 nt_reg_del(u32 path, u32 pl, u32 name, u32 nl) {
    u32 k = flat_key((const char *)path, pl, 0);
    NtValue *v;
    if (!k) return -1;
    v = val_find(k, name, nl);
    if (!v) return -1;
    value_release(v);
    if (KEY[k].values) KEY[k].values--;
    return 0;
}
u32 nt_reg_count(void) { return k_reg2_stats(1u); }
u32 nt_reg_enum(u32 idx) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_VALUE; i++) {
        NtValue *v = &VAL[i];
        if (!v->used) continue;
        if (n == idx) {
            key_path_str(v->key, (char *)TMP + 1024, 260);
            reg_enum_name_off = v->name_off;
            reg_enum_name_len = v->name_len;
            reg_value_type = v->type;
            reg_value_len = v->data_len;
            if (v->data_len && v->data_len < 240u * 1024u) cp(TMP, DATA + v->data_off, v->data_len);
            tmp_len = v->data_len;
            return 1;
        }
        n++;
    }
    return 0;
}
u32 nt_reg_enum_path_ptr(void) { return (u32)TMP + 1024; }
u32 nt_reg_enum_path_len(void) { return sl((const char *)TMP + 1024); }
u32 nt_reg_enum_name_ptr(void) { return (u32)(NAMES + reg_enum_name_off); }
u32 nt_reg_enum_name_len(void) { return reg_enum_name_len; }
u32 nt_reg_enum_type(void) { return reg_value_type; }

u32 nt_reg_save(void) {
    u32 i, o = 0;
    u8 *b = TMP;
    const char *hdr = "KREG2\n";
    while (hdr[o]) { b[o] = (u8)hdr[o]; o++; }
    for (i = 1; i < NT_MAX_KEY; i++) {
        u32 j;
        if (!KEY[i].used || i < 5) continue;
        key_path_str(i, (char *)TMP + 2048, 260);
        for (j = 1; j < NT_MAX_VALUE; j++) {
            NtValue *v = &VAL[j];
            u32 p = 0;
            if (!v->used || v->key != i) continue;
            if (o + 4096u > 260u * 1024u) break;
            while (TMP[2048 + p] && o < 260u * 1024u) { TMP[o++] = TMP[2048 + p]; p++; }
            TMP[o++] = '\t';
            p = 0;
            while (NAMES[v->name_off + p]) { TMP[o++] = NAMES[v->name_off + p]; p++; }
            TMP[o++] = '\t';
            TMP[o++] = (u8)('0' + (v->type % 10u));
            TMP[o++] = '\t';
            if (v->data_len) {
                u32 enc = b64_enc(DATA + v->data_off, v->data_len, (char *)TMP + o);
                o += enc;
            }
            TMP[o++] = '\n';
        }
    }
    tmp_len = o;
    return o;
}
i32 nt_reg_load(u32 ptr, u32 len) {
    const char *p = (const char *)ptr, *end = p + len;
    u32 loaded = 0, v2 = 0, skipped = 0;
    if (len > 8u && p[4] == '2') v2 = 1;
    while (p < end && *p != '\n') p++;
    if (p < end) p++;
    while (p < end) {
        char path[260];
        char name[96];
        u32 pl = 0, nl = 0, type = 1u;
        while (p < end && *p != '\t' && *p != '\n' && pl < 259u) path[pl++] = *p++;
        path[pl] = 0;
        if (p < end && *p == '\t') p++;
        if (v2) {
            while (p < end && *p != '\t' && *p != '\n' && nl < 95u) name[nl++] = *p++;
            name[nl] = 0;
            if (p < end && *p == '\t') p++;
            if (p < end && *p >= '0' && *p <= '9') { type = (u32)(*p - '0'); p++; }
            if (p < end && *p == '\t') p++;
        } else {
            while (p < end && *p != '\n' && nl < 95u) name[nl++] = *p++;
            name[nl] = 0;
        }
        {
            const char *d0 = p;
            u32 dl, key;
            static u8 tmpbuf[NT_DATA_POOL > 8u * 1024u ? 8u * 1024u : NT_DATA_POOL];
            while (p < end && *p != '\n') p++;
            dl = (u32)(p - d0);
            if (p < end) p++;
            if (!pl) continue;
            key = flat_key(path, pl, 1);
            if (!key) continue;
            /* a value is only decoded when it fits: base64 is 4 chars for every
               3 bytes, and an unchecked decode would run past the buffer and
               take the caller's stack with it. */
            if (dl && (dl / 4u) * 3u + 4u > sizeof(tmpbuf)) {
                skipped++;
                if (p < end) continue;
            }
            if (dl) {
                u32 got = b64_dec(d0, dl, tmpbuf);
                if (got > sizeof(tmpbuf)) got = sizeof(tmpbuf);
                k_reg2_set_value(key, (u32)name, nl, type, (u32)tmpbuf, got);
            } else {
                k_reg2_set_value(key, (u32)name, nl, type, 0, 0);
            }
            loaded++;
        }
    }
    hive_skips += skipped;                          /* reported by nt_stat */
    return (i32)loaded;
}
/* --------------------------------------------------------------- VMBus I/O
   The shell relays a message to a partition's VMBus channel through the
   kernel's own I/O manager: an IRP is built for the VMBus device, dispatched
   to the transport driver and completed, so the counters in Task Manager and
   the hypervisor's channel both see the traffic. */
static u32 vmbus_tx_count, vmbus_tx_bytes;
u32 k_vmbus_tx(u32 bytes) {
    u32 dev_id = 0, i, id, st;
    for (i = 1; i < NT_MAX_DEVICE; i++) {
        if (DEV[i].used && DEV[i].type == 1u) { dev_id = i; break; }   /* the transport */
    }
    if (!dev_id) return ST_INVALID_DEVICE_REQ;
    id = k_irp_create(dev_id, 0x0Fu /* IRP_MJ_INTERNAL_DEVICE_CONTROL */, 0, 0, bytes);
    if (!id) return ST_INSUFFICIENT_RES;
    st = (u32)k_io_call_driver(id);
    if (st == ST_SUCCESS) { vmbus_tx_count++; vmbus_tx_bytes += bytes; }
    return st;
}
u32 k_vmbus_stats(u32 which) {
    switch (which) {
        case 0: return vmbus_tx_count;
        case 1: return vmbus_tx_bytes;
        default: return vmbus_tx_count ? (vmbus_tx_bytes / vmbus_tx_count) : 0u;
    }
}

/* -------------------------------------------------------------- bugcheck */
static u32 bc_code, bc_params[4], bc_halted, bc_count;
static u8  BC_DUMP[2048];
static u32 bc_dump_len;

typedef struct { char *b; u32 n; u32 cap; } BStr;
static void bs_put(BStr *s, const char *t) { while (*t && s->n + 1 < s->cap) s->b[s->n++] = *t++; s->b[s->n] = 0; }
static void bs_num(BStr *s, u32 v) {
    char t[12]; u32 i = 0;
    if (!v) { bs_put(s, "0"); return; }
    while (v && i < 11) { t[i++] = (char)('0' + v % 10u); v /= 10u; }
    while (i && s->n + 1 < s->cap) s->b[s->n++] = t[--i];
    s->b[s->n] = 0;
}
static void bs_hex(BStr *s, u32 v) {
    const char *h = "0123456789ABCDEF";
    char t[9]; u32 i;
    for (i = 0; i < 8; i++) t[i] = h[(v >> ((7u - i) * 4u)) & 0xFu];
    t[8] = 0;
    bs_put(s, t);
}
u32 k_bugcheck(u32 code, u32 p1, u32 p2, u32 p3, u32 p4) {
    BStr s;
    u32 i;
    bc_code = code;
    bc_params[0] = p1; bc_params[1] = p2; bc_params[2] = p3; bc_params[3] = p4;
    bc_halted = 1;
    bc_count++;
    bc_dump_len = 0;
    s.b = (char *)BC_DUMP; s.n = 0; s.cap = sizeof(BC_DUMP) - 1;
    BC_DUMP[0] = 0;
    bs_put(&s, "*** STOP: 0x");
    bs_hex(&s, code);
    bs_put(&s, " (0x"); bs_hex(&s, p1);
    bs_put(&s, ", 0x"); bs_hex(&s, p2);
    bs_put(&s, ", 0x"); bs_hex(&s, p3);
    bs_put(&s, ", 0x"); bs_hex(&s, p4);
    bs_put(&s, ")\n\nLoaded drivers:\n");
    for (i = 1; i < NT_MAX_DRIVER; i++) {
        if (DRV[i].used) {
            bs_put(&s, "  ");
            bs_put(&s, N(DRV[i].name_off));
            bs_put(&s, "  irps=");
            bs_num(&s, DRV[i].irps_created);
            bs_put(&s, " failed=");
            bs_num(&s, DRV[i].irps_failed);
            bs_put(&s, "\n");
        }
    }
    bs_put(&s, "\nDevice stack:\n");
    for (i = 1; i < NT_MAX_DEVICE; i++) {
        if (DEV[i].used) {
            bs_put(&s, "  ");
            bs_put(&s, N(DEV[i].name_off));
            bs_put(&s, "  depth=");
            bs_num(&s, DEV[i].depth);
            bs_put(&s, " queued=");
            bs_num(&s, DEV[i].queue_depth);
            bs_put(&s, " irps=");
            bs_num(&s, DEV[i].irp_total);
            bs_put(&s, "\n");
        }
    }
    bs_put(&s, "\nThreads: ");
    bs_num(&s, thread_count);
    bs_put(&s, "  Objects: ");
    bs_num(&s, k_obj_count());
    bs_put(&s, "  Handles: ");
    bs_num(&s, handle_total);
    bs_put(&s, "  IRPs: ");
    bs_num(&s, io_created);
    bs_put(&s, "/");
    bs_num(&s, io_completed);
    bs_put(&s, "\nCommit: ");
    bs_num(&s, commit_charge / 1024u);
    bs_put(&s, " KB of ");
    bs_num(&s, commit_limit / 1024u);
    bs_put(&s, " KB   IRQL violations: ");
    bs_num(&s, irql_violations);
    bs_put(&s, "   SLAT: n/a\n");
    bs_put(&s, "Wait chains:\n");
    for (i = 1; i < NT_MAX_THREAD; i++) {
        if (TH[i].used && TH[i].state == TH_WAIT) {
            bs_put(&s, "  thread ");
            bs_num(&s, i);
            bs_put(&s, " waiting on obj ");
            bs_num(&s, TH[i].wait_obj);
            bs_put(&s, "\n");
        }
    }
    bs_put(&s, "\nKernel halted. Press any key to restart.\n");
    bc_dump_len = s.n;
    return code;
}
u32 k_bugcheck_state(u32 which) {
    switch (which) {
        case 0: return bc_code;
        case 1: return bc_params[0];
        case 2: return bc_params[1];
        case 3: return bc_params[2];
        case 4: return bc_params[3];
        case 5: return bc_halted;
        default: return bc_count;
    }
}
u32 k_bugcheck_dump_ptr(void) { return (u32)BC_DUMP; }
u32 k_bugcheck_dump_len(void) { return bc_dump_len; }

/* -------------------------------------------------------------- counters */
static u32 reg_key_count(void) { return k_reg2_stats(0u); }
u32 nt_stat(u32 idx) {
    u32 i, ready = 0, run = 0, wait = 0;
    for (i = 1; i < NT_MAX_THREAD; i++) {
        if (!TH[i].used) continue;
        if (TH[i].state == TH_READY) ready++;
        else if (TH[i].state == TH_RUN) run++;
        else if (TH[i].state == TH_WAIT) wait++;
    }
    switch (idx) {
        case NS_OBJECTS: return k_obj_count();
        case NS_OBJECT_PEAK: return obj_peak;
        case NS_HANDLES: return handle_total;
        case NS_THREADS: return thread_count;
        case NS_TH_READY: return ready;
        case NS_TH_RUN: return run;
        case NS_TH_WAIT: return wait;
        case NS_READY_DEPTH: return ready_depth();
        case NS_WAITS: return waits_total;
        case NS_MUTANTS_HELD: return mutants_held;
        case NS_DPC_QUEUED: return dpc_queued;
        case NS_DPC_DRAINED: return dpc_drained;
        case NS_APC_QUEUED: return apc_queued;
        case NS_APC_DELIVERED: return apc_delivered;
        case NS_IRP_CREATED: return io_created;
        case NS_IRP_COMPLETED: return io_completed;
        case NS_IRP_FAILED: return io_failed;
        case NS_IRP_OVERFLOW: return io_overflow;
        case NS_IRP_CANCELLED: return io_cancelled;
        case NS_IRQL_VIOLATIONS: return irql_violations;
        case NS_COMMIT_CHARGE: return commit_charge;
        case NS_COMMIT_LIMIT: return commit_limit;
        case NS_COMMIT_PEAK: return commit_peak;
        case NS_COMMIT_FAILS: return commit_failures;
        case NS_PAGE_FAULTS: {
            u32 p, t = 0;
            for (p = 0; p < NT_MAX_PID; p++) t += PID_FAULTS[p];
            return t;
        }
        case NS_POOL_PAGED: return pool_paged;
        case NS_POOL_PAGED_PEAK: return pool_paged_peak;
        case NS_POOL_NONPAGED: return pool_nonpaged;
        case NS_POOL_NP_PEAK: return pool_np_peak;
        case NS_TOKENS: {
            u32 t = 0;
            for (i = 0; i < NT_MAX_PID + 16u; i++) if (TOKENS[i].used) t++;
            return t;
        }
        case NS_ACCESS_CHECKS: return access_checks;
        case NS_ACCESS_DENIES: return access_denies;
        case NS_REG_KEYS: return reg_key_count();
        case NS_REG_VALUES: return k_reg2_stats(1u);
        case NS_REG_DEPTH: return k_reg2_stats(2u);
        case NS_TX_COMMITTED: return tx_committed;
        case NS_TX_ROLLEDBACK: return tx_rolledback;
        case NS_BUGCHECKS: return bc_count;
        case NS_SECTIONS: {
            u32 n = 0;
            for (i = 1; i < NT_MAX_SECTION; i++) if (SEC[i].used) n++;
            return n;
        }
        case NS_VM_REGIONS: return vm_regions_total;
        case NS_CURRENT_TID: return cur_tid;
        case NS_SWITCHES: return switch_count;
        case NS_BOOSTS: return boost_count;
        case NS_AGING: return aging_count;
        case NS_VMBUS_MSGS: return vmbus_tx_count;
        case NS_KERNEL_HALTED: return bc_halted;
        case NS_OBJECT_DELETES: return obj_deleted;
        case NS_WAIT_TIMEOUTS: return wait_timeouts;
        case NS_HIVE_QUOTA: return name_quota_hits + data_quota_hits;
        case NS_HIVE_SKIPS: return hive_skips;
        default: return 0;
    }
}
u32 nt_tmp_len(void) { return tmp_len; }

/* ------------------------------------------------------------ the setup */
static void seed_hive(void) {
    u32 hklm = k_reg2_root(0u), hkcu = k_reg2_root(1u), hkcr = k_reg2_root(2u), hku = k_reg2_root(3u);
    u32 sys, ccs, svc, dev, key2, sw;
    static const char *sysname = "SYSTEM", *ccsname = "CurrentControlSet", *svcname = "Services";
    static const char *devname = "Device", *sw2 = "Software", *microsoft = "Microsoft";
    sys = (u32)k_reg2_create_key(hklm, (u32)sysname, sl(sysname));
    ccs = (u32)k_reg2_create_key(sys, (u32)ccsname, sl(ccsname));
    svc = (u32)k_reg2_create_key(ccs, (u32)svcname, sl(svcname));
    /* the services the I/O manager knows about */
    {
        static const char *names[4] = { "Vmbus", "Beep", "Null", "HypervisorSupport" };
        static const u32 types[4] = { 1u, 1u, 3u, 4u };
        u32 i;
        for (i = 0; i < 4; i++) {
            u32 s = (u32)k_reg2_create_key(svc, (u32)names[i], sl(names[i]));
            static const char *imagep = "ImagePath", *startp = "Start", *typep = "Type";
            static const char *images[4] = { "system32\\drivers\\Vmbus.sys", "system32\\drivers\\Beep.sys",
                                             "system32\\drivers\\Null.sys", "system32\\drivers\\HvSupport.sys" };
            k_reg2_set_value(s, (u32)imagep, sl(imagep), 1u, (u32)images[i], sl(images[i]));
            k_reg2_set_dword(s, (u32)startp, sl(startp), 1u);
            k_reg2_set_dword(s, (u32)typep, sl(typep), types[i]);
        }
    }
    dev = (u32)k_reg2_create_key(hklm, (u32)devname, sl(devname));
    k_reg2_set_value(dev, (u32)"VmbusChannel", 12, 1u, (u32)"\\Device\\Vmbus", 14);
    sw = (u32)k_reg2_create_key(hkcu, (u32)sw2, sl(sw2));
    key2 = (u32)k_reg2_create_key(sw, (u32)microsoft, sl(microsoft));
    (void)key2;
    (void)hkcr; (void)hku;
}

void nt_init(void) {
    u32 i;
    z(OBJ, sizeof(OBJ)); z(HANDLES, sizeof(HANDLES)); z(TOKENS, sizeof(TOKENS));
    z(TH, sizeof(TH)); z(KEY, sizeof(KEY)); z(VAL, sizeof(VAL));
    z(TX, sizeof(TX)); z(UNDO, sizeof(UNDO)); z(REG, sizeof(REG));
    z(DRV, sizeof(DRV)); z(DEV, sizeof(DEV)); z(IRP, sizeof(IRP));
    z(SEC, sizeof(SEC)); z(POOL, sizeof(POOL));
    z(ready_head, sizeof(ready_head)); z(ready_tail, sizeof(ready_tail));
    z(PID_TOKEN, sizeof(PID_TOKEN)); z(VM_NEXT, sizeof(VM_NEXT));
    z(BC_DUMP, sizeof(BC_DUMP));
    z(apc_ready, sizeof(apc_ready));
    names_used = 8; data_used = 8;
    obj_created = obj_deleted = obj_peak = 0; handle_total = 0;
    thread_count = 0; cur_tid = 0; ready_bitmap = 0;
    tid_seq = 1; switch_count = boost_count = aging_count = 0; boost_decay = 0;
    wait_timeouts = waits_total = mutants_held = 0;
    irql = IRQL_PASSIVE; irql_sp = 0; irql_violations = 0;
    dip = aip = 0; dpc_queued = dpc_drained = apc_queued = apc_delivered = 0;
    apc_rh = apc_rt = 0;
    io_created = io_completed = io_failed = io_overflow = io_cancelled = io_queued = 0;
    commit_charge = 0; commit_limit = NT_COMMIT_LIMIT; commit_peak = 0; commit_failures = 0;
    vm_regions_total = 0; pool_free_head = 8;
    pool_paged = pool_paged_peak = pool_nonpaged = pool_np_peak = 0;
    access_checks = access_denies = 0;
    tx_committed = tx_rolledback = cur_tx = 0;
    nfree_n = dfree_n = 0; name_quota_hits = data_quota_hits = 0; pool_frozen = 0;
    hive_skips = 0;
    bc_code = bc_halted = bc_count = 0; bc_dump_len = 0;
    for (i = 1; i < NT_MAX_KEY; i++) {};
    for (i = 0; i < NT_MAX_PID; i++) { PID_VSIZE[i] = PID_COMMIT[i] = PID_WORKING[i] = PID_FAULTS[i] = 0; }

    /* the four hive roots: HKLM, HKCU, HKCR, HKU at 1..4 under a virtual root */
    z(&KEY[0], sizeof(NtKey));
    {
        static const char *roots[4] = { "HKEY_LOCAL_MACHINE", "HKEY_CURRENT_USER", "HKEY_CLASSES_ROOT", "HKEY_USERS" };
        for (i = 0; i < 4; i++) {
            KEY[i + 1].used = 1;
            KEY[i + 1].parent = 0;
            KEY[i + 1].name_off = name_store((u32)roots[i], sl(roots[i]));
            KEY[i + 1].name_len = sl(roots[i]);
        }
    }
    /* the system token */
    (void)k_token_create(3000u, 1u);
    seed_hive();
    pool_free_head = 8;

    /* the driver/device tree the I/O manager exposes */
    {
        static const char *dn[4] = { "\\Driver\\Vmbus", "\\Driver\\Beep", "\\Driver\\NullDrv", "\\Driver\\HvFilter" };
        static const u32 disp[4] = { 1u, 1u, 3u, 2u };
        static const char *vn[4] = { "\\Device\\Vmbus", "\\Device\\Beep", "\\Device\\Null", "\\Device\\HvFilter" };
        u32 d[4];
        for (i = 0; i < 4; i++) d[i] = k_driver_create((u32)dn[i], sl(dn[i]), disp[i], 0);
        for (i = 0; i < 4; i++) (void)k_device_create(d[i], (u32)vn[i], sl(vn[i]), (i == 0) ? 1u : 2u);
        /* a filter device layered over the VMBus device, so the stack depth is > 1 */
        {
            u32 filt = 0, vmbus = 0;
            for (i = 1; i < NT_MAX_DEVICE; i++) {
                if (DEV[i].used && DEV[i].driver == d[3]) filt = i;
                if (DEV[i].used && DEV[i].driver == d[0]) vmbus = i;
            }
            if (filt && vmbus) k_devices_link(filt, vmbus);
        }
    }
}

u32 k_thread_of_proc(u32 pid) {
    u32 i;
    for (i = 1; i < NT_MAX_THREAD; i++) if (TH[i].used && TH[i].pid == pid) return i;
    return 0;
}

void nt_on_proc_create(u32 pid, u32 name_ptr, u32 name_len) {
    u32 i, oid;
    if (pid == 0 || pid >= NT_MAX_PID) return;
    for (i = 0; i < NT_MAX_HANDLE; i++) z(&HANDLES[pid][i], sizeof(NtHandle));
    for (i = 0; i < NT_MAX_REGION; i++) z(&REG[pid][i], sizeof(NtRegion));
    VM_NEXT[pid] = NT_VM_BASE;
    PID_VSIZE[pid] = PID_COMMIT[pid] = PID_WORKING[pid] = PID_FAULTS[pid] = 0;
    oid = k_obj_create(OT_PROCESS, name_ptr, name_len, DACL_PUBLIC);
    if (oid) OBJ[oid].owner_pid = pid;
    /* every process gets a handle to itself, and a stack region it commits */
    if (oid) k_handle_open(pid, oid, ACCESS_ALL);
    {
        i32 stk = k_vm_reserve(pid, 64u * 1024u, ACCESS_READ | ACCESS_WRITE);
        if (stk > 0) k_vm_commit(pid, (u32)stk, 64u * 1024u);
    }
    /* a Windows process starts with one thread, running at normal priority:
       the executive creates it here so the shell's processes are scheduled,
       boosted and switched exactly like any other. */
    if (!k_thread_of_proc(pid)) {
        u32 tid = k_thread_create(pid, 8u, name_ptr, name_len);
        (void)tid;
    }
}
void nt_on_proc_destroy(u32 pid) {
    u32 i;
    if (pid == 0 || pid >= NT_MAX_PID) return;
    for (i = 1; i < NT_MAX_THREAD; i++) if (TH[i].used && TH[i].pid == pid) k_thread_terminate(i);
    for (i = 0; i < NT_MAX_HANDLE; i++) if (HANDLES[pid][i].used) k_handle_close(pid, (i32)(i + 1));
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used) {
            commit_charge = (commit_charge > REG[pid][i].committed) ? commit_charge - REG[pid][i].committed : 0;
            if (vm_regions_total) vm_regions_total--;
            z(&REG[pid][i], sizeof(NtRegion));
        }
    }
    PID_VSIZE[pid] = PID_COMMIT[pid] = PID_WORKING[pid] = PID_FAULTS[pid] = 0;
    PID_TOKEN[pid] = 0;
}
