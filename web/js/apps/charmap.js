/* ===========================================================================
 * charmap.js — Character Map (Windows 98 accessory)
 *
 * Classic script (NOT a module).  Registers itself with W98.registerApp().
 * 32 x 8 character grid with 1px cell borders, font combo, subset combo,
 * "Characters to copy" field, Select / Copy and a status bar with the hex code.
 * =========================================================================*/
(function () {
  'use strict';

  var ID = 'charmap';
  var REG_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\CharacterMap';
  var COLS = 32, ROWS = 8, PERPAGE = COLS * ROWS, TOTAL = 65536;

  /* The 1998 font list.  CSS stacks degrade gracefully if a face is absent. */
  var FONTS = [
    { name: 'Arial', css: 'Arial, Helvetica, "Liberation Sans", sans-serif' },
    { name: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", serif' },
    { name: 'Courier New', css: '"Courier New", Courier, "Liberation Mono", monospace' },
    { name: 'Symbol', css: 'Symbol, "Segoe UI Symbol", "Standard Symbols PS", serif' },
    { name: 'MS Sans Serif', css: '"MS Sans Serif", Tahoma, Geneva, "DejaVu Sans", sans-serif' },
    { name: 'Wingdings', css: 'Wingdings, "Segoe UI Symbol", "Zapf Dingbats", fantasy' },
    { name: 'Terminal', css: 'Terminal, "Lucida Console", "Courier New", monospace' }
  ];

  /* Windows-1252 high range: the "codepage-ish" page shown for code points
     0x80..0x9F.  Anything not listed here is unassigned in cp1252. */
  var CP1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178
  };
  var CP1252_NAMES = {
    0x80: 'EURO SIGN', 0x82: 'SINGLE LOW-9 QUOTATION MARK', 0x83: 'LATIN SMALL LETTER F WITH HOOK',
    0x84: 'DOUBLE LOW-9 QUOTATION MARK', 0x85: 'HORIZONTAL ELLIPSIS', 0x86: 'DAGGER',
    0x87: 'DOUBLE DAGGER', 0x88: 'MODIFIER LETTER CIRCUMFLEX ACCENT', 0x89: 'PER MILLE SIGN',
    0x8A: 'LATIN CAPITAL LETTER S WITH CARON', 0x8B: 'SINGLE LEFT-POINTING ANGLE QUOTATION MARK',
    0x8C: 'LATIN CAPITAL LIGATURE OE', 0x8E: 'LATIN CAPITAL LETTER Z WITH CARON',
    0x91: 'LEFT SINGLE QUOTATION MARK', 0x92: 'RIGHT SINGLE QUOTATION MARK',
    0x93: 'LEFT DOUBLE QUOTATION MARK', 0x94: 'RIGHT DOUBLE QUOTATION MARK',
    0x95: 'BULLET', 0x96: 'EN DASH', 0x97: 'EM DASH', 0x98: 'SMALL TILDE',
    0x99: 'TRADE MARK SIGN', 0x9A: 'LATIN SMALL LETTER S WITH CARON',
    0x9B: 'SINGLE RIGHT-POINTING ANGLE QUOTATION MARK', 0x9C: 'LATIN SMALL LIGATURE OE',
    0x9E: 'LATIN SMALL LETTER Z WITH CARON', 0x9F: 'LATIN CAPITAL LETTER Y WITH DIAERESIS'
  };

  var SUBSETS = [
    { name: 'Windows: Western', start: 0x0000 },
    { name: 'Unicode: Latin Extended-A', start: 0x0100 },
    { name: 'Unicode: Latin Extended-B', start: 0x0180 },
    { name: 'Unicode: Spacing Modifier Letters', start: 0x02B0 },
    { name: 'Unicode: Greek', start: 0x0370 },
    { name: 'Unicode: Cyrillic', start: 0x0400 },
    { name: 'Unicode: Hebrew', start: 0x0590 },
    { name: 'Unicode: Arabic', start: 0x0600 },
    { name: 'Unicode: General Punctuation', start: 0x2000 },
    { name: 'Unicode: Currency Symbols', start: 0x20A0 },
    { name: 'Unicode: Letterlike Symbols', start: 0x2100 },
    { name: 'Unicode: Arrows', start: 0x2190 },
    { name: 'Unicode: Mathematical Operators', start: 0x2200 },
    { name: 'Unicode: Box Drawing', start: 0x2500 },
    { name: 'Unicode: Block Elements', start: 0x2580 },
    { name: 'Unicode: Geometric Shapes', start: 0x25A0 },
    { name: 'Unicode: Miscellaneous Symbols', start: 0x2600 },
    { name: 'Unicode: Dingbats', start: 0x2700 },
    { name: 'Unicode: CJK Symbols and Punctuation', start: 0x3000 },
    { name: 'Unicode: Hiragana', start: 0x3040 }
  ];

  var WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
  var PUNCT = {
    0x20: 'SPACE', 0x21: 'EXCLAMATION MARK', 0x22: 'QUOTATION MARK', 0x23: 'NUMBER SIGN',
    0x24: 'DOLLAR SIGN', 0x25: 'PERCENT SIGN', 0x26: 'AMPERSAND', 0x27: 'APOSTROPHE',
    0x28: 'LEFT PARENTHESIS', 0x29: 'RIGHT PARENTHESIS', 0x2A: 'ASTERISK', 0x2B: 'PLUS SIGN',
    0x2C: 'COMMA', 0x2D: 'HYPHEN-MINUS', 0x2E: 'FULL STOP', 0x2F: 'SOLIDUS',
    0x3A: 'COLON', 0x3B: 'SEMICOLON', 0x3C: 'LESS-THAN SIGN', 0x3D: 'EQUALS SIGN',
    0x3E: 'GREATER-THAN SIGN', 0x3F: 'QUESTION MARK', 0x40: 'COMMERCIAL AT',
    0x5B: 'LEFT SQUARE BRACKET', 0x5C: 'REVERSE SOLIDUS', 0x5D: 'RIGHT SQUARE BRACKET',
    0x5E: 'CIRCUMFLEX ACCENT', 0x5F: 'LOW LINE', 0x60: 'GRAVE ACCENT',
    0x7B: 'LEFT CURLY BRACKET', 0x7C: 'VERTICAL LINE', 0x7D: 'RIGHT CURLY BRACKET',
    0x7E: 'TILDE', 0xA0: 'NO-BREAK SPACE', 0xA9: 'COPYRIGHT SIGN',
    0xAE: 'REGISTERED SIGN', 0xB0: 'DEGREE SIGN', 0xB1: 'PLUS-MINUS SIGN',
    0xB5: 'MICRO SIGN', 0xBD: 'VULGAR FRACTION ONE HALF', 0xD7: 'MULTIPLICATION SIGN',
    0xF7: 'DIVISION SIGN'
  };

  function nameOf(code) {
    if (code >= 0x30 && code <= 0x39) { return 'DIGIT ' + WORDS[code - 0x30]; }
    if (code >= 0x41 && code <= 0x5A) { return 'LATIN CAPITAL LETTER ' + String.fromCharCode(code); }
    if (code >= 0x61 && code <= 0x7A) { return 'LATIN SMALL LETTER ' + String.fromCharCode(code); }
    if (code < 0x20 || code === 0x7F) { return ''; }
    if (PUNCT[code]) { return PUNCT[code]; }
    if (code >= 0x80 && code <= 0x9F && CP1252_NAMES[code]) { return CP1252_NAMES[code]; }
    return '';
  }

  function hex(n, pad) {
    var s = n.toString(16).toUpperCase();
    while (s.length < pad) { s = '0' + s; }
    return s;
  }
  function isPrintable(code) {
    if (code < 0x20 || code === 0x7F) { return false; }
    if (code >= 0x80 && code <= 0x9F && !CP1252[code]) { return false; }
    if (code >= 0xD800 && code <= 0xDFFF) { return false; }
    if (code >= 0xFDD0 && code <= 0xFDEF) { return false; }
    if ((code & 0xFFFE) === 0xFFFE) { return false; }
    return true;
  }
  /* The glyph shown for a code point (Windows-1252 folding for 0x80..0x9F). */
  function glyphFor(code) {
    if (code >= 0x80 && code <= 0x9F && CP1252[code]) {
      return String.fromCodePoint(CP1252[code]);
    }
    try { return String.fromCodePoint(code); } catch (e) { return ''; }
  }

  var CSS = [
    '.cm-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;',
    '  min-width:0;min-height:0;background:#c0c0c0;padding:4px;overflow:hidden;',
    '  font:11px Tahoma,"MS Sans Serif",sans-serif;color:#000000}',
    '.cm-root,.cm-root *{box-sizing:border-box}',
    '.cm-row{display:flex;align-items:center;flex:none;margin:0 0 4px}',
    '.cm-row>label{width:52px;flex:none}',
    '.cm-row>label.cm-w2{width:56px}',
    '.cm-sel{flex:1 1 auto;min-width:0;height:18px;font:11px Tahoma,sans-serif;border-radius:0}',
    '.cm-gridwrap{flex:1 1 auto;display:flex;min-height:96px;margin:0 0 5px}',
    '.cm-frame{flex:1 1 auto;min-width:0;background:#ffffff;border:1px solid #808080;',
    '  border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000,inset -1px -1px 0 #dfdfdf;overflow:hidden;',
    '  display:flex}',
    '.cm-grid{flex:1 1 auto;min-width:0;display:grid;grid-template-columns:repeat(32,1fr);',
    '  grid-template-rows:repeat(8,1fr);overflow:hidden;-webkit-user-select:none;user-select:none}',
    '.cm-cell{display:flex;align-items:center;justify-content:center;border:1px solid #c8c8c8;',
    '  margin:-1px 0 0 -1px;overflow:hidden;line-height:1;cursor:default;background:#ffffff;',
    '  color:#000000;padding:0}',
    '.cm-cell.blank{background:#e8e8e8}',
    '.cm-cell.sel{background:#000080;color:#ffffff}',
    '.cm-cell.cur{border-color:#000000;border-style:dotted}',
    '.cm-sb{width:16px;flex:none;display:flex;flex-direction:column;background:#c0c0c0;',
    '  margin-left:1px;border:1px solid #ffffff;border-right-color:#000000;',
    '  border-bottom-color:#000000}',
    '.cm-sb .t,.cm-sb .b{height:16px;flex:none;position:relative;cursor:default}',
    '.cm-sb .t:before,.cm-sb .b:before{content:"";position:absolute;left:4px;top:4px;',
    '  width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent}',
    '.cm-sb .t:before{border-bottom:6px solid #000000}',
    '.cm-sb .b:before{border-top:6px solid #000000}',
    '.cm-sb .track{flex:1 1 auto;min-height:16px;position:relative;background:#dfdfdf;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff}',
    '.cm-sb .thumb{position:absolute;left:0;width:100%;background:#c0c0c0;height:24px;',
    '  border:1px solid #ffffff;border-right-color:#000000;border-bottom-color:#000000}',
    '.cm-copylab{flex:none;margin:0 0 3px}',
    '.cm-copyrow{display:flex;align-items:flex-start;flex:none;gap:6px}',
    '.cm-field{flex:1 1 auto;min-width:0;height:22px;padding:2px 3px;background:#ffffff;',
    '  border:1px solid #808080;border-right-color:#ffffff;border-bottom-color:#ffffff;',
    '  box-shadow:inset 1px 1px 0 #000000;border-radius:0;outline:none;',
    '  font:12px Tahoma,"MS Sans Serif",sans-serif;color:#000000}',
    '.cm-btns{flex:none;display:flex;flex-direction:column;gap:4px}',
    '.cm-btns button{min-width:66px;font:11px Tahoma,sans-serif;padding:2px 6px;border-radius:0}',
    '.cm-hint{flex:none;font:11px Tahoma,sans-serif;color:#000000;margin:5px 0 0;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style');
    st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  W98.registerApp({
    id: ID,
    title: 'Character Map',
    icon: 'charmap',
    width: 460,
    height: 400,
    minWidth: 380,
    minHeight: 320,
    resizable: true,
    maximizable: true,
    singleton: true,
    startMenuGroup: 'Accessories',
    create: create
  });

  function create(win) {
    ensureCss();
    win.el.style.display = 'flex';
    win.el.style.overflow = 'hidden';
    var root = document.createElement('div');
    root.className = 'cm-root';
    root.style.flex = '1 1 auto';
    win.el.appendChild(root);

    /* ------------------------------------------------------------- rows */
    var row1 = document.createElement('div');
    row1.className = 'cm-row';
    var l1 = document.createElement('label');
    l1.textContent = 'Font:';
    l1.setAttribute('for', 'cm-font');
    var fsel = document.createElement('select');
    fsel.className = 'cm-sel';
    fsel.id = 'cm-font';
    FONTS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.name;
      o.textContent = f.name;
      fsel.appendChild(o);
    });
    row1.appendChild(l1);
    row1.appendChild(fsel);
    root.appendChild(row1);

    var row2 = document.createElement('div');
    row2.className = 'cm-row';
    var l2 = document.createElement('label');
    l2.className = 'cm-w2';
    l2.textContent = 'Subset:';
    var ssel = document.createElement('select');
    ssel.className = 'cm-sel';
    SUBSETS.forEach(function (s, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = s.name;
      ssel.appendChild(o);
    });
    row2.appendChild(l2);
    row2.appendChild(ssel);
    root.appendChild(row2);

    /* ------------------------------------------------------------- grid */
    var wrap = document.createElement('div');
    wrap.className = 'cm-gridwrap';
    var frame = document.createElement('div');
    frame.className = 'cm-frame';
    var grid = document.createElement('div');
    grid.className = 'cm-grid';
    grid.setAttribute('role', 'grid');
    grid.tabIndex = 0;
    frame.appendChild(grid);
    var sb = document.createElement('div');
    sb.className = 'cm-sb';
    sb.innerHTML = '<div class="t"></div><div class="track"><div class="thumb"></div></div>' +
      '<div class="b"></div>';
    wrap.appendChild(frame);
    wrap.appendChild(sb);
    root.appendChild(wrap);

    /* --------------------------------------------------------- copy area */
    var clab = document.createElement('div');
    clab.className = 'cm-copylab';
    clab.textContent = 'Characters to copy:';
    root.appendChild(clab);
    var crow = document.createElement('div');
    crow.className = 'cm-copyrow';
    var field = document.createElement('input');
    field.type = 'text';
    field.className = 'cm-field';
    field.setAttribute('aria-label', 'Characters to copy');
    var btns = document.createElement('div');
    btns.className = 'cm-btns';
    var bSel = document.createElement('button');
    bSel.type = 'button';
    bSel.textContent = 'Select';
    var bCopy = document.createElement('button');
    bCopy.type = 'button';
    bCopy.textContent = 'Copy';
    btns.appendChild(bSel);
    btns.appendChild(bCopy);
    crow.appendChild(field);
    crow.appendChild(btns);
    root.appendChild(crow);

    var hint = document.createElement('div');
    hint.className = 'cm-hint';
    hint.textContent = 'Drag to select more than one character.';
    root.appendChild(hint);

    /* ------------------------------------------------------------ state */
    var S = {
      font: 'Arial',
      start: 0,
      cells: [],
      sel: [],          // selected indices, in selection order
      cur: 0,           // caret index inside the page
      anchor: 0,
      drag: false,
      clip: ''
    };
    try {
      var f = W98.reg.get(REG_KEY, 'Font', '');
      if (f && FONTS.some(function (x) { return x.name === f; })) { S.font = f; }
    } catch (e) { /* keep default */ }

    function fontCss() {
      for (var i = 0; i < FONTS.length; i++) {
        if (FONTS[i].name === S.font) { return FONTS[i].css; }
      }
      return 'Arial, sans-serif';
    }
    function codeAt(i) { return (S.start + i) % TOTAL; }

    /* ------------------------------------------------------------ render */
    function renderGrid() {
      var frag = document.createDocumentFragment();
      S.cells = [];
      for (var i = 0; i < PERPAGE; i++) {
        var code = codeAt(i);
        var c = document.createElement('div');
        c.className = 'cm-cell';
        if (isPrintable(code)) {
          c.textContent = glyphFor(code);
          c.title = 'U+' + hex(code, 4) + (code <= 0xFF ? ' (0x' + hex(code, 2) + ')' : '');
        } else {
          c.classList.add('blank');
          c.title = '';
        }
        c.setAttribute('data-i', String(i));
        S.cells.push(c);
        frag.appendChild(c);
      }
      grid.innerHTML = '';
      grid.appendChild(frag);
      applyFontSize();
      paint();
    }
    function applyFontSize() {
      var r = S.cells.length ? S.cells[0].getBoundingClientRect() : { width: 14, height: 18 };
      var sz = Math.max(9, Math.min(14, Math.floor(Math.min(r.width, r.height) * 0.82)));
      grid.style.fontSize = sz + 'px';
      grid.style.fontFamily = fontCss();
    }
    function inSel(i) { return S.sel.indexOf(i) >= 0; }
    function paint() {
      for (var i = 0; i < S.cells.length; i++) {
        var c = S.cells[i];
        if (inSel(i)) { c.classList.add('sel'); } else { c.classList.remove('sel'); }
        if (i === S.cur) { c.classList.add('cur'); } else { c.classList.remove('cur'); }
      }
      paintScroll();
    }
    function paintScroll() {
      var track = sb.querySelector('.track');
      var thumb = sb.querySelector('.thumb');
      if (!track || !thumb) { return; }
      var th = track.clientHeight || 100;
      var totalPages = TOTAL / PERPAGE;
      var pos = Math.min(totalPages - 1, Math.max(0, Math.round(S.start / PERPAGE)));
      var thh = Math.max(18, Math.round(th / totalPages * 3));
      var span = Math.max(1, th - thh);
      thumb.style.height = thh + 'px';
      thumb.style.top = Math.round(pos / (totalPages - 1) * span) + 'px';
    }

    /* --------------------------------------------------------- selection */
    function selectOnly(i) { S.sel = [i]; S.cur = i; S.anchor = i; paint(); }
    function extendTo(i) {
      var a = S.anchor, b = i, lo = Math.min(a, b), hi = Math.max(a, b), out = [];
      for (var k = lo; k <= hi; k++) { out.push(k); }
      S.sel = out;
      S.cur = i;
      paint();
    }
    function toggle(i) {
      var p = S.sel.indexOf(i);
      if (p >= 0) { S.sel.splice(p, 1); } else { S.sel.push(i); }
      S.cur = i;
      S.anchor = i;
      paint();
    }
    function selectedText() {
      var idx = S.sel.slice().sort(function (a, b) { return a - b; });
      var out = '';
      for (var i = 0; i < idx.length; i++) {
        var code = codeAt(idx[i]);
        if (isPrintable(code)) { out += glyphFor(code); }
      }
      return out;
    }
    function addSelectionToField() {
      var t = selectedText();
      if (!t) { return; }
      field.value += t;
      field.scrollLeft = field.value.length * 8;
    }

    /* ------------------------------------------------------------- events */
    grid.addEventListener('mousedown', function (e) {
      var c = cellFrom(e);
      if (!c) { return; }
      var i = parseInt(c.getAttribute('data-i'), 10);
      e.preventDefault();
      try { grid.focus(); } catch (e2) { }
      if (e.ctrlKey || e.metaKey) { toggle(i); return; }
      S.drag = true;
      selectOnly(i);
    });
    grid.addEventListener('mousemove', function (e) {
      var c = cellFrom(e);
      if (!c) { return; }
      var i = parseInt(c.getAttribute('data-i'), 10);
      if (S.drag) { extendTo(i); }
      showStatus(i);
    });
    grid.addEventListener('mouseover', function (e) {
      var c = cellFrom(e);
      if (c) { showStatus(parseInt(c.getAttribute('data-i'), 10)); }
    });
    grid.addEventListener('dblclick', function (e) {
      var c = cellFrom(e);
      if (!c) { return; }
      var i = parseInt(c.getAttribute('data-i'), 10);
      selectOnly(i);
      addSelectionToField();
    });
    document.addEventListener('mouseup', function () { S.drag = false; });
    grid.addEventListener('wheel', function (e) {
      e.preventDefault();
      scrollBy(e.deltaY > 0 ? PERPAGE : -PERPAGE);
    }, { passive: false });

    function cellFrom(e) {
      var n = e.target;
      while (n && n !== grid && !(n.getAttribute && n.getAttribute('data-i') !== null)) {
        n = n.parentNode;
      }
      if (!n || n === grid || !n.getAttribute) { return null; }
      return n.getAttribute('data-i') === null ? null : n;
    }

    function scrollBy(delta) {
      var ns = S.start + delta;
      if (ns < 0) { ns = 0; }
      if (ns > TOTAL - PERPAGE) { ns = TOTAL - PERPAGE; }
      if (ns === S.start) { return; }
      S.start = ns;
      renderGrid();
      showStatus(S.cur);
    }
    function setStart(v) {
      v = Math.max(0, Math.min(TOTAL - PERPAGE, v | 0));
      S.start = v;
      renderGrid();
      showStatus(S.cur);
    }

    /* --------------------------------------------------------- scrollbar */
    (function scrollbar() {
      var track = sb.querySelector('.track');
      var thumb = sb.querySelector('.thumb');
      var dragging = false, grabY = 0, grabTop = 0;
      thumb.addEventListener('mousedown', function (e) {
        dragging = true;
        grabY = e.clientY;
        grabTop = parseFloat(thumb.style.top || '0') || 0;
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) { return; }
        var th = track.clientHeight || 100;
        var thh = thumb.offsetHeight || 20;
        var span = Math.max(1, th - thh);
        var top = Math.max(0, Math.min(span, grabTop + (e.clientY - grabY)));
        var frac = top / span;
        var totalPages = TOTAL / PERPAGE;
        setStart(Math.round(frac * (totalPages - 1)) * PERPAGE);
      });
      document.addEventListener('mouseup', function () { dragging = false; });
      track.addEventListener('mousedown', function (e) {
        if (e.target === thumb) { return; }
        var r = track.getBoundingClientRect();
        scrollBy(e.clientY < r.top + thumb.offsetHeight / 2 ? -PERPAGE : PERPAGE);
      });
      sb.querySelector('.t').addEventListener('mousedown', function () { scrollBy(-COLS); });
      sb.querySelector('.b').addEventListener('mousedown', function () { scrollBy(COLS); });
      win.setTimeout(paintScroll, 0);
    })();

    /* ----------------------------------------------------------- keyboard */
    function moveCursor(i) {
      i = Math.max(0, Math.min(PERPAGE - 1, i));
      if (i < 0) { return; }
      if (!grid.contains(S.cells[i])) { return; }
      selectOnly(i);
      var c = S.cells[i];
      if (c && c.scrollIntoView) {
        try { c.scrollIntoView({ block: 'nearest' }); } catch (e) { }
      }
      showStatus(i);
    }
    grid.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowLeft') { e.preventDefault(); moveCursor(S.cur - 1); return; }
      if (k === 'ArrowRight') { e.preventDefault(); moveCursor(S.cur + 1); return; }
      if (k === 'ArrowUp') {
        e.preventDefault();
        if (S.cur - COLS < 0) { scrollBy(-PERPAGE); moveCursor(S.cur + PERPAGE - COLS); }
        else { moveCursor(S.cur - COLS); }
        return;
      }
      if (k === 'ArrowDown') {
        e.preventDefault();
        if (S.cur + COLS >= PERPAGE) { scrollBy(PERPAGE); moveCursor((S.cur + COLS) % PERPAGE); }
        else { moveCursor(S.cur + COLS); }
        return;
      }
      if (k === 'PageUp') { e.preventDefault(); scrollBy(-PERPAGE); return; }
      if (k === 'PageDown' || k === ' ') { e.preventDefault(); scrollBy(PERPAGE); return; }
      if (k === 'Home') { e.preventDefault(); moveCursor(0); return; }
      if (k === 'End') { e.preventDefault(); moveCursor(PERPAGE - 1); return; }
      if (k === 'Enter') { e.preventDefault(); addSelectionToField(); return; }
      if ((e.ctrlKey || e.metaKey) && String(k).toLowerCase() === 'c') {
        e.preventDefault();
        doCopy();
      }
    });

    /* -------------------------------------------------------------- status */
    function showStatus(i) {
      var code = codeAt(i);
      var nm = nameOf(code);
      var left = 'U+' + hex(code, 4) + '  (0x' + hex(code, 2) + ')';
      var right = nm ? nm : S.font + (isPrintable(code) ? '' : '  (not available)');
      try {
        win.setStatus([{ text: left, width: 128 }, { text: right }]);
      } catch (e) { /* no status bar available */ }
    }
    function showFontStatus() {
      try {
        win.setStatus([{ text: '', width: 128 }, { text: S.font + '  \u2014  ' +
          (S.start ? 'U+' + hex(S.start, 4) : 'Windows: Western') }]);
      } catch (e) { /* ignore */ }
    }

    /* --------------------------------------------------------- clipboard */
    var hintTimer = 0;
    var resizeTimer = 0;
    function doCopy() {
      var t = field.value;
      S.clip = t;
      if (!t) {
        try { W98.sound.beep(); } catch (e) { }
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var p = navigator.clipboard.writeText(t);
          if (p && p['then']) { p.then(function () { }, function () { }); }
        }
      } catch (e) { /* local buffer keeps working */ }
      hint.textContent = 'Copied ' + t.length + ' character' + (t.length === 1 ? '' : 's') +
        ' to the Clipboard.';
      if (hintTimer) { win.clearTimeout(hintTimer); }
      hintTimer = win.setTimeout(function () {
        hintTimer = 0;
        hint.textContent = 'Drag to select more than one character.';
      }, 2500);
    }

    bSel.addEventListener('click', function () {
      if (!S.sel.length) { return; }
      addSelectionToField();
      try { grid.focus(); } catch (e) { }
    });
    bCopy.addEventListener('click', doCopy);
    field.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'c') {
        e.preventDefault();
        doCopy();
      }
    });

    function setFont(name) {
      S.font = name;
      try { W98.reg.set(REG_KEY, 'Font', name); } catch (e) { }
      win.setTitle(name + ' - Character Map');
      grid.style.fontFamily = fontCss();
      applyFontSize();
      showFontStatus();
      try { grid.focus(); } catch (e2) { }
    }
    fsel.addEventListener('change', function () { setFont(fsel.value); });
    ssel.addEventListener('change', function () {
      var s = SUBSETS[parseInt(ssel.value, 10)] || SUBSETS[0];
      S.sel = [];
      S.cur = 0;
      setStart(s.start);
      showFontStatus();
    });

    /* -------------------------------------------------------------- menu */
    win.setMenu([
      {
        label: '&File', items: [
          { label: '&Copy', accel: 'Ctrl+C', onclick: doCopy },
          { type: 'sep' },
          { label: 'E&xit', onclick: function () { win.close(); } }
        ]
      },
      {
        label: '&Edit', items: [
          { label: '&Select', onclick: addSelectionToField },
          { label: '&Clear', onclick: function () { field.value = ''; } }
        ]
      },
      {
        label: '&View', items: [
          { label: '&Next Page', accel: 'PgDn', onclick: function () { scrollBy(PERPAGE); } },
          { label: '&Previous Page', accel: 'PgUp', onclick: function () { scrollBy(-PERPAGE); } },
          { type: 'sep' },
          { label: 'Go to &First Page', onclick: function () { setStart(0); } }
        ]
      },
      {
        label: '&Help', items: [
          { label: '&Help Topics', onclick: helpTopics },
          { type: 'sep' },
          { label: '&About Character Map', onclick: about }
        ]
      }
    ]);

    function helpTopics() {
      W98.dialog.alert('Character Map Help',
        'Character Map Help Topics\n\n' +
        '\u2022 Choose a font from the Font list.\n' +
        '\u2022 Click a character, then click Select to add it to\n' +
        '  Characters to copy.\n' +
        '\u2022 Drag the mouse across the grid to select many characters.\n' +
        '\u2022 Hold down Ctrl while clicking to add single characters.\n' +
        '\u2022 Click Copy to put the characters on the Clipboard.', 'info');
    }
    function about() {
      var def = {
        id: ID, title: 'About Character Map', icon: 'charmap',
        name: 'Character Map',
        text: 'Microsoft Windows 98\nVersion 4.10.1998\n\n' +
          'Displays characters from every installed font.'
      };
      try {
        if (typeof W98.aboutDialog === 'function') { W98.aboutDialog(def); return; }
      } catch (e) { /* fall through */ }
      W98.dialog.alert('About Character Map', def.text, 'info');
    }

    /* ---------------------------------------------------------- start up */
    fsel.value = S.font;
    ssel.value = '0';
    win.setTitle(S.font + ' - Character Map');
    renderGrid();
    showFontStatus();
    var startTimer = win.setTimeout(function () {
      startTimer = 0;
      try { grid.focus(); } catch (e) { }
      paintScroll();
      applyFontSize();
    }, 30);

    return {
      onClose: function () {
        if (hintTimer) { win.clearTimeout(hintTimer); hintTimer = 0; }
        if (startTimer) { win.clearTimeout(startTimer); startTimer = 0; }
      },
      onResize: function () {
        if (resizeTimer) { win.clearTimeout(resizeTimer); }
        resizeTimer = win.setTimeout(function () {
          resizeTimer = 0;
          applyFontSize();
          paintScroll();
        }, 20);
      },
      onFocus: function () { }
    };
  }
})();
