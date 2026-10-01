/* ===========================================================================
 * pinball.js — 3D Pinball for Windows 98, "Space Cadet" (fidelity build)
 *
 * Classic script (NOT a module).  Registers itself with W98.registerApp().
 * Uses only the documented W98 / win API from CONTRACT.md.
 *
 * Client area is a fixed 300x460.  Everything is drawn procedurally, one
 * pixel at a time, onto a single canvas:
 *
 *   top 56px   red 7-segment LED scoreboard: SCORE (left), the
 *              "SPACE CADET" mission line + letter lamps (centre),
 *              ball pips / MULTIPLIER / HIGH SCORE (right)
 *   below      the table: navy painted sci-fi playfield, chrome rails,
 *              green/blue ORBIT RAMP, three red-and-yellow pop bumpers,
 *              two slingshots, ten rollover pads spelling SPACE CADET,
 *              two outlanes, a centre drain, two bottom inlane flippers
 *              and a plunger launch lane on the right with a one-way gate.
 *
 * No border-radius, no blur, no soft drop shadows, no modern gradients:
 * every shaded surface is a hard-edged 2-colour ordered dither.
 *
 * Physics: fixed 1/120 s timestep off an accumulator fed by the W98 kernel
 * clock, with adaptive sub-stepping so a fast ball can never tunnel through
 * a wall or a flipper.  Flippers are rotating capsules whose angular
 * velocity feeds the collision response, so a flip really does transfer
 * energy into the ball.
 * ===========================================================================*/
(function () {
  'use strict';

  if (typeof W98 === 'undefined' || !W98) {
    var tries = 0;
    (function wait() {
      if (typeof W98 !== 'undefined' && W98 && typeof W98.registerApp === 'function') main();
      else if (++tries < 40) setTimeout(wait, 25);
    })();
    return;
  }
  main();

  function main() {

  var ID = 'pinball';
  var REG_HIVE = 'HKEY_CURRENT_USER\\Software\\Pinball';

  /* ------------------------------------------------------------ metrics */
  var TW = 300, TH = 460;        // table space == canvas backing store == client
  var HUD_H = 56;                // LED scoreboard strip across the top
  var PF_Y = HUD_H;              // playfield origin inside the canvas
  var PF_H = 404;                // playfield height
  var DRAIN_Y = 402;             // ball centre past this = drained
  var BALL_R = 7;

  var GRAVITY = 1300;            // px / s^2
  var FIXED_DT = 1 / 120;        // physics timestep (kernel-time accumulator)
  var MAX_FRAME_DT = 0.050;      // clamp so a background tab can't teleport
  var MAX_SUBSTEPS = 16;
  var MAX_SPEED = 1900;
  var AIR_DAMP = 0.10;
  var ROLL_DAMP = 0.60;

  /* -------------------------------------------------------- 1998 palette */
  var C = {
    face: '#c0c0c0', shadow: '#808080', dark: '#000000',
    hi: '#ffffff', light: '#dfdfdf',
    titleA: '#000080', titleB: '#1084d0',
    ledOn: '#ff2800', ledOff: '#2e0a04', ledDim: '#7a1408',
    navy: '#0a1440', navyD: '#050a24', navyL: '#142a6a',
    purple: '#2a1a62', purpleD: '#170c3a',
    chrome: '#d4d8e0', chromeM: '#9098a8', chromeD: '#4a5060',
    greenRamp: '#18a05a', greenRampD: '#0a5c34',
    blueRamp: '#2050c0', blueRampD: '#102a70',
    bumpRed: '#d02020', bumpRedD: '#7a0c0c',
    bumpYel: '#ffd830', bumpYelD: '#a07000',
    ball: '#c8c8cc', ballEdge: '#101418'
  };

  /* ==================================================================== */
  /* ======================== 5x7 DOT-MATRIX FONT ======================= */
  /* ==================================================================== */
  var B32 = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
  var FONT = {
    '0': 'EHHHHHE', '1': '44C444E', '2': 'EH1248V', '3': 'V2421HE', '4': '26AIV22',
    '5': 'VGU11HE', '6': '68GUHHE', '7': 'V124888', '8': 'EHEEHEE', '9': 'EHHF12C',
    'A': 'EHHVHHH', 'B': 'UHHUHHU', 'C': 'EHGGGHE', 'D': 'SIHHHIS', 'E': 'VGGUGGV',
    'F': 'VGGUGGG', 'G': 'EHGNHHF', 'H': 'HHHVHHH', 'I': 'V44444V', 'J': '72222IC',
    'K': 'HIKOKIH', 'L': 'GGGGGGV', 'M': 'HPLLHHH', 'N': 'HHOLJHH', 'O': 'EHHHHHE',
    'P': 'UHHUGGG', 'Q': 'EHHHLID', 'R': 'UHHUKIH', 'S': 'FGGE11U', 'T': 'V444444',
    'U': 'HHHHHHE', 'V': 'HHHHHA4', 'W': 'HHHLLPH', 'X': 'HHA4AHH', 'Y': 'HHA4444',
    'Z': 'V1248GV',
    ' ': '0000000', '-': '0000V00', '.': '00000CC', ':': '0CC00CC',
    '/': '122488G', '+': '044V440', '!': '4444404', '=': '00V0V00',
    '?': 'EH12404', "'": '4400000', '>': 'G84248G', '<': '1248421', '*': 'A4VA4A0'
  };
  var FONT_W = 5, FONT_H = 7, FONT_ADV = 6;

  var textCache = {};
  function textBitmap(text, scale, color) {
    text = String(text).toUpperCase();
    var key = scale + '|' + color + '|' + text;
    var cv = textCache[key];
    if (cv) return cv;
    var w = Math.max(1, text.length * FONT_ADV * scale - scale);
    cv = document.createElement('canvas');
    cv.width = w; cv.height = FONT_H * scale;
    var g = cv.getContext('2d');
    g.fillStyle = color;
    for (var i = 0; i < text.length; i++) {
      var pat = FONT[text.charAt(i)] || FONT[' '];
      var ox = i * FONT_ADV * scale;
      for (var r = 0; r < FONT_H; r++) {
        var bits = B32.indexOf(pat.charAt(r));
        if (bits <= 0) continue;
        var run = -1;
        for (var c = 0; c <= FONT_W; c++) {
          var on = (c < FONT_W) && (bits & (1 << (FONT_W - 1 - c)));
          if (on && run < 0) run = c;
          if (!on && run >= 0) { g.fillRect(ox + run * scale, r * scale, (c - run) * scale, scale); run = -1; }
        }
      }
    }
    var n = 0; for (var k in textCache) n++;
    if (n > 128) textCache = {};
    textCache[key] = cv;
    return cv;
  }
  function drawText(g, text, x, y, scale, color) {
    g.drawImage(textBitmap(text, scale, color), x | 0, y | 0);
  }
  function textWidth(text, scale) {
    return Math.max(1, String(text).length * FONT_ADV * scale - scale);
  }

  /* ==================================================================== */
  /* ========================= 7-SEGMENT LED =========================== */
  /* ==================================================================== */
  var SEG_RECTS = [
    [3, 0, 8, 3], [0, 4, 3, 6], [11, 4, 3, 6], [3, 11, 8, 2],
    [0, 13, 3, 6], [11, 13, 3, 6], [3, 20, 8, 3]
  ];
  var SEG_MASK = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
  var SEG_ADV = 17;

  function drawDigit7(g, d, x, y, s, onCol, offCol) {
    var mask = SEG_MASK[d] || 0;
    for (var i = 0; i < 7; i++) {
      var r = SEG_RECTS[i];
      g.fillStyle = (mask & (1 << i)) ? onCol : offCol;
      g.fillRect(x + r[0] * s, y + r[1] * s, r[2] * s, r[3] * s);
    }
  }
  function drawNumber7(g, digits, x, y, s, onCol, offCol) {
    for (var i = 0; i < digits.length; i++) {
      var ch = digits.charAt(i);
      if (ch >= '0' && ch <= '9') drawDigit7(g, ch.charCodeAt(0) - 48, x + i * SEG_ADV * s, y, s, onCol, offCol);
      else drawText(g, ch, x + i * SEG_ADV * s + 4 * s, y + 8 * s, s, onCol);
    }
  }

  /* ==================================================================== */
  /* ============================ GEOMETRY ============================== */
  /* ==================================================================== */
  /* Playfield space: x 0..300, y 0..404 (drawn at canvas y + PF_Y).       */

  var HULL = [[8, 422], [8, 96], [30, 54], [96, 36], [184, 36], [250, 46], [292, 80], [292, 396]];
  var INNER_ARC = [[58, 76], [110, 64], [162, 64], [204, 72], [242, 88], [268, 108]];

  var LANE_L = 268, LANE_R = 292, LANE_FLOOR_Y = 396, GATE_Y = 108;
  var OUTLANE_L_X = 40, OUTLANE_R_X = 236, OUTLANE_TOP_Y = 258, OUTLANE_BOT_Y = 410;

  var SLING_L = [[44, 272], [44, 334], [92, 312]];
  var SLING_R = [[232, 272], [232, 334], [184, 312]];
  var BUMPERS = [{ x: 74, y: 196, r: 15 }, { x: 138, y: 170, r: 15 }, { x: 202, y: 196, r: 15 }];
  var LOOP_SENSOR = { x: 92, y: 50, r: 13 };

  var LETTERS = 'SPACE CADET';
  var ROLL_TOP = 124, ROLL_H = 10, ROLL_W = 16;
  var ROLL_CX = [24, 49, 75, 100, 125, 151, 176, 201, 226, 252];
  var LETTER_SLOT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];   // LETTERS index per pad
  var PAD_TO_LETTER = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10];    // pad -> LETTERS index

  var FLIP_LEN = 58, FLIP_RAD = 4.5;
  var FLIP_L = { px: 72, py: 366, rest: 0.5236, up: -0.4887 };
  var FLIP_R = { px: 204, py: 366, rest: Math.PI - 0.5236, up: Math.PI + 0.4887 };
  var FLIP_UP_W = 20.0, FLIP_DOWN_W = 12.0;

  var PLUNGE_X = 280, PLUNGE_REST_Y = 396, PLUNGE_TOP_Y = 372;
  var LAUNCH_MIN = 520, LAUNCH_MAX = 1360;
  var MAX_TONES_PER_SEC = 20;

  /* ==================================================================== */
  /* ============================ APP STATE ============================= */
  /* ==================================================================== */

  var win, canvas, ctx, staticCv, staticSync;
  var scale = 1, rafCancel = null, running = false, disposed = false;
  var lastTick = 0, accumulator = 0, frameCount = 0, fpsTime = 0, fps = 60;

  var ball = { x: PLUNGE_X, y: PLUNGE_REST_Y - BALL_R, vx: 0, vy: 0, contact: false };
  var ballInPlay = true;
  var mode = 'ready';                     // ready | play | gameover
  var score = 0, ballsLeft = 3, mult = 1, highScore = 0;
  var litLetters = [], padLit = [], padCooldown = [], bumperLit = [0, 0, 0], slingFlash = [0, 0];
  var loopCooldown = 0, loopFlash = 0;
  var plungerPower = 0, plungeHeld = false;
  var nudgeCount = 0, nudgeDecay = 0, tiltTimer = 0;
  var statusMsg = '', statusTimer = 0;
  var paused = false, muted = false, focused = true;
  var stuckTimer = 0, animClock = 0;
  var overlayRect = { x: 30, y: 118, w: 240, h: 120 };

  var flippers = [
    { px: FLIP_L.px, py: FLIP_L.py, len: FLIP_LEN, restAngle: FLIP_L.rest, upAngle: FLIP_L.up,
      angle: FLIP_L.rest, omega: 0, pressed: false, sign: -1 },
    { px: FLIP_R.px, py: FLIP_R.py, len: FLIP_LEN, restAngle: FLIP_R.rest, upAngle: FLIP_R.up,
      angle: FLIP_R.rest, omega: 0, pressed: false, sign: 1 }
  ];

  var segs = [], circles = [], laneSegs = [];

  /* ==================================================================== */
  /* ============================ HELPERS =============================== */
  /* ==================================================================== */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function vlen(x, y) { return Math.sqrt(x * x + y * y); }

  function addSeg(ax, ay, bx, by, o) {
    o = o || {};
    var dx = bx - ax, dy = by - ay, L = vlen(dx, dy) || 1;
    var s = {
      ax: ax, ay: ay, bx: bx, by: by,
      nx: dy / L, ny: -dx / L,
      rest: o.rest === undefined ? 0.42 : o.rest,
      fric: o.fric === undefined ? 0.06 : o.fric,
      kick: o.kick || 0, thick: o.thick || 0, gate: !!o.gate,
      kind: o.kind || 'wall', id: o.id === undefined ? -1 : o.id
    };
    segs.push(s);
    return s;
  }

  function buildTable() {
    segs = []; circles = []; laneSegs = [];
    var i;
    for (i = 0; i < HULL.length - 1; i++)
      addSeg(HULL[i][0], HULL[i][1], HULL[i + 1][0], HULL[i + 1][1], { rest: 0.62, fric: 0.05 });
    for (i = 0; i < INNER_ARC.length - 1; i++)
      addSeg(INNER_ARC[i][0], INNER_ARC[i][1], INNER_ARC[i + 1][0], INNER_ARC[i + 1][1], { rest: 0.64, fric: 0.05 });

    laneSegs[0] = addSeg(LANE_R, LANE_FLOOR_Y, LANE_L, LANE_FLOOR_Y, { rest: 0.30, fric: 0.12, kind: 'lane-floor' });
    laneSegs[1] = addSeg(LANE_L, LANE_FLOOR_Y, LANE_L, GATE_Y, { rest: 0.42, fric: 0.07, kind: 'lane-divider' });
    laneSegs[2] = addSeg(LANE_L, GATE_Y - 4, LANE_R, GATE_Y - 4, { rest: 0.10, fric: 0.20, gate: true, kind: 'gate' });
    laneSegs[3] = segs[HULL.length - 3];   // right outer wall of the hull

    addSeg(OUTLANE_L_X, OUTLANE_TOP_Y, OUTLANE_L_X, OUTLANE_BOT_Y, { rest: 0.35, fric: 0.10 });
    addSeg(OUTLANE_R_X, OUTLANE_TOP_Y, OUTLANE_R_X, OUTLANE_BOT_Y, { rest: 0.35, fric: 0.10 });

    function sling(T, id) {
      addSeg(T[0][0], T[0][1], T[2][0], T[2][1], { rest: 0.50, fric: 0.05, kick: 340, kind: 'sling', id: id });
      addSeg(T[2][0], T[2][1], T[1][0], T[1][1], { rest: 0.50, fric: 0.05, kick: 340, kind: 'sling', id: id });
      addSeg(T[1][0], T[1][1], T[0][0], T[0][1], { rest: 0.35, fric: 0.12 });
    }
    sling(SLING_L, 0);
    sling(SLING_R, 1);

    for (i = 0; i < BUMPERS.length; i++)
      circles.push({ x: BUMPERS[i].x, y: BUMPERS[i].y, r: BUMPERS[i].r, rest: 0.60, kick: 430, kind: 'bumper', id: i });
  }

  /* ==================================================================== */
  /* ============================== SOUND =============================== */
  /* ==================================================================== */
  /* Short square-wave blips only, exactly like the 1995 original, behind a
     hard rate limiter so a rattle can never spawn hundreds of oscillators. */

  var lastSfx = {}, toneTimes = [];

  function toneAt(freq, ms, type) {
    try {
      if (!W98.sound || typeof W98.sound.tone !== 'function') return;
      var now = W98.tick();
      while (toneTimes.length && now - toneTimes[0] > 1000) toneTimes.shift();
      if (toneTimes.length >= MAX_TONES_PER_SEC) return;
      toneTimes.push(now);
      W98.sound.tone(freq, ms, type || 'square');
    } catch (e) {}
  }
  function sfx(name, freq, ms, gapMs) {
    if (muted) return;
    var now = W98.tick();
    if (lastSfx[name] !== undefined && now - lastSfx[name] < (gapMs === undefined ? 45 : gapMs)) return;
    lastSfx[name] = now;
    if (name === 'bump1') toneAt(880, 32); else toneAt(freq, ms, 'square');
  }

  function sndFlip() { sfx('flip', 420, 22, 30); }
  function sndBump(i) { sfx('bump' + i, 700 + i * 120, 34, 40); }
  function sndSling(i) { sfx('sling' + i, 520 + i * 80, 28, 45); }
  function sndRoll(i) { sfx('roll', 1050 + i * 40, 20, 25); }
  function sndLaunch() { sfx('launch', 240, 70, 220); }
  function sndDrain() { sfx('drain', 130, 190, 500); }
  function sndTilt() { sfx('tilt', 100, 320, 900); }
  function sndLoop() { sfx('loop', 1200, 26, 200); sfx('loop2', 1600, 40, 200); }
  function sndBonus() { sfx('bonus', 1000, 40, 300); sfx('bonus2', 1500, 90, 300); }

  /* ==================================================================== */
  /* ============================ GAME LOGIC ============================ */
  /* ==================================================================== */

  function setStatus(msg, ms) { statusMsg = msg; statusTimer = ms || 1600; }

  function parkBall() {
    ball.x = PLUNGE_X;
    ball.y = PLUNGE_REST_Y - BALL_R;
    ball.vx = 0; ball.vy = 0;
    ball.contact = false;
    ballInPlay = false;
  }

  function loadBall() {
    ball.x = PLUNGE_X; ball.y = PLUNGE_REST_Y - BALL_R;
    ball.vx = 0; ball.vy = 0; ball.contact = false;
    ballInPlay = true;
    mode = 'ready';
    plungerPower = 0;
    mult = 1;
    for (var i = 0; i < 10; i++) padLit[i] = false;
    loopCooldown = 0;
    nudgeCount = 0; nudgeDecay = 0; tiltTimer = 0;
    stuckTimer = 0;
  }

  function newGame() {
    score = 0; ballsLeft = 3; mult = 1;
    for (var i = 0; i < LETTERS.length; i++) litLetters[i] = false;
    litLetters[5] = true;
    for (i = 0; i < 10; i++) padLit[i] = false;
    for (i = 0; i < 3; i++) bumperLit[i] = 0;
    statusTimer = 0; statusMsg = ''; tiltTimer = 0;
    loadBall();
    setStatus('SHOOT AGAIN', 2000);
    sfx('start', 660, 60, 300);
    sfx('start2', 990, 90, 300);
  }

  function saveHigh() {
    try {
      if (score > highScore) {
        highScore = score;
        if (W98.reg && W98.reg.set) W98.reg.set(REG_HIVE, 'HighScore', String(highScore));
      }
    } catch (e) {}
  }

  function award(base) {
    if (tiltTimer > 0) return;
    score += base * mult;
    if (score > highScore) highScore = score;
  }

  function drainBall() {
    if (mode !== 'play') return;
    var where = 'BALL DRAINED';
    if (ball.x < OUTLANE_L_X) where = 'LEFT OUTLANE';
    else if (ball.x > OUTLANE_R_X) where = 'RIGHT OUTLANE';
    sndDrain();
    saveHigh();
    ballsLeft--;
    if (ballsLeft <= 0) {
      ballsLeft = 0;
      mode = 'gameover';
      parkBall();
      setStatus('GAME OVER', 900000);
      sfx('over', 220, 220, 800);
    } else {
      loadBall();
      setStatus(where + ' - BALL ' + (4 - ballsLeft) + ' OF 3', 2400);
    }
  }

  function tiltNow() {
    if (tiltTimer > 0) return;
    tiltTimer = 3.0;
    nudgeCount = 0;
    setStatus('TILT', 3000);
    sndTilt();
    flippers[0].pressed = false;
    flippers[1].pressed = false;
  }

  function tryNudge(dx, dy) {
    if (mode === 'gameover' || tiltTimer > 0) return;
    if (nudgeCount >= 3) { tiltNow(); return; }
    nudgeCount++;
    var p = 70 + nudgeCount * 18;
    ball.vx += dx * p; ball.vy += dy * p;
    sfx('nudge', 90 + nudgeCount * 20, 40, 120);
    setStatus('NUDGE ' + nudgeCount + ' OF 3', 900);
  }

  function hitLetter(idx) {
    if (idx < 0 || idx >= 10) return;
    padCooldown[idx] = 0.8;
    if (!padLit[idx]) { padLit[idx] = true; sndRoll(idx); }
    award(500);
    var li = PAD_TO_LETTER[idx];
    if (li === undefined) return;
    litLetters[li] = true;
    litLetters[5] = true;
    var all = true;
    for (var i = 0; i < 10; i++) if (!litLetters[LETTER_SLOT[i]]) all = false;
    if (all) {
      mult = Math.min(9, mult + 2);
      award(25000);
      setStatus('SPACE CADET BONUS!', 3000);
      sndBonus();
      for (i = 0; i < 10; i++) { litLetters[i] = false; padLit[i] = false; }
      litLetters[5] = true;
      litLetters[10] = false;
    }
  }

  function hitBumper(b) { if (b.id >= 0 && b.id < 3) bumperLit[b.id] = 0.28; award(1000); sndBump(b.id); }
  function hitSling(id) { if (id >= 0 && id < 2) slingFlash[id] = 0.16; award(250); sndSling(id); }

  function hitLoop() {
    if (loopCooldown > 0) return;
    loopCooldown = 1.6; loopFlash = 0.6;
    mult = Math.min(9, mult + 1);
    award(5000);
    setStatus('ORBIT RAMP - MULTIPLIER X' + mult, 2000);
    sndLoop();
  }

  /* ==================================================================== */
  /* ============================ PHYSICS =============================== */
  /* ==================================================================== */

  function flipperTip(f) {
    return { x: f.px + Math.cos(f.angle) * f.len, y: f.py + Math.sin(f.angle) * f.len };
  }

  function updateFlipper(f, h) {
    var goal = f.pressed ? f.upAngle : f.restAngle;
    var delta = goal - f.angle;
    var sp = ((delta * f.sign) > 0) ? FLIP_UP_W : FLIP_DOWN_W;
    if (Math.abs(delta) <= sp * h + 1e-9) {
      f.angle = goal;
      f.omega = h > 0 ? delta / h : 0;
    } else {
      f.angle += (delta > 0 ? 1 : -1) * sp * h;
      f.omega = (delta > 0 ? sp : -sp);
    }
  }

  function segClosest(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return { x: ax + dx * t, y: ay + dy * t, t: t };
  }

  function collideSeg(s) {
    if (s.gate && ball.vy <= 0 && ball.y > s.ay) return false;  // one-way
    var c = segClosest(ball.x, ball.y, s.ax, s.ay, s.bx, s.by);
    var nx = ball.x - c.x, ny = ball.y - c.y;
    var d2 = nx * nx + ny * ny;
    var rr = BALL_R + s.thick;
    if (d2 > rr * rr) return false;
    var d = Math.sqrt(d2);
    if (d < 1e-4) { nx = s.nx; ny = s.ny; d = 1e-4; } else { nx /= d; ny /= d; }

    var pen = rr - d;
    if (pen > 0) { ball.x += nx * pen; ball.y += ny * pen; }

    var vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      var rest = Math.abs(vn) < 48 ? 0 : s.rest;
      var newVn = -vn * rest;
      var tvx = ball.vx - vn * nx, tvy = ball.vy - vn * ny;
      tvx *= (1 - s.fric); tvy *= (1 - s.fric);
      ball.vx = tvx + nx * newVn;
      ball.vy = tvy + ny * newVn;
      if (s.kick > 0) {
        var vn2 = ball.vx * nx + ball.vy * ny;
        if (vn2 < s.kick) { ball.vx += nx * (s.kick - vn2); ball.vy += ny * (s.kick - vn2); }
        if (s.kind === 'sling') hitSling(s.id);
      }
      if (s.kind === 'wall' && Math.abs(vn) > 260) sfx('wall', 300, 18, 110);
    }
    ball.contact = true;
    return true;
  }

  function collideCircle(c) {
    var nx = ball.x - c.x, ny = ball.y - c.y;
    var d2 = nx * nx + ny * ny, rr = BALL_R + c.r;
    if (d2 > rr * rr) return false;
    var d = Math.sqrt(d2);
    if (d < 1e-4) { nx = 0; ny = -1; d = 1e-4; } else { nx /= d; ny /= d; }
    ball.x = c.x + nx * rr;
    ball.y = c.y + ny * rr;
    var vn = ball.vx * nx + ball.vy * ny;
    var target = c.kick;
    if (vn < 0 && -vn * c.rest > target) target = Math.min(-vn * c.rest, 700);
    if (vn < target) {
      ball.vx += nx * (target - vn);
      ball.vy += ny * (target - vn);
      hitBumper(c);
    }
    ball.contact = true;
    return true;
  }

  function collideFlipper(f, h) {
    var prev = f.angle - f.omega * h;
    var best = null, k;
    for (k = 0; k <= 3; k++) {
      var a = prev + (f.angle - prev) * (k / 3);
      var tx = f.px + Math.cos(a) * f.len, ty = f.py + Math.sin(a) * f.len;
      var c = segClosest(ball.x, ball.y, f.px, f.py, tx, ty);
      var nx = ball.x - c.x, ny = ball.y - c.y;
      var d2 = nx * nx + ny * ny, rr = BALL_R + FLIP_RAD;
      if (d2 <= rr * rr) {
        var d = Math.sqrt(d2) || 1e-4;
        var pen = rr - d;
        if (!best || pen > best.pen) best = { pen: pen, nx: nx / d, ny: ny / d, cx: c.x, cy: c.y };
      }
    }
    if (!best) return false;

    ball.x += best.nx * best.pen;
    ball.y += best.ny * best.pen;

    // velocity of the rotating flipper surface at the contact point
    var rx = best.cx - f.px, ry = best.cy - f.py;
    var svx = -f.omega * ry, svy = f.omega * rx;
    var rvx = ball.vx - svx, rvy = ball.vy - svy;
    var vn = rvx * best.nx + rvy * best.ny;
    if (vn < 0) {
      var rest = Math.abs(vn) < 90 ? 0.05 : 0.52;
      var newVn = -vn * rest;
      var tx2 = -best.ny, ty2 = best.nx;
      var vt = (rvx * tx2 + rvy * ty2) * 0.94;
      rvx = best.nx * newVn + tx2 * vt;
      rvy = best.ny * newVn + ty2 * vt;
      ball.vx = rvx + svx;
      ball.vy = rvy + svy;
      if (Math.abs(f.omega) > 6 && Math.abs(vn) > 60) { sndFlip(); award(25); }
    }
    ball.contact = true;
    return true;
  }

  function collidePlunger() {
    if (ball.x < LANE_L - 2) return;
    var tipY = PLUNGE_REST_Y - plungerPower * (PLUNGE_REST_Y - PLUNGE_TOP_Y);
    var ny = ball.y - tipY, rr = BALL_R + 2;
    if (ny > 0 && ny < rr) {
      ball.y = tipY - rr;
      if (ball.vy > 0) ball.vy *= -0.1;
    }
  }

  function substep(h) {
    var i;
    if (tiltTimer <= 0) {
      updateFlipper(flippers[0], h);
      updateFlipper(flippers[1], h);
    } else {
      flippers[0].omega = 0; flippers[1].omega = 0;
    }

    ball.vy += GRAVITY * h;
    var damp = 1 - AIR_DAMP * h;
    ball.vx *= damp; ball.vy *= damp;
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;

    ball.contact = false;
    for (i = 0; i < segs.length; i++) collideSeg(segs[i]);
    for (i = 0; i < circles.length; i++) collideCircle(circles[i]);
    if (tiltTimer <= 0) {
      collideFlipper(flippers[0], h);
      collideFlipper(flippers[1], h);
    }
    collidePlunger();

    if (ball.contact) { var k2 = 1 - ROLL_DAMP * h; ball.vx *= k2; ball.vy *= k2; }
    var sp = vlen(ball.vx, ball.vy);
    if (sp > MAX_SPEED) { ball.vx *= MAX_SPEED / sp; ball.vy *= MAX_SPEED / sp; }
  }

  function physics(dt) {
    var i;
    if (mode === 'ready') {
      // ball parked in the plunger lane: the plunger and nudges still act
      ball.vy += GRAVITY * dt;
      ball.x += ball.vx * dt; ball.y += ball.vy * dt;
      ball.vx *= (1 - 4 * dt); ball.vy *= (1 - 6 * dt);
      ball.vx += (PLUNGE_X - ball.x) * 14 * dt;
      updateFlipper(flippers[0], dt);
      updateFlipper(flippers[1], dt);
      collideSeg(laneSegs[1]);
      collideSeg(laneSegs[0]);
      collideSeg(laneSegs[3]);
      collidePlunger();
      if (ball.y > PLUNGE_REST_Y - BALL_R) { ball.y = PLUNGE_REST_Y - BALL_R; ball.vy = 0; }
      return;
    }
    var speed = vlen(ball.vx, ball.vy) + GRAVITY * dt * 0.5;
    var steps = Math.ceil(speed * dt / (BALL_R * 0.45));
    if (steps < 1) steps = 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    var h = dt / steps;
    for (i = 0; i < steps; i++) substep(h);
  }

  function launchBall(power) {
    if (mode !== 'ready') return;
    var v = LAUNCH_MIN + clamp(power, 0, 1) * (LAUNCH_MAX - LAUNCH_MIN);
    ball.vy = -v;
    ball.vx = (Math.random() - 0.5) * 14;
    mode = 'play';
    sndLaunch();
    setStatus('', 0);
  }

  /* ==================================================================== */
  /* ============================ SENSORS =============================== */
  /* ==================================================================== */

  function sensors(dt) {
    var i;
    for (i = 0; i < 10; i++) if (padCooldown[i] > 0) padCooldown[i] -= dt;
    if (loopCooldown > 0) loopCooldown -= dt;
    for (i = 0; i < 3; i++) if (bumperLit[i] > 0) bumperLit[i] -= dt;
    for (i = 0; i < 2; i++) if (slingFlash[i] > 0) slingFlash[i] -= dt;
    if (loopFlash > 0) loopFlash -= dt;
    if (statusTimer > 0) { statusTimer -= dt; if (statusTimer <= 0) statusMsg = ''; }
    animClock += dt;

    if (nudgeCount > 0) { nudgeDecay += dt; if (nudgeDecay > 2.5) { nudgeDecay = 0; nudgeCount--; } }
    if (tiltTimer > 0) tiltTimer -= dt;

    if (mode !== 'play') return;

    for (i = 0; i < 10; i++) {
      if (padCooldown[i] > 0) continue;
      var cx = ROLL_CX[i];
      // generous tolerance: the pads form one continuous rollover bank
      if (ball.x > cx - ROLL_W / 2 - 5 && ball.x < cx + ROLL_W / 2 + 5 &&
          ball.y > ROLL_TOP - 6 && ball.y < ROLL_TOP + ROLL_H + 6) hitLetter(i);
    }

    var dx = ball.x - LOOP_SENSOR.x, dy = ball.y - LOOP_SENSOR.y;
    var rr = LOOP_SENSOR.r + BALL_R * 0.4;
    if (dx * dx + dy * dy < rr * rr) hitLoop();

    if (ball.y > DRAIN_Y) { drainBall(); return; }

    var sp = vlen(ball.vx, ball.vy);
    if (sp < 26) {
      stuckTimer += dt;
      if (stuckTimer > 1.4) {
        stuckTimer = 0;
        if (ball.y < 130) {
          // wedged on the ramp / one-way gate: push it back around the loop
          ball.vx = -240; ball.vy = -60;
          setStatus('BALL FREED', 900);
        } else {
          ball.vx += (Math.random() - 0.5) * 300;
          ball.vy -= 110;
        }
      }
    } else stuckTimer = 0;

    if (ball.x < -40 || ball.x > TW + 40 || ball.y < -90) {
      ball.x = PLUNGE_X; ball.y = PLUNGE_REST_Y - BALL_R;
      ball.vx = 0; ball.vy = 0; mode = 'ready';
    }
  }

  /* ==================================================================== */
  /* ============================== INPUT =============================== */
  /* ==================================================================== */

  function keysActive() {
    if (focused) return true;
    var ae = document.activeElement;
    return !ae || ae === document.body || ae === win.el || (win.el.contains && win.el.contains(ae));
  }

  function onKeyDown(e) {
    if (disposed) return;
    var code = e.keyCode, key = e.key || '';
    var used = true;
    try {
      if (code === 37 || key === 'ArrowLeft' || key === 'z' || key === 'Z') {
        flippers[0].pressed = true;
      } else if (code === 39 || key === 'ArrowRight' || key === '/' || key === '?') {
        flippers[1].pressed = true;
      } else if (code === 32 || code === 17 || key === ' ' || key === 'Control') {
        if (mode === 'ready') { plungeHeld = true; }
        else if (mode === 'play' && !e.repeat && code === 32) { tryNudge(0, -1); }
      } else if (code === 80 || key === 'p' || key === 'P') {
        togglePause();
      } else if (code === 77 || key === 'm' || key === 'M') {
        toggleMute();
      } else if (code === 113) {
        newGame();
      } else if (code === 13 || key === 'Enter') {
        if (mode === 'gameover') newGame();
      } else {
        used = false;
      }
    } catch (err) {}
    if (used && keysActive() && e.preventDefault) e.preventDefault();
  }

  function onKeyUp(e) {
    if (disposed) return;
    var code = e.keyCode, key = e.key || '';
    try {
      if (code === 37 || key === 'ArrowLeft' || key === 'z' || key === 'Z') flippers[0].pressed = false;
      else if (code === 39 || key === 'ArrowRight' || key === '/' || key === '?') flippers[1].pressed = false;
      else if (code === 32 || code === 17 || key === ' ' || key === 'Control') {
        if (plungeHeld) { plungeHeld = false; if (mode === 'ready') launchBall(plungerPower); }
      }
    } catch (err) {}
  }

  function canvasPos(e) {
    var r = canvas.getBoundingClientRect();
    if (!r || !r.width) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) * (TW / r.width), y: (e.clientY - r.top) * (TH / r.height) };
  }

  function onMouseDown(e) {
    if (disposed) return;
    try {
      var p = canvasPos(e);
      if (mode === 'gameover') {
        var o = overlayRect;
        if (p.x > o.x && p.x < o.x + o.w && p.y > o.y + PF_Y && p.y < o.y + o.h + PF_Y) newGame();
        return;
      }
      if (p.x > LANE_L - 8 && p.y > PF_Y) { plungeHeld = true; mousePlunge = true; }
      else if (p.x < TW / 2) flippers[0].pressed = true;
      else flippers[1].pressed = true;
      mouseDown = true;
      if (e.preventDefault) e.preventDefault();
      if (win.focus) win.focus();
    } catch (err) {}
  }

  var mouseDown = false, mousePlunge = false;

  function onMouseUp() {
    try {
      flippers[0].pressed = false;
      flippers[1].pressed = false;
      if (mousePlunge) {
        mousePlunge = false;
        plungeHeld = false;
        if (mode === 'ready') launchBall(plungerPower);
      }
      mouseDown = false;
    } catch (err) {}
  }

  function onWindowBlur() {
    flippers[0].pressed = false;
    flippers[1].pressed = false;
  }

  function togglePause() {
    paused = !paused;
    setStatus(paused ? 'PAUSED' : '', paused ? 900000 : 0);
    if (!paused) lastTick = 0;      // resync the clock: nothing teleports
  }
  function toggleMute() {
    muted = !muted;
    if (window.__pinballDebug) window.__pinballDebug.muted = muted;
    setStatus(muted ? 'SOUND OFF' : 'SOUND ON', 1200);
  }

  /* ==================================================================== */
  /* ============================== DRAWING ============================= */
  /* ==================================================================== */

  var BAY = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  function ditherFill(g, x, y, w, h, cA, cB, t0, t1, vertical) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var t = vertical ? (j / (h || 1)) : (i / (w || 1));
        var k = t0 + (t1 - t0) * t;
        g.fillStyle = (k > (BAY[j & 3][i & 3] + 0.5) / 16) ? cB : cA;
        g.fillRect(x + i, y + j, 1, 1);
      }
    }
  }
  // hard-edged chrome band: 4 dithered steps, no gradients
  function chromeV(g, x, y, w, h, cols) {
    var n = cols.length - 1, seg = Math.max(1, Math.floor(h / n));
    for (var i = 0; i < n; i++) {
      var yy = y + i * seg;
      var hh = (i === n - 1) ? (y + h - yy) : seg;
      if (hh <= 0) continue;
      ditherFill(g, x, yy, w, hh, cols[i], cols[i + 1], 0, 1, true);
    }
  }
  function chromeH(g, x, y, w, h, cols) {
    var n = cols.length - 1, seg = Math.max(1, Math.floor(w / n));
    for (var i = 0; i < n; i++) {
      var xx = x + i * seg;
      var ww = (i === n - 1) ? (x + w - xx) : seg;
      if (ww <= 0) continue;
      ditherFill(g, xx, y, ww, h, cols[i], cols[i + 1], 0, 1, false);
    }
  }

  function disc(g, x, y, r, col) { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }

  function ribbon(g, pts, side, thick, fill) {
    var n = pts.length, out = [], i;
    for (i = 0; i < n; i++) {
      var nx = 0, ny = 0;
      if (i > 0) {
        var dx1 = pts[i][0] - pts[i - 1][0], dy1 = pts[i][1] - pts[i - 1][1];
        var l1 = vlen(dx1, dy1) || 1; nx += dy1 / l1; ny += -dx1 / l1;
      }
      if (i < n - 1) {
        var dx2 = pts[i + 1][0] - pts[i][0], dy2 = pts[i + 1][1] - pts[i][1];
        var l2 = vlen(dx2, dy2) || 1; nx += dy2 / l2; ny += -dx2 / l2;
      }
      var ln = vlen(nx, ny) || 1;
      out.push([pts[i][0] + side * nx / ln * thick, pts[i][1] + side * ny / ln * thick]);
    }
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
    for (i = n - 1; i >= 0; i--) g.lineTo(out[i][0], out[i][1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  }

  function chromeRail(g, pts, side) {
    ribbon(g, pts, side, 8, '#0a0e20');
    ribbon(g, pts, side, 6.5, C.chromeD);
    ribbon(g, pts, side, 5, C.chromeM);
    ribbon(g, pts, side, 2.5, C.chrome);
    ribbon(g, pts, side, 1, '#ffffff');
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokeStyle = '#000000'; g.lineWidth = 1; g.stroke();
  }
  function thinRail(g, pts) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.strokeStyle = '#000000'; g.lineWidth = 6; g.stroke();
    g.strokeStyle = C.chromeD; g.lineWidth = 4; g.stroke();
    g.strokeStyle = C.chrome; g.lineWidth = 2; g.stroke();
    g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.stroke();
  }

  /* ---------------------------------------------------- static playfield */

  function drawPlayfieldStatic(g) {
    var i;

    /* navy base with hard dithered bands */
    ditherFill(g, 8, 0, TW - 16, PF_H, C.navyL, C.navy, 0.0, 1.0, true);
    ditherFill(g, 8, 300, TW - 16, PF_H - 300, C.navy, C.navyD, 0.0, 1.0, true);
    ditherFill(g, 8, 0, TW - 16, 40, C.navyD, C.navyL, 0.0, 1.0, true);
    ditherFill(g, 8, 0, 90, PF_H, C.purpleD, C.purple, 0.0, 1.0, false);
    ditherFill(g, 210, 0, TW - 218, PF_H, C.purpleD, C.purple, 0.0, 1.0, false);

    /* painted starfield */
    var seed = 20250930;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var s = 0; s < 190; s++) {
      var sx = (10 + rnd() * (TW - 20)) | 0, sy = (24 + rnd() * (PF_H - 70)) | 0, b = rnd();
      g.fillStyle = b > 0.88 ? '#ffffff' : (b > 0.62 ? '#8fa8e8' : '#3a54a8');
      g.fillRect(sx, sy, 1, 1);
    }

    /* painted nebula bands (hard dither, no blur) */
    ditherFill(g, 18, 150, 120, 70, C.navy, C.purple, 0.0, 1.0, true);
    ditherFill(g, 160, 96, 110, 60, C.navy, C.purple, 0.6, 0.0, true);

    /* painted planet with a ring (upper left) */
    disc(g, 64, 250, 42, '#101c52');
    disc(g, 60, 244, 40, '#1b2f80');
    disc(g, 54, 236, 30, '#2a44a4');
    disc(g, 46, 228, 18, '#3d5cc4');
    g.fillStyle = '#1b2f80';
    g.fillRect(20, 258, 88, 3);
    g.fillRect(24, 268, 80, 2);
    g.strokeStyle = '#5c78d8'; g.lineWidth = 2;
    g.beginPath(); g.ellipse(64, 250, 60, 17, -0.30, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#20347e'; g.lineWidth = 3;
    g.beginPath(); g.ellipse(64, 250, 66, 21, -0.30, 0, Math.PI * 2); g.stroke();

    /* painted space station / rocket (centre of the playfield) */
    g.fillStyle = '#101c52';
    g.beginPath();
    g.moveTo(150, 214); g.lineTo(163, 244); g.lineTo(163, 276); g.lineTo(137, 276); g.lineTo(137, 244);
    g.closePath(); g.fill();
    g.fillStyle = '#22367e';
    g.fillRect(139, 250, 22, 26);
    g.fillStyle = '#3d5cc4';
    g.fillRect(144, 256, 12, 8);
    g.fillStyle = '#101c52';
    g.fillRect(122, 258, 16, 6); g.fillRect(162, 258, 16, 6);
    g.fillStyle = '#2a3f92';
    g.fillRect(128, 275, 10, 12); g.fillRect(162, 275, 10, 12);

    /* painted emblem rings */
    g.strokeStyle = '#17276e'; g.lineWidth = 3;
    g.beginPath(); g.arc(150, 210, 122, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#20347e'; g.lineWidth = 2;
    g.beginPath(); g.arc(150, 210, 108, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(150, 210, 70, 0, Math.PI * 2); g.stroke();

    /* painted SPACE CADET lettering across the lower playfield */
    drawText(g, 'SPACE', 98, 306, 3, '#17276e');
    drawText(g, 'CADET', 98, 330, 3, '#17276e');
    drawText(g, 'SPACE', 97, 305, 3, '#2a44a4');
    drawText(g, 'CADET', 97, 329, 3, '#2a44a4');
    drawText(g, 'PINBALL', 118, 84, 2, '#2a44a4');

    /* green / blue ORBIT RAMP band along the top */
    var band = [];
    var hullBand = [[8, 96], [30, 54], [96, 36], [184, 36], [250, 46], [292, 80]];
    var arcBand = [[58, 76], [110, 64], [162, 64], [204, 72], [242, 88], [268, 108]];
    for (i = 0; i < hullBand.length; i++) band.push(hullBand[i]);
    for (i = 0; i < arcBand.length; i++) band.push(arcBand[i]);
    g.beginPath();
    g.moveTo(band[0][0], band[0][1]);
    for (i = 1; i < band.length; i++) g.lineTo(band[i][0], band[i][1]);
    g.closePath();
    g.fillStyle = C.greenRampD; g.fill();
    // inner blue strip + green highlight, drawn as clipped bands
    g.save();
    g.clip();
    ditherFill(g, 8, 36, TW - 16, 22, C.greenRampD, C.greenRamp, 0.0, 1.0, true);
    ditherFill(g, 8, 58, TW - 16, 22, C.blueRampD, C.blueRamp, 0.0, 1.0, true);
    ditherFill(g, 8, 80, TW - 16, 34, C.greenRampD, '#062a18', 0.0, 1.0, true);
    g.restore();
    g.strokeStyle = '#000000'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(8, 96);
    g.lineTo(30, 54); g.lineTo(96, 36); g.lineTo(184, 36); g.lineTo(250, 46); g.lineTo(292, 80);
    g.lineTo(268, 108); g.lineTo(242, 88); g.lineTo(204, 72); g.lineTo(162, 64); g.lineTo(110, 64); g.lineTo(58, 76);
    g.closePath();
    g.stroke();

    /* launch lane: chrome channel */
    chromeH(g, LANE_L, GATE_Y - 4, LANE_R - LANE_L, LANE_FLOOR_Y - GATE_Y + 4,
            [C.chromeD, C.chromeM, C.chrome, C.chromeM, C.chromeD]);
    g.fillStyle = '#000000';
    for (var ly = GATE_Y + 8; ly < LANE_FLOOR_Y; ly += 20) g.fillRect(LANE_L + 2, ly, LANE_R - LANE_L - 4, 1);

    /* outlanes: dark chrome funnels */
    chromeH(g, 8, OUTLANE_TOP_Y, OUTLANE_L_X - 8, 34, ['#151c3c', '#2a3a6c', '#4a5c94']);
    g.fillStyle = '#05091c';
    g.fillRect(8, OUTLANE_TOP_Y + 34, OUTLANE_L_X - 8, OUTLANE_BOT_Y - OUTLANE_TOP_Y - 34);
    chromeH(g, OUTLANE_R_X, OUTLANE_TOP_Y, LANE_L - OUTLANE_R_X, 34, ['#151c3c', '#2a3a6c', '#4a5c94']);
    g.fillStyle = '#05091c';
    g.fillRect(OUTLANE_R_X, OUTLANE_TOP_Y + 34, LANE_L - OUTLANE_R_X, OUTLANE_BOT_Y - OUTLANE_TOP_Y - 34);

    /* centre drain mouth */
    ditherFill(g, OUTLANE_L_X, 356, OUTLANE_R_X - OUTLANE_L_X, 48, '#05091c', '#000000', 0.0, 1.0, true);
    drawText(g, 'DRAIN', 130, 364, 1, '#2a3f92');
    for (i = 0; i < 5; i++) {
      drawText(g, '>', 48 + i * 5, 374 + (i % 2) * 3, 1, '#22367e');
      drawText(g, '<', 240 - i * 5, 374 + (i % 2) * 3, 1, '#22367e');
    }

    /* pop bumper bases */
    for (i = 0; i < BUMPERS.length; i++) {
      var b = BUMPERS[i];
      disc(g, b.x + 1, b.y + 2, b.r + 3, '#05091c');
      disc(g, b.x, b.y, b.r + 3, C.chromeD);
      disc(g, b.x, b.y, b.r + 2, C.chromeM);
      disc(g, b.x, b.y, b.r, '#3a0a0a');
      disc(g, b.x, b.y, b.r - 4, '#160303');
    }

    /* rollover pads (unlit) */
    for (i = 0; i < 10; i++) {
      var px = ROLL_CX[i] - ROLL_W / 2;
      g.fillStyle = '#05091c';
      g.fillRect(px - 1, ROLL_TOP - 1, ROLL_W + 2, ROLL_H + 2);
      g.fillStyle = '#1a2350';
      g.fillRect(px, ROLL_TOP, ROLL_W, ROLL_H);
      g.fillStyle = '#0b1030';
      g.fillRect(px + 1, ROLL_TOP + 1, ROLL_W - 2, ROLL_H - 2);
    }

    /* chrome rails */
    chromeRail(g, HULL, 1);
    chromeRail(g, [[268, 108], [242, 88], [204, 72], [162, 64], [110, 64], [58, 76]], 1);
    thinRail(g, [[OUTLANE_L_X, OUTLANE_TOP_Y], [OUTLANE_L_X, OUTLANE_BOT_Y]]);
    thinRail(g, [[OUTLANE_R_X, OUTLANE_TOP_Y], [OUTLANE_R_X, OUTLANE_BOT_Y]]);
    thinRail(g, [[LANE_L, GATE_Y], [LANE_L, LANE_FLOOR_Y]]);
    thinRail(g, [[LANE_L, LANE_FLOOR_Y], [LANE_R, LANE_FLOOR_Y]]);

    drawSlingStatic(g, SLING_L);
    drawSlingStatic(g, SLING_R);

    drawText(g, 'OUT', 12, 262, 1, '#3a54a8');
    drawText(g, 'LANE', 12, 272, 1, '#3a54a8');
    drawText(g, 'OUT', 244, 262, 1, '#3a54a8');
    drawText(g, 'LANE', 244, 272, 1, '#3a54a8');

    /* ramp chevrons inside the ORBIT RAMP channel */
    for (i = 0; i < 4; i++) {
      var ax = 100 - i * 18;
      drawText(g, '<', ax, 50, 2, '#5cd890');
    }
    drawText(g, 'ORBIT RAMP', 150, 46, 1, '#5cd890');

    /* ramp throat markings: entry from the launch lane, return into play */
    drawText(g, 'RAMP', 226, 120, 1, '#5cd890');
    drawText(g, 'ENTRY', 226, 130, 1, '#3a8c60');
    drawText(g, 'RAMP', 92, 78, 1, '#5cd890');
    drawText(g, 'RETURN', 86, 88, 1, '#3a8c60');
    g.fillStyle = '#0a5c34';
    for (i = 0; i < 3; i++) g.fillRect(60 + i * 9, 96 + i * 2, 14, 3);

    /* one-way gate label */
    drawText(g, 'ONE WAY', LANE_L + 2, GATE_Y + 2, 1, '#8fa8e8');
  }

  function drawSlingStatic(g, T) {
    g.beginPath();
    g.moveTo(T[0][0], T[0][1]); g.lineTo(T[2][0], T[2][1]); g.lineTo(T[1][0], T[1][1]);
    g.closePath();
    g.fillStyle = '#101c52'; g.fill();
    g.strokeStyle = C.chromeM; g.lineWidth = 3; g.stroke();
    g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.stroke();
    g.fillStyle = '#1b2f80';
    g.fillRect(T[0][0] - 2, T[0][1] + 8, 5, T[1][1] - T[0][1] - 16);
  }

  /* ------------------------------------------------------- static HUD */

  function drawHudStatic(g) {
    // bezel
    g.fillStyle = '#000000'; g.fillRect(0, 0, TW, HUD_H);
    g.fillStyle = '#1a1a2a'; g.fillRect(1, 1, TW - 2, 1);
    g.fillStyle = C.chromeM; g.fillRect(1, 2, TW - 2, 1);
    g.fillStyle = C.face; g.fillRect(1, 3, TW - 2, 1);
    g.fillStyle = '#000000'; g.fillRect(1, 4, TW - 2, HUD_H - 5);

    // dot-matrix substrate
    var xx, yy;
    for (yy = 6; yy < HUD_H - 3; yy += 3) {
      for (xx = 3; xx < TW - 3; xx += 3) {
        g.fillStyle = ((xx + yy) % 6 === 0) ? '#170606' : '#100404';
        g.fillRect(xx, yy, 1, 1);
      }
    }
    g.fillStyle = '#000000'; g.fillRect(1, HUD_H - 2, TW - 2, 2);

    // fixed labels
    drawText(g, 'SCORE', 7, 7, 1, C.ledDim);
    drawText(g, 'SPACE CADET', 126, 7, 1, C.ledDim);
    drawText(g, 'MULTIPLIER', 212, 19, 1, C.ledDim);
    drawText(g, 'HIGH', 212, 31, 1, C.ledDim);
    drawText(g, 'PLAYER 1', 7, 42, 1, '#4a1008');
    drawText(g, 'NUDGE', 62, 42, 1, '#4a1008');
    drawText(g, 'BALLS', 212, 7, 1, C.ledDim);

    g.fillStyle = '#2a0a04';
    g.fillRect(128, 16, 78, 1);
    g.fillRect(128, 29, 78, 1);
  }

  /* ------------------------------------------------------------ frame */

  function render() {
    var g = ctx, s = scale, i;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, TW * s, TH * s);
    g.setTransform(s, 0, 0, s, 0, 0);
    g.drawImage(staticCv, 0, 0, TW, TH);

    g.save();
    g.translate(0, PF_Y);

    /* rollover pads */
    for (i = 0; i < 10; i++) {
      var px = ROLL_CX[i] - ROLL_W / 2;
      var on = padLit[i];
      g.fillStyle = on ? '#ffd830' : '#1c2450';
      g.fillRect(px, ROLL_TOP, ROLL_W, ROLL_H);
      g.fillStyle = on ? '#ff6020' : '#2a3a7c';
      g.fillRect(px + 1, ROLL_TOP + 1, ROLL_W - 2, ROLL_H - 2);
      g.fillStyle = on ? '#fff0b0' : '#101a44';
      g.fillRect(px + 3, ROLL_TOP + 3, ROLL_W - 6, ROLL_H - 6);
      var li = (i < 5) ? i : i + 1;
      var ch = (i === 5) ? 'C' : LETTERS.charAt(li);
      drawText(g, ch, px + 5, ROLL_TOP - 9, 1, on ? '#fff0b0' : '#4a5c94');
    }

    /* orbit ramp chevrons */
    for (i = 0; i < 4; i++) {
      var ax = 100 - i * 18;
      var lit = loopFlash > 0 ? '#ffe06a' : (((animClock * 3 + i * 0.4) % 1) < 0.5 ? '#8cf0b4' : '#3a8c60');
      drawText(g, '<', ax, 50, 2, lit);
    }
    drawText(g, 'ORBIT RAMP', 150, 46, 1, loopFlash > 0 ? '#ffe06a' : '#5cd890');

    /* slingshot rubbers */
    for (i = 0; i < 2; i++) {
      var T = (i === 0) ? SLING_L : SLING_R;
      var fl = slingFlash[i] > 0;
      g.beginPath();
      g.moveTo(T[0][0], T[0][1]); g.lineTo(T[2][0], T[2][1]); g.lineTo(T[1][0], T[1][1]);
      g.closePath();
      g.fillStyle = fl ? '#ffe06a' : '#e8e8f0';
      g.fill();
      g.strokeStyle = fl ? '#ffffff' : C.chromeM;
      g.lineWidth = 2; g.stroke();
      g.strokeStyle = '#000000'; g.lineWidth = 1; g.stroke();
      g.fillStyle = fl ? '#d02020' : '#101c52';
      g.beginPath();
      g.moveTo(T[0][0] + 3, T[0][1] + 7);
      g.lineTo(T[2][0] - 3, T[2][1]);
      g.lineTo(T[1][0] + 3, T[1][1] - 7);
      g.closePath(); g.fill();
    }

    /* pop bumpers: red body, yellow ring, chrome cap */
    for (i = 0; i < BUMPERS.length; i++) {
      var b = BUMPERS[i];
      var lit = bumperLit[i] > 0;
      var spin = ((animClock * 2 + i * 0.33) % 1) < 0.5;
      disc(g, b.x, b.y, b.r + 3, C.chromeM);
      disc(g, b.x, b.y, b.r + 1, lit ? '#ffe06a' : C.bumpYelD);
      disc(g, b.x, b.y, b.r - 1, lit ? '#fff0b0' : C.bumpYel);
      disc(g, b.x, b.y, b.r - 5, lit ? '#ff8060' : C.bumpRed);
      disc(g, b.x, b.y, b.r - 8, lit ? '#fffbe0' : C.bumpRedD);
      g.strokeStyle = '#000000'; g.lineWidth = 1;
      g.beginPath(); g.arc(b.x, b.y, b.r + 3, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(b.x, b.y, b.r - 5, 0, Math.PI * 2); g.stroke();
      // cap posts
      g.fillStyle = lit ? '#ffffff' : C.chrome;
      g.fillRect(b.x - 1, b.y - b.r - 4, 2, b.r + 4);
      g.fillRect(b.x - 1, b.y, 2, b.r + 4);
      // rotating beacon (hard 2-state, no blur)
      g.fillStyle = lit ? '#ffffff' : (spin ? C.bumpYel : C.bumpYelD);
      disc(g, b.x, b.y - 2, 2, spin ? '#ffffff' : '#ffd830');
    }

    /* one-way gate flap */
    g.fillStyle = '#000000'; g.fillRect(LANE_L + 1, GATE_Y - 7, LANE_R - LANE_L - 2, 3);
    g.fillStyle = C.chrome; g.fillRect(LANE_L + 1, GATE_Y - 7, LANE_R - LANE_L - 2, 1);
    g.fillStyle = C.chromeD; g.fillRect(LANE_L + 1, GATE_Y - 5, LANE_R - LANE_L - 2, 1);

    /* plunger */
    var tipY = PLUNGE_REST_Y - plungerPower * (PLUNGE_REST_Y - PLUNGE_TOP_Y);
    g.fillStyle = '#000000'; g.fillRect(PLUNGE_X - 9, tipY, 18, 7);
    g.fillStyle = plungerPower > 0.02 ? C.bumpYel : C.chromeM;
    g.fillRect(PLUNGE_X - 8, tipY + 1, 16, 5);
    g.fillStyle = '#ffffff'; g.fillRect(PLUNGE_X - 8, tipY + 1, 16, 1);
    g.fillStyle = C.chromeD; g.fillRect(PLUNGE_X - 2, tipY + 7, 4, PLUNGE_REST_Y - tipY);
    g.fillStyle = '#000000'; g.fillRect(PLUNGE_X - 7, PLUNGE_REST_Y - 4, 14, 5);
    g.fillStyle = C.chromeM; g.fillRect(PLUNGE_X - 6, PLUNGE_REST_Y - 3, 12, 3);

    /* plunger power meter */
    if (plungerPower > 0.02) {
      g.fillStyle = '#000000'; g.fillRect(LANE_L + 2, 296, 8, 94);
      g.fillStyle = '#2a0a04'; g.fillRect(LANE_L + 3, 297, 6, 92);
      var ph = Math.round(plungerPower * 88);
      for (var q = 0; q < ph; q += 3) {
        g.fillStyle = (q / 88) > 0.72 ? C.ledOn : '#ffb020';
        g.fillRect(LANE_L + 4, 387 - q, 4, 2);
      }
    }

    for (i = 0; i < 2; i++) drawFlipper(g, flippers[i]);
    drawBall(g);

    g.restore();

    drawHudDynamic(g);

    if (mode === 'gameover') drawGameOver(g);
    else if (paused) drawBanner(g, 'PAUSED', 'PRESS P TO RESUME');
    else if (tiltTimer > 0) drawBanner(g, 'TILT', 'NO BONUS');
    else if (mode === 'ready' && statusTimer <= 0) {
      drawText(g, 'HOLD SPACE OR CTRL TO', 88, PF_Y + 300, 1, '#ffe06a');
      drawText(g, 'CHARGE THE PLUNGER', 98, PF_Y + 310, 1, '#ffe06a');
    }
  }

  function drawFlipper(g, f) {
    var tip = flipperTip(f);
    var nx = Math.cos(f.angle + Math.PI / 2), ny = Math.sin(f.angle + Math.PI / 2);
    var w0 = 6.5, w1 = 3.2;
    g.beginPath();
    g.moveTo(f.px + nx * w0, f.py + ny * w0);
    g.lineTo(tip.x + nx * w1, tip.y + ny * w1);
    g.lineTo(tip.x - nx * w1, tip.y - ny * w1);
    g.lineTo(f.px - nx * w0, f.py - ny * w0);
    g.closePath();
    g.fillStyle = f.pressed ? '#ffe06a' : C.chrome;
    g.fill();
    g.strokeStyle = '#000000'; g.lineWidth = 1; g.stroke();
    g.beginPath();
    g.moveTo(f.px + (tip.x - f.px) * 0.08, f.py + (tip.y - f.py) * 0.08);
    g.lineTo(f.px + (tip.x - f.px) * 0.9, f.py + (tip.y - f.py) * 0.9);
    g.strokeStyle = f.pressed ? '#d02020' : C.chromeD;
    g.lineWidth = 2; g.stroke();
    disc(g, f.px, f.py, 3, '#000000');
    disc(g, f.px, f.py, 2, C.chromeM);
  }

  function drawBall(g) {
    if (!ballInPlay) return;
    var x = ball.x, y = ball.y;
    disc(g, x, y, BALL_R, C.ball);
    g.strokeStyle = C.ballEdge;
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, BALL_R - 0.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#f0f0f4';
    g.fillRect(Math.round(x - 3), Math.round(y - 4), 3, 2);
  }

  function drawHudDynamic(g) {
    var i, blink;
    var sc = String(Math.min(score, 9999999));
    while (sc.length < 7) sc = '0' + sc;
    drawNumber7(g, sc, 7, 15, 1, C.ledOn, C.ledOff);

    /* ball pips */
    for (i = 0; i < 3; i++) {
      var on = i < ballsLeft;
      disc(g, 216 + i * 11, 12, 4, on ? C.ledOn : C.ledOff);
      if (on) { disc(g, 215 + i * 11, 11, 1, '#ffb0a0'); }
    }

    /* multiplier */
    drawText(g, 'X' + mult, 262, 19, 1, mult > 1 ? '#ffd830' : C.ledOn);

    /* high score */
    var hs = String(Math.min(highScore, 9999999));
    while (hs.length < 7) hs = '0' + hs;
    drawText(g, hs, 212, 31, 1, C.ledDim);

    /* SPACE CADET letter lamps */
    for (i = 0; i < LETTERS.length; i++) {
      var lit = litLetters[i];
      var slot = 126 + i * 7;
      g.fillStyle = lit ? '#ffd830' : '#180404';
      g.fillRect(slot, 17, 6, 11);
      drawText(g, LETTERS.charAt(i), slot, 19, 1, lit ? '#000000' : C.ledOff);
    }

    /* mission / status text line */
    blink = ((animClock * 3) % 1) < 0.7;
    if (statusMsg && blink) {
      var col = (statusMsg === 'TILT') ? C.ledOn : '#ff9020';
      drawText(g, statusMsg, 126, 33, 1, col);
    }

    /* mute / pause flags */
    if (muted) drawText(g, 'MUTE', 212, 43, 1, C.ledDim);
    else if (paused) drawText(g, 'PAUSE', 212, 43, 1, '#ff9020');
    for (i = 0; i < 3; i++) {
      g.fillStyle = (i < (3 - nudgeCount) || tiltTimer > 0) ? C.ledDim : C.ledOn;
      g.fillRect(100 + i * 7, 42, 5, 6);
    }
  }

  function drawBanner(g, title, sub) {
    var w = 190, h = 52, x = (TW - w) / 2, y = PF_Y + 150;
    g.fillStyle = '#000000';
    g.fillRect(0, PF_Y, TW, PF_H);
    g.save();
    g.globalAlpha = 0.55;
    g.fillStyle = '#000000';
    g.fillRect(0, PF_Y, TW, PF_H);
    g.restore();
    g.fillStyle = C.face; g.fillRect(x, y, w, h);
    g.fillStyle = C.hi; g.fillRect(x, y, w, 1); g.fillRect(x, y, 1, h);
    g.fillStyle = '#000'; g.fillRect(x, y + h - 1, w, 1); g.fillRect(x + w - 1, y, 1, h);
    g.fillStyle = C.shadow; g.fillRect(x + 1, y + h - 2, w - 2, 1); g.fillRect(x + w - 2, y + 1, 1, h - 2);
    drawText(g, title, x + (w - textWidth(title, 2)) / 2, y + 12, 2, '#c00000');
    if (sub) drawText(g, sub, x + (w - textWidth(sub, 1)) / 2, y + 34, 1, '#000000');
  }

  function drawGameOver(g) {
    g.save();
    g.globalAlpha = 0.62;
    g.fillStyle = '#000000';
    g.fillRect(0, PF_Y, TW, PF_H);
    g.restore();

    var o = overlayRect, x = o.x, y = PF_Y + o.y, w = o.w, h = o.h;
    g.fillStyle = '#000000';
    g.fillRect(x + 2, y + 2, w, h);
    g.fillStyle = C.face;
    g.fillRect(x, y, w, h);
    g.fillStyle = C.hi; g.fillRect(x, y, w, 1); g.fillRect(x, y, 1, h);
    g.fillStyle = C.light; g.fillRect(x + 1, y + 1, w - 2, 1); g.fillRect(x + 1, y + 1, 1, h - 2);
    g.fillStyle = '#000'; g.fillRect(x, y + h - 1, w, 1); g.fillRect(x + w - 1, y, 1, h);
    g.fillStyle = C.shadow; g.fillRect(x + 1, y + h - 2, w - 2, 1); g.fillRect(x + w - 2, y + 1, 1, h - 2);

    // classic navy->blue title bar (two hard bands, no CSS gradient)
    g.fillStyle = C.titleA; g.fillRect(x + 2, y + 2, w - 4, 16);
    g.fillStyle = '#1084d0'; g.fillRect(x + 2 + Math.floor((w - 4) * 0.55), y + 2, Math.ceil((w - 4) * 0.45) - 2, 16);
    g.fillStyle = '#ffffff';
    g.font = 'bold 11px Tahoma, "MS Sans Serif", sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText('GAME OVER', x + 5, y + 14);

    drawText(g, 'GAME OVER', x + 76, y + 24, 2, '#c00000');
    drawText(g, 'SCORE ' + score, x + 80, y + 46, 1, '#000000');
    drawText(g, 'HIGH  ' + highScore, x + 80, y + 56, 1, '#000000');
    drawText(g, 'PRESS ENTER TO START A NEW GAME', x + 22, y + 72, 1, '#000080');

    var bw = 74, bh = 20, bx = x + (w - bw) / 2, by = y + h - bh - 8;
    g.fillStyle = C.face; g.fillRect(bx, by, bw, bh);
    g.fillStyle = C.hi; g.fillRect(bx, by, bw, 1); g.fillRect(bx, by, 1, bh); g.fillRect(bx + 1, by + 1, bw - 2, 1);
    g.fillStyle = C.dark; g.fillRect(bx, by + bh - 1, bw, 1); g.fillRect(bx + bw - 1, by, 1, bh);
    g.fillStyle = C.shadow; g.fillRect(bx + 1, by + bh - 2, bw - 2, 1); g.fillRect(bx + bw - 2, by + 1, 1, bh - 2);
    g.fillStyle = '#000000';
    g.font = 'bold 11px Tahoma, "MS Sans Serif", sans-serif';
    g.fillText('OK', bx + (bw - g.measureText('OK').width) / 2, by + 14);
  }

  /* ==================================================================== */
  /* ============================== LOOP ================================ */
  /* ==================================================================== */

  function frame() {
    if (disposed || !running) return;
    try {
      var now = W98.tick();
      if (!lastTick) lastTick = now;
      var dtMs = now - lastTick;
      lastTick = now;
      if (!(dtMs >= 0)) dtMs = 0;
      if (dtMs > MAX_FRAME_DT * 1000) dtMs = MAX_FRAME_DT * 1000;   // no teleporting

      if (now - fpsTime >= 500) {
        fps = frameCount * 1000 / (now - fpsTime);
        frameCount = 0; fpsTime = now;
      }
      frameCount++;
      if (window.__pinballDebug) {
        var d = window.__pinballDebug;
        d.fps = fps; d.score = score; d.balls = ballsLeft; d.mult = mult; d.mode = mode;
      }

      if (!paused && mode !== 'gameover') {
        var dt = dtMs / 1000;
        if (plungeHeld && mode === 'ready') plungerPower = clamp(plungerPower + dt * 0.85, 0, 1);
        accumulator += dt;
        var guard = 0;
        while (accumulator >= FIXED_DT && guard < 40) {
          physics(FIXED_DT);
          sensors(FIXED_DT);
          accumulator -= FIXED_DT;
          guard++;
        }
        if (guard >= 40) accumulator = 0;
      }
      render();
    } catch (err) {
      if (window.console && console.error) console.error('pinball:', err);
    }
  }

  function startLoop() {
    if (running || disposed) return;
    running = true;
    lastTick = 0; accumulator = 0; frameCount = 0;
    try { fpsTime = W98.tick(); } catch (e) { fpsTime = 0; }
    try { rafCancel = (W98.raf ? W98.raf(frame) : null); } catch (e) { rafCancel = null; }
  }
  function stopLoop() {
    running = false;
    try { if (rafCancel) rafCancel(); } catch (e) {}
    rafCancel = null;
  }

  /* ==================================================================== */
  /* ============================== SETUP =============================== */
  /* ==================================================================== */

  function removeListeners() {
    try {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('blur', onWindowBlur, false);
    } catch (e) {}
  }

  W98.registerApp({
    id: ID,
    title: '3D Pinball - Space Cadet',
    icon: 'pinball',
    width: TW,
    height: TH,
    minWidth: TW,
    minHeight: TH,
    resizable: false,
    maximizable: false,
    desktop: true,
    startMenuGroup: 'Games',
    singleton: true,
    create: function (w, args) {
      win = w;

      /* per-instance state — this script is loaded once, so a window that is
         closed and re-opened from the Start menu re-enters create() on the
         same closure and everything must be re-armed here. */
      disposed = false;
      running = false;
      rafCancel = null;
      paused = false;
      focused = true;
      lastTick = 0;
      accumulator = 0;
      frameCount = 0;
      fps = 60;
      plungerPower = 0;
      plungeHeld = false;
      mouseDown = false;
      mousePlunge = false;
      stuckTimer = 0;
      animClock = 0;
      statusMsg = ''; statusTimer = 0;
      nudgeCount = 0; nudgeDecay = 0; tiltTimer = 0;
      loopCooldown = 0; loopFlash = 0;
      lastSfx = {}; toneTimes = [];
      highScore = 0;
      ballInPlay = true;
      flippers[0].angle = flippers[0].restAngle; flippers[0].omega = 0; flippers[0].pressed = false;
      flippers[1].angle = flippers[1].restAngle; flippers[1].omega = 0; flippers[1].pressed = false;

      scale = 1;
      try {
        if (win.width && win.height) {
          var sx = Math.floor(win.width / TW), sy = Math.floor(win.height / TH);
          scale = Math.max(1, Math.min(sx, sy) || 1);
        }
      } catch (e) { scale = 1; }

      buildTable();

      win.el.style.background = '#000000';
      win.el.style.overflow = 'hidden';
      win.el.style.display = 'flex';
      win.el.style.alignItems = 'center';
      win.el.style.justifyContent = 'center';
      win.el.style.fontFamily = 'Tahoma, "MS Sans Serif", sans-serif';

      canvas = document.createElement('canvas');
      canvas.width = TW * scale;
      canvas.height = TH * scale;
      canvas.style.width = (TW * scale) + 'px';
      canvas.style.height = (TH * scale) + 'px';
      canvas.style.imageRendering = 'pixelated';
      canvas.style.display = 'block';
      canvas.style.outline = 'none';
      canvas.setAttribute('tabindex', '0');
      win.el.appendChild(canvas);
      ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      rebuildStatic();

      try {
        var hs = (W98.reg && W98.reg.get) ? W98.reg.get(REG_HIVE, 'HighScore', '0') : '0';
        highScore = parseInt(hs, 10);
        if (!isFinite(highScore) || highScore < 0) highScore = 0;
      } catch (e) { highScore = 0; }

      for (var i = 0; i < LETTERS.length; i++) litLetters[i] = false;
      litLetters[5] = true;
      for (i = 0; i < 10; i++) { padCooldown[i] = 0; padLit[i] = false; bumperLit[i % 3] = 0; slingFlash[i % 2] = 0; }

      try { if (win.claimKeys) win.claimKeys(); } catch (e) {}

      // Title-bar icon. 'pinball' is a first-class icon in the shell's own
      // 32x32 pixel-art renderer (W98Icons.def('pinball', …)).  Note that
      // W98.icons.url('pinball') returns null for procedurally drawn icons —
      // it only yields a path once a bitmap asset ships — and win.setIcon()
      // takes the icon *key*, resolving asset-or-procedural art itself.  So
      // the key is the correct argument here; passing url() would clobber the
      // title-bar icon with a null key.
      try {
        if (win.setIcon) win.setIcon('pinball');
      } catch (e) {}

      try {
        if (win.setMenu) win.setMenu([
          { label: '&Game', items: [
            { label: '&New Game', accel: 'F2', onclick: function () { newGame(); } },
            { type: 'sep' },
            { label: '&Pause\\Resume', accel: 'P', onclick: togglePause },
            { label: '&Mute', accel: 'M', onclick: toggleMute },
            { type: 'sep' },
            { label: 'E&xit', onclick: function () { if (win.close) win.close(); } }
          ] },
          { label: '&Options', items: [
            { label: '&Tilt Table', onclick: tiltNow },
            { label: 'Clear &High Score', checked: false, type: 'check', onclick: function () {
              highScore = 0;
              try { if (W98.reg && W98.reg.set) W98.reg.set(REG_HIVE, 'HighScore', '0'); } catch (e) {}
              W98.reg.set(REG_HIVE, 'HighScore', '0');
            } }
          ] },
          { label: '&Help', items: [
            { label: '&How to Play…', onclick: function () {
              if (W98.dialog && W98.dialog.alert) {
                W98.dialog.alert('3D Pinball - Space Cadet',
                  'LEFT ARROW or Z   - left flipper (hold to raise)\\n' +
                  'RIGHT ARROW or /  - right flipper (hold to raise)\\n' +
                  'SPACE or CTRL     - hold to charge the plunger, release to launch\\n' +
                  '                    (once the ball is in play SPACE nudges)\\n' +
                  'P - pause    M - mute    F2 - new game\\n\\n' +
                  'Shoot the ORBIT RAMP to raise the multiplier.\\n' +
                  'Light every rollover to spell SPACE CADET for a big bonus.\\n' +
                  'Three nudges without a rest will TILT the table.\\n' +
                  'Mouse: left half = left flipper, right half = right flipper,\\n' +
                  'and the launch lane works the plunger.', 'info');
              }
            } },
            { label: '&About 3D Pinball…', onclick: function () {
              if (W98.aboutDialog) W98.aboutDialog({ id: ID, title: 'About 3D Pinball', icon: 'pinball' });
            } }
          ] }
        ]);
      } catch (e) {}

      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('blur', onWindowBlur, false);
      canvas.addEventListener('contextmenu', function (e) { if (e.preventDefault) e.preventDefault(); }, false);

      try {
        if (win.on) {
          win.on('blur', function () { focused = false; onWindowBlur(); });
          win.on('focus', function () { focused = true; lastTick = 0; if (!running) startLoop(); });
          win.on('resize', function () { onResize(win.width, win.height); });
        }
      } catch (e) {}

      newGame();
      startLoop();

      window.__pinballDebug = {
        fps: 0, score: 0, balls: 3, mult: 1, mode: mode, muted: false, closed: false,
        ball: ball, flippers: flippers,
        snapshot: function () {
          return {
            fps: fps, score: score, balls: ballsLeft, mult: mult, mode: mode, high: highScore,
            ballInPlay: ballInPlay, paused: paused, muted: muted,
            nudgeCount: nudgeCount, tiltTimer: tiltTimer, plungerPower: plungerPower,
            statusMsg: statusMsg, lights: litLetters.slice(0),
            bumperLit: bumperLit.slice(0),
            ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
            flipperAngle: [flippers[0].angle, flippers[1].angle],
            flipperOmega: [flippers[0].omega, flippers[1].omega]
          };
        },
        newGame: newGame, tilt: tiltNow, launch: function () { launchBall(1); }
      };

      return {
        onClose: function () {
          disposed = true;
          stopLoop();
          removeListeners();
          try { saveHigh(); } catch (e) {}
          if (window.__pinballDebug) window.__pinballDebug.closed = true;
        },
        onResize: function () { onResize(win.width, win.height); },
        onFocus: function () { focused = true; lastTick = 0; },
        onBlur: function () { focused = false; onWindowBlur(); },
        onKey: function () { /* handled at document level, gated on window focus */ }
      };
    }
  });

  function rebuildStatic() {
    staticCv = document.createElement('canvas');
    staticCv.width = TW * scale;
    staticCv.height = TH * scale;
    var g = staticCv.getContext('2d');
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.imageSmoothingEnabled = false;
    drawHudStatic(g);
    g.save();
    g.translate(0, PF_Y);
    drawPlayfieldStatic(g);
    g.restore();
  }

  function onResize(w, h) {
    try {
      if (!canvas || !w || !h) return;
      var sx = Math.floor(w / TW), sy = Math.floor(h / TH);
      var ns = Math.max(1, Math.min(sx, sy) || 1);
      if (ns === scale) return;
      scale = ns;
      canvas.width = TW * scale;
      canvas.height = TH * scale;
      canvas.style.width = (TW * scale) + 'px';
      canvas.style.height = (TH * scale) + 'px';
      ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      rebuildStatic();
    } catch (e) {}
  }

  } /* main() */
})();
