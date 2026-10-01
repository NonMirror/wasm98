// Hypervisor acceptance test: instantiates web/wasm/hypervisor.wasm in Node and
// asserts every point of HV_ABI.md section 5.2.  Run: node tools/hv_test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = readFileSync(join(root, 'web/wasm/hypervisor.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, {});
const H = instance.exports;

const enc = new TextEncoder();
const dec = new TextDecoder();
const u8 = () => new Uint8Array(H.memory.buffer);
const dv = () => new DataView(H.memory.buffer);

/* hypercall codes */
const C_GET_HV_INFO = 0x0011, C_GET_REF_TIME = 0x0012, C_GET_VP_INDEX = 0x0013;
const C_ENABLE_HC_PAGE = 0x0060, C_QUERY_MSR = 0x0070, C_SET_MSR = 0x0071;
const C_CPUID = 0x0072;

/* MSRs */
const M_GUEST_OS_ID = 0x40000000, M_HYPERCALL = 0x40000001, M_VP_INDEX = 0x40000002;
const M_TIME_REF_COUNT = 0x40000020, M_SCONTROL = 0x40000080, M_SIEFP = 0x40000082;
const M_SIMP = 0x40000083, M_SINT0 = 0x40000090;

/* status codes */
const S_OK = 0, S_INVALID = 2, S_DENIED = 3, S_BADSTATE = 5, S_SLAT = 6, S_NOIMPL = 7;
/* partition states */
const PS = { EMPTY: 0, CREATED: 1, INIT: 2, RUNNING: 3, PAUSED: 4, STOPPED: 5, FAULTED: 6, DELETED: 7 };
/* guest boot flags */
const BF = { CPUID: 1, OSID: 2, HYPERCALL: 4, REFTIME: 8, VPINDEX: 16, SYNIC: 32, TIMER: 64, VMBUS: 128, FB: 256 };
const ALL_BOOT = 0x1FF;

let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + what + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function call(name, ...args) {
  const f = H[name];
  if (typeof f !== 'function') { fail++; console.log('  MISSING EXPORT: ' + name); return -1; }
  return f(...args);
}

/* the wasm staging area: scratch()+0 is reused for reads/frames, a separate
   arena high in the scratch buffer holds strings that must survive. */
const scratch = () => H.hv_scratch(0);
let strOff = 0;
const STR_BASE = 131072;
function pushStr(s) {
  const b = enc.encode(s);
  const p = scratch() + STR_BASE + strOff;
  u8().set(b, p);
  u8()[p + b.length] = 0;
  strOff = (strOff + b.length + 8) & ~3;
  if (strOff > 100000) strOff = 0;
  return { p, n: b.length };
}
function readStr(ptr, len) { return dec.decode(u8().subarray(ptr, ptr + len)); }
function u32s(ptr, n) { const d = dv(), out = []; for (let i = 0; i < n; i++) out.push(d.getUint32(ptr + i * 4, true)); return out; }
function pf(part, f) { return H.hv_partition_field(part, f); }
function vf(vp, f) { return H.hv_vp_field(vp, f); }
function logText() { const n = H.hv_log_len(); return n ? readStr(H.hv_log_ptr(), n) : ''; }
function guestLog(part) { const n = H.hv_guest_log_len(part); return n ? readStr(H.hv_guest_log_ptr(part), n) : ''; }
function pump(iter, ms) { let runs = 0; for (let i = 0; i < iter; i++) runs += H.hv_schedule(ms); return runs; }
function part(name) { const a = pushStr(name); return H.hv_partition_create(a.p, a.n); }
function pfnFor(part, gpa) {
  for (let p = 1; p < 4096; p++)
    if (H.hv_page_field(p, 0) === part && H.hv_page_field(p, 1) === gpa) return p;
  return 0;
}
function setFrame(part, code, inGpa, outGpa, a0, a1, a2, a3) {
  const d = new DataView(new ArrayBuffer(32));
  [code, 0, inGpa, outGpa, a0 | 0, a1 | 0, a2 | 0, a3 | 0].forEach((v, i) => d.setUint32(i * 4, v >>> 0, true));
  u8().set(new Uint8Array(d.buffer), scratch());
  H.hv_write_gpa(part, 0xE000, scratch(), 32);
}
function frameStatus(part) { H.hv_read_gpa(part, 0xE004, scratch(), 4); return u32s(scratch(), 1)[0]; }
function msrSet(vp, msr, lo, hi) { return H.hv_set_msr(vp, msr, lo >>> 0, (hi || 0) >>> 0); }
function msrGet(vp, msr) { H.hv_query_msr(vp, msr, scratch()); return u32s(scratch(), 2); }
function cpuid(leaf, sub) { H.hv_cpuid(0, leaf, sub, scratch()); return u32s(scratch(), 4); }
function chanOf(part) {
  for (let c = 1; c <= 16; c++) if (H.hv_vmbus_channel_field(c, 0) === part) return c;
  return 0;
}
function drainAll(ch, max) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const n = H.hv_vmbus_drain(ch, scratch(), 256);
    if (!n) break;
    out.push({ type: u32s(scratch(), 1)[0], text: readStr(scratch() + 8, n) });
  }
  return out;
}

console.log('\n=== hypervisor.wasm acceptance test (HV_ABI.md 5.2) ===\n');
console.log('module    ' + bytes.length + ' bytes, ' + Object.keys(H).filter(k => /^(hv_|guest_)/.test(k)).length + ' hv/guest exports');

/* ---- 1. init + info ----------------------------------------------------- */
const magic = call('hv_init', 1000, 8, 16, 16 * 1024 * 1024);
ok(magic === 0x48560001, 'hv_init returns the HV magic', magic);
ok(H.hv_magic() === 0x48560001, 'hv_magic');
ok(readStr(H.hv_vendor_ptr(), H.hv_vendor_len()) === 'Microsoft Hv', 'vendor string is "Microsoft Hv"', readStr(H.hv_vendor_ptr(), H.hv_vendor_len()));
ok(H.hv_signature() === 0x31237648, 'signature "Hv#1"', H.hv_signature().toString(16));
ok(H.hv_version() === 0x00060000, 'version 6.0', H.hv_version().toString(16));
ok(H.hv_max_partitions() === 8, 'max partitions 8', H.hv_max_partitions());
ok(H.hv_max_vps() === 16, 'max vps 16', H.hv_max_vps());
ok(H.hv_page_size() === 4096, 'page size 4 KB', H.hv_page_size());
ok(H.hv_phys_bytes() === 16 * 1024 * 1024, 'physical memory 16 MB', H.hv_phys_bytes());
ok(H.hv_ref_time_ms() === 1000, 'reference time starts at the requested value', H.hv_ref_time_ms());
ok(H.hv_debug_frame_words() === 8, 'hypercall frame is 32 bytes', H.hv_debug_frame_words());
ok(H.hv_debug_msg_size() === 256, 'SynIC message is 256 bytes', H.hv_debug_msg_size());
ok(H.hv_debug_fb_bytes() === 400 * 120 * 4, 'framebuffer is 400x120x32bpp', H.hv_debug_fb_bytes());
ok(H.hv_debug_gpa_limit() === 0xB0000, 'guest GPA window is 176 pages', H.hv_debug_gpa_limit());

/* ---- 2. the root partition ---------------------------------------------- */
ok(H.hv_partition_count() === 1, 'hv_init created the root partition', H.hv_partition_count());
ok(pf(1, 11) === 1, 'partition 1 is the root', pf(1, 11));
ok(pf(1, 1) === PS.RUNNING, 'root partition is running', pf(1, 1));
ok(readStr(pf(1, 2), pf(1, 3)) === 'ROOT', 'root partition name', readStr(pf(1, 2), pf(1, 3)));
ok(H.hv_partition_delete(1) === S_DENIED, 'root partition cannot be deleted', H.hv_partition_delete(1));
ok(H.hv_partition_stop(1) === S_DENIED, 'root partition cannot be stopped');
ok(H.hv_partition_count() === 1, 'root survived the delete attempt');
const rootVp = H.hv_partition_vp(1, 0);
ok(rootVp > 0, 'root has a VP', rootVp);
ok(vf(rootVp, 2) !== 2, 'the root VP is not dispatched (no guest)', vf(rootVp, 2));

/* ---- 3. two child partitions -------------------------------------------- */
const A = part('Windows 98 Guest A');
const B = part('Windows 98 Guest B');
ok(A > 1 && B > 1 && A !== B, 'two child partitions created', [A, B]);
ok(pf(A, 1) === PS.CREATED, 'child partition starts created', pf(A, 1));
ok(readStr(pf(A, 2), pf(A, 3)) === 'Windows 98 Guest A', 'partition name round trip', readStr(pf(A, 2), pf(A, 3)));
ok(H.hv_partition_count() === 3, 'partition count is 3', H.hv_partition_count());
const vpA = H.hv_vp_create(A, 0);
const vpB = H.hv_vp_create(B, 0);
ok(vpA > 0 && vpB > 0 && vpA !== vpB, 'a VP for each child', [vpA, vpB]);
ok(vf(vpA, 0) === A, 'vp.partition', vf(vpA, 0));
ok(vf(vpA, 1) === 0, 'vp.index', vf(vpA, 1));
ok(vf(vpA, 2) === 1, 'vp created state', vf(vpA, 2));
ok(H.hv_vp_count() === 3, 'vp count is 3', H.hv_vp_count());
ok(H.hv_vp_set_register(vpA, 0, 0xDEADBEEF) === 0, 'set a VP register');
ok((H.hv_vp_register(vpA, 0) >>> 0) === 0xDEADBEEF, 'read the VP register back', (H.hv_vp_register(vpA, 0) >>> 0).toString(16));
ok(H.hv_vp_set_register(vpA, 9, 1) === S_INVALID, 'out-of-range register refused');

/* ---- 4. init + start + boot both guests --------------------------------- */
ok(H.hv_partition_init(A) === 0, 'initialize partition A');
ok(pf(A, 1) === PS.INIT, 'A initialised', pf(A, 1));
ok(pf(A, 14) === 1, 'A has a guest image', pf(A, 14));
ok(pf(A, 5) === 176, 'A window is 176 GPA pages', pf(A, 5));
ok(H.hv_partition_init(B) === 0, 'initialize partition B');
ok(H.hv_partition_start(A) === 0, 'start partition A');
ok(H.hv_partition_start(B) === 0, 'start partition B');
ok(pf(A, 1) === PS.RUNNING, 'A running', pf(A, 1));
const runs = pump(30, 50);
ok(runs > 0, 'hv_schedule dispatched VPs', runs);
ok(H.hv_sched_field(4) === 2, 'two running vps', H.hv_sched_field(4));
const flagsA = H.hv_guest_field(A, 1);
ok((flagsA & BF.CPUID) !== 0, 'guest read CPUID 0x40000000', flagsA);
ok((flagsA & BF.OSID) !== 0, 'guest wrote GUEST_OS_ID', flagsA);
ok((flagsA & BF.HYPERCALL) !== 0, 'guest enabled the hypercall page', flagsA);
ok((flagsA & BF.REFTIME) !== 0, 'guest read the reference time', flagsA);
ok((flagsA & BF.VPINDEX) !== 0, 'guest read its VP index', flagsA);
ok((flagsA & BF.SYNIC) !== 0, 'guest set SIMP/SIEFP/SCONTROL and unmasked SINTs', flagsA);
ok((flagsA & BF.TIMER) !== 0, 'guest armed the synthetic timer', flagsA);
ok((flagsA & BF.VMBUS) !== 0, 'guest completed the VMBus handshake', flagsA);
ok((flagsA & BF.FB) !== 0, 'guest drew its framebuffer', flagsA);
ok(flagsA === ALL_BOOT, 'all nine boot steps completed', flagsA);
ok(H.hv_guest_field(A, 0) === 10, 'guest reached the run stage', H.hv_guest_field(A, 0));
ok(H.hv_guest_field(A, 13) === 0, 'guest reported no boot error', H.hv_guest_field(A, 13));
ok(H.hv_debug_guest_osid(A) === 0x00319831, 'HV_X64_MSR_GUEST_OS_ID is 0x00319831', H.hv_debug_guest_osid(A).toString(16));
const glogA = guestLog(A);
ok(glogA.includes('Microsoft Hv'), 'guest log names the vendor', glogA.split('\n')[1]);
ok(glogA.includes('HV_X64_MSR_GUEST_OS_ID'), 'guest log shows the OS id write');
ok(glogA.includes('hypercall page enabled'), 'guest log shows the hypercall page');
ok(glogA.includes('reference time'), 'guest log shows the reference time');
ok(glogA.includes('virtual processor index'), 'guest log shows the VP index');
ok(glogA.includes('SynIC up'), 'guest log shows SynIC setup');
ok(glogA.includes('synthetic timer armed'), 'guest log shows the timer');
ok(glogA.includes('VMBus channel'), 'guest log shows the channel');
ok(glogA.includes('framebuffer 400x120x32bpp'), 'guest log shows the framebuffer');
ok(glogA.includes('boot complete'), 'guest log shows boot complete');
ok(guestLog(B).includes('boot complete'), 'second guest booted too');
ok(H.hv_guest_field(B, 1) === ALL_BOOT, 'second guest completed all boot steps', H.hv_guest_field(B, 1));

/* ---- 5. the guest framebuffer is real pixels ---------------------------- */
{
  const n = H.hv_read_gpa(A, 0x10000, scratch(), 400 * 120 * 4);
  ok(n === 400 * 120 * 4, 'framebuffer readable through the SLAT', n);
  const px = new Uint32Array(u8().buffer, scratch(), 400 * 120);
  let ink = 0, bg = 0;
  for (let i = 0; i < px.length; i++) { if (px[i] === 0xFF101820) bg++; else ink++; }
  ok(bg > 30000, 'framebuffer was cleared to the console background', bg);
  ok(ink > 500, 'guest drew its boot log into the framebuffer', ink);
  let hbInk = 0;
  for (let y = 108; y < 116; y++) for (let x = 0; x < 400; x++) if (px[y * 400 + x] === 0xFF60FF60) hbInk++;
  ok(hbInk > 100, 'the guest keeps a green heartbeat line at the bottom of the framebuffer', hbInk);
}

/* ---- 6. GPA / SLAT: deposit, map, isolation ---------------------------- */
{
  const sA = pushStr('SECRET-A-WINDOW');
  const sB = pushStr('SECRET-B-WINDOW');
  ok(H.hv_write_gpa(A, 0x40000, sA.p, sA.n) === sA.n, 'write A data through hv_write_gpa');
  ok(H.hv_write_gpa(B, 0x40000, sB.p, sB.n) === sB.n, 'write B data through hv_write_gpa');
  H.hv_read_gpa(A, 0x40000, scratch(), 15);
  const ra = readStr(scratch(), 15);
  H.hv_read_gpa(B, 0x40000, scratch(), 15);
  const rb = readStr(scratch(), 15);
  ok(ra === 'SECRET-A-WINDOW', 'A reads back its own bytes', ra);
  ok(rb === 'SECRET-B-WINDOW', 'B reads back its own bytes', rb);
  ok(ra !== rb, 'partition A cannot see partition B memory at the same GPA');
  const pfnA = pfnFor(A, 0x40000), pfnB = pfnFor(B, 0x40000);
  ok(pfnA > 0 && pfnB > 0 && pfnA !== pfnB, 'the same GPA maps to different host pages per partition', [pfnA, pfnB]);
  ok(H.hv_page_field(pfnA, 0) === A, 'host page owner is A', H.hv_page_field(pfnA, 0));
  ok(H.hv_page_field(pfnB, 0) === B, 'host page owner is B', H.hv_page_field(pfnB, 0));
  ok(H.hv_page_field(pfnA, 3) === 1, 'host page is marked present', H.hv_page_field(pfnA, 3));

  /* map flags: ro, rw, deposit */
  ok(H.hv_gpa_state(A, 0x40000) === 3, 'A page is rw', H.hv_gpa_state(A, 0x40000));
  ok(H.hv_map_gpa(A, 0x40000, 1, 2) === 0, 'remap A page read-only');
  ok(H.hv_gpa_state(A, 0x40000) === 2, 'A page now read-only', H.hv_gpa_state(A, 0x40000));
  ok(H.hv_map_gpa(A, 0x40000, 1, 3) === 0, 'restore A page rw');
  ok(H.hv_gpa_state(A, 0x40000) === 3, 'A page rw again');
  ok(H.hv_gpa_state(A, 0xB0000) === 0, 'a GPA outside the window is unmapped', H.hv_gpa_state(A, 0xB0000));
  ok(H.hv_map_gpa(A, 0xA0000, 64, 3) === S_INVALID, 'map past the GPA window is refused', H.hv_map_gpa(A, 0xA0000, 64, 3));
  ok(H.hv_read_gpa(A, 0xB0000, scratch(), 16) === 0, 'read outside the window transfers nothing');
  ok(H.hv_write_gpa(A, 0xB0000, sA.p, 4) === 0, 'write outside the window transfers nothing');
  /* a real unmap frees the page */
  ok(H.hv_unmap_gpa(A, 0x50000, 1) === 0, 'unmap one page');
  ok(H.hv_gpa_state(A, 0x50000) === 0, 'unmapped page reports 0', H.hv_gpa_state(A, 0x50000));
  ok(H.hv_read_gpa(A, 0x50000, scratch(), 4) === 0, 'reading the unmapped page transfers nothing');
  ok(H.hv_map_gpa(A, 0x50000, 1, 3) === 0, 'map it back');
  ok(H.hv_gpa_state(A, 0x50000) === 3, 'mapped again');
  ok(H.hv_unmap_gpa(A, 0x60000, 1) === 0, 'unmap of an unmapped range is a no-op');
}

/* ---- 7. memory accounting ---------------------------------------------- */
ok(H.hv_memory_stats(0) === 16 * 1024 * 1024, 'memory total', H.hv_memory_stats(0));
ok(H.hv_memory_stats(1) > 0, 'mapped bytes', H.hv_memory_stats(1));
ok(H.hv_memory_stats(2) >= 0, 'reserved bytes', H.hv_memory_stats(2));
ok(H.hv_memory_stats(3) > 0, 'free bytes', H.hv_memory_stats(3));
ok(H.hv_memory_stats(4) > 0, 'deposit counter', H.hv_memory_stats(4));

/* ---- 8. CPUID virtualisation ------------------------------------------- */
{
  const v = cpuid(0x40000000, 0);
  ok(v[0] === 0x40000004, 'cpuid 0x40000000 max leaf', v[0].toString(16));
  const vendor = String.fromCharCode(...[v[1], v[2], v[3]].flatMap(w => [w & 255, (w >> 8) & 255, (w >> 16) & 255, (w >> 24) & 255]));
  ok(vendor === 'Microsoft Hv', 'cpuid 0x40000000 vendor', vendor);
  ok(cpuid(0x40000001, 0)[0] === 0x31237648, 'cpuid 0x40000001 signature "Hv#1"');
  ok(cpuid(0x40000002, 0)[0] === 0x00060000, 'cpuid 0x40000002 version');
  ok(cpuid(0x40000003, 0)[0] === 1, 'cpuid 0x40000003 privilege mask');
  const v1 = cpuid(1, 0);
  ok((v1[2] & 0x80000000) !== 0, 'cpuid 1 ECX[31] hypervisor-present bit', v1[2].toString(16));
  ok(cpuid(0x40000005, 0)[0] === 16, 'cpuid 0x40000005 implementation limits (max vps)');
  ok(cpuid(0x40000006, 0)[0] !== 0, 'cpuid 0x40000006 hardware features');
}

/* ---- 9. virtual MSRs --------------------------------------------------- */
{
  ok(msrSet(vpA, M_GUEST_OS_ID, 0xCAFEBABE, 0) === S_OK, 'MSR write accepted');
  ok(msrGet(vpA, M_GUEST_OS_ID)[0] === 0xCAFEBABE, 'MSR read back', msrGet(vpA, M_GUEST_OS_ID)[0].toString(16));
  msrSet(vpA, M_GUEST_OS_ID, 0x00319831, 0);
  ok(msrGet(vpA, M_GUEST_OS_ID)[0] === 0x00319831, 'guest OS id restored');
  ok(msrGet(vpA, M_VP_INDEX)[0] === vf(vpA, 1), 'VP_INDEX MSR matches the VP', msrGet(vpA, M_VP_INDEX)[0]);
  ok(msrSet(vpA, M_VP_INDEX, 9, 0) === S_DENIED, 'VP_INDEX is read-only', msrSet(vpA, M_VP_INDEX, 9, 0));
  const t1 = msrGet(vpA, M_TIME_REF_COUNT);
  const t1v = t1[0] + t1[1] * 4294967296;
  pump(4, 100);
  const t2 = msrGet(vpA, M_TIME_REF_COUNT);
  const t2v = t2[0] + t2[1] * 4294967296;
  ok(t2v > t1v, 'TIME_REF_COUNT advances in 100 ns units', [t1v, t2v]);
  ok(Math.abs((t2v - t1v) / 10000 - 400) < 2, 'TIME_REF_COUNT tracks the hypervisor clock', (t2v - t1v) / 10000);
  ok(msrGet(vpA, M_SIMP)[0] === 0x90000, 'SIMP virtual MSR', msrGet(vpA, M_SIMP)[0].toString(16));
  ok(msrGet(vpA, M_SIEFP)[0] === 0x91000, 'SIEFP virtual MSR');
  ok(msrGet(vpA, M_SCONTROL)[0] === 1, 'SCONTROL virtual MSR');
  const sint2 = msrGet(vpA, M_SINT0 + 2)[0];
  ok((sint2 & 0xFF) === 0x22, 'SINT2 vector', sint2.toString(16));
  ok((sint2 & 0x10000) === 0, 'SINT2 unmasked');
  ok(H.hv_msr_log_count(A) > 0, 'MSR access log is populated', H.hv_msr_log_count(A));
  const logN = H.hv_msr_log_count(A);
  let sawWrite = false, sawRead = false;
  for (let i = 0; i < logN; i++) {
    if (H.hv_msr_log_field(A, i, 0) === M_GUEST_OS_ID && H.hv_msr_log_field(A, i, 2) === 1) sawWrite = true;
    if (H.hv_msr_log_field(A, i, 0) === M_GUEST_OS_ID && H.hv_msr_log_field(A, i, 2) === 0) sawRead = true;
  }
  ok(sawWrite, 'MSR log records the GUEST_OS_ID write');
  ok(sawRead, 'MSR log records the GUEST_OS_ID read');
  ok(H.hv_msr_log_count(A) <= 32, 'MSR log keeps the last 32 accesses', H.hv_msr_log_count(A));
}

/* ---- 10. the hypercall engine (raw frames from the root) --------------- */
{
  const before = H.hv_hypercall_count();
  setFrame(A, C_GET_HV_INFO, 0, 0x92000, 0, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallGetHypervisorInfo returns success');
  ok(frameStatus(A) === S_OK, 'the frame status word was written back', frameStatus(A));
  H.hv_read_gpa(A, 0x92000, scratch(), 32);
  ok(readStr(scratch(), 12) === 'Microsoft Hv', 'call output carries the vendor', readStr(scratch(), 12));
  ok(u32s(scratch() + 16, 1)[0] === 0x31237648, 'call output carries the signature');

  setFrame(A, C_GET_REF_TIME, 0, 0x92000, 0, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallGetReferenceTime success');
  H.hv_read_gpa(A, 0x92000, scratch(), 4);
  ok(u32s(scratch(), 1)[0] === H.hv_ref_time_ms(), 'reference time call matches the hypervisor clock', [u32s(scratch(), 1)[0], H.hv_ref_time_ms()]);

  setFrame(A, C_GET_VP_INDEX, 0, 0x92000, 0, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallGetVpIndex success');
  H.hv_read_gpa(A, 0x92000, scratch(), 4);
  ok(u32s(scratch(), 1)[0] === vf(vpA, 1), 'vp index call output');

  setFrame(A, C_QUERY_MSR, 0, 0x92000, M_VP_INDEX, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallQueryMsr success');
  H.hv_read_gpa(A, 0x92000, scratch(), 8);
  ok(u32s(scratch(), 2)[0] === vf(vpA, 1), 'HvCallQueryMsr output');

  setFrame(A, C_SET_MSR, 0, 0, M_GUEST_OS_ID, 0x00319831, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallSetMsr success');
  ok(msrGet(vpA, M_GUEST_OS_ID)[0] === 0x00319831, 'HvCallSetMsr landed in the virtual MSR');

  setFrame(A, C_CPUID, 0, 0x92000, 0x40000000, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallCpuid success');
  H.hv_read_gpa(A, 0x92000, scratch(), 16);
  ok(u32s(scratch(), 4)[0] === 0x40000004, 'HvCallCpuid output', u32s(scratch(), 4));

  setFrame(A, C_ENABLE_HC_PAGE, 0, 0, 0xE000, M_HYPERCALL, 0, 0);
  ok(H.hv_vmcall(vpA) === S_OK, 'HvCallEnableHypercallPage success');

  setFrame(A, 0x1234, 0, 0, 0, 0, 0, 0);
  ok(H.hv_vmcall(vpA) === S_NOIMPL, 'unknown call code reports not implemented', H.hv_vmcall(vpA));
  ok(H.hv_hypercall_count() > before + 7, 'the hypercall counter rises', H.hv_hypercall_count());
  ok(vf(vpA, 4) > 7, 'per-VP hypercall counter', vf(vpA, 4));
}

/* ---- 11. synthetic timer + heartbeat ----------------------------------- */
{
  const fires = H.hv_timer_field(vpA, 0);
  ok(fires >= 5, 'synthetic timer fired at least 5 times', fires);
  ok(H.hv_timer_field(vpA, 1) > 0, 'timer records the last fire time', H.hv_timer_field(vpA, 1));
  ok(H.hv_timer_field(vpA, 3) === 1, 'timer is armed', H.hv_timer_field(vpA, 3));
  const hb = H.hv_guest_heartbeat(A);
  ok(hb >= 5, 'guest heartbeat rose with the timer', hb);
  ok(H.hv_guest_field(A, 3) === hb, 'every fire was serviced exactly once', [H.hv_guest_field(A, 3), hb]);
  const before = H.hv_guest_heartbeat(A);
  pump(20, 100);
  ok(H.hv_guest_heartbeat(A) > before, 'heartbeat keeps rising while running', [before, H.hv_guest_heartbeat(A)]);
  ok(H.hv_timer_field(vpB, 0) >= 5, 'the second partition has its own timer', H.hv_timer_field(vpB, 0));
}

/* ---- 12. SynIC delivery and drain ------------------------------------- */
{
  ok(H.hv_synic_field(vpA, 0) === 1, 'SCONTROL reflected in SynIC state', H.hv_synic_field(vpA, 0));
  ok(H.hv_synic_field(vpA, 1) === 0x90000, 'SIMP reflected', H.hv_synic_field(vpA, 1));
  ok(H.hv_synic_field(vpA, 2) === 0x91000, 'SIEFP reflected', H.hv_synic_field(vpA, 2));
  ok(H.hv_sint_field(vpA, 0, 0) === 0x20 && H.hv_sint_field(vpA, 0, 1) === 0, 'SINT0 vector 32 unmasked');
  ok(H.hv_sint_field(vpA, 2, 0) === 0x22 && H.hv_sint_field(vpA, 2, 1) === 0, 'SINT2 vector 34 unmasked');
  ok(H.hv_sint_field(vpA, 2, 2) > 0, 'SINT2 counted its interrupts', H.hv_sint_field(vpA, 2, 2));
  ok(H.hv_synic_field(rootVp, 4) > 0, 'the guest posted SynIC messages to the root partition', H.hv_synic_field(rootVp, 4));
  const n = H.hv_message_pop(rootVp, scratch(), 256);
  ok(n === 256, 'a SynIC message drains from the root queue', n);
  ok(u32s(scratch(), 1)[0] === 1, 'the drained message is a heartbeat', u32s(scratch(), 1)[0]);
  ok(readStr(scratch() + 12, 9) === 'heartbeat', 'the drained message carries text', readStr(scratch() + 12, 20));

  /* deliver a message INTO the guest and watch the guest drain it itself */
  const msg = new Uint8Array(256);
  new DataView(msg.buffer).setUint32(0, 7, true);
  new DataView(msg.buffer).setUint32(4, 5, true);
  msg.set(enc.encode('hello'), 12);
  u8().set(msg, scratch());
  const qbefore = H.hv_synic_field(vpA, 4);
  ok(H.hv_message_push(vpA, scratch(), 256) === 1, 'deliver a SynIC message to the guest VP');
  ok(H.hv_synic_field(vpA, 4) === qbefore + 1, 'guest VP message counter rose');
  pump(2, 200);
  ok(guestLog(A).includes('synic: drained message type 7'), 'the guest drained the message itself',
     guestLog(A).split('\n').filter(l => l.includes('synic')).slice(-1)[0]);
}

/* ---- 13. VMBus: offer, accept, data, injected commands ----------------- */
const chA = chanOf(A);
{
  ok(H.hv_vmbus_channel_count() >= 2, 'a channel per child partition', H.hv_vmbus_channel_count());
  ok(chA > 0 && chanOf(B) > 0 && chA !== chanOf(B), 'distinct channels for A and B', [chA, chanOf(B)]);
  ok(H.hv_vmbus_channel_field(chA, 1) === 2, 'the channel is open (offer accepted)', H.hv_vmbus_channel_field(chA, 1));
  ok(H.hv_vmbus_channel_field(chA, 2) !== 0, 'offer id low', H.hv_vmbus_channel_field(chA, 2).toString(16));
  ok(H.hv_vmbus_channel_field(chA, 9) === chA, 'channel id field');
  ok(H.hv_vmbus_channel_field(chA, 4) === 0x80000, 'ring GPA', H.hv_vmbus_channel_field(chA, 4).toString(16));
  ok(H.hv_vmbus_channel_field(chA, 10) === 0x88000, 'root->guest ring GPA', H.hv_vmbus_channel_field(chA, 10).toString(16));
  const got = drainAll(chA, 60);
  ok(got.some(m => m.type === 2), 'the guest sent offer-accepted (type 2)', got.slice(0, 5).map(m => m.type));
  ok(got.filter(m => m.type === 4).length >= 5, 'the guest sent heartbeat data frames (type 4)', got.length);
  ok(got.some(m => m.text.startsWith('heartbeat')), 'heartbeat text arrived in the root ring', got.slice(0, 3).map(m => m.text));
  ok(H.hv_vmbus_channel_field(chA, 5) > 0, 'channel in-bytes counter advanced', H.hv_vmbus_channel_field(chA, 5));
  ok(H.hv_vmbus_stats(5) >= 2, 'two channels open', H.hv_vmbus_stats(5));

  /* root -> guest: inject a ping and wait for the pong */
  const p = pushStr('ping');
  ok(H.hv_vmbus_inject(chA, p.p, p.n) === 4, 'inject "ping" into the guest ring');
  pump(4, 100);
  const after = drainAll(chA, 60);
  const pong = after.map(m => m.text).find(t => t.startsWith('pong'));
  ok(!!pong && pong.includes('partition ' + A), 'the guest answered the ping over VMBus', pong);
  ok(H.hv_guest_field(A, 7) === 1, 'guest recorded the ping command', H.hv_guest_field(A, 7));

  const cmd = 'log injected-from-root';
  const l = pushStr(cmd);
  const injected = H.hv_vmbus_inject(chA, l.p, l.n);
  ok(injected === cmd.length, 'inject "log ..."', injected);
  pump(4, 100);
  ok(guestLog(A).includes('injected-from-root'), 'the guest honoured the log command');
  ok(H.hv_guest_field(A, 7) === 2, 'guest recorded the log command', H.hv_guest_field(A, 7));
  ok(H.hv_guest_field(A, 6) === 2, 'guest command counter is 2', H.hv_guest_field(A, 6));
  /* an unknown command is ignored, not fatal */
  const u = pushStr('frobnicate');
  H.hv_vmbus_inject(chA, u.p, u.n);
  pump(2, 100);
  ok(guestLog(A).includes('unknown command'), 'unknown commands are logged and ignored');
  ok(pf(A, 1) === PS.RUNNING, 'the guest survived the unknown command', pf(A, 1));
}

/* ---- 14. VP time-slicing ----------------------------------------------- */
{
  ok(H.hv_sched_field(5) === 10, 'quantum is 10 ms', H.hv_sched_field(5));
  ok(H.hv_sched_field(0) > 0, 'slices counted', H.hv_sched_field(0));
  ok(H.hv_sched_field(1) > 0, 'preemptions happened', H.hv_sched_field(1));
  ok(H.hv_sched_field(2) > 0, 'context switches happened', H.hv_sched_field(2));
  ok(vf(vpA, 8) > 0 && vf(vpB, 8) > 0, 'both VPs were preempted', [vf(vpA, 8), vf(vpB, 8)]);
  ok(vf(vpA, 3) > 0 && vf(vpB, 3) > 0, 'both VPs accumulated run time (interleaved)', [vf(vpA, 3), vf(vpB, 3)]);
  ok(vf(vpA, 6) > 0 && vf(vpB, 6) > 0, 'both VPs executed guest instructions', [vf(vpA, 6), vf(vpB, 6)]);
  const ratio = vf(vpA, 3) / Math.max(1, vf(vpB, 3));
  ok(ratio > 0.4 && ratio < 2.5, 'run time is shared fairly between the two VPs', [vf(vpA, 3), vf(vpB, 3)]);
  ok(vf(vpA, 7) >= 0 && vf(vpA, 7) <= 1000, 'slice-left accounting is sane', vf(vpA, 7));
  ok((H.hv_vp_run_ns(vpA) >>> 0) > 0, 'raw run ns available', H.hv_vp_run_ns(vpA) >>> 0);
  ok(pf(A, 10) > 0 && pf(B, 10) > 0, 'both partitions counted dispatch runs', [pf(A, 10), pf(B, 10)]);
}

/* ---- 15. pause freezes the guest, the hypervisor clock keeps running ---- */
{
  const hb = H.hv_guest_heartbeat(A);
  const t = H.hv_ref_time_ms();
  ok(H.hv_partition_pause(A) === 0, 'pause partition A');
  ok(pf(A, 1) === PS.PAUSED, 'A is paused', pf(A, 1));
  ok(H.hv_sched_field(4) === 1, 'only one running vp while paused', H.hv_sched_field(4));
  pump(10, 1500);
  ok(H.hv_guest_heartbeat(A) === hb, 'paused guest heartbeat is frozen', [hb, H.hv_guest_heartbeat(A)]);
  ok(H.hv_ref_time_ms() > t + 1000, 'hypervisor reference time kept advancing', [t, H.hv_ref_time_ms()]);
  ok(H.hv_guest_heartbeat(B) > 0, 'the other partition keeps running while A is paused');
  ok(H.hv_partition_pause(A) === S_BADSTATE, 'pausing a paused partition is refused');
  ok(H.hv_partition_resume(A) === 0, 'resume partition A');
  ok(pf(A, 1) === PS.RUNNING, 'A is running again');
  const hb2 = H.hv_guest_heartbeat(A);
  pump(6, 200);
  ok(H.hv_guest_heartbeat(A) > hb2, 'heartbeat resumed after the pause', [hb2, H.hv_guest_heartbeat(A)]);
  ok(H.hv_partition_resume(A) === S_BADSTATE, 'resume of a running partition is refused');
}

/* ---- 16. SLAT fault on a hypercall buffer + probes --------------------- */
{
  const D = part('Fault Probe Guest');
  H.hv_vp_create(D, 0);
  ok(H.hv_partition_init(D) === 0, 'probe partition initialised');
  ok(H.hv_partition_start(D) === 0, 'probe partition started');
  const vpD = H.hv_partition_vp(D, 0);
  pump(2, 100);
  const f0 = pf(D, 9);
  setFrame(D, C_GET_REF_TIME, 0xB0000, 0, 0, 0, 0, 0);        /* in_gpa outside the window */
  const st = H.hv_vmcall(vpD);
  ok(st === S_SLAT, 'hypercall with an unmapped in_gpa reports HV_STATUS_SLAT_FAULT', st);
  ok(pf(D, 9) > f0, 'the SLAT fault counter rose', [f0, pf(D, 9)]);
  ok(pf(D, 1) === PS.FAULTED, 'the partition became faulted', pf(D, 1));
  ok(H.hv_slat_faults(D) > 0, 'hv_slat_faults(part)', H.hv_slat_faults(D));
  ok(logText().includes('hypercall buffer'), 'the hypervisor logged the hypercall buffer fault');
  ok(H.hv_probe_read_gpa(D, 0xB0000) === S_SLAT, 'probe read of an unmapped GPA reports SLAT_FAULT');
  ok(H.hv_probe_write_gpa(D, 0xB0000) === S_SLAT, 'probe write of an unmapped GPA reports SLAT_FAULT');
  ok(H.hv_probe_read_gpa(D, 0x10000) === S_OK, 'probe of a mapped GPA succeeds');
  ok(H.hv_read_gpa(D, 0xB0000, scratch(), 4) === 0, 'the JS read path transfers nothing on a bad GPA');
  H.hv_partition_delete(D);
  ok(pf(D, 1) === PS.EMPTY, 'deleted partition is gone from the table', pf(D, 1));
}

/* ---- 17. canary isolation check --------------------------------------- */
{
  const C = part('Canary Guest');
  H.hv_vp_create(C, 0);
  ok(H.hv_partition_init(C) === 0, 'canary partition initialised');
  ok(H.hv_partition_start(C) === 0, 'canary partition started');
  const vpC = H.hv_partition_vp(C, 0);
  pump(4, 100);
  ok(H.hv_guest_field(C, 1) === ALL_BOOT, 'the canary guest booted normally', H.hv_guest_field(C, 1));
  ok(pf(C, 1) === PS.RUNNING, 'canary partition running', pf(C, 1));
  ok(pf(C, 13) === 0, 'no canary faults yet');
  ok(H.hv_gpa_state(C, H.hv_debug_gpa_limit()) === 0, 'the guard page GPA is outside the guest window');
  ok(H.hv_canary_lo(C) > 0 && H.hv_canary_hi(C) > H.hv_canary_lo(C), 'guard pages exist around the window', [H.hv_canary_lo(C), H.hv_canary_hi(C)]);
  ok(H.hv_debug_guest_stray_write(C) === 1, 'inject a stray write outside the guest window');
  const hb = H.hv_guest_heartbeat(C);
  const v = H.hv_vm_entry(vpC);
  ok(v === 0, 'the next VM entry refused to continue', v);
  ok(pf(C, 13) === 1, 'the canary check caught the violation', pf(C, 13));
  ok(pf(C, 1) === PS.FAULTED, 'the partition faulted (state 6)', pf(C, 1));
  ok(pf(C, 9) > 0, 'the fault counter rose', pf(C, 9));
  ok(logText().includes('GUEST ISOLATION VIOLATION'), 'the hypervisor logged the isolation violation');
  pump(3, 200);
  ok(H.hv_guest_heartbeat(C) === hb, 'a faulted partition no longer runs', [hb, H.hv_guest_heartbeat(C)]);
  ok(H.hv_debug_guest_oob_write(C, 0xB0000) === 0, 'a guest store outside the window is refused by the SLAT');
  H.hv_partition_delete(C);
  ok(pf(C, 1) === PS.EMPTY, 'canary partition deleted');
}

/* ---- 18. the SLAT is what stops the guest, not politeness -------------- */
{
  const G = part('ReadOnly Guest');
  H.hv_vp_create(G, 0);
  H.hv_partition_init(G);
  ok(H.hv_partition_start(G) === 0, 'read-only test partition started');
  pump(3, 100);
  ok(H.hv_guest_field(G, 1) === ALL_BOOT, 'read-only test guest booted');
  ok(H.hv_map_gpa(G, 0x40000, 1, 2) === 0, 'make one guest page read-only');
  ok(H.hv_gpa_state(G, 0x40000) === 2, 'page is read-only', H.hv_gpa_state(G, 0x40000));
  ok(H.hv_debug_guest_oob_write(G, 0x40000) === 0, 'a guest store to a read-only page is refused');
  ok(pf(G, 1) === PS.FAULTED, 'the guest that stored to a read-only page faults', pf(G, 1));
  ok(logText().includes('read-only'), 'the hypervisor logged the read-only violation');
  H.hv_partition_delete(G);
}

/* ---- 19. a guest halted by the root ------------------------------------ */
{
  const E = part('Halting Guest');
  H.hv_vp_create(E, 0);
  H.hv_partition_init(E);
  H.hv_partition_start(E);
  pump(4, 100);
  ok(H.hv_guest_field(E, 1) === ALL_BOOT, 'the halting guest booted', H.hv_guest_field(E, 1));
  const chE = chanOf(E);
  const h = pushStr('halt');
  ok(H.hv_vmbus_inject(chE, h.p, h.n) === 4, 'inject "halt"');
  pump(4, 100);
  ok(pf(E, 1) === PS.STOPPED, 'the guest halted the partition', pf(E, 1));
  ok(H.hv_guest_field(E, 8) === 1, 'guest reports halted', H.hv_guest_field(E, 8));
  pump(2, 200);
  ok(pf(E, 1) === PS.STOPPED, 'a stopped partition stays stopped');
  ok(H.hv_guest_heartbeat(E) > 0, 'the halted guest kept its heartbeat history');
  H.hv_partition_delete(E);
}

/* ---- 20. lifecycle: stop, reset, delete -------------------------------- */
{
  const F = part('Lifecycle Guest');
  H.hv_vp_create(F, 0);
  H.hv_partition_init(F);
  const hb0 = H.hv_guest_heartbeat(B);
  H.hv_partition_stop(B);
  ok(pf(B, 1) === PS.STOPPED, 'stop partition B', pf(B, 1));
  pump(2, 200);
  ok(H.hv_guest_heartbeat(B) === hb0, 'a stopped partition does not run');
  ok(H.hv_partition_reset(B) === 0, 'reset partition B (reboot)');
  ok(pf(B, 1) === PS.INIT, 'B is re-initialised', pf(B, 1));
  ok(H.hv_guest_heartbeat(B) === 0, 'reset cleared the guest state');
  ok(H.hv_guest_field(B, 1) === 0, 'reset cleared the boot flags');
  H.hv_partition_start(B);
  pump(6, 100);
  ok(H.hv_guest_field(B, 1) === ALL_BOOT, 'the reset guest booted again', H.hv_guest_field(B, 1));
  ok(H.hv_guest_heartbeat(B) > 0, 'heartbeat running after the reboot');
  ok(chanOf(B) > 0, 'the VMBus channel was re-offered', chanOf(B));
  const freeBefore = H.hv_memory_stats(3);
  ok(H.hv_partition_delete(F) === 0, 'delete a partition');
  ok(pf(F, 1) === PS.EMPTY, 'deleted partition is empty', pf(F, 1));
  ok(H.hv_memory_stats(3) >= freeBefore, 'free memory reported after the delete', [freeBefore, H.hv_memory_stats(3)]);
  ok(H.hv_partition_count() === 3, 'partition count back to root+A+B', H.hv_partition_count());
}

/* ---- 21. hypervisor log ------------------------------------------------- */
{
  const t = logText();
  ok(t.length > 200, 'hypervisor log has content', t.length);
  ok(t.includes('hypervisor up'), 'log records the boot');
  ok(t.includes('root partition created'), 'log records the root partition');
  ok(t.includes('VMBus channel'), 'log records the channel offer');
  ok(t.includes('initialised'), 'log records partition initialisation');
  ok(t.includes('ISOLATION VIOLATION'), 'log records the isolation violation');
  ok(t.includes('fault'), 'log records faults');
  ok(H.hv_log_ptr() > 0 && H.hv_log_len() > 0, 'log accessors');
}

/* ---- final state -------------------------------------------------------- */
console.log('\n--- final state ---');
console.log('partitions   ' + H.hv_partition_count() + ' / ' + H.hv_max_partitions() + '   vps ' + H.hv_vp_count() + ' / ' + H.hv_max_vps());
console.log('hypercalls   ' + H.hv_hypercall_count() + '   slat faults ' + H.hv_slat_faults_total());
console.log('slices       ' + H.hv_sched_field(0) + '   preemptions ' + H.hv_sched_field(1) + '   switches ' + H.hv_sched_field(2));
console.log('memory       ' + (H.hv_memory_stats(1) / 1024) + ' KB mapped, ' + (H.hv_memory_stats(3) / 1024) + ' KB free of ' + (H.hv_memory_stats(0) / 1024) + ' KB');
console.log('guest A      heartbeat ' + H.hv_guest_heartbeat(A) + '  timer fires ' + H.hv_timer_field(vpA, 0) + '  instr ' + vf(vpA, 6));
console.log('guest B      heartbeat ' + H.hv_guest_heartbeat(B) + '  timer fires ' + H.hv_timer_field(vpB, 0) + '  instr ' + vf(vpB, 6));
console.log('vmbus        ' + H.hv_vmbus_channel_count() + ' channels, ' + H.hv_vmbus_stats(1) + ' messages, ' + H.hv_vmbus_stats(3) + ' bytes drained');
console.log('hypervisor log ' + H.hv_log_len() + ' bytes');
console.log('\n' + (fail === 0 ? 'ALL GREEN' : fail + ' FAILURES') + ' — ' + pass + ' checks passed');
process.exit(fail === 0 ? 0 : 1);
