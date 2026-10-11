/*
 * Tiny, deterministic PE32 and PE32+ images used by pe_test.mjs.  They are
 * deliberately built in JavaScript so the acceptance test does not depend on
 * a host MinGW/LLVM installation.  The entry point consists of `return 42`;
 * there is no CRT and no writable global state.  The import image contains a
 * single user32.dll import and exercises the import-directory walk without
 * requiring a linker-generated binary.
 */

function image(size = 0x800) {
  return new Uint8Array(size);
}
function w16(b, o, n) { b[o] = n & 255; b[o + 1] = (n >>> 8) & 255; }
function w32(b, o, n) {
  n >>>= 0;
  b[o] = n & 255; b[o + 1] = (n >>> 8) & 255;
  b[o + 2] = (n >>> 16) & 255; b[o + 3] = (n >>> 24) & 255;
}
function w64(b, o, n) {
  let x = BigInt(n);
  for (let i = 0; i < 8; i++, x >>= 8n) b[o + i] = Number(x & 255n);
}
function ascii(b, o, s) {
  for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i) & 255;
  b[o + s.length] = 0;
}

function basePE({ pe64 = false, imports = false, relocations = false } = {}) {
  const nsects = (imports ? 2 : 1) + (relocations ? 1 : 0);
  const optSize = pe64 ? 240 : 224;
  const peOff = 0x80;
  const coff = peOff + 4;
  const opt = coff + 20;
  const sect = opt + optSize;
  const imageSize = relocations ? 0x4000 : (imports ? 0x3000 : 0x2000);
  const fileSize = relocations ? 0xa00 : (imports ? 0x800 : 0x400);
  const b = image(fileSize);

  /* DOS header and the PE signature. */
  b[0] = 0x4d; b[1] = 0x5a; w32(b, 0x3c, peOff);
  b.set([0x50, 0x45, 0, 0], peOff);
  w16(b, coff, pe64 ? 0x8664 : 0x14c);
  w16(b, coff + 2, nsects);
  w32(b, coff + 4, 0x65000000);       // deterministic timestamp
  w16(b, coff + 16, optSize);
  w16(b, coff + 18, 0x0102);           // executable, 32-bit machine

  w16(b, opt, pe64 ? 0x20b : 0x10b);
  b[opt + 2] = 14; b[opt + 3] = 0;     // linker version
  w32(b, opt + 4, 0x200);              // SizeOfCode
  w32(b, opt + 8, 0);                  // initialized data
  w32(b, opt + 16, 0x1000);            // AddressOfEntryPoint
  w32(b, opt + 20, 0x1000);            // BaseOfCode
  if (pe64) {
    w64(b, opt + 24, 0x140000000n);    // ImageBase
    w32(b, opt + 32, 0x1000);          // SectionAlignment
    w32(b, opt + 36, 0x200);           // FileAlignment
    w32(b, opt + 56, imageSize);       // SizeOfImage
    w32(b, opt + 60, 0x200);           // SizeOfHeaders
    w16(b, opt + 68, 3);               // IMAGE_SUBSYSTEM_WINDOWS_CUI
    w32(b, opt + 108, 16);             // NumberOfRvaAndSizes
    if (imports) { w32(b, opt + 120, 0x2000); w32(b, opt + 124, 0x100); }
    if (relocations) { w32(b, opt + 152, 0x3000); w32(b, opt + 156, 0x100); }
  } else {
    w32(b, opt + 28, 0x00400000);      // ImageBase
    w32(b, opt + 32, 0x1000);
    w32(b, opt + 36, 0x200);
    w32(b, opt + 56, imageSize);
    w32(b, opt + 60, 0x200);
    w16(b, opt + 68, 3);
    w32(b, opt + 92, 16);
    if (imports) { w32(b, opt + 104, 0x2000); w32(b, opt + 108, 0x100); }
    if (relocations) { w32(b, opt + 136, 0x3000); w32(b, opt + 140, 0x100); }
  }

  /* .text: mov eax,42; ret (valid in both x86 and x86_64). */
  ascii(b, sect, '.text'); w32(b, sect + 8, 0x200); w32(b, sect + 12, 0x1000);
  w32(b, sect + 16, 0x200); w32(b, sect + 20, 0x200); w32(b, sect + 36, 0x60000020);
  b.set([0xb8, 42, 0, 0, 0, 0xc3], 0x200);

  if (relocations) {
    const rs = sect + (imports ? 80 : 40);
    ascii(b, rs, '.reloc'); w32(b, rs + 8, 0x100); w32(b, rs + 12, 0x3000);
    w32(b, rs + 16, 0x100); w32(b, rs + 20, 0x500); w32(b, rs + 36, 0x42000040);
    /* One HIGHLOW/DIR64 relocation for the absolute pointer at RVA 0x1100. */
    w32(b, 0x500, 0x1000); w32(b, 0x504, 12);
    w16(b, 0x508, ((pe64 ? 10 : 3) << 12) | 0x100); w16(b, 0x50a, 0);
    if (pe64) w64(b, 0x300, 0x140001234n); else w32(b, 0x300, 0x00401234);
  }

  if (imports) {
    const s = sect + 40;
    ascii(b, s, '.idata'); w32(b, s + 8, 0x100); w32(b, s + 12, 0x2000);
    w32(b, s + 16, 0x100); w32(b, s + 20, 0x400); w32(b, s + 36, 0x40000040);
    /* IMAGE_IMPORT_DESCRIPTOR at RVA 0x2000 (raw 0x400). */
    w32(b, 0x400, 0x2040);             // OriginalFirstThunk
    w32(b, 0x40c, 0x2060);             // Name
    w32(b, 0x410, 0x2048);             // FirstThunk
    w32(b, 0x440, 0x2080); w32(b, 0x448, 0);
    w32(b, 0x448, 0x2080); w32(b, 0x450, 0);
    ascii(b, 0x460, 'user32.dll');
    w16(b, 0x480, 0); ascii(b, 0x482, 'CreateWindowExA');
  }
  return b;
}

export function pe32Console() { return basePE({ pe64: false, imports: false }); }
export function pe64Console() { return basePE({ pe64: true, imports: false }); }
export function pe32WithUser32Import() { return basePE({ pe64: false, imports: true }); }
export function pe32WithRelocation() { return basePE({ pe64: false, relocations: true }); }
export function pe64WithRelocation() { return basePE({ pe64: true, relocations: true }); }

export function cloneBytes(bytes) { return new Uint8Array(bytes); }
