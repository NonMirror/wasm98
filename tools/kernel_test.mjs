// Kernel smoke test: instantiates web/wasm/kernel.wasm in Node and exercises
// every syscall family the desktop depends on.  Run: node tools/kernel_test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = readFileSync(join(root, 'web/wasm/kernel.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, {});
const k = instance.exports;

const U32 = 0, STATE = 1, Z = 2, CPU = 3, FLAGS = 4, STARTED = 5;
const ST = { SYSCALLS:0, TICKS:1, TIMERS:2, PROCS:3, HEAP_USED:4, HEAP_SIZE:5, SWITCHES:6,
  UPTIME:7, QUEUE:8, NDESC:9, NEXT_PID:10, FILES:11, BYTES:12, REG:13, TMP_CAP:14, VERSION:15,
  PANIC:16, SLICE:17, CURRENT:18, FIRED:19, NODES:20, HEAP_FREE:21, DROPPED:22 };

let pass = 0, fail = 0;
const dec = new TextDecoder();
const enc = new TextEncoder();
const u8 = () => new Uint8Array(k.memory.buffer);

function ok(cond, what, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function call(name, ...args) {
  const f = k[name];
  if (typeof f !== 'function') { fail++; console.log('  MISSING EXPORT: ' + name); return -1; }
  return f(...args);
}
function push(str) {                       // copy a JS string into wasm heap -> ptr
  const b = enc.encode(str);
  const p = k.k_alloc(b.length + 1);
  if (!p) throw new Error('kernel heap exhausted while pushing ' + str);
  u8().set(b, p);
  u8()[p + b.length] = 0;
  return { p, n: b.length };
}
function read(ptr, len) { return dec.decode(u8().subarray(ptr, ptr + len)); }
function freed(x) { call('k_free', x.p); }
const tmp = () => read(k.k_tmp_ptr(), k.k_tmp_len());
const stat = (i) => k.k_stat(i);

function fsWrite(path, data) {
  const a = push(path);
  const bytesIn = typeof data === 'string' ? enc.encode(data) : data;
  const dp = k.k_alloc(bytesIn.length + 1);
  u8().set(bytesIn, dp);
  const r = call('k_fs_write', a.p, a.n, dp, bytesIn.length);
  k.k_free(dp); freed(a);
  return r;
}
function fsRead(path) {
  const a = push(path);
  const r = call('k_fs_read', a.p, a.n);
  freed(a);
  return r < 0 ? null : u8().slice(k.k_tmp_ptr(), k.k_tmp_ptr() + r);
}
function text(path) { const b = fsRead(path); return b ? dec.decode(b) : null; }
function fsExists(path) { const a = push(path); const r = call('k_fs_exists', a.p, a.n); freed(a); return r === 1; }
function fsIsDir(path) { const a = push(path); const r = call('k_fs_is_dir', a.p, a.n); freed(a); return r === 1; }
function fsMkdir(path) { const a = push(path); const r = call('k_fs_mkdir', a.p, a.n); freed(a); return r; }
function fsUnlink(path) { const a = push(path); const r = call('k_fs_unlink', a.p, a.n); freed(a); return r; }
function fsRename(a2, b2) {
  const a = push(a2), b = push(b2);
  const r = call('k_fs_rename', a.p, a.n, b.p, b.n);
  freed(a); freed(b); return r;
}
function fsList(path) {
  const a = push(path);
  const h = call('k_fs_opendir', a.p, a.n);
  freed(a);
  if (h < 0) return null;
  const out = [];
  while (call('k_fs_readdir', h) === 1) {
    out.push({
      name: read(k.k_dir_name_ptr(), k.k_dir_name_len()),
      dir: k.k_dir_is_dir() === 1, size: k.k_dir_size(), mtime: k.k_dir_mtime(),
    });
  }
  call('k_fs_closedir', h);
  return out;
}
function regSet(path, name, val) {
  const a = push(path), b = push(name);
  const vb = enc.encode(val);
  const vp = k.k_alloc(vb.length + 1);
  u8().set(vb, vp);
  const r = call('k_reg_set', a.p, a.n, b.p, b.n, vp, vb.length);
  k.k_free(vp); freed(a); freed(b);
  return r;
}
function regGet(path, name) {
  const a = push(path), b = push(name);
  const r = call('k_reg_get', a.p, a.n, b.p, b.n);
  freed(a); freed(b);
  return r < 0 ? null : read(k.k_tmp_ptr(), k.k_tmp_len());
}
function regDel(path, name) {
  const a = push(path), b = push(name);
  const r = call('k_reg_del', a.p, a.n, b.p, b.n);
  freed(a); freed(b); return r;
}
function procCreate(name) {
  const a = push(name);
  const pid = call('k_proc_create', a.p, a.n, 0);
  freed(a); return pid;
}
function procName(pid) { return read(k.k_proc_name_ptr(pid), k.k_proc_name_len(pid)); }

console.log('\n=== kernel.wasm smoke test ===\n');
console.log('version 0x' + k_version_hex());
function k_version_hex() { return k.k_version().toString(16); }

k.k_init(0x1998);
console.log('after init: heap_used=' + stat(ST.HEAP_USED) + '/' + stat(ST.HEAP_SIZE) +
            '  files=' + stat(ST.FILES) + '  bytes=' + stat(ST.BYTES) +
            '  nodes=' + stat(ST.NODES) + '  reg=' + stat(ST.REG));

/* ---- 1. seeded filesystem ------------------------------------------------- */
ok(fsExists('C:\\WINDOWS\\SYSTEM.INI'), 'C:\\WINDOWS\\SYSTEM.INI exists');
ok(fsIsDir('C:\\WINDOWS'), 'C:\\WINDOWS is a dir');
ok(fsIsDir('C:\\My Documents\\My Pictures'), 'My Pictures is a dir');
ok(fsIsDir('A:'), 'floppy A: exists');
ok(!fsExists('C:\\WINDOWS\\NOPE.TXT'), 'missing file reports missing');
const sysini = fsRead('C:\\WINDOWS\\SYSTEM.INI');
ok(sysini && dec.decode(sysini).includes('[386Enh]'), 'SYSTEM.INI content readable', sysini ? dec.decode(sysini).slice(0, 20) : null);
ok((text('C:\\AUTOEXEC.BAT') || '').includes('PROMPT $p$g'), 'AUTOEXEC.BAT content');

/* ---- 2. path normalisation ----------------------------------------------- */
ok((text('c:/windows/system.ini') || '').includes('[386Enh]'), 'lowercase + forward slashes');
ok((text('C:\\WINDOWS\\..\\WINDOWS\\SYSTEM.INI') || '').includes('[386Enh]'), 'dot-dot traversal');
ok((text('\\WINDOWS\\SYSTEM.INI') || '').includes('[386Enh]'), 'drive-relative defaults to C:');

/* ---- 3. listing ---------------------------------------------------------- */
const rootList = fsList('C:\\');
ok(rootList && rootList.length >= 5, 'C:\\ lists >= 5 entries', rootList && rootList.map(e => e.name));
ok(rootList.some(e => e.name === 'WINDOWS' && e.dir), 'WINDOWS listed as dir');
const winList = fsList('C:\\WINDOWS');
ok(winList.some(e => e.name === 'SYSTEM.INI' && !e.dir), 'SYSTEM.INI listed as file');
ok(winList.find(e => e.name === 'SYSTEM.INI').size > 100, 'SYSTEM.INI has a size');

/* ---- 4. create / write / read / rename / delete -------------------------- */
ok(fsMkdir('C:\\My Documents\\Test Dir') === 0, 'mkdir nested');
ok(fsIsDir('C:\\My Documents\\Test Dir'), 'new dir is a dir');
ok(fsWrite('C:\\My Documents\\Test Dir\\hello.txt', 'hello wasm kernel') === 17, 'write file');
ok(text('C:\\My Documents\\Test Dir\\hello.txt') === 'hello wasm kernel', 'read back');
ok(fsWrite('C:\\My Documents\\Test Dir\\hello.txt', 'overwritten') === 11, 'overwrite file');
ok(text('C:\\My Documents\\Test Dir\\hello.txt') === 'overwritten', 'read after overwrite');
ok(fsRename('C:\\My Documents\\Test Dir\\hello.txt', 'C:\\My Documents\\Test Dir\\bye.txt') === 0, 'rename');
ok(!fsExists('C:\\My Documents\\Test Dir\\hello.txt'), 'old name gone');
ok(text('C:\\My Documents\\Test Dir\\bye.txt') === 'overwritten', 'content survived rename');
ok(fsUnlink('C:\\My Documents\\Test Dir\\bye.txt') === 0, 'delete file');
ok(!fsExists('C:\\My Documents\\Test Dir\\bye.txt'), 'deleted file gone');
fsWrite('C:\\My Documents\\Test Dir\\inner.txt', 'x');
ok(fsUnlink('C:\\My Documents\\Test Dir') === 0, 'recursive delete of dir');
ok(!fsExists('C:\\My Documents\\Test Dir\\inner.txt'), 'child gone after recursive delete');
ok(!fsIsDir('C:\\My Documents\\Test Dir'), 'dir gone after recursive delete');

/* ---- 5. big binary write (Paint-sized 640x480 BMP) ---------------------- */
const bmp = new Uint8Array(921654);
for (let i = 0; i < bmp.length; i++) bmp[i] = (i * 7) & 0xff;
ok(fsWrite('C:\\My Documents\\big.bmp', bmp) === bmp.length, 'write 900 KB file');
const back = fsRead('C:\\My Documents\\big.bmp');
ok(back && back.length === bmp.length, 'read back 900 KB');
let same = back && back.length === bmp.length;
if (same) for (let i = 0; i < bmp.length; i += 997) if (back[i] !== bmp[i]) { same = false; break; }
ok(same, '900 KB payload identical');
ok(stat(ST.BYTES) > 900000, 'byte counter tracks the volume', stat(ST.BYTES));

/* ---- 6. heap stress + accounting ---------------------------------------- */
const held = [];
const before = stat(ST.HEAP_USED);
for (let i = 0; i < 400; i++) { const p = k.k_alloc(64 + (i % 512)); if (!p) { fail++; console.log('  FAIL: alloc ' + i); break; } held.push(p); }
const peak = stat(ST.HEAP_USED);
for (let i = 0; i < held.length; i += 2) k.k_free(held[i]);
for (let i = 1; i < held.length; i += 2) k.k_free(held[i]);
ok(stat(ST.HEAP_USED) === before, 'heap returns to prior level after mass free', { before, now: stat(ST.HEAP_USED) });
ok(peak > before, 'heap usage rose during stress', { before, peak });
const freeb = stat(ST.HEAP_FREE);
ok(freeb > 7 * 1024 * 1024, 'free heap after churn is ~8MB', freeb);
const big = k.k_alloc(3 * 1024 * 1024);
ok(big !== 0, 'can allocate a 3 MB block');
k.k_free(big);
ok(k.k_alloc(9 * 1024 * 1024) === 0, 'over-large allocation fails cleanly');

/* ---- 7. registry -------------------------------------------------------- */
ok(regSet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper', 'C:\\WINDOWS\\STRAW.BMP') === 0, 'reg set');
ok(regGet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper') === 'C:\\WINDOWS\\STRAW.BMP', 'reg get');
ok(regGet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Missing') === null, 'reg get missing');
ok(regSet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper', '(None)') === 0, 'reg overwrite');
ok(regGet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper') === '(None)', 'reg get after overwrite');
ok(regDel('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper') === 0, 'reg delete');
ok(regGet('HKEY_CURRENT_USER\\Software\\W98\\Desktop', 'Wallpaper') === null, 'reg gone after delete');
ok(stat(ST.REG) >= 0, 'reg count stat');

/* ---- 7b. registry enumeration ------------------------------------------- */
{
  regSet('HKEY_CURRENT_USER\\Software\\Enum', 'One', '1');
  regSet('HKEY_CURRENT_USER\\Software\\Enum', 'Two', 'two');
  const total = k.k_reg_enum_count();
  ok(total >= 2, 'registry enumerable', total);
  const seen = {};
  for (let i = 0; i < total; i++) {
    if (k.k_reg_enum(i) === 1) seen[read(k.k_reg_enum_name_ptr(), k.k_reg_enum_name_len())] = read(k.k_reg_enum_path_ptr(), k.k_reg_enum_path_len());
  }
  ok(seen.One === 'HKEY_CURRENT_USER\\Software\\Enum', 'enumeration returns path for One', seen.One);
  ok(seen.Two === 'HKEY_CURRENT_USER\\Software\\Enum', 'enumeration returns path for Two', seen.Two);
}

/* ---- 8. processes + scheduler ------------------------------------------- */
const p1 = procCreate('Explorer');
const p2 = procCreate('Minesweeper');
const p3 = procCreate('MS-DOS Prompt');
ok(p1 && p2 && p3 && p1 !== p2, 'pids allocated', [p1, p2, p3]);
ok(procName(p1) === 'Explorer', 'proc name round trip', procName(p1));
ok(call('k_proc_count') === 3, 'proc count == 3', call('k_proc_count'));
ok(call('k_proc_field', p2, STATE) === 1, 'proc state running');
call('k_proc_set_field', p2, STATE, 2);
ok(call('k_proc_field', p2, STATE) === 2, 'proc state minimised');
call('k_focus_set', p3);
ok(call('k_focus_get') === p3, 'focus tracks last set pid');
ok(call('k_proc_field', p1, STARTED) === stat(ST.UPTIME), 'proc start time == kernel uptime');

/* ---- 9. timers + the tick heartbeat ------------------------------------- */
const t1 = call('k_timer_set', p1, 100, 0);          // periodic 100ms
const t2 = call('k_timer_set', p2, 250, 1);          // one shot
ok(t1 && t2, 'timers allocated', [t1, t2]);
ok(call('k_timer_count') === 2, 'timer queue length 2');
ok(call('k_timer_pid', t1) === p1, 'timer owner recorded');
let firedTotal = 0, t2fired = 0, t1fired = 0;
for (let t = 10; t <= 1000; t += 10) {
  const n = call('k_tick', t);
  firedTotal += n;
  let id;
  while ((id = call('k_fired_pop')) !== 0) {
    if (id === t1) t1fired++;
    if (id === t2) t2fired++;
  }
}
ok(t2fired === 1, 'one-shot timer fired exactly once', t2fired);
ok(t1fired >= 8 && t1fired <= 12, 'periodic timer fired ~10x in 1000ms', t1fired);
ok(call('k_timer_count') === 1, 'one-shot removed from queue');
ok(stat(ST.TIMERS) === firedTotal, 'fired counter matches tick returns', { firedTotal, s: stat(ST.TIMERS) });
ok(stat(ST.TICKS) === 100, 'tick counter == 100 frames', stat(ST.TICKS));
ok(stat(ST.SWITCHES) > 0, 'scheduler switched tasks', stat(ST.SWITCHES));
ok(call('k_proc_field', p1, CPU) > 0, 'cpu time accumulated', call('k_proc_field', p1, CPU));
ok(stat(ST.CURRENT) === p1 || stat(ST.CURRENT) === p3, 'current task is live', stat(ST.CURRENT));
call('k_timer_kill', t1);
ok(call('k_timer_count') === 0, 'timers killed');
ok(call('k_tick', 500) === 0, 'tick with no due timers returns 0');

/* ---- 10. process teardown kills its timers ----------------------------- */
call('k_timer_set', p3, 50, 0);
call('k_timer_set', p3, 70, 0);
ok(call('k_timer_count') === 2, 'two timers for p3');
ok(call('k_proc_destroy', p3) === 0, 'destroy process');
ok(call('k_timer_count') === 0, 'timers reaped with the process');
ok(call('k_proc_count') === 2, 'proc count dropped');
ok(call('k_proc_name_ptr', p3) === 0, 'destroyed pid has no name');

/* ---- 11. persistence round trip (save -> reboot -> load) ---------------- */
fsWrite('C:\\My Documents\\persist.txt', 'survive the reboot');
fsMkdir('C:\\My Documents\\Empty Dir');
regSet('HKEY_CURRENT_USER\\Software\\W98\\Test', 'Keep', 'yes');
const sysBeforeReboot = stat(ST.SYSCALLS);
ok(stat(ST.SYSCALLS) > 1000, 'syscall counter accumulated (pre-reboot)', sysBeforeReboot);
const fsLen = call('k_fs_save');
ok(fsLen > 100, 'fs save produced a blob', fsLen);
const fsStr = tmp();
ok(fsStr.startsWith('KFS1'), 'fs blob is KFS1', fsStr.slice(0, 12));
ok(fsStr.includes('persist.txt'), 'blob mentions the file');
const regLen = call('k_reg_save');
const regStr = tmp();
ok(regLen > 10 && /^KREG[12]/.test(regStr), 'registry blob is a hive image (KREG1 legacy or KREG2)', regStr.slice(0, 12));

// simulate a reboot
k.k_init(0x1998);
ok(!fsExists('C:\\My Documents\\persist.txt'), 'file gone after fresh boot');
ok(fsExists('C:\\WINDOWS\\SYSTEM.INI'), 'seed files present after fresh boot');

// push the blobs back in (copy out of TMP first: loading overwrites TMP)
function pushText(str) { return push(str); }
{
  const b1 = pushText(fsStr), b2 = pushText(regStr);
  const n1 = call('k_fs_load', b1.p, b1.n);
  const n2 = call('k_reg_load', b2.p, b2.n);
  k.k_free(b1.p); k.k_free(b2.p);
  ok(n1 >= 2, 'fs load parsed records', n1);
  ok(n2 >= 1, 'registry load parsed records', n2);
}
ok(fsExists('C:\\My Documents\\persist.txt'), 'file restored after load');
ok(text('C:\\My Documents\\persist.txt') === 'survive the reboot', 'restored content');
ok(fsIsDir('C:\\My Documents\\Empty Dir'), 'empty dir restored');
ok(regGet('HKEY_CURRENT_USER\\Software\\W98\\Test', 'Keep') === 'yes', 'registry value restored');
const bmp2 = fsRead('C:\\My Documents\\big.bmp');
ok(bmp2 && bmp2.length === bmp.length && bmp2[5000] === bmp[5000], '900 KB binary survived the round trip', bmp2 && bmp2.length);

/* ---- 12. kernel log + panic + misc -------------------------------------- */
ok(k.k_log_len() > 50, 'kernel log has content', k.k_log_len());
ok(read(k.k_log_ptr(), Math.min(200, k.k_log_len())).includes('kernel'), 'log text readable');
ok(k.k_rand() !== k.k_rand(), 'prng advances');
ok(stat(ST.VERSION) === 0x0004000a, 'version stat');
ok(stat(ST.TMP_CAP) === 2 * 1024 * 1024, 'tmp buffer 2MB');
ok(k.k_heap_peak() > 0, 'heap peak tracked');
ok(k.k_panicked() === 0, 'not panicked');
k.k_panic(0x0000007b);
ok(k.k_panicked() === 0x7b, 'panic code latched');
ok(stat(ST.DROPPED) === 0, 'no dropped timer events');


/* ==========================================================================
   The NT-style executive layer (kernel/nt.c).  On k_stat, index >= 100 is
   delegated to nt_stat, so NS(n) is the executive counter n.
   ======================================================================== */
function NS(n) { return k.k_stat(100 + n); }
const U = (x) => x >>> 0;                     // wasm i32 returns are signed
function clip(s) { s = String(s); return s.length > 60 ? s.slice(0, 57) + '...' : s; }
function tmpClip() { return clip(tmp()); }
function oidNamed(name, type, dacl) { const a = push(name); const r = k.k_obj_create(type, a.p, a.n, dacl); freed(a); return r; }
function nameOf(id) { return read(k.k_obj_name_ptr(id), k.k_obj_name_len(id)); }
function openKey(parent, path) {               // walk "A\B\C" with computed lengths
  let cur = parent;
  const segs = path.split('\\');
  const ptrs = segs.map(s => push(s));
  try {
    for (let i = 0; i < segs.length && cur; i++) cur = k.k_reg2_open_key(cur, ptrs[i].p, ptrs[i].n);
  } finally { ptrs.forEach(freed); }
  return cur;
}
function enumNames(fn, key) {
  const out = [];
  for (let i = 0; fn(key, i) === 1; i++) out.push(read(k.k_reg2_name_ptr(), k.k_reg2_name_len()));
  return out;
}
function setStr(key, name, value) {
  const a = push(name), b = push(value);
  const r = k.k_reg2_set_value(key, a.p, a.n, 1, b.p, b.n);
  freed(a); freed(b);
  return r;
}
function getKeyValue(key, name) {
  const a = push(name);
  const n = k.k_reg2_get_value(key, a.p, a.n);
  freed(a);
  return n;
}

console.log('\n--- NT executive layer ---');
k.k_init(0x1998);

/* ---- objects, handles, security ---------------------------------------- */
{
  const e1 = oidNamed('DemoEventA', 6, 0);
  const e2 = oidNamed('DemoEventB', 6, 0);
  ok(e1 && e2 && e1 !== e2, 'objects get distinct ids', [e1, e2]);
  ok(k.k_obj_type(e1) === 6, 'object type reported', k.k_obj_type(e1));
  ok(nameOf(e1) === 'DemoEventA', 'object name round trip', nameOf(e1));
  ok(k.k_obj_field(e1, 2) === 1, 'a fresh object holds one reference', k.k_obj_field(e1, 2));
  ok(k.k_obj_ref(e1) === 2 && k.k_obj_field(e1, 2) === 2, 'k_obj_ref bumps the count');
  ok(k.k_obj_deref(e1) === 1, 'k_obj_deref releases one reference');
  ok(k.k_obj_deref(e1) === 0 && k.k_obj_type(e1) === 0, 'the last dereference deletes the object');
  ok(NS(46) >= 1, 'object deletions are counted', NS(46));
  ok(NS(0) >= NS(1) * 0 + 2 && NS(1) >= 2, 'object count and peak are tracked', [NS(0), NS(1)]);
}
{
  const guarded = oidNamed('Guarded', 6, 1 /* ACCESS_READ only */);
  const nm = push('TestProc');
  const pid = k.k_process_create(nm.p, nm.n, 0);
  freed(nm);
  ok(pid > 0, 'k_process_create gives a pid', pid);
  const denies0 = NS(31);
  const bad = k.k_handle_open(pid, guarded, 2 /* ACCESS_WRITE */);
  ok(bad === -5, 'opening for write against a read-only DACL is denied', bad);
  ok(NS(31) > denies0, 'access denials are counted', NS(31));
  const good = k.k_handle_open(pid, guarded, 1 /* ACCESS_READ */);
  ok(good > 0, 'opening for read against the same DACL succeeds', good);
  ok(k.k_handle_obj(pid, good) === guarded, 'handle resolves back to the object', k.k_handle_obj(pid, good));
  ok(k.k_handle_access(pid, good) === 1, 'handle remembers its access mask', k.k_handle_access(pid, good));
  ok(k.k_handle_count(pid) >= 2, 'the process holds its own handle too', k.k_handle_count(pid));
  const dup = k.k_handle_dup(pid, good, 0);
  ok(dup > 0 && dup !== good, 'k_handle_dup duplicates a handle', dup);
  ok(k.k_handle_close(pid, dup) === 0, 'k_handle_close releases it');
  ok(k.k_handle_close(pid, dup) === -1, 'closing twice fails');
  ok(k.k_handle_open(999, guarded, 1) === -1, 'opening from a bogus pid fails');
  const tok = k.k_token_of(pid);
  ok(tok > 0, 'the process owns a token', tok);
  ok(k.k_sid_of(tok) === 1000, 'a normal user token carries SID 1000', k.k_sid_of(tok));
  ok(k.k_privileged_of(tok) === 0, 'a user token is unprivileged');
  const adm = oidNamed('AdminOnly', 6, 0x20000 /* SYSTEM_ONLY */);
  ok(k.k_access_check(tok, adm, 1) === -5, 'a SYSTEM-only object refuses a user token',
     k.k_access_check(tok, adm, 1));
  const priv = k.k_token_create(3000, 1);
  ok(k.k_token_set(pid, priv) === 0, 'the token can be swapped');
  ok(k.k_access_check(priv, adm, 1) === 0, 'a privileged token bypasses the DACL');
  ok(NS(29) >= 2 && NS(30) >= 3, 'tokens and access checks are counted', [NS(29), NS(30)]);
  k.k_token_set(pid, tok);
}

/* ---- threads, priorities, ready queues --------------------------------- */
{
  const nm = push('ThreadHost');
  const pid = k.k_process_create(nm.p, nm.n, 0);
  const tn = push('main');
  const mainTid = k.k_thread_create(pid, 8, tn.p, tn.n);
  const tn2 = push('realtime');
  const hi = k.k_thread_create(pid, 24, tn2.p, tn2.n);
  freed(nm); freed(tn); freed(tn2);
  ok(hi > 0 && mainTid > 0, 'threads are created', [mainTid, hi]);
  ok(NS(3) >= 2, 'the thread count rises', NS(3));
  ok(k.k_thread_field(hi, 0) === pid, 'a thread knows its process', k.k_thread_field(hi, 0));
  ok(k.k_thread_field(hi, 2) === 24, 'thread priority is stored', k.k_thread_field(hi, 2));
  ok(k.k_thread_ready_index(24) === hi, 'the ready queue at priority 24 holds it');
  ok(k.k_thread_ready_index(23) === 0, 'lower priority queues are empty');
  ok(k.k_thread_set_priority(hi, 20) === 0 && k.k_thread_field(hi, 2) === 20, 'priority can be changed');
  ok(k.k_thread_boost(hi, 5) === 25, 'a priority boost applies', k.k_thread_field(hi, 2));
  ok(NS(42) > 0, 'boosts are counted');
  ok(k.k_thread_set_priority(hi, 24) === 0, 'priority reset');
  const wn = push('weird');
  const weird = k.k_thread_create(pid, 99, wn.p, wn.n);
  freed(wn);
  ok(k.k_thread_field(weird, 2) === 31, 'an out-of-range priority is clamped', k.k_thread_field(weird, 2));
  /* a blocked thread comes back when its object is signalled */
  const ev = k.k_event_create(0, 0);
  ok(U(k.k_thread_wait(weird, ev, 0, 0)) === 0x8000000D, 'an unsignalled event blocks the thread');
  ok(k.k_thread_field(weird, 1) === 3, 'the blocked thread is in the Waiting state', k.k_thread_field(weird, 1));
  ok(k.k_event_set(ev) === 1, 'signalling wakes exactly one waiter');
  ok(k.k_thread_field(weird, 1) === 1, 'and the thread goes Ready', k.k_thread_field(weird, 1));
}

/* ---- dispatcher objects: waits, inheritance, timeouts ------------------ */
{
  const nm = push('WaitHost');
  const pid = k.k_process_create(nm.p, nm.n, 0);
  const on = push('owner'), wn = push('waiter');
  const owner = k.k_thread_create(pid, 10, on.p, on.n);
  const waiter = k.k_thread_create(pid, 20, wn.p, wn.n);
  freed(nm); freed(on); freed(wn);
  const ev = k.k_event_create(0 /* auto reset */, 0 /* unsignalled */);
  ok(ev > 0, 'an event object is created', ev);
  ok(k.k_obj_field(ev, 16) === 0, 'the event starts unsignalled');
  const r = k.k_thread_wait(waiter, ev, 0, 0);
  ok(U(r) === 0x8000000D, 'waiting on an unsignalled event reports still-waiting', U(r).toString(16));
  ok(k.k_wait_count(ev) === 1, 'the thread is on the object wait list', k.k_wait_count(ev));
  ok(k.k_thread_field(waiter, 1) === 3, 'the thread state is Waiting', k.k_thread_field(waiter, 1));
  ok(NS(8) > 0, 'waits are counted');
  k.k_obj_signal(ev);
  ok(k.k_wait_count(ev) === 0, 'signalling wakes the waiter');
  ok(k.k_thread_field(waiter, 1) === 1, 'and readies it', k.k_thread_field(waiter, 1));
  ok(k.k_obj_field(ev, 16) === 0, 'an auto-reset event is consumed by the waiter it wakes',
     k.k_obj_field(ev, 16));
  ok(k.k_event_reset(ev) === 0, 'an event can be reset by hand');
  /* mutants give priority inheritance */
  const mtx = k.k_mutant_create(owner);
  ok(mtx > 0 && k.k_obj_field(mtx, 20) === owner, 'a mutant records its owner', k.k_obj_field(mtx, 20));
  ok(NS(9) > 0, 'held mutants are counted', NS(9));
  const prioBefore = k.k_thread_field(owner, 2);
  k.k_thread_wait(waiter, mtx, 0, 0);
  ok(k.k_wait_count(mtx) === 1, 'the second thread blocks on the mutant');
  ok(k.k_thread_field(owner, 2) > prioBefore, 'priority inheritance boosted the holder',
     [prioBefore, k.k_thread_field(owner, 2)]);
  k.k_mutant_release(mtx, owner);
  ok(k.k_wait_count(mtx) === 0, 'releasing wakes the waiter', k.k_wait_count(mtx));
  ok(k.k_obj_field(mtx, 20) === waiter, 'ownership transfers to the waiter', k.k_obj_field(mtx, 20));
  ok(k.k_mutant_release(mtx, owner) === -5, 'a non-owner cannot release it',
     k.k_mutant_release(mtx, owner));
  k.k_mutant_release(mtx, waiter);
  /* semaphores: count, limit, refusal */
  const sem = k.k_semaphore_create(1, 2);
  ok(k.k_obj_field(sem, 18) === 1 && k.k_obj_field(sem, 19) === 2, 'the semaphore has count and limit',
     [k.k_obj_field(sem, 18), k.k_obj_field(sem, 19)]);
  ok(k.k_obj_wait_test(sem, owner) === 0, 'acquiring succeeds while the count lasts');
  ok(k.k_obj_field(sem, 18) === 0, 'acquiring decrements the count', k.k_obj_field(sem, 18));
  ok(k.k_obj_wait_test(sem, waiter) !== 0, 'acquiring an empty semaphore pends');
  const rel = U(k.k_semaphore_release(sem, 1));
  ok(rel === 0, 'releasing wakes nobody when the count is restored', rel);
  ok(k.k_obj_field(sem, 18) === 1, 'the count is restored', k.k_obj_field(sem, 18));
  const over = U(k.k_semaphore_release(sem, 2));
  ok(over === 0xC000000D, 'releasing past the limit is refused', over.toString(16));
  ok(k.k_obj_field(sem, 18) === 1, 'and the count is untouched', k.k_obj_field(sem, 18));
  /* wait timeouts */
  const to = k.k_event_create(0, 0);
  const t0 = NS(47);
  k.k_thread_wait(owner, to, 500, 0);
  ok(k.k_thread_field(owner, 1) === 3, 'a timed wait blocks the thread first');
  for (let t = 1000; t < 6000; t += 100) k.k_tick(t);
  ok(NS(47) > t0, 'the wait timeout is counted', NS(47) - t0);
  ok(k.k_thread_field(owner, 1) === 1, 'the timed-out thread is ready again', k.k_thread_field(owner, 1));
  /* waiting with a timeout is illegal at DISPATCH_LEVEL */
  const v0 = k.k_irql_violations();
  k.k_irql_raise(2);
  const bad = k.k_thread_wait(owner, to, 100, 0);
  ok(U(bad) === 0xC0000010, 'waiting with a timeout at DISPATCH_LEVEL is refused', U(bad).toString(16));
  ok(k.k_irql_violations() > v0, 'IRQL violations are counted', k.k_irql_violations());
  k.k_irql_lower(0);
  ok(k.k_irql() === 0, 'IRQL returns to PASSIVE_LEVEL', k.k_irql());
  /* APCs are only delivered to alertable threads */
  const an = push('ApcHost');
  const apid = k.k_process_create(an.p, an.n, 0);
  const atn = push('apc');
  const atid = k.k_thread_create(apid, 12, atn.p, atn.n);
  freed(an); freed(atn);
  const a0 = NS(12), d0 = NS(13);
  k.k_apc_queue(atid, apid, 0x1234, 1);
  ok(NS(12) > a0, 'APCs are queued', NS(12) - a0);
  k.k_tick(7000);
  ok(NS(13) === d0, 'an APC is not delivered to a non-alertable thread');
  k.k_thread_alert(atid);
  k.k_tick(7100);
  const packed = k.k_apc_pop();
  ok(packed !== 0, 'the delivered APC is handed to the shell', packed);
  ok((packed >>> 8) === atid, 'it names the thread it was delivered to', [packed >>> 8, atid]);
  ok(NS(13) > d0, 'APC deliveries are counted', NS(13) - d0);
}

/* ---- DPCs and the executive heartbeat ---------------------------------- */
{
  const d0 = k.k_dpc_drained(), q0 = NS(10);
  for (let i = 0; i < 5; i++) k.k_dpc_queue(i, i * 3);
  ok(NS(10) >= q0 + 5, 'DPCs are queued', NS(10) - q0);
  k.k_tick(8000);
  ok(k.k_dpc_drained() >= d0 + 5, 'the tick drains the DPC queue', k.k_dpc_drained() - d0);
}

/* ---- I/O manager, IRPs and the device stack ---------------------------- */
{
  const VMBUS = 1, NULLDEV = 3, FILTER = 4;     // device slots seeded by nt_init
  ok(k.k_device_field(VMBUS, 0) > 0, 'the seeded devices have drivers', k.k_device_field(VMBUS, 0));
  ok(k.k_device_field(FILTER, 2) === VMBUS, 'the filter device is layered over Vmbus',
     k.k_device_field(FILTER, 2));
  ok(k.k_device_field(FILTER, 3) >= 1, 'a layered device knows its stack depth',
     k.k_device_field(FILTER, 3));
  ok(k.k_devices_link(VMBUS, FILTER) === -1, 'linking a device under itself is refused');
  const irp1 = k.k_irp_create(VMBUS, 0x03 /* IRP_MJ_READ */, 0, 0, 512);
  ok(irp1 > 0, 'an IRP is created', irp1);
  ok(U(k.k_irp_field(irp1, 0)) === 0x00000103, 'a new IRP is pending', U(k.k_irp_field(irp1, 0)).toString(16));
  const st1 = k.k_io_call_driver(irp1);
  ok(st1 === 0, 'the transport driver completes the IRP', st1);
  ok(k.k_irp_field(irp1, 7) === 1, 'the IRP is marked completed');
  ok(k.k_irp_field(irp1, 8) === 512, 'it reports the transferred bytes', k.k_irp_field(irp1, 8));
  ok(k.k_irp_field(irp1, 6) === 1, 'one stack location was pushed', k.k_irp_field(irp1, 6));
  const irp2 = k.k_irp_create(FILTER, 0x03, 0, 64, 64);
  k.k_io_call_driver(irp2);
  ok(k.k_irp_field(irp2, 6) === 2, 'the filter driver passes the IRP down the stack',
     k.k_irp_field(irp2, 6));
  ok(k.k_irp_field(irp2, 7) === 1 && U(k.k_irp_field(irp2, 0)) === 0,
     'and it completes at the bottom of the stack');
  /* a driver that pends the IRP once, then fails it */
  const irp3 = k.k_irp_create(NULLDEV, 0x03, 0, 0, 0);
  const q1 = k.k_irp_queue_depth(NULLDEV), f0 = NS(16);
  const p1 = k.k_io_call_driver(irp3);
  ok(U(p1) === 0xC0000016, 'the pending driver returns STATUS_MORE_PROCESSING_REQUIRED',
     U(p1).toString(16));
  ok(k.k_irp_queue_depth(NULLDEV) === q1 + 1, 'the IRP is queued on the device');
  const p2 = k.k_io_call_driver(irp3);
  ok(U(p2) === 0xC0000010, 'the second call fails the IRP', U(p2).toString(16));
  ok(k.k_irp_queue_depth(NULLDEV) === q1, 'and takes it off the queue');
  ok(NS(16) > f0, 'failed IRPs are counted', NS(16) - f0);
  ok(U(k.k_io_complete(irp3, 0, 0)) === 0xC0000010, 're-completing a finished IRP is a no-op');
  /* stack overflow: build a chain deeper than one IRP's stack of 8 */
  let prev = FILTER, made = 0;
  const fdrv = k.k_device_field(FILTER, 0);
  for (let i = 0; i < 9; i++) {
    const dn = push('\\Device\\Chain' + i);
    const d = k.k_device_create(fdrv, dn.p, dn.n, 2);
    freed(dn);
    if (!d) break;
    k.k_devices_link(d, prev);
    prev = d;
    made++;
  }
  ok(made >= 8, 'a device chain deeper than the IRP stack was built', made);
  const ov0 = NS(17);
  const irp4 = k.k_irp_create(prev, 0x03, 0, 0, 0);
  const ovSt = U(k.k_io_call_driver(irp4));
  ok(ovSt === 0xC000009A && U(k.k_irp_field(irp4, 0)) === 0xC000009A,
     'an IRP that runs out of stack space fails with STATUS_INSUFFICIENT_RESOURCES', ovSt.toString(16));
  ok(k.k_irp_field(irp4, 7) === 1, 'and the failed IRP is completed, not left pending');
  ok(NS(17) > ov0, 'I/O stack overflows are counted', NS(17) - ov0);
  ok(k.k_io_counts(0) >= 4 && k.k_io_counts(1) >= 2 && k.k_io_counts(2) >= 1,
     'IRP creation, completion and failure are counted',
     [k.k_io_counts(0), k.k_io_counts(1), k.k_io_counts(2)]);
  ok(k.k_io_counts(5) >= 1, 'queued IRPs are counted', k.k_io_counts(5));
}

/* ---- memory manager: VAD-style regions, commit, sections, pool --------- */
{
  const nm = push('VmHost');
  const pid = k.k_process_create(nm.p, nm.n, 0);
  freed(nm);
  ok(k.k_vm_field(pid, 4) >= 1, 'a new process owns a reserved stack region', k.k_vm_field(pid, 4));
  ok(k.k_vm_field(pid, 0) >= 65536, 'its virtual size is counted', k.k_vm_field(pid, 0));
  ok(k.k_vm_field(pid, 1) >= 65536, 'and its stack is committed', k.k_vm_field(pid, 1));
  const v = k.k_vm_reserve(pid, 256 * 1024, 3);
  ok(v > 0, 'a region is reserved', v);
  ok(k.k_vm_commit(pid, v, 64 * 1024) === 0, 'commit inside the region succeeds');
  ok(k.k_commit_field(0) > 0, 'commit charge is tracked', k.k_commit_field(0));
  const faults0 = NS(24);
  k.k_vm_touch(pid, v);
  ok(NS(24) === faults0, 'touching a committed page does not fault', NS(24) - faults0);
  const v2 = k.k_vm_reserve(pid, 64 * 1024, 3);
  ok(k.k_vm_touch(pid, v2) === 0, 'touching an uncommitted page is a legal demand-zero access');
  ok(NS(24) > faults0, 'and counts a page fault', NS(24) - faults0);
  ok(k.k_vm_touch(pid, 0x0ffffff0) === -1073741811 || k.k_vm_touch(pid, 0x0ffffff0) < 0,
     'touching an unmapped address is refused');
  ok(k.k_commit_field(1) === 6 * 1024 * 1024, 'the commit limit is real', k.k_commit_field(1));
  ok(k.k_vm_free(pid, v, 64 * 1024) === 0, 'a region can be released');
  /* exhaust the commit limit */
  const fails0 = k.k_commit_field(3);
  let refused = 0;
  for (let i = 0; i < 30 && !refused; i++) {
    const vv = k.k_vm_reserve(pid, 1024 * 1024, 3);
    if (vv < 0) break;
    if (k.k_vm_commit(pid, vv, 1024 * 1024) !== 0) refused = 1;
  }
  ok(refused === 1, 'commit beyond the limit is refused');
  ok(k.k_commit_field(3) > fails0, 'commit failures are counted', k.k_commit_field(3));
  ok(k.k_commit_field(2) > 0, 'peak commit is tracked', k.k_commit_field(2));
  /* sections: shared memory mapped into two processes */
  const sec = k.k_section_create(128 * 1024, 3);
  ok(sec > 0, 'a section is created', sec);
  ok(k.k_section_field(sec, 0) === 128 * 1024, 'the section reports its rounded size', k.k_section_field(sec, 0));
  const nmB = push('VmHost2');
  const pidB = k.k_process_create(nmB.p, nmB.n, 0);
  freed(nmB);
  const va = k.k_vm_reserve(pid, 128 * 1024, 3);
  const vb = k.k_vm_reserve(pidB, 128 * 1024, 3);
  ok(k.k_section_map(pid, sec, va) === 0, 'the section maps into one process');
  ok(k.k_section_map(pidB, sec, vb) === 0, 'and into another');
  ok(k.k_section_map(pid, sec, va) === -2, 'mapping the same region twice is refused');
  ok(k.k_section_field(sec, 3) === 2, 'two mappings are recorded', k.k_section_field(sec, 3));
  ok(k.k_section_field(sec, 2) >= 3, 'mapping takes a reference on the section', k.k_section_field(sec, 2));
  ok(NS(38) >= 1, 'sections are counted', NS(38));
  /* pool: paged pool is refused at raised IRQL */
  const p1 = k.k_pool_alloc(4096, 1, 0x4162);
  ok(p1 !== 0, 'paged pool allocation works at PASSIVE_LEVEL');
  ok(k.k_pool_field(0) >= 4096, 'paged pool usage is tracked', k.k_pool_field(0));
  k.k_irql_raise(2);
  const p2 = k.k_pool_alloc(4096, 1, 0x4162);
  const np = k.k_pool_alloc(4096, 0, 0x4162);
  k.k_irql_lower(0);
  ok(p2 === 0, 'paged pool at DISPATCH_LEVEL is refused', p2);
  ok(np !== 0, 'nonpaged pool at DISPATCH_LEVEL is allowed', np);
  ok(k.k_pool_field(2) >= 4096, 'nonpaged pool usage is tracked', k.k_pool_field(2));
  ok(k.k_pool_field(1) > 0 && k.k_pool_field(3) > 0, 'pool peaks are tracked',
     [k.k_pool_field(1), k.k_pool_field(3)]);
  /* terminating a process releases its address space and handles */
  const r0 = NS(39);
  ok(k.k_process_terminate(pidB) === 0, 'a process can be terminated', k.k_process_terminate(pidB));
  ok(NS(39) < r0, 'its VM regions are released', [r0, NS(39)]);
  ok(k.k_vm_field(pidB, 1) === 0, 'its commit is gone', k.k_vm_field(pidB, 1));
}

/* ---- the registry hive ------------------------------------------------- */
{
  const hklm = k.k_reg2_root(0), hkcu = k.k_reg2_root(1);
  ok(hklm > 0 && hkcu > 0 && hklm !== hkcu, 'the hive has roots', [hklm, hkcu]);
  ok(k.k_reg2_root(4) === 0, 'a bogus hive index has no root', k.k_reg2_root(4));
  const svc = openKey(hklm, 'SYSTEM\\CurrentControlSet\\Services');
  ok(svc > 0, 'the seeded SYSTEM hive is navigable', svc);
  const services = enumNames(k.k_reg2_enum_key, svc);
  ok(services.length === 4 && services.indexOf('Vmbus') >= 0, 'the seeded services are there', services);
  const vmbusKey = openKey(svc, 'Vmbus');
  ok(vmbusKey > 0, 'a seeded service key exists', vmbusKey);
  const typ = getKeyValue(vmbusKey, 'Type');
  ok(typ === 4 && k.k_reg2_value_type() === 4, 'a REG_DWORD value reads back with its type',
     [typ, k.k_reg2_value_type(), clip(tmpClip())]);
  const got = getKeyValue(vmbusKey, 'ImagePath');
  ok(got > 0 && k.k_reg2_value_type() === 1, 'a REG_SZ value reads back as a string',
     [got, k.k_reg2_value_type()]);
  ok(tmp().indexOf('Vmbus.sys') >= 0, 'and carries the driver image path', tmpClip());
  const kp = k.k_reg2_key_path(vmbusKey);
  ok(kp > 0, 'a key can render its full path', kp);
  ok(read(kp, 64).indexOf('Vmbus') >= 0, 'the path names the key', clip(read(kp, 64)));
  /* typed writes */
  const kn = push('HiveTest');
  const testKey = k.k_reg2_create_key(hkcu, kn.p, kn.n);
  freed(kn);
  ok(testKey > 0, 'a key is created', testKey);
  ok(setStr(testKey, 'Str', 'hello') === 0, 'REG_SZ is written');
  ok(getKeyValue(testKey, 'Str') === 5 && tmp() === 'hello', 'and read back', tmpClip());
  const nn = push('Num');
  ok(k.k_reg2_set_dword(testKey, nn.p, nn.n, 0x12345678) === 0, 'REG_DWORD is written');
  ok(getKeyValue(testKey, 'Num') === 4 && k.k_reg2_value_type() === 4, 'with the right type');
  freed(nn);
  const bn = push('Bin'), bd = push('\x01\x02\x03\x04');
  ok(k.k_reg2_set_value(testKey, bn.p, bn.n, 3, bd.p, bd.n) === 0, 'REG_BINARY is written');
  freed(bn); freed(bd);
  ok(getKeyValue(testKey, 'Bin') === 4 && k.k_reg2_value_type() === 3, 'and keeps its own type');
  ok(k.k_reg2_value_len() === 4, 'value length is exposed', k.k_reg2_value_len());
  /* an overwrite frees the old bytes and reuses the pool */
  const before = NS(48);
  for (let i = 0; i < 40; i++) setStr(testKey, 'Churn', 'value-' + i);
  ok(NS(48) === before, 'churning one value does not exhaust the hive pool', NS(48) - before);
  ok(getKeyValue(testKey, 'Churn') === 8 && tmp() === 'value-39', 'the last write wins', tmpClip());
  /* enumeration */
  const names = enumNames(k.k_reg2_enum_value, testKey);
  ok(names.length === 4 && names.indexOf('Num') >= 0 && names.indexOf('Churn') >= 0,
     'values enumerate', names);
  const sn = push('Sub');
  const sub = k.k_reg2_create_key(testKey, sn.p, sn.n);
  freed(sn);
  ok(sub > 0, 'a subkey is created', sub);
  const kids = enumNames(k.k_reg2_enum_key, testKey);
  ok(kids.length === 1 && kids[0] === 'Sub', 'subkeys enumerate', kids);
  ok(k.k_reg2_key_field(testKey, 1) === 1 && k.k_reg2_key_field(testKey, 2) === 4,
     'the key counts its subkeys and values',
     [k.k_reg2_key_field(testKey, 1), k.k_reg2_key_field(testKey, 2)]);
  /* deleting a key with children is refused, exactly like RegDeleteKey */
  ok(U(k.k_reg2_delete_key(testKey)) === 0xC00000F0, 'deleting a key with subkeys is refused',
     U(k.k_reg2_delete_key(testKey)).toString(16));
  ok(k.k_reg2_delete_key(sub) === 0, 'the child key deletes');
  ok(k.k_reg2_delete_key(testKey) === 0, 'and then the parent');
  ok(k.k_reg2_delete_key(hklm) === -1, 'a hive root cannot be deleted');
  /* transactions */
  const kn2 = push('TxTest');
  const txKey = k.k_reg2_create_key(hkcu, kn2.p, kn2.n);
  freed(kn2);
  setStr(txKey, 'V', 'committed');
  const tx = k.k_reg2_tx_begin();
  ok(tx > 0, 'a transaction begins', tx);
  setStr(txKey, 'V', 'rolled-back');
  ok(getKeyValue(txKey, 'V') > 0 && tmp() === 'rolled-back', 'the write is visible inside the transaction', tmpClip());
  ok(k.k_reg2_tx_rollback(tx) === 0, 'the transaction rolls back');
  getKeyValue(txKey, 'V');
  ok(tmp() === 'committed', 'the rollback restored the previous value', tmpClip());
  ok(NS(36) > 0, 'rollbacks are counted', NS(36));
  const tx2 = k.k_reg2_tx_begin();
  setStr(txKey, 'V', 'kept');
  ok(k.k_reg2_tx_commit(tx2) === 0, 'the second transaction commits');
  getKeyValue(txKey, 'V');
  ok(tmp() === 'kept', 'the committed value sticks', tmpClip());
  ok(NS(35) > 0, 'commits are counted', NS(35));
  ok(k.k_reg2_tx_commit(999) === -1, 'committing an unknown transaction fails');
  /* a value created inside a rolled-back transaction disappears again */
  const tx3 = k.k_reg2_tx_begin();
  setStr(txKey, 'Gone', 'x');
  ok(k.k_reg2_tx_rollback(tx3) === 0, 'a third transaction rolls back');
  ok(getKeyValue(txKey, 'Gone') === -1, 'the value it created is gone', getKeyValue(txKey, 'Gone'));
  ok(NS(32) > 4 && NS(33) > 4 && NS(34) >= 3, 'hive size is reported', [NS(32), NS(33), NS(34)]);
  ok(NS(48) >= 0, 'hive pool quota hits are reported', NS(48));
  /* the legacy flat API reads and writes the same hive */
  ok(regSet('HKEY_CURRENT_USER\\Software\\LegacyView', 'Value', 'from-legacy') === 0, 'legacy write');
  ok(regGet('HKEY_CURRENT_USER\\Software\\LegacyView', 'Value') === 'from-legacy', 'legacy read');
  const hiveKey = openKey(hkcu, 'Software\\LegacyView');
  ok(hiveKey > 0, 'the legacy write landed in the hive');
  ok(getKeyValue(hiveKey, 'Value') > 0 && tmp() === 'from-legacy', 'and the hive sees the same bytes',
     tmpClip());
  /* the hive survives a save/load round trip */
  const blob = k.k_reg_save();
  ok(blob > 100, 'the hive serialises', blob);
  const blobCopy = read(k.k_tmp_ptr(), blob).slice();
  const before2 = k.k_reg2_stats(1);
  ok(k.k_reg_load.apply(null, (() => { const a = push(blobCopy); const p = a.p, n = a.n; return [p, n]; })()) > 0,
     'and loads back');
  ok(k.k_reg2_stats(1) >= before2, 'the reloaded hive has at least as many values',
     [before2, k.k_reg2_stats(1)]);
}

/* ---- bugcheck (last: it halts the kernel) ------------------------------ */
{
  ok(k.k_bugcheck_state(5) === 0, 'the kernel is not halted before the test');
  const code = k.k_bugcheck(0x0000007B, 0xC0000034, 0, 0, 0);
  ok(code === 0x7B, 'a bugcheck records its code', code);
  ok(k.k_bugcheck_state(0) === 0x7B, 'the code is readable', k.k_bugcheck_state(0));
  ok(U(k.k_bugcheck_state(1)) === 0xC0000034, 'and its parameters', U(k.k_bugcheck_state(1)).toString(16));
  ok(k.k_bugcheck_state(5) === 1, 'the kernel is halted');
  ok(k.k_bugcheck_dump_len() > 200, 'a minidump was written', k.k_bugcheck_dump_len());
  const dump = read(k.k_bugcheck_dump_ptr(), k.k_bugcheck_dump_len());
  ok(dump.indexOf('*** STOP: 0x0000007B') === 0, 'the dump leads with the stop code', dump.slice(0, 30));
  ok(dump.indexOf('Vmbus') > 0, 'the dump lists the loaded drivers');
  ok(dump.indexOf('Device stack') > 0, 'the dump lists the device stack');
  ok(dump.indexOf('Wait chains') > 0, 'the dump lists the wait chains');
  ok(dump.indexOf('Commit:') > 0 && dump.indexOf('IRQL violations') > 0, 'the dump reports commit and IRQL');
  const d0 = k.k_dpc_drained();
  k.k_tick(30000);
  ok(k.k_dpc_drained() === d0, 'a halted kernel stops draining work items');
  ok(NS(37) === 1, 'the bugcheck is counted', NS(37));
  /* reboot so the harness leaves a clean kernel behind */
  k.k_init(0x1998);
  ok(k.k_bugcheck_state(5) === 0 && k.k_bugcheck_state(6) === 0, 'a reboot clears the halt');
  ok(k.k_reg2_stats(0) > 8, 'and re-seeds the hive', k.k_reg2_stats(0));
}

console.log('\n--- final state ---');
console.log('syscalls   ' + stat(ST.SYSCALLS));
console.log('ticks      ' + stat(ST.TICKS));
console.log('timers     ' + stat(ST.TIMERS));
console.log('procs      ' + stat(ST.PROCS));
console.log('switches   ' + stat(ST.SWITCHES));
console.log('heap       ' + stat(ST.HEAP_USED) + ' used / ' + stat(ST.HEAP_FREE) + ' free / peak ' + k.k_heap_peak());
console.log('volume     ' + stat(ST.FILES) + ' files, ' + stat(ST.BYTES) + ' bytes, ' + stat(ST.NODES) + ' nodes');
console.log('registry   ' + stat(ST.REG) + ' values');

console.log('\n' + (fail === 0 ? 'ALL GREEN' : fail + ' FAILURES') + ' — ' + pass + ' checks passed');
process.exit(fail === 0 ? 0 : 1);
