/* ===========================================================================
 * calculator.js — Calculator (Windows 98 accessory, Scientific view)
 *
 * Classic script (NOT a module).  Registers itself with W98.registerApp().
 * Immediate-execution arithmetic exactly like the real Windows calculator:
 * there is no operator precedence, "=" repeats, all ops are 32-bit aware in
 * the non-decimal number systems.
 * =========================================================================*/
(function () {
  'use strict';

  var ID = 'calculator';
  var REG_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Calculator';

  var CSS = [
    '.calc-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
    '  min-width:0;min-height:0;background:#c0c0c0;padding:3px;overflow:hidden;',
    '  font:11px Tahoma,"MS Sans Serif",sans-serif;color:#000000}',
    '.calc-root,.calc-root *{box-sizing:border-box}',
    '.calc-disp{display:flex;align-items:stretch;height:40px;flex:none;background:#ffffff;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000,inset -1px -1px 0 #dfdfdf;margin:0 0 4px}',
    '.calc-mbox{width:20px;flex:none;display:flex;align-items:center;justify-content:center;',
    '  font:bold 12px Tahoma,sans-serif;color:#808080;padding-top:2px}',
    '.calc-mbox.on{color:#800000}',
    '.calc-valwrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;',
    '  justify-content:flex-end;padding:1px 4px 2px 0}',
    '.calc-val{font:bold 15px/17px "Lucida Console","Courier New",monospace;color:#800000;',
    '  text-align:right;overflow:hidden;white-space:nowrap;letter-spacing:0}',
    '.calc-val.err{font-size:11px;line-height:17px;letter-spacing:0}',
    '.calc-tags{display:flex;justify-content:space-between;font:9px Tahoma,sans-serif;',
    '  color:#000000;line-height:10px;height:10px}',
    '.calc-grid{flex:1 1 auto;display:grid;grid-template-columns:repeat(6,1fr);gap:2px;',
    '  min-height:0;margin:0 0 3px}',
    '.calc-btn{position:relative;background:#c0c0c0;color:#000000;border:0;border-radius:0;',
    '  padding:0;margin:0;min-width:0;min-height:24px;overflow:hidden;cursor:default;',
    '  font:11px Tahoma,"MS Sans Serif",sans-serif;line-height:1;',
    '  box-shadow:inset 1px 1px 0 #ffffff,inset -1px -1px 0 #000000,',
    '  inset 2px 2px 0 #dfdfdf,inset -2px -2px 0 #808080}',
    '.calc-btn:active,.calc-btn.on{box-shadow:inset 1px 1px 0 #000000,inset -1px -1px 0 #ffffff,',
    '  inset 2px 2px 0 #808080,inset -2px -2px 0 #dfdfdf;padding:1px 0 0 1px}',
    '.calc-btn:focus{outline:1px dotted #000000;outline-offset:-5px}',
    '.calc-btn[disabled]{color:#808080;text-shadow:1px 1px 0 #ffffff;cursor:default}',
    '.calc-btn.default{box-shadow:inset 1px 1px 0 #ffffff,inset -1px -1px 0 #000000,',
    '  inset 2px 2px 0 #dfdfdf,inset -2px -2px 0 #808080,0 0 0 1px #000000}',
    '.calc-btn.mem{color:#000080}',
    '.calc-btn.op{color:#800000}',
    '.calc-btn.hex{color:#800080}',
    '.calc-base{flex:none;display:flex;align-items:center;gap:7px;height:19px;',
    '  padding:0 1px;font:11px Tahoma,sans-serif}',
    '.calc-base label{display:flex;align-items:center;gap:2px;cursor:default}',
    '.calc-base input{margin:0;width:12px;height:12px}',
    '.calc-sub{font:bold 9px Tahoma,sans-serif;color:#000000;margin-right:1px}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style');
    st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------ layouts */
  function bt(label, key, opt) {
    var o = { label: label, key: key };
    if (opt) { o.span = opt.span; o.cls = opt.cls; o.default_ = opt.default_; }
    return o;
  }

  function sciRows() {
    return [
      [bt('Inv', 'inv', { cls: 'mem' }), bt('Hyp', 'hyp', { cls: 'mem' }),
       bt('Backspace', 'back', { span: 2 }), bt('CE', 'ce'), bt('C', 'c'), bt('sqrt', 'sqrt')],
      [bt('ln', 'ln'), bt('log', 'log'), bt('(', 'lp'), bt(')', 'rp'),
       bt('n!', 'fact'), bt('x\u00B2', 'sqr'), bt('x^y', 'pow')],
      [bt('exp', 'exp'), bt('sin', 'sin'), bt('cos', 'cos'), bt('tan', 'tan'),
       bt('dms', 'dms'), bt('sinh', 'sinh'), bt('cosh', 'cosh')],
      [bt('tanh', 'tanh'), bt('\u03C0', 'pi'), bt('int', 'int'), bt('EE', 'ee'),
       bt('F-E', 'fe'), bt('%', 'pct'), bt('1/x', 'recip')],
      [bt('MC', 'mc', { cls: 'mem' }), bt('7', '7'), bt('8', '8'), bt('9', '9'),
       bt('/', '/', { cls: 'op' }), bt('A', 'hexA', { cls: 'hex' }), bt('B', 'hexB', { cls: 'hex' })],
      [bt('MR', 'mr', { cls: 'mem' }), bt('4', '4'), bt('5', '5'), bt('6', '6'),
       bt('*', '*', { cls: 'op' }), bt('C', 'hexC', { cls: 'hex' }), bt('D', 'hexD', { cls: 'hex' })],
      [bt('MS', 'ms', { cls: 'mem' }), bt('1', '1'), bt('2', '2'), bt('3', '3'),
       bt('-', '-', { cls: 'op' }), bt('E', 'hexE', { cls: 'hex' }), bt('F', 'hexF', { cls: 'hex' })],
      [bt('M+', 'm+', { cls: 'mem' }), bt('0', '0'), bt('.', 'dot'),
       bt('+', '+', { cls: 'op' }), bt('=', '=', { default_: true }), bt('+/-', 'neg'), null]
    ];
  }

  function stdRows() {
    return [
      [bt('Backspace', 'back', { span: 2 }), bt('CE', 'ce', { span: 2 }),
       bt('C', 'c', { span: 2 })],
      [bt('MC', 'mc', { cls: 'mem' }), bt('7', '7'), bt('8', '8'), bt('9', '9'),
       bt('/', '/', { cls: 'op' }), bt('sqrt', 'sqrt')],
      [bt('MR', 'mr', { cls: 'mem' }), bt('4', '4'), bt('5', '5'), bt('6', '6'),
       bt('*', '*', { cls: 'op' }), bt('%', 'pct')],
      [bt('MS', 'ms', { cls: 'mem' }), bt('1', '1'), bt('2', '2'), bt('3', '3'),
       bt('-', '-', { cls: 'op' }), bt('1/x', 'recip')],
      [bt('M+', 'm+', { cls: 'mem' }), bt('0', '0'), bt('+/-', 'neg'), bt('.', 'dot'),
       bt('+', '+', { cls: 'op' }), bt('=', '=', { default_: true })]
    ];
  }
  /* scientific view is a 7-column grid (the 1998 layout), standard 6 */
  function colsFor(view) { return view === 'standard' ? 6 : 7; }

  var FUNC_KEYS = {
    sqrt: 1, sqr: 1, ln: 1, log: 1, lp: 1, rp: 1, fact: 1, exp: 1, pow: 1,
    sin: 1, cos: 1, tan: 1, sinh: 1, cosh: 1, tanh: 1, dms: 1, pi: 1, int: 1,
    ee: 1, pct: 1, reciproc: 1, recip: 1, neg: 1, dot: 1, fe: 1
  };

  /* ================================================================ app ==*/
  W98.registerApp({
    id: ID,
    title: 'Calculator',
    icon: 'calculator',
    width: 260,
    height: 340,
    minWidth: 260,
    minHeight: 340,
    resizable: false,
    maximizable: false,
    singleton: true,
    startMenuGroup: 'Accessories',
    desktop: false,
    create: create
  });

  function create(win) {
    ensureCss();

    win.el.style.display = 'flex';
    win.el.style.overflow = 'hidden';
    var root = document.createElement('div');
    root.className = 'calc-root';
    root.style.flex = '1 1 auto';
    win.el.appendChild(root);

    /* --------------------------------------------------------- display */
    var disp = document.createElement('div');
    disp.className = 'calc-disp';
    var mbox = document.createElement('div');
    mbox.className = 'calc-mbox';
    mbox.textContent = 'M';
    mbox.title = 'Memory';
    var valwrap = document.createElement('div');
    valwrap.className = 'calc-valwrap';
    var tags = document.createElement('div');
    tags.className = 'calc-tags';
    var tagL = document.createElement('span');
    tagL.textContent = '';
    var tagR = document.createElement('span');
    tagR.textContent = '';
    tags.appendChild(tagL);
    tags.appendChild(tagR);
    var val = document.createElement('div');
    val.className = 'calc-val';
    val.textContent = '0.';
    valwrap.appendChild(tags);
    valwrap.appendChild(val);
    disp.appendChild(mbox);
    disp.appendChild(valwrap);
    root.appendChild(disp);

    /* ------------------------------------------------------------ grid */
    var grid = document.createElement('div');
    grid.className = 'calc-grid';
    root.appendChild(grid);

    /* ------------------------------------------------------ base radios */
    var baseBar = document.createElement('div');
    baseBar.className = 'calc-base';
    var baseLabel = document.createElement('span');
    baseLabel.className = 'calc-sub';
    baseLabel.textContent = 'Base';
    baseBar.appendChild(baseLabel);
    var baseNames = ['Std', 'Hex', 'Dec', 'Oct', 'Bin'];
    var baseRadios = {};
    baseNames.forEach(function (nm) {
      var l = document.createElement('label');
      var r = document.createElement('input');
      r.type = 'radio';
      r.name = 'calcbase' + Math.random().toString(36).slice(2);
      r.tabIndex = 0;
      r.setAttribute('aria-label', nm + ' number system');
      l.appendChild(r);
      l.appendChild(document.createTextNode(nm));
      baseBar.appendChild(l);
      baseRadios[nm] = r;
      r.addEventListener('change', function () { setBaseName(nm); });
    });
    root.appendChild(baseBar);

    /* ----------------------------------------------------------- state */
    var S = {
      entry: null,          // string being typed, or null
      val: 0,               // current value when not typing
      acc: null,            // pending left operand
      op: null,             // pending operator
      lastOp: null,
      lastArg: null,
      mem: 0,
      memSet: false,
      baseName: 'Std',
      base: 10,
      angle: 'deg',
      inv: false,
      hyp: false,
      fe: false,
      err: '',
      justEq: false,
      copyBuf: ''
    };
    var buttons = {};       // key -> [elements]

    try {
      var v = W98.reg.get(REG_KEY, 'View', 'scientific');
      S.view = (v === 'standard') ? 'standard' : 'scientific';
      var a = W98.reg.get(REG_KEY, 'Angle', 'deg');
      if (a === 'rad' || a === 'grad' || a === 'deg') { S.angle = a; }
      var b = W98.reg.get(REG_KEY, 'Base', 'Std');
      if (baseNames.indexOf(b) >= 0) { S.baseName = b; S.base = baseOf(b); }
    } catch (e) {
      S.view = 'scientific';
    }

    function baseOf(nm) {
      return nm === 'Hex' ? 16 : nm === 'Oct' ? 8 : nm === 'Bin' ? 2 : 10;
    }

    /* ------------------------------------------------------ number model */
    function parseEntry() {
      var s = S.entry;
      if (s === null || s === '') { return 0; }
      if (S.base === 10) {
        if (s === '-' || s === '-.') { return 0; }
        var d = parseFloat(s);
        return isFinite(d) ? d : 0;
      }
      var n = parseInt(s, S.base);
      if (!isFinite(n)) { return 0; }
      n = ((n % 4294967296) + 4294967296) % 4294967296;
      if (n >= 2147483648) { n -= 4294967296; }
      return n;
    }
    function cur() {
      return S.entry !== null ? parseEntry() : S.val;
    }
    function setVal(v) {
      S.val = v;
      S.entry = null;
    }
    function fmtDec(n) {
      if (typeof n !== 'number' || !isFinite(n)) { return n > 0 ? 'Overflow' : ''; }
      if (n === 0) { return '0'; }
      var a = Math.abs(n);
      if (S.fe || a >= 1e16 || a < 1e-9) {
        var e = n.toExponential(14);
        e = e.replace(/\.?0+e/, 'e');
        return e;
      }
      var s;
      if (Number.isInteger(n) && Math.abs(n) < 1e15) {
        s = String(n);
      } else {
        /* the 1998 calculator worked in 13 significant decimal digits */
        s = String(parseFloat(n.toPrecision(13)));
      }
      return s;
    }
    function fmtBase(n, base) {
      if (base === 10) { return fmtDec(n); }
      var i = isFinite(n) ? Math.trunc(n) : 0;
      var u = ((i % 4294967296) + 4294967296) % 4294967296;
      return u.toString(base).toUpperCase();
    }
    function displayText() {
      if (S.err) { return S.err; }
      if (S.entry !== null) {
        var s = S.entry;
        if (S.base === 10) {
          if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0) { s += '.'; }
          return s;
        }
        return s.toUpperCase();
      }
      var t = fmtBase(S.val, S.base);
      /* the 1998 display always shows the decimal point in decimal mode */
      if (S.base === 10 && t.indexOf('.') < 0 && t.indexOf('e') < 0 &&
          t.indexOf('E') < 0 && !/[A-Za-z]/.test(t)) {
        t += '.';
      }
      return t;
    }

    /* ------------------------------------------------------------ errors */
    function fail(msg) {
      S.err = msg;
      S.entry = null;
      S.op = null;
      S.acc = null;
      S.lastOp = null;
      S.lastArg = null;
      try { W98.sound.error(); } catch (e) { }
      update();
    }
    function clearErr() {
      if (S.err) {
        S.err = '';
        S.entry = null;
        S.op = null;
        S.acc = null;
        S.lastOp = null;
        S.lastArg = null;
        S.val = 0;
        S.justEq = false;
      }
    }

    /* --------------------------------------------------------- arithmetic */
    /* The 1998 calculator was a 13-significant-digit decimal machine; rounding
       here keeps 0.1+0.2 exact and sin(30 deg) at 0.5 instead of float noise. */
    function round13(x) {
      if (typeof x !== 'number' || !isFinite(x) || x === 0) { return x; }
      var r = parseFloat(x.toPrecision(13));
      return isFinite(r) ? r : x;
    }
    function apply(a, op, b) {
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? null : a / b;
        case '^': return Math.pow(a, b);
        case 'root': return (a < 0 && Math.abs(b % 2) === 1)
          ? -Math.pow(-a, 1 / b) : Math.pow(a, 1 / b);
      }
      return b;
    }
    function combine() {
      if (S.op === null) { return true; }
      var r = apply(S.acc, S.op, cur());
      if (r === null || (typeof r === 'number' && !isFinite(r))) {
        fail(S.op === '/' ? 'Cannot divide by zero.' : 'Result is undefined.');
        return false;
      }
      r = round13(r);
      if (Math.abs(r) < 1e-15) { r = 0; }
      setVal(r);
      return true;
    }

    /* --------------------------------------------------------- functions */
    function toRad(x) {
      return S.angle === 'deg' ? x * Math.PI / 180
        : S.angle === 'grad' ? x * Math.PI / 200 : x;
    }
    function fromRad(x) {
      return S.angle === 'deg' ? x * 180 / Math.PI
        : S.angle === 'grad' ? x * 200 / Math.PI : x;
    }
    function gamma(z) {
      var g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012,
        9.9843695780195716e-6, 1.5056327351493116e-7];
      if (z < 0.5) {
        return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
      }
      z -= 1;
      var x = 0.99999999999980993;
      for (var i = 0; i < g.length; i++) { x += g[i] / (z + i + 1); }
      var t = z + g.length - 0.5;
      return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
    }
    function unary(name) {
      if (S.err) { return; }
      var x = cur();
      var r;
      switch (name) {
        case 'sqrt':
          if (x < 0) { fail('Invalid input for function'); return; }
          r = Math.sqrt(x); break;
        case 'sqr': r = x * x; break;
        case 'ln':
          if (x <= 0) { fail('Invalid input for function'); return; }
          r = Math.log(x); break;
        case 'log':
          if (x <= 0) { fail('Invalid input for function'); return; }
          r = Math.log(x) / Math.LN10; break;
        case 'exp': r = Math.exp(x); break;
        case 'invln': r = Math.exp(x); break;
        case 'invlog': r = Math.pow(10, x); break;
        case 'recip':
          if (x === 0) { fail('Cannot divide by zero.'); return; }
          r = 1 / x; break;
        case 'fact':
          if (x < 0 && Number.isInteger(x)) { fail('Invalid input for function'); return; }
          if (x > 170) { fail('Overflow'); return; }
          r = Number.isInteger(x) ? fact(x) : gamma(x + 1);
          break;
        case 'sin': r = S.inv ? fromRad(Math.asin(x)) : Math.sin(toRad(x)); break;
        case 'cos': r = S.inv ? fromRad(Math.acos(x)) : Math.cos(toRad(x)); break;
        case 'tan': r = S.inv ? fromRad(Math.atan(x)) : Math.tan(toRad(x)); break;
        case 'sinh':
          r = S.inv ? Math.asinh(x) : Math.sinh(x); break;
        case 'cosh':
          if (S.inv) { r = x < 1 ? NaN : Math.acosh(x); }
          else { r = Math.cosh(x); }
          break;
        case 'tanh':
          r = S.inv ? (Math.abs(x) < 1 ? Math.atanh(x) : NaN) : Math.tanh(x);
          break;
        case 'int': r = Math.trunc(x); break;
        case 'frac': r = x - Math.trunc(x); break;
        case 'pi': r = Math.PI; break;
        case 'dms': r = toDms(x); break;
        case 'deg': r = fromDms(x); break;
        default: return;
      }
      if (typeof r !== 'number' || !isFinite(r) || (r !== r)) {
        if (name === 'fact' && Math.abs(x) > 170) { fail('Overflow'); return; }
        fail('Invalid input for function'); return;
      }
      r = round13(r);
      setVal(Math.abs(r) < 1e-15 ? 0 : r);
      S.justEq = false;
      update();
    }
    function fact(n) {
      var r = 1;
      for (var i = 2; i <= n; i++) { r *= i; }
      return r;
    }
    function toDms(x) {
      var sign = x < 0 ? -1 : 1;
      var a = Math.abs(x);
      var d = Math.floor(a);
      var m = Math.floor((a - d) * 60);
      var s = ((a - d) * 60 - m) * 60;
      return sign * (d + m / 100 + s / 10000);
    }
    function fromDms(x) {
      var sign = x < 0 ? -1 : 1;
      var a = Math.abs(x);
      var d = Math.floor(a);
      var ms = (a - d) * 100;
      var m = Math.floor(ms + 1e-9);
      var s = (ms - m) * 100;
      return sign * (d + m / 60 + s / 3600);
    }

    /* ------------------------------------------------------------- entry */
    function maxLen() {
      return S.base === 16 ? 8 : S.base === 8 ? 11 : S.base === 2 ? 32 : 20;
    }
    function digit(d) {
      if (S.err) { clearErr(); }
      if (S.base === 10 && S.justEq) { S.entry = null; S.op = null; S.acc = null; }
      S.justEq = false;
      var s = S.entry === null ? '' : S.entry;
      if (S.base === 10) {
        if (s === '-' || s === '') { S.entry = (s === '-' ? '-' + d : (d === '0' ? '0' : d)); }
        else if (s.indexOf('e') >= 0) {
          var parts = s.split('e');
          if (parts[1].length < 4) { S.entry = s + d; }
        } else if (s === '0') { S.entry = d; }
        else if (s.length < maxLen()) { S.entry = s + d; }
      } else {
        if (s.length >= maxLen()) { return update(); }
        S.entry = s === '' ? d : s + d;
      }
      S.val = parseEntry();
      update();
    }
    function dot() {
      if (S.err) { clearErr(); }
      if (S.base !== 10) { return; }
      S.justEq = false;
      if (S.entry === null) { S.entry = '0.'; }
      else if (S.entry.indexOf('.') < 0 && S.entry.indexOf('e') < 0) { S.entry += '.'; }
      S.val = parseEntry();
      update();
    }
    function neg() {
      if (S.err) { clearErr(); }
      if (S.base !== 10) { return; }
      if (S.entry !== null) {
        if (S.entry.charAt(0) === '-') { S.entry = S.entry.slice(1); }
        else { S.entry = '-' + S.entry; }
      } else {
        S.val = -S.val;
      }
      S.justEq = false;
      update();
    }
    function back() {
      if (S.err) { clearErr(); }
      S.justEq = false;
      if (S.entry !== null) {
        S.entry = S.entry.slice(0, -1);
        if (S.entry === '' || S.entry === '-') { S.entry = '0'; }
        S.val = parseEntry();
      }
      update();
    }
    function ce() {
      if (S.err) { clearErr(); }
      S.entry = '0';
      S.val = 0;
      S.justEq = false;
      update();
    }
    function clearAll() {
      S.err = '';
      S.entry = null;
      S.val = 0;
      S.acc = null;
      S.op = null;
      S.lastOp = null;
      S.lastArg = null;
      S.justEq = false;
      update();
    }
    function pressOp(o) {
      if (S.err) { return; }
      if (S.op !== null && S.entry !== null) {
        if (!combine()) { return; }
      }
      /* immediate execution: whatever is on the display becomes the new
         left operand, whether we just combined or replaced an operator. */
      S.acc = cur();
      S.op = o;
      S.entry = null;
      S.justEq = false;
      update();
    }
    function equals() {
      if (S.err) { return; }
      if (S.op !== null) {
        var b = cur();
        var r = apply(S.acc, S.op, b);
        if (r === null || !isFinite(r)) {
          fail(S.op === '/' ? 'Cannot divide by zero.' : 'Result is undefined.');
          return;
        }
        S.lastOp = S.op;
        S.lastArg = b;
        S.acc = null;
        S.op = null;
        setVal(Math.abs(round13(r)) < 1e-15 ? 0 : round13(r));
      } else if (S.lastOp !== null) {
        var r2 = apply(cur(), S.lastOp, S.lastArg);
        if (r2 === null || !isFinite(r2)) {
          fail(S.lastOp === '/' ? 'Cannot divide by zero.' : 'Result is undefined.');
          return;
        }
        setVal(Math.abs(round13(r2)) < 1e-15 ? 0 : round13(r2));
      } else {
        setVal(cur());
      }
      S.entry = null;
      S.justEq = true;
      update();
    }
    function percent() {
      if (S.err) { return; }
      var v = cur();
      if (S.op === '+' || S.op === '-') {
        if (S.acc === null) { S.acc = 0; }
        setVal(S.acc * v / 100);
      } else {
        setVal(v / 100);
      }
      S.justEq = false;
      update();
    }
    function memory(what) {
      if (S.err) { return; }
      if (what === 'mc') { S.mem = 0; S.memSet = false; }
      else if (what === 'mr') {
        setVal(S.mem);
        S.entry = null;
        S.justEq = false;
      } else if (what === 'ms') { S.mem = cur(); S.memSet = true; }
      else if (what === 'm+') {
        var r = S.mem + cur();
        if (!isFinite(r)) { fail('Overflow'); return; }
        S.mem = r;
        S.memSet = true;
      }
      update();
    }

    /* -------------------------------------------------------- base / view */
    function setBaseName(nm) {
      S.baseName = nm;
      S.base = baseOf(nm);
      S.fe = false;
      S.entry = null;
      S.inv = false;
      S.hyp = false;
      if (S.base !== 10) { S.val = Math.trunc(S.val); }
      try { W98.reg.set(REG_KEY, 'Base', nm); } catch (e) { }
      render();
      update();
    }
    function setAngle(a) {
      S.angle = a;
      try { W98.reg.set(REG_KEY, 'Angle', a); } catch (e) { }
      renderMenu();
      update();
    }
    function setView(v) {
      S.view = v;
      try { W98.reg.set(REG_KEY, 'View', v); } catch (e) { }
      render();
      renderMenu();
      update();
    }

    /* ------------------------------------------------------------ pressing */
    function press(key) {
      try {
        switch (key) {
          case 'inv': S.inv = !S.inv; render(); return;
          case 'hyp': S.hyp = !S.hyp; render(); return;
          case 'back': back(); return;
          case 'ce': ce(); return;
          case 'c': clearAll(); return;
          case 'dot': dot(); return;
          case 'neg': neg(); return;
          case '=': equals(); return;
          case '+': case '-': case '*': case '/': pressOp(key); return;
          case 'pow':
            if (S.inv) { pressOp('root'); } else { pressOp('^'); }
            return;
          case 'sqrt':
            if (S.inv) { unary('sqr'); } else { unary('sqrt'); }
            return;
          case 'sqr':
            if (S.inv) { unary('sqrt'); } else { unary('sqr'); }
            return;
          case 'ln':
            if (S.inv) { unary('invln'); } else { unary('ln'); }
            return;
          case 'log':
            if (S.inv) { unary('invlog'); } else { unary('log'); }
            return;
          case 'sin':
            if (S.hyp) { unary('sinh'); } else { unary('sin'); }
            return;
          case 'cos':
            if (S.hyp) { unary('cosh'); } else { unary('cos'); }
            return;
          case 'tan':
            if (S.hyp) { unary('tanh'); } else { unary('tan'); }
            return;
          case 'dms':
            if (S.inv) { unary('deg'); } else { unary('dms'); }
            return;
          case 'pi': unary('pi'); return;
          case 'int':
            if (S.inv) { unary('frac'); } else { unary('int'); }
            return;
          case 'fact': unary('fact'); return;
          case 'exp': unary('exp'); return;
          case 'recip': unary('recip'); return;
          case 'ee':
            if (S.entry === null) { S.entry = '1'; }
            if (S.entry.indexOf('e') < 0) { S.entry += 'e'; }
            S.justEq = false;
            update();
            return;
          case 'fe': S.fe = !S.fe; update(); return;
          case 'pct': percent(); return;
          case 'mc': case 'mr': case 'ms': case 'm+': memory(key); return;
          case 'lp': case 'rp': return;      // grouping parenthesis (display only)
        }
        if (/^[0-9]$/.test(key)) { digit(key); return; }
        if (/^hex[ABCDEF]$/.test(key)) { digit(key.charAt(3)); return; }
      } catch (e) {
        try { W98.sound.error(); } catch (e2) { }
      }
    }

    /* ------------------------------------------------------------ render */
    function labelFor(b) {
      var k = b.key, hyp = S.hyp, inv = S.inv, t = b.label;
      switch (k) {
        case 'sqrt': return inv ? 'x\u00B2' : 'sqrt';
        case 'sqr': return inv ? 'sqrt' : 'x\u00B2';
        case 'ln': return inv ? 'e^x' : 'ln';
        case 'log': return inv ? '10^x' : 'log';
        case 'pow': return inv ? 'y\u221Ax' : 'x^y';
        case 'sin': return hyp ? (inv ? 'sinh\u207B\u00B9' : 'sinh') : (inv ? 'sin\u207B\u00B9' : 'sin');
        case 'cos': return hyp ? (inv ? 'cosh\u207B\u00B9' : 'cosh') : (inv ? 'cos\u207B\u00B9' : 'cos');
        case 'tan': return hyp ? (inv ? 'tanh\u207B\u00B9' : 'tanh') : (inv ? 'tan\u207B\u00B9' : 'tan');
        case 'dms': return inv ? 'deg' : 'dms';
        case 'int': return inv ? 'F-E' : 'int';
        default: return t;
      }
    }
    function render() {
      var rows = S.view === 'standard' ? stdRows() : sciRows();
      grid.innerHTML = '';
      grid.style.gridTemplateColumns = 'repeat(' + colsFor(S.view) + ',1fr)';
      grid.style.gridTemplateRows = 'repeat(' + rows.length + ',minmax(24px,1fr))';
      buttons = {};
      var frag = document.createDocumentFragment();
      rows.forEach(function (row) {
        row.forEach(function (b) {
          if (!b) { return; }
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'calc-btn' + (b.cls ? ' ' + b.cls : '') + (b.default_ ? ' default' : '');
          btn.textContent = labelFor(b);
          btn.setAttribute('data-key', b.key);
          btn.title = btn.textContent;
          if (b.span) { btn.style.gridColumn = 'span ' + b.span; }
          btn.addEventListener('click', function () { press(b.key); });
          if (!buttons[b.key]) { buttons[b.key] = []; }
          buttons[b.key].push(btn);
          frag.appendChild(btn);
        });
      });
      grid.appendChild(frag);
      baseBar.style.display = S.view === 'scientific' ? 'flex' : 'none';
      buttons.inv.forEach(function (b) { if (S.inv) { b.classList.add('on'); } });
      buttons.hyp.forEach(function (b) { if (S.hyp) { b.classList.add('on'); } });
      if (baseRadios[S.baseName]) { baseRadios[S.baseName].checked = true; }
      var k;
      for (k in baseRadios) {
        if (Object.prototype.hasOwnProperty.call(baseRadios, k)) {
          var lab = baseRadios[k].parentNode;
          if (lab && lab.style) { lab.style.fontWeight = '400'; }
        }
      }
    }
    function update() {
      var txt = displayText();
      val.textContent = txt;
      val.className = 'calc-val' + (S.err ? ' err' : '');
      mbox.className = 'calc-mbox' + (S.memSet || S.mem !== 0 ? ' on' : '');
      mbox.textContent = (S.mem !== 0) ? 'M' : 'M';
      tagL.textContent = S.base !== 10 ? S.baseName : (S.fe ? 'F-E' : '');
      tagR.textContent = S.angle === 'deg' ? '' : (S.angle === 'rad' ? 'Rad' : 'Grad');
      setEnabled();
    }
    function setEnabled() {
      var nonDec = S.base !== 10;
      var k;
      for (k in buttons) {
        if (!Object.prototype.hasOwnProperty.call(buttons, k)) { continue; }
        var arr = buttons[k], i, off = false;
        if (FUNC_KEYS[k] && nonDec) { off = true; }
        if (k === 'inv' || k === 'hyp') { off = nonDec; }
        if (k === 'dot' && nonDec) { off = true; }
        if (/^[0-9]$/.test(k)) {
          var d = parseInt(k, 10);
          if (d >= S.base) { off = true; }
        }
        if (k.indexOf('hex') === 0) { off = (S.base !== 16); }
        for (i = 0; i < arr.length; i++) {
          arr[i].disabled = off;
          arr[i].setAttribute('aria-disabled', off ? 'true' : 'false');
        }
      }
    }

    /* -------------------------------------------------------------- menu */
    function renderMenu() {
      win.setMenu([
        {
          label: '&Edit', items: [
            { label: '&Copy', accel: 'Ctrl+C', onclick: copyValue },
            { label: '&Paste', accel: 'Ctrl+V', onclick: pasteValue }
          ]
        },
        {
          label: '&View', items: [
            {
              label: '&Standard', type: 'radio', checked: S.view === 'standard',
              onclick: function () { setView('standard'); }
            },
            {
              label: '&Scientific', type: 'radio', checked: S.view === 'scientific',
              onclick: function () { setView('scientific'); }
            },
            { type: 'sep' },
            {
              label: '&Decimal', accel: 'F6', type: 'radio', checked: S.baseName === 'Dec' || S.baseName === 'Std',
              onclick: function () { setBaseName('Dec'); }
            },
            {
              label: '&Hexadecimal', accel: 'F5', type: 'radio', checked: S.baseName === 'Hex',
              onclick: function () { setBaseName('Hex'); }
            },
            {
              label: '&Octal', accel: 'F7', type: 'radio', checked: S.baseName === 'Oct',
              onclick: function () { setBaseName('Oct'); }
            },
            {
              label: '&Binary', accel: 'F8', type: 'radio', checked: S.baseName === 'Bin',
              onclick: function () { setBaseName('Bin'); }
            },
            { type: 'sep' },
            {
              label: '&Degrees', accel: 'F2', type: 'radio', checked: S.angle === 'deg',
              onclick: function () { setAngle('deg'); }
            },
            {
              label: '&Radians', accel: 'F3', type: 'radio', checked: S.angle === 'rad',
              onclick: function () { setAngle('rad'); }
            },
            {
              label: 'G&radients', accel: 'F4', type: 'radio', checked: S.angle === 'grad',
              onclick: function () { setAngle('grad'); }
            }
          ]
        },
        {
          label: '&Help', items: [
            { label: '&Help Topics', onclick: helpTopics },
            { type: 'sep' },
            { label: '&About Calculator', onclick: about }
          ]
        }
      ]);
    }
    function copyValue() {
      var t = displayText();
      S.copyBuf = t;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var p = navigator.clipboard.writeText(t);
          if (p && p['catch']) { p['catch'](function () { }); }
        }
      } catch (e) { /* ignore */ }
    }
    function pasteValue() {
      function use(t) {
        if (t == null) { return; }
        t = String(t).replace(/[^0-9A-Fa-f.]/g, '');
        if (!t) { return; }
        clearErr();
        S.entry = t;
        S.val = parseEntry();
        S.justEq = false;
        update();
      }
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(use, function () { use(S.copyBuf); });
          return;
        }
      } catch (e) { /* ignore */ }
      use(S.copyBuf);
    }
    function helpTopics() {
      W98.dialog.alert('Calculator Help',
        'Calculator Help Topics\n\n' +
        '\u2022 Use the number keys and the + - * / keys to calculate.\n' +
        '\u2022 Press Enter for =, Escape for C, Backspace to delete a digit.\n' +
        '\u2022 Press r for 1/x.\n' +
        '\u2022 F5 Hex, F6 Dec, F7 Oct, F8 Bin.\n' +
        '\u2022 F2 Degrees, F3 Radians, F4 Gradients.\n' +
        '\u2022 Inv and Hyp change the scientific functions.\n' +
        '\u2022 MS stores, MR recalls, M+ adds to memory; MC clears it.', 'info');
    }
    function about() {
      var def = {
        id: ID, title: 'About Calculator', icon: 'calculator',
        name: 'Calculator',
        text: 'Microsoft Windows 98\nVersion 4.10.1998\n\n' +
          'This product is licensed to:\n  A Windows 98 User'
      };
      try {
        if (typeof W98.aboutDialog === 'function') { W98.aboutDialog(def); return; }
      } catch (e) { /* fall through */ }
      W98.dialog.alert('About Calculator', def.text, 'info');
    }

    /* ----------------------------------------------------------- keyboard */
    var KEYMAP = {
      '+': '+', '-': '-', '*': '*', '/': '/', 'x': '*', 'X': '*',
      'Enter': '=', '=': '=',
      'Escape': 'c', 'Backspace': 'back', 'Delete': 'ce',
      'r': 'recip', 'R': 'recip',
      '%': 'pct', '.': 'dot', ',': 'dot',
      '!': 'fact'
    };
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          var lk = String(e.key).toLowerCase();
          if (lk === 'c') { e.preventDefault(); copyValue(); return; }
          if (lk === 'v') { e.preventDefault(); pasteValue(); return; }
        }
        return;
      }
      var k = e.key;
      if (!k) { return; }
      if (k === 'F5') { e.preventDefault(); setBaseName('Hex'); return; }
      if (k === 'F6') { e.preventDefault(); setBaseName('Dec'); return; }
      if (k === 'F7') { e.preventDefault(); setBaseName('Oct'); return; }
      if (k === 'F8') { e.preventDefault(); setBaseName('Bin'); return; }
      if (k === 'F9') { e.preventDefault(); neg(); return; }
      if (k === 'F2') { e.preventDefault(); setAngle('deg'); return; }
      if (k === 'F3') { e.preventDefault(); setAngle('rad'); return; }
      if (k === 'F4') { e.preventDefault(); setAngle('grad'); return; }
      if (k === 'F1') { return; }
      if (/^[0-9]$/.test(k)) {
        e.preventDefault();
        var d = parseInt(k, 10);
        if (d < S.base) { digit(k); }
        return;
      }
      if (S.base === 16 && /^[a-fA-F]$/.test(k)) {
        e.preventDefault();
        digit(k.toUpperCase());
        return;
      }
      if (/^Numpad/.test(k)) { return; }
      var key = KEYMAP[k];
      if (key) {
        e.preventDefault();
        if (key === '+' || key === '-' || key === '*' || key === '/') {
          if (S.base !== 10 && key !== '+' && key !== '-' && key !== '*' && key !== '/') { return; }
        }
        press(key);
      }
    }
    win.el.addEventListener('keydown', onKey);

    /* ---------------------------------------------------------- start up */
    render();
    renderMenu();
    update();
    try { win.el.focus(); } catch (e) { /* ignore */ }
    setTimeout(function () {
      try { win.el.focus(); } catch (e) { /* ignore */ }
    }, 0);

    return {
      onClose: function () { /* no timers, nothing to release */ },
      onResize: function () { },
      onFocus: function () { },
      onBlur: function () { }
    };
  }
})();
