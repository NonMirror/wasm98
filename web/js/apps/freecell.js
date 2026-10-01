/* ============================================================================
 * FreeCell  --  web/js/apps/freecell.js
 * Microsoft FreeCell for the Windows 98 Web desktop.
 * Classic script (no modules). Registers itself through W98.registerApp().
 * Every card bitmap is drawn procedurally: no image files, no network.
 *
 * Fidelity notes (1998 client):
 *   client area   632 x 456, fixed (not resizable, not maximizable)
 *   card          71 x 96, 1px black outline, hard square edges
 *   board         8 tableau columns, 4 free cells left, 4 foundations right,
 *                 solid #008000 table
 *   cascade       classic 20px step, compressed only for columns longer than
 *                 13 cards (a 3px strip is the floor so nothing ever runs off
 *                 the fixed client area)
 *   foundations   stacked with the classic 3px vertical overlap
 *   win           52 cards bounce around the board like the original
 * ==========================================================================*/
(function () {
'use strict';

if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

/* ------------------------------------------------------------- constants -- */

var CARD_W = 71, CARD_H = 96;
var TOOL_H = 22;
var FACE = '#c0c0c0', HI = '#ffffff', DARK = '#000000';
var FELT = '#008000', SLOT = '#004000', RED = '#cc0000';
var STEP_MAX = 20, STEP_MIN = 3, FOUND_OVERLAP = 3;

var RANK_TXT = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
/* card id = rank * 4 + suit     rank 0..12 = A..K     suit 0=C 1=D 2=H 3=S */
function rankOf(c) { return c >> 2; }
function suitOf(c) { return c & 3; }
function isRedCard(c) { var s = c & 3; return s === 1 || s === 2; }

/* classic Microsoft deal: C runtime LCG, seed = deal number (1..1000000) */
function dealColumns(dealNumber) {
  var state = (dealNumber & 0x7fffffff) | 0;
  var deck = new Array(52), i, j, t;
  for (i = 0; i < 52; i++) { deck[i] = 51 - i; }
  for (i = 0; i < 51; i++) {
    state = (state * 214013 + 2531011) % 2147483648;
    j = 51 - ((state >>> 16) % (52 - i));
    t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  var cols = [[], [], [], [], [], [], [], []];
  for (i = 0; i < 52; i++) { cols[i % 8].push(deck[i]); }
  return cols;
}

/* ------------------------------------------------------ procedural card art */

/* a suit pip centred on (cx,cy); s is the nominal pip width */
function drawPip(g, cx, cy, suit, s) {
  var h = s * 0.5;
  g.beginPath();
  if (suit === 1) {                                  /* diamond */
    g.moveTo(cx, cy - h);
    g.lineTo(cx + s * 0.36, cy);
    g.lineTo(cx, cy + h);
    g.lineTo(cx - s * 0.36, cy);
    g.closePath(); g.fill();
  } else if (suit === 2) {                           /* heart */
    g.moveTo(cx, cy + h * 0.95);
    g.bezierCurveTo(cx - s * 0.63, cy + h * 0.12, cx - s * 0.53, cy - h * 1.10, cx, cy - h * 0.40);
    g.bezierCurveTo(cx + s * 0.53, cy - h * 1.10, cx + s * 0.63, cy + h * 0.12, cx, cy + h * 0.95);
    g.closePath(); g.fill();
  } else if (suit === 3) {                           /* spade */
    g.moveTo(cx, cy - h);
    g.bezierCurveTo(cx + s * 0.58, cy - h * 0.10, cx + s * 0.50, cy + h * 0.52, cx + s * 0.07, cy + h * 0.52);
    g.lineTo(cx + s * 0.20, cy + h * 1.02);
    g.lineTo(cx - s * 0.20, cy + h * 1.02);
    g.lineTo(cx - s * 0.07, cy + h * 0.52);
    g.bezierCurveTo(cx - s * 0.50, cy + h * 0.52, cx - s * 0.58, cy - h * 0.10, cx, cy - h);
    g.closePath(); g.fill();
  } else {                                           /* club */
    g.arc(cx, cy - h * 0.42, s * 0.26, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx - s * 0.27, cy + h * 0.28, s * 0.26, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx + s * 0.27, cy + h * 0.28, s * 0.26, 0, Math.PI * 2); g.fill();
    g.beginPath();
    g.moveTo(cx - s * 0.09, cy + h * 0.20);
    g.lineTo(cx + s * 0.09, cy + h * 0.20);
    g.lineTo(cx + s * 0.22, cy + h * 1.02);
    g.lineTo(cx - s * 0.22, cy + h * 1.02);
    g.closePath(); g.fill();
  }
}

var PIPS = {
  2:  [[-1, 0], [1, 0]],
  3:  [[0, 0], [0, 0.5], [0, 1]],
  4:  [[-1, 0], [1, 0], [-1, 1], [1, 1]],
  5:  [[-1, 0], [1, 0], [0, 0.5], [-1, 1], [1, 1]],
  6:  [[-1, 0], [1, 0], [-1, 0.5], [1, 0.5], [-1, 1], [1, 1]],
  7:  [[-1, 0], [1, 0], [0, 0.25], [-1, 0.5], [1, 0.5], [-1, 1], [1, 1]],
  8:  [[-1, 0], [1, 0], [0, 0.25], [-1, 0.5], [1, 0.5], [0, 0.75], [-1, 1], [1, 1]],
  9:  [[-1, 0], [1, 0], [-1, 1 / 3], [1, 1 / 3], [0, 0.5], [-1, 2 / 3], [1, 2 / 3], [-1, 1], [1, 1]],
  10: [[-1, 0], [1, 0], [0, 1 / 6], [-1, 1 / 3], [1, 1 / 3], [-1, 2 / 3], [1, 2 / 3], [0, 5 / 6], [-1, 1], [1, 1]]
};

/* one mirrored royal half-figure (crown / bonnet / cap) */
function drawCourtHalf(g, cx, cy, rank, col) {
  g.lineWidth = 1;
  g.strokeStyle = DARK;
  g.beginPath();                                   /* shoulders */
  g.moveTo(cx - 13, cy + 12);
  g.lineTo(cx - 9, cy + 3);
  g.lineTo(cx + 9, cy + 3);
  g.lineTo(cx + 13, cy + 12);
  g.closePath();
  g.fillStyle = col; g.fill(); g.stroke();
  g.fillStyle = '#ffe9cc';                         /* neck */
  g.fillRect(cx - 2, cy - 1, 5, 5);
  g.strokeRect(cx - 2.5, cy - 1, 5, 5);
  g.beginPath();                                   /* head */
  g.arc(cx, cy - 5, 6, 0, Math.PI * 2);
  g.fillStyle = '#ffe9cc'; g.fill(); g.stroke();
  if (rank === 12) {                               /* king: crown */
    g.beginPath();
    g.moveTo(cx - 8, cy - 8);
    g.lineTo(cx - 8, cy - 14);
    g.lineTo(cx - 4, cy - 10);
    g.lineTo(cx, cy - 16);
    g.lineTo(cx + 4, cy - 10);
    g.lineTo(cx + 8, cy - 14);
    g.lineTo(cx + 8, cy - 8);
    g.closePath();
    g.fillStyle = col; g.fill(); g.stroke();
  } else if (rank === 11) {                        /* queen: bonnet */
    g.beginPath();
    g.moveTo(cx - 8, cy - 7);
    g.bezierCurveTo(cx - 9, cy - 16, cx + 9, cy - 16, cx + 8, cy - 7);
    g.closePath();
    g.fillStyle = col; g.fill(); g.stroke();
    g.beginPath(); g.arc(cx, cy - 16, 2, 0, Math.PI * 2);
    g.fillStyle = HI; g.fill(); g.stroke();
  } else {                                         /* jack: cap + plume */
    g.beginPath();
    g.moveTo(cx - 9, cy - 7); g.lineTo(cx + 9, cy - 7);
    g.lineTo(cx + 6, cy - 13); g.lineTo(cx - 6, cy - 13);
    g.closePath();
    g.fillStyle = col; g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(cx - 9, cy - 7); g.lineTo(cx - 9, cy - 4);
    g.lineTo(cx + 9, cy - 4); g.lineTo(cx + 9, cy - 7);
    g.closePath();
    g.fillStyle = HI; g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(cx - 5, cy - 13); g.lineTo(cx - 8, cy - 22); g.lineTo(cx - 2, cy - 15);
    g.closePath();
    g.fillStyle = col; g.fill(); g.stroke();
  }
}

function drawCourt(g, x, y, card) {
  var col = isRedCard(card) ? RED : DARK, rank = rankOf(card);
  g.fillStyle = HI;
  g.fillRect(x + 13, y + 17, CARD_W - 26, CARD_H - 34);
  g.strokeStyle = DARK; g.lineWidth = 1;
  g.strokeRect(x + 13.5, y + 17.5, CARD_W - 27, CARD_H - 35);
  g.save();
  g.beginPath();
  g.rect(x + 14, y + 18, CARD_W - 28, CARD_H - 36);
  g.clip();
  drawCourtHalf(g, x + CARD_W / 2, y + 30, rank, col);
  g.save();
  g.translate(x + CARD_W / 2, y + CARD_H / 2);
  g.rotate(Math.PI);
  g.translate(-(x + CARD_W / 2), -(y + CARD_H / 2));
  drawCourtHalf(g, x + CARD_W / 2, y + 30, rank, col);
  g.restore();
  g.restore();
  g.fillStyle = col;
  drawPip(g, x + 18, y + 25, suitOf(card), 9);
  drawPip(g, x + CARD_W - 18, y + CARD_H - 25, suitOf(card), 9);
}

function drawCorner(g, x, y, card) {
  var col = isRedCard(card) ? RED : DARK, r = rankOf(card);
  g.fillStyle = col;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold ' + (r === 9 ? 12 : 14) + 'px Tahoma, "MS Sans Serif", Arial, sans-serif';
  g.fillText(RANK_TXT[r], x + 13, y + 13);
  drawPip(g, x + 13, y + 26, suitOf(card), 10);
}

function drawCardFace(g, x, y, card) {
  x = Math.round(x); y = Math.round(y);
  g.fillStyle = HI;
  g.fillRect(x, y, CARD_W, CARD_H);
  g.strokeStyle = DARK;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1);
  var r = rankOf(card), col = isRedCard(card) ? RED : DARK;
  g.save();
  g.beginPath(); g.rect(x + 1, y + 1, CARD_W - 2, CARD_H - 2); g.clip();
  if (r >= 10) {
    drawCourt(g, x, y, card);
  } else if (r === 0) {
    g.fillStyle = col;
    drawPip(g, x + CARD_W / 2, y + CARD_H / 2, suitOf(card), 40);
  } else {
    var list = PIPS[r + 1], i, px, py, cx = x + CARD_W / 2;
    var py0 = y + 24, py1 = y + CARD_H - 24;
    g.fillStyle = col;
    for (i = 0; i < list.length; i++) {
      px = cx + list[i][0] * 12.5;
      py = py0 + list[i][1] * (py1 - py0);
      if (list[i][1] > 0.5) {
        g.save();
        g.translate(px, py); g.rotate(Math.PI);
        drawPip(g, 0, 0, suitOf(card), 17);
        g.restore();
      } else {
        drawPip(g, px, py, suitOf(card), 17);
      }
    }
  }
  g.restore();
  drawCorner(g, x, y, card);
  g.save();
  g.translate(x + CARD_W / 2, y + CARD_H / 2);
  g.rotate(Math.PI);
  g.translate(-(x + CARD_W / 2), -(y + CARD_H / 2));
  drawCorner(g, x, y, card);
  g.restore();
}

var BACK_STYLES = {
  blue:  { base: '#0000a8', hatch: '#8080d0', edge: '#4040c0' },
  red:   { base: '#800000', hatch: '#d08080', edge: '#c04040' },
  green: { base: '#006000', hatch: '#80d080', edge: '#40c040' }
};

function drawCardBack(g, x, y, style) {
  x = Math.round(x); y = Math.round(y);
  var st = BACK_STYLES[style] || BACK_STYLES.blue;
  g.fillStyle = HI;
  g.fillRect(x, y, CARD_W, CARD_H);
  g.fillStyle = st.base;
  g.fillRect(x + 2, y + 2, CARD_W - 4, CARD_H - 4);
  g.save();
  g.beginPath(); g.rect(x + 4, y + 4, CARD_W - 8, CARD_H - 8); g.clip();
  g.strokeStyle = st.hatch;
  g.lineWidth = 1;
  g.beginPath();
  var i;
  for (i = -CARD_H; i < CARD_W + CARD_H; i += 9) {
    g.moveTo(x + i + 0.5, y + 4);
    g.lineTo(x + i + CARD_H + 0.5, y + CARD_H - 4);
    g.moveTo(x + i + 0.5, y + CARD_H - 4);
    g.lineTo(x + i + CARD_H + 0.5, y + 4);
  }
  g.stroke();
  g.strokeStyle = st.edge;
  g.beginPath();
  g.moveTo(x + 4, y + 4); g.lineTo(x + CARD_W - 4, y + 4);
  g.lineTo(x + CARD_W - 4, y + CARD_H - 4); g.lineTo(x + 4, y + CARD_H - 4);
  g.closePath(); g.stroke();
  g.restore();
  g.strokeStyle = HI;
  g.strokeRect(x + 3.5, y + 3.5, CARD_W - 7, CARD_H - 7);
  g.strokeStyle = DARK;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1);
}

/* ----------------------------------------------------------- game engine -- */

function nowMs() {
  try {
    if (W98 && typeof W98.tick === 'function') {
      var t = W98.tick();
      if (typeof t === 'number' && isFinite(t)) { return t; }
    }
  } catch (e) {}
  return Date.now();
}

var S = { supermove: true, animate: true, cardBack: 'blue', sound: true };
var G = null;
var win = null, canvas = null, ctx = null, def = null;
var L = { left: 11, gap: 6, step: 77, top: 12, tabTop: 120, stack: 20 };
var dead = false, looping = false, rafCancel = null;
var anims = [], drag = null, pressHandled = false;
var winRun = null, winRunUntil = 0;
var statTimer = null, autoPlayTimer = null, focused = true;
var optDlg = null, optSnapshot = null;

function snapshot() {
  var s = { cols: [], free: G.free.slice(), found: G.found.slice(), moves: G.moves };
  for (var i = 0; i < 8; i++) { s.cols.push(G.cols[i].slice()); }
  return s;
}
function restore(s) {
  G.cols = [];
  for (var i = 0; i < 8; i++) { G.cols.push(s.cols[i].slice()); }
  G.free = s.free.slice();
  G.found = s.found.slice();
  G.moves = s.moves;
  G.sel = null; drag = null;
}
function pushHistory() {
  G.hist.push(snapshot());
  if (G.hist.length > 4000) { G.hist.shift(); }
}
function newGame(num) {
  G = {
    num: num, cols: dealColumns(num), free: [null, null, null, null],
    found: [0, 0, 0, 0], moves: 0, start: nowMs(), elapsed: 0, won: false,
    sel: null, hist: []
  };
  anims = []; drag = null; pressHandled = false;
  winRun = null; winRunUntil = 0;
  savePrefs();
}
function elapsedSec() {
  if (!G) { return 0; }
  if (G.won) { return G.elapsed; }
  return Math.max(0, Math.floor((nowMs() - G.start) / 1000));
}
function score() {
  var cards = G.found[0] + G.found[1] + G.found[2] + G.found[3];
  return Math.max(0, 500 + cards * 25 - G.moves * 2 - Math.floor(elapsedSec() / 5) * 5);
}
function fmtTime(sec) {
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function freeCells() {
  var n = 0;
  for (var i = 0; i < 4; i++) { if (G.free[i] === null) { n++; } }
  return n;
}
function emptyCols() {
  var n = 0;
  for (var i = 0; i < 8; i++) { if (!G.cols[i].length) { n++; } }
  return n;
}
function maxMove(toEmpty) {
  if (!S.supermove) { return 1; }
  var e = emptyCols() - (toEmpty ? 1 : 0);
  if (e < 0) { e = 0; }
  return (freeCells() + 1) * Math.pow(2, e);
}
function canStack(card, onto) {
  return rankOf(card) === rankOf(onto) - 1 && isRedCard(card) !== isRedCard(onto);
}
function isRun(cards, from) {
  for (var i = from + 1; i < cards.length; i++) {
    if (!canStack(cards[i], cards[i - 1])) { return false; }
  }
  return true;
}
function foundationNeeds(card) { return G.found[suitOf(card)] === rankOf(card); }

/* --------------------------------------------------------------- effects -- */

function sfx(freq, ms, type) {
  if (!S.sound || !(freq > 0)) { return; }
  try {
    if (W98.sound && typeof W98.sound.tone === 'function') { W98.sound.tone(freq, ms, type || 'square'); }
  } catch (e) {}
}
function beepOnce() {
  if (!S.sound) { return; }
  try { if (W98.sound && W98.sound.beep) { W98.sound.beep(); } } catch (e) {}
}
function errorOnce() {
  if (!S.sound) { return; }
  try { if (W98.sound && W98.sound.error) { W98.sound.error(); } } catch (e) {}
}

/* --------------------------------------------------------- animation kit -- */

function startAnim(items, dur, onDone) {
  anims.push({ items: items, t: 0, dur: dur, done: onDone, dead: false });
  kick();
}
function flyingSet() {
  var map = {}, a, i, j;
  for (i = 0; i < anims.length; i++) {
    a = anims[i];
    for (j = 0; j < a.items.length; j++) { map[a.items[j].card] = true; }
  }
  return map;
}
function easeOut(t) { return 1 - (1 - t) * (1 - t); }
function stepAnims(dt) {
  var i, a, busy = false;
  for (i = 0; i < anims.length; i++) {
    a = anims[i];
    if (a.dead) { continue; }
    a.t += dt;
    if (a.t >= a.dur) {
      a.t = a.dur; a.dead = true;
      if (a.done) { try { a.done(); } catch (e) {} }
    } else { busy = true; }
  }
  if (anims.length) { anims = anims.filter(function (x) { return !x.dead; }); }
  return busy || anims.length > 0;
}

/* ------------------------------------------------------------ raf driving -- */

function doRaf(fn) {
  try {
    if (W98 && typeof W98.raf === 'function') { return W98.raf(fn); }
  } catch (e) {}
  var id = null, last = 0, stop = false;
  var loop = function (ts) {
    if (stop) { return; }
    if (!last) { last = ts; }
    var dt = ts - last;
    last = ts;
    fn(dt);
    if (!stop) { id = requestAnimationFrame(loop); }
  };
  id = requestAnimationFrame(loop);
  return function () { stop = true; if (id !== null) { cancelAnimationFrame(id); id = null; } };
}
function kick() {
  if (dead || looping) { return; }
  looping = true;
  rafCancel = doRaf(function (dt) {
    if (dead || !looping) { return; }
    frame(dt || 16);
  });
}
function frame(dt) {
  if (dead) { return; }
  if (dt > 100) { dt = 100; }
  var busy = stepAnims(dt);
  if (winRun) { stepWinRun(dt); busy = true; }
  render();
  if (!(busy || drag !== null)) {
    looping = false;
    var c = rafCancel;
    rafCancel = null;
    if (c) { try { c(); } catch (e) {} }
  }
}

/* ----------------------------------------------------------- layout math -- */

function colX(i) { return L.left + i * L.step; }
function cardY(i, k) { return L.tabTop + k * L.stack; }

function computeLayout(W, H) {
  var gap = 6;
  var boardW = 8 * CARD_W + 7 * gap;
  if (boardW > W - 8) {
    gap = Math.floor((W - 8 - 8 * CARD_W) / 7);
    if (gap < 2) { gap = 2; }
    boardW = 8 * CARD_W + 7 * gap;
  }
  L.gap = gap;
  L.step = CARD_W + gap;
  L.left = Math.max(2, Math.floor((W - boardW) / 2));
  L.top = 12;
  L.tabTop = L.top + CARD_H + 12;
  var maxLen = 1, i;
  for (i = 0; i < 8; i++) { if (G.cols[i].length > maxLen) { maxLen = G.cols[i].length; } }
  var availH = H - L.tabTop - 4;
  var off = maxLen > 1 ? Math.floor((availH - CARD_H) / (maxLen - 1)) : STEP_MAX;
  if (off > STEP_MAX) { off = STEP_MAX; }
  if (off < STEP_MIN) { off = STEP_MIN; }
  L.stack = off;
}

/* ------------------------------------------------------------ hit testing -- */

function hitTest(px, py) {
  var i, x, y, n, k;
  if (py >= L.top && py < L.top + CARD_H) {
    for (i = 0; i < 8; i++) {
      x = colX(i);
      if (px >= x && px < x + CARD_W) {
        if (i < 4) { return { zone: 'cell', idx: i }; }
        return { zone: 'found', idx: i - 4 };
      }
    }
    return null;
  }
  if (py >= L.tabTop) {
    for (i = 0; i < 8; i++) {
      x = colX(i);
      if (px >= x && px < x + CARD_W) {
        n = G.cols[i].length;
        if (!n) { return { zone: 'col', idx: i, card: -1, empty: true }; }
        y = cardY(i, n - 1);
        if (py > y + CARD_H) { return null; }
        k = Math.floor((py - L.tabTop) / L.stack);
        if (k > n - 1) { k = n - 1; }
        if (k < 0) { k = 0; }
        return { zone: 'col', idx: i, card: k };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------ move logic -- */

function animateMove(cards, fromPts, toPt) {
  if (!S.animate || !cards.length) { return; }
  var items = [], i;
  for (i = 0; i < cards.length; i++) {
    items.push({
      card: cards[i], x0: fromPts[i].x, y0: fromPts[i].y,
      x1: toPt.x, y1: toPt.y - i * L.stack
    });
  }
  startAnim(items, 150, null);
}

function doUndo() {
  if (!G || G.won || !G.hist.length) { return; }
  restore(G.hist.pop());
  anims = [];
  sfx(300, 40, 'triangle');
  render(); updateStatus();
}

function getFoundationXY(suit) { return { x: colX(4 + suit), y: L.top }; }

function moveToFoundation(fromZone, fromIdx) {
  var card, fromX, fromY;
  if (fromZone === 'cell') { card = G.free[fromIdx]; }
  else {
    var col = G.cols[fromIdx];
    card = col.length ? col[col.length - 1] : null;
  }
  if (card === null || card === undefined) { return false; }
  if (!foundationNeeds(card)) { errorOnce(); return false; }
  pushHistory();
  if (fromZone === 'cell') {
    fromX = colX(fromIdx); fromY = L.top;
    G.free[fromIdx] = null;
  } else {
    var c = G.cols[fromIdx];
    fromX = colX(fromIdx); fromY = cardY(fromIdx, c.length - 1);
    c.pop();
  }
  G.found[suitOf(card)]++;
  G.moves++;
  sfx(880 + rankOf(card) * 20, 25, 'square');
  var f = getFoundationXY(suitOf(card));
  animateMove([card], [{ x: fromX, y: fromY }], { x: f.x, y: f.y });
  kick();
  updateStatus();
  checkWin();
  return true;
}

function moveToCell(fromZone, fromIdx, cellIdx) {
  var card, fromX, fromY;
  if (G.free[cellIdx] !== null) { errorOnce(); return false; }
  if (fromZone === 'col') {
    var col = G.cols[fromIdx];
    if (!col.length) { return false; }
    card = col[col.length - 1];
    fromX = colX(fromIdx); fromY = cardY(fromIdx, col.length - 1);
    pushHistory();
    col.pop();
  } else if (fromZone === 'cell') {
    if (fromIdx === cellIdx) { return false; }
    card = G.free[fromIdx];
    if (card === null || card === undefined) { return false; }
    fromX = colX(fromIdx); fromY = L.top;
    pushHistory();
    G.free[fromIdx] = null;
  } else { return false; }
  G.free[cellIdx] = card;
  G.moves++;
  sfx(520, 20, 'square');
  animateMove([card], [{ x: fromX, y: fromY }], { x: colX(cellIdx), y: L.top });
  kick(); updateStatus();
  return true;
}

function moveRun(fromCol, k, toCol) {
  if (fromCol === toCol) { return false; }
  var src = G.cols[fromCol], dst = G.cols[toCol];
  if (k < 0 || k >= src.length) { return false; }
  var n = src.length - k;
  if (!isRun(src, k)) { errorOnce(); return false; }
  if (n > maxMove(dst.length === 0)) { errorOnce(); return false; }
  if (dst.length && !canStack(src[k], dst[dst.length - 1])) { errorOnce(); return false; }
  pushHistory();
  var cards = src.slice(k), pts = [], i;
  for (i = 0; i < n; i++) { pts.push({ x: colX(fromCol), y: cardY(fromCol, k + i) }); }
  src.length = k;
  for (i = 0; i < n; i++) { dst.push(cards[i]); }
  G.moves++;
  sfx(n > 1 ? 660 : 600, 22, 'square');
  animateMove(cards, pts, { x: colX(toCol), y: cardY(toCol, dst.length - n) });
  kick(); updateStatus();
  return true;
}

/* the move implied by the current selection landing on `target` */
function attemptSelectionMove(target) {
  var sel = G.sel;
  if (!sel || !target) { return false; }
  if (sel.zone === 'col') {
    if (target.zone === 'col') { return moveRun(sel.idx, sel.card, target.idx); }
    if (target.zone === 'cell') { return moveToCell('col', sel.idx, target.idx); }
    if (target.zone === 'found') {
      if (sel.card !== G.cols[sel.idx].length - 1) { return false; }
      return moveToFoundation('col', sel.idx);
    }
  } else if (sel.zone === 'cell') {
    var card = G.free[sel.idx];
    if (card === null || card === undefined) { return false; }
    if (target.zone === 'col') {
      var col2 = G.cols[target.idx];
      if (col2.length && !canStack(card, col2[col2.length - 1])) { errorOnce(); return false; }
      pushHistory();
      var fromX = colX(sel.idx), fromY = L.top;
      G.free[sel.idx] = null;
      col2.push(card);
      G.moves++;
      sfx(600, 22, 'square');
      animateMove([card], [{ x: fromX, y: fromY }], { x: colX(target.idx), y: cardY(target.idx, col2.length - 1) });
      kick(); updateStatus();
      return true;
    }
    if (target.zone === 'cell') { return moveToCell('cell', sel.idx, target.idx); }
    if (target.zone === 'found') { return moveToFoundation('cell', sel.idx); }
  }
  return false;
}

function selectableAt(h) {
  if (!h) { return null; }
  if (h.zone === 'cell') { return G.free[h.idx] !== null ? { zone: 'cell', idx: h.idx } : null; }
  if (h.zone === 'col' && h.card >= 0) {
    if (isRun(G.cols[h.idx], h.card)) { return { zone: 'col', idx: h.idx, card: h.card }; }
  }
  return null;
}

/* ------------------------------------------------------- auto play safety -- */
function isSafeCard(card) {
  var r = rankOf(card);
  if (r <= 1 || r >= 12) { return true; }
  var o1, o2;
  if (isRedCard(card)) { o1 = 0; o2 = 3; } else { o1 = 1; o2 = 2; }
  return G.found[o1] >= r + 1 && G.found[o2] >= r + 1;
}
function autoPlayStep() {
  if (!G || G.won || dead) { return false; }
  var i, c, col, t;
  for (i = 0; i < 4; i++) {
    c = G.free[i];
    if (c !== null && foundationNeeds(c) && isSafeCard(c)) { return moveToFoundation('cell', i); }
  }
  for (i = 0; i < 8; i++) {
    col = G.cols[i];
    if (col.length) {
      t = col[col.length - 1];
      if (foundationNeeds(t) && isSafeCard(t)) { return moveToFoundation('col', i); }
    }
  }
  return false;
}
function autoPlayAll() {
  if (!G || G.won || dead) { return; }
  if (autoPlayTimer) { win.clearTimeout(autoPlayTimer); autoPlayTimer = null; }
  var guard = 0;
  var step = function () {
    autoPlayTimer = null;
    if (dead || !G || G.won) { return; }
    if (autoPlayStep() && guard++ < 60) { autoPlayTimer = win.setTimeout(step, 80); }
  };
  step();
}

/* --------------------------------------------------------------- win seq -- */
function checkWin() {
  var total = G.found[0] + G.found[1] + G.found[2] + G.found[3];
  if (total >= 52 && !G.won) {
    var el = elapsedSec();
    G.won = true;
    G.elapsed = el;
    anims = [];
    winRun = [];
    var i, j;
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 13; j++) {
        winRun.push({
          card: j * 4 + i,
          x: colX(4 + i) + (13 - j) * 1.5,
          y: L.top - (13 - j) * 1.5,
          vx: -70 - Math.random() * 170,
          vy: -150 - Math.random() * 200
        });
      }
    }
    winRunUntil = nowMs() + 4200;
    winFanfare();
    kick();
    updateStatus();
    win.setTimeout(function () {
      if (dead) { return; }
      beepOnce();
      var s = 'You won game #' + G.num + ' in ' + G.moves + ' moves.\r\n' +
              'Time: ' + fmtTime(G.elapsed) + '     Score: ' + score();
      var p = (W98.dialog && W98.dialog.alert) ? W98.dialog.alert('FreeCell', s, 'info') : null;
      var after = function () {
        if (dead) { return; }
        if (W98.dialog && W98.dialog.confirm) {
          W98.dialog.confirm('FreeCell', 'Deal a new game?').then(function (yes) {
            if (yes && !dead) { newGame(randomGame()); resetClock(); }
          });
        }
      };
      if (p && p.then) { p.then(after); } else { after(); }
    }, 4400);
  }
}
function winFanfare() {
  if (!S.sound) { return; }
  try {
    if (W98.sound && W98.sound.tone) {
      W98.sound.tone(523, 90, 'square');
      W98.sound.tone(659, 90, 'square');
      W98.sound.tone(784, 90, 'square');
      W98.sound.tone(1046, 170, 'square');
    }
  } catch (e) {}
}
function stepWinRun(dt) {
  var i, b, W = canvas.width, H = canvas.height, t = dt / 1000;
  for (i = 0; i < winRun.length; i++) {
    b = winRun[i];
    b.vy += 360 * t;
    b.x += b.vx * t;
    b.y += b.vy * t;
    if (b.x < 1) { b.x = 1; b.vx = Math.abs(b.vx) * 0.82; }
    if (b.x > W - CARD_W - 1) { b.x = W - CARD_W - 1; b.vx = -Math.abs(b.vx) * 0.82; }
    if (b.y < 1) { b.y = 1; b.vy = Math.abs(b.vy) * 0.82; }
    if (b.y > H - CARD_H - 1) {
      b.y = H - CARD_H - 1;
      b.vy = -Math.abs(b.vy) * 0.86;
      b.vx *= 0.99;
    }
  }
  if (nowMs() > winRunUntil) { winRun = null; }
}

/* --------------------------------------------------------------- renderer -- */

function render() {
  if (!ctx || !G) { return; }
  var W = canvas.width, H = canvas.height, i, x, y, k;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = FELT;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = SLOT;
  ctx.lineWidth = 1;
  for (i = 0; i < 8; i++) {
    ctx.strokeRect(colX(i) + 0.5, L.top + 0.5, CARD_W - 1, CARD_H - 1);
  }

  var skip = flyingSet();
  if (drag) {
    for (i = 0; i < drag.cards.length; i++) { skip[drag.cards[i]] = true; }
  }

  /* free cells: one card each, no overlap */
  for (i = 0; i < 4; i++) {
    if (G.free[i] !== null && G.free[i] !== undefined && !skip[G.free[i]]) {
      drawCardFace(ctx, colX(i), L.top, G.free[i]);
    }
  }

  /* foundations: classic 3px vertical overlap between the buried cards */
  for (i = 0; i < 4; i++) {
    var n = G.found[i];
    if (n <= 0) { continue; }
    x = colX(4 + i);
    var layers = Math.min(n, 4);
    for (k = layers; k >= 1; k--) {
      var id = (n - k) * 4 + i;
      if (skip[id]) { continue; }
      drawCardFace(ctx, x + (k - 1) * FOUND_OVERLAP, L.top + (k - 1) * FOUND_OVERLAP, id);
    }
  }

  /* tableau */
  for (i = 0; i < 8; i++) {
    var col = G.cols[i];
    for (k = 0; k < col.length; k++) {
      if (skip[col[k]]) { continue; }
      var selThis = G.sel && G.sel.zone === 'col' && G.sel.idx === i && k >= G.sel.card;
      x = colX(i);
      y = cardY(i, k);
      if (selThis && !drag) { y -= 2; }
      drawCardFace(ctx, x, y, col[k]);
      if (selThis && !drag) {
        ctx.strokeStyle = '#000080';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 1.5, y + 1.5, CARD_W - 3, CARD_H - 3);
      }
    }
  }

  if (G.sel && G.sel.zone === 'cell' && !drag) {
    ctx.strokeStyle = '#000080';
    ctx.lineWidth = 1;
    ctx.strokeRect(colX(G.sel.idx) + 1.5, L.top + 1.5, CARD_W - 3, CARD_H - 3);
  }

  /* cards in flight */
  for (i = 0; i < anims.length; i++) {
    var a = anims[i], p = a.dur ? Math.min(1, a.t / a.dur) : 1, e = easeOut(p), j;
    for (j = 0; j < a.items.length; j++) {
      var it = a.items[j];
      drawCardFace(ctx, it.x0 + (it.x1 - it.x0) * e, it.y0 + (it.y1 - it.y0) * e, it.card);
    }
  }

  /* cards being dragged follow the pointer */
  if (drag) {
    for (i = 0; i < drag.cards.length; i++) {
      drawCardFace(ctx, drag.px - drag.grabDX, drag.py - drag.grabDY + i * L.stack, drag.cards[i]);
    }
  }

  /* the classic bounce */
  if (winRun) {
    for (i = 0; i < winRun.length; i++) {
      drawCardFace(ctx, winRun[i].x, winRun[i].y, winRun[i].card);
    }
  } else if (G.won) {
    ctx.fillStyle = DARK;
    ctx.fillRect(0, (H >> 1) - 20, W, 40);
    ctx.fillStyle = '#ffff00';
    ctx.font = 'bold 28px Tahoma, "MS Sans Serif", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('You Win!', W / 2, H >> 1);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/* ----------------------------------------------------------- status bar --- */

function updateStatus() {
  if (dead || !win || !G) { return; }
  try {
    win.setStatus([
      { text: 'Game #' + G.num, width: 118 },
      { text: 'Moves: ' + G.moves, width: 96 },
      { text: 'Score: ' + score(), width: 106 },
      { text: 'Time: ' + fmtTime(elapsedSec()) }
    ]);
  } catch (e) {}
}

/* -------------------------------------------------------------- prefs I/O -- */
var REG_PATH = 'HKEY_CURRENT_USER\\Software\\FreeCell';
function regGet(name, dflt) {
  try {
    if (W98.reg && W98.reg.get) {
      var v = W98.reg.get(REG_PATH, name, dflt);
      if (v === undefined || v === null) { return dflt; }
      if (dflt === true || dflt === false) {
        if (v === 0 || v === '0' || v === false) { return false; }
        if (v === 1 || v === '1' || v === true) { return true; }
      }
      return v;
    }
  } catch (e) {}
  return dflt;
}
function regSet(name, val) {
  try { if (W98.reg && W98.reg.set) { W98.reg.set(REG_PATH, name, val); } } catch (e) {}
}
function loadPrefs() {
  S.supermove = regGet('Supermove', true) !== false;
  S.animate = regGet('Animate', true) !== false;
  S.sound = regGet('Sound', true) !== false;
  var cb = regGet('CardBack', 'blue');
  S.cardBack = (typeof cb === 'string' && BACK_STYLES[cb]) ? cb : 'blue';
}
function savePrefs() {
  regSet('Supermove', S.supermove ? 1 : 0);
  regSet('Animate', S.animate ? 1 : 0);
  regSet('Sound', S.sound ? 1 : 0);
  regSet('CardBack', S.cardBack);
  if (G) { regSet('LastGame', G.num); }
}
function randomGame() { return 1 + Math.floor(Math.random() * 1000000); }
function iconURL(key) {
  try { if (W98.icons && typeof W98.icons.url === 'function') { return W98.icons.url(key); } } catch (e) {}
  return null;
}

/* --------------------------------------------------------------- chrome --- */

function makeToolIcon(kind) {
  var c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  c.style.imageRendering = 'pixelated';
  c.style.width = '16px';
  c.style.height = '16px';
  var g = c.getContext('2d');
  if (!g) { return c; }
  g.fillStyle = DARK;
  if (kind === 'new') {
    g.fillRect(2, 3, 8, 11);
    g.fillStyle = HI; g.fillRect(3, 4, 6, 9);
    g.fillStyle = RED; g.fillRect(5, 5, 2, 3);
    g.fillStyle = DARK; g.fillRect(8, 8, 7, 7);
    g.fillStyle = HI; g.fillRect(9, 9, 5, 5);
    g.fillStyle = RED; g.fillRect(11, 10, 1, 4); g.fillRect(10, 11, 4, 1);
  } else if (kind === 'undo') {
    g.strokeStyle = DARK; g.lineWidth = 2;
    g.beginPath(); g.arc(8, 9, 5, Math.PI * 0.9, Math.PI * 2.1); g.stroke();
    g.beginPath(); g.moveTo(1, 7); g.lineTo(6, 4); g.lineTo(6, 10); g.closePath(); g.fill();
  } else if (kind === 'auto') {
    g.beginPath(); g.moveTo(8, 13); g.lineTo(2, 5); g.lineTo(14, 5); g.closePath(); g.fill();
    g.fillRect(6, 1, 4, 3);
    g.fillStyle = '#008000'; g.fillRect(3, 7, 10, 2);
  } else if (kind === 'restart') {
    g.strokeStyle = DARK; g.lineWidth = 2;
    g.beginPath(); g.arc(8, 8, 5, 0, Math.PI * 1.6); g.stroke();
    g.beginPath(); g.moveTo(12, 12); g.lineTo(14, 5); g.lineTo(8, 7); g.closePath(); g.fill();
  } else if (kind === 'opts') {
    g.fillRect(2, 3, 12, 2);
    g.fillRect(2, 11, 12, 2);
    g.fillStyle = HI; g.fillRect(4, 1, 4, 6); g.fillRect(9, 9, 4, 6);
    g.strokeStyle = DARK; g.lineWidth = 1;
    g.strokeRect(4.5, 1.5, 3, 5); g.strokeRect(9.5, 9.5, 3, 5);
  }
  return c;
}
function toolButton(parent, kind, label, title, fn) {
  var b = document.createElement('button');
  b.className = 'w98-toolbtn';
  b.type = 'button';
  b.title = title || label;
  b.appendChild(makeToolIcon(kind));
  var sp = document.createElement('span');
  sp.textContent = label;
  b.appendChild(sp);
  b.addEventListener('click', function (e) {
    e.preventDefault();
    try { if (W98.sound && W98.sound.click) { W98.sound.click(); } } catch (err) {}
    fn();
  });
  parent.appendChild(b);
  return b;
}

/* ------------------------------------------------------- options dialog --- */
/* a real 1998 modal dialog box: raised panel, navy title bar, OK / Cancel  */

function buildOptionsDialog() {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:20;' +
    'display:none;align-items:center;justify-content:center';
  var panel = document.createElement('div');
  panel.className = 'w98-raised';
  panel.style.cssText = 'background:#c0c0c0;padding:2px;width:252px';
  var title = document.createElement('div');
  title.style.cssText = 'background:#000080;color:#ffffff;font:bold 11px Tahoma,' +
    '"MS Sans Serif",Arial,sans-serif;padding:3px 4px';
  title.textContent = 'Options';
  panel.appendChild(title);
  var body = document.createElement('div');
  body.style.cssText = 'padding:8px 8px 6px 8px;font:11px Tahoma,"MS Sans Serif",Arial,sans-serif';
  panel.appendChild(body);
  /* Win98 dialogs wear the application icon in the corner */
  var iu = iconURL('freecell');
  if (iu) {
    var ic = document.createElement('img');
    ic.src = iu;
    ic.width = 16;
    ic.height = 16;
    ic.style.cssText = 'float:left;margin:0 6px 0 0;image-rendering:pixelated';
    body.appendChild(ic);
  }

  function check(text, get, set) {
    var l = document.createElement('label');
    l.style.cssText = 'display:block;padding:2px 0';
    var i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!get();
    i.addEventListener('change', function () { set(i.checked); });
    l.appendChild(i);
    var s = document.createElement('span');
    s.textContent = ' ' + text;
    l.appendChild(s);
    body.appendChild(l);
  }
  check('Supermove (move several cards at once)', function () { return S.supermove; },
    function (v) { S.supermove = v; });
  check('Animate card moves', function () { return S.animate; },
    function (v) { S.animate = v; });
  check('Sound', function () { return S.sound; }, function (v) { S.sound = v; });

  var backWrap = document.createElement('div');
  backWrap.style.cssText = 'margin-top:6px;padding:2px 0';
  backWrap.appendChild(document.createTextNode('Card back:'));
  var backs = document.createElement('div');
  backs.style.cssText = 'padding:3px 0 0 12px';
  ['blue', 'red', 'green'].forEach(function (key) {
    var l = document.createElement('label');
    l.style.cssText = 'display:block;padding:1px 0';
    var r = document.createElement('input');
    r.type = 'radio';
    r.name = 'fc_cardback';
    r.checked = (S.cardBack === key);
    r.addEventListener('change', function () { if (r.checked) { S.cardBack = key; } });
    l.appendChild(r);
    var s = document.createElement('span');
    s.textContent = ' ' + key.charAt(0).toUpperCase() + key.slice(1) + ' back';
    l.appendChild(s);
    backs.appendChild(l);
  });
  backWrap.appendChild(backs);
  body.appendChild(backWrap);

  var row = document.createElement('div');
  row.style.cssText = 'text-align:right;padding:8px 4px 2px 4px';
  var ok = document.createElement('button');
  ok.className = 'default';
  ok.textContent = 'OK';
  ok.style.cssText = 'min-width:64px;margin-right:6px';
  var cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'min-width:64px';
  row.appendChild(ok);
  row.appendChild(cancel);
  panel.appendChild(row);
  overlay.appendChild(panel);

  ok.addEventListener('click', function () { closeOptions(true); });
  cancel.addEventListener('click', function () { closeOptions(false); });
  return overlay;
}
function openOptions() {
  if (!optDlg) { return; }
  optSnapshot = { supermove: S.supermove, animate: S.animate, sound: S.sound, cardBack: S.cardBack };
  optDlg.style.display = 'flex';
}
function closeOptions(applied) {
  if (!optDlg) { return; }
  optDlg.style.display = 'none';
  if (!applied && optSnapshot) {
    S.supermove = optSnapshot.supermove;
    S.animate = optSnapshot.animate;
    S.sound = optSnapshot.sound;
    S.cardBack = optSnapshot.cardBack;
  }
  optSnapshot = null;
  savePrefs();
  setMenu();
  render();
}
function optionsOpen() { return !!(optDlg && optDlg.style.display === 'flex'); }

/* ---------------------------------------------------- menus and commands -- */

function resetClock() {
  if (!G) { return; }
  anims = []; winRun = null;
  G.start = nowMs();
  G.elapsed = 0;
  computeLayout(canvas.width, canvas.height);
  render(); updateStatus();
}
function cmdNew() { newGame(randomGame()); resetClock(); }
function cmdRestart() { var n = G.num; newGame(n); resetClock(); }
function cmdSelect() {
  if (dead) { return; }
  var pr = (W98.dialog && W98.dialog.prompt)
    ? W98.dialog.prompt('Select Game', 'Game number (1 - 1000000):', String(G.num))
    : null;
  var go = function (v) {
    if (dead || v === null || v === undefined || v === '') { return; }
    var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    if (!isFinite(n) || n < 1) { errorOnce(); return; }
    if (n > 1000000) { n = 1000000; }
    newGame(n);
    resetClock();
  };
  if (pr && pr.then) { pr.then(go); } else if (typeof pr === 'string') { go(pr); }
}
function cmdAuto() { autoPlayAll(); }
function cmdAbout() {
  if (dead) { return; }
  try { if (W98.aboutDialog && def) { W98.aboutDialog(def); return; } } catch (e) {}
  if (W98.dialog && W98.dialog.alert) {
    W98.dialog.alert('About FreeCell', 'Microsoft FreeCell\r\n' +
      'Windows 98 Web desktop\r\nMicrosoft-compatible deals 1 - 1000000.', 'info');
  }
}
function cmdHelp() {
  if (dead) { return; }
  var msg =
    'Move cards between the eight tableau columns. Any card may be placed on a\n' +
    'card one rank higher and of the opposite colour. Aces build up to Kings on\n' +
    'the foundations. Each free cell holds one card.\n\n' +
    'The number of cards you may move at once is\n' +
    '     (free cells + 1) x 2 ^ (empty columns)\n' +
    'An empty column you are moving into does not count.\n\n' +
    'Double-click a card to send it home. Auto sends every card that is safe to\n' +
    'send. Undo is unlimited. F2 deals a new game, F3 selects a game number.';
  if (W98.dialog && W98.dialog.alert) { W98.dialog.alert('How to Play FreeCell', msg, 'info'); }
}
function setMenu() {
  if (dead || !win) { return; }
  try {
    win.setMenu([
      { label: '&Game', items: [
        { label: '&New Game', accel: 'F2', onclick: cmdNew },
        { label: '&Select Game\u2026', accel: 'F3', onclick: cmdSelect },
        { label: '&Restart Game', onclick: cmdRestart },
        { type: 'sep' },
        { label: '&Undo', accel: 'Ctrl+Z', onclick: doUndo },
        { label: '&Auto-play safe cards', accel: 'Ctrl+A', onclick: cmdAuto },
        { type: 'sep' },
        { label: '&Options\u2026', onclick: openOptions },
        { type: 'sep' },
        { label: 'E&xit', onclick: function () { win.close(); } }
      ]},
      { label: '&Help', items: [
        { label: '&How to Play', accel: 'F1', onclick: cmdHelp },
        { type: 'sep' },
        { label: '&About FreeCell\u2026', onclick: cmdAbout }
      ]}
    ]);
  } catch (e) {}
}

/* ----------------------------------------------------------------- input -- */

function toLocal(ev) {
  var r = canvas.getBoundingClientRect();
  if (!r || !r.width) { return { x: ev.clientX || 0, y: ev.clientY || 0 }; }
  return {
    x: (ev.clientX - r.left) * (canvas.width / r.width),
    y: (ev.clientY - r.top) * (canvas.height / r.height)
  };
}
function isActive() {
  if (!win || !win.el || !focused) { return false; }
  var ae = document.activeElement;
  if (!ae || ae === document.body || ae === win.el) { return true; }
  return win.el.contains(ae);
}
function onMouseDown(ev) {
  if (dead || !G || ev.button !== 0) { return; }
  focused = true;
  if (optionsOpen()) { return; }
  var p = toLocal(ev), h = hitTest(p.x, p.y);
  if (!h || h.zone === 'found') { G.sel = null; render(); return; }
  if (G.sel && attemptSelectionMove(h)) { G.sel = null; pressHandled = true; render(); return; }
  var sel = selectableAt(h);
  if (sel) {
    G.sel = sel;
    if (sel.zone === 'col') {
      drag = {
        zone: 'col', idx: sel.idx, card: sel.card,
        cards: G.cols[sel.idx].slice(sel.card),
        px: p.x, py: p.y,
        grabDX: p.x - colX(sel.idx),
        grabDY: p.y - cardY(sel.idx, sel.card),
        startX: p.x, startY: p.y, moved: false
      };
    } else {
      drag = {
        zone: 'cell', idx: sel.idx, cards: [G.free[sel.idx]],
        px: p.x, py: p.y,
        grabDX: p.x - colX(sel.idx),
        grabDY: p.y - L.top,
        startX: p.x, startY: p.y, moved: false
      };
    }
    render();
    return;
  }
  if (h.zone === 'col') { errorOnce(); }
  G.sel = null;
  render();
}
function onMouseMove(ev) {
  if (dead || !drag) { return; }
  var p = toLocal(ev);
  drag.px = p.x; drag.py = p.y;
  if (Math.abs(p.x - drag.startX) > 3 || Math.abs(p.y - drag.startY) > 3) { drag.moved = true; }
  kick();
  render();
}
function onMouseUp(ev) {
  if (dead || !G) { return; }
  if (pressHandled) { pressHandled = false; return; }
  if (!drag) { return; }
  var d = drag;
  drag = null;
  if (d.moved) {
    var p = toLocal(ev), h = hitTest(p.x, p.y);
    if (h && attemptSelectionMove(h)) { G.sel = null; render(); return; }
    G.sel = d.zone === 'col'
      ? { zone: 'col', idx: d.idx, card: d.card }
      : { zone: 'cell', idx: d.idx };
  }
  render();
}
function onDblClick(ev) {
  if (dead || !G || optionsOpen()) { return; }
  var p = toLocal(ev), h = hitTest(p.x, p.y);
  if (!h) { return; }
  G.sel = null;
  if (h.zone === 'cell') {
    moveToFoundation('cell', h.idx);
  } else if (h.zone === 'col') {
    var col = G.cols[h.idx];
    if (col.length && h.card === col.length - 1) { moveToFoundation('col', h.idx); }
  }
  render();
}
function onKeyDown(ev) {
  if (dead || !G || !ev) { return; }
  if (ev.__fcHandled) { return; }
  if (!isActive()) { return; }
  if (optionsOpen()) {
    if (ev.key === 'Escape') {
      ev.__fcHandled = true;
      ev.preventDefault();
      closeOptions(false);
    }
    return;
  }
  var k = ev.key, handled = true;
  if (k === 'F2') { cmdNew(); }
  else if (k === 'F3') { cmdSelect(); }
  else if (k === 'F1') { cmdHelp(); }
  else if ((ev.ctrlKey || ev.metaKey) && (k === 'z' || k === 'Z')) { doUndo(); }
  else if ((ev.ctrlKey || ev.metaKey) && (k === 'a' || k === 'A')) { cmdAuto(); }
  else if (k === 'Escape') { G.sel = null; render(); }
  else { handled = false; }
  if (handled) {
    ev.__fcHandled = true;
    ev.preventDefault();
  }
}

/* ------------------------------------------------------------ window glue -- */

function layout() {
  if (dead || !canvas) { return; }
  var w = (win && win.width) ? win.width : (win.el.clientWidth || 632);
  var h = (win && win.height) ? win.height : (win.el.clientHeight || 456);
  var cw = Math.max(320, Math.floor(w));
  var ch = Math.max(240, Math.floor(h) - TOOL_H);
  canvas.width = cw;
  canvas.height = ch;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  computeLayout(cw, ch);
  render();
}

function blockMenu(e) { e.preventDefault(); }

function cleanup() {
  if (dead) { return; }
  savePrefs();
  dead = true;
  looping = false;
  if (rafCancel) { try { rafCancel(); } catch (e) {} rafCancel = null; }
  if (statTimer) { try { win.clearInterval(statTimer); } catch (e) {} statTimer = null; }
  if (autoPlayTimer) { try { win.clearTimeout(autoPlayTimer); } catch (e) {} autoPlayTimer = null; }
  try { canvas.removeEventListener('mousedown', onMouseDown); } catch (e) {}
  try { canvas.removeEventListener('dblclick', onDblClick); } catch (e) {}
  try { canvas.removeEventListener('contextmenu', blockMenu); } catch (e) {}
  try { document.removeEventListener('mousemove', onMouseMove, true); } catch (e) {}
  try { document.removeEventListener('mouseup', onMouseUp, true); } catch (e) {}
  try { document.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
  anims = []; winRun = null; G = null;
}

var appDef = {
  id: 'freecell',
  title: 'FreeCell',
  icon: 'freecell',
  width: 632, height: 456,
  minWidth: 632, minHeight: 456,
  resizable: false,
  maximizable: false,
  desktop: true,
  singleton: true,
  startMenuGroup: 'Games',
  create: function (w, args) {
    win = w;
    dead = false; looping = false; focused = true;
    anims = []; drag = null; winRun = null; winRunUntil = 0; pressHandled = false;
    loadPrefs();

    win.el.style.display = 'flex';
    win.el.style.flexDirection = 'column';
    win.el.style.overflow = 'hidden';
    win.el.style.background = FACE;

    var bar = document.createElement('div');
    bar.className = 'w98-toolbar';
    bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;padding:1px 2px;height:' + TOOL_H + 'px';
    win.el.appendChild(bar);

    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.flex = '0 0 auto';
    canvas.width = 632;
    canvas.height = 456 - TOOL_H;
    win.el.appendChild(canvas);
    ctx = canvas.getContext('2d');
    if (!ctx) {
      var msg = document.createElement('div');
      msg.textContent = 'FreeCell requires canvas support.';
      win.el.replaceChild(msg, canvas);
      return {};
    }

    var game = (args && typeof args === 'object' && args.game) ? parseInt(args.game, 10) : 0;
    if (!game || !isFinite(game) || game < 1) { game = parseInt(regGet('LastGame', 0), 10); }
    if (!game || !isFinite(game) || game < 1) { game = randomGame(); }
    if (game > 1000000) { game = 1000000; }
    newGame(game);

    toolButton(bar, 'new', 'New', 'New game (F2)', cmdNew);
    toolButton(bar, 'restart', 'Restart', 'Restart this game', cmdRestart);
    toolButton(bar, 'undo', 'Undo', 'Undo the last move (Ctrl+Z)', doUndo);
    toolButton(bar, 'auto', 'Auto', 'Send every safe card home (Ctrl+A)', cmdAuto);
    toolButton(bar, 'opts', 'Options', 'Options\u2026', openOptions);

    optDlg = buildOptionsDialog();
    win.el.appendChild(optDlg);

    win.setTitle('FreeCell');
    try {
      if (win.setIcon) { win.setIcon('freecell'); }
    } catch (e) {}
    win.claimKeys();
    setMenu();
    updateStatus();
    layout();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', blockMenu);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);

    try { win.on('resize', function () { layout(); }); } catch (e) {}
    try { win.on('close', cleanup); } catch (e) {}
    try { win.on('focus', function () { focused = true; }); } catch (e) {}
    try {
      win.on('blur', function () {
        focused = false;
        if (G) { G.sel = null; }
        render();
      });
    } catch (e) {}

    statTimer = win.setInterval(function () {
      if (dead) { return; }
      updateStatus();
    }, 1000);

    render();
    return {
      onClose: cleanup,
      onResize: function () { layout(); },
      onFocus: function () { focused = true; },
      onBlur: function () { focused = false; },
      onKey: onKeyDown
    };
  }
};

def = appDef;
W98.registerApp(appDef);

})();
