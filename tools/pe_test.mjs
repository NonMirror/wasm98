// PE loader acceptance test.  It exercises the bounded parser/interpreter with
// deterministic PE images from pe_fixtures.mjs, so no MinGW installation or
// browser DOM is needed.  Run: node tools/pe_test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  pe32Console, pe64Console, pe32WithUser32Import, pe32WithApiSetImport,
  pe32WithRelocation, pe64WithRelocation, pe64WithApiSetImport,
} from './pe_fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'web/js/pe-loader.js'), 'utf8');
const win32Source = readFileSync(join(root, 'web/js/win32-api.js'), 'utf8');
const context = { console, TextDecoder, TextEncoder, BigInt, Uint8Array, ArrayBuffer, DataView };
context.window = context;
context.globalThis = context;
context.W98 = {};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'web/js/pe-loader.js' });
vm.runInContext(win32Source, context, { filename: 'web/js/win32-api.js' });
const PE = context.W98PE || context.W98.PE;
const Win32 = context.W98Win32;
assert.ok(Win32 && typeof Win32.createRuntime === 'function', 'W98Win32.createRuntime export exists');
assert.ok(PE && typeof PE.parse === 'function', 'W98PE.parse export exists');

function parse(bytes, options) { return PE.parse(bytes, options || {}); }
function expectCode(fn, code, label) {
  assert.throws(fn, e => e && e.code === code, label + ' (' + code + ')');
}
function u32At(image, rva) {
  const b = image.readRva(rva, 4);
  return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
}

console.log('\n=== PE32/PE32+ loader acceptance test ===\n');
const x86 = parse(pe32Console());
assert.equal(x86.arch, 'x86');
assert.equal(x86.machine, 0x14c);
assert.equal(x86.magic, 0x10b);
assert.equal(x86.subsystemName, 'console');
assert.equal(x86.isConsole, true);
assert.equal(x86.isStaticallyLinked, true);
assert.equal(x86.entryRva, 0x1000);
assert.deepEqual(Array.from(x86.sections, s => s.name), ['.text']);
assert.deepEqual(Array.from(x86.entryBytes(6)), [0xb8, 42, 0, 0, 0, 0xc3]);
{ const r = x86.run(); assert.equal(r.status, 'exited'); assert.equal(r.exitCode, 42); assert.equal(r.steps, 2); }

const x64 = parse(pe64Console());
assert.equal(x64.arch, 'x86_64');
assert.equal(x64.machine, 0x8664);
assert.equal(x64.magic, 0x20b);
assert.equal(x64.subsystemName, 'console');
assert.equal(x64.entryRva, 0x1000);
{ const r = x64.run(); assert.equal(r.status, 'exited'); assert.equal(r.exitCode, 42); assert.equal(r.steps, 2); }
const consoleLaunch = PE.runConsole(pe32Console(), { maxSteps: 16 });
assert.equal(consoleLaunch.status, 'exited'); assert.equal(consoleLaunch.exitCode, 42);
assert.equal(consoleLaunch.console, true); assert.equal(consoleLaunch.gui, false);
expectCode(() => PE.runGui(pe32Console()), 'SUBSYSTEM_NOT_GUI', 'console cannot run through GUI entry point');
const launched = PE.run(pe32Console(), { maxSteps: 16 });
assert.equal(launched.status, 'exited'); assert.equal(launched.exitCode, 42);
assert.equal(launched.arch, 'x86'); assert.equal(launched.subsystem, 'console');

/* Imports are parsed by DLL and symbol, then filled through an explicit host
   resolver.  The test does not require a DOM: the callback is the ABI bridge
   user32/gdi32 implementations use to provide host functions. */
const calls = [];
const rtForImports = Win32.createRuntime();
const imported = parse(pe32WithUser32Import(), {
  resolveImport(dll, name) {
    calls.push([dll, name]);
    return function CreateWindowExA() { return 0x1234; };
  },
});
assert.equal(imported.imports.length, 1);
assert.equal(imported.imports[0].dll.toLowerCase(), 'user32.dll');
assert.equal(imported.imports[0].name, 'CreateWindowExA');
assert.deepEqual(Array.from(calls), [['user32.dll', 'CreateWindowExA']]);
assert.ok(imported.imports[0].address, 'resolved import receives an IAT address');
assert.ok(imported.imports[0].host, 'resolved import retains host callback');
assert.ok(Object.keys(imported.hostSlots).length === 1, 'one host callback slot allocated');
/* Execute a PE32 absolute-IAT call as well as merely parsing its import. */
const importedCallBytes = pe32WithUser32Import();
const importedCall = parse(importedCallBytes, { resolveImport(dll, name) {
  return name === 'CreateWindowExA' ? function () { return 0; } : null;
}});
const iatVA = 0x00400000 + 0x2048;
importedCall.image.set([0xff, 0x15, iatVA & 255, (iatVA >>> 8) & 255, (iatVA >>> 16) & 255, (iatVA >>> 24) & 255,
  0xb8, 42, 0, 0, 0, 0xc3], 0x1000);
assert.equal(importedCall.run({ maxSteps: 16 }).exitCode, 42, 'x86 absolute IAT call executes');
const importedHost = parse(pe32WithUser32Import(), { resolveImport: (dll, name) => rtForImports.resolve(dll, name) });
assert.equal(typeof importedHost.imports[0].host, 'function');

/* PE32+ API-set imports are the form produced by current MinGW/UCRT builds.
   Verify that the resolver aliases the API-set DLL to its CRT bridge and that
   a RIP-relative call through the 64-bit IAT returns to the guest. */
const apiSetRuntime = Win32.createRuntime();
const apiSet = parse(pe64WithApiSetImport(), {
  resolveImport: (dll, name) => apiSetRuntime.resolveImport(dll, name),
});
assert.equal(apiSet.arch, 'x86_64');
assert.equal(apiSet.imports[0].dll.toLowerCase(), 'api-ms-win-crt-stdio-l1-1-0.dll');
assert.equal(apiSet.imports[0].name, 'puts');
assert.ok(apiSet.imports[0].host, 'API-set import resolves through the CRT bridge');
const apiRun = apiSet.run({ maxSteps: 32 });
assert.equal(apiRun.status, 'exited');
assert.equal(apiRun.exitCode, 42);
assert.equal(apiSetRuntime.consoleText(), '\n');
apiSetRuntime.destroy();

const apiSet32Runtime = Win32.createRuntime();
const apiSet32 = parse(pe32WithApiSetImport(), {
  resolveImport: (dll, name) => apiSet32Runtime.resolveImport(dll, name),
});
assert.equal(apiSet32.arch, 'x86');
assert.equal(apiSet32.imports[0].dll.toLowerCase(), 'api-ms-win-crt-stdio-l1-1-0.dll');
assert.equal(apiSet32.run({ maxSteps: 32 }).status, 'exited');
assert.equal(apiSet32Runtime.consoleText(), '\n');
apiSet32Runtime.destroy();

/* A relocation entry is applied only when a non-preferred load base is used. */
const r32 = parse(pe32WithRelocation());
assert.equal(r32.relocations.length, 1);
assert.equal(r32.relocations[0].type, 3); // IMAGE_REL_BASED_HIGHLOW
const before32 = u32At(r32, 0x1100) >>> 0;
r32.applyRelocations(0x402000);
assert.equal(u32At(r32, 0x1100) >>> 0, (before32 + 0x2000) >>> 0);
const r64 = parse(pe64WithRelocation());
assert.equal(r64.relocations.length, 1);
assert.equal(r64.relocations[0].type, 10); // IMAGE_REL_BASED_DIR64
const before64 = r64.readRva(0x1100, 8);
r64.applyRelocations(0x140002000n);
const after64 = r64.readRva(0x1100, 8);
assert.equal(after64[0], before64[0]);
assert.equal(after64[1], (before64[1] + 0x20) & 255); // low 16 bits moved by 0x2000

/* Header hardening: reject unsupported machines and machine/optional-header
   mismatches before allocating an image. */
const badMachine = pe32Console();
badMachine[0x84] = 0x34; badMachine[0x85] = 0x12;
expectCode(() => parse(badMachine), 'UNSUPPORTED_MACHINE', 'unsupported machine');
const badMagic = pe32Console();
badMagic[0x98] = 0x0b; badMagic[0x99] = 0x02;
expectCode(() => parse(badMagic), 'MACHINE_MAGIC_MISMATCH', 'machine/magic mismatch');
const badSignature = pe32Console();
badSignature[0x80] = 0x51;
expectCode(() => parse(badSignature), 'BAD_PE_SIGNATURE', 'bad PE signature');



/* The user32/gdi32 bridge is deterministic in a headless host.  Exercise the
   same calls a GUI PE uses, including the window message path and pixel data;
   no document or canvas implementation is installed in this test context. */
const rt = Win32.createRuntime({ commandLine: 'sample.exe /quiet' });
const seenMessages = [];
const atom = rt.user32.RegisterClassExA({
  lpszClassName: 'PeTestWindow',
  lpfnWndProc(hwnd, message) { seenMessages.push(message); return 0; },
});
assert.ok(atom > 0, 'RegisterClassExA returns an atom');
const hwnd = rt.user32.CreateWindowExA({ className: 'PeTestWindow', title: 'PE test', width: 8, height: 6 });
assert.ok(hwnd > 0, 'CreateWindowExA returns a window handle');
assert.equal(rt.user32.ShowWindow(hwnd, Win32.constants.SW_SHOW), 0, 'first ShowWindow reports hidden state');
const hdc = rt.user32.GetDC(hwnd);
assert.ok(hdc > 0, 'GetDC returns a device context');
assert.equal(rt.gdi32.SetPixel(hdc, 2, 3, 0x000000ff), 0x000000ff, 'SetPixel returns COLORREF');
assert.equal(rt.gdi32.GetPixel(hdc, 2, 3), 0x000000ff, 'GetPixel round trip');
assert.equal(rt.gdi32.TextOutA(hdc, 0, 0, 'X'), 1, 'TextOutA works on virtual surface');
const surface = rt.surface(hwnd);
assert.equal(surface.width, 8); assert.equal(surface.height, 6);
assert.deepEqual(Array.from(surface.pixels.slice((3 * 8 + 2) * 4, (3 * 8 + 3) * 4)), [255, 0, 0, 255], 'RGBA pixel is red');
const message = {};
assert.equal(rt.user32.PostMessageA(hwnd, Win32.constants.WM_USER || 0x0400, 7, 9), 1, 'PostMessageA queues a message');
assert.equal(rt.user32.GetMessageA(message, hwnd, 0x0400, 0x0400), 1, 'GetMessageA dequeues a message');
assert.equal(rt.user32.DispatchMessageA(message), 0, 'DispatchMessageA invokes the window procedure');
assert.ok(seenMessages.includes(Win32.constants.WM_CREATE), 'WM_CREATE delivered');
assert.ok(seenMessages.includes(0x0400), 'posted message delivered');
assert.equal(rt.user32.SetWindowTextA(hwnd, 'renamed'), 1);
const title = {}; assert.equal(rt.user32.GetWindowTextA(hwnd, title, 32), 7); assert.equal(title.value, 'renamed');
assert.equal(rt.kernel32.GetCommandLineA(), 'sample.exe /quiet');
const outCount = {}; assert.equal(rt.kernel32.WriteConsoleA(Win32.constants.STD_OUTPUT_HANDLE, 'hello', 5, outCount), 1); assert.equal(outCount.value, 5); assert.equal(rt.consoleText(), 'hello');
rt.kernel32.ExitProcess(17); assert.equal(rt.exitCode, 17); assert.equal(rt.exited, true);
rt.destroy();

console.log('PE/Win32 checks passed — x86/x86_64 parse, imports, relocations, execution, user32, gdi32');
