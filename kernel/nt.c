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
    u32 used, type, refs, dacl, owner_pid, owner_sid, integrity, protection;
    u32 ace_count, dacl_present;
    u32 name_off, name_len;
    u32 link_target;
    /* dispatcher payload */
    u32 dstate, dmanual, dcount, dlimit, downer, dsignals;
    u32 dabandoned;
    u32 waiters[NT_PRIO];         /* thread ids, highest priority first */
    u32 wait_count;
} NtObj;
static NtObj OBJ[NT_MAX_OBJ];
typedef struct { u32 used, obj, sid, mask, type, order; } NtAce;
static NtAce ACE[NT_MAX_ACE];
static u32 ace_sequence;
static u32 obj_created, obj_deleted, obj_peak;
static char NS_TMP[256];

static NtObj *obj(u32 id) { return (id && id < NT_MAX_OBJ && OBJ[id].used) ? &OBJ[id] : 0; }

static u32 ns_name_store(const char *s, u32 len) {
    u32 off;
    if (len > 255u) len = 255u;
    off = pool_take(nfree, &nfree_n, &names_used, NT_NAME_POOL, len + 1u);
    if (!off) { name_quota_hits++; return 0; }
    cp(NAMES + off, s, len);
    NAMES[off + len] = 0;
    return off;
}
static void ns_name_free(u32 off, u32 len) {
    if (off && len) pool_give(nfree, &nfree_n, off, len + 1u);
}
static u32 ns_normalize(u32 ptr, u32 len) {
    const char *s = (const char *)ptr;
    u32 i = 0, n = 0;
    if (!ptr || !len) return 0;
    if (len >= 4u && s[0] == '\\' && s[1] == '?' && s[2] == '?' && s[3] == '\\') {
        const char *prefix = "\\GLOBAL??\\";
        while (prefix[n] && n + 1u < sizeof(NS_TMP)) NS_TMP[n] = prefix[n], n++;
        i = 4u;
    } else if (s[0] != '\\') {
        const char *prefix = "\\BaseNamedObjects\\";
        while (prefix[n] && n + 1u < sizeof(NS_TMP)) NS_TMP[n] = prefix[n], n++;
    }
    while (i < len && n + 1u < sizeof(NS_TMP)) {
        NS_TMP[n++] = s[i++];
    }
    while (n > 1u && NS_TMP[n - 1u] == '\\') n--;
    NS_TMP[n] = 0;
    return n;
}
static u32 ns_match(const NtObj *o, const char *name, u32 len) {
    return o && o->used && o->name_off && o->name_len == len && cieq(N(o->name_off), name, len);
}
static u32 ns_find(const char *name, u32 len) {
    u32 i;
    for (i = 1; i < NT_MAX_OBJ; i++) if (ns_match(&OBJ[i], name, len)) return i;
    return 0;
}
static u32 ns_resolve(u32 id, u32 *status) {
    u32 depth = 0;
    while (obj(id) && OBJ[id].type == OT_SYMBOLIC_LINK) {
        if (++depth > 8u) { if (status) *status = ST_REPARSE; return 0; }
        id = OBJ[id].link_target;
    }
    if (!obj(id)) { if (status) *status = ST_OBJECT_NAME_NOT_FOUND; return 0; }
    return id;
}

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
    OBJ[id].integrity = IL_MEDIUM;
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
    if (o->link_target) k_obj_deref(o->link_target);
    for (i = 0; i < NT_MAX_ACE; i++) {
        if (ACE[i].used && ACE[i].obj == id) z(&ACE[i], sizeof(NtAce));
    }
    if (o->name_off) {
        if (o->type == OT_DIRECTORY || o->type == OT_SYMBOLIC_LINK) ns_name_free(o->name_off, o->name_len);
        else name_free(o->name_off, o->name_len);
    }
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
u32 k_obj_namespace_count(void) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_OBJ; i++) if (OBJ[i].used && OBJ[i].name_off) n++;
    return n;
}
i32 k_obj_create_named(u32 type, u32 name_ptr, u32 name_len, u32 dacl) {
    u32 id, n, off;
    n = ns_normalize(name_ptr, name_len);
    if (!n) return (i32)ST_INVALID_PARAM;
    if (ns_find(NS_TMP, n)) return (i32)ST_OBJECT_NAME_COLLISION;
    id = k_obj_create(type, 0, 0, dacl);
    if (!id) return (i32)ST_INSUFFICIENT_RES;
    off = ns_name_store(NS_TMP, n);
    if (!off) { k_obj_deref(id); return (i32)ST_INSUFFICIENT_RES; }
    OBJ[id].name_off = off;
    OBJ[id].name_len = n;
    return (i32)id;
}
i32 k_obj_open_named(u32 name_ptr, u32 name_len, u32 type) {
    u32 n = ns_normalize(name_ptr, name_len), id, status = ST_OBJECT_NAME_NOT_FOUND;
    if (!n) return (i32)ST_INVALID_PARAM;
    id = ns_find(NS_TMP, n);
    if (!id) return (i32)ST_OBJECT_NAME_NOT_FOUND;
    id = ns_resolve(id, &status);
    if (!id || (type && OBJ[id].type != type)) return (i32)status;
    k_obj_ref(id);
    return (i32)id;
}
i32 k_obj_link_named(u32 name_ptr, u32 name_len, u32 target) {
    i32 id = k_obj_create_named(OT_SYMBOLIC_LINK, name_ptr, name_len, DACL_PUBLIC);
    if (id < 0) return id;
    if (!obj(target)) { k_obj_deref((u32)id); return (i32)ST_OBJECT_NAME_NOT_FOUND; }
    OBJ[id].link_target = target;
    k_obj_ref(target);
    return id;
}
i32 k_obj_retarget_named(u32 name_ptr, u32 name_len, u32 target) {
    u32 n = ns_normalize(name_ptr, name_len), id, old;
    if (!n) return (i32)ST_INVALID_PARAM;
    id = ns_find(NS_TMP, n);
    if (!id || OBJ[id].type != OT_SYMBOLIC_LINK) return (i32)ST_OBJECT_NAME_NOT_FOUND;
    if (!obj(target)) return (i32)ST_OBJECT_NAME_NOT_FOUND;
    old = OBJ[id].link_target;
    k_obj_ref(target);
    OBJ[id].link_target = target;
    if (old) k_obj_deref(old);
    return (i32)id;
}
static u32 ace_matches(const NtAce *a, u32 sid) {
    return a && (a->sid == sid || a->sid == ACE_EVERYONE);
}
i32 k_obj_set_owner(u32 id, u32 sid) {
    NtObj *o = obj(id);
    if (!o || !sid) return (i32)ST_INVALID_PARAM;
    o->owner_sid = sid;
    return 0;
}
i32 k_obj_add_ace(u32 id, u32 sid, u32 mask, u32 type) {
    NtObj *o = obj(id);
    u32 i;
    mask = k_access_map_generic(mask);
    if (!o || !sid || !mask || (mask & ~ACCESS_VALID) || type > ACE_DENY)
        return (i32)ST_INVALID_PARAM;
    for (i = 0; i < NT_MAX_ACE; i++) if (!ACE[i].used) {
        ACE[i].used = 1; ACE[i].obj = id; ACE[i].sid = sid;
        ACE[i].mask = mask; ACE[i].type = type; ACE[i].order = ++ace_sequence;
        o->ace_count++; o->dacl_present = 1;
        return 0;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_obj_clear_aces(u32 id) {
    NtObj *o = obj(id);
    u32 i;
    if (!o) return (i32)ST_INVALID_PARAM;
    for (i = 0; i < NT_MAX_ACE; i++) if (ACE[i].used && ACE[i].obj == id && ACE[i].type <= ACE_DENY) z(&ACE[i], sizeof(NtAce));
    o->ace_count = 0; o->dacl_present = 1;
    return 0;
}
u32 k_obj_owner(u32 id) { NtObj *o = obj(id); return o ? o->owner_sid : 0; }
u32 k_obj_ace_count(u32 id) { NtObj *o = obj(id); return o ? o->ace_count : 0; }
i32 k_obj_set_integrity(u32 id, u32 level) {
    NtObj *o = obj(id);
    if (!o || level > IL_SYSTEM) return (i32)ST_INVALID_PARAM;
    o->integrity = level;
    return 0;
}
u32 k_obj_integrity(u32 id) { NtObj *o = obj(id); return o ? o->integrity : 0; }
i32 k_obj_set_protection(u32 id, u32 signer) {
    NtObj *o = obj(id);
    if (!o || signer > PPL_WINDOWS) return (i32)ST_INVALID_PARAM;
    o->protection = signer;
    return 0;
}
u32 k_obj_protection(u32 id) { NtObj *o = obj(id); return o ? o->protection : PPL_NONE; }
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
        case 7: return o->owner_sid;
        case 8: return o->ace_count;
        case 9: return o->integrity;
        case 10: return o->protection;
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
typedef struct { u32 used, obj, access, generation; } NtHandle;
static NtHandle HANDLES[NT_MAX_PID][NT_MAX_HANDLE];
/* The low byte is the stable slot number.  The upper bits are a sequence
   number that changes whenever a slot is closed, so an old handle can never
   resolve to a newly opened object in the same slot. */
static u32 HANDLE_GEN[NT_MAX_PID][NT_MAX_HANDLE];
u32 handle_total;

static u32 handle_slot(i32 h, u32 *generation) {
    u32 raw;
    u32 slot;
    if (h <= 0) return NT_MAX_HANDLE;
    raw = (u32)h;
    slot = raw & 0xFFu;
    if (!slot || slot > NT_MAX_HANDLE) return NT_MAX_HANDLE;
    if (generation) *generation = raw >> 8;
    return slot - 1u;
}
static i32 handle_id(u32 slot, u32 generation) {
    return (i32)((generation << 8) | (slot + 1u));
}

u32 k_handle_count(u32 pid) {
    u32 i, n = 0;
    if (pid >= NT_MAX_PID) return 0;
    for (i = 0; i < NT_MAX_HANDLE; i++) if (HANDLES[pid][i].used) n++;
    return n;
}
static i32 token_check(u32 pid, u32 oid, u32 access) {
    NtObj *o = obj(oid);
    if (!o) return -1;
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
            HANDLES[pid][i].generation = HANDLE_GEN[pid][i];
            k_obj_ref(oid);
            handle_total++;
            return handle_id(i, HANDLES[pid][i].generation);
        }
    }
    return -2;
}
i32 k_handle_close(u32 pid, i32 h) {
    u32 generation, slot = handle_slot(h, &generation);
    if (pid >= NT_MAX_PID || slot >= NT_MAX_HANDLE) return -1;
    if (!HANDLES[pid][slot].used || HANDLES[pid][slot].generation != generation) return -1;
    k_obj_deref(HANDLES[pid][slot].obj);
    z(&HANDLES[pid][slot], sizeof(NtHandle));
    HANDLE_GEN[pid][slot]++;
    if (handle_total) handle_total--;
    return 0;
}
i32 k_handle_dup(u32 pid, i32 h, u32 access) {
    u32 generation, slot = handle_slot(h, &generation);
    if (pid >= NT_MAX_PID || slot >= NT_MAX_HANDLE) return -1;
    if (!HANDLES[pid][slot].used || HANDLES[pid][slot].generation != generation) return -1;
    if (access == 0) access = HANDLES[pid][slot].access;
    return k_handle_open(pid, HANDLES[pid][slot].obj, access);
}
i32 k_handle_obj(u32 pid, i32 h) {
    u32 generation, slot = handle_slot(h, &generation);
    if (pid >= NT_MAX_PID || slot >= NT_MAX_HANDLE) return -1;
    return (HANDLES[pid][slot].used && HANDLES[pid][slot].generation == generation) ?
           (i32)HANDLES[pid][slot].obj : -1;
}
u32 k_handle_access(u32 pid, i32 h) {
    u32 generation, slot = handle_slot(h, &generation);
    if (pid >= NT_MAX_PID || slot >= NT_MAX_HANDLE) return 0;
    return (HANDLES[pid][slot].used && HANDLES[pid][slot].generation == generation) ?
           HANDLES[pid][slot].access : 0;
}

/* --------------------------------------------------------------- security */
typedef struct { u32 used, sid, privileged, privileges, integrity, signer; } NtToken;
static NtToken TOKENS[NT_MAX_PID + 16];
static u32 PID_TOKEN[NT_MAX_PID];
static u32 access_checks, access_denies, access_grants, audit_success, audit_failure;

u32 k_token_create(u32 sid, u32 privileged) {
    u32 i;
    for (i = 1; i < NT_MAX_PID + 16; i++) {
        if (!TOKENS[i].used) {
            TOKENS[i].used = 1; TOKENS[i].sid = sid; TOKENS[i].privileged = privileged ? 1 : 0;
            TOKENS[i].privileges = privileged ? TOKEN_PRIV_ALL : 0;
            TOKENS[i].integrity = privileged ? IL_SYSTEM : (sid == 2000u ? IL_HIGH : (sid == 4000u ? IL_LOW : (sid == 3000u ? IL_SYSTEM : IL_MEDIUM)));
            TOKENS[i].signer = privileged ? PPL_WINDOWS : (sid == 2000u ? PPL_CODEGEN : (sid == 3000u ? PPL_WINDOWS : (sid == 4000u ? PPL_AUTHENTICODE : PPL_AUTHENTICODE)));
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
i32 k_token_set_privileges(u32 tok, u32 privileges) {
    if (tok >= NT_MAX_PID + 16 || !TOKENS[tok].used ||
        (privileges & ~TOKEN_PRIV_ALL))
        return (i32)ST_INVALID_PARAM;
    TOKENS[tok].privileges = privileges;
    TOKENS[tok].privileged = (privileges & TOKEN_PRIV_DEBUG) ? 1u : 0u;
    return 0;
}
u32 k_token_privileges(u32 tok) {
    return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].privileges : 0;
}
u32 k_token_integrity(u32 tok) {
    return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].integrity : IL_UNTRUSTED;
}
i32 k_token_set_integrity(u32 tok, u32 level) {
    if (tok >= NT_MAX_PID + 16 || !TOKENS[tok].used || level > IL_SYSTEM)
        return (i32)ST_INVALID_PARAM;
    TOKENS[tok].integrity = level;
    return 0;
}
u32 k_token_signer(u32 tok) {
    return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].signer : PPL_NONE;
}
i32 k_token_set_signer(u32 tok, u32 signer) {
    if (tok >= NT_MAX_PID + 16 || !TOKENS[tok].used || signer > PPL_WINDOWS)
        return (i32)ST_INVALID_PARAM;
    TOKENS[tok].signer = signer;
    return 0;
}
u32 k_token_has_privilege(u32 tok, u32 privilege) {
    return (tok < NT_MAX_PID + 16 && TOKENS[tok].used && privilege &&
            (TOKENS[tok].privileges & privilege) == privilege) ? 1u : 0u;
}
i32 k_privilege_check(u32 tok, u32 privilege) {
    if (!privilege || (privilege & ~TOKEN_PRIV_ALL)) return (i32)ST_INVALID_PARAM;
    return k_token_has_privilege(tok, privilege) ? 0 : (i32)ST_PRIVILEGE_NOT_HELD;
}
u32 k_access_map_generic(u32 access) {
    u32 mapped = access & 0x0FFFFFFFu;
    /* DEVIATION: object-specific rights retain the legacy four-bit ABI. */
    if (access & GENERIC_READ) mapped |= ACCESS_READ | ACCESS_READ_CONTROL;
    if (access & GENERIC_WRITE) mapped |= ACCESS_WRITE | ACCESS_READ_CONTROL;
    if (access & GENERIC_EXECUTE) mapped |= ACCESS_EXEC | ACCESS_READ_CONTROL;
    if (access & GENERIC_ALL) mapped |= ACCESS_ALL | ACCESS_READ_CONTROL | ACCESS_WRITE_DAC | ACCESS_WRITE_OWNER;
    return mapped;
}
static i32 access_result(u32 oid, u32 sid, u32 access, i32 result) {
    u32 i;
    if (result) access_denies++; else access_grants++;
    for (i = 0; i < NT_MAX_ACE; i++) {
        NtAce *a = &ACE[i];
        if (!a->used || a->obj != oid || !ace_matches(a, sid) || !(a->mask & access)) continue;
        if (!result && (a->type == ACE_AUDIT_SUCCESS || a->type == ACE_AUDIT_BOTH)) audit_success++;
        if (result && (a->type == ACE_AUDIT_FAILURE || a->type == ACE_AUDIT_BOTH)) audit_failure++;
    }
    return result;
}
i32 k_obj_add_sacl_ace(u32 tok, u32 id, u32 sid, u32 mask, u32 type) {
    u32 i;
    if (k_privilege_check(tok, TOKEN_PRIV_SECURITY)) return (i32)ST_PRIVILEGE_NOT_HELD;
    mask = k_access_map_generic(mask);
    if (!obj(id) || !sid || !mask || (mask & ~ACCESS_VALID) || type < ACE_AUDIT_SUCCESS || type > ACE_AUDIT_BOTH)
        return (i32)ST_INVALID_PARAM;
    for (i = 0; i < NT_MAX_ACE; i++) if (!ACE[i].used) {
        ACE[i].used = 1; ACE[i].obj = id; ACE[i].sid = sid;
        ACE[i].mask = mask; ACE[i].type = type; ACE[i].order = ++ace_sequence;
        return 0;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_obj_security_add_ace(u32 tok, u32 id, u32 sid, u32 mask, u32 type) {
    if (!obj(id)) return (i32)ST_INVALID_PARAM;
    if (k_access_check(tok, id, ACCESS_WRITE_DAC)) return (i32)ST_ACCESS_DENIED;
    return k_obj_add_ace(id, sid, mask, type);
}
i32 k_obj_security_set_owner(u32 tok, u32 id, u32 sid) {
    if (!obj(id) || !sid) return (i32)ST_INVALID_PARAM;
    if (k_privilege_check(tok, TOKEN_PRIV_TAKE_OWNERSHIP) && k_access_check(tok, id, ACCESS_WRITE_OWNER))
        return (i32)ST_ACCESS_DENIED;
    if (!k_token_has_privilege(tok, TOKEN_PRIV_TAKE_OWNERSHIP) && sid != k_sid_of(tok))
        return (i32)ST_ACCESS_DENIED;
    return k_obj_set_owner(id, sid);
}
i32 k_obj_security_set_integrity(u32 tok, u32 id, u32 level) {
    if (!obj(id) || level > IL_SYSTEM) return (i32)ST_INVALID_PARAM;
    if (k_access_check(tok, id, ACCESS_WRITE_DAC)) return (i32)ST_ACCESS_DENIED;
    return k_obj_set_integrity(id, level);
}
i32 k_obj_security_set_protection(u32 tok, u32 id, u32 signer) {
    if (!obj(id) || signer > PPL_WINDOWS) return (i32)ST_INVALID_PARAM;
    if (k_access_check(tok, id, ACCESS_WRITE_DAC)) return (i32)ST_ACCESS_DENIED;
    return k_obj_set_protection(id, signer);
}
u32 k_sid_of(u32 tok) { return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].sid : 0; }
u32 k_privileged_of(u32 tok) { return (tok < NT_MAX_PID + 16 && TOKENS[tok].used) ? TOKENS[tok].privileged : 0; }

i32 k_access_check(u32 tok, u32 oid, u32 access) {
    NtObj *o = obj(oid);
    u32 granted = 0, sid = k_sid_of(tok), i, next, order, remaining, budget;
    access_checks++;
    access = k_access_map_generic(access);
    if (!o || !access || (access & ~ACCESS_VALID)) return access_result(oid, sid, access, -1);
    if (k_token_integrity(tok) < o->integrity &&
        (access & (ACCESS_WRITE | ACCESS_DELETE | ACCESS_WRITE_DAC | ACCESS_WRITE_OWNER)))
        return access_result(oid, sid, access, -5);
    if (o->protection && k_token_signer(tok) < o->protection &&
        (access & (ACCESS_WRITE | ACCESS_DELETE | ACCESS_EXEC)))
        return access_result(oid, sid, access, -5);
    if ((access & ACCESS_SYSTEM_SECURITY) && !k_token_has_privilege(tok, TOKEN_PRIV_SECURITY))
        return access_result(oid, sid, access, (i32)ST_PRIVILEGE_NOT_HELD);
    if (k_token_has_privilege(tok, TOKEN_PRIV_DEBUG)) return access_result(oid, sid, access, 0);
    if ((o->dacl & DACL_SYSTEM_ONLY) && !k_token_has_privilege(tok, TOKEN_PRIV_SYSTEM))
        return access_result(oid, sid, access, -5);
    if (o->dacl & DACL_SYSTEM_ONLY) return access_result(oid, sid, access, 0);
    if (sid && sid == o->owner_sid) granted |= ACCESS_READ_CONTROL | ACCESS_WRITE_DAC;
    if (k_token_has_privilege(tok, TOKEN_PRIV_TAKE_OWNERSHIP)) granted |= ACCESS_WRITE_OWNER;
    if (k_token_has_privilege(tok, TOKEN_PRIV_SECURITY)) granted |= ACCESS_SYSTEM_SECURITY;
    remaining = access & ~granted;
    if (!remaining) return access_result(oid, sid, access, 0);
    if (o->dacl_present) {
        /* SeAccessCheck evaluates the remaining requested rights in ACE
           order. Canonical deny-before-allow prevents an earlier grant. */
        order = 0;
        for (budget = 0; budget < NT_MAX_ACE; budget++) {
            next = 0;
            for (i = 0; i < NT_MAX_ACE; i++)
                if (ACE[i].used && ACE[i].obj == oid && ACE[i].type <= ACE_DENY && ACE[i].order > order &&
                    (!next || ACE[i].order < next)) next = ACE[i].order;
            if (!next) break;
            for (i = 0; i < NT_MAX_ACE; i++) if (ACE[i].used && ACE[i].obj == oid && ACE[i].order == next) {
                if (ace_matches(&ACE[i], sid)) {
                    if (ACE[i].type == ACE_DENY && (ACE[i].mask & remaining))
                        return access_result(oid, sid, access, -5);
                    if (ACE[i].type == ACE_ALLOW) remaining &= ~ACE[i].mask;
                    if (!remaining) return access_result(oid, sid, access, 0);
                }
                break;
            }
            order = next;
        }
        return access_result(oid, sid, access, -5);
    }
    if (o->dacl & DACL_PUBLIC) return access_result(oid, sid, access, 0);
    granted |= o->dacl & ACCESS_ALL;
    return access_result(oid, sid, access, (granted & access) == access ? 0 : -5);
}

/* ---------------------------------------------------------------- threads */
typedef struct {
    u32 used, id, pid, state, prio, base, quantum, quantum_left, boost, aging;
    u32 cpu_us, waits, wait_obj, wait_deadline, wait_started, alertable, apc_pending;
    u32 wait_obj_count, wait_all, wait_result;
    u32 wait_objs[8];
    u32 name_off, name_len, ready_next, started, affinity, ideal_cpu, processor;
} NtThread;
static NtThread TH[NT_MAX_THREAD];
static u32 ready_head[NT_PRIO], ready_tail[NT_PRIO], ready_bitmap, thread_count;
static u32 tid_seq = 1, cur_tid, switch_count, boost_count, aging_count, wait_timeouts, boost_decay;
static u32 current_cpu, idle_ticks[NT_MAX_CPU], PID_PRIORITY_CLASS[NT_MAX_PID];
static u32 waits_total, mutants_held, irql_violations;

static NtThread *th(u32 id) { return (id && id < NT_MAX_THREAD && TH[id].used) ? &TH[id] : 0; }
static void wait_remove_at(NtObj *o, u32 idx);
static void wait_detach(NtThread *t);
static u32 wake_obj(NtObj *o, u32 count);
static void wait_mark_complete(NtThread *t, u32 status);

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
        while (c && n < NT_MAX_THREAD) {
            if (c >= NT_MAX_THREAD || !TH[c].used) break;
            n++; c = TH[c].ready_next;
        }
    }
    return n;
}
u32 k_thread_ready_index(u32 level) {
    return (level < NT_PRIO) ? ready_head[level] : 0;
}
u32 k_cpu_ready_index(u32 cpu, u32 level) {
    u32 id;
    if (cpu >= NT_MAX_CPU || level >= NT_PRIO) return 0;
    for (id = ready_head[level]; id; id = TH[id].ready_next)
        if (TH[id].used && (TH[id].affinity & (1u << cpu))) return id;
    return 0;
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
            t->affinity = (1u << NT_MAX_CPU) - 1u;
            t->ideal_cpu = 0;
            t->processor = 0;
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
    u32 i;
    if (!t) return -1;
    if (t->state == TH_READY) ready_remove(tid);
    wait_detach(t);
    for (i = 1; i < NT_MAX_OBJ; i++) if (OBJ[i].used && OBJ[i].type == OT_MUTANT && OBJ[i].downer == tid) {
        OBJ[i].dstate = 0; OBJ[i].dcount = 0; OBJ[i].downer = 0; OBJ[i].dabandoned = 1;
        (void)wake_obj(&OBJ[i], 1);
        if (mutants_held) mutants_held--;
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
        case 10: return t->wait_result;
        case 11: return t->wait_obj_count;
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
    if (t->state == TH_WAIT && t->alertable) {
        t->alertable = 0;
        wait_mark_complete(t, ST_ALERTED);
        return (i32)ST_ALERTED;
    }
    t->alertable = 1;
    return 0;
}
i32 k_thread_set_affinity(u32 tid, u32 mask) {
    NtThread *t = th(tid);
    if (!t || !mask || (mask & ~((1u << NT_MAX_CPU) - 1u))) return (i32)ST_INVALID_PARAM;
    t->affinity = mask;
    return 0;
}
u32 k_thread_affinity(u32 tid) { NtThread *t = th(tid); return t ? t->affinity : 0; }
i32 k_thread_set_ideal_processor(u32 tid, u32 cpu) {
    NtThread *t = th(tid);
    if (!t || cpu >= NT_MAX_CPU) return (i32)ST_INVALID_PARAM;
    t->ideal_cpu = cpu;
    return 0;
}
u32 k_thread_ideal_processor(u32 tid) { NtThread *t = th(tid); return t ? t->ideal_cpu : 0; }
u32 k_thread_processor(u32 tid) { NtThread *t = th(tid); return t ? t->processor : 0; }
u32 k_scheduler_cpu(void) { return current_cpu; }
i32 k_scheduler_set_cpu(u32 cpu) {
    if (cpu >= NT_MAX_CPU) return (i32)ST_INVALID_PARAM;
    current_cpu = cpu;
    return 0;
}
i32 k_process_set_priority_class(u32 pid, u32 class_id) {
    if (pid >= NT_MAX_PID || class_id > 4u) return (i32)ST_INVALID_PARAM;
    PID_PRIORITY_CLASS[pid] = class_id;
    return 0;
}
u32 k_process_priority_class(u32 pid) { return pid < NT_MAX_PID ? PID_PRIORITY_CLASS[pid] : 0; }

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
static void wait_detach(NtThread *t) {
    u32 i, j;
    if (!t) return;
    for (i = 0; i < t->wait_obj_count && i < 8; i++) {
        NtObj *o = obj(t->wait_objs[i]);
        if (!o) continue;
        for (j = 0; j < o->wait_count; j++) if (o->waiters[j] == t->id) {
            wait_remove_at(o, j);
            j--;
        }
    }
    t->wait_obj_count = 0;
    t->wait_obj = 0;
}
static i32 wait_probe(NtObj *o, u32 tid) {
    if (!o) return ST_INVALID_PARAM;
    switch (o->type) {
        case OT_EVENT: return o->dstate ? ST_SUCCESS : ST_PARTIAL_COPY;
        case OT_MUTANT:
            if (o->dabandoned) return ST_ABANDONED;
            return (!o->dstate || o->downer == tid) ? ST_SUCCESS : ST_PARTIAL_COPY;
        case OT_SEMAPHORE: return o->dcount ? ST_SUCCESS : ST_PARTIAL_COPY;
        default: return o->dstate ? ST_SUCCESS : ST_PARTIAL_COPY;
    }
}
static u32 wait_all_ready(NtThread *t, u32 *abandoned) {
    u32 i, any_abandoned = 0;
    if (!t || !t->wait_obj_count) return 0;
    for (i = 0; i < t->wait_obj_count && i < 8; i++) {
        NtObj *o = obj(t->wait_objs[i]);
        i32 r = wait_probe(o, t->id);
        if (r == ST_ABANDONED) any_abandoned = 1;
        else if (r != ST_SUCCESS) return 0;
    }
    if (abandoned) *abandoned = any_abandoned;
    return 1;
}
static void wait_mark_complete(NtThread *t, u32 status) {
    if (!t) return;
    wait_detach(t);
    t->wait_deadline = 0;
    t->wait_result = status;
    if (t->state == TH_WAIT) ready_push(t);
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
    if (alertable && t->apc_pending) {
        t->apc_pending--; t->alertable = 0; t->wait_result = ST_USER_APC;
        return (i32)ST_USER_APC;
    }
    t->waits++;
    waits_total++;
    /* already signalled? */
    t->wait_obj_count = 0; t->wait_all = 0; t->wait_result = ST_PARTIAL_COPY;
    { i32 wr = k_obj_wait_test(oid, tid);
      if (wr == ST_SUCCESS || wr == ST_ABANDONED) {
        t->wait_result = (wr == ST_ABANDONED) ? ST_ABANDONED : ST_SUCCESS;
        return wr;
      }
    }
    wait_add(o, tid);
    t->wait_obj = oid;
    t->wait_obj_count = 1; t->wait_objs[0] = oid;
    t->wait_deadline = timeout_ms ? (t->wait_started + timeout_ms) : 0;
    return ST_PARTIAL_COPY;      /* STATUS_TIMEOUT-ish: still waiting */
}

i32 k_wait_multiple(u32 tid, u32 list_ptr, u32 count, u32 wait_type, u32 timeout_ms, u32 alertable) {
    NtThread *t = th(tid);
    const u32 *ids = (const u32 *)list_ptr;
    u32 i, abandoned = 0;
    if (!t || !ids || !count || count > 8 || wait_type > WAIT_ALL) return (i32)ST_INVALID_PARAM;
    if (k_irql() >= IRQL_DISPATCH && timeout_ms) { irql_violations++; return (i32)ST_INVALID_DEVICE_REQ; }
    if (alertable) t->alertable = 1;
    if (alertable && t->apc_pending) {
        t->apc_pending--; t->alertable = 0; t->wait_result = ST_USER_APC;
        return (i32)ST_USER_APC;
    }
    for (i = 0; i < count; i++) if (!obj(ids[i])) return (i32)ST_INVALID_PARAM;
    t->wait_obj_count = count; t->wait_all = (wait_type == WAIT_ALL); t->wait_result = ST_PARTIAL_COPY;
    for (i = 0; i < count; i++) t->wait_objs[i] = ids[i];
    if (wait_type == WAIT_ANY) {
        for (i = 0; i < count; i++) if (wait_probe(obj(ids[i]), tid) == ST_SUCCESS || wait_probe(obj(ids[i]), tid) == ST_ABANDONED) {
            i32 r = k_obj_wait_test(ids[i], tid);
            t->wait_result = (r == ST_ABANDONED) ? ST_ABANDONED : ST_SUCCESS;
            t->wait_obj_count = 0; t->wait_obj = 0;
            return t->wait_result;
        }
    } else if (wait_all_ready(t, &abandoned)) {
        for (i = 0; i < count; i++) (void)k_obj_wait_test(ids[i], tid);
        t->wait_result = abandoned ? ST_ABANDONED : ST_SUCCESS;
        t->wait_obj_count = 0; t->wait_obj = 0;
        return t->wait_result;
    }
    for (i = 0; i < count; i++) wait_add(obj(ids[i]), tid);
    t->wait_obj = ids[0];
    t->wait_deadline = timeout_ms ? (t->wait_started + timeout_ms) : 0;
    t->waits++; waits_total++;
    return ST_PARTIAL_COPY;
}
u32 k_wait_result(u32 tid) { NtThread *t = th(tid); return t ? t->wait_result : ST_INVALID_PARAM; }

i32 k_obj_wait_test(u32 oid, u32 tid) {
    NtObj *o = obj(oid);
    if (!o) return ST_INVALID_PARAM;
    switch (o->type) {
        case OT_EVENT:
            if (!o->dstate) return ST_PARTIAL_COPY;
            if (!o->dmanual) o->dstate = 0;
            return ST_SUCCESS;
        case OT_MUTANT:
            if (o->dabandoned) {
                o->dabandoned = 0; o->dstate = 1; o->downer = tid; o->dcount = 1; mutants_held++;
                return ST_ABANDONED;
            }
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
    u32 woke = 0, scanned = 0;
    while (o->wait_count && woke < count && scanned < NT_PRIO) {
        u32 tid = o->waiters[0];
        NtThread *t = th(tid);
        u32 abandoned = 0;
        u32 all_wait = t && t->wait_all;
        scanned++;
        if (t && t->wait_all && !wait_all_ready(t, &abandoned)) {
            /* A wait-all remains registered until every object is ready. Put
               this priority-ordered waiter at the tail for this signal pass
               so another waiter on the same object can still progress. */
            if (o->wait_count > 1) {
                wait_remove_at(o, 0);
                o->waiters[o->wait_count++] = tid;
                continue;
            }
            break;
        }
        wait_remove_at(o, 0);
        if (!t) continue;
        if (o->type == OT_MUTANT && o->dabandoned) abandoned = 1;
        wait_detach(t);
        t->wait_result = abandoned ? ST_ABANDONED : ST_SUCCESS;
        t->wait_deadline = 0;
        ready_push(t);
        woke++;
        if (o->type == OT_MUTANT && !all_wait) {       /* ownership transfers to the waiter */
            o->downer = tid;
            o->dstate = 1;
            o->dcount = 1;
            o->dabandoned = 0;
            mutants_held++;
            break;
        }
        if (o->type == OT_SEMAPHORE && o->dcount && !all_wait) o->dcount--;
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

/* ------------------------------------------------------------ locks */
typedef struct {
    u32 used, type, owner, shared, recursion, saved_irql, refusals, acquires;
} NtLock;
static NtLock LOCKS[NT_MAX_LOCK];
static NtLock *lock_of(u32 id) { return (id && id < NT_MAX_LOCK && LOCKS[id].used) ? &LOCKS[id] : 0; }
i32 k_lock_create(u32 type) {
    u32 i;
    if (type < LOCK_SPIN || type > LOCK_GUARDED_MUTEX) return (i32)ST_INVALID_PARAM;
    for (i = 1; i < NT_MAX_LOCK; i++) if (!LOCKS[i].used) {
        z(&LOCKS[i], sizeof(NtLock)); LOCKS[i].used = 1; LOCKS[i].type = type;
        return (i32)i;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
static i32 lock_refuse(NtLock *l, i32 status) { if (l) l->refusals++; return status; }
i32 k_lock_acquire(u32 id, u32 tid, u32 mode) {
    NtLock *l = lock_of(id);
    u32 old_irql;
    if (!l || !tid || mode > LOCK_EXCLUSIVE) return (i32)ST_INVALID_PARAM;
    if ((l->type == LOCK_SPIN || l->type == LOCK_QUEUED_SPIN) && mode != LOCK_EXCLUSIVE)
        return lock_refuse(l, (i32)ST_INVALID_PARAM);
    if ((l->type == LOCK_SPIN || l->type == LOCK_QUEUED_SPIN) && k_irql() >= IRQL_HIGH)
        return lock_refuse(l, (i32)ST_INVALID_DEVICE_REQ);
    if ((l->type == LOCK_FAST_MUTEX || l->type == LOCK_GUARDED_MUTEX) && k_irql() >= IRQL_APC)
        return lock_refuse(l, (i32)ST_INVALID_DEVICE_REQ);
    if ((l->type == LOCK_ERESOURCE || l->type == LOCK_PUSHLOCK) && k_irql() >= IRQL_DISPATCH)
        return lock_refuse(l, (i32)ST_INVALID_DEVICE_REQ);
    if (l->owner == tid && mode == LOCK_EXCLUSIVE) {
        if (l->type == LOCK_ERESOURCE || l->type == LOCK_PUSHLOCK) {
            l->recursion++; l->acquires++; return 0;
        }
        return lock_refuse(l, (i32)ST_RECURSIVE_LOCK);
    }
    if (mode == LOCK_SHARED) {
        if (l->type != LOCK_ERESOURCE && l->type != LOCK_PUSHLOCK)
            return lock_refuse(l, (i32)ST_INVALID_PARAM);
        if (l->owner || l->shared == 0xFFFFFFFFu)
            return lock_refuse(l, (i32)ST_RESOURCE_IN_USE);
        l->shared++; l->acquires++; return 0;
    }
    if (l->owner || l->shared) return lock_refuse(l, (i32)ST_RESOURCE_IN_USE);
    old_irql = k_irql();
    l->saved_irql = old_irql;
    l->owner = tid; l->recursion = 1; l->acquires++;
    if (l->type == LOCK_SPIN || l->type == LOCK_QUEUED_SPIN) k_irql_raise(IRQL_DISPATCH);
    else if (l->type == LOCK_FAST_MUTEX || l->type == LOCK_GUARDED_MUTEX) k_irql_raise(IRQL_APC);
    return 0;
}
i32 k_lock_release(u32 id, u32 tid, u32 mode) {
    NtLock *l = lock_of(id);
    if (!l || !tid || mode > LOCK_EXCLUSIVE) return (i32)ST_INVALID_PARAM;
    if (mode == LOCK_SHARED) {
        if ((l->type != LOCK_ERESOURCE && l->type != LOCK_PUSHLOCK) || !l->shared)
            return lock_refuse(l, (i32)ST_ACCESS_DENIED);
        l->shared--;
        return 0;
    }
    if (l->owner != tid) return lock_refuse(l, (i32)ST_ACCESS_DENIED);
    if (l->recursion > 1) { l->recursion--; return 0; }
    l->owner = 0; l->recursion = 0;
    if (l->type == LOCK_SPIN || l->type == LOCK_QUEUED_SPIN ||
        l->type == LOCK_FAST_MUTEX || l->type == LOCK_GUARDED_MUTEX)
        k_irql_lower(l->saved_irql);
    return 0;
}
u32 k_lock_field(u32 id, u32 field) {
    NtLock *l = lock_of(id);
    if (!l) return 0;
    switch (field) {
        case 0: return l->type;
        case 1: return (l->owner || l->shared) ? 1u : 0u;
        case 2: return l->owner;
        case 3: return l->shared;
        case 4: return l->recursion;
        case 5: return l->refusals;
        case 6: return l->acquires;
        case 7: return l->saved_irql;
        default: return 0;
    }
}
i32 k_spinlock_create(void) { return k_lock_create(LOCK_SPIN); }
i32 k_spinlock_acquire(u32 id, u32 tid) { return k_lock_acquire(id, tid, LOCK_EXCLUSIVE); }
i32 k_spinlock_release(u32 id, u32 tid) { return k_lock_release(id, tid, LOCK_EXCLUSIVE); }
i32 k_pushlock_create(void) { return k_lock_create(LOCK_PUSHLOCK); }
i32 k_pushlock_acquire(u32 id, u32 tid, u32 exclusive) {
    return k_lock_acquire(id, tid, exclusive ? LOCK_EXCLUSIVE : LOCK_SHARED);
}
i32 k_pushlock_release(u32 id, u32 tid, u32 exclusive) {
    return k_lock_release(id, tid, exclusive ? LOCK_EXCLUSIVE : LOCK_SHARED);
}

/* -------------------------------------------------------- work items */
typedef struct { u32 used, proc_id, data, run_irql, runs; } NtWork;
static NtWork WORK[NT_MAX_WORK];
i32 k_work_queue(u32 proc_id, u32 data) {
    u32 i;
    if (k_irql() > IRQL_DISPATCH) { irql_violations++; return (i32)ST_INVALID_DEVICE_REQ; }
    for (i = 1; i < NT_MAX_WORK; i++) if (!WORK[i].used) {
        z(&WORK[i], sizeof(NtWork)); WORK[i].used = 1; WORK[i].proc_id = proc_id; WORK[i].data = data;
        return (i32)i;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_work_drain(void) {
    u32 i, n = 0;
    if (k_irql() != IRQL_PASSIVE) { irql_violations++; return (i32)ST_INVALID_DEVICE_REQ; }
    for (i = 1; i < NT_MAX_WORK; i++) if (WORK[i].used) {
        WORK[i].run_irql = IRQL_PASSIVE; WORK[i].runs++; WORK[i].used = 0; n++;
    }
    return (i32)n;
}
u32 k_work_pending(void) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_WORK; i++) if (WORK[i].used) n++;
    return n;
}
u32 k_work_field(u32 id, u32 field) {
    NtWork *w = (id && id < NT_MAX_WORK) ? &WORK[id] : 0;
    if (!w) return 0;
    switch (field) {
        case 0: return w->used;
        case 1: return w->proc_id;
        case 2: return w->data;
        case 3: return w->run_irql;
        case 4: return w->runs;
        default: return 0;
    }
}

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

/* --------------------------------------------------------------- ETW model */
typedef struct { u32 used, name_off, name_len, events, dropped; } NtEtwProvider;
typedef struct {
    u32 used, name_off, name_len, capacity, count, dropped, head, tail;
    u32 provider[NT_MAX_ETW_PROVIDER], level[NT_MAX_ETW_PROVIDER], keywords[NT_MAX_ETW_PROVIDER];
    u32 slots[64];
} NtEtwSession;
typedef struct {
    u32 used, provider, event_id, level, keywords, tid, timestamp, data_len;
    u8 data[NT_ETW_PAYLOAD];
} NtEtwEvent;
static NtEtwProvider ETW_PROVIDER[NT_MAX_ETW_PROVIDER];
static NtEtwSession ETW_SESSION[NT_MAX_ETW_SESSION];
static NtEtwEvent ETW_EVENT[NT_MAX_ETW_EVENT];
static NtEtwEvent ETW_LAST;
static u32 etw_time_ms, etw_sched_provider, etw_io_provider, etw_mm_provider;
static u32 etw_last_event;
static u32 etw_sessions_live;

static NtEtwProvider *etw_provider(u32 id) {
    return (id && id < NT_MAX_ETW_PROVIDER && ETW_PROVIDER[id].used) ? &ETW_PROVIDER[id] : 0;
}
static NtEtwSession *etw_session(u32 id) {
    return (id && id < NT_MAX_ETW_SESSION && ETW_SESSION[id].used) ? &ETW_SESSION[id] : 0;
}
i32 k_etw_register_provider(u32 name_ptr, u32 name_len) {
    u32 i, off;
    if (!name_ptr || !name_len || name_len > 63u) return (i32)ST_INVALID_PARAM;
    for (i = 1; i < NT_MAX_ETW_PROVIDER; i++)
        if (ETW_PROVIDER[i].used && ETW_PROVIDER[i].name_len == name_len &&
            cieq(N(ETW_PROVIDER[i].name_off), (const char *)name_ptr, name_len)) return (i32)i;
    for (i = 1; i < NT_MAX_ETW_PROVIDER; i++) if (!ETW_PROVIDER[i].used) break;
    if (i >= NT_MAX_ETW_PROVIDER) return (i32)ST_INSUFFICIENT_RES;
    off = name_store(name_ptr, name_len);
    if (!off) return (i32)ST_INSUFFICIENT_RES;
    ETW_PROVIDER[i].used = 1; ETW_PROVIDER[i].name_off = off; ETW_PROVIDER[i].name_len = name_len;
    return (i32)i;
}
i32 k_etw_start_session(u32 name_ptr, u32 name_len, u32 capacity) {
    u32 i, off;
    if (!name_ptr || !name_len || name_len > 63u) return (i32)ST_INVALID_PARAM;
    if (!capacity) capacity = 64u;
    if (capacity > 64u) capacity = 64u;
    for (i = 1; i < NT_MAX_ETW_SESSION; i++) if (!ETW_SESSION[i].used) break;
    if (i >= NT_MAX_ETW_SESSION) return (i32)ST_INSUFFICIENT_RES;
    off = name_store(name_ptr, name_len);
    if (!off) return (i32)ST_INSUFFICIENT_RES;
    z(&ETW_SESSION[i], sizeof(NtEtwSession));
    ETW_SESSION[i].used = 1; ETW_SESSION[i].name_off = off; ETW_SESSION[i].name_len = name_len;
    ETW_SESSION[i].capacity = capacity;
    etw_sessions_live++;
    return (i32)i;
}
i32 k_etw_enable_provider(u32 session, u32 provider, u32 level, u32 keywords) {
    NtEtwSession *s = etw_session(session); u32 i;
    if (!s || !etw_provider(provider)) return (i32)ST_OBJECT_NAME_NOT_FOUND;
    for (i = 0; i < NT_MAX_ETW_PROVIDER; i++) if (s->provider[i] == provider || !s->provider[i]) {
        s->provider[i] = provider; s->level[i] = level ? level : 255u; s->keywords[i] = keywords; return 0;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
static u32 etw_enabled(NtEtwSession *s, u32 provider, u32 level, u32 keywords) {
    u32 i;
    for (i = 0; i < NT_MAX_ETW_PROVIDER; i++) if (s->provider[i] == provider) {
        if (level > s->level[i]) return 0;
        if (s->keywords[i] && !(s->keywords[i] & keywords)) return 0;
        return 1;
    }
    return 0;
}
i32 k_etw_write(u32 provider, u32 event_id, u32 level, u32 keywords, u32 data, u32 len, u32 tid) {
    u32 i, e, next;
    NtEtwProvider *p = etw_provider(provider);
    if (!p) return (i32)ST_OBJECT_NAME_NOT_FOUND;
    if (len > NT_ETW_PAYLOAD) len = NT_ETW_PAYLOAD;
    p->events++;
    for (i = 1; i < NT_MAX_ETW_SESSION; i++) {
        NtEtwSession *s = &ETW_SESSION[i];
        if (!s->used || !etw_enabled(s, provider, level, keywords)) continue;
        next = (s->tail + 1u) % s->capacity;
        if (next == s->head) { s->dropped++; p->dropped++; continue; }
        for (e = 1; e < NT_MAX_ETW_EVENT; e++) if (!ETW_EVENT[e].used) break;
        if (e >= NT_MAX_ETW_EVENT) { s->dropped++; p->dropped++; continue; }
        ETW_EVENT[e].used = 1; ETW_EVENT[e].provider = provider; ETW_EVENT[e].event_id = event_id;
        ETW_EVENT[e].level = level; ETW_EVENT[e].keywords = keywords; ETW_EVENT[e].tid = tid;
        ETW_EVENT[e].timestamp = etw_time_ms; ETW_EVENT[e].data_len = len;
        if (len) cp(ETW_EVENT[e].data, (const void *)data, len);
        s->slots[s->tail] = e; s->tail = next; s->count++;
    }
    return 0;
}
u32 k_etw_drain(u32 session, u32 max_events) {
    NtEtwSession *s = etw_session(session); u32 n = 0;
    if (!s) return 0;
    while (n < max_events && s->head != s->tail) {
        u32 e = s->slots[s->head];
        s->head = (s->head + 1u) % s->capacity;
        if (s->count) s->count--;
        etw_last_event = e;
        if (e && e < NT_MAX_ETW_EVENT) { ETW_LAST = ETW_EVENT[e]; ETW_EVENT[e].used = 0; }
        n++;
    }
    return n;
}
u32 k_etw_event_field(u32 session, u32 f) {
    NtEtwSession *s = etw_session(session); NtEtwEvent *e;
    if (!s) return 0;
    if (f == 7u) return s->dropped;
    if (f == 8u) return s->count;
    e = etw_last_event ? &ETW_LAST : 0;
    if (!e) return 0;
    switch (f) {
        case 0: return e->provider; case 1: return e->event_id; case 2: return e->level;
        case 3: return e->keywords; case 4: return e->tid; case 5: return e->timestamp;
        case 6: return e->data_len; default: return 0;
    }
}
u32 k_etw_event_ptr(void) {
    NtEtwEvent *e = etw_last_event ? &ETW_LAST : 0;
    if (!e) return 0;
    if (e->data_len) cp(TMP, e->data, e->data_len);
    tmp_len = e->data_len;
    return (u32)TMP;
}
u32 k_etw_event_len(void) { return etw_last_event ? ETW_LAST.data_len : 0; }
static void etw_emit(u32 provider, u32 event_id, u32 level, u32 keywords, u32 data, u32 len, u32 tid) {
    if (provider && etw_sessions_live) (void)k_etw_write(provider, event_id, level, keywords, data, len, tid);
}

/* the executive heartbeat: DPC drain at DISPATCH_LEVEL, APC delivery,
   scheduler accounting, wait timeouts and starvation aging. */
static u32 last_tick_ms;
u32 nt_tick(u32 now_ms, u32 dt_ms) {
    u32 i, ran = 0, prev_irql;
    if (k_bugcheck_state(5)) return 0;                 /* halted: nothing runs */
    if (now_ms < last_tick_ms) now_ms = last_tick_ms;
    last_tick_ms = now_ms;
    etw_time_ms = now_ms;
    {
        u32 tick_event[2];
        tick_event[0] = dt_ms; tick_event[1] = etw_sessions_live ? ready_depth() : 0u;
        if (etw_sessions_live) etw_emit(etw_sched_provider, 1u, 4u, 1u, (u32)tick_event, sizeof(tick_event), cur_tid);
    }

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
                if (t->state == TH_WAIT) wait_mark_complete(t, ST_USER_APC);
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
            wait_detach(t);
            t->wait_result = ST_TIMEOUT;
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
            t = th(k_cpu_ready_index(current_cpu, p));
            if (t) {
                if (cur_tid && th(cur_tid) && th(cur_tid)->state == TH_RUN) th(cur_tid)->state = TH_READY;
                t->state = TH_RUN;
                t->processor = current_cpu;
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
            } else {
                idle_ticks[current_cpu]++;
            }
            if (ran) break;
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
typedef struct { u32 used, id, driver, type, lower, depth, queue_depth, name_off, name_len, irp_total, oid;
                u32 pnp_state, power_state, open_handles, starts, query_removes, removes; } NtDevice;
typedef struct {
    u32 used, id, dev, current_dev, major, minor, status, bytes, in_len, out_len;
    u32 depth, completed, cancelled, retried, owner_pid;
    u32 completion_port, completion_key, completion_posted, pending;
    u32 stack[8];
} NtIrp;

typedef struct { u32 used, id, concurrency, assoc_device, assoc_key, head, tail, depth;
                u32 posts, gets, last_key, last_bytes, last_status, last_irp; } NtIocp;
typedef struct { u32 used, id, port, key, bytes, status, irp, next; } NtIocpPacket;
typedef struct { u32 used, id, owner_pid, peer, connected, closed, max_messages;
                u32 head, tail, queued, sent, received; } NtAlpcPort;
typedef struct { u32 used, id, next, sender, receiver, token, len, section, reply_to, status, done;
                u8 data[NT_ALPC_DATA]; } NtAlpcMessage;

static NtDriver DRV[NT_MAX_DRIVER];
static NtDevice DEV[NT_MAX_DEVICE];
static NtIrp IRP[NT_MAX_IRP];
static NtIocp IOCP[NT_MAX_IOCP];
static NtIocpPacket IOCP_PACKET[NT_MAX_IOCP_PKT];
static NtAlpcPort ALPC[NT_MAX_ALPC];
static NtAlpcMessage ALPC_MSG[NT_MAX_ALPC_MSG];
static u32 io_created, io_completed, io_failed, io_overflow, io_cancelled, io_queued;

static NtDriver *drv(u32 id) { return (id && id < NT_MAX_DRIVER && DRV[id].used) ? &DRV[id] : 0; }
static NtDevice *dev(u32 id) { return (id && id < NT_MAX_DEVICE && DEV[id].used) ? &DEV[id] : 0; }
static NtIrp *irp(u32 id) { return (id && id < NT_MAX_IRP && IRP[id].used) ? &IRP[id] : 0; }
static NtIocp *iocp(u32 id) { return (id && id < NT_MAX_IOCP && IOCP[id].used) ? &IOCP[id] : 0; }
static NtAlpcPort *alpc(u32 id) { return (id && id < NT_MAX_ALPC && ALPC[id].used) ? &ALPC[id] : 0; }
static NtAlpcMessage *alpc_msg(u32 id) { return (id && id < NT_MAX_ALPC_MSG && ALPC_MSG[id].used) ? &ALPC_MSG[id] : 0; }

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
            DEV[i].pnp_state = PNP_ADDED; DEV[i].power_state = POWER_D3;
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
i32 k_device_open(u32 id) {
    NtDevice *d = dev(id);
    if (!d) return (i32)ST_INVALID_PARAM;
    if (d->pnp_state == PNP_REMOVED) return (i32)ST_DELETE_PENDING;
    d->open_handles++;
    return 0;
}
i32 k_device_close(u32 id) {
    NtDevice *d = dev(id);
    if (!d || !d->open_handles) return (i32)ST_INVALID_PARAM;
    d->open_handles--;
    return 0;
}
i32 k_pnp_start(u32 id) {
    NtDevice *d = dev(id);
    if (!d || d->pnp_state == PNP_REMOVED) return (i32)ST_DELETE_PENDING;
    if (d->pnp_state == PNP_STARTED) return 0;
    d->pnp_state = PNP_STARTED; d->power_state = POWER_D0; d->starts++;
    return 0;
}
i32 k_pnp_query_remove(u32 id) {
    NtDevice *d = dev(id);
    if (!d || d->pnp_state == PNP_REMOVED) return (i32)ST_DELETE_PENDING;
    if (d->pnp_state != PNP_STARTED) return (i32)ST_INVALID_DEVICE_REQ;
    if (d->open_handles) return (i32)ST_DEVICE_BUSY;
    d->pnp_state = PNP_QUERY_REMOVE; d->query_removes++;
    return 0;
}
i32 k_pnp_cancel_remove(u32 id) {
    NtDevice *d = dev(id);
    if (!d || d->pnp_state != PNP_QUERY_REMOVE) return (i32)ST_INVALID_DEVICE_REQ;
    d->pnp_state = PNP_STARTED;
    return 0;
}
i32 k_pnp_remove(u32 id) {
    NtDevice *d = dev(id);
    if (!d || d->pnp_state == PNP_REMOVED) return (i32)ST_DELETE_PENDING;
    if (d->pnp_state != PNP_QUERY_REMOVE || d->open_handles) return (i32)ST_DEVICE_BUSY;
    d->pnp_state = PNP_REMOVED; d->power_state = POWER_D3; d->removes++;
    return 0;
}
i32 k_pnp_set_power(u32 id, u32 state) {
    NtDevice *d = dev(id);
    if (!d || state > POWER_D3) return (i32)ST_INVALID_PARAM;
    if (d->pnp_state != PNP_STARTED) return (i32)ST_INVALID_DEVICE_REQ;
    d->power_state = state;
    return 0;
}
u32 k_pnp_field(u32 id, u32 field) {
    NtDevice *d = dev(id);
    if (!d) return 0;
    switch (field) {
        case 0: return d->pnp_state;
        case 1: return d->power_state;
        case 2: return d->open_handles;
        case 3: return d->starts;
        case 4: return d->query_removes;
        case 5: return d->removes;
        default: return d->driver;
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
 i32 k_iocp_create(u32 concurrency) {
    u32 i;
    for (i = 1; i < NT_MAX_IOCP; i++) if (!IOCP[i].used) {
        z(&IOCP[i], sizeof(NtIocp)); IOCP[i].used = 1; IOCP[i].id = i;
        IOCP[i].concurrency = concurrency;
        return (i32)i;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_iocp_associate(u32 port, u32 device, u32 key) {
    NtIocp *p = iocp(port);
    if (!p || !dev(device)) return (i32)ST_INVALID_PARAM;
    if (p->assoc_device && p->assoc_device != device) return (i32)ST_ACCESS_DENIED;
    p->assoc_device = device; p->assoc_key = key;
    return 0;
}
i32 k_iocp_post(u32 port, u32 key, u32 bytes, u32 status, u32 id) {
    NtIocp *p = iocp(port);
    u32 i, packet = 0;
    if (!p) return (i32)ST_INVALID_PARAM;
    if (p->depth >= NT_MAX_IOCP_PKT) return (i32)ST_INSUFFICIENT_RES;
    for (i = 1; i < NT_MAX_IOCP_PKT; i++) if (!IOCP_PACKET[i].used) { packet = i; break; }
    if (!packet) return (i32)ST_INSUFFICIENT_RES;
    IOCP_PACKET[packet].used = 1; IOCP_PACKET[packet].id = packet; IOCP_PACKET[packet].port = port;
    IOCP_PACKET[packet].key = key; IOCP_PACKET[packet].bytes = bytes;
    IOCP_PACKET[packet].status = status; IOCP_PACKET[packet].irp = id; IOCP_PACKET[packet].next = 0;
    if (p->tail) IOCP_PACKET[p->tail].next = packet; else p->head = packet;
    p->tail = packet; p->depth++; p->posts++;
    return (i32)packet;
}
i32 k_iocp_get(u32 port, u32 timeout_ms) {
    NtIocp *p = iocp(port);
    NtIocpPacket *q;
    u32 packet;
    (void)timeout_ms;
    if (!p) return (i32)ST_INVALID_PARAM;
    if (!p->head) return (i32)ST_TIMEOUT;
    packet = p->head; q = &IOCP_PACKET[packet];
    p->head = q->next; if (!p->head) p->tail = 0;
    if (p->depth) p->depth--; p->gets++;
    p->last_key = q->key; p->last_bytes = q->bytes; p->last_status = q->status; p->last_irp = q->irp;
    q->used = 0;
    return (i32)packet;
}
u32 k_iocp_field(u32 port, u32 field) {
    NtIocp *p = iocp(port);
    if (!p) return 0;
    switch (field) {
        case 0: return p->depth;
        case 1: return p->posts;
        case 2: return p->gets;
        case 3: return p->last_key;
        case 4: return p->last_bytes;
        case 5: return p->last_status;
        case 6: return p->last_irp;
        default: return p->assoc_device;
    }
}
u32 k_iocp_packet_field(u32 packet, u32 field) {
    NtIocpPacket *q = (packet && packet < NT_MAX_IOCP_PKT) ? &IOCP_PACKET[packet] : 0;
    if (!q) return 0;
    switch (field) {
        case 0: return q->port;
        case 1: return q->key;
        case 2: return q->bytes;
        case 3: return q->status;
        case 4: return q->irp;
        default: return q->used;
    }
}
i32 k_alpc_create(u32 owner_pid, u32 max_messages) {
    u32 i;
    if (max_messages > NT_MAX_ALPC_MSG) return (i32)ST_INVALID_PARAM;
    if (!max_messages) max_messages = 16;
    for (i = 1; i < NT_MAX_ALPC; i++) if (!ALPC[i].used) {
        z(&ALPC[i], sizeof(NtAlpcPort)); ALPC[i].used = 1; ALPC[i].id = i;
        ALPC[i].owner_pid = owner_pid; ALPC[i].max_messages = max_messages;
        return (i32)i;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_alpc_connect(u32 client, u32 server) {
    NtAlpcPort *c = alpc(client), *s = alpc(server);
    if (!c || !s || client == server || c->closed || s->closed || c->peer || s->peer)
        return (i32)ST_ACCESS_DENIED;
    c->peer = server; s->peer = client; c->connected = s->connected = 1;
    return 0;
}
i32 k_alpc_accept(u32 server, u32 client) { return k_alpc_connect(client, server); }
i32 k_alpc_close(u32 id) {
    NtAlpcPort *p = alpc(id);
    NtAlpcPort *peer;
    if (!p) return (i32)ST_INVALID_PARAM;
    p->closed = 1; p->connected = 0;
    peer = alpc(p->peer);
    if (peer) { peer->peer = 0; peer->connected = 0; }
    p->peer = 0;
    return 0;
}
static i32 alpc_enqueue(NtAlpcPort *receiver, u32 sender, u32 token, const u8 *src,
                        u32 len, u32 section, u32 reply_to, u32 status) {
    u32 i, id = 0;
    NtAlpcMessage *m;
    if (!receiver || receiver->closed) return (i32)ST_PORT_CLOSED;
    if (receiver->queued >= receiver->max_messages) return (i32)ST_INSUFFICIENT_RES;
    for (i = 1; i < NT_MAX_ALPC_MSG; i++) if (!ALPC_MSG[i].used) { id = i; break; }
    if (!id) return (i32)ST_INSUFFICIENT_RES;
    m = &ALPC_MSG[id]; z(m, sizeof(NtAlpcMessage)); m->used = 1; m->id = id;
    m->sender = sender; m->receiver = receiver->id; m->token = token; m->len = len;
    m->section = section; m->reply_to = reply_to; m->status = status;
    if (src && len) cp(m->data, src, len);
    if (receiver->tail) ALPC_MSG[receiver->tail].next = id; else receiver->head = id;
    receiver->tail = id; receiver->queued++;
    return (i32)id;
}
i32 k_alpc_send(u32 id, u32 token, u32 data_ptr, u32 data_len, u32 section) {
    NtAlpcPort *p = alpc(id), *peer;
    if (!p || data_len > NT_ALPC_DATA) return (i32)ST_INVALID_PARAM;
    if (p->closed || !p->peer) return (i32)ST_PORT_CLOSED;
    if (token && !k_sid_of(token)) return (i32)ST_ACCESS_DENIED;
    peer = alpc(p->peer);
    if (!peer) return (i32)ST_PORT_CLOSED;
    { i32 r = alpc_enqueue(peer, id, token, (const u8 *)data_ptr, data_len, section, 0, ST_SUCCESS);
      if (r > 0) p->sent++;
      return r;
    }
}
i32 k_alpc_receive(u32 id, u32 timeout_ms) {
    NtAlpcPort *p = alpc(id);
    NtAlpcMessage *m;
    u32 msg;
    (void)timeout_ms;
    if (!p) return (i32)ST_INVALID_PARAM;
    if (!p->head) return p->closed ? (i32)ST_PORT_CLOSED : (i32)ST_TIMEOUT;
    msg = p->head; m = &ALPC_MSG[msg]; p->head = m->next;
    if (!p->head) p->tail = 0;
    m->next = 0; if (p->queued) p->queued--; p->received++;
    return (i32)msg;
}
i32 k_alpc_reply(u32 id, u32 message, u32 status) {
    NtAlpcPort *p = alpc(id), *peer;
    NtAlpcMessage *m = alpc_msg(message);
    if (!p || !m || m->receiver != id || m->done) return (i32)ST_INVALID_PARAM;
    peer = alpc(m->sender);
    if (!peer || peer->closed) return (i32)ST_PORT_CLOSED;
    { i32 r = alpc_enqueue(peer, id, 0, 0, 0, 0, message, status);
      if (r > 0) m->done = 1;
      return r;
    }
}
i32 k_alpc_message_release(u32 id) {
    NtAlpcMessage *m = alpc_msg(id);
    if (!m) return (i32)ST_INVALID_PARAM;
    z(m, sizeof(NtAlpcMessage));
    return 0;
}
u32 k_alpc_field(u32 id, u32 field) {
    NtAlpcPort *p = alpc(id);
    if (!p) return 0;
    switch (field) {
        case 0: return p->owner_pid;
        case 1: return p->peer;
        case 2: return p->connected;
        case 3: return p->closed;
        case 4: return p->queued;
        case 5: return p->sent;
        case 6: return p->received;
        default: return p->max_messages;
    }
}
u32 k_alpc_message_field(u32 id, u32 field) {
    NtAlpcMessage *m = alpc_msg(id);
    if (!m) return 0;
    switch (field) {
        case 0: return m->sender;
        case 1: return m->token;
        case 2: return m->len;
        case 3: return m->section;
        case 4: return m->reply_to;
        case 5: return m->status;
        case 6: return (u32)m->data;
        default: return m->receiver;
    }
}
i32 k_irp_associate_completion(u32 id, u32 port, u32 key) {
    NtIrp *r = irp(id);
    NtIocp *p = iocp(port);
    if (!r || !p || (p->assoc_device && p->assoc_device != r->dev)) return (i32)ST_INVALID_PARAM;
    r->completion_port = port; r->completion_key = key;
    return 0;
}
i32 k_io_mark_pending(u32 id) {
    NtIrp *r = irp(id);
    if (!r || r->completed) return (i32)ST_INVALID_PARAM;
    r->pending = 1; r->status = 0x00000103u;
    return (i32)ST_MORE_PROCESSING;
}
static void irp_finish(NtIrp *r, u32 status) {
    u32 ev[3];
    r->status = status;
    r->completed = 1;
    r->bytes = (status == ST_SUCCESS) ? r->out_len : 0;
    io_completed++;
    if (status != ST_SUCCESS) {
        io_failed++;
        if (drv(DEV[r->dev].driver)) DRV[DEV[r->dev].driver].irps_failed++;
    }
    if (DEV[r->dev].queue_depth) DEV[r->dev].queue_depth--;
    if (r->completion_port && !r->completion_posted) {
        (void)k_iocp_post(r->completion_port, r->completion_key, r->bytes, status, r->id);
        r->completion_posted = 1;
    }
    ev[0] = r->id; ev[1] = status; ev[2] = r->bytes;
    etw_emit(etw_io_provider, 1u, status == ST_SUCCESS ? 4u : 2u, 1u, (u32)ev, sizeof(ev), cur_tid);
}
i32 k_io_call_driver(u32 id) {
    NtIrp *r = irp(id);
    u32 guard = 0;
    if (!r) return -1;
    if (r->completed) return (i32)r->status;
    if (dev(r->dev) && DEV[r->dev].pnp_state == PNP_REMOVED) {
        irp_finish(r, ST_DELETE_PENDING);
        return (i32)r->status;
    }
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
    u32 i;
    if (!r) return 0;
    if (r->completed) return r->status;
    irp_finish(r, status);
    r->bytes = bytes;
    if (r->completion_port && r->completion_posted)
        for (i = 1; i < NT_MAX_IOCP_PKT; i++)
            if (IOCP_PACKET[i].used && IOCP_PACKET[i].port == r->completion_port && IOCP_PACKET[i].irp == id)
                IOCP_PACKET[i].bytes = bytes;
    return r->status;
}
i32 k_io_cancel(u32 id) {
    NtIrp *r = irp(id);
    if (!r) return (i32)ST_INVALID_PARAM;
    if (r->completed) return (i32)r->status;
    if (r->cancelled) return (i32)ST_ACCESS_DENIED;
    r->cancelled = 1; io_cancelled++;
    (void)k_io_complete(id, ST_INVALID_DEVICE_REQ, 0);
    return 0;
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
        case 10: return r->completion_port;
        case 11: return r->completion_key;
        case 12: return r->completion_posted;
        case 13: return r->pending;
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
typedef struct { u32 used, vaddr, bytes, committed, protect, section, pfn_count, cow_private, copy_on_write, large_page, paged_out, prototype_faults; } NtRegion;
static NtRegion REG[NT_MAX_PID][NT_MAX_REGION];
static u32 VM_NEXT[NT_MAX_PID], PID_VSIZE[NT_MAX_PID], PID_COMMIT[NT_MAX_PID];
static u32 PID_WORKING[NT_MAX_PID], PID_FAULTS[NT_MAX_PID];
static u32 commit_charge, commit_limit = NT_COMMIT_LIMIT, commit_peak, commit_failures;
static u32 pool_paged, pool_paged_peak, pool_nonpaged, pool_np_peak;
static u32 hive_skips;                              /* oversized values not loaded */
static u32 pool_free_head;
static u8  POOL[NT_POOL_BYTES];
static u32 vm_regions_total;
typedef struct { u32 used, ptr, bytes, paged, tag, owner, nx; } NtPoolAlloc;
static NtPoolAlloc POOL_ALLOC[NT_MAX_POOL_ALLOC];
static u32 POOL_QUOTA[NT_MAX_PID], POOL_CHARGE[NT_MAX_PID];
static u32 pool_live, pool_bad_frees, pool_quota_fails, pool_nx;
static u32 pagefile_slots, pagefile_outs, pagefile_ins, pagefile_failures;

/* A bounded segment heap model: each heap owns a set of variable-size
   segments carved from a fixed arena, while the block table models split and
   coalesced free ranges.  The arena is deliberately finite so growth and
   metadata exhaustion remain observable allocation failures. */
typedef struct {
    u32 used, id, owner, initial, maximum, reserved, committed, live;
    u32 allocs, frees, segments, failures, flags, closed;
} NtSegHeap;
typedef struct { u32 used, heap, off, bytes, allocated, tag; } NtSegBlock;
static u8 SEGMENT_POOL[NT_SEGMENT_POOL_BYTES];
static NtSegHeap SEG_HEAP[NT_MAX_SEG_HEAP];
static NtSegBlock SEG_BLOCK[NT_MAX_SEG_BLOCK];
static u32 segment_top;

typedef struct { u32 used, id, parent, memory_limit, charge, kill_on_close, silo, closed, member_count;
                u32 members[8]; } NtJob;
static NtJob JOB[NT_MAX_JOB];
static u32 PID_JOB[NT_MAX_PID];
static NtJob *job_of(u32 id) { return (id && id < NT_MAX_JOB && JOB[id].used) ? &JOB[id] : 0; }
i32 k_job_create(u32 parent, u32 memory_limit, u32 kill_on_close, u32 silo) {
    u32 i;
    if (parent && !job_of(parent)) return (i32)ST_INVALID_PARAM;
    for (i = 1; i < NT_MAX_JOB; i++) if (!JOB[i].used) {
        z(&JOB[i], sizeof(NtJob)); JOB[i].used = 1; JOB[i].id = i; JOB[i].parent = parent;
        JOB[i].memory_limit = memory_limit; JOB[i].kill_on_close = kill_on_close ? 1u : 0u;
        JOB[i].silo = silo ? 1u : 0u;
        return (i32)i;
    }
    return (i32)ST_INSUFFICIENT_RES;
}
i32 k_job_assign(u32 id, u32 pid) {
    NtJob *j = job_of(id);
    if (!j || j->closed || !pid || pid >= NT_MAX_PID || PID_JOB[pid] || j->member_count >= 8)
        return (i32)ST_INVALID_PARAM;
    if (!k_thread_of_proc(pid)) return (i32)ST_INVALID_PARAM;
    if (j->memory_limit && j->charge + PID_COMMIT[pid] > j->memory_limit) return (i32)ST_JOB_LIMIT;
    j->members[j->member_count++] = pid; PID_JOB[pid] = id;
    j->charge += PID_COMMIT[pid];
    return 0;
}
i32 k_job_set_limit(u32 id, u32 memory_limit) {
    NtJob *j = job_of(id);
    if (!j || j->closed || (memory_limit && memory_limit < j->charge)) return (i32)ST_JOB_LIMIT;
    j->memory_limit = memory_limit;
    return 0;
}
i32 k_job_close(u32 id) {
    NtJob *j = job_of(id);
    u32 i, pid;
    if (!j || j->closed) return (i32)ST_INVALID_PARAM;
    j->closed = 1;
    if (j->kill_on_close) {
        for (i = 0; i < j->member_count; i++) { pid = j->members[i]; if (pid) (void)k_process_terminate(pid); }
    }
    for (i = 0; i < j->member_count; i++) if (j->members[i] < NT_MAX_PID) PID_JOB[j->members[i]] = 0;
    j->member_count = 0;
    return 0;
}
u32 k_job_field(u32 id, u32 field) {
    NtJob *j = job_of(id);
    if (!j) return 0;
    switch (field) {
        case 0: return j->parent;
        case 1: return j->member_count;
        case 2: return j->memory_limit;
        case 3: return j->charge;
        case 4: return j->kill_on_close;
        case 5: return j->silo;
        case 6: return j->closed;
        default: return 0;
    }
}

typedef struct { u32 used, bytes, protect, refs, mappings, gpa, cow, cow_faults, prototype, prototype_faults; } NtSection;
static NtSection SEC[NT_MAX_SECTION];
typedef struct { u32 used, state, refcount, owner_pid, modified, pagefile_slot; } NtPfn;
static NtPfn PFN[NT_MAX_PFN];
static u32 pfn_take(u32 owner) {
    u32 state, i;
    for (state = PFN_ZEROED; state <= PFN_STANDBY; state++)
        for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].state == state) {
            PFN[i].state = PFN_ACTIVE; PFN[i].refcount = 1; PFN[i].owner_pid = owner; return i;
        }
    for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].state == PFN_FREE) {
        PFN[i].state = PFN_ACTIVE; PFN[i].refcount = 1; PFN[i].owner_pid = owner; return i;
    }
    return 0;
}
static u32 pfn_available(void) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].state != PFN_ACTIVE && PFN[i].state != PFN_MODIFIED) n++;
    return n;
}
static u32 pfn_release(u32 owner, u32 count) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_PFN && n < count; i++) if (PFN[i].used && PFN[i].state == PFN_ACTIVE && PFN[i].owner_pid == owner) {
        PFN[i].state = PFN_STANDBY; PFN[i].refcount = 0; n++;
    }
    return n;
}

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
    if (objid) { OBJ[objid].owner_pid = pid; OBJ[objid].owner_sid = k_sid_of(tok); }
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
i32 k_vm_reserve_large(u32 pid, u32 bytes, u32 protect) {
    i32 v; NtRegion *r;
    if (pid >= NT_MAX_PID || !bytes || (bytes % NT_LARGE_PAGE)) return (i32)ST_INVALID_PARAM;
    if (!VM_NEXT[pid]) VM_NEXT[pid] = NT_VM_BASE;
    VM_NEXT[pid] = (VM_NEXT[pid] + NT_LARGE_PAGE - 1u) & ~(NT_LARGE_PAGE - 1u);
    v = k_vm_reserve(pid, bytes, protect & ~VM_LARGE_PAGE);
    if (v < 0) return v;
    r = vm_find(pid, (u32)v); if (r) r->large_page = 1u;
    return v;
}
i32 k_vm_commit(u32 pid, u32 vaddr, u32 bytes) {
    NtRegion *r = vm_find(pid, vaddr);
    u32 charge, pages, i;
    if (!r) return ST_INVALID_PARAM;
    charge = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
    if (charge > r->bytes) charge = r->bytes;
    if (PID_JOB[pid] && job_of(PID_JOB[pid]) && job_of(PID_JOB[pid])->memory_limit &&
        job_of(PID_JOB[pid])->charge + charge > job_of(PID_JOB[pid])->memory_limit)
        return (i32)ST_JOB_LIMIT;
    if (commit_charge + charge > commit_limit) { commit_failures++; return ST_INSUFFICIENT_RES; }
    pages = charge / NT_PAGE;
    if (pfn_available() < pages) { commit_failures++; return ST_INSUFFICIENT_RES; }
    for (i = 0; i < pages; i++) if (!pfn_take(pid)) { commit_failures++; return ST_INSUFFICIENT_RES; }
    r->committed += charge;
    if (r->committed > r->bytes) r->committed = r->bytes;
    commit_charge += charge;
    if (commit_charge > commit_peak) commit_peak = commit_charge;
    PID_COMMIT[pid] += charge;
    if (PID_JOB[pid] && job_of(PID_JOB[pid])) job_of(PID_JOB[pid])->charge += charge;
    r->pfn_count += pages;
    {
        u32 ev[3]; ev[0] = pid; ev[1] = charge; ev[2] = pages;
        etw_emit(etw_mm_provider, 1u, 4u, 1u, (u32)ev, sizeof(ev), cur_tid);
    }
    return 0;
}
i32 k_vm_free(u32 pid, u32 vaddr, u32 bytes) {
    NtRegion *r = vm_find(pid, vaddr);
    u32 release, i;
    if (!r) return -1;
    release = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
    if (release > r->committed) release = r->committed;
    r->committed -= release;
    if (r->paged_out) for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].owner_pid == pid && PFN[i].state == PFN_MODIFIED) {
        PFN[i].state = PFN_FREE; PFN[i].pagefile_slot = 0u; if (pagefile_slots) pagefile_slots--; break;
    }
    (void)pfn_release(pid, r->pfn_count);
    commit_charge = (commit_charge > release) ? commit_charge - release : 0;
    PID_COMMIT[pid] = (PID_COMMIT[pid] > release) ? PID_COMMIT[pid] - release : 0;
    if (PID_JOB[pid] && job_of(PID_JOB[pid])) job_of(PID_JOB[pid])->charge =
        (job_of(PID_JOB[pid])->charge > release) ? job_of(PID_JOB[pid])->charge - release : 0;
    if (PID_VSIZE[pid] >= r->bytes) PID_VSIZE[pid] -= r->bytes;
    if (vm_regions_total) vm_regions_total--;
    z(r, sizeof(NtRegion));
    return 0;
}
i32 k_vm_touch(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr);
    if (!r) { PID_FAULTS[pid]++; return ST_INVALID_PARAM; }
    if (!r->committed) {
        if (!pfn_take(pid)) return ST_INSUFFICIENT_RES;
        r->pfn_count++; PID_FAULTS[pid]++;          /* demand-zero page */
    }
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
u32 k_vm_region_field(u32 pid, u32 vaddr, u32 field) {
    NtRegion *r = vm_find(pid, vaddr);
    if (!r || field > 2u) return 0u;
    if (field == 0u) return r->large_page;
    if (field == 1u) return r->paged_out;
    return r->section && r->section < NT_MAX_SECTION && SEC[r->section].used && SEC[r->section].prototype;
}
i32 k_mm_pageout(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr); u32 i;
    if (!r || !r->pfn_count || r->paged_out) { pagefile_failures++; return (i32)ST_INVALID_PARAM; }
    for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].owner_pid == pid && PFN[i].state == PFN_ACTIVE) {
        PFN[i].state = PFN_MODIFIED; PFN[i].pagefile_slot = i + 1u; r->paged_out = 1u;
        pagefile_slots++; pagefile_outs++;
        PID_WORKING[pid] = (PID_WORKING[pid] > NT_PAGE) ? PID_WORKING[pid] - NT_PAGE : 0u;
        return 0;
    }
    pagefile_failures++; return (i32)ST_INSUFFICIENT_RES;
}
i32 k_mm_pagein(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr); u32 i;
    if (!r || !r->paged_out) { pagefile_failures++; return (i32)ST_INVALID_PARAM; }
    for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].owner_pid == pid && PFN[i].state == PFN_MODIFIED) {
        PFN[i].state = PFN_ACTIVE; PFN[i].pagefile_slot = 0u; r->paged_out = 0u;
        if (pagefile_slots) pagefile_slots--; pagefile_ins++; PID_WORKING[pid] += NT_PAGE; return 0;
    }
    pagefile_failures++; return (i32)ST_INSUFFICIENT_RES;
}
u32 k_mm_pagefile_field(u32 field) {
    switch (field) { case 0: return pagefile_slots; case 1: return pagefile_outs; case 2: return pagefile_ins; case 3: return pagefile_failures; default: return 0u; }
}
i32 k_mm_trim(u32 pid, u32 pages) {
    u32 i, trimmed = 0;
    if (pid >= NT_MAX_PID) return (i32)ST_INVALID_PARAM;
    for (i = 0; i < NT_MAX_REGION && trimmed < pages; i++) if (REG[pid][i].used && !REG[pid][i].paged_out && REG[pid][i].pfn_count) {
        u32 n = REG[pid][i].pfn_count;
        if (n > pages - trimmed) n = pages - trimmed;
        trimmed += pfn_release(pid, n);
        REG[pid][i].pfn_count -= n;
        PID_WORKING[pid] = (PID_WORKING[pid] > n * NT_PAGE) ? PID_WORKING[pid] - n * NT_PAGE : 0;
    }
    return (i32)trimmed;
}
i32 k_mm_reclaim(u32 pages) {
    u32 i, n = 0;
    for (i = 1; i < NT_MAX_PFN && n < pages; i++) if (PFN[i].used && PFN[i].state == PFN_STANDBY) {
        PFN[i].state = PFN_FREE; n++;
    }
    return (i32)n;
}
u32 k_mm_pfn_field(u32 state) {
    u32 i, n = 0;
    if (state > PFN_ACTIVE) return 0;
    for (i = 1; i < NT_MAX_PFN; i++) if (PFN[i].used && PFN[i].state == state) n++;
    return n;
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
i32 k_section_create_ex(u32 bytes, u32 protect, u32 copy_on_write) {
    u32 i;
    for (i = 1; i < NT_MAX_SECTION; i++) {
        if (!SEC[i].used) {
            u32 oid;
            SEC[i].used = 1; SEC[i].bytes = (bytes + NT_PAGE - 1u) & ~(NT_PAGE - 1u);
            SEC[i].protect = protect ? protect : (ACCESS_READ | ACCESS_WRITE);
            SEC[i].refs = 1; SEC[i].cow = copy_on_write ? 1u : 0u;
            oid = k_obj_create(OT_SECTION, 0, 0, DACL_PUBLIC);
            SEC[i].gpa = oid;
            return (i32)i;
        }
    }
    return (i32)ST_INSUFFICIENT_RES;
}
u32 k_section_create(u32 bytes, u32 protect) {
    i32 r = k_section_create_ex(bytes, protect, 0);
    return r > 0 ? (u32)r : 0;
}
i32 k_section_set_cow(u32 sec, u32 enabled) {
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return (i32)ST_INVALID_PARAM;
    SEC[sec].cow = enabled ? 1u : 0u;
    return 0;
}
i32 k_section_set_prototype(u32 sec, u32 enabled) {
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return (i32)ST_INVALID_PARAM;
    SEC[sec].prototype = enabled ? 1u : 0u; return 0;
}
i32 k_section_map(u32 pid, u32 sec, u32 vaddr) {
    u32 i;
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return -1;
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used && REG[pid][i].vaddr == vaddr) {
            if (REG[pid][i].section) return -2;
            REG[pid][i].section = sec;
            REG[pid][i].copy_on_write = SEC[sec].cow;
            SEC[sec].mappings++;
            SEC[sec].refs++;
            return 0;
        }
    }
    return -3;
}
i32 k_vm_cow_write(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr);
    NtSection *s;
    if (!r || !r->section || r->section >= NT_MAX_SECTION || !SEC[r->section].used)
        return (i32)ST_INVALID_PARAM;
    if (!r->copy_on_write) return (i32)ST_ACCESS_DENIED;
    if (r->cow_private) return 0;
    if (!pfn_take(pid)) return (i32)ST_INSUFFICIENT_RES;
    r->cow_private = 1; r->pfn_count++; s = &SEC[r->section]; s->cow_faults++;
    return 0;
}
i32 k_vm_prototype_fault(u32 pid, u32 vaddr) {
    NtRegion *r = vm_find(pid, vaddr); NtSection *s;
    if (!r || !r->section || r->section >= NT_MAX_SECTION || !SEC[r->section].used) return (i32)ST_INVALID_PARAM;
    s = &SEC[r->section]; if (!s->prototype) return (i32)ST_ACCESS_DENIED;
    if (r->prototype_faults) return 0;
    if (!pfn_take(pid)) return (i32)ST_INSUFFICIENT_RES;
    r->prototype_faults = 1u; r->pfn_count++; s->prototype_faults++; return 0;
}
u32 k_section_field(u32 sec, u32 f) {
    if (sec >= NT_MAX_SECTION || !SEC[sec].used) return 0;
    switch (f) {
        case 0: return SEC[sec].bytes;
        case 1: return SEC[sec].protect;
        case 2: return SEC[sec].refs;
        case 3: return SEC[sec].mappings;
        case 4: return SEC[sec].cow;
        case 5: return SEC[sec].cow_faults;
        case 6: return SEC[sec].prototype;
        case 7: return SEC[sec].prototype_faults;
        default: return 0;
    }
}
u32 k_pool_alloc_for(u32 pid, u32 bytes, u32 paged, u32 tag) {
    u32 need = (bytes + 32u) & ~7u, i, off;
    if (paged && k_irql() >= IRQL_DISPATCH) {
        irql_violations++;
        return 0;
    }
    if (pid >= NT_MAX_PID || !bytes) return 0;
    if (POOL_QUOTA[pid] && POOL_CHARGE[pid] + need > POOL_QUOTA[pid]) { pool_quota_fails++; return 0; }
    if (pool_free_head + need > NT_POOL_BYTES) return 0;
    for (i = 1; i < NT_MAX_POOL_ALLOC; i++) if (!POOL_ALLOC[i].used) break;
    if (i >= NT_MAX_POOL_ALLOC) return 0;
    off = pool_free_head; pool_free_head += need;
    POOL_ALLOC[i].used = 1; POOL_ALLOC[i].ptr = (u32)(POOL + off); POOL_ALLOC[i].bytes = need;
    POOL_ALLOC[i].paged = paged ? 1u : 0u; POOL_ALLOC[i].tag = tag; POOL_ALLOC[i].owner = pid;
    POOL_ALLOC[i].nx = (tag & POOL_NX) ? 1u : 0u;
    if (POOL_ALLOC[i].nx) pool_nx++;
    POOL_CHARGE[pid] += need; pool_live++;
    if (paged) { pool_paged += need; if (pool_paged > pool_paged_peak) pool_paged_peak = pool_paged; }
    else { pool_nonpaged += need; if (pool_nonpaged > pool_np_peak) pool_np_peak = pool_nonpaged; }
    return POOL_ALLOC[i].ptr;
}
u32 k_pool_alloc(u32 bytes, u32 paged, u32 tag) { return k_pool_alloc_for(0, bytes, paged, tag); }
i32 k_pool_free(u32 ptr, u32 tag) {
    u32 i;
    for (i = 1; i < NT_MAX_POOL_ALLOC; i++) if (POOL_ALLOC[i].used && POOL_ALLOC[i].ptr == ptr) break;
    if (i >= NT_MAX_POOL_ALLOC || POOL_ALLOC[i].tag != tag) { pool_bad_frees++; return (i32)ST_BAD_POOL_CALLER; }
    if (POOL_ALLOC[i].owner < NT_MAX_PID)
        POOL_CHARGE[POOL_ALLOC[i].owner] = (POOL_CHARGE[POOL_ALLOC[i].owner] > POOL_ALLOC[i].bytes) ?
            POOL_CHARGE[POOL_ALLOC[i].owner] - POOL_ALLOC[i].bytes : 0;
    if (POOL_ALLOC[i].paged) pool_paged = (pool_paged > POOL_ALLOC[i].bytes) ? pool_paged - POOL_ALLOC[i].bytes : 0;
    else pool_nonpaged = (pool_nonpaged > POOL_ALLOC[i].bytes) ? pool_nonpaged - POOL_ALLOC[i].bytes : 0;
    if (POOL_ALLOC[i].nx && pool_nx) pool_nx--;
    if (pool_live) pool_live--;
    POOL_ALLOC[i].used = 0;
    return 0;
}
i32 k_pool_set_nx(u32 ptr, u32 nx) {
    u32 i;
    for (i = 1; i < NT_MAX_POOL_ALLOC; i++) if (POOL_ALLOC[i].used && POOL_ALLOC[i].ptr == ptr) break;
    if (i >= NT_MAX_POOL_ALLOC) return (i32)ST_BAD_POOL_CALLER;
    if (POOL_ALLOC[i].nx != (nx ? 1u : 0u)) {
        if (POOL_ALLOC[i].nx) { if (pool_nx) pool_nx--; } else pool_nx++;
        POOL_ALLOC[i].nx = nx ? 1u : 0u;
    }
    return 0;
}
u32 k_pool_is_nx(u32 ptr) {
    u32 i;
    for (i = 1; i < NT_MAX_POOL_ALLOC; i++) if (POOL_ALLOC[i].used && POOL_ALLOC[i].ptr == ptr) return POOL_ALLOC[i].nx;
    return 0;
}
i32 k_pool_set_quota(u32 pid, u32 bytes) {
    if (pid >= NT_MAX_PID) return (i32)ST_INVALID_PARAM;
    POOL_QUOTA[pid] = bytes;
    return 0;
}
u32 k_pool_quota(u32 pid) { return pid < NT_MAX_PID ? POOL_QUOTA[pid] : 0; }
u32 k_pool_charge(u32 pid) { return pid < NT_MAX_PID ? POOL_CHARGE[pid] : 0; }
u32 k_pool_field(u32 f) {
    switch (f) {
        case 0: return pool_paged;
        case 1: return pool_paged_peak;
        case 2: return pool_nonpaged;
        case 4: return pool_live;
        case 5: return pool_bad_frees;
        case 6: return pool_quota_fails;
        case 7: return pool_nx;
        default: return pool_np_peak;
    }
}

static u32 seg_align(u32 bytes) {
    if (bytes > 0xFFFFFFF0u) return 0u;
    return (bytes + 15u) & ~15u;
}
static NtSegHeap *seg_heap(u32 id) {
    if (!id || id >= NT_MAX_SEG_HEAP || !SEG_HEAP[id].used) return 0;
    return &SEG_HEAP[id];
}
static NtSegBlock *seg_new_block(u32 heap, u32 off, u32 bytes, u32 allocated, u32 tag) {
    u32 i;
    for (i = 1; i < NT_MAX_SEG_BLOCK; i++) if (!SEG_BLOCK[i].used) {
        SEG_BLOCK[i].used = 1u; SEG_BLOCK[i].heap = heap; SEG_BLOCK[i].off = off;
        SEG_BLOCK[i].bytes = bytes; SEG_BLOCK[i].allocated = allocated ? 1u : 0u;
        SEG_BLOCK[i].tag = tag; return &SEG_BLOCK[i];
    }
    return 0;
}
static void seg_coalesce(NtSegHeap *h) {
    u32 i, j;
    if (!h) return;
    for (i = 1; i < NT_MAX_SEG_BLOCK; i++) {
        NtSegBlock *a = &SEG_BLOCK[i];
        if (!a->used || a->heap != h->id || a->allocated) continue;
        for (j = i + 1u; j < NT_MAX_SEG_BLOCK; j++) {
            NtSegBlock *b = &SEG_BLOCK[j];
            if (!b->used || b->heap != h->id || b->allocated) continue;
            if (a->off + a->bytes == b->off) {
                a->bytes += b->bytes; b->used = 0u; b->allocated = 0u;
            } else if (b->off + b->bytes == a->off) {
                b->bytes += a->bytes; a->used = 0u; a->allocated = 0u; a = b;
            }
        }
    }
}
i32 k_segment_heap_create(u32 pid, u32 initial_bytes, u32 maximum_bytes, u32 flags) {
    u32 i, initial = seg_align(initial_bytes), maximum = seg_align(maximum_bytes);
    NtSegHeap *h; NtSegBlock *b;
    if (pid >= NT_MAX_PID || !initial || !maximum || maximum < initial || initial > NT_SEGMENT_POOL_BYTES)
        return (i32)ST_INVALID_PARAM;
    for (i = 1; i < NT_MAX_SEG_HEAP; i++) if (!SEG_HEAP[i].used) break;
    if (i >= NT_MAX_SEG_HEAP || segment_top + initial > NT_SEGMENT_POOL_BYTES)
        return (i32)ST_INSUFFICIENT_RES;
    b = seg_new_block(i, segment_top, initial, 0u, 0u);
    if (!b) return (i32)ST_INSUFFICIENT_RES;
    h = &SEG_HEAP[i]; z(h, sizeof(*h)); h->used = 1u; h->id = i; h->owner = pid;
    h->initial = initial; h->maximum = maximum; h->reserved = initial; h->segments = 1u; h->flags = flags;
    segment_top += initial;
    return (i32)i;
}
u32 k_segment_heap_alloc(u32 heap, u32 bytes, u32 tag) {
    NtSegHeap *h = seg_heap(heap); NtSegBlock *b = 0, *split; u32 i, need, grow, off;
    if (!h || h->closed || !(need = seg_align(bytes))) { if (h) h->failures++; return 0u; }
    for (i = 1; i < NT_MAX_SEG_BLOCK; i++) if (SEG_BLOCK[i].used && SEG_BLOCK[i].heap == heap && !SEG_BLOCK[i].allocated && SEG_BLOCK[i].bytes >= need) { b = &SEG_BLOCK[i]; break; }
    if (!b) {
        if (h->reserved >= h->maximum) { h->failures++; return 0u; }
        grow = need > (64u * 1024u) ? need : (64u * 1024u);
        if (grow > h->maximum - h->reserved) grow = h->maximum - h->reserved;
        if (grow < need || segment_top + grow > NT_SEGMENT_POOL_BYTES) { h->failures++; return 0u; }
        b = seg_new_block(heap, segment_top, grow, 0u, 0u);
        if (!b) { h->failures++; return 0u; }
        segment_top += grow; h->reserved += grow; h->segments++;
    }
    if (b->bytes > need) {
        split = seg_new_block(heap, b->off + need, b->bytes - need, 0u, 0u);
        if (!split) { h->failures++; return 0u; }
        b->bytes = need;
    }
    off = b->off; b->allocated = 1u; b->tag = tag;
    h->committed += b->bytes; h->live++; h->allocs++;
    return (u32)(uintptr_t)(SEGMENT_POOL + off);
}
i32 k_segment_heap_free(u32 ptr, u32 tag) {
    u32 i; NtSegBlock *b = 0; NtSegHeap *h;
    for (i = 1; i < NT_MAX_SEG_BLOCK; i++) if (SEG_BLOCK[i].used && SEG_BLOCK[i].allocated &&
        (u32)(uintptr_t)(SEGMENT_POOL + SEG_BLOCK[i].off) == ptr) { b = &SEG_BLOCK[i]; break; }
    if (!b || b->tag != tag) {
        /* Attribute a bad caller to the matching heap when the pointer still
           belongs to a free range; otherwise keep the error self-contained. */
        for (i = 1; i < NT_MAX_SEG_BLOCK; i++) if (SEG_BLOCK[i].used &&
            ptr >= (u32)(uintptr_t)(SEGMENT_POOL + SEG_BLOCK[i].off) &&
            ptr < (u32)(uintptr_t)(SEGMENT_POOL + SEG_BLOCK[i].off + SEG_BLOCK[i].bytes)) {
            h = seg_heap(SEG_BLOCK[i].heap); if (h) h->failures++; break;
        }
        return (i32)ST_BAD_POOL_CALLER;
    }
    h = seg_heap(b->heap); if (!h) return (i32)ST_BAD_POOL_CALLER;
    b->allocated = 0u; b->tag = 0u;
    h->committed = h->committed > b->bytes ? h->committed - b->bytes : 0u;
    if (h->live) h->live--; h->frees++;
    seg_coalesce(h);
    return 0;
}
i32 k_segment_heap_destroy(u32 heap) {
    NtSegHeap *h = seg_heap(heap); u32 i;
    if (!h || h->closed) return (i32)ST_INVALID_PARAM;
    if (h->live) { h->failures++; return (i32)ST_RESOURCE_IN_USE; }
    h->closed = 1u;
    for (i = 1; i < NT_MAX_SEG_BLOCK; i++) if (SEG_BLOCK[i].used && SEG_BLOCK[i].heap == heap) SEG_BLOCK[i].used = 0u;
    return 0;
}
u32 k_segment_heap_field(u32 heap, u32 field) {
    NtSegHeap *h = seg_heap(heap); if (!h) return 0u;
    switch (field) {
    case 0: return h->owner; case 1: return h->initial; case 2: return h->maximum;
    case 3: return h->reserved; case 4: return h->committed; case 5: return h->live;
    case 6: return h->allocs; case 7: return h->frees; case 8: return h->segments;
    case 9: return h->failures; case 10: return h->flags; case 11: return h->closed;
    default: return 0u;
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
typedef struct { u32 used, parent, name_off, name_len, subkeys, values, in_tx;
                 u32 cell_off, bin_off, cell_size, flags, link_target; } NtKey;
typedef struct { u32 used, key, name_off, name_len, type, data_off, data_len; } NtValue;
typedef struct { u32 used, committed, count; } NtTx;
typedef struct { u32 used, tx, kind, key, val, old_type, old_off, old_len, existed, name_off, name_len; } NtUndo;
typedef struct { u32 used, root, name_off, name_len, version, cells, closed; } NtAppHive;

#define KEYF_LINK 1u
#define KEYF_HIVE_ROOT 2u
#define KEYF_APP_ROOT 4u
#define REG_CELL_BASE 0x1000u
#define REG_BIN_SIZE  0x1000u

static NtKey   KEY[NT_MAX_KEY];
static NtValue VAL[NT_MAX_VALUE];
static NtTx    TX[NT_MAX_TX];
static NtUndo  UNDO[NT_MAX_UNDO];
static NtAppHive APP_HIVE[NT_MAX_APP_HIVE];
static u32 reg_enum_name_off, reg_enum_name_len;
static u32 tx_committed, tx_rolledback, cur_tx;
static u32 reg_value_len, reg_value_type;

static u32 key_resolve(u32 id, u32 *status) {
    u32 depth = 0;
    while (id && id < NT_MAX_KEY && KEY[id].used && (KEY[id].flags & KEYF_LINK)) {
        if (++depth > 8u) { if (status) *status = ST_REPARSE; return 0; }
        id = KEY[id].link_target;
    }
    if (!id || id >= NT_MAX_KEY || !KEY[id].used) {
        if (status) *status = ST_OBJECT_NAME_NOT_FOUND;
        return 0;
    }
    return id;
}

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
u32 k_reg2_cell_field(u32 id, u32 f) {
    NtKey *k = key(id);
    if (!k) return 0;
    switch (f) {
        case 0: return k->cell_off;
        case 1: return k->bin_off;
        case 2: return k->cell_size;
        case 3: return k->flags;
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
            KEY[i].cell_off = REG_CELL_BASE + i * 64u;
            KEY[i].bin_off = (KEY[i].cell_off / REG_BIN_SIZE) * REG_BIN_SIZE;
            KEY[i].cell_size = 64u + name_len;
            KEY[parent].subkeys++;
            {
                u32 ar = parent;
                while (ar && ar < NT_MAX_KEY && KEY[ar].used) {
                    if (KEY[ar].flags & KEYF_APP_ROOT) {
                        u32 h;
                        for (h = 1; h < NT_MAX_APP_HIVE; h++)
                            if (APP_HIVE[h].used && APP_HIVE[h].root == ar) { APP_HIVE[h].cells++; break; }
                        break;
                    }
                    ar = KEY[ar].parent;
                }
            }
            return (i32)i;
        }
    }
    return -2;
}
 i32 k_reg2_link_key(u32 parent, u32 name_ptr, u32 name_len, u32 target) {
    i32 id;
    u32 st = ST_OBJECT_NAME_NOT_FOUND;
    if (!key(parent) || !key_resolve(target, &st) || name_len > 63u) return (i32)st;
    if (key_find_child(parent, name_ptr, name_len)) return (i32)ST_OBJECT_NAME_COLLISION;
    id = k_reg2_create_key(parent, name_ptr, name_len);
    if (id < 0) return id;
    KEY[(u32)id].flags |= KEYF_LINK;
    KEY[(u32)id].link_target = target;
    return id;
}

i32 k_reg2_create_app_hive(u32 name_ptr, u32 name_len) {
    u32 i, off;
    if (!name_ptr || !name_len || name_len > 63u) return (i32)ST_INVALID_PARAM;
    for (i = 1; i < NT_MAX_APP_HIVE; i++) {
        if (APP_HIVE[i].used && APP_HIVE[i].name_len == name_len &&
            cieq(N(APP_HIVE[i].name_off), (const char *)name_ptr, name_len))
            return (i32)ST_OBJECT_NAME_COLLISION;
    }
    for (i = 1; i < NT_MAX_APP_HIVE; i++) if (!APP_HIVE[i].used) break;
    if (i >= NT_MAX_APP_HIVE) return (i32)ST_INSUFFICIENT_RES;
    off = name_store(name_ptr, name_len);
    if (!off) return (i32)ST_INSUFFICIENT_RES;
    {
        static const char prefix[] = "APPHIVE:";
        char path[80]; u32 j;
        for (j = 0; j < 8u; j++) path[j] = prefix[j];
        for (j = 0; j < name_len && j + 8u < sizeof(path) - 1u; j++) path[j + 8u] = ((const char *)name_ptr)[j];
        path[j + 8u] = 0;
        APP_HIVE[i].root = (u32)k_reg2_create_key(k_reg2_root(3u), (u32)path, j + 8u);
    }
    if (!APP_HIVE[i].root) { name_free(off, name_len); return (i32)ST_INSUFFICIENT_RES; }
    APP_HIVE[i].used = 1;
    APP_HIVE[i].name_off = off;
    APP_HIVE[i].name_len = name_len;
    APP_HIVE[i].version = 1u;
    APP_HIVE[i].cells = 1u;
    APP_HIVE[i].closed = 0;
    KEY[APP_HIVE[i].root].flags |= KEYF_APP_ROOT | KEYF_HIVE_ROOT;
    return (i32)i;
}
u32 k_reg2_app_hive_root(u32 hive) {
    return (hive < NT_MAX_APP_HIVE && APP_HIVE[hive].used && !APP_HIVE[hive].closed) ? APP_HIVE[hive].root : 0;
}
u32 k_reg2_app_hive_field(u32 hive, u32 f) {
    if (hive >= NT_MAX_APP_HIVE || !APP_HIVE[hive].used) return 0;
    switch (f) {
        case 0: return APP_HIVE[hive].root;
        case 1: return APP_HIVE[hive].version;
        case 2: return APP_HIVE[hive].cells;
        case 3: return APP_HIVE[hive].closed;
        default: return 0;
    }
}
u32 k_reg2_open_key(u32 parent, u32 name_ptr, u32 name_len) {
    u32 id = key_find_child(parent, name_ptr, name_len), st = ST_OBJECT_NAME_NOT_FOUND;
    if (!id) return 0;
    return key_resolve(id, &st);
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
    const char *hdr = "KREG3\n";
    while (hdr[o]) { b[o] = (u8)hdr[o]; o++; }
    for (i = 1; i < NT_MAX_APP_HIVE; i++) if (APP_HIVE[i].used && !APP_HIVE[i].closed) {
        u32 j = 0;
        if (o + 128u > 260u * 1024u) break;
        b[o++] = '@'; b[o++] = 'A'; b[o++] = 'P'; b[o++] = 'P'; b[o++] = '\t';
        while (j < APP_HIVE[i].name_len) b[o++] = NAMES[APP_HIVE[i].name_off + j++];
        b[o++] = '\t'; b[o++] = (u8)('0' + (APP_HIVE[i].version % 10u)); b[o++] = '\t'; b[o++] = '\n';
    }
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
    if (len > 8u && (p[4] == '2' || p[4] == '3')) v2 = 1;
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
        if (v2 && pl == 4u && path[0] == '@' && path[1] == 'A' && path[2] == 'P' && path[3] == 'P') {
            (void)k_reg2_create_app_hive((u32)name, nl);
            while (p < end && *p != '\n') p++;
            if (p < end) p++;
            loaded++;
            continue;
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

/* ------------------------------------------------ verifier / PatchGuard */
static u32 VER_RULES[NT_MAX_DRIVER], VER_VIOLATIONS[NT_MAX_DRIVER];
static u32 VER_CODE[NT_MAX_DRIVER], VER_PARAMS[NT_MAX_DRIVER][4];
static u32 pg_enabled, pg_interval, pg_next, pg_checks, pg_baseline, pg_last;
static u32 pg_hash(void) {
    u32 i, h = 2166136261u;
    for (i = 1; i < NT_MAX_DRIVER; i++) if (DRV[i].used) {
        h ^= DRV[i].dispatch_id + i * 33u; h *= 16777619u;
        h ^= DRV[i].flags; h *= 16777619u;
    }
    for (i = 1; i < NT_MAX_DEVICE; i++) if (DEV[i].used) {
        h ^= DEV[i].lower + DEV[i].pnp_state * 17u; h *= 16777619u;
    }
    return h;
}
i32 k_verifier_enable(u32 driver, u32 rules) {
    if (!drv(driver)) return (i32)ST_INVALID_PARAM;
    VER_RULES[driver] = rules & (VERIFIER_RULE_IRQL | VERIFIER_RULE_POOL | VERIFIER_RULE_IO | VERIFIER_RULE_HANDLE);
    VER_VIOLATIONS[driver] = 0;
    return 0;
}
i32 k_verifier_check(u32 driver, u32 rule, u32 p1, u32 p2, u32 p3, u32 p4) {
    u32 code;
    if (!drv(driver) || !(VER_RULES[driver] & rule)) return 0;
    if (rule == VERIFIER_RULE_IRQL) code = BUGCHECK_DRIVER_IRQL;
    else if (rule == VERIFIER_RULE_HANDLE) code = BUGCHECK_KMODE_EXCEPTION;
    else code = BUGCHECK_VERIFIER;
    VER_VIOLATIONS[driver]++; VER_CODE[driver] = code;
    VER_PARAMS[driver][0] = p1; VER_PARAMS[driver][1] = p2;
    VER_PARAMS[driver][2] = p3; VER_PARAMS[driver][3] = p4;
    (void)k_bugcheck(code, p1, p2, p3, p4);
    return (i32)code;
}
u32 k_verifier_field(u32 driver, u32 f) {
    if (!drv(driver)) return 0;
    switch (f) {
        case 0: return VER_RULES[driver]; case 1: return VER_VIOLATIONS[driver];
        case 2: return VER_CODE[driver]; case 3: return VER_PARAMS[driver][0];
        case 4: return VER_PARAMS[driver][1]; case 5: return VER_PARAMS[driver][2];
        case 6: return VER_PARAMS[driver][3]; default: return 0;
    }
}
i32 k_patchguard_enable(u32 interval_ms) {
    pg_enabled = 1; pg_interval = interval_ms ? interval_ms : 1000u;
    pg_next = pg_interval; pg_checks = 0; pg_baseline = pg_hash(); pg_last = pg_baseline;
    return 0;
}
u32 k_patchguard_tick(u32 now_ms) {
    u32 h;
    if (!pg_enabled || now_ms < pg_next) return 0;
    h = pg_hash(); pg_checks++; pg_last = h;
    while (pg_next <= now_ms) pg_next += pg_interval;
    if (h != pg_baseline) { (void)k_bugcheck(BUGCHECK_PATCHGUARD, h, pg_baseline, 0, 0); return BUGCHECK_PATCHGUARD; }
    return 0;
}
i32 k_patchguard_corrupt(u32 driver, u32 dispatch_id) {
    if (!pg_enabled || !drv(driver)) return (i32)ST_INVALID_PARAM;
    DRV[driver].dispatch_id = dispatch_id;
    return 0;
}
u32 k_patchguard_field(u32 f) {
    switch (f) { case 0: return pg_enabled; case 1: return pg_checks; case 2: return pg_interval;
        case 3: return pg_baseline; case 4: return pg_last; case 5: return pg_next; default: return 0; }
}

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
        case NS_ACCESS_GRANTS: return access_grants;
        case NS_AUDIT_SUCCESS: return audit_success;
        case NS_AUDIT_FAILURE: return audit_failure;
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
    z(OBJ, sizeof(OBJ)); z(ACE, sizeof(ACE)); z(HANDLES, sizeof(HANDLES)); z(HANDLE_GEN, sizeof(HANDLE_GEN)); z(TOKENS, sizeof(TOKENS));
    z(TH, sizeof(TH)); z(KEY, sizeof(KEY)); z(VAL, sizeof(VAL));
    z(TX, sizeof(TX)); z(UNDO, sizeof(UNDO)); z(APP_HIVE, sizeof(APP_HIVE)); z(REG, sizeof(REG));
    z(DRV, sizeof(DRV)); z(DEV, sizeof(DEV)); z(IRP, sizeof(IRP)); z(IOCP, sizeof(IOCP)); z(IOCP_PACKET, sizeof(IOCP_PACKET));
    z(ALPC, sizeof(ALPC)); z(ALPC_MSG, sizeof(ALPC_MSG));
    z(ETW_PROVIDER, sizeof(ETW_PROVIDER)); z(ETW_SESSION, sizeof(ETW_SESSION));
    z(ETW_EVENT, sizeof(ETW_EVENT)); z(&ETW_LAST, sizeof(ETW_LAST));
    z(VER_RULES, sizeof(VER_RULES)); z(VER_VIOLATIONS, sizeof(VER_VIOLATIONS));
    z(VER_CODE, sizeof(VER_CODE)); z(VER_PARAMS, sizeof(VER_PARAMS));
    z(SEC, sizeof(SEC)); z(PFN, sizeof(PFN)); z(JOB, sizeof(JOB)); z(PID_JOB, sizeof(PID_JOB)); z(POOL, sizeof(POOL)); z(POOL_ALLOC, sizeof(POOL_ALLOC)); z(POOL_QUOTA, sizeof(POOL_QUOTA)); z(POOL_CHARGE, sizeof(POOL_CHARGE)); z(SEGMENT_POOL, sizeof(SEGMENT_POOL)); z(SEG_HEAP, sizeof(SEG_HEAP)); z(SEG_BLOCK, sizeof(SEG_BLOCK)); z(LOCKS, sizeof(LOCKS)); z(WORK, sizeof(WORK));
    for (i = 1; i < NT_MAX_PFN; i++) { PFN[i].used = 1; PFN[i].state = PFN_FREE; }
    z(ready_head, sizeof(ready_head)); z(ready_tail, sizeof(ready_tail));
    z(PID_TOKEN, sizeof(PID_TOKEN)); z(PID_PRIORITY_CLASS, sizeof(PID_PRIORITY_CLASS)); z(VM_NEXT, sizeof(VM_NEXT));
    z(BC_DUMP, sizeof(BC_DUMP));
    z(apc_ready, sizeof(apc_ready));
    names_used = 8; data_used = 8;
    etw_time_ms = 0; etw_last_event = 0; etw_sessions_live = 0;
    obj_created = obj_deleted = obj_peak = 0; handle_total = 0;
    thread_count = 0; cur_tid = 0; ready_bitmap = 0; current_cpu = 0; z(idle_ticks, sizeof(idle_ticks));
    tid_seq = 1; switch_count = boost_count = aging_count = 0; boost_decay = 0;
    wait_timeouts = waits_total = mutants_held = 0;
    irql = IRQL_PASSIVE; irql_sp = 0; irql_violations = 0;
    dip = aip = 0; dpc_queued = dpc_drained = apc_queued = apc_delivered = 0;
    apc_rh = apc_rt = 0;
    io_created = io_completed = io_failed = io_overflow = io_cancelled = io_queued = 0;
    commit_charge = 0; commit_limit = NT_COMMIT_LIMIT; commit_peak = 0; commit_failures = 0;
    vm_regions_total = 0; pool_free_head = 8; segment_top = 0;
    pool_paged = pool_paged_peak = pool_nonpaged = pool_np_peak = 0;
    pool_live = pool_bad_frees = pool_quota_fails = pool_nx = 0;
    pagefile_slots = pagefile_outs = pagefile_ins = pagefile_failures = 0;
    access_checks = access_denies = access_grants = audit_success = audit_failure = 0; ace_sequence = 0;
    tx_committed = tx_rolledback = cur_tx = 0;
    nfree_n = dfree_n = 0; name_quota_hits = data_quota_hits = 0; pool_frozen = 0;
    hive_skips = 0;
    pg_enabled = pg_interval = pg_next = pg_checks = pg_baseline = pg_last = 0;
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
            KEY[i + 1].cell_off = REG_CELL_BASE + (i + 1u) * 64u;
            KEY[i + 1].bin_off = REG_BIN_SIZE;
            KEY[i + 1].cell_size = 64u + KEY[i + 1].name_len;
            KEY[i + 1].flags = KEYF_HIVE_ROOT;
        }
    }
    /* the system token */
    (void)k_token_create(3000u, 1u);
    seed_hive();
    {
        static const char *sched = "W98-Scheduler", *io = "W98-Io", *mm = "W98-Mm";
        etw_sched_provider = (u32)k_etw_register_provider((u32)sched, sl(sched));
        etw_io_provider = (u32)k_etw_register_provider((u32)io, sl(io));
        etw_mm_provider = (u32)k_etw_register_provider((u32)mm, sl(mm));
    }
    {
        static const char *roots[5] = { "\\", "\\Device", "\\BaseNamedObjects", "\\GLOBAL??", "\\Sessions\\0" };
        for (i = 0; i < 5; i++) (void)k_obj_create_named(OT_DIRECTORY, (u32)roots[i], sl(roots[i]), DACL_PUBLIC);
    }
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
    if (oid) { OBJ[oid].owner_pid = pid; OBJ[oid].owner_sid = k_sid_of(k_token_of(pid)); }
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
    for (i = 0; i < NT_MAX_HANDLE; i++) if (HANDLES[pid][i].used)
        k_handle_close(pid, handle_id(i, HANDLES[pid][i].generation));
    for (i = 0; i < NT_MAX_REGION; i++) {
        if (REG[pid][i].used) {
            commit_charge = (commit_charge > REG[pid][i].committed) ? commit_charge - REG[pid][i].committed : 0;
            if (PID_JOB[pid] && job_of(PID_JOB[pid])) job_of(PID_JOB[pid])->charge =
                (job_of(PID_JOB[pid])->charge > REG[pid][i].committed) ?
                    job_of(PID_JOB[pid])->charge - REG[pid][i].committed : 0;
            if (REG[pid][i].paged_out) {
                u32 q;
                for (q = 1; q < NT_MAX_PFN; q++) if (PFN[q].used && PFN[q].owner_pid == pid && PFN[q].state == PFN_MODIFIED) {
                    PFN[q].state = PFN_FREE; PFN[q].pagefile_slot = 0u; if (pagefile_slots) pagefile_slots--; break;
                }
            }
            (void)pfn_release(pid, REG[pid][i].pfn_count);
            if (vm_regions_total) vm_regions_total--;
            z(&REG[pid][i], sizeof(NtRegion));
        }
    }
    PID_VSIZE[pid] = PID_COMMIT[pid] = PID_WORKING[pid] = PID_FAULTS[pid] = 0;
    if (PID_JOB[pid]) {
        NtJob *j = job_of(PID_JOB[pid]);
        if (j) for (i = 0; i < j->member_count; i++) if (j->members[i] == pid) {
            u32 k; for (k = i; k + 1 < j->member_count; k++) j->members[k] = j->members[k + 1];
            if (j->member_count) j->member_count--; break;
        }
    }
    PID_TOKEN[pid] = 0;
    PID_JOB[pid] = 0;
}
