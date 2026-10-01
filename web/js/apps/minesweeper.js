/* ============================================================================
 * Minesweeper  --  web/js/apps/minesweeper.js
 * Microsoft Minesweeper (Windows 98) for the Windows 98 Web desktop.
 * Classic script (no modules). Registers itself through W98.registerApp().
 *
 * Reproduced from the 1998 original (winmine) layout rules:
 *   16x16 tiles, 5px board margin, a status row holding the LED mine counter
 *   (left), the 24x24 face button (centre) and the LED timer (right), then the
 *   minefield inside a 1px raised border.
 *
 *   client = cols*16 + 10  by  rows*16 + 38
 *   beginner        154 x 182   (the exact original client area, from the
 *                                1998 layout: 5px margin, 23px LED well,
 *                                4px gap, 16px tiles, 5px margin)
 *   intermediate    266 x 294
 *   expert          490 x 294
 *
 * Registry: HKEY_CURRENT_USER\Software\Microsoft\Minesweeper
 * Sound: none. The 1998 game is silent and so is this one.
 * ==========================================================================*/
(function () {
'use strict';

if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

/* ------------------------------------------------------------- constants -- */

var TILE   = 16;                 /* one minefield tile                     */
var BM     = 5;                  /* board margin around everything         */
var ROWH   = 24;                 /* status row height (the face button)    */
var ROWGAP = 4;                  /* gap between the status row and the field */
var LED_W  = 12, LED_H = 23;     /* one seven-segment digit                */
var LED_N  = 3;                  /* three digits per display               */
var LED_BOX_W = LED_W * LED_N;       /* black well = 36                    */
var LED_BOX_H = LED_H;               /* 23                                 */
var FACE   = 24;                 /* face button                            */
var BORDER = 1;                  /* raised border drawn around the field   */

var MIN_ROWS = 9, MIN_COLS = 9, MIN_MINES = 10;
var MAX_ROWS = 24, MAX_COLS = 30, MAX_MINES = 668;
var DEF_TIME = 999;              /* "no record" time, as in the original   */

var LEVELS = [
  { key: 'Beginner',     label: 'Beginner',     cols: 9,  rows: 9,  mines: 10 },
  { key: 'Intermediate', label: 'Intermediate', cols: 16, rows: 16, mines: 40 },
  { key: 'Expert',       label: 'Expert',       cols: 30, rows: 16, mines: 99 }
];

var REG = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Minesweeper';

var C = {
  face:   '#c0c0c0',
  hi:     '#ffffff',
  light:  '#dfdfdf',
  shadow: '#808080',
  dark:   '#000000',
  ledBg:  '#000000',
  ledOn:  '#ff0000',
  ledOff: '#3c0000',
  red:    '#ff0000',
  grid:   '#808080'
};

/* the eight number colours, exactly as in 1998 */
var NUMCOL = [null, '#0000ff', '#008000', '#ff0000', '#000080',
              '#800000', '#008080', '#000000', '#808080'];

/* 5x7 bold pixel digits, drawn at 2x inside a 16x16 tile */
var FONT = {
  '1': ['...#.', '..##.', '.#.#.', '#..#.', '...#.', '...#.', '...#.'],
  '2': ['.###.', '#...#', '...#.', '..#..', '.#...', '#....', '#####'],
  '3': ['####.', '....#', '.###.', '....#', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.']
};

/* seven-segment maps for the LED digits */
var SEG = {
  '0': 'abcdef', '1': 'bc',      '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd',  '6': 'afgedc',  '7': 'abc',   '8': 'abcdefg',
  '9': 'abcdfg', '-': 'g',       ' ': ''
};

/* ----------------------------------------------------------------- state -- */

var win = null, canvas = null, ctx = null, def = null;
var dead = false, focused = true;

var cols = 9, rows = 9, mines = 10;
var tier = 0;                       /* 0/1/2 = level, 3 = custom          */
var W = 154, H = 182;               /* client size                        */

var cells = [];                     /* {mine,state,num}                   */
var status = 'waiting';             /* waiting | playing | lost | won     */
var boxesLeft = 0, flags = 0, revealed = 0;
var time = 0, timerId = null, tickAt = 0;
var faceState = 'smile';            /* smile | ooh | dead | cool          */
var boomCol = -1, boomRow = -1;     /* exploded mine                      */

var markQ = false;                  /* Marks (?) menu item, off by default */
var colorMode = true;
var soundOn = false;                /* the original is silent             */
var bestTime = [DEF_TIME, DEF_TIME, DEF_TIME];
var bestName = ['', '', ''];
var lastName = '';

var press = { down: false, left: false, right: false, middle: false,
              chord: false, col: -1, row: -1, faceDown: false, acted: false };

var FIELD_X = 5, FIELD_Y = 36, ROW_Y = 5, FACE_X = 65, FACE_Y = 5,
    LED_L_X = 5, LED_R_X = 111;

/* ------------------------------------------------------------ registry --- */

function regGet(name, dflt) {
  try {
    if (W98.reg && typeof W98.reg.get === 'function') {
      var v = W98.reg.get(REG, name, dflt);
      if (v === undefined || v === null) { return dflt; }
      if (typeof dflt === 'boolean') {
        if (v === true || v === 1 || v === '1' || v === 'true') { return true; }
        if (v === false || v === 0 || v === '0' || v === 'false') { return false; }
      }
      if (typeof dflt === 'number') {
        var n = parseInt(v, 10);
        return isFinite(n) ? n : dflt;
      }
      return v;
    }
  } catch (e) {}
  return dflt;
}

function regSet(name, val) {
  lastSaved[name] = val;
  try { if (W98.reg && typeof W98.reg.set === 'function') { W98.reg.set(REG, name, val); } } catch (e) {}
}

/* ------------------------------------------------------------- geometry -- */

function clientW(c, r) { return c * TILE + BM * 2; }
function clientH(c, r) { return r * TILE + BM * 2 + ROWH + ROWGAP; }

function computeLayout() {
  W = clientW(cols, rows);
  H = clientH(cols, rows);
  ROW_Y = BM;
  LED_L_X = BM;
  LED_R_X = W - BM - LED_BOX_W;
  FACE_X = Math.round((W - FACE) / 2);
  FACE_Y = ROW_Y;
  FIELD_X = BM;
  FIELD_Y = BM + ROWH + ROWGAP;
}

function fieldW() { return cols * TILE; }
function fieldH() { return rows * TILE; }

function cellIndex(c, r) {
  if (c < 0 || r < 0 || c >= cols || r >= rows) { return -1; }
  return r * cols + c;
}
function cellAt(c, r) {
  var i = cellIndex(c, r);
  return i < 0 ? null : cells[i];
}

/* --------------------------------------------------------- canvas setup -- */

function fitCanvas() {
  if (!canvas) { return; }
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
}

function applySize() {
  computeLayout();
  fitCanvas();
  if (win) {
    try { if (win.setClientSize) { win.setClientSize(W, H); } } catch (e) {}
  }
}

/* ------------------------------------------------------------- new game -- */

function clampInt(v, lo, hi, dflt) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) { return dflt; }
  return n < lo ? lo : (n > hi ? hi : n);
}
function clampMines(m) {
  var n = parseInt(m, 10);
  if (!isFinite(n)) { n = MIN_MINES; }
  var hi = Math.min(MAX_MINES, (cols - 1) * (rows - 1));
  if (hi < MIN_MINES) { hi = MIN_MINES; }
  if (n < MIN_MINES) { n = MIN_MINES; }
  if (n > hi) { n = hi; }
  return n;
}

function startGame() {
  var i, n = cols * rows;
  cells = new Array(n);
  for (i = 0; i < n; i++) {
    cells[i] = { mine: false, state: 0, num: 0 };   /* state 0 covered */
  }
  status = 'waiting';
  boxesLeft = n - mines;
  flags = 0;
  revealed = 0;
  time = 0;
  boomCol = -1; boomRow = -1;
  faceState = 'smile';
  stopTimer();
  cancelPress();
}

function stopTimer() {
  if (timerId !== null) {
    try { if (win) { win.clearInterval(timerId); } } catch (e) {}
    timerId = null;
  }
}

function startTimer() {
  stopTimer();
  if (!win || dead) { return; }
  tickAt = now();
  timerId = win.setInterval(function () {
    if (dead || status !== 'playing') { return; }
    var t = now();
    var d = Math.floor((t - tickAt) / 1000);
    if (d !== time) {
      time = d > 999 ? 999 : d;
      render();
    }
  }, 200);
}

function now() {
  try { if (W98 && typeof W98.tick === 'function') { return W98.tick(); } } catch (e) {}
  return Date.now();
}

/* ------------------------------------------------------------- planting -- */

function placeMines(safeC, safeR) {
  var i, c, r, n = cols * rows;
  var safe = {};
  /* the first click is always safe: the clicked cell and, as in the original,
     the opening area around it stay clear of mines */
  for (c = safeC - 1; c <= safeC + 1; c++) {
    for (r = safeR - 1; r <= safeR + 1; r++) {
      var k = cellIndex(c, r);
      if (k >= 0) { safe[k] = true; }
    }
  }
  var pool = [];
  for (i = 0; i < n; i++) { if (!safe[i]) { pool.push(i); } }
  if (pool.length < mines) {                     /* tiny custom boards */
    pool = [];
    for (i = 0; i < n; i++) { if (i !== cellIndex(safeC, safeR)) { pool.push(i); } }
  }
  for (i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  for (i = 0; i < mines && i < pool.length; i++) { cells[pool[i]].mine = true; }

  /* neighbour counts */
  for (c = 0; c < cols; c++) {
    for (r = 0; r < rows; r++) {
      var cell = cellAt(c, r);
      if (!cell || cell.mine) { continue; }
      var cnt = 0;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) { continue; }
          var nb = cellAt(c + dx, r + dy);
          if (nb && nb.mine) { cnt++; }
        }
      }
      cell.num = cnt;
    }
  }
}

/* --------------------------------------------------------------- reveal -- */

function reveal(c, r) {
  var cell = cellAt(c, r);
  if (!cell || cell.state === 1 || cell.state === 2) { return; }
  if (status !== 'playing' && status !== 'waiting') { return; }

  if (status === 'waiting') {
    placeMines(c, r);
    status = 'playing';
    startTimer();
  }
  if (cell.mine) { lose(c, r); return; }

  /* iterative flood fill over zero cells */
  var stack = [[c, r]];
  var guard = 0;
  while (stack.length && guard++ < 100000) {
    var p = stack.pop(), pc = p[0], pr = p[1];
    var cur = cellAt(pc, pr);
    if (!cur || cur.state === 1 || cur.state === 2 || cur.mine) { continue; }
    cur.state = 1;                                  /* revealed */
    revealed++;
    boxesLeft--;
    if (cur.num === 0) {
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) { continue; }
          var nb = cellAt(pc + dx, pr + dy);
          if (nb && nb.state === 0) { stack.push([pc + dx, pr + dy]); }
        }
      }
    }
  }
  checkWin();
}

function chord(c, r) {
  var cell = cellAt(c, r);
  if (!cell || cell.state !== 1 || !cell.num) { return; }
  var fl = 0, dx, dy;
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) { continue; }
      var nb = cellAt(c + dx, r + dy);
      if (nb && nb.state === 2) { fl++; }
    }
  }
  if (fl !== cell.num) { return; }
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) { continue; }
      var n2 = cellAt(c + dx, r + dy);
      if (n2 && (n2.state === 0 || n2.state === 3)) { reveal(c + dx, r + dy); }
      if (status === 'lost') { return; }
    }
  }
}

function toggleFlag(c, r) {
  var cell = cellAt(c, r);
  if (!cell || cell.state === 1) { return; }
  if (status !== 'playing' && status !== 'waiting') { return; }
  if (cell.state === 0) {
    cell.state = 2;                       /* flag */
    flags++;
  } else if (cell.state === 2) {
    if (markQ) { cell.state = 3; }        /* question mark */
    else { cell.state = 0; }
    flags--;
  } else {
    cell.state = 0;
  }
}

/* ------------------------------------------------------------- end game -- */

function checkWin() {
  if (status !== 'playing') { return; }
  if (revealed < cols * rows - mines) { return; }
  status = 'won';
  faceState = 'cool';
  stopTimer();
  /* every remaining mine is flagged automatically */
  for (var c = 0; c < cols; c++) {
    for (var r = 0; r < rows; r++) {
      var cell = cellAt(c, r);
      if (cell && cell.mine && cell.state !== 2) { cell.state = 2; flags++; }
    }
  }
  render();
  bestTimeCheck();
}

function lose(c, r) {
  status = 'lost';
  faceState = 'dead';
  boomCol = c; boomRow = r;
  stopTimer();
  render();
}

function bestTimeCheck() {
  if (tier < 0 || tier > 2) { return; }
  if (time >= bestTime[tier]) { return; }
  var lvl = LEVELS[tier].label;
  var done = function (name) {
    if (dead) { return; }
    if (name === null || name === undefined) { name = lastName; }
    name = String(name).replace(/[\r\n]/g, ' ').slice(0, 30);
    if (name === '') { name = ''; }
    lastName = name;
    bestTime[tier] = time;
    bestName[tier] = name;
    regSet('Time' + (tier + 1), time);
    regSet('Name' + (tier + 1), name);
    showBestTimes();
  };
  var msg = 'You have the fastest time for ' + lvl + ' level.\r\n' +
            'Please enter your name:';
  var dlg = W98.dialog && typeof W98.dialog.prompt === 'function'
    ? W98.dialog.prompt('Minesweeper', msg, lastName || '', { owner: win }) : null;
  if (dlg && typeof dlg.then === 'function') { dlg.then(done); }
  else { done(''); }
}

/* ======================================================================== */
/* drawing                                                                  */
/* ======================================================================== */

function px(x, y, col) { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); }
function box(x, y, w, h, col) {
  if (w <= 0 || h <= 0) { return; }
  ctx.fillStyle = col;
  ctx.fillRect(x, y, w, h);
}

/* raised 1px bevel: white top/left, shadow bottom/right */
function raised1(x, y, w, h) {
  box(x, y, w, 1, C.hi);
  box(x, y, 1, h, C.hi);
  box(x, y + h - 1, w, 1, C.shadow);
  box(x + w - 1, y, 1, h, C.shadow);
}

/* a 16x16 unpressed tile: silver with the classic 3D bevel */
function drawCovered(x, y) {
  box(x, y, TILE, TILE, C.face);
  box(x, y, TILE, 1, C.hi);
  box(x, y, 1, TILE, C.hi);
  box(x, y + TILE - 1, TILE, 1, C.shadow);
  box(x + TILE - 1, y, 1, TILE, C.shadow);
}

/* a pressed/open tile: flat with the 1px grid line */
function drawOpen(x, y) {
  box(x, y, TILE, TILE, C.face);
  box(x, y, TILE, 1, C.grid);
  box(x, y, 1, TILE, C.grid);
}

/* the number, in the bold pixel font, centred */
function drawNumber(x, y, n) {
  var g = FONT[String(n)];
  if (!g) { return; }
  var col = colorMode ? (NUMCOL[n] || C.dark) : C.dark;
  ctx.fillStyle = col;
  var ox = x + Math.floor((TILE - 10) / 2);
  var oy = y + Math.floor((TILE - 14) / 2);
  for (var r = 0; r < g.length; r++) {
    var row = g[r];
    for (var c = 0; c < row.length; c++) {
      if (row.charAt(c) !== '.') { ctx.fillRect(ox + c * 2, oy + r * 2, 2, 2); }
    }
  }
}

function drawFlag(x, y) {
  var tri = colorMode ? C.red : C.dark;
  box(x + 8, y + 3, 2, 9, C.dark);            /* pole                   */
  box(x + 4, y + 12, 9, 2, C.dark);           /* base                   */
  var rowsT = [[3, 7, 8], [4, 6, 8], [5, 5, 8], [6, 4, 8], [7, 3, 8],
               [8, 4, 8], [9, 5, 8], [10, 6, 8], [11, 7, 8]];
  ctx.fillStyle = tri;
  for (var i = 0; i < rowsT.length; i++) {
    var rr = rowsT[i];
    ctx.fillRect(x + rr[1], y + rr[0], rr[2] - rr[1] + 1, 1);
  }
  if (!colorMode) { box(x + 8, y + 6, 1, 4, C.hi); }
}

function drawQuestion(x, y) {
  box(x, y, TILE, TILE, C.face);
  box(x, y, TILE, 1, C.hi);
  box(x, y, 1, TILE, C.hi);
  box(x, y + TILE - 1, TILE, 1, C.shadow);
  box(x + TILE - 1, y, 1, TILE, C.shadow);
  var col = colorMode ? '#000080' : C.dark;
  ctx.fillStyle = col;
  ctx.fillRect(x + 6, y + 4, 5, 2);
  ctx.fillRect(x + 9, y + 6, 2, 2);
  ctx.fillRect(x + 8, y + 8, 2, 2);
  ctx.fillRect(x + 7, y + 10, 2, 2);
  ctx.fillRect(x + 7, y + 13, 2, 2);
}

/* the classic black spiky mine with two white eye highlights */
function drawMine(x, y) {
  var i;
  ctx.fillStyle = C.dark;
  /* eight spikes with little crossbars */
  ctx.fillRect(x + 7, y + 1, 2, 5);  ctx.fillRect(x + 6, y + 1, 4, 1);
  ctx.fillRect(x + 7, y + 10, 2, 5); ctx.fillRect(x + 6, y + 14, 4, 1);
  ctx.fillRect(x + 1, y + 7, 5, 2);  ctx.fillRect(x + 1, y + 6, 1, 4);
  ctx.fillRect(x + 10, y + 7, 5, 2); ctx.fillRect(x + 14, y + 6, 1, 4);
  ctx.fillRect(x + 2, y + 2, 3, 1);  ctx.fillRect(x + 2, y + 2, 1, 3);
  ctx.fillRect(x + 11, y + 2, 3, 1); ctx.fillRect(x + 13, y + 2, 1, 3);
  ctx.fillRect(x + 2, y + 13, 3, 1); ctx.fillRect(x + 2, y + 11, 1, 3);
  ctx.fillRect(x + 11, y + 13, 3, 1); ctx.fillRect(x + 13, y + 11, 1, 3);
  /* ball */
  var rowsBall = [[3, 5, 10], [4, 3, 12], [5, 2, 13], [6, 2, 13], [7, 2, 13],
                  [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 3, 12], [12, 5, 10]];
  for (i = 0; i < rowsBall.length; i++) {
    var rr = rowsBall[i];
    ctx.fillRect(x + rr[1], y + rr[0], rr[2] - rr[1] + 1, 1);
  }
  /* eyes */
  box(x + 4, y + 5, 2, 2, C.hi);
  box(x + 8, y + 5, 2, 2, C.hi);
}

function drawWrongFlag(x, y) {
  drawMine(x, y);
  ctx.fillStyle = C.red;
  var i;
  for (i = 0; i < 5; i++) {
    ctx.fillRect(x + 4 + i, y + 4 + i, 2, 1);
    ctx.fillRect(x + 8 - i, y + 4 + i, 2, 1);
  }
}

/* ------------------------------------------------------------ LED digits -- */

function segOn(x, y, which, col) {
  var t = 3;
  ctx.fillStyle = col;
  switch (which) {
    case 'a': ctx.fillRect(x + 2, y + 0, 8, t);
              ctx.fillRect(x + 1, y + 1, 1, 1); ctx.fillRect(x + 10, y + 1, 1, 1); break;
    case 'g': ctx.fillRect(x + 2, y + 10, 8, t);
              ctx.fillRect(x + 1, y + 11, 1, 1); ctx.fillRect(x + 10, y + 11, 1, 1); break;
    case 'd': ctx.fillRect(x + 2, y + 20, 8, t);
              ctx.fillRect(x + 1, y + 21, 1, 1); ctx.fillRect(x + 10, y + 21, 1, 1); break;
    case 'f': ctx.fillRect(x + 0, y + 2, t, 8);
              ctx.fillRect(x + 1, y + 1, 1, 1); ctx.fillRect(x + 1, y + 10, 1, 1); break;
    case 'b': ctx.fillRect(x + 9, y + 2, t, 8);
              ctx.fillRect(x + 9, y + 1, 1, 1); ctx.fillRect(x + 9, y + 10, 1, 1); break;
    case 'e': ctx.fillRect(x + 0, y + 13, t, 8);
              ctx.fillRect(x + 1, y + 12, 1, 1); ctx.fillRect(x + 1, y + 20, 1, 1); break;
    case 'c': ctx.fillRect(x + 9, y + 13, t, 8);
              ctx.fillRect(x + 9, y + 12, 1, 1); ctx.fillRect(x + 9, y + 20, 1, 1); break;
  }
}

function drawLedDigit(x, y, ch) {
  var on = SEG[ch] || '';
  var i, all = 'abcdefg';
  for (i = 0; i < all.length; i++) {
    var s = all.charAt(i);
    segOn(x, y, s, on.indexOf(s) >= 0 ? C.ledOn : C.ledOff);
  }
}

/* number -> three LED characters */
function ledChars(n) {
  if (n < 0) {
    n = -n;
    if (n > 99) { n = 99; }
    return ['-', String(Math.floor(n / 10)), String(n % 10)];
  }
  if (n > 999) { n = 999; }
  return [String(Math.floor(n / 100) % 10),
          String(Math.floor(n / 10) % 10),
          String(n % 10)];
}

function drawLedBox(x, y, n) {
  box(x, y, LED_BOX_W, LED_BOX_H, C.ledBg);
  var s = ledChars(n);
  for (var i = 0; i < LED_N; i++) {
    drawLedDigit(x + i * LED_W, y, s[i]);
  }
}

/* ------------------------------------------------------------ face button -- */

function circleRuns(R) {
  var runs = [], dy, w;
  for (dy = -R; dy <= R; dy++) {
    w = Math.floor(Math.sqrt(R * R - dy * dy + 0.25) + 0.35);
    runs.push([dy, -w, w]);
  }
  return runs;
}
var CIRC9 = circleRuns(9), CIRC8 = circleRuns(8);

function faceCircle(cx, cy, runs, col) {
  ctx.fillStyle = col;
  for (var i = 0; i < runs.length; i++) {
    var rr = runs[i];
    ctx.fillRect(cx + rr[1], cy + rr[0], rr[2] - rr[1] + 1, 1);
  }
}
function fpx(cx, cy, x, y, w, h, col) {
  ctx.fillStyle = col;
  ctx.fillRect(cx + x, cy + y, w, h);
}

function drawFaceContent(cx, cy, state) {
  faceCircle(cx, cy, CIRC9, C.dark);
  faceCircle(cx, cy, CIRC8, '#ffff00');
  var i;
  if (state === 'dead') {
    /* X eyes */
    for (i = 0; i < 5; i++) {
      fpx(cx, cy, -6 + i, -6 + i, 1, 1, C.dark);
      fpx(cx, cy, -2 - i, -6 + i, 1, 1, C.dark);
      fpx(cx, cy, 2 + i, -6 + i, 1, 1, C.dark);
      fpx(cx, cy, 6 - i, -6 + i, 1, 1, C.dark);
    }
    fpx(cx, cy, -2, 4, 5, 1, C.dark);      /* frown */
    fpx(cx, cy, -4, 3, 2, 1, C.dark);
    fpx(cx, cy, 3, 3, 2, 1, C.dark);
    fpx(cx, cy, -5, 2, 1, 1, C.dark);
    fpx(cx, cy, 5, 2, 1, 1, C.dark);
    return;
  }
  if (state === 'cool') {
    /* sunglasses */
    fpx(cx, cy, -6, -5, 13, 1, C.dark);
    fpx(cx, cy, -6, -4, 5, 4, C.dark);
    fpx(cx, cy, 2, -4, 5, 4, C.dark);
    fpx(cx, cy, -1, -4, 2, 1, C.dark);
    fpx(cx, cy, -3, 4, 7, 1, C.dark);      /* smile */
    fpx(cx, cy, -5, 3, 2, 1, C.dark);
    fpx(cx, cy, 4, 3, 2, 1, C.dark);
    fpx(cx, cy, 6, 2, 1, 1, C.dark);
    fpx(cx, cy, -6, 2, 1, 1, C.dark);
    return;
  }
  if (state === 'ooh') {
    /* round eyes and a little round mouth */
    fpx(cx, cy, -5, -5, 3, 3, C.dark); fpx(cx, cy, -4, -4, 1, 1, '#ffff00');
    fpx(cx, cy, 3, -5, 3, 3, C.dark);  fpx(cx, cy, 4, -4, 1, 1, '#ffff00');
    fpx(cx, cy, -1, 2, 3, 3, C.dark);  fpx(cx, cy, 0, 3, 1, 1, C.dark);
    return;
  }
  /* smile */
  fpx(cx, cy, -5, -4, 2, 3, C.dark);
  fpx(cx, cy, 4, -4, 2, 3, C.dark);
  fpx(cx, cy, -2, 4, 5, 1, C.dark);
  fpx(cx, cy, -4, 3, 2, 1, C.dark);
  fpx(cx, cy, 3, 3, 2, 1, C.dark);
  fpx(cx, cy, -5, 2, 1, 1, C.dark);
  fpx(cx, cy, 5, 2, 1, 1, C.dark);
}

function drawFaceButton() {
  var x = FACE_X, y = FACE_Y, down = press.faceDown;
  box(x, y, FACE, FACE, C.face);
  if (down) {
    box(x, y, FACE, 1, C.shadow);
    box(x, y, 1, FACE, C.shadow);
    box(x, y + FACE - 1, FACE, 1, C.hi);
    box(x + FACE - 1, y, 1, FACE, C.hi);
  } else {
    box(x, y, FACE, 1, C.hi);
    box(x, y, 1, FACE, C.hi);
    box(x + 1, y + 1, FACE - 1, 1, C.light);
    box(x + 1, y + 1, 1, FACE - 1, C.light);
    box(x, y + FACE - 1, FACE, 1, C.dark);
    box(x + FACE - 1, y, 1, FACE, C.dark);
    box(x, y + FACE - 2, FACE, 1, C.shadow);
    box(x + FACE - 2, y, 1, FACE, C.shadow);
  }
  var state = faceState;
  if (press.down && status !== 'lost' && status !== 'won') { state = 'ooh'; }
  drawFaceContent(x + (down ? 13 : 12), y + (down ? 13 : 12), state);
}

/* --------------------------------------------------------------- render --- */

function drawField() {
  var c, r, cell, x, y;
  for (r = 0; r < rows; r++) {
    for (c = 0; c < cols; c++) {
      cell = cells[r * cols + c];
      x = FIELD_X + c * TILE;
      y = FIELD_Y + r * TILE;
      if (!cell) { drawCovered(x, y); continue; }
      if (cell.state === 1) {
        drawOpen(x, y);
        if (cell.num > 0) { drawNumber(x, y, cell.num); }
        if (status === 'lost' && cell.mine && c === boomCol && r === boomRow) {
          box(x, y, TILE, TILE, C.red);
          drawMine(x, y);
        }
        continue;
      }
      if (status === 'lost' && cell.mine) {
        if (cell.state === 2) { drawCovered(x, y); drawFlag(x, y); }
        else if (c === boomCol && r === boomRow) {
          box(x, y, TILE, TILE, C.red);
          drawMine(x, y);
        } else { drawOpen(x, y); drawMine(x, y); }
        continue;
      }
      if (status === 'lost' && !cell.mine && cell.state === 2) {
        drawOpen(x, y);
        drawWrongFlag(x, y);
        continue;
      }
      /* covered */
      if (cell.state === 0 || cell.state === 3) {
        if (press.down && isPressedCell(c, r)) { drawOpen(x, y); }
        else { drawCovered(x, y); }
        if (cell.state === 3) { drawQuestion(x, y); }
      } else {
        drawCovered(x, y);
        drawFlag(x, y);
      }
    }
  }
}

/* which cells look pressed right now */
function isPressedCell(c, r) {
  if (!press.down) { return false; }
  if (press.chord) {
    return Math.abs(c - press.col) <= 1 && Math.abs(r - press.row) <= 1;
  }
  return c === press.col && r === press.row;
}

function render() {
  if (!ctx || dead) { return; }
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    box(0, 0, W, H, C.face);
    drawLedBox(LED_L_X, ROW_Y, mines - flags);
    drawLedBox(LED_R_X, ROW_Y, time);
    drawFaceButton();
    raised1(FIELD_X - 1, FIELD_Y - 1, fieldW() + 2, fieldH() + 2);
    drawField();
  } catch (e) {}
}

/* ======================================================================== */
/* input                                                                    */
/* ======================================================================== */

function cellFromPoint(x, y) {
  var c = Math.floor((x - FIELD_X) / TILE);
  var r = Math.floor((y - FIELD_Y) / TILE);
  if (c < 0 || r < 0 || c >= cols || r >= rows) { return null; }
  return { col: c, row: r };
}

function toLocal(ev) {
  var r = canvas.getBoundingClientRect();
  var sx = r.width ? canvas.width / r.width : 1;
  var sy = r.height ? canvas.height / r.height : 1;
  return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
}

function inFace(x, y) {
  return x >= FACE_X && x < FACE_X + FACE && y >= FACE_Y && y < FACE_Y + FACE;
}

function gameOver() { return status === 'lost' || status === 'won'; }

function updatePressCell(x, y) {
  var p = cellFromPoint(x, y);
  if (!p) { press.col = -1; press.row = -1; return; }
  press.col = p.col; press.row = p.row;
}

function cancelPress() {
  press.down = false;
  press.left = false;
  press.right = false;
  press.middle = false;
  press.chord = false;
  press.faceDown = false;
  press.acted = false;
  press.col = -1;
  press.row = -1;
}

function onMouseDown(ev) {
  if (dead || !canvas) { return; }
  try {
    var p = toLocal(ev);
    var b = ev.button;
    if (b !== 0 && b !== 1 && b !== 2) { return; }
    if (!press.down) { press.acted = false; }
    if (b === 0) { press.left = true; }
    else if (b === 1) { press.middle = true; }
    else { press.right = true; }

    if (inFace(p.x, p.y)) {
      press.faceDown = (b === 0);
      press.down = true;
      render();
      return;
    }
    press.down = true;
    press.faceDown = false;

    if (b === 2 && !press.left && !press.middle) {
      /* the only button down is the right one: cycle the flag right away */
      var q = cellFromPoint(p.x, p.y);
      if (q && !gameOver()) { toggleFlag(q.col, q.row); }
    }
    press.chord = !!(press.middle || (press.left && press.right));
    updatePressCell(p.x, p.y);
    render();
  } catch (e) {}
}

function onMouseMove(ev) {
  if (dead || !canvas) { return; }
  try {
    if (!press.down) { return; }
    var p = toLocal(ev);
    if (inFace(p.x, p.y)) {
      press.col = -1; press.row = -1;
    } else {
      updatePressCell(p.x, p.y);
    }
    render();
  } catch (e) {}
}

function onMouseUp(ev) {
  if (dead || !canvas) { return; }
  try {
    var b = ev.button;
    if (b !== 0 && b !== 1 && b !== 2) { return; }
    var wasChord = press.chord;
    if (b === 0) { press.left = false; }
    else if (b === 1) { press.middle = false; }
    else { press.right = false; }

    var p = toLocal(ev);
    var faceHit = inFace(p.x, p.y);
    var anyDown = press.left || press.right || press.middle;

    if (press.faceDown) {
      press.down = anyDown;
      press.faceDown = false;
      if (b === 0 && faceHit) { newGame(false); return; }
      render();
      return;
    }

    if (!press.acted) {
      if (wasChord && (b === 0 || b === 1 || b === 2)) {
        /* both buttons (or the middle button): clear around the number */
        var q = faceHit ? null : cellFromPoint(p.x, p.y);
        press.acted = true;
        if (q && !gameOver()) { chord(q.col, q.row); }
      } else if (b === 0 && !anyDown) {
        var q2 = faceHit ? null : cellFromPoint(p.x, p.y);
        press.acted = true;
        if (q2 && !gameOver()) { reveal(q2.col, q2.row); }
      }
    }

    press.down = anyDown;
    if (anyDown) {
      press.chord = !!(press.middle || (press.left && press.right));
      if (!faceHit) { updatePressCell(p.x, p.y); }
    } else {
      press.chord = false;
      press.acted = false;
      press.col = -1; press.row = -1;
    }
    render();
  } catch (e) {}
}

function blockMenu(ev) {
  try { ev.preventDefault(); } catch (e) {}
}

function onKey(ev) {
  if (dead || !ev) { return; }
  if (!isActive()) { return; }
  var k = ev.key;
  if (k === 'F2') { ev.preventDefault(); newGame(false); }
  else if (k === 'F1') { ev.preventDefault(); cmdHelp(); }
}

function isActive() {
  if (!win || !win.el || !focused) { return false; }
  var ae = document.activeElement;
  if (!ae || ae === document.body || ae === win.el) { return true; }
  return win.el.contains(ae);
}

/* ======================================================================== */
/* commands / dialogs                                                       */
/* ======================================================================== */

function newGame(quiet) {
  startGame();
  applySize();
  render();
  void quiet;
}

function setLevel(i) {
  if (i < 0 || i > 2) { return; }
  tier = i;
  regSet('Difficulty', i);
  var L = LEVELS[i];
  cols = L.cols; rows = L.rows; mines = L.mines;
  regSet('Height', rows); regSet('Width', cols); regSet('Mines', mines);
  startGame();
  applySize();
  render();
  setMenu();
}

function setCustom(c, r, m) {
  tier = 3;
  cols = clampInt(c, MIN_COLS, MAX_COLS, 9);
  rows = clampInt(r, MIN_ROWS, MAX_ROWS, 9);
  mines = clampMines(m);
  regSet('Difficulty', 3);
  regSet('Height', rows); regSet('Width', cols); regSet('Mines', mines);
  startGame();
  applySize();
  render();
  setMenu();
}

/* --------------------------------------------------------- custom field -- */

function cmdCustom() {
  if (dead) { return; }
  var dlg = null;
  try { dlg = W98.dialog.custom({ title: 'Custom Field', width: 260, height: 176, owner: win }); }
  catch (e) { dlg = null; }
  if (!dlg) { return; }
  var box = dlg.box;
  var form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  function row(label, val, lo, hi) {
    var line = document.createElement('div');
    line.style.cssText = 'display:flex;align-items:center;gap:8px;';
    var lab = document.createElement('label');
    lab.textContent = label;
    lab.style.cssText = 'flex:0 0 64px;text-align:right;';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = val;
    inp.style.cssText = 'flex:0 0 70px;';
    var hint = document.createElement('span');
    hint.textContent = '(' + lo + '\u2013' + hi + ')';
    hint.style.cssText = 'color:#808080;';
    line.appendChild(lab); line.appendChild(inp); line.appendChild(hint);
    form.appendChild(line);
    return inp;
  }
  var inH = row('Height:', rows, MIN_ROWS, MAX_ROWS);
  var inW = row('Width:', cols, MIN_COLS, MAX_COLS);
  var inM = row('Mines:', mines, MIN_MINES, MAX_MINES);
  box.appendChild(form);

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:16px;';
  var ok = document.createElement('button');
  ok.textContent = 'OK'; ok.className = 'default'; ok.style.minWidth = '75px';
  var cancel = document.createElement('button');
  cancel.textContent = 'Cancel'; cancel.style.minWidth = '75px';
  btns.appendChild(ok); btns.appendChild(cancel);
  box.appendChild(btns);

  function close() { try { dlg.close(); } catch (e) {} }
  function accept() {
    var h = clampInt(inH.value, MIN_ROWS, MAX_ROWS, rows);
    var w = clampInt(inW.value, MIN_COLS, MAX_COLS, cols);
    var m = clampInt(inM.value, MIN_MINES, MAX_MINES, mines);
    close();
    setCustom(w, h, m);
  }
  ok.onclick = accept;
  cancel.onclick = close;
  try {
    dlg.el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); accept(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  } catch (e) {}
  try { inH.focus(); inH.select(); } catch (e) {}
}

/* ----------------------------------------------------------- best times -- */

function showBestTimes() {
  if (dead) { return; }
  var dlg = null;
  try { dlg = W98.dialog.custom({ title: 'Fastest Mine Sweepers', width: 320, height: 168, owner: win }); }
  catch (e) { dlg = null; }
  if (!dlg) {
    if (W98.dialog && W98.dialog.alert) {
      W98.dialog.alert('Fastest Mine Sweepers',
        LEVELS[0].label + ': ' + bestTime[0] + ' seconds ' + dispName(0) + '\n' +
        LEVELS[1].label + ': ' + bestTime[1] + ' seconds ' + dispName(1) + '\n' +
        LEVELS[2].label + ': ' + bestTime[2] + ' seconds ' + dispName(2), 'info');
    }
    return;
  }
  var box = dlg.box;
  var table = document.createElement('div');
  table.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  var labelEls = [];
  for (var i = 0; i < 3; i++) {
    var line = document.createElement('div');
    line.style.cssText = 'display:flex;gap:8px;';
    var a = document.createElement('span');
    a.textContent = LEVELS[i].label + ':';
    a.style.cssText = 'flex:0 0 92px;text-align:right;';
    var b = document.createElement('span');
    b.style.cssText = 'flex:0 0 92px;';
    var c = document.createElement('span');
    line.appendChild(a); line.appendChild(b); line.appendChild(c);
    table.appendChild(line);
    labelEls.push({ time: b, name: c });
  }
  box.appendChild(table);
  function refresh() {
    for (var i = 0; i < 3; i++) {
      labelEls[i].time.textContent = bestTime[i] + ' seconds';
      labelEls[i].name.textContent = dispName(i);
    }
  }
  refresh();

  var hr = document.createElement('div');
  hr.className = 'w98-hr';
  hr.style.margin = '10px 0 0';
  box.appendChild(hr);

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  var reset = document.createElement('button');
  reset.textContent = 'Reset Scores'; reset.style.minWidth = '90px';
  var ok = document.createElement('button');
  ok.textContent = 'OK'; ok.className = 'default'; ok.style.minWidth = '75px';
  btns.appendChild(reset); btns.appendChild(ok);
  box.appendChild(btns);

  reset.onclick = function () {
    for (var i = 0; i < 3; i++) {
      bestTime[i] = DEF_TIME; bestName[i] = '';
      regSet('Time' + (i + 1), DEF_TIME);
      regSet('Name' + (i + 1), '');
    }
    refresh();
  };
  ok.onclick = function () { try { dlg.close(); } catch (e) {} };
  try {
    dlg.el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); try { dlg.close(); } catch (x) {} }
    });
  } catch (e) {}
}

function dispName(i) { return bestName[i] ? bestName[i] : 'Anonymous'; }

/* ----------------------------------------------------------------- help -- */

function infoDialog(title, text) {
  if (dead) { return; }
  if (W98.dialog && typeof W98.dialog.alert === 'function') {
    W98.dialog.alert(title, text, 'info');
  }
}

function cmdHelp() {
  infoDialog('Minesweeper Help',
    'The object of Minesweeper is to locate all the mines as quickly as\n' +
    'possible without uncovering one. To uncover a square, click it with\n' +
    'the left mouse button.\n\n' +
    'To mark a square you suspect contains a mine, right-click it. The\n' +
    'counter on the left shows the number of mines remaining.\n\n' +
    'To clear squares around a number, point at the number and press both\n' +
    'mouse buttons (or the middle button). The squares are uncovered if\n' +
    'the number of flags around the number matches it.\n\n' +
    'The timer on the right starts with your first click. It stops when\n' +
    'you win or lose. The smiley button starts a new game.');
}

function cmdSearchHelp() {
  infoDialog('Search for Help on...',
    'Type the first few letters of a word in the Help index, or choose a\n' +
    'topic from the list.\n\n' +
    'Minesweeper: how to play, the face button, flags, question marks,\n' +
    'best times, custom fields.');
}

function cmdUsingHelp() {
  infoDialog('Using Help',
    'To get help about Minesweeper, choose Contents from the Help menu,\n' +
    'or press F1.\n\n' +
    'For information about using Help itself, look at the Help topics in\n' +
    'the Windows Help system.');
}

function cmdAbout() {
  if (dead) { return; }
  if (W98.aboutDialog) { W98.aboutDialog(def); return; }
  infoDialog('About Minesweeper', 'Microsoft Minesweeper\nWindows 98 Web desktop');
}

function cmdExit() { if (win) { try { win.close(); } catch (e) {} } }

/* ======================================================================== */
/* menu                                                                     */
/* ======================================================================== */

function setMenu() {
  if (dead || !win) { return; }
  try {
    win.setMenu([
      { label: '&Game', items: [
        { label: '&New', accel: 'F2', onclick: function () { newGame(false); } },
        { type: 'sep' },
        { label: '&Beginner', type: 'radio', checked: tier === 0,
          onclick: function () { setLevel(0); } },
        { label: '&Intermediate', type: 'radio', checked: tier === 1,
          onclick: function () { setLevel(1); } },
        { label: '&Expert', type: 'radio', checked: tier === 2,
          onclick: function () { setLevel(2); } },
        { label: '&Custom\u2026', type: 'radio', checked: tier === 3,
          onclick: cmdCustom },
        { type: 'sep' },
        { label: '&Marks (?)', type: 'check', checked: markQ,
          onclick: function () {
            markQ = !markQ; regSet('Mark', markQ ? 1 : 0); setMenu(); render();
          } },
        { label: '&Color', type: 'check', checked: colorMode,
          onclick: function () {
            colorMode = !colorMode; regSet('Color', colorMode ? 1 : 0); setMenu(); render();
          } },
        { label: '&Sound', type: 'check', checked: soundOn,
          onclick: function () {
            soundOn = !soundOn; regSet('Sound', soundOn ? 1 : 0); setMenu();
          } },
        { type: 'sep' },
        { label: 'Best &Times\u2026', onclick: showBestTimes },
        { type: 'sep' },
        { label: 'E&xit', onclick: cmdExit }
      ]},
      { label: '&Help', items: [
        { label: '&Contents', accel: 'F1', onclick: cmdHelp },
        { label: '&Search for Help on\u2026', onclick: cmdSearchHelp },
        { label: '&Using Help', onclick: cmdUsingHelp },
        { type: 'sep' },
        { label: '&About Minesweeper\u2026', onclick: cmdAbout }
      ]}
    ]);
  } catch (e) {}
}

/* ======================================================================== */
/* lifecycle                                                                */
/* ======================================================================== */

function cleanup() {
  if (dead) { return; }
  dead = true;
  stopTimer();
  try { document.removeEventListener('mouseup', docUp); } catch (e) {}
  try { if (canvas) {
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('contextmenu', blockMenu);
  } } catch (e) {}
  try { if (win && win.el) { win.el.removeEventListener('keydown', onKey); } } catch (e) {}
  try { saveSettings(); } catch (e) {}
  cancelPress();
  cells = [];
}

function docUp(ev) {
  if (dead) { return; }
  if (!canvas) { return; }
  try { onMouseUp(ev); } catch (e) {}
}

function loadSettings() {
  markQ = !!regGet('Mark', false);
  colorMode = !!regGet('Color', true);
  soundOn = !!regGet('Sound', false);
  for (var i = 0; i < 3; i++) {
    bestTime[i] = clampInt(regGet('Time' + (i + 1), DEF_TIME), 0, DEF_TIME, DEF_TIME);
    var nm = regGet('Name' + (i + 1), '');
    bestName[i] = (typeof nm === 'string') ? nm.slice(0, 30) : '';
  }
  var d = clampInt(regGet('Difficulty', 0), 0, 3, 0);
  if (d === 0 || d === 1 || d === 2) {
    tier = d;
    cols = LEVELS[d].cols; rows = LEVELS[d].rows; mines = LEVELS[d].mines;
  } else {
    tier = 3;
    cols = clampInt(regGet('Width', 9), MIN_COLS, MAX_COLS, 9);
    rows = clampInt(regGet('Height', 9), MIN_ROWS, MAX_ROWS, 9);
    mines = clampMines(regGet('Mines', 10));
  }
}

var lastSaved = {};

function saveSettings() {
  /* only values that actually changed are written, so a close never hammers
     the kernel registry */
  var want = {
    Mark: markQ ? 1 : 0,
    Color: colorMode ? 1 : 0,
    Sound: soundOn ? 1 : 0,
    Difficulty: tier,
    Height: rows,
    Width: cols,
    Mines: mines
  };
  for (var i = 0; i < 3; i++) {
    want['Time' + (i + 1)] = bestTime[i];
    want['Name' + (i + 1)] = bestName[i];
  }
  for (var k in want) {
    if (Object.prototype.hasOwnProperty.call(want, k) && lastSaved[k] !== want[k]) {
      regSet(k, want[k]);
      lastSaved[k] = want[k];
    }
  }
}

function rememberSaved() {
  lastSaved = {
    Mark: markQ ? 1 : 0, Color: colorMode ? 1 : 0, Sound: soundOn ? 1 : 0,
    Difficulty: tier, Height: rows, Width: cols, Mines: mines,
    Name1: bestName[0], Name2: bestName[1], Name3: bestName[2],
    Time1: bestTime[0], Time2: bestTime[1], Time3: bestTime[2]
  };
}

var appDef = {
  id: 'minesweeper',
  title: 'Minesweeper',
  icon: 'minesweeper',
  width: 154, height: 182,
  minWidth: 154, minHeight: 182,
  resizable: false,
  maximizable: false,
  desktop: true,
  startMenuGroup: 'Games',
  singleton: true,
  create: function (w, args) {
    win = w;
    dead = false;
    focused = true;

    loadSettings();
    rememberSaved();
    computeLayout();

    win.el.style.display = 'block';
    win.el.style.overflow = 'hidden';
    win.el.style.background = C.face;
    win.el.style.padding = '0';
    win.el.style.font = '11px Tahoma, "MS Sans Serif", Arial, sans-serif';

    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.cursor = 'default';
    win.el.appendChild(canvas);
    ctx = canvas.getContext ? canvas.getContext('2d') : null;

    if (!ctx) {
      var msg = document.createElement('div');
      msg.textContent = 'Minesweeper requires canvas support.';
      msg.style.padding = '8px';
      win.el.replaceChild(msg, canvas);
      return {};
    }

    try { win.setTitle('Minesweeper'); } catch (e) {}
    try { if (win.setIcon) { win.setIcon('minesweeper'); } } catch (e) {}
    /* the window icon, as published by the shell icon renderer */
    try {
      if (W98.icons && typeof W98.icons.url === 'function') { W98.icons.url('minesweeper'); }
    } catch (e) {}

    applySize();
    fitCanvas();
    startGame();
    setMenu();
    render();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('contextmenu', blockMenu);
    document.addEventListener('mouseup', docUp);
    win.el.addEventListener('keydown', onKey);

    try { win.on('close', cleanup); } catch (e) {}
    try {
      win.on('blur', function () {
        focused = false;
        if (press.down) { cancelPress(); render(); }
      });
    } catch (e) {}
    try { win.on('focus', function () { focused = true; }); } catch (e) {}
    try {
      win.on('resize', function (nw, nh) {
        if (dead) { return; }
        W = Math.round(nw); H = Math.round(nh);
        fitCanvas();
        render();
      });
    } catch (e) {}

    return {
      onClose: cleanup,
      onResize: function (nw, nh) {
        if (dead) { return; }
        W = Math.round(nw); H = Math.round(nh);
        fitCanvas(); render();
      },
      onFocus: function () { focused = true; },
      onBlur: function () { focused = false; if (press.down) { cancelPress(); render(); } },
      onKey: onKey
    };
  }
};

def = appDef;
W98.registerApp(appDef);

})();
