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
    this.isStaticallyLinked = !this.imports.some(function (i) {
      return /^(msvcr|msvcp|ucrtbase|vcruntime|api-ms-win-crt|libgcc|libstdc\+\+|mingw|cygwin|libwinpthread)/i.test(i.dll);
    });
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
    /* A small deterministic TEB/TLS area is enough for compiler CRT startup
       and keeps GS-prefixed accesses inside the private guest boundary. */
    this.tls = new Uint8Array(0x1000);
    this.tlsBase = this.stackBase + (this.x64 ? BigInt(this.stack.length + 0x1000) : this.stack.length + 0x1000);
    this.tebBase = this.tlsBase + (this.x64 ? 0x100n : 0x100);
    this.tlsOffset = this.x64 ? 0x30 : 0x18;
    this.sp = this.stackBase + (this.x64 ? BigInt(this.stack.length - this.word * 4) : this.stack.length - this.word * 4);
    this.writePtr(this.sp, this.x64 ? 0n : 0); this.r[this.x64 ? 4 : 4] = this.sp; /* RSP/ESP */
    this.writePtr(this.tlsBase + (this.x64 ? BigInt(this.tlsOffset) : this.tlsOffset), this.tebBase);
    this.hostSlots = image.hostSlots;
    this.args = options.args || [];
  }
  CPU.prototype.num = function (v) { return this.x64 ? (typeof v === 'bigint' ? v : BigInt(v)) : Number(v) >>> 0; };
  CPU.prototype.addr = function (v) { return typeof v === 'bigint' ? v : BigInt(v >>> 0); };
  CPU.prototype.reg = function (i) { return this.r[i] || (this.x64 ? 0n : 0); };
  CPU.prototype.setReg = function (i, v) {
    var q = this.x64 ? (BigInt(v) & 0xffffffffffffffffn) : (Number(v) >>> 0);
    this.r[i] = q;
    /* Keep the stack-pointer register and the interpreter's bounded stack
       cursor in lockstep.  Compiler prologues adjust RSP with SUB/ADD, while
       CALL/RET use `sp` directly for safe memory access. */
    if (i === 4) this.sp = q;
  };
  CPU.prototype.off = function (a, n) {
    var x = this.addr(a), ib = this.addr(this.image.loadBase), ie = ib + BigInt(this.image.image.length);
    if (x >= ib && x + BigInt(n) <= ie) return { b: this.image.image, p: Number(x - ib) };
    var sb = this.addr(this.stackBase), se = sb + BigInt(this.stack.length);
    if (x >= sb && x + BigInt(n) <= se) return { b: this.stack, p: Number(x - sb) };
    var tb = this.addr(this.tlsBase), te = tb + BigInt(this.tls.length);
    if (x >= tb && x + BigInt(n) <= te) return { b: this.tls, p: Number(x - tb) };
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
  CPU.prototype.allocGuest = function (n, alignBytes) {
    n = Math.max(1, Number(n) || 1); alignBytes = alignBytes || 8;
    if (this._hostAlloc == null) this._hostAlloc = this.x64 ? this.stackBase : this.stackBase;
    var p = this.x64 ? (BigInt(this._hostAlloc) + BigInt(alignBytes - 1)) & ~BigInt(alignBytes - 1) : (this._hostAlloc + alignBytes - 1) & ~(alignBytes - 1);
    var end = this.x64 ? p + BigInt(n) : p + n;
    var limit = this.x64 ? this.sp - 1024n : this.sp - 1024;
    if (end >= limit) fail('STACK_OVERFLOW', 'guest host allocation exhausted');
    this._hostAlloc = end; return p;
  };
  CPU.prototype.callGuest = function (target, args) {
    var savedR = this.r.slice(), savedRip = this.rip, savedSp = this.sp;
    var savedFlags = { zf: this.flags.zf, sf: this.flags.sf, cf: this.flags.cf, of: this.flags.of };
    var word = this.x64 ? 8 : 4, base = this.x64 ? BigInt(this.sp) - 0x200n : this.sp - 0x200;
    try {
      this.sp = base;
      this.writePtr(this.sp, this.x64 ? 0n : 0);
      this.setReg(4, this.sp);
      if (this.x64) {
        this.setReg(1, args[0] || 0); this.setReg(2, args[1] || 0);
        this.setReg(8, args[2] || 0); this.setReg(9, args[3] || 0);
      } else {
        for (var i = args.length - 1; i >= 0; i--) this.writePtr(this.sp + word * (i + 1), args[i] || 0);
      }
      this.rip = target;
      var limit = Math.min(this.maxSteps - this.steps, 100000), result = null;
      for (var n = 0; n < limit; n++) { result = this.step(); if (result) break; }
      return this.reg(0);
    } finally {
      this.r = savedR; this.rip = savedRip; this.sp = savedSp;
      this.flags = savedFlags;
    }
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
  CPU.prototype.setArith = function (a, b, out, sub, width) {
    var bytes = width || this.word, bits = bytes * 8, mask = this.x64 ? (1n << BigInt(bits)) - 1n : (Math.pow(2, bits) - 1), aa = this.x64 ? BigInt(a) & mask : Number(a) >>> 0, bb = this.x64 ? BigInt(b) & mask : Number(b) >>> 0, oo = this.x64 ? BigInt(out) & mask : (Number(out) >>> 0) & mask;
    this.flags.zf = oo === 0 || oo === 0n; this.flags.sf = this.x64 ? !!(oo & (1n << BigInt(bits - 1))) : !!(oo & Math.pow(2, bits - 1)); this.flags.cf = sub ? aa < bb : oo < aa; this.flags.of = false; return oo & mask;
  };
  CPU.prototype.modrm = function (rex) {
    var b = this.fetch8(), mod = b >>> 6, reg = ((b >>> 3) & 7) + (rex && rex.r ? 8 : 0), rm0 = (b & 7), rm = rm0 + (rex && rex.b ? 8 : 0), disp = 0, addr = null, base;
    if (mod === 3) return { reg: reg, rm: rm, direct: true };
    if (rm0 === 4) { var sib = this.fetch8(), ss = sib >>> 6, ix0 = (sib >>> 3) & 7, ix = ix0 + (rex && rex.x ? 8 : 0), bi0 = sib & 7, bi = bi0 + (rex && rex.b ? 8 : 0); if (!(mod === 0 && bi0 === 5)) base = this.reg(bi); else base = this.x64 ? 0n : 0; if (ix0 !== 4) base = base + this.reg(ix) * (this.x64 ? (1n << BigInt(ss)) : Math.pow(2, ss)); if (mod === 1) disp = this.fetchS(1); else if (mod === 2) disp = this.fetchS(4); else if (bi0 === 5) disp = this.fetchS(4); addr = base + (this.x64 ? BigInt(disp) : disp); }
    else if (mod === 0 && rm0 === 5) {
      disp = this.fetchS(4);
      if (this.x64) addr = this.rip + BigInt(disp);
      else {
        var av = disp >>> 0, lb = this.image.loadBase >>> 0;
        addr = (av >= lb && av < ((lb + this.image.image.length) >>> 0)) ? av : ((lb + av) >>> 0);
      }
    }
    else { addr = this.reg(rm); if (mod === 1) addr += this.x64 ? BigInt(this.fetchS(1)) : this.fetchS(1); else if (mod === 2) addr += this.x64 ? BigInt(this.fetchS(4)) : this.fetchS(4); }
    if (this.segment === 'gs' || this.segment === 'fs') addr = this.x64 ? this.tlsBase + this.addr(addr) : this.tlsBase + Number(addr);
    return { reg: reg, rm: rm, direct: false, addr: addr };
  };
  CPU.prototype.value = function (m, n) {
    if (!m.direct) return this.read(m.addr, n);
    var v = this.reg(m.rm);
    if (this.x64) return n === 1 ? v & 255n : n === 2 ? v & 65535n : n === 4 ? v & 0xffffffffn : v;
    return n === 1 ? v & 255 : n === 2 ? v & 65535 : v;
  };
  CPU.prototype.store = function (m, v, n) {
    if (!m.direct) { this.write(m.addr, v, n); return; }
    if (n >= this.word) { this.setReg(m.rm, v); return; }
    var old = this.reg(m.rm), mask = this.x64 ? (n === 1 ? 255n : n === 2 ? 65535n : 0xffffffffn) : (n === 1 ? 255 : 65535);
    var q = this.x64 ? ((BigInt(old) & ~mask) | (BigInt(v) & mask)) : ((old & ~mask) | (Number(v) & mask));
    /* A 32-bit write to an x64 register clears its upper half. */
    if (this.x64 && n === 4) q = BigInt(v) & 0xffffffffn;
    this.setReg(m.rm, q);
  };
  CPU.prototype.jcc = function (cc) { switch (cc) { case 4: return this.flags.zf; case 5: return !this.flags.zf; case 2: return this.flags.cf; case 3: return !this.flags.cf; case 12: return this.flags.sf !== this.flags.of; case 13: return this.flags.sf === this.flags.of; case 14: return this.flags.zf || this.flags.sf !== this.flags.of; case 15: return !this.flags.zf && this.flags.sf === this.flags.of; default: return false; } };
  CPU.prototype.hostCall = function (address) {
    var h = this.hostSlots[String(address)], ret;
    if (!h) return false;
    var args = [], n = h.argCount || this.options.argCount || 8, i;
    var complete = true;
    if (this.x64) {
      /* Microsoft x64 passes the first four integer arguments in RCX, RDX,
         R8, and R9.  The caller also reserves the 32-byte home area, so the
         fifth argument is at [RSP+28h] after the CALL has pushed its return
         address.  Reading these slots is required for CreateWindowEx,
         CreateFile, BitBlt, and other imports with more than four arguments.
         Keep the private CPU argument out of the guest ABI. */
      args.push(this.r[1], this.r[2], this.r[8], this.r[9]);
      for (i = 4; i < n; i++) {
        try { args.push(this.read(this.sp + BigInt(this.word * (i + 1)), this.word)); }
        catch (e) { args.push(0n); complete = false; }
      }
    }
    else {
      for (i = 0; i < n; i++) {
        try { args.push(this.read(this.sp + this.word * (i + 1), this.word)); }
        catch (e) { args.push(0); complete = false; }
      }
    }
    /* The CPU is passed as a final, private argument.  Win32 adapters use it
       to read guest strings and write buffers; ordinary callbacks can simply
       ignore the extra value. */
    ret = h.fn.apply(null, args.concat([this]));
    this.setReg(0, ret == null ? 0 : ret);
    if (this.terminated) return { status: 'exited', exitCode: this.terminatedCode == null ? Number(this.reg(0)) : this.terminatedCode };
    this.rip = this.pop();
    if (!this.x64 && h.stackBytes && complete) { this.sp += h.stackBytes; this.setReg(4, this.sp); }
    return true;
  };
  CPU.prototype.step = function () {
    var rex = null, op, m, a, b, out, imm, target, n, operand16 = false, lock = false;
    this.segment = null;
    while (this.rip != null) {
      op = Number(this.read(this.rip, 1));
      if (op >= 0x40 && op <= 0x4f && this.x64) { this.rip++; rex = { w: !!(op & 8), r: !!(op & 4), x: !!(op & 2), b: !!(op & 1) }; continue; }
      if (op === 0x66) { this.rip++; operand16 = true; continue; }
      if (op === 0xf0) { this.rip++; lock = true; continue; }
      if (op === 0x64) { this.rip++; this.segment = 'fs'; continue; }
      if (op === 0x65) { this.rip++; this.segment = 'gs'; continue; }
      /* The CRT emits CS/DS/ES prefixes around multi-byte NOPs.  They have no
         observable effect in this flat guest address space. */
      if (op === 0x2e || op === 0x3e || op === 0x26 || op === 0x36) { this.rip++; continue; }
      break;
    }
    op = this.fetch8();
    if (op === 0x90) return null;
    if (op === 0xc9) { this.setReg(4, this.reg(5)); this.setReg(5, this.pop()); return null; }
    if (op === 0xc3 || op === 0xc2) { target = this.pop(); if (op === 0xc2) this.sp += this.x64 ? BigInt(this.fetchS(2)) : this.fetchS(2); if (target === 0 || target === 0n) return { status: 'exited', exitCode: Number(this.reg(0) & (this.x64 ? 0xffffffffn : 0xffffffff)) }; this.rip = target; return null; }
    if (op === 0xf4) return { status: 'halted', exitCode: Number(this.reg(0)) };
    if (op === 0xcc || op === 0xcd) return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 1n : 1) };
    if (op === 0xdb) {
      /* fninit (DB E3) only resets the x87 control state, which is not
         modelled by this integer-focused interpreter. */
      if (this.fetch8() === 0xe3) return null;
      return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 2n : 2) };
    }
    if (op >= 0xa0 && op <= 0xa3) {
      /* MOV accumulator, moffs (used by 32-bit CRT startup for FS:[0x18]).
         Unlike ModR/M addressing, the absolute offset is encoded inline. */
      n = (op === 0xa0 || op === 0xa2) ? 1 : (this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4));
      var moffs = this.x64 ? this.fetchS(8) : this.fetchS(4);
      if (this.segment === 'gs' || this.segment === 'fs') moffs = this.x64 ? this.tlsBase + this.addr(moffs) : this.tlsBase + Number(moffs);
      if (op === 0xa0 || op === 0xa1) this.setReg(0, this.read(moffs, n));
      else this.write(moffs, this.reg(0), n);
      return null;
    }
    if (op === 0x98) {
      /* With REX.W this is CDQE: sign-extend EAX into RAX.  The x64 CRT
         uses it when sizing its pseudo-relocation work table. */
      if (this.x64) this.setReg(0, BigInt.asIntN(32, BigInt(this.reg(0))));
      else this.setReg(0, this.reg(0));
      return null;
    }
    /* Accumulator-immediate arithmetic is used by __chkstk_ms and CRT
       relocation helpers (for example `cmp rax, 0x1000`). */
    if (op === 0x05 || op === 0x0d || op === 0x25 || op === 0x2d || op === 0x35 || op === 0x3d) {
      n = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4);
      imm = this.fetchS(n === 8 ? 4 : n); a = this.reg(0);
      if (op === 0x05) out = this.setArith(a, imm, this.x64 ? BigInt(a) + BigInt(imm) : a + imm, false, n);
      else if (op === 0x0d) out = this.x64 ? (BigInt(a) | BigInt(imm)) : (a | imm);
      else if (op === 0x25) out = this.x64 ? (BigInt(a) & BigInt(imm)) : (a & imm);
      else if (op === 0x2d) out = this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true, n);
      else if (op === 0x35) out = this.x64 ? (BigInt(a) ^ BigInt(imm)) : (a ^ imm);
      else { this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true, n); return null; }
      this.setReg(0, out); this.flags.zf = out === 0 || out === 0n;
      return null;
    }
    /* In 32-bit mode 40h..4Fh are INC/DEC register opcodes.  In 64-bit
       mode the same byte range is consumed above as REX prefixes. */
    if (!this.x64 && op >= 0x40 && op <= 0x4f) {
      var ir = op & 7, old = this.reg(ir), carry = this.flags.cf;
      out = op < 0x48 ? (old + 1) >>> 0 : (old - 1) >>> 0;
      this.setReg(ir, out); this.flags.zf = out === 0; this.flags.sf = !!(out & 0x80000000);
      this.flags.of = op < 0x48 ? old === 0x7fffffff : old === 0x80000000; this.flags.cf = carry;
      return null;
    }
    if (op >= 0x50 && op <= 0x57) { this.push(this.reg((op & 7) + (rex && rex.b ? 8 : 0))); return null; }
    if (op >= 0x58 && op <= 0x5f) { this.setReg((op & 7) + (rex && rex.b ? 8 : 0), this.pop()); return null; }
    if (op >= 0xb8 && op <= 0xbf) {
      var ri = (op & 7) + (rex && rex.b ? 8 : 0), sz = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4), mv = this.fetchS(sz);
      if (this.x64 && sz === 4) mv = BigInt(mv) & 0xffffffffn;
      this.setReg(ri, mv); return null;
    }
    if (op === 0x68) { this.push(this.fetchS(4)); return null; }
    if (op === 0x6a) { this.push(this.fetchS(1)); return null; }
    if (op === 0xe8 || op === 0xe9) { imm = this.fetchS(4); target = this.rip + (this.x64 ? BigInt(imm) : imm); if (op === 0xe8) { this.push(this.rip); var hr = this.hostCall(target); if (hr) return hr === true ? null : hr; } this.rip = target; return null; }
    if (op === 0xeb) { imm = this.fetchS(1); this.rip += this.x64 ? BigInt(imm) : imm; return null; }
    if (op >= 0x70 && op <= 0x7f) { imm = this.fetchS(1); if (this.jcc(op & 15)) this.rip += this.x64 ? BigInt(imm) : imm; return null; }
    if (op === 0x0f) {
      op = this.fetch8();
      if (op >= 0x80 && op <= 0x8f) { imm = this.fetchS(4); if (this.jcc(op & 15)) this.rip += this.x64 ? BigInt(imm) : imm; return null; }
      /* CMOVcc is common in clang's branchless return paths. */
      if (op >= 0x40 && op <= 0x4f) { m = this.modrm(rex); if (this.jcc(op & 15)) this.setReg(m.reg, this.value(m, this.x64 && rex && rex.w ? 8 : 4)); return null; }
      /* Multi-byte NOPs are emitted by MinGW for alignment. */
      if (op === 0x1f) { this.modrm(rex); return null; }
      /* SETcc writes a byte based on the current flags. */
      if (op >= 0x90 && op <= 0x9f) {
        m = this.modrm(rex); this.store(m, this.jcc(op & 15) ? 1 : 0, 1); return null;
      }
      /* MOVZX word/byte is used by the PE header and CRT probes. */
      if (op === 0xb6 || op === 0xb7) {
        m = this.modrm(rex); a = this.value(m, op === 0xb6 ? 1 : 2); this.setReg(m.reg, a); return null;
      }
      /* CMPXCHG and XCHG are the single-threaded forms used by the MinGW
         startup lock.  The lock prefix is consumed above; no host thread can
         race this interpreter. */
      if (op === 0xb1) {
        m = this.modrm(rex); n = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4); a = this.value(m, n);
        var cmpAcc = this.x64 && n < 8 ? this.reg(0) & (n === 1 ? 255n : n === 2 ? 65535n : 0xffffffffn) : this.reg(0);
        if (cmpAcc === a) { this.store(m, this.reg(m.reg), n); this.flags.zf = true; }
        else { this.setReg(0, a); this.flags.zf = false; }
        return null;
      }
      return { status: 'unsupported_instruction', opcode: 0x0f00 | op, rip: this.rip - (this.x64 ? 2n : 2) };
    }
    if (op === 0x63 && this.x64) { m = this.modrm(rex); a = this.value(m, 4); this.setReg(m.reg, BigInt.asIntN(32, BigInt(a))); return null; }
    if (op === 0x87) { m = this.modrm(rex); n = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4); a = this.value(m, n); this.store(m, this.reg(m.reg), n); this.setReg(m.reg, a); return null; }
    if (op === 0xc1 || op === 0xd1 || op === 0xd3) {
      m = this.modrm(rex); n = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4); a = this.value(m, n);
      var shift = op === 0xc1 ? this.fetch8() : (op === 0xd1 ? 1 : (this.x64 ? Number(this.reg(1) & 63n) : (this.reg(1) & 31)));
      shift &= n * 8 - 1;
      if ((m.reg & 7) === 4) out = this.x64 ? (BigInt(a) << BigInt(shift)) : (a << shift);
      else if ((m.reg & 7) === 5) out = this.x64 ? (BigInt(a) >> BigInt(shift)) : (a >>> shift);
      else if ((m.reg & 7) === 7) out = this.x64 ? (BigInt.asIntN(n * 8, BigInt(a)) >> BigInt(shift)) : (a >> shift);
      else return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 1n : 1) };
      this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; return null;
    }
    /* MOV r/m, immediate (C7/C6) and byte moves appear in compiler-generated
       structure initialization and freestanding memcpy routines. */
    if (op === 0xc7 || op === 0xc6) {
      m = this.modrm(rex); n = op === 0xc6 ? 1 : (this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4));
      if ((m.reg & 7) !== 0) return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 2n : 2) };
      imm = this.fetchS(op === 0xc6 ? 1 : (operand16 ? 2 : 4)); this.store(m, imm, n); return null;
    }
    if (op === 0x88 || op === 0x8a || op === 0x89 || op === 0x8b || op === 0x8d || op === 0x31 || op === 0x33 || op === 0x01 || op === 0x03 || op === 0x29 || op === 0x2b || op === 0x39 || op === 0x3b || op === 0x85) {
      m = this.modrm(rex); n = (op === 0x88 || op === 0x8a) ? 1 : (this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4)); a = (op === 0x8d || op === 0x88 || op === 0x89) ? 0 : this.value(m, n); b = this.reg(m.reg);
      if (op === 0x88 || op === 0x89) this.store(m, b, n);
      else if (op === 0x8a || op === 0x8b || op === 0x8d) {
        if (op === 0x8d) this.store({ direct: true, rm: m.reg }, m.addr, n);
        else if (n === 1) { var prior = this.reg(m.reg), mask8 = this.x64 ? ~255n : 0xffffff00; this.setReg(m.reg, (prior & mask8) | (this.x64 ? BigInt(a) : Number(a))); }
        else this.setReg(m.reg, a);
      } else if (op === 0x31 || op === 0x33) { out = a ^ b; this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; }
      else if (op === 0x01 || op === 0x03) { out = this.setArith(a, b, this.x64 ? BigInt(a) + BigInt(b) : (a + b), false, n); this.store(m, out, n); }
      else if (op === 0x29 || op === 0x2b) { out = this.setArith(a, b, this.x64 ? BigInt(a) - BigInt(b) : (a - b), true, n); this.store(m, out, n); }
      else if (op === 0x39 || op === 0x3b) this.setArith(a, b, this.x64 ? BigInt(a) - BigInt(b) : (a - b), true, n);
      else { out = a & b; this.flags.zf = out === 0 || out === 0n; this.flags.sf = this.x64 ? !!(out & (1n << BigInt(n * 8 - 1))) : !!(out & (n === 1 ? 0x80 : 0x80000000)); }
      return null;
    }
    if (op === 0x83 || op === 0x81) {
      m = this.modrm(rex); n = this.x64 && rex && rex.w ? 8 : (operand16 ? 2 : 4);
      imm = this.fetchS(op === 0x83 ? 1 : (operand16 ? 2 : 4)); a = this.value(m, n);
      switch (m.reg & 7) {
        case 0: out = this.setArith(a, imm, this.x64 ? BigInt(a) + BigInt(imm) : a + imm, false, n); this.store(m, out, n); break;
        case 2: {
          var carryAdd = this.flags.cf ? 1 : 0;
          out = this.setArith(a, this.x64 ? BigInt(imm) + BigInt(carryAdd) : imm + carryAdd, this.x64 ? BigInt(a) + BigInt(imm) + BigInt(carryAdd) : a + imm + carryAdd, false, n);
          this.store(m, out, n); break;
        }
        case 3: {
          var carrySub = this.flags.cf ? 1 : 0;
          out = this.setArith(a, this.x64 ? BigInt(imm) + BigInt(carrySub) : imm + carrySub, this.x64 ? BigInt(a) - BigInt(imm) - BigInt(carrySub) : a - imm - carrySub, true, n);
          this.store(m, out, n); break;
        }
        case 1: out = this.x64 ? (BigInt(a) | BigInt(imm)) : (a | imm); this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; this.flags.sf = this.x64 ? !!(out & (1n << BigInt(n * 8 - 1))) : !!(out & (n === 1 ? 0x80 : 0x80000000)); break;
        case 4: out = this.x64 ? (BigInt(a) & BigInt(imm)) : (a & imm); this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; this.flags.sf = this.x64 ? !!(out & (1n << BigInt(n * 8 - 1))) : !!(out & (n === 1 ? 0x80 : 0x80000000)); break;
        case 5: out = this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true, n); this.store(m, out, n); break;
        case 6: out = this.x64 ? (BigInt(a) ^ BigInt(imm)) : (a ^ imm); this.store(m, out, n); this.flags.zf = out === 0 || out === 0n; this.flags.sf = this.x64 ? !!(out & (1n << BigInt(n * 8 - 1))) : !!(out & (n === 1 ? 0x80 : 0x80000000)); break;
        case 7: this.setArith(a, imm, this.x64 ? BigInt(a) - BigInt(imm) : a - imm, true, n); break;
        default: return { status: 'unsupported_instruction', opcode: op, rip: this.rip - (this.x64 ? 2n : 2) };
      }
      return null;
    }
    if (op === 0xff) {
      m = this.modrm(rex);
      switch (m.reg & 7) {
        case 2:
          target = this.value(m, this.word); this.push(this.rip);
          var hr2 = this.hostCall(target); if (hr2) return hr2 === true ? null : hr2;
          this.rip = target; return null;
        case 4:
          /* PE import thunks are `jmp [__imp_function]`.  The caller has
             already pushed its return address, so dispatch through the host
             slot just like an indirect CALL and let hostCall pop that return
             address after the shim returns. */
          target = this.value(m, this.word); var hj = this.hostCall(target);
          if (hj) return hj === true ? null : hj;
          this.rip = target; return null;
        case 6: this.push(this.value(m, this.word)); return null;
        default: break;
      }
    }
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
    var runtime = options.runtime || null, bridge = global.W98Win32 || (global.W98 && global.W98.Win32);
    if (!runtime && !options.resolveImport && bridge && typeof bridge.createRuntime === 'function') runtime = bridge.createRuntime(options);
    var resolver = options.resolveImport || (runtime && typeof runtime.resolveImport === 'function' ? function (dll, name, ordinal, imp) {
      return runtime.resolveImport(dll, name, ordinal, imp);
    } : runtime && typeof runtime.resolve === 'function' ? function (dll, name, ordinal, imp) {
      return runtime.resolve(dll, name, ordinal, imp);
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
    result.runtime = runtime || defaultRuntime || null;
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
