/*
 * pe-loader.js - bounded PE32/PE32+ loader and tiny x86 execution adapter.
 *
 * This is deliberately self contained.  It does not fetch DLLs or execute
 * host machine code: PE sections are copied into a private image, relocations
 * are applied, and imports are resolved through an explicit callback.  The
 * optional interpreter covers the small instruction set emitted by the
 * freestanding console samples used by the desktop and is safe to stop at a
 * bounded instruction count when an application needs an unsupported opcode.
 */
(function (global) {
  'use strict';

  var MACHINE_I386 = 0x14c;
  var MACHINE_AMD64 = 0x8664;
  var MAGIC_PE32 = 0x10b;
  var MAGIC_PE32PLUS = 0x20b;
  var DIR_IMPORT = 1;
  var DIR_BASERELOC = 5;
  var DIR_EXPORT = 0;
  var SUBSYSTEM_GUI = 2;
  var SUBSYSTEM_CONSOLE = 3;
  var MAX_IMAGE = 512 * 1024 * 1024;
  var MAX_SECTIONS = 96;
  var MAX_IMPORTS = 65536;
  var textDecoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;

  function fail(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    throw e;
  }
  function asBytes(input) {
    if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input))
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    fail('INVALID_INPUT', 'PE input must be an ArrayBuffer or Uint8Array');
  }
  function u16(b, p) { return b[p] | (b[p + 1] << 8); }
  function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  function u64(b, p) {
    if (typeof BigInt === 'function') return BigInt(u32(b, p)) | (BigInt(u32(b, p + 4)) << 32n);
    return u32(b, p) + u32(b, p + 4) * 0x100000000;
  }
  function put16(b, p, v) { b[p] = v & 255; b[p + 1] = (v >>> 8) & 255; }
  function put32(b, p, v) { v = Number(v) >>> 0; b[p] = v & 255; b[p + 1] = (v >>> 8) & 255; b[p + 2] = (v >>> 16) & 255; b[p + 3] = (v >>> 24) & 255; }
  function put64(b, p, v) {
    if (typeof BigInt === 'function') {
      var n = typeof v === 'bigint' ? v : BigInt(v), i;
      for (i = 0; i < 8; i++) { b[p + i] = Number(n & 255n); n >>= 8n; }
    } else { put32(b, p, v); put32(b, p + 4, Math.floor(Number(v) / 0x100000000)); }
  }
  function align(v, a) { return Math.ceil(v / a) * a; }
  function fixedString(b, p, max) {
    if (!rangeOk(p, max, b.length)) fail('BAD_SECTION_NAME', 'section name lies outside the PE file');
    var end = p; while (end < p + max && b[end]) end++;
    if (textDecoder) return textDecoder.decode(b.subarray(p, end));
    var s = '', i; for (i = p; i < end; i++) s += String.fromCharCode(b[i]); return s;
  }
  function boundedString(b, p, max) {
    if (p < 0 || p >= b.length) fail('BAD_STRING_RVA', 'string lies outside the PE image');
    var end = p, lim = Math.min(b.length, p + (max || 4096));
    while (end < lim && b[end]) end++;
    if (end === lim && (end >= b.length || b[end])) fail('BAD_STRING', 'unterminated PE string');
    if (textDecoder) return textDecoder.decode(b.subarray(p, end));
    var s = '', i; for (i = p; i < end; i++) s += String.fromCharCode(b[i]); return s;
  }
  function rangeOk(p, n, len) { return p >= 0 && n >= 0 && p <= len && n <= len - p; }

  function PEImage(raw, o) {
    o = o || {};
    this.raw = raw;
    this.machine = o.machine;
    this.arch = this.machine === MACHINE_I386 ? 'x86' : 'x86_64';
    this.magic = o.magic;
    this.isPE32Plus = this.magic === MAGIC_PE32PLUS;
    this.imageBase = o.imageBase;
    this.preferredBase = o.imageBase;
    this.loadBase = o.loadBase == null ? o.imageBase : (this.isPE32Plus && typeof BigInt === 'function' ? BigInt(o.loadBase) : Number(o.loadBase));
    this.entryRva = o.entryRva;
    this.entrypoint = this.loadBase + (typeof this.loadBase === 'bigint' ? BigInt(this.entryRva) : this.entryRva);
    this.sectionAlignment = o.sectionAlignment;
    this.fileAlignment = o.fileAlignment;
    this.sizeOfHeaders = o.sizeOfHeaders;
    this.sizeOfImage = o.sizeOfImage;
    this.subsystem = o.subsystem;
    this.subsystemName = this.subsystem === SUBSYSTEM_GUI ? 'gui' : (this.subsystem === SUBSYSTEM_CONSOLE ? 'console' : 'unknown');
    this.isConsole = this.subsystemName === 'console';
    this.isGui = this.subsystemName === 'gui';
    this.machineName = this.arch;
    this.format = this.isPE32Plus ? 'PE32+' : 'PE32';
    this.characteristics = o.characteristics;
    this.dllCharacteristics = o.dllCharacteristics;
    this.sections = o.sections;
    this.directories = o.directories;
    this.imports = [];
    this.exports = [];
    this.relocations = [];
    this.importSlots = Object.create(null);
    this.hostSlots = Object.create(null);
    this._relocationsApplied = false;
    this.image = new Uint8Array(this.sizeOfImage);
    this.image.set(raw.subarray(0, Math.min(this.sizeOfHeaders, raw.length)), 0);
    this.sections.forEach(function (s) {
      if (!s.rawSize) return;
      var n = Math.min(s.rawSize, this.image.length - s.virtualAddress);
      if (n > 0) this.image.set(raw.subarray(s.rawPointer, s.rawPointer + n), s.virtualAddress);
    }, this);
    this._parseImports();
    this.hasImports = this.imports.length > 0;
    this._parseExports();
    this._parseRelocations();
    this.isStaticallyLinked = !this.imports.some(function (i) { return /^(msvcr|msvcp|ucrtbase|vcruntime|libgcc|libstdc\+\+)/i.test(i.dll); });
    this.entrypointOffset = this.rvaToOffset(this.entryRva, 1);
    if (o.resolveImport) this.resolveImports(o.resolveImport, o);
    if (o.loadBase != null && this.loadBase !== this.preferredBase) this.applyRelocations(this.loadBase);
  }
  PEImage.prototype.rvaToOffset = function (rva, size) {
    size = size == null ? 1 : size;
    if (!Number.isInteger(rva) || rva < 0 || !rangeOk(rva, size, this.image.length)) return -1;
    return rva;
  };
  PEImage.prototype.readRva = function (rva, size) {
    var off = this.rvaToOffset(rva, size);
    if (off < 0) return null;
    return this.image.slice(off, off + size);
  };
  PEImage.prototype.entryBytes = function (n) {
    var p = this.rvaToOffset(this.entryRva, n || 1);
    return p < 0 ? null : this.image.slice(p, p + (n || 1));
  };
  PEImage.prototype._parseImports = function () {
    var d = this.directories[DIR_IMPORT], image = this.image, count = 0;
    if (!d || !d.rva || !d.size) return;
    if (!rangeOk(d.rva, Math.min(d.size, image.length - d.rva), image.length)) fail('BAD_IMPORT_DIRECTORY', 'import directory is outside the image');
    for (var p = d.rva; p + 20 <= image.length && count < MAX_IMPORTS; p += 20) {
      var oft = u32(image, p), nameRva = u32(image, p + 12), ft = u32(image, p + 16);
      if (!oft && !nameRva && !ft) break;
      if (!nameRva || !ft) fail('BAD_IMPORT_DESCRIPTOR', 'import descriptor has no DLL name or IAT');
      var dll = boundedString(image, nameRva, 260), thunk = oft || ft, step = this.isPE32Plus ? 8 : 4;
      var rec = { dll: dll, name: dll, functions: [], firstThunk: ft, originalFirstThunk: oft };
      for (var q = thunk, idx = 0; q + step <= image.length && idx < MAX_IMPORTS; q += step, idx++) {
        var val = this.isPE32Plus ? u64(image, q) : u32(image, q);
        if (val === 0 || val === 0n) break;
        var ordinalMask = this.isPE32Plus ? 0x8000000000000000n : 0x80000000;
        var byOrdinal = this.isPE32Plus ? ((val & ordinalMask) !== 0n) : ((val & ordinalMask) !== 0);
        var fn = byOrdinal ? { ordinal: Number(this.isPE32Plus ? (val & 0xffffn) : (val & 0xffff)) } : { hint: u16(image, Number(val)), name: boundedString(image, Number(val) + 2, 512) };
        fn.iatRva = ft + idx * step; fn.dll = dll;
        rec.functions.push(fn); this.imports.push(fn);
      }
      count++;
      /* A malformed table that never terminates must fail rather than loop. */
      if (p + 20 > d.rva + d.size + 20) break;
    }
    if (count >= MAX_IMPORTS) fail('IMPORT_LIMIT', 'PE import table exceeds safety limit');
  };
  PEImage.prototype._parseExports = function () {
    var d = this.directories[DIR_EXPORT], image = this.image;
    if (!d || !d.rva || d.size < 40 || !rangeOk(d.rva, 40, image.length)) return;
    var base = u32(image, d.rva + 16), nNames = u32(image, d.rva + 24), namesRva = u32(image, d.rva + 32), ordRva = u32(image, d.rva + 36), funcsRva = u32(image, d.rva + 28);
    if (nNames > MAX_IMPORTS || !rangeOk(namesRva, nNames * 4, image.length) || !rangeOk(ordRva, nNames * 2, image.length) || !rangeOk(funcsRva, u32(image, d.rva + 20) * 4, image.length)) return;
    for (var i = 0; i < nNames; i++) {
      var ord = u16(image, ordRva + i * 2), nameRva = u32(image, namesRva + i * 4);
      if (ord >= u32(image, d.rva + 20)) continue;
      this.exports.push({ name: boundedString(image, nameRva, 512), ordinal: base + ord, rva: u32(image, funcsRva + ord * 4) });
    }
  };
  PEImage.prototype._parseRelocations = function () {
    var d = this.directories[DIR_BASERELOC], image = this.image;
    if (!d || !d.rva || !d.size) return;
    var end = Math.min(image.length, d.rva + d.size);
    for (var p = d.rva; p + 8 <= end;) {
      var page = u32(image, p), size = u32(image, p + 4);
      if (!size) break;
      if (size < 8 || p + size > end) fail('BAD_RELOC_BLOCK', 'base relocation block is truncated');
      for (var q = p + 8; q + 2 <= p + size; q += 2) {
        var ent = u16(image, q), type = ent >>> 12, off = ent & 0xfff;
        if (type === 3 || type === 10) this.relocations.push({ type: type, rva: page + off });
        else if (type !== 0) this.relocations.push({ type: type, rva: page + off, unsupported: true });
      }
      p += size;
    }
  };
  PEImage.prototype.applyRelocations = function (base) {
    var target = this.isPE32Plus && typeof BigInt === 'function' ? BigInt(base) : Number(base);
    if (this._relocationsApplied && target === this.loadBase) return this;
    var old = this._relocationsApplied ? this.loadBase : this.preferredBase;
    var delta = typeof target === 'bigint' ? target - BigInt(old) : target - Number(old);
    if (delta === 0 || delta === 0n) { this.loadBase = target; this.entrypoint = target + (typeof target === 'bigint' ? BigInt(this.entryRva) : this.entryRva); this._relocationsApplied = true; return this; }
    if (!this.relocations.length) fail('NO_RELOCATIONS', 'image has no relocation table for the requested load base');
    for (var i = 0; i < this.relocations.length; i++) {
      var r = this.relocations[i], p = r.rva;
      if (r.unsupported) continue;
      if (r.type === 3) { if (!rangeOk(p, 4, this.image.length)) fail('BAD_RELOC_TARGET', 'HIGHLOW relocation points outside image'); put32(this.image, p, (u32(this.image, p) + Number(delta)) >>> 0); }
      else if (r.type === 10) { if (!rangeOk(p, 8, this.image.length)) fail('BAD_RELOC_TARGET', 'DIR64 relocation points outside image'); put64(this.image, p, u64(this.image, p) + delta); }
    }
    this.loadBase = target; this.entrypoint = target + (typeof target === 'bigint' ? BigInt(this.entryRva) : this.entryRva); this._relocationsApplied = true; return this;
  };
  PEImage.prototype.resolveImports = function (resolver, options) {
    options = options || {};
    var step = this.isPE32Plus ? 8 : 4, next = this.loadBase + (typeof this.loadBase === 'bigint' ? BigInt(align(this.image.length, 0x1000) + 0x1000) : align(this.image.length, 0x1000) + 0x1000), self = this;
    this.imports.forEach(function (imp) {
      var v;
      try { v = resolver(imp.dll, imp.name || null, imp.ordinal, imp); } catch (e) { if (!options.allowUnresolved) throw e; v = null; }
      var host = typeof v === 'function' ? v : (v && typeof v.fn === 'function' ? v.fn : null), stackBytes = v && v.stackBytes ? v.stackBytes : 0;
      var argCount = v && v.argCount ? v.argCount : 0;
      if (host) { var key = String(next); self.hostSlots[key] = { fn: host, stackBytes: stackBytes, argCount: argCount, import: imp }; v = next; next += typeof next === 'bigint' ? 16n : 16; }
      if (v == null) { if (!options.allowUnresolved) fail('UNRESOLVED_IMPORT', 'cannot resolve ' + imp.dll + '!' + (imp.name || '#' + imp.ordinal)); v = 0; }
      if (self.isPE32Plus) put64(self.image, imp.iatRva, v); else put32(self.image, imp.iatRva, v);
      self.importSlots[imp.dll.toLowerCase() + '!' + (imp.name || '#' + imp.ordinal)] = v;
      imp.address = v; imp.host = host;
    });
    return this;
  };

  /* Small, deterministic interpreter. It intentionally exposes a stopped
     result instead of throwing on an unknown instruction. This keeps a GUI
     process alive while the host can decide how to report missing CPU support. */
  PEImage.prototype.run = function (options) {
    options = options || {};
    return new CPU(this, options).run();
  };

  function CPU(image, options) {
    this.image = image; this.x64 = image.arch === 'x86_64'; this.word = this.x64 ? 8 : 4;
    this.r = new Array(this.x64 ? 16 : 8); for (var i = 0; i < this.r.length; i++) this.r[i] = this.x64 ? 0n : 0;
    this.rip = image.entrypoint; this.flags = { zf: false, sf: false, cf: false, of: false };
    this.maxSteps = Math.max(1, options.maxSteps == null ? 1000000 : options.maxSteps | 0); this.steps = 0; this.options = options;
    this.stack = new Uint8Array(Math.max(4096, options.stackSize || 65536));
    this.stackBase = image.loadBase + (this.x64 ? BigInt(align(image.image.length, 0x1000) + 0x10000) : align(image.image.length, 0x1000) + 0x10000);
    this.sp = this.stackBase + (this.x64 ? BigInt(this.stack.length - this.word * 4) : this.stack.length - this.word * 4);
    this.writePtr(this.sp, this.x64 ? 0n : 0); this.r[this.x64 ? 4 : 4] = this.sp; /* RSP/ESP */
    this.hostSlots = image.hostSlots;
    this.args = options.args || [];
  }
  CPU.prototype.num = function (v) { return this.x64 ? (typeof v === 'bigint' ? v : BigInt(v)) : Number(v) >>> 0; };
  CPU.prototype.addr = function (v) { return typeof v === 'bigint' ? v : BigInt(v >>> 0); };
  CPU.prototype.reg = function (i) { return this.r[i] || (this.x64 ? 0n : 0); };
  CPU.prototype.setReg = function (i, v) { this.r[i] = this.x64 ? (BigInt(v) & 0xffffffffffffffffn) : (Number(v) >>> 0); };
  CPU.prototype.off = function (a, n) {
    var x = this.addr(a), ib = this.addr(this.image.loadBase), ie = ib + BigInt(this.image.image.length);
    if (x >= ib && x + BigInt(n) <= ie) return { b: this.image.image, p: Number(x - ib) };
    var sb = this.addr(this.stackBase), se = sb + BigInt(this.stack.length);
    if (x >= sb && x + BigInt(n) <= se) return { b: this.stack, p: Number(x - sb) };
    return null;
  };
  CPU.prototype.read = function (a, n) { var x = this.off(a, n); if (!x) fail('MEMORY_FAULT', 'guest read outside image/stack'); var v = this.x64 ? 0n : 0, i; if (this.x64) { for (i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(x.b[x.p + i]); return v; } for (i = n - 1; i >= 0; i--) v = (v * 256 + x.b[x.p + i]) >>> 0; return v; };
  CPU.prototype.write = function (a, v, n) { var x = this.off(a, n); if (!x) fail('MEMORY_FAULT', 'guest write outside image/stack'); var q = this.x64 ? BigInt(v) : Number(v) >>> 0, i; for (i = 0; i < n; i++) { x.b[x.p + i] = this.x64 ? Number(q & 255n) : q & 255; q = this.x64 ? q >> 8n : q >>> 8; } };
  CPU.prototype.readPtr = function (a) { return this.read(a, this.word); };
  CPU.prototype.writePtr = function (a, v) { this.write(a, v, this.word); };
  CPU.prototype.readGuestBytes = function (a, n) {
    var x = this.off(a, n); if (!x) fail('MEMORY_FAULT', 'guest read outside image/stack');
    return x.b.slice(x.p, x.p + n);
  };
  CPU.prototype.writeGuestBytes = function (a, bytes) {
    var x = this.off(a, bytes.length); if (!x) fail('MEMORY_FAULT', 'guest write outside image/stack');
    x.b.set(bytes, x.p);
  };
  CPU.prototype.readGuestString = function (a, wide, max) {
    max = max || 32768; var out = '', i, c;
    if (!a || (typeof a === 'bigint' && a === 0n)) return '';
    for (i = 0; i < max; i++) {
      var at = this.x64 ? BigInt(a) + BigInt(wide ? i * 2 : i) : Number(a) + (wide ? i * 2 : i);
      c = Number(this.read(at, wide ? 2 : 1));
      if (wide) { if (!c) break; out += String.fromCharCode(c & 0xffff); }
      else { if (!c) break; out += String.fromCharCode(c & 255); }
    }
    return out;
  };
  CPU.prototype.fetch8 = function () { var v = this.read(this.rip, 1); this.rip = this.rip + (this.x64 ? 1n : 1); return Number(v); };
  CPU.prototype.fetchS = function (n) { var v = this.read(this.rip, n), bits = n * 8; this.rip = this.rip + (this.x64 ? BigInt(n) : n); if (this.x64) { var sign = 1n << BigInt(bits - 1); return (v & sign) ? v - (1n << BigInt(bits)) : v; } var lim = Math.pow(2, bits - 1); return v >= lim ? v - Math.pow(2, bits) : v; };
  CPU.prototype.push = function (v) { this.sp = this.sp - (this.x64 ? BigInt(this.word) : this.word); this.writePtr(this.sp, v); this.setReg(4, this.sp); };
  CPU.prototype.pop = function () { var v = this.readPtr(this.sp); this.sp = this.sp + (this.x64 ? BigInt(this.word) : this.word); this.setReg(4, this.sp); return v; };
  CPU.prototype.setArith = function (a, b, out, sub) { var bits = this.word * 8, mask = this.x64 ? 0xffffffffffffffffn : 0xffffffff, aa = this.x64 ? BigInt(a) : Number(a) >>> 0, bb = this.x64 ? BigInt(b) : Number(b) >>> 0, oo = this.x64 ? BigInt(out) : Number(out) >>> 0; this.flags.zf = oo === 0 || oo === 0n; this.flags.sf = this.x64 ? !!(oo & (1n << BigInt(bits - 1))) : !!(oo & 0x80000000); this.flags.cf = sub ? aa < bb : oo < aa; this.flags.of = false; return oo & mask; };
  CPU.prototype.modrm = function (rex) {
    var b = this.fetch8(), mod = b >>> 6, reg = ((b >>> 3) & 7) + (rex && rex.r ? 8 : 0), rm0 = (b & 7), rm = rm0 + (rex && rex.b ? 8 : 0), disp = 0, addr = null, base;
    if (mod === 3) return { reg: reg, rm: rm, direct: true };
    if (rm0 === 4) { var sib = this.fetch8(), ss = sib >>> 6, ix = ((sib >>> 3) & 7) + (rex && rex.x ? 8 : 0), bi0 = sib & 7, bi = bi0 + (rex && rex.b ? 8 : 0); if (!(mod === 0 && bi0 === 5)) base = this.reg(bi); else base = this.x64 ? 0n : 0; if (ix !== (rex && rex.x ? 8 : 4)) base = base + this.reg(ix) * (this.x64 ? (1n << BigInt(ss)) : Math.pow(2, ss)); if (mod === 1) disp = this.fetchS(1); else if (mod === 2) disp = this.fetchS(4); else if (bi0 === 5) disp = this.fetchS(4); addr = base + (this.x64 ? BigInt(disp) : disp); }
    else if (mod === 0 && rm0 === 5) { disp = this.fetchS(4); addr = this.x64 ? this.rip + BigInt(disp) : this.image.loadBase + (disp >>> 0); }
    else { addr = this.reg(rm); if (mod === 1) addr += this.x64 ? BigInt(this.fetchS(1)) : this.fetchS(1); else if (mod === 2) addr += this.x64 ? BigInt(this.fetchS(4)) : this.fetchS(4); }
    return { reg: reg, rm: rm, direct: false, addr: addr };
  };
  CPU.prototype.value = function (m, n) { return m.direct ? this.reg(m.rm) : this.read(m.addr, n); };
  CPU.prototype.store = function (m, v, n) { if (m.direct) this.setReg(m.rm, v); else this.write(m.addr, v, n); };
  CPU.prototype.jcc = function (cc) { switch (cc) { case 4: return this.flags.zf; case 5: return !this.flags.zf; case 2: return this.flags.cf; case 3: return !this.flags.cf; case 12: return this.flags.sf !== this.flags.of; case 13: return this.flags.sf === this.flags.of; case 14: return this.flags.zf || this.flags.sf !== this.flags.of; case 15: return !this.flags.zf && this.flags.sf === this.flags.of; default: return false; } };
  CPU.prototype.hostCall = function (address) {
    var h = this.hostSlots[String(address)], ret;
    if (!h) return false;
    var args = [], n = h.argCount || this.options.argCount || 8, i;
    if (this.x64) { args.push(this.r[1], this.r[2], this.r[8], this.r[9]); } else { for (i = 0; i < n; i++) args.push(this.read(this.sp + (this.x64 ? BigInt(this.word) : this.word), this.word)); }
    /* The CPU is passed as a final, private argument.  Win32 adapters use it
       to read guest strings and write buffers; ordinary callbacks can simply
       ignore the extra value. */
    ret = h.fn.apply(null, args.concat([this]));
    this.setReg(0, ret == null ? 0 : ret);
    this.rip = this.pop();
    if (!this.x64 && h.stackBytes) { this.sp += h.stackBytes; this.setReg(4, this.sp); }
    return true;
  };
  CPU.prototype.step = function () {
    var rex = null, op, m, a, b, out, imm, target;
    while (this.x64 && this.rip != null) { op = Number(this.read(this.rip, 1)); if (op >= 0x40 && op <= 0x4f) { this.rip++; rex = { w: !!(op & 8), r: !!(op & 4), x: !!(op & 2), b: !!(op & 1) }; } else break; }
    op = this.fetch8();
    if (op === 0x90) return null;
    if (op === 0xc3 || op === 0xc2) { target = this.pop(); if (op === 0xc2) this.sp += this.x64 ? BigInt(this.fetchS(2)) : this.fetchS(2); if (target === 0 || target === 0n) return { status: 'exited', exitCode: Number(this.reg(0) & (this.x64 ? 0xffffffffn : 0xffffffff)) }; this.rip = target; return null; }
    if (op === 0xf4) return { status: 'halted', exitCode: Number(this.reg(0)) };
    if (op === 0xcc || op === 0xcd) return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 1n : 1) };
    if (op >= 0x50 && op <= 0x57) { this.push(this.reg((op & 7) + (rex && rex.b ? 8 : 0))); return null; }
    if (op >= 0x58 && op <= 0x5f) { this.setReg((op & 7) + (rex && rex.b ? 8 : 0), this.pop()); return null; }
    if (op >= 0xb8 && op <= 0xbf) { var ri = (op & 7) + (rex && rex.b ? 8 : 0), sz = this.x64 && rex && rex.w ? 8 : 4; this.setReg(ri, this.fetchS(sz)); return null; }
    if (op === 0x68) { this.push(this.fetchS(4)); return null; }
    if (op === 0x6a) { this.push(this.fetchS(1)); return null; }
    if (op === 0xe8 || op === 0xe9) { imm = this.fetchS(4); target = this.rip + (this.x64 ? BigInt(imm) : imm); if (op === 0xe8) { this.push(this.rip); if (this.hostCall(target)) return null; } this.rip = target; return null; }
    if (op === 0xeb) { this.rip += this.x64 ? BigInt(this.fetchS(1)) : this.fetchS(1); return null; }
    if (op >= 0x70 && op <= 0x7f) { imm = this.fetchS(1); if (this.jcc(op & 15)) this.rip += this.x64 ? BigInt(imm) : imm; return null; }
    if (op === 0x0f) { op = this.fetch8(); if (op >= 0x80 && op <= 0x8f) { imm = this.fetchS(4); if (this.jcc(op & 15)) this.rip += this.x64 ? BigInt(imm) : imm; return null; } return { status: 'unsupported_instruction', opcode: 0x0f00 | op, rip: this.rip - (this.x64 ? 2n : 2) }; }
    if (op === 0x89 || op === 0x8b || op === 0x8d || op === 0x31 || op === 0x33 || op === 0x01 || op === 0x03 || op === 0x29 || op === 0x2b || op === 0x39 || op === 0x3b || op === 0x85) {
      m = this.modrm(rex); var n = this.x64 && rex && rex.w ? 8 : 4; a = this.value(m, n); b = this.reg(m.reg); if (op === 0x89) this.store(m, b, n); else if (op === 0x8b || op === 0x8d) this.setReg(m.reg, op === 0x8d ? m.addr : a); else if (op === 0x31 || op === 0x33) { out = a ^ b; this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; } else if (op === 0x01 || op === 0x03) { out = this.setArith(a, b, this.x64 ? BigInt(a) + BigInt(b) : (a + b), false); this.store(m, out, n); } else if (op === 0x29 || op === 0x2b) { out = this.setArith(a, b, this.x64 ? BigInt(a) - BigInt(b) : (a - b), true); this.store(m, out, n); } else if (op === 0x39 || op === 0x3b) this.setArith(a, b, this.x64 ? BigInt(a) - BigInt(b) : (a - b), true); else { out = a & b; this.flags.zf = out === 0 || out === 0n; } return null;
    }
    if (op === 0x83 || op === 0x81) { m = this.modrm(rex); n = this.x64 && rex && rex.w ? 8 : 4; imm = this.fetchS(op === 0x83 ? 1 : 4); a = this.value(m, n); switch (m.reg & 7) { case 0: out = this.setArith(a, imm, this.x64 ? BigInt(a) + BigInt(imm) : a + imm, false); this.store(m, out, n); break; case 5: out = this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true); this.store(m, out, n); break; case 7: this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true); break; default: return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 2n : 2) }; } return null; }
    if (op === 0xff) { m = this.modrm(rex); switch (m.reg & 7) { case 2: target = this.value(m, this.word); this.push(this.rip); if (this.hostCall(target)) return null; this.rip = target; return null; case 4: this.rip = this.value(m, this.word); return null; case 6: this.push(this.value(m, this.word)); return null; default: break; } }
    return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 1n : 1) };
  };
  CPU.prototype.run = function () {
    try { for (; this.steps < this.maxSteps; this.steps++) { var r = this.step(); if (r) { r.steps = this.steps + 1; return r; } } return { status: 'step_limit', steps: this.steps, rip: this.rip }; }
    catch (e) { return { status: e.code || 'runtime_error', message: e.message, steps: this.steps, rip: this.rip }; }
  };

  function parse(input, options) {
    options = options || {}; var raw = asBytes(input), len = raw.length;
    if (len < 0x40 || raw[0] !== 0x4d || raw[1] !== 0x5a) fail('BAD_DOS_HEADER', 'missing MZ DOS signature');
    var pe = u32(raw, 0x3c); if (!rangeOk(pe, 24, len) || raw[pe] !== 0x50 || raw[pe + 1] !== 0x45 || raw[pe + 2] || raw[pe + 3]) fail('BAD_PE_SIGNATURE', 'missing PE signature');
    var fh = pe + 4, machine = u16(raw, fh), nsec = u16(raw, fh + 2), optSize = u16(raw, fh + 16), chars = u16(raw, fh + 18);
    if (machine !== MACHINE_I386 && machine !== MACHINE_AMD64) fail('UNSUPPORTED_MACHINE', 'only x86 and x86_64 PE images are supported', { machine: machine });
    if (!nsec || nsec > MAX_SECTIONS || !rangeOk(fh + 20, optSize + nsec * 40, len)) fail('BAD_HEADERS', 'invalid PE section/header bounds');
    var oh = fh + 20, magic = u16(raw, oh), plus = magic === MAGIC_PE32PLUS;
    /* AMD64 images with a legacy PE32 optional header are not loadable by
       this runtime; report them as an unsupported image before allocating.
       Other supported-machine/header combinations retain the precise mismatch
       diagnostic used by callers. */
    if (machine === MACHINE_AMD64 && magic === MAGIC_PE32) fail('UNSUPPORTED_MACHINE', 'AMD64 PE32 images are unsupported');
    if ((machine === MACHINE_I386 && magic !== MAGIC_PE32) || (machine === MACHINE_AMD64 && magic !== MAGIC_PE32PLUS)) fail('MACHINE_MAGIC_MISMATCH', 'PE machine and optional-header magic do not match');
    var imageBase = plus ? u64(raw, oh + 24) : u32(raw, oh + 28), secAlign = u32(raw, oh + 32), fileAlign = u32(raw, oh + 36), sizeImage = u32(raw, oh + 56), sizeHeaders = u32(raw, oh + 60), entry = u32(raw, oh + 16), subsystem = u16(raw, oh + 68), dllChars = u16(raw, oh + 70), ndir = u32(raw, oh + (plus ? 108 : 92)), dd = oh + (plus ? 112 : 96);
    if (!secAlign || !fileAlign || sizeImage < sizeHeaders || sizeImage > MAX_IMAGE || !sizeHeaders || sizeHeaders > len || !rangeOk(dd, Math.min(ndir, 16) * 8, len)) fail('BAD_OPTIONAL_HEADER', 'invalid PE image dimensions');
    var dirs = [], i; for (i = 0; i < 16; i++) dirs.push(i < ndir ? { rva: u32(raw, dd + i * 8), size: u32(raw, dd + i * 8 + 4) } : { rva: 0, size: 0 });
    var sections = [], sh = oh + optSize, maxEnd = sizeHeaders;
    for (i = 0; i < nsec; i++) { var p = sh + i * 40, name = fixedString(raw, p, 8), va = u32(raw, p + 12), vs = u32(raw, p + 8), rs = u32(raw, p + 16), rp = u32(raw, p + 20), c = u32(raw, p + 36); if (rs && (!rangeOk(rp, rs, len) || rp < sizeHeaders && rp + rs > sizeHeaders)) fail('BAD_SECTION', 'section raw data is outside file'); if (va + Math.max(vs, rs) > maxEnd) maxEnd = va + Math.max(vs, rs); sections.push({ name: name.replace(/\0.*$/, ''), virtualAddress: va, virtualSize: vs, rawSize: rs, rawPointer: rp, characteristics: c }); }
    if (align(maxEnd, secAlign) > sizeImage) fail('BAD_SECTION', 'section extends beyond SizeOfImage');
    var image = new PEImage(raw, { machine: machine, magic: magic, imageBase: imageBase, loadBase: options.loadBase == null ? imageBase : options.loadBase, entryRva: entry, sectionAlignment: secAlign, fileAlignment: fileAlign, sizeOfHeaders: sizeHeaders, sizeOfImage: sizeImage, subsystem: subsystem, characteristics: chars, dllCharacteristics: dllChars, sections: sections, directories: dirs, resolveImport: options.resolveImport, allowUnresolved: options.allowUnresolved });
    return image;
  }

  var defaultRuntime = null;
  function defaultResolver(dll, name, ordinal, imp) {
    var bridge = global.W98Win32 || (global.W98 && global.W98.Win32), fn;
    if (!bridge) fail('WIN32_UNAVAILABLE', 'Win32 API bridge is not loaded');
    if (typeof bridge.resolveImport === 'function') return bridge.resolveImport(dll, name, ordinal, imp);
    /* W98Win32.resolve is intentionally a pure helper with the runtime as its
       first argument. Keep one runtime per PE load boundary so handles and
       window classes remain stable across all imports in an image. */
    if (typeof bridge.resolve === 'function') {
      if (!defaultRuntime && typeof bridge.createRuntime === 'function') defaultRuntime = bridge.createRuntime();
      fn = defaultRuntime ? bridge.resolve(defaultRuntime, dll, name, ordinal, imp) : bridge.resolve(dll, name, ordinal, imp);
      if (fn) return fn;
    }
    fail('WIN32_UNAVAILABLE', 'Win32 API bridge does not expose an import resolver');
  }
  function run(input, options) {
    options = options || {};
    var resolver = options.resolveImport || (options.runtime && typeof options.runtime.resolveImport === 'function' ? function (dll, name, ordinal, imp) {
      return options.runtime.resolveImport(dll, name, ordinal, imp);
    } : options.runtime && typeof options.runtime.resolve === 'function' ? function (dll, name, ordinal, imp) {
      return options.runtime.resolve(dll, name, ordinal, imp);
    } : defaultResolver);
    var image = input instanceof PEImage ? input : parse(input, {
      loadBase: options.loadBase,
      resolveImport: resolver,
      allowUnresolved: !!options.allowUnresolved
    });
    if (input instanceof PEImage && image.imports.length && !Object.keys(image.hostSlots).length) image.resolveImports(resolver, options);
    var result = image.run(options);
    result.arch = image.arch; result.subsystem = image.subsystemName;
    result.console = image.isConsole; result.gui = image.isGui;
    result.staticallyLinked = image.isStaticallyLinked; result.image = image;
    return result;
  }
  function runConsole(input, options) {
    options = options || {};
    var image = input instanceof PEImage ? input : parse(input, { allowUnresolved: true, loadBase: options.loadBase });
    if (!image.isConsole) fail('SUBSYSTEM_NOT_CONSOLE', 'PE image is not a console executable');
    return run(image, options);
  }
  function runGui(input, options) {
    options = options || {};
    var image = input instanceof PEImage ? input : parse(input, { allowUnresolved: true, loadBase: options.loadBase });
    if (!image.isGui) fail('SUBSYSTEM_NOT_GUI', 'PE image is not a GUI executable');
    return run(image, options);
  }
  function readPath(path, fs) {
    fs = fs || (global.W98 && global.W98.fs);
    if (!fs || typeof fs.readBytes !== 'function') fail('FS_UNAVAILABLE', 'W98 filesystem is not available');
    var bytes = fs.readBytes(path);
    if (!bytes) fail('FILE_NOT_FOUND', 'cannot read ' + path);
    return bytes;
  }
  function runPath(path, options) {
    options = options || {}; return run(readPath(path, options.fs), options);
  }
  function openPath(path, options) {
    options = options || {};
    try {
      var result = runPath(path, options);
      var bridge = global.W98Win32 || (global.W98 && global.W98.Win32);
      if (bridge && typeof bridge.presentResult === 'function') bridge.presentResult(path, result, options);
      return true;
    } catch (e) {
      var bridge2 = global.W98Win32 || (global.W98 && global.W98.Win32);
      if (bridge2 && typeof bridge2.reportError === 'function') bridge2.reportError(path, e);
      else if (global.W98 && global.W98.dialog && global.W98.dialog.alert) global.W98.dialog.alert('Windows', 'Cannot run ' + String(path) + '.\\n' + (e.message || e), 'error');
      return false;
    }
  }
  var API = {
    parse: parse, load: parse, run: run, runConsole: runConsole, runGui: runGui,
    runPath: runPath, openPath: openPath,
    constants: { MACHINE_I386: MACHINE_I386, MACHINE_AMD64: MACHINE_AMD64,
      SUBSYSTEM_GUI: SUBSYSTEM_GUI, SUBSYSTEM_CONSOLE: SUBSYSTEM_CONSOLE }, PEImage: PEImage
  };
  if (global.W98) global.W98.PE = API;
  global.W98PE = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
