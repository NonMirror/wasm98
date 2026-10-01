/* ============================================================================
 * JezzBall  --  web/js/apps/jezzball.js
 * Microsoft JezzBall (1992 Entertainment Pack) for the Windows 98 Web desktop.
 * Classic script (no modules). Registers itself through W98.registerApp().
 *
 * Fidelity notes (1998 client):
 *   client area   592 x 472, fixed (not resizable, not maximizable)
 *   room          35 x 25 cells of 16px = 560 x 400, black 1px border
 *   palette       blue room, dark blue-grey captured areas, red-and-white
 *                 atoms, red wall while growing, white wall once locked
 *   panel         Level / Lives (life icons) / % Cleared / Score
 *   physics       fixed 120Hz timestep decoupled from rendering, substepped
 *                 so fast balls never tunnel through a 3px wall
 * ==========================================================================*/
(function () {
'use strict';

if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

/* ------------------------------------------------------------- constants -- */

var CELL = 16, COLS = 35, ROWS = 25;
var RW = COLS * CELL, RH = ROWS * CELL;          /* room 560 x 400            */
var BALL_R = 5, WALL_HALF = 1.5;
var GOAL = 0.75;                                  /* 75% captured clears      */
var CELL_MS = 22;                                 /* wall growth: 1 cell/22ms */
var STEP_MS = 1000 / 120;                         /* fixed physics timestep   */
var TOTAL_CELLS = COLS * ROWS;
var PANEL_H = 26, GAP = 12;

var C = {
  face: '#c0c0c0', hi: '#ffffff', shadow: '#808080', dark: '#000000',
  room: '#0000a8', captured: '#202838', capEdge: '#6a7a9a',
  wall: '#ffffff', grow: '#e00000', tip: '#ff8080',
  ball: '#d00000', ballHi: '#ffffff', ballRim: '#500000',
  text: '#000000', warn: '#ffff00'
};

/* --------------------------------------------------------------- helpers -- */

function nowMs() {
  try {
    if (W98 && typeof W98.tick === 'function') {
      var t = W98.tick();
      if (typeof t === 'number' && isFinite(t)) { return t; }
    }
  } catch (e) {}
  return Date.now();
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/* ----------------------------------------------------------- reg storage -- */
var REG_PATH = 'HKEY_CURRENT_USER\\Software\\JezzBall';
var S = { sound: true };
function regGet(name, dflt) {
  try {
    if (W98.reg && W98.reg.get) {
      var v = W98.reg.get(REG_PATH, name, dflt);
      if (v === undefined || v === null) { return dflt; }
      if ((v === 0 || v === '0') && (dflt === true || dflt === false)) { return false; }
      if ((v === 1 || v === '1') && (dflt === true || dflt === false)) { return true; }
      return v;
    }
  } catch (e) {}
  return dflt;
}
function regSet(name, val) {
  try { if (W98.reg && W98.reg.set) { W98.reg.set(REG_PATH, name, val); } } catch (e) {}
}
function numOr(v, dflt) {
  var n = parseInt(v, 10);
  return (isFinite(n) && n >= 0) ? n : dflt;
}

/* ----------------------------------------------------------------- sound -- */
var lastBlip = 0;
function tone(freq, ms, type, gap) {
  if (!S.sound) { return; }
  var t = nowMs();
  if (gap && t - lastBlip < gap) { return; }
  lastBlip = t;
  try {
    if (W98.sound && typeof W98.sound.tone === 'function') { W98.sound.tone(freq, ms, type || 'square'); }
  } catch (e) {}
}
/* the rapid 1998 tick-tick cadence while a wall is building */
function tickBlip() { tone(1400, 6, 'square', 34); }
function placeBlip() { tone(700, 22, 'square'); }
function lockBlip() { tone(420, 26, 'square'); }
function captureBlip() { tone(880, 30, 'square'); }
function dieBlip() {
  if (!S.sound) { return; }
  try {
    if (W98.sound && W98.sound.tone) {
      W98.sound.tone(220, 90, 'sawtooth');
      W98.sound.tone(140, 160, 'sawtooth');
    }
  } catch (e) {}
}
function levelBlip() {
  if (!S.sound) { return; }
  try {
    if (W98.sound && W98.sound.tone) {
      W98.sound.tone(523, 60, 'square');
      W98.sound.tone(659, 60, 'square');
      W98.sound.tone(880, 110, 'square');
    }
  } catch (e) {}
}
function gameOverBlip() {
  if (!S.sound) { return; }
  try {
    if (W98.sound && W98.sound.tone) {
      W98.sound.tone(392, 120, 'square');
      W98.sound.tone(294, 120, 'square');
      W98.sound.tone(196, 240, 'square');
    }
  } catch (e) {}
}
function bounceBlip() { tone(2000, 4, 'square', 36); }

/* ----------------------------------------------------------------- state -- */

var win = null, canvas = null, ctx = null, def = null;
var dead = false, focused = true, looping = false, rafCancel = null, prevTs = 0, acc = 0;
var state = 'ready';              /* ready | play | dead | clear | over | paused */
var stateUntil = 0;
var level = 1, lives = 3, score = 0, bestScore = 0, bestLevel = 1;
var balls = [], particles = [], walls = [], growing = [];
var hWalls = [], vWalls = [], filled = [], fillCount = 0;
var orient = 'h';
var banner = '';
var panel = { x: 0, y: 0, w: 0, h: 0 };
var roomX = 0, roomY = 0;
var hover = null;
var press = null;
var flashes = [];
var bgDirty = true, bgCanvas = null, bgCtx = null;

function newGrid() {
  var r;
  hWalls = []; vWalls = []; filled = [];
  for (r = 0; r <= ROWS; r++) {
    hWalls.push(new Array(COLS).fill(false));
  }
  for (r = 0; r < ROWS; r++) {
    vWalls.push(new Array(COLS + 1).fill(false));
    filled.push(new Array(COLS).fill(false));
  }
  fillCount = 0;
  bgDirty = true;
}

/* ------------------------------------------------------------------ setup -- */

function ballSpeed() { return Math.min(150 + (level - 1) * 10, 300); }
function ballCount() { return Math.min(level + 1, 50); }   /* 2 atoms at level 1 */

function startLevel(lv) {
  var i, tries;
  level = lv;
  newGrid();
  walls = []; growing = []; particles = []; flashes = [];
  balls = [];
  var n = ballCount(), sp = ballSpeed();
  for (i = 0; i < n; i++) {
    for (tries = 0; tries < 200; tries++) {
      var x = 24 + Math.random() * (RW - 48);
      var y = 24 + Math.random() * (RH - 48);
      var ok = true, j;
      for (j = 0; j < balls.length; j++) {
        var dx = balls[j].x - x, dy = balls[j].y - y;
        if (dx * dx + dy * dy < 900) { ok = false; break; }
      }
      if (ok) { break; }
    }
    var ang = Math.random() * Math.PI * 2;
    balls.push({
      x: x, y: y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      r: BALL_R, glow: 0
    });
  }
  if (lv > bestLevel) { bestLevel = lv; regSet('BestLevel', bestLevel); }
  orient = 'h';
  banner = 'LEVEL ' + lv;
  state = 'ready';
  stateUntil = nowMs() + 900;
  updateStatus();
  paint();
}
function newGame(first) {
  if (!first) { }
  score = 0;
  lives = 3;
  startLevel(1);
  banner = 'LEVEL 1';
}
function levelComplete() {
  state = 'clear';
  stateUntil = nowMs() + 2000;
  banner = 'LEVEL ' + level + ' CLEARED';
  levelBlip();
  var bonus = 100 * level;
  score += bonus;
  if (level % 2 === 0 && lives < 5) { lives++; }
  regSet('HighScore', Math.max(score, bestScore));
  regSet('BestLevel', Math.max(level + 1, bestLevel));
  updateStatus();
}
function loseLife() {
  lives--;
  if (lives <= 0) { gameOver(); return; }
  state = 'dead';
  stateUntil = nowMs() + 1000;
  banner = 'LIFE LOST';
  dieBlip();
  updateStatus();
}
function gameOver() {
  state = 'over';
  stateUntil = nowMs() + 1400;
  banner = 'GAME OVER';
  gameOverBlip();
  if (score > bestScore) {
    bestScore = score;
    regSet('HighScore', bestScore);
  }
  regSet('BestLevel', bestLevel);
  updateStatus();
  win.setTimeout(function () {
    if (dead) { return; }
    var msg = 'Game over.\r\n\r\nScore: ' + score + '\r\n' +
              'Level reached: ' + level + '\r\n' +
              'High score: ' + bestScore;
    var p = (W98.dialog && W98.dialog.alert) ? W98.dialog.alert('JezzBall', msg, 'info') : null;
    var after = function () {
      if (dead) { return; }
      newGame(false);
    };
    if (p && p.then) { p.then(after); } else { after(); }
  }, 1600);
}

/* ------------------------------------------------------------------ walls -- */

/* solid geometry test between two cells of the same line */
function blockedAt(horiz, line, cell, side) {
  /* side: +1 look right/down, -1 look left/up from `cell`            */
  var nb = cell + side;
  if (nb < 0 || nb >= (horiz ? COLS : ROWS)) { return true; }   /* border */
  if (horiz) {
    if (line < 1 || line > ROWS - 1) { return true; }
    return !!(vWalls[line - 1][nb] || vWalls[line][nb] || hWalls[line][nb]);
  }
  if (line < 1 || line > COLS - 1) { return true; }
  return !!(hWalls[nb][line - 1] || hWalls[nb][line] || vWalls[nb][line]);
}
function limitScan(horiz, line, cell, dir) {
  var k = cell, guard = 0;
  while (guard++ < 200) {
    if (blockedAt(horiz, line, k, dir)) { return k; }
    k += dir;
  }
  return cell;
}

function cellWallExists(horiz, line, cell) {
  if (horiz) {
    if (line < 0 || line > ROWS) { return true; }
    return !!hWalls[line][cell];
  }
  if (cell < 0 || cell > COLS) { return true; }
  return !!vWalls[cell][line];
}
function markCell(horiz, line, cell) {
  if (horiz) { hWalls[line][cell] = true; }
  else { vWalls[cell][line] = true; }
}
function clearCell(horiz, line, cell) {
  if (horiz) { hWalls[line][cell] = false; }
  else { vWalls[cell][line] = false; }
}

/* ball distance to a wall cell, used to refuse unfair placements */
function ballNearCell(horiz, line, cell) {
  var x1, x2, y1, y2, i;
  if (horiz) {
    x1 = cell * CELL; x2 = x1 + CELL;
    y1 = y2 = line * CELL;
  } else {
    y1 = cell * CELL; y2 = y1 + CELL;
    x1 = x2 = line * CELL;
  }
  for (i = 0; i < balls.length; i++) {
    var b = balls[i];
    var cx = clamp(b.x, x1, x2), cy = clamp(b.y, y1, y2);
    var dx = b.x - cx, dy = b.y - cy;
    if (dx * dx + dy * dy < (b.r + 9) * (b.r + 9)) { return true; }
  }
  return false;
}

function placeWall(horiz, line, cell) {
  if (state !== 'play') { return false; }
  if (growing.length) { return false; }        /* one splitter at a time */
  var maxLine = horiz ? ROWS - 1 : COLS - 1;
  if (line < 1 || line > maxLine) { return false; }
  var maxCell = horiz ? COLS : ROWS;
  if (cell < 0 || cell >= maxCell) { return false; }
  if (cellWallExists(horiz, line, cell)) { return false; }
  if (ballNearCell(horiz, line, cell)) { return false; }
  var lo = limitScan(horiz, line, cell, -1);
  var hi = limitScan(horiz, line, cell, 1);
  var w = {
    horiz: horiz, line: line, lo: cell, hi: cell,
    limitLo: lo, limitHi: hi, acc: 0, lockT: nowMs()
  };
  markCell(horiz, line, cell);
  growing.push(w);
  bgDirty = true;
  placeBlip();
  paint();
  return true;
}
function growWalls(dt) {
  var i, w, j;
  for (i = growing.length - 1; i >= 0; i--) {
    w = growing[i];
    w.acc += dt;
    var steps = 0;
    while (w.acc >= CELL_MS && steps < 6) {
      w.acc -= CELL_MS;
      steps++;
      var did = false;
      if (w.lo > w.limitLo) {
        w.lo--;
        if (!cellWallExists(w.horiz, w.line, w.lo)) { markCell(w.horiz, w.line, w.lo); }
        did = true;
      }
      if (w.hi < w.limitHi) {
        w.hi++;
        if (!cellWallExists(w.horiz, w.line, w.hi)) { markCell(w.horiz, w.line, w.hi); }
        did = true;
      }
      if (did) { bgDirty = true; tickBlip(); }
      if (w.lo <= w.limitLo && w.hi >= w.limitHi) { break; }
    }
    if (w.lo <= w.limitLo && w.hi >= w.limitHi) {
      /* reached solid geometry on both sides: lock it and split the room */
      w.lockT = nowMs();
      growing.splice(i, 1);
      walls.push(w);
      bgDirty = true;
      lockBlip();
      captureRegions();
    }
  }
}
function killGrowingWall(idx) {
  var w = growing[idx], c;
  for (c = w.lo; c <= w.hi; c++) { clearCell(w.horiz, w.line, c); }
  growing.splice(idx, 1);
  bgDirty = true;
}
function wallRect(w) {
  if (w.horiz) {
    return {
      x1: w.lo * CELL, x2: (w.hi + 1) * CELL,
      y1: w.line * CELL - WALL_HALF, y2: w.line * CELL + WALL_HALF
    };
  }
  return {
    x1: w.line * CELL - WALL_HALF, x2: w.line * CELL + WALL_HALF,
    y1: w.lo * CELL, y2: (w.hi + 1) * CELL
  };
}
function ballTouchesRect(b, rc) {
  var cx = clamp(b.x, rc.x1, rc.x2), cy = clamp(b.y, rc.y1, rc.y2);
  var dx = b.x - cx, dy = b.y - cy;
  return (dx * dx + dy * dy) < (b.r * b.r);
}

/* ------------------------------------------------------------- flood fill -- */

function captureRegions() {
  var rid = [], r, c, i;
  for (r = 0; r < ROWS; r++) {
    rid.push(new Array(COLS).fill(-1));
  }
  var regions = [];
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      if (filled[r][c] || rid[r][c] >= 0) { continue; }
      var id = regions.length, cells = [], stack = [[r, c]];
      regions.push({ cells: cells, hasBall: false });
      rid[r][c] = id;
      while (stack.length) {
        var p = stack.pop(), pr = p[0], pc = p[1];
        cells.push([pr, pc]);
        /* right neighbour: vertical grid line pc+1 */
        if (pc + 1 < COLS && !vWalls[pr][pc + 1] && rid[pr][pc + 1] < 0 && !filled[pr][pc + 1]) {
          rid[pr][pc + 1] = id; stack.push([pr, pc + 1]);
        }
        if (pc - 1 >= 0 && !vWalls[pr][pc] && rid[pr][pc - 1] < 0 && !filled[pr][pc - 1]) {
          rid[pr][pc - 1] = id; stack.push([pr, pc - 1]);
        }
        if (pr + 1 < ROWS && !hWalls[pr + 1][pc] && rid[pr + 1][pc] < 0 && !filled[pr + 1][pc]) {
          rid[pr + 1][pc] = id; stack.push([pr + 1, pc]);
        }
        if (pr - 1 >= 0 && !hWalls[pr][pc] && rid[pr - 1][pc] < 0 && !filled[pr - 1][pc]) {
          rid[pr - 1][pc] = id; stack.push([pr - 1, pc]);
        }
      }
    }
  }
  /* which regions hold an atom? */
  for (i = 0; i < balls.length; i++) {
    var br = Math.floor(balls[i].y / CELL), bc = Math.floor(balls[i].x / CELL);
    br = clamp(br, 0, ROWS - 1); bc = clamp(bc, 0, COLS - 1);
    var id2 = rid[br][bc];
    if (id2 >= 0 && regions[id2]) { regions[id2].hasBall = true; }
  }
  /* fill every empty region */
  var gained = 0, k;
  for (i = 0; i < regions.length; i++) {
    if (regions[i].hasBall) { continue; }
    for (k = 0; k < regions[i].cells.length; k++) {
      var rr = regions[i].cells[k][0], cc = regions[i].cells[k][1];
      if (!filled[rr][cc]) { filled[rr][cc] = true; fillCount++; gained++; }
    }
  }
  if (gained > 0) {
    score += gained * 10;
    bgDirty = true;
    captureBlip();
    splash(roomX + RW / 2, roomY + RH / 2, gained, '#8080ff');
  }
  updateStatus();
  if (fillCount / TOTAL_CELLS >= GOAL && state === 'play') {
    levelComplete();
  }
}

/* ------------------------------------------------------------- particles -- */

function splash(x, y, n, col) {
  var i, count = Math.min(18, 4 + Math.floor(n / 12));
  for (i = 0; i < count; i++) {
    var a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 90;
    particles.push({
      x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 320 + Math.random() * 220, t: 0, col: col || '#ffffff'
    });
  }
  if (particles.length > 240) { particles = particles.slice(particles.length - 240); }
}
function stepParticles(dt) {
  var i, p, t = dt / 1000;
  for (i = particles.length - 1; i >= 0; i--) {
    p = particles[i];
    p.t += dt;
    if (p.t >= p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * t;
    p.y += p.vy * t;
    p.vx *= 0.94;
    p.vy *= 0.94;
  }
  for (i = flashes.length - 1; i >= 0; i--) {
    flashes[i].t += dt;
    if (flashes[i].t > flashes[i].life) { flashes.splice(i, 1); }
  }
}

/* -------------------------------------------------------------- physics --- */

function collideBall(b) {
  var r = b.r, i, li, ly, c0, c1, c, rc, hit = false;
  /* room edges */
  if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx); hit = true; }
  if (b.x > RW - r) { b.x = RW - r; b.vx = -Math.abs(b.vx); hit = true; }
  if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy); hit = true; }
  if (b.y > RH - r) { b.y = RH - r; b.vy = -Math.abs(b.vy); hit = true; }

  /* horizontal grid lines */
  var l0 = clamp(Math.floor((b.y - r) / CELL), 1, ROWS - 1);
  var l1 = clamp(Math.floor((b.y + r) / CELL), 1, ROWS - 1);
  c0 = clamp(Math.floor((b.x - r) / CELL), 0, COLS - 1);
  c1 = clamp(Math.floor((b.x + r) / CELL), 0, COLS - 1);
  for (li = l0; li <= l1; li++) {
    ly = li * CELL;
    if (Math.abs(b.y - ly) > r + WALL_HALF) { continue; }
    for (c = c0; c <= c1; c++) {
      if (!hWalls[li][c]) { continue; }
      if (b.y < ly) { b.y = ly - r - 0.01; if (b.vy > 0) { b.vy = -b.vy; } }
      else { b.y = ly + r + 0.01; if (b.vy < 0) { b.vy = -b.vy; } }
      hit = true;
      break;
    }
  }
  /* vertical grid lines */
  var k0 = clamp(Math.floor((b.x - r) / CELL), 1, COLS - 1);
  var k1 = clamp(Math.floor((b.x + r) / CELL), 1, COLS - 1);
  var r0 = clamp(Math.floor((b.y - r) / CELL), 0, ROWS - 1);
  var r1 = clamp(Math.floor((b.y + r) / CELL), 0, ROWS - 1);
  for (li = k0; li <= k1; li++) {
    ly = li * CELL;
    if (Math.abs(b.x - ly) > r + WALL_HALF) { continue; }
    for (c = r0; c <= r1; c++) {
      if (!vWalls[c][li]) { continue; }
      if (b.x < ly) { b.x = ly - r - 0.01; if (b.vx > 0) { b.vx = -b.vx; } }
      else { b.x = ly + r + 0.01; if (b.vx < 0) { b.vx = -b.vx; } }
      hit = true;
      break;
    }
  }
  if (hit) {
    bounceBlip();
    if (particles.length < 200) {
      flashes.push({
        x: b.x, y: b.y, t: 0, life: 70,
        x2: b.x + b.vx * 0.03, y2: b.y + b.vy * 0.03
      });
      if (flashes.length > 40) { flashes.shift(); }
    }
  }
}

function stepBall(b, dtMs) {
  /* dtMs is milliseconds; ball speed is px/s, so integrate in seconds and
     substep at most half a radius per step so nothing tunnels a wall */
  var dt = dtMs / 1000;
  var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  var dist = sp * dt;
  var n = Math.max(1, Math.ceil(dist / (b.r * 0.5)));
  var sdt = dt / n, i;
  for (i = 0; i < n; i++) {
    b.x += b.vx * sdt;
    b.y += b.vy * sdt;
    collideBall(b);
  }
  if (b.glow > 0) { b.glow -= dtMs; }
}

function physics(dt) {
  if (state === 'play') {
    growWalls(dt);
    var i;
    for (i = 0; i < balls.length; i++) {
      stepBall(balls[i], dt);
    }
    /* death test: any atom touching a wall that is still being built */
    if (state === 'play') {
      for (i = 0; i < growing.length; i++) {
        var rc = wallRect(growing[i]), j;
        for (j = 0; j < balls.length; j++) {
          if (ballTouchesRect(balls[j], rc)) {
            balls[j].glow = 400;
            splash(balls[j].x, balls[j].y, 40, '#ff8080');
            killGrowingWall(i);
            loseLife();
            break;
          }
        }
        if (state !== 'play') { break; }
      }
    }
  } else if (state === 'ready' || state === 'clear') {
    /* atoms keep gliding during the intermissions, walls do not grow */
    var k;
    for (k = 0; k < balls.length; k++) { stepBall(balls[k], dt); }
  }
  stepParticles(dt);
  if (state !== 'play' && state !== 'paused' && nowMs() >= stateUntil) {
    if (state === 'ready') { state = 'play'; banner = ''; }
    else if (state === 'clear') { startLevel(level + 1); }
    else if (state === 'dead') { state = 'play'; banner = ''; }
    else if (state === 'over') { /* the dialog restarts the game */ }
  }
}

/* -------------------------------------------------------------- renderer -- */

function layout() {
  var W = canvas.width, H = canvas.height;
  roomX = Math.max(2, Math.floor((W - RW) / 2));
  roomY = Math.max(2, H - PANEL_H - GAP * 2 - RH);
  panel.w = RW;
  panel.h = PANEL_H;
  panel.x = roomX;
  panel.y = roomY + RH + GAP;
  if (panel.y + panel.h > H) { panel.y = H - panel.h - 2; }
  if (!bgCanvas) {
    try {
      bgCanvas = document.createElement('canvas');
      bgCtx = bgCanvas.getContext('2d');
    } catch (e) { bgCanvas = null; bgCtx = null; }
  }
  if (bgCanvas) {
    bgCanvas.width = RW + 2;
    bgCanvas.height = RH + 2;
    bgDirty = true;
  }
}

function drawWallBand(g, horiz, line, lo, hi, col, tipLo, tipHi) {
  var x, y, w, h, c, cx, cy, cw, ch;
  if (horiz) {
    x = 1 + lo * CELL;
    w = (hi - lo + 1) * CELL;
    y = 1 + line * CELL - 1;
    g.fillStyle = C.dark;
    g.fillRect(x, y, w, 3);
    for (c = lo; c <= hi; c++) {
      cx = 1 + c * CELL;
      cw = CELL;
      if (tipLo !== undefined && (c <= tipLo || c >= tipHi)) { g.fillStyle = C.tip; }
      else { g.fillStyle = col; }
      g.fillRect(cx, y + 1, cw, 1);
    }
  } else {
    y = 1 + lo * CELL;
    h = (hi - lo + 1) * CELL;
    x = 1 + line * CELL - 1;
    g.fillStyle = C.dark;
    g.fillRect(x, y, 3, h);
    for (c = lo; c <= hi; c++) {
      cy = 1 + c * CELL;
      ch = CELL;
      if (tipLo !== undefined && (c <= tipLo || c >= tipHi)) { g.fillStyle = C.tip; }
      else { g.fillStyle = col; }
      g.fillRect(x + 1, cy, 1, ch);
    }
  }
}

/* the room background (open area, captured areas, walls, border) is cached in
   an offscreen bitmap and only rebuilt when the geometry actually changes */
function buildBg() {
  if (!bgCtx) { return; }
  var g = bgCtx, r, c, runStart, i, w;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = C.room;
  g.fillRect(0, 0, RW + 2, RH + 2);
  for (r = 0; r < ROWS; r++) {
    runStart = -1;
    for (c = 0; c <= COLS; c++) {
      var on = (c < COLS && filled[r][c]);
      if (on && runStart < 0) { runStart = c; }
      if (!on && runStart >= 0) {
        g.fillStyle = C.captured;
        g.fillRect(1 + runStart * CELL, 1 + r * CELL, (c - runStart) * CELL, CELL);
        runStart = -1;
      }
    }
  }
  g.fillStyle = C.capEdge;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      if (!filled[r][c]) { continue; }
      if (r === 0 || !filled[r - 1][c]) {
        g.fillRect(1 + c * CELL, 1 + r * CELL, CELL, 1);
      }
    }
  }
  for (i = 0; i < walls.length; i++) {
    drawWallBand(g, walls[i].horiz, walls[i].line, walls[i].lo, walls[i].hi, C.wall);
  }
  for (i = 0; i < growing.length; i++) {
    w = growing[i];
    drawWallBand(g, w.horiz, w.line, w.lo, w.hi, C.grow, w.lo, w.hi);
  }
  g.fillStyle = C.dark;
  g.fillRect(0, 0, RW + 2, 1);
  g.fillRect(0, RH + 1, RW + 2, 1);
  g.fillRect(0, 0, 1, RH + 2);
  g.fillRect(RW + 1, 0, 1, RH + 2);
  bgDirty = false;
}

function drawBall(g, b) {
  var x = roomX + b.x, y = roomY + b.y;
  if (b.glow > 0) {
    g.beginPath(); g.arc(x, y, BALL_R + 3, 0, Math.PI * 2);
    g.fillStyle = ((nowMs() / 90) | 0) % 2 ? '#ff8080' : '#ffffff';
    g.fill();
  }
  g.beginPath(); g.arc(x, y, BALL_R, 0, Math.PI * 2);
  g.fillStyle = C.ballRim; g.fill();
  g.beginPath(); g.arc(x, y, BALL_R - 1, 0, Math.PI * 2);
  g.fillStyle = C.ball; g.fill();
  g.fillStyle = C.ballHi;
  g.fillRect(Math.round(x - 3), Math.round(y - 3), 2, 2);
  g.fillRect(Math.round(x - 1), Math.round(y - 4), 2, 1);
}

function drawLife(g, x, y) {
  g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2);
  g.fillStyle = C.ballRim; g.fill();
  g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
  g.fillStyle = C.ball; g.fill();
  g.fillStyle = C.ballHi;
  g.fillRect(Math.round(x - 3), Math.round(y - 3), 2, 2);
}

function drawPanel(g) {
  var x = panel.x, y = panel.y, w = panel.w, h = panel.h;
  g.fillStyle = C.face;
  g.fillRect(x, y, w, h);
  g.fillStyle = C.shadow;
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y, 1, h);
  g.fillStyle = C.hi;
  g.fillRect(x, y + h - 1, w, 1);
  g.fillRect(x + w - 1, y, 1, h);
  g.font = '11px Tahoma, "MS Sans Serif", Arial, sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  var ty = y + Math.floor(h / 2) + 1;
  g.fillStyle = C.text;
  g.fillText('Level: ' + level, x + 8, ty);
  g.fillText('Lives:', x + 108, ty);
  var i;
  for (i = 0; i < lives; i++) { drawLife(g, x + 148 + i * 16, ty); }
  g.fillText('% Cleared: ' + Math.min(100, Math.floor(fillCount / TOTAL_CELLS * 100)) + '%', x + 238, ty);
  g.fillText('Score: ' + score, x + 400, ty);
}

function drawOverlay() {
  var g = ctx, cx = roomX + RW / 2, cy = roomY + RH / 2;
  if (state === 'paused') {
    g.fillStyle = C.dark;
    g.fillRect(roomX, cy - 18, RW, 36);
    g.fillStyle = C.warn;
    g.font = 'bold 22px Tahoma, "MS Sans Serif", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('PAUSED', cx, cy);
    return;
  }
  if (banner) {
    g.fillStyle = C.dark;
    g.fillRect(roomX, cy - 16, RW, 32);
    g.fillStyle = C.warn;
    g.font = 'bold 18px Tahoma, "MS Sans Serif", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(banner, cx, cy);
  }
}

function render() {
  if (!ctx) { return; }
  var g = ctx, i;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = C.face;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (bgDirty) { buildBg(); }
  if (bgCanvas) {
    g.drawImage(bgCanvas, roomX - 1, roomY - 1);
  } else {
    g.fillStyle = C.room;
    g.fillRect(roomX, roomY, RW, RH);
  }
  for (i = 0; i < flashes.length; i++) {
    var f = flashes[i];
    var a = 1 - f.t / f.life;
    if (a <= 0) { continue; }
    g.fillStyle = a > 0.5 ? C.hi : '#ff8080';
    g.fillRect(Math.round(roomX + f.x - 1), Math.round(roomY + f.y - 1), 3, 3);
  }
  for (i = 0; i < particles.length; i++) {
    var p = particles[i];
    g.fillStyle = p.col;
    g.fillRect(Math.round(roomX + p.x), Math.round(roomY + p.y), 2, 2);
  }
  for (i = 0; i < balls.length; i++) { drawBall(g, balls[i]); }
  if (state === 'play' && hover && !press) { drawGhost(g); }
  drawPanel(g);
  drawOverlay();
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
}
function drawGhost(g) {
  /* a faint preview of the wall about to be placed */
  var line = hover.line, cell = hover.cell;
  if (hover.horiz) {
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(roomX + cell * CELL, roomY + line * CELL, CELL, 1);
  } else {
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(roomX + line * CELL, roomY + cell * CELL, 1, CELL);
  }
}

/* ------------------------------------------------------------ status bar -- */

function updateStatus() {
  if (dead || !win) { return; }
  try {
    win.setStatus([
      { text: 'Level: ' + level, width: 84 },
      { text: 'Lives: ' + Math.max(0, lives), width: 76 },
      { text: '% Cleared: ' + Math.min(100, Math.floor(fillCount / TOTAL_CELLS * 100)) + '%', width: 116 },
      { text: 'Score: ' + score }
    ]);
  } catch (e) {}
}

/* ------------------------------------------------------------------ loop -- */

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
function startLoop() {
  if (looping || dead) { return; }
  looping = true;
  prevTs = 0;
  acc = 0;
  rafCancel = doRaf(function (dt) {
    if (dead || !looping) { return; }
    if (!dt || dt < 0) { dt = 16; }
    if (dt > 100) { dt = 100; }
    acc += dt;
    var guard = 0;
    while (acc >= STEP_MS && guard++ < 10) {
      acc -= STEP_MS;
      physics(STEP_MS);
    }
    if (state !== 'paused') { render(); }
  });
}
function stopLoop() {
  looping = false;
  if (rafCancel) {
    try { rafCancel(); } catch (e) {}
    rafCancel = null;
  }
}
function paint() { if (ctx) { render(); } }

/* ------------------------------------------------------------ window glue -- */

function blockMenu(e) { e.preventDefault(); }

function cleanup() {
  if (dead) { return; }
  dead = true;
  stopLoop();
  try { canvas.removeEventListener('mousedown', onMouseDown); } catch (e) {}
  try { canvas.removeEventListener('mouseup', onMouseUp); } catch (e) {}
  try { canvas.removeEventListener('mousemove', onMouseMove); } catch (e) {}
  try { canvas.removeEventListener('contextmenu', blockMenu); } catch (e) {}
  try { document.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
  try { regSet('HighScore', Math.max(score, bestScore)); regSet('BestLevel', bestLevel); } catch (e) {}
  balls = []; walls = []; growing = []; particles = []; flashes = [];
}

function toLocal(ev) {
  var r = canvas.getBoundingClientRect();
  if (!r || !r.width) { return { x: ev.clientX || 0, y: ev.clientY || 0 }; }
  return {
    x: (ev.clientX - r.left) * (canvas.width / r.width) - roomX,
    y: (ev.clientY - r.top) * (canvas.height / r.height) - roomY
  };
}
function inside(x, y) { return x >= -2 && y >= -2 && x <= RW + 2 && y <= RH + 2; }

function hoverAt(x, y, horiz) {
  if (typeof horiz !== 'boolean') { horiz = (orient === 'h'); }
  if (!inside(x, y)) { return null; }
  if (horiz) {
    var line = clamp(Math.round(y / CELL), 1, ROWS - 1);
    var cell = clamp(Math.floor(x / CELL), 0, COLS - 1);
    return { horiz: true, line: line, cell: cell };
  }
  var cline = clamp(Math.round(x / CELL), 1, COLS - 1);
  var cell2 = clamp(Math.floor(y / CELL), 0, ROWS - 1);
  return { horiz: false, line: cline, cell: cell2 };
}
function onMouseMove(ev) {
  if (dead) { return; }
  var p = toLocal(ev);
  hover = hoverAt(p.x, p.y, orient === 'h');
  if (state === 'play') { paint(); }
}
function onMouseDown(ev) {
  if (dead || !canvas) { return; }
  focused = true;
  if (ev.button === 2) {          /* right button toggles orientation */
    toggleOrient();
    return;
  }
  if (ev.button !== 0) { return; }
  var p = toLocal(ev);
  press = { x: p.x, y: p.y, t: nowMs(), horiz: orient === 'h' };
}
function onMouseUp(ev) {
  if (dead) { return; }
  if (ev.button === 2) { return; }
  if (ev.button !== 0) { return; }
  if (!press) { return; }
  var p = toLocal(ev);
  var dx = p.x - press.x, dy = p.y - press.y;
  var horiz = press.horiz, x = press.x, y = press.y;
  if (Math.sqrt(dx * dx + dy * dy) > 8) {
    /* dragged: the drag axis picks the wall orientation */
    horiz = Math.abs(dx) >= Math.abs(dy);
    x = p.x; y = p.y;
  }
  press = null;
  if (state !== 'play') { return; }
  var h = hoverAt(x, y, horiz);
  if (!h) { paint(); return; }
  placeWall(horiz, h.line, h.cell);
  paint();
}
function toggleOrient() {
  orient = (orient === 'h') ? 'v' : 'h';
  tone(1000, 18, 'square');
  setMenu();
  updateStatus();
  paint();
}
function onKeyDown(ev) {
  if (dead || !ev || !canvas) { return; }
  if (ev.__jbHandled) { return; }
  if (!isActive()) { return; }
  var k = ev.key, handled = true;
  if (k === 'p' || k === 'P') {
    if (state === 'paused') { state = 'play'; }
    else if (state === 'play' || state === 'ready') { state = 'paused'; }
    paint();
  } else if (k === 'F2') { newGame(false); }
  else if (k === ' ' || k === 'Spacebar' || k === 'ArrowUp' || k === 'ArrowDown' ||
           k === 'ArrowLeft' || k === 'ArrowRight') {
    toggleOrient();
  } else if (k === 'Escape') {
    if (state === 'paused') { state = 'play'; paint(); } else { handled = false; }
  } else { handled = false; }
  if (handled) {
    ev.__jbHandled = true;
    ev.preventDefault();
  }
}
function isActive() {
  if (!win || !win.el || !focused) { return false; }
  var ae = document.activeElement;
  if (!ae || ae === document.body || ae === win.el) { return true; }
  return win.el.contains(ae);
}

/* ------------------------------------------------------------------ menu -- */

function cmdPause() { onKeyDown({ key: 'p', preventDefault: function () {}, __jbHandled: false }); }
function cmdNew() { newGame(false); }
function cmdAbout() {
  if (dead) { return; }
  try { if (W98.aboutDialog && def) { W98.aboutDialog(def); return; } } catch (e) {}
  if (W98.dialog && W98.dialog.alert) {
    W98.dialog.alert('About JezzBall',
      'JezzBall\r\nWindows 98 Web desktop\r\n\r\nHigh score: ' + bestScore +
      '\r\nBest level: ' + bestLevel, 'info');
  }
}
function cmdHelp() {
  if (dead) { return; }
  var msg =
    'Bounce atoms around the room and trap them.\n\n' +
    'Click (or drag) in the room to build a wall. The wall grows from the\n' +
    'point you clicked in both directions until it reaches solid geometry.\n' +
    'If an atom touches the wall while it is still growing you lose a life.\n\n' +
    'When the wall is finished, any area that contains no atom is captured\n' +
    'and filled. Capture 75% of the room to clear the level. There are two\n' +
    'atoms at level 1 and one more for every level after that.\n\n' +
    'Right-click or press Space / an arrow key to switch the wall between\n' +
    'horizontal and vertical. P pauses, F2 starts a new game.';
  if (W98.dialog && W98.dialog.alert) { W98.dialog.alert('How to Play JezzBall', msg, 'info'); }
}
function setMenu() {
  if (dead || !win) { return; }
  try {
    win.setMenu([
      { label: '&Game', items: [
        { label: '&New Game', accel: 'F2', onclick: cmdNew },
        { label: '&Pause', accel: 'P', onclick: cmdPause },
        { type: 'sep' },
        { label: '&Horizontal wall', type: 'radio', checked: orient === 'h',
          onclick: function () { orient = 'h'; setMenu(); paint(); } },
        { label: '&Vertical wall', type: 'radio', checked: orient === 'v',
          onclick: function () { orient = 'v'; setMenu(); paint(); } },
        { type: 'sep' },
        { label: '&Sound', type: 'check', checked: S.sound,
          onclick: function () { S.sound = !S.sound; regSet('Sound', S.sound ? 1 : 0); setMenu(); } },
        { type: 'sep' },
        { label: 'E&xit', onclick: function () { win.close(); } }
      ]},
      { label: '&Help', items: [
        { label: '&How to Play', accel: 'F1', onclick: cmdHelp },
        { type: 'sep' },
        { label: '&About JezzBall\u2026', onclick: cmdAbout }
      ]}
    ]);
  } catch (e) {}
}

/* ------------------------------------------------------------ app def ---- */

var appDef = {
  id: 'jezzball',
  title: 'JezzBall',
  icon: 'jezzball',
  width: 592, height: 472,
  minWidth: 592, minHeight: 472,
  resizable: false,
  maximizable: false,
  desktop: true,
  singleton: true,
  startMenuGroup: 'Games',
  create: function (w, args) {
    win = w;
    dead = false;
    focused = true;
    looping = false;
    press = null;
    hover = null;

    S.sound = regGet('Sound', true) !== false;
    bestScore = numOr(regGet('HighScore', 0), 0);
    bestLevel = Math.max(1, numOr(regGet('BestLevel', 1), 1));

    win.el.style.display = 'flex';
    win.el.style.flexDirection = 'column';
    win.el.style.overflow = 'hidden';
    win.el.style.background = C.face;

    canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.imageRendering = 'pixelated';
    canvas.style.flex = '0 0 auto';
    canvas.width = 592;
    canvas.height = 472;
    win.el.appendChild(canvas);
    ctx = canvas.getContext('2d');
    if (!ctx) {
      var msg = document.createElement('div');
      msg.textContent = 'JezzBall requires canvas support.';
      win.el.replaceChild(msg, canvas);
      return {};
    }
    layout();

    win.setTitle('JezzBall');
    try { if (win.setIcon) { win.setIcon('jezzball'); } } catch (e) {}
    win.claimKeys();
    setMenu();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('contextmenu', blockMenu);
    document.addEventListener('keydown', onKeyDown, true);

    try { win.on('resize', function () { layout(); paint(); }); } catch (e) {}
    try { win.on('close', cleanup); } catch (e) {}
    try { win.on('focus', function () { focused = true; }); } catch (e) {}
    try { win.on('blur', function () { focused = false; paint(); }); } catch (e) {}

    newGame(true);
    regSet('HighScore', bestScore);
    regSet('BestLevel', bestLevel);
    startLoop();
    render();

    return {
      onClose: cleanup,
      onResize: function () { layout(); paint(); },
      onFocus: function () { focused = true; },
      onBlur: function () { focused = false; },
      onKey: onKeyDown
    };
  }
};

def = appDef;
W98.registerApp(appDef);

})();
