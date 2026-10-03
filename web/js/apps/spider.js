/* ===========================================================================
 * Spider Solitaire -- Windows 98 Entertainment Pack extension
 * Classic script.  No external assets or network calls.
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

  var ID = 'spider';
  var REG = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Spider';
  var CW = 820, CH = 560, COLS = 10, CARD_W = 68, CARD_H = 92;
  var FELT = '#008000', FELT_DARK = '#006000';
  var SUIT = ['♠', '♥', '♦', '♣'];
  var SUIT_COL = ['#000000', '#cc0000', '#cc0000', '#000000'];
  var RANK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var dead = false, focused = true, canvas, ctx, win;
  var timerId = null, started = 0, elapsed = 0, running = false;
  var seed = 1, score = 0, completed = 0, stock = [], cols = [], undo = [];
  var selected = null, focusCol = 0, hint = null, status = 'Deal the cards to begin.';
  var bestScore = 0, bestTime = 0, backStyle = 'lattice';

  function now() {
    try { return (W98 && typeof W98.tick === 'function') ? W98.tick() : 0; } catch (e) { return 0; }
  }
  function regGet(k, d) {
    try {
      if (W98.reg && typeof W98.reg.get === 'function') {
        var v = W98.reg.get(REG, k, d);
        return (v === undefined || v === null) ? d : v;
      }
    } catch (e) {}
    return d;
  }
  function regSet(k, v) { try { if (W98.reg && typeof W98.reg.set === 'function') { W98.reg.set(REG, k, v); } } catch (e) {} }
  function int(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rng(seed0) {
    var s = (seed0 >>> 0) || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function copy(a) { return JSON.parse(JSON.stringify(a)); }
  function card(r, s, up) { return { r: r, s: s, up: !!up }; }

  function save() {
    var state = { v: 2, seed: seed, score: score, completed: completed, elapsed: elapsedNow(),
      stock: stock, cols: cols, status: status, bestScore: bestScore, bestTime: bestTime };
    try { regSet('State', JSON.stringify(state)); } catch (e) {}
    regSet('BestScore', bestScore); regSet('BestTime', bestTime); regSet('Seed', seed); regSet('CardBack', backStyle);
  }
  function load() {
    bestScore = clamp(int(regGet('BestScore', 0), 0), 0, 999999);
    bestTime = clamp(int(regGet('BestTime', 0), 0), 0, 9999999);
    backStyle = regGet('CardBack', 'lattice') === 'plain' ? 'plain' : 'lattice';
    var raw = regGet('State', '');
    if (typeof raw !== 'string' || !raw) { newGame(normalizeSeed(regGet('Seed', 1))); return; }
    try {
      var s = JSON.parse(raw);
      if (!s || s.v !== 2 || !Array.isArray(s.cols) || s.cols.length !== COLS || !Array.isArray(s.stock)) { throw new Error('bad'); }
      var good = true, count = 0;
      function validCard(x) { return !!x && isFinite(x.r) && x.r === Math.floor(x.r) && x.r >= 1 && x.r <= 13 && isFinite(x.s) && x.s === Math.floor(x.s) && x.s >= 0 && x.s <= 3 && typeof x.up === 'boolean'; }
      s.cols.forEach(function (c) { if (!Array.isArray(c) || c.length > 52) { good = false; return; } count += c.length; c.forEach(function (x) { if (!validCard(x)) { good = false; } }); });
      s.stock.forEach(function (x) { count++; if (!validCard(x)) { good = false; } });
      var done = clamp(int(s.completed, 0), 0, 8);
      if (!good || s.stock.length > 60 || count !== 104 - done * 13) { throw new Error('bad'); }
      seed = normalizeSeed(s.seed); cols = copy(s.cols); stock = copy(s.stock);
      score = clamp(int(s.score, 0), -99999, 999999); completed = clamp(int(s.completed, 0), 0, 8);
      elapsed = clamp(int(s.elapsed, 0), 0, 9999999); status = typeof s.status === 'string' ? s.status : 'Deal the cards to begin.';
      if (completed >= 8 || status === 'won' || status === 'lost' || status.indexOf('win') >= 0) { running = false; }
      else { startClock(); }
    } catch (e) { newGame(normalizeSeed(regGet('Seed', 1))); }
  }
  function normalizeSeed(v) { var n = int(v, 1) >>> 0; return n || 1; }
  function elapsedNow() { return running ? elapsed + Math.max(0, now() - started) : elapsed; }
  function startClock() {
    if (dead || running || status === 'won') { return; }
    started = now(); running = true;
    if (timerId === null && win && win.setInterval) { timerId = win.setInterval(function () { if (!dead && focused && running) { render(); } }, 250); }
  }
  function pauseClock() { if (running) { elapsed = elapsedNow(); running = false; } }
  function stopClock() { pauseClock(); if (timerId !== null) { try { win.clearInterval(timerId); } catch (e) {} timerId = null; } }

  function newGame(s) {
    stopClock(); seed = normalizeSeed(s || ((now() ^ ((seed + 0x9e3779b9) >>> 0)) >>> 0)); score = 0; completed = 0; elapsed = 0; selected = null; hint = null; undo = [];
    var deck = [], i, j, rnd = rng(seed);
    for (i = 0; i < 2; i++) { for (j = 1; j <= 13; j++) { deck.push(card(j, 0, false), card(j, 1, false), card(j, 2, false), card(j, 3, false)); } }
    for (i = deck.length - 1; i > 0; i--) { j = Math.floor(rnd() * (i + 1)); var t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    cols = [[], [], [], [], [], [], [], [], [], []];
    for (i = 0; i < 54; i++) { cols[i % COLS].push(deck.pop()); }
    cols.forEach(function (c, k) { c[c.length - 1].up = true; });
    stock = deck; status = 'Your move — build descending runs of one suit.';
    startClock(); save(); render();
  }
  function snapshot() { undo.push(JSON.stringify({ cols: cols, stock: stock, score: score, completed: completed, elapsed: elapsedNow(), status: status })); if (undo.length > 64) { undo.shift(); } }
  function doUndo() {
    if (!undo.length || dead) { return; }
    pauseClock(); try { var s = JSON.parse(undo.pop()); cols = s.cols; stock = s.stock; score = s.score; completed = s.completed; elapsed = s.elapsed; status = s.status; selected = null; hint = null; if (status.indexOf('won') < 0) { startClock(); } save(); render(); } catch (e) {}
  }
  function isRun(c, at) {
    if (!c || at < 0 || at >= c.length || !c[at].up) { return false; }
    for (var i = at + 1; i < c.length; i++) { if (!c[i].up || c[i - 1].s !== c[i].s || c[i - 1].r !== c[i].r + 1) { return false; } }
    return true;
  }
  function canMove(from, at, to) {
    if (from === to || !cols[from] || !cols[to] || !isRun(cols[from], at)) { return false; }
    var moving = cols[from][at], dest = cols[to];
    return !dest.length || (dest[dest.length - 1].up && dest[dest.length - 1].r === moving.r + 1);
  }
  function removeComplete(col) {
    if (col.length < 13) { return false; }
    var start = col.length - 13, s = col[start].s;
    if (col[start].r !== 13 || !col[start].up) { return false; }
    for (var i = start; i < col.length; i++) { if (!col[i].up || col[i].s !== s || col[i].r !== 13 - (i - start)) { return false; } }
    col.splice(start, 13); completed++; score += 100; if (score > bestScore) { bestScore = score; }
    if (col.length) { col[col.length - 1].up = true; }
    return true;
  }
  function move(from, at, to) {
    if (!canMove(from, at, to)) { return false; }
    snapshot(); var moved = cols[from].splice(at); Array.prototype.push.apply(cols[to], moved);
    if (cols[from].length && !cols[from][cols[from].length - 1].up) { cols[from][cols[from].length - 1].up = true; score += 5; }
    if (removeComplete(cols[to])) { status = 'Sequence complete!'; }
    selected = null; hint = null; if (completed >= 8) { pauseClock(); status = 'You win! All eight sequences are complete.'; if (!bestTime || elapsedNow() < bestTime) { bestTime = Math.floor(elapsedNow() / 1000); } }
    save(); render(); return true;
  }
  function dealStock() {
    if (!stock.length) { status = 'No cards remain in the stock.'; render(); return; }
    for (var i = 0; i < COLS; i++) { if (!cols[i].length) { status = 'Fill empty columns before dealing.'; render(); return; } }
    snapshot(); for (i = 0; i < COLS; i++) { var c = stock.pop(); c.up = true; cols[i].push(c); }
    score = Math.max(-999, score - 10); status = 'Ten new cards dealt.'; startClock(); save(); render();
  }
  function choose(col, at) {
    if (dead) { return; }
    if (selected === null) { if (isRun(cols[col], at)) { selected = { col: col, at: at }; status = 'Choose a destination column.'; render(); } return; }
    if (selected.col === col && selected.at === at) { selected = null; render(); return; }
    if (!move(selected.col, selected.at, col)) { if (isRun(cols[col], at)) { selected = { col: col, at: at }; status = 'Choose a destination column.'; render(); } else { status = 'That run cannot be moved there.'; selected = null; render(); } }
  }
  function hintMove() {
    hint = null;
    for (var a = 0; a < COLS; a++) { for (var i = 0; i < cols[a].length; i++) { if (!isRun(cols[a], i)) { continue; } for (var b = 0; b < COLS; b++) { if (canMove(a, i, b)) { hint = { from: a, at: i, to: b }; status = 'Hint: move the highlighted run.'; render(); return; } } } }
    status = stock.length ? 'Hint: deal another row from the stock.' : 'No legal moves found.'; render();
  }

  function bevel(g, x, y, w, h, pressed) {
    g.fillStyle = '#c0c0c0'; g.fillRect(x, y, w, h); g.strokeStyle = pressed ? '#000000' : '#ffffff'; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); g.strokeStyle = pressed ? '#ffffff' : '#808080'; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }
  function drawBack(g, x, y) {
    g.fillStyle = '#000080'; g.fillRect(x, y, CARD_W, CARD_H); g.strokeStyle = '#fff'; g.strokeRect(x + 2.5, y + 2.5, CARD_W - 5, CARD_H - 5);
    if (backStyle === 'lattice') { g.strokeStyle = '#55aaff'; for (var i = 5; i < CARD_W - 5; i += 8) { g.beginPath(); g.moveTo(x + i, y + 4); g.lineTo(x + i - 4, y + CARD_H - 4); g.stroke(); } }
    else { g.fillStyle = '#0000a0'; g.fillRect(x + 7, y + 7, CARD_W - 14, CARD_H - 14); g.strokeStyle = '#55aaff'; g.strokeRect(x + 8.5, y + 8.5, CARD_W - 17, CARD_H - 17); }
  }
  function drawCard(g, x, y, c, sel) {
    if (!c.up) { drawBack(g, x, y); return; }
    g.fillStyle = '#fff'; g.fillRect(x, y, CARD_W, CARD_H); g.strokeStyle = '#000'; g.strokeRect(x + .5, y + .5, CARD_W - 1, CARD_H - 1);
    g.fillStyle = SUIT_COL[c.s]; g.font = 'bold 15px Tahoma'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(RANK[c.r], x + 4, y + 3); g.font = '16px Arial'; g.fillText(SUIT[c.s], x + 4, y + 21);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 25px Arial'; g.fillText(SUIT[c.s], x + CARD_W / 2, y + CARD_H / 2 + 5);
    g.font = 'bold 15px Tahoma'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(RANK[c.r], x + CARD_W - 4, y + CARD_H - 3); g.font = '16px Arial'; g.fillText(SUIT[c.s], x + CARD_W - 4, y + CARD_H - 19);
    if (sel) { g.strokeStyle = '#ffff00'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, CARD_W - 3, CARD_H - 3); g.lineWidth = 1; }
  }
  function render() {
    if (!ctx || dead) { return; }
    var g = ctx; g.clearRect(0, 0, CW, CH); g.fillStyle = FELT; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#c0c0c0'; g.fillRect(0, 0, CW, 40); g.strokeStyle = '#fff'; g.strokeRect(.5, .5, CW - 1, 39); g.strokeStyle = '#808080'; g.beginPath(); g.moveTo(0, 39.5); g.lineTo(CW, 39.5); g.stroke();
    var btns = [{ x: 8, w: 92, t: 'New Game' }, { x: 106, w: 74, t: 'Undo' }, { x: 184, w: 74, t: 'Hint' }]; btns.forEach(function (b) { bevel(g, b.x, 8, b.w, 24, false); g.fillStyle = '#000'; g.font = '11px Tahoma'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(b.t, b.x + b.w / 2, 20); });
    g.textAlign = 'left'; g.fillStyle = '#000'; g.font = '11px Tahoma'; g.fillText('Score: ' + score, 280, 16); g.fillText('Sequences: ' + completed + '/8', 280, 30); g.fillText('Time: ' + Math.floor(elapsedNow() / 1000) + 's', 425, 16); g.fillText('Best: ' + (bestTime ? bestTime + 's' : '--'), 425, 30);
    var stockX = CW - CARD_W - 18; g.fillStyle = '#004000'; g.fillRect(stockX - 4, 46, CARD_W + 8, CARD_H + 8); if (stock.length) { drawBack(g, stockX, 50); g.fillStyle = '#fff'; g.font = 'bold 11px Tahoma'; g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(stock.length, stockX + CARD_W / 2, 146); } else { g.strokeStyle = '#40a040'; g.strokeRect(stockX + .5, 50.5, CARD_W - 1, CARD_H - 1); }
    var boardW = CW - 2 * 8 - CARD_W - 30, gap = (boardW - COLS * CARD_W) / (COLS - 1), top = 52, step = 20;
    for (var c = 0; c < COLS; c++) {
      var x = 8 + c * (CARD_W + gap); g.fillStyle = c === focusCol ? '#40a040' : FELT_DARK; g.fillRect(x - 2, top - 2, CARD_W + 4, 3); var col = cols[c];
      if (!col.length) { g.strokeStyle = '#40a040'; g.strokeRect(x + .5, top + .5, CARD_W - 1, CARD_H - 1); }
      for (var i = 0; i < col.length; i++) { var y = top + i * step; if (i === col.length - 1) { y = Math.min(y, CH - CARD_H - 8); } var sel = selected && selected.col === c && i >= selected.at; var hi = hint && hint.from === c && i >= hint.at; drawCard(g, x, y, col[i], sel || hi); }
    }
    g.fillStyle = '#fff'; g.font = '11px Tahoma'; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(status, 8, CH - 6);
    if (!focused) { g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(0, 0, CW, CH); g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText('Paused — click the window to resume', CW / 2, CH / 2); }
  }

  function pos(ev) { var r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) * CW / r.width, y: (ev.clientY - r.top) * CH / r.height }; }
  function onMouseDown(ev) {
    if (!focused || dead) { return; } var p = pos(ev); if (p.y < 40) { if (p.x < 100) { newGame(); } else if (p.x < 182) { doUndo(); } else if (p.x < 265) { hintMove(); } return; }
    var stockX = CW - CARD_W - 18; if (p.x >= stockX && p.x <= stockX + CARD_W && p.y >= 46 && p.y <= 155) { dealStock(); return; }
    var boardW = CW - 2 * 8 - CARD_W - 30, gap = (boardW - COLS * CARD_W) / (COLS - 1), c = Math.floor((p.x - 8) / (CARD_W + gap)); if (c < 0 || c >= COLS) { return; }
    var col = cols[c], at = col.length - 1; if (col.length) { var step = 20; at = Math.floor((p.y - 52) / step); if (at < 0) { at = 0; } if (at >= col.length) { at = col.length - 1; } while (at < col.length - 1 && p.y > 52 + (at + 1) * step + CARD_H) { at++; } choose(c, at); } else if (selected !== null) { move(selected.col, selected.at, c); }
    try { canvas.focus(); } catch (e) {}
  }
  function onKey(ev) {
    if (ev && ev.__spiderHandled) { return; }
    if (ev) { ev.__spiderHandled = true; }
    if (dead || !focused) { return; } var k = ev.key || ''; if (k === 'ArrowLeft') { focusCol = (focusCol + COLS - 1) % COLS; render(); ev.preventDefault(); return; } if (k === 'ArrowRight') { focusCol = (focusCol + 1) % COLS; render(); ev.preventDefault(); return; }
    if (k === 'n' || k === 'N' || k === 'F2') { newGame(); ev.preventDefault(); return; } if (k === 'u' || k === 'U' || (k === 'z' && ev.ctrlKey)) { doUndo(); ev.preventDefault(); return; } if (k === 'h' || k === 'H' || k === 'F1') { hintMove(); ev.preventDefault(); return; } if (k === 'b' || k === 'B') { toggleBack(); ev.preventDefault(); return; } if (k === 'd' || k === 'D' || k === ' ') { dealStock(); ev.preventDefault(); return; } if (k === 'Escape') { selected = null; hint = null; render(); ev.preventDefault(); return; }
    if (k === 'Enter') { if (selected === null) { var c = cols[focusCol]; if (c.length) { choose(focusCol, c.length - 1); } } else { move(selected.col, selected.at, focusCol); } ev.preventDefault(); }
  }
  function toggleBack() { backStyle = backStyle === 'lattice' ? 'plain' : 'lattice'; regSet('CardBack', backStyle); render(); }
  function about() {
    if (W98.aboutDialog) { try { W98.aboutDialog({ id: ID, title: 'About Spider Solitaire', icon: 'solitaire' }); return; } catch (e) {} }
    if (W98.dialog && W98.dialog.alert) { W98.dialog.alert('About Spider Solitaire', 'Spider Solitaire\nWindows 98 Web Entertainment Pack\n\nBuild complete descending runs in one suit. Click a card, then a column; press N for a new game.', 'info'); }
  }
  function setMenu() {
    try { win.setMenu([{ label: '&Game', items: [{ label: '&New Game', accel: 'F2', onclick: function () { newGame(); } }, { label: '&Undo', accel: 'Ctrl+Z', onclick: doUndo }, { label: '&Deal from Stock', accel: 'Space', onclick: dealStock }, { label: 'Card &Back Style', onclick: toggleBack }, { type: 'sep' }, { label: 'E&xit', onclick: function () { win.close(); } }] }, { label: '&Help', items: [{ label: '&How to Play', onclick: function () { if (W98.dialog && W98.dialog.alert) { W98.dialog.alert('How to Play Spider', 'Move descending runs of the same suit. Any card may be placed on the next higher rank. Empty columns accept any run. Complete K through A to remove a sequence. Deal only when every column has a card.', 'info'); } } }, { label: '&About Spider Solitaire...', onclick: about }] }]); } catch (e) {}
  }
  function cleanup() { if (dead) { return; } dead = true; stopClock(); try { canvas.removeEventListener('mousedown', onMouseDown); canvas.removeEventListener('keydown', onKey); } catch (e) {} try { win.el.removeEventListener('keydown', onKey); } catch (e) {} try { save(); } catch (e) {} }

  W98.registerApp({ id: ID, title: 'Spider Solitaire', icon: 'solitaire', width: CW, height: CH, minWidth: CW, minHeight: CH, resizable: false, maximizable: false, desktop: true, startMenuGroup: 'Games', singleton: true, create: function (w) {
    win = w; dead = false; focused = true; win.el.style.overflow = 'hidden'; win.el.style.background = FELT; load();
    canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH; canvas.tabIndex = 0; canvas.style.display = 'block'; canvas.style.width = CW + 'px'; canvas.style.height = CH + 'px'; canvas.style.imageRendering = 'pixelated'; win.el.appendChild(canvas); ctx = canvas.getContext('2d');
    setMenu(); render(); canvas.addEventListener('mousedown', onMouseDown); canvas.addEventListener('keydown', onKey); try { win.el.addEventListener('keydown', onKey); } catch (e) {}
    try { if (typeof win.claimKeys === 'function') { win.claimKeys(); } } catch (e) {}
    try { win.on('close', cleanup); win.on('blur', function () { focused = false; pauseClock(); render(); }); win.on('minimize', function () { focused = false; pauseClock(); render(); }); win.on('focus', function () { focused = true; if (status.indexOf('win') < 0) { startClock(); } render(); }); win.on('restore', function () { focused = true; if (status.indexOf('win') < 0) { startClock(); } render(); }); } catch (e) {}
    return { onClose: cleanup, onFocus: function () { focused = true; startClock(); render(); }, onBlur: function () { focused = false; pauseClock(); render(); }, onKey: onKey };
  }});
}());
