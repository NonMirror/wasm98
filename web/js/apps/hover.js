/* ============================================================================
 * Hover! -- web/js/apps/hover.js
 * A small, self-contained Windows 98 Entertainment Pack style hovercraft game.
 * No external assets or network access.  The arena is procedurally painted so
 * it keeps the hard-edged Win98 look at every size.
 * ========================================================================== */
(function () {
  'use strict';

  if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

  var APP_ID = 'hover';
  var APP_TITLE = 'Hover!';
  var REG_PATH = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Hover';
  var CW = 640, CH = 456;
  var FIELD = { x: 12, y: 70, w: 616, h: 350 };
  var C = {
    face: '#c0c0c0', light: '#dfdfdf', hi: '#ffffff', shadow: '#808080', dark: '#000000',
    title: '#000080', blue: '#0000a8', blueDark: '#000060', blueLine: '#3030c0',
    cyan: '#00ffff', aqua: '#80ffff', yellow: '#ffff00', red: '#ff0000', green: '#00c000',
    navy: '#000040', white: '#ffffff', grey: '#404040', orange: '#ff8000'
  };

  var win = null, canvas = null, ctx = null, appDef = null;
  var dead = false, focused = true, pausedByUser = false, pausedForFocus = false;
  var timerId = null, lastClock = 0;
  var keys = { up: false, down: false, left: false, right: false };
  var pointer = { active: false, x: 0, y: 0 };
  var mouseDown = false;
  var state = 'playing';                 /* playing | won | lost */
  var difficulty = 1;                    /* 0 easy, 1 normal, 2 hard */
  var soundOn = true;
  var score = 0, bestScore = 0, lastScore = 0, wins = 0;
  var elapsed = 0, fuel = 100, collected = 0;
  var seed = 0x984231;
  var rngState = 0;
  var player = { x: 78, y: 112, vx: 0, vy: 0, angle: 0, invuln: 0 };
  var beacons = [], drones = [], blocks = [];
  var message = 'Collect all signal beacons';
  var messageUntil = 0;
  var flashUntil = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function intValue(v, fallback, lo, hi) {
    var n;
    try { n = parseInt(v, 10); } catch (e) { return fallback; }
    return isFinite(n) && n >= lo && n <= hi ? n : fallback;
  }
  function regGet(name, fallback) {
    try {
      if (W98.reg && typeof W98.reg.get === 'function') {
        var value = W98.reg.get(REG_PATH, name, fallback);
        if (typeof fallback === 'boolean') {
          if (value === true || value === 1 || value === '1' || value === 'true') { return true; }
          if (value === false || value === 0 || value === '0' || value === 'false') { return false; }
          return fallback;
        }
        var n;
        try { n = parseInt(value, 10); } catch (e2) { return fallback; }
        return isFinite(n) ? n : fallback;
      }
    } catch (e) {}
    return fallback;
  }
  function regSet(name, value) {
    try { if (W98.reg && typeof W98.reg.set === 'function') { W98.reg.set(REG_PATH, name, value); } } catch (e) {}
  }
  function clock() {
    try {
      if (W98 && typeof W98.tick === 'function') {
        var t = W98.tick();
        if (typeof t === 'number' && isFinite(t)) { return t; }
      }
    } catch (e) {}
    return 0;
  }
  function random() {
    /* LCG: a saved seed makes every course repeatable after a reload. */
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  }
  function beep(freq, ms) {
    if (!soundOn) { return; }
    try { if (W98.sound && typeof W98.sound.tone === 'function') { W98.sound.tone(freq, ms, 'square'); } } catch (e) {}
  }
  function nowSeconds() { return clock() / 1000; }

  function raised(x, y, w, h) {
    ctx.fillStyle = C.face; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.hi; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = C.shadow; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
  }
  function sunken(x, y, w, h) {
    ctx.fillStyle = C.face; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.shadow; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = C.hi; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
  }
  function button(x, y, w, h, label, pressed) {
    if (pressed) { sunken(x, y, w, h); }
    else { raised(x, y, w, h); }
    ctx.fillStyle = C.dark;
    ctx.font = 'bold 11px Tahoma, "MS Sans Serif", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  function text(s, x, y, color, font) {
    ctx.fillStyle = color || C.dark;
    ctx.font = font || '11px Tahoma, "MS Sans Serif", Arial, sans-serif';
    ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, y);
  }
  function rectHit(x, y, w, h, px, py) { return px >= x && py >= y && px < x + w && py < y + h; }

  function loadSettings() {
    bestScore = intValue(regGet('BestScore', 0), 0, 0, 9999999);
    lastScore = intValue(regGet('LastScore', 0), 0, 0, 9999999);
    wins = intValue(regGet('Wins', 0), 0, 0, 9999999);
    difficulty = intValue(regGet('Difficulty', 1), 1, 0, 2);
    soundOn = regGet('Sound', true) !== false;
    seed = intValue(regGet('Seed', seed), seed, 1, 0x7fffffff) >>> 0;
  }
  function saveSettings() {
    regSet('BestScore', bestScore);
    regSet('LastScore', lastScore);
    regSet('Wins', wins);
    regSet('Difficulty', difficulty);
    regSet('Sound', soundOn ? 1 : 0);
    regSet('Seed', seed >>> 0);
  }

  function blocked(x, y, r) {
    var i, b;
    if (x - r < FIELD.x + 4 || x + r > FIELD.x + FIELD.w - 4 || y - r < FIELD.y + 4 || y + r > FIELD.y + FIELD.h - 4) { return true; }
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i];
      if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) { return true; }
    }
    return false;
  }
  function freeSpot(r, avoidX, avoidY) {
    var x, y, tries = 0;
    do {
      x = FIELD.x + 24 + random() * (FIELD.w - 48);
      y = FIELD.y + 24 + random() * (FIELD.h - 48);
      tries++;
    } while ((blocked(x, y, r) || (avoidX != null && Math.abs(x - avoidX) + Math.abs(y - avoidY) < 88)) && tries < 200);
    return { x: x, y: y };
  }
  function buildCourse() {
    var i, b, p, count = difficulty === 0 ? 7 : (difficulty === 2 ? 12 : 10);
    blocks = [];
    /* broad, chunky barriers leave lanes around the edge for beginners */
    for (i = 0; i < 8 + difficulty; i++) {
      b = {
        x: FIELD.x + 38 + random() * (FIELD.w - 130),
        y: FIELD.y + 36 + random() * (FIELD.h - 100),
        w: 22 + Math.floor(random() * 38), h: 15 + Math.floor(random() * 30)
      };
      if (b.x < FIELD.x + 130 && b.y < FIELD.y + 100) { i--; continue; }
      blocks.push(b);
    }
    beacons = [];
    for (i = 0; i < count; i++) {
      p = freeSpot(10, player.x, player.y);
      beacons.push({ x: p.x, y: p.y, phase: random() * 6.28, collected: false });
    }
    drones = [];
    for (i = 0; i < 2 + difficulty; i++) {
      p = freeSpot(12, player.x, player.y);
      drones.push({ x: p.x, y: p.y, vx: (random() * 2 - 1) * (38 + difficulty * 12), vy: (random() * 2 - 1) * (38 + difficulty * 12), phase: random() * 6.28, bump: 0 });
    }
  }
  function newGame(incrementSeed) {
    if (incrementSeed !== false) {
      seed = ((seed + 1) >>> 0) || 1;
      saveSettings();
    }
    rngState = seed >>> 0;
    state = 'playing'; pausedByUser = false; pausedForFocus = !focused;
    score = 0; elapsed = 0; fuel = 100; collected = 0;
    player.x = FIELD.x + 58; player.y = FIELD.y + 55; player.vx = 0; player.vy = 0; player.angle = 0; player.invuln = 0;
    message = 'Collect all signal beacons'; messageUntil = nowSeconds() + 3; flashUntil = 0;
    buildCourse();
    if (ctx) { render(); }
  }
  function finish(winGame) {
    state = winGame ? 'won' : 'lost';
    pausedByUser = false;
    lastScore = score;
    if (winGame) { wins++; score += Math.max(0, Math.round(400 - elapsed * 4)); }
    if (score > bestScore) { bestScore = score; }
    saveSettings();
    beep(winGame ? 880 : 160, winGame ? 120 : 180);
    message = winGame ? 'COURSE CLEAR!' : 'CRAFT DISABLED';
    messageUntil = nowSeconds() + 4;
    render();
  }
  function collideWithBlocks(nx, ny) {
    var r = 9, i, b;
    if (nx - r < FIELD.x + 4 || nx + r > FIELD.x + FIELD.w - 4) { return true; }
    if (ny - r < FIELD.y + 4 || ny + r > FIELD.y + FIELD.h - 4) { return true; }
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i];
      if (nx + r > b.x && nx - r < b.x + b.w && ny + r > b.y && ny - r < b.y + b.h) { return true; }
    }
    return false;
  }
  function update(dt) {
    var accel = 210, drag = Math.pow(0.0008, dt), maxSpeed = 145 + difficulty * 28;
    var ax = 0, ay = 0, nx, ny, i, dx, dy, d, b, droneSpeed;
    if (state !== 'playing' || pausedByUser || pausedForFocus || !focused) { return; }
    elapsed += dt;
    if (elapsed >= (difficulty === 2 ? 65 : 80)) { finish(false); return; }
    if (keys.left) { ax -= 1; } if (keys.right) { ax += 1; }
    if (keys.up) { ay -= 1; } if (keys.down) { ay += 1; }
    if (pointer.active) {
      dx = pointer.x - player.x; dy = pointer.y - player.y; d = Math.sqrt(dx * dx + dy * dy);
      if (d > 14) { ax += dx / d; ay += dy / d; }
    }
    d = Math.sqrt(ax * ax + ay * ay);
    if (d > 0) { ax /= d; ay /= d; player.vx += ax * accel * dt; player.vy += ay * accel * dt; player.angle = Math.atan2(player.vy || ay, player.vx || ax); }
    player.vx *= drag; player.vy *= drag;
    d = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    if (d > maxSpeed) { player.vx = player.vx / d * maxSpeed; player.vy = player.vy / d * maxSpeed; }
    nx = player.x + player.vx * dt; ny = player.y + player.vy * dt;
    if (collideWithBlocks(nx, player.y)) { player.vx *= -0.35; nx = player.x; beep(110, 20); }
    if (collideWithBlocks(player.x, ny)) { player.vy *= -0.35; ny = player.y; beep(110, 20); }
    player.x = nx; player.y = ny;
    player.invuln = Math.max(0, player.invuln - dt);
    droneSpeed = 25 + difficulty * 12;
    for (i = 0; i < drones.length; i++) {
      b = drones[i]; b.phase += dt * 2;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (collideWithBlocks(b.x, b.y) || b.x < FIELD.x + 20 || b.x > FIELD.x + FIELD.w - 20) { b.vx *= -1; }
      if (b.y < FIELD.y + 20 || b.y > FIELD.y + FIELD.h - 20) { b.vy *= -1; }
      dx = player.x - b.x; dy = player.y - b.y; d = Math.sqrt(dx * dx + dy * dy);
      if (d < 18 && player.invuln <= 0) {
        fuel -= 18; score = Math.max(0, score - 50); player.invuln = 1.5; flashUntil = nowSeconds() + .18;
        if (d > 0) { player.vx += dx / d * 100; player.vy += dy / d * 100; }
        beep(120, 80); message = 'WARNING: SENTINEL CONTACT'; messageUntil = nowSeconds() + 1.5;
        if (fuel <= 0) { finish(false); return; }
      }
    }
    for (i = 0; i < beacons.length; i++) {
      b = beacons[i];
      if (b.collected) { continue; }
      dx = player.x - b.x; dy = player.y - b.y;
      if (dx * dx + dy * dy < 18 * 18) {
        b.collected = true; collected++; score += 100 + Math.max(0, Math.round(fuel)); fuel = Math.min(100, fuel + 4);
        message = 'BEACON ' + collected + '/' + beacons.length; messageUntil = nowSeconds() + 1.2;
        beep(620 + collected * 25, 55);
        if (collected >= beacons.length) { finish(true); return; }
      }
    }
    if (score > bestScore) { bestScore = score; regSet('BestScore', bestScore); }
  }
  function drawBeacon(b, t) {
    var pulse = 2 + Math.sin(t * 4 + b.phase) * 2;
    ctx.strokeStyle = b.collected ? '#205060' : C.aqua; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(b.x, b.y, 8 + pulse, 0, Math.PI * 2); ctx.stroke();
    if (!b.collected) {
      ctx.fillStyle = C.yellow; ctx.fillRect(Math.round(b.x - 3), Math.round(b.y - 3), 6, 6);
      ctx.fillStyle = C.white; ctx.fillRect(Math.round(b.x - 1), Math.round(b.y - 1), 2, 2);
    }
  }
  function drawDrone(d, t) {
    var bob = Math.sin(t * 3 + d.phase) * 2;
    ctx.fillStyle = '#300000'; ctx.fillRect(Math.round(d.x - 10), Math.round(d.y - 6 + bob), 20, 12);
    ctx.fillStyle = C.red; ctx.fillRect(Math.round(d.x - 8), Math.round(d.y - 4 + bob), 16, 8);
    ctx.fillStyle = C.yellow; ctx.fillRect(Math.round(d.x - 4), Math.round(d.y - 2 + bob), 3, 3); ctx.fillRect(Math.round(d.x + 2), Math.round(d.y - 2 + bob), 3, 3);
    ctx.fillStyle = C.orange; ctx.fillRect(Math.round(d.x - 13), Math.round(d.y + 7 + bob), 7, 2); ctx.fillRect(Math.round(d.x + 6), Math.round(d.y + 7 + bob), 7, 2);
  }
  function drawPlayer(t) {
    var blink = player.invuln > 0 && Math.floor(t * 14) % 2 === 0;
    if (blink) { return; }
    var x = player.x, y = player.y, a = player.angle || 0, c = Math.cos(a), s = Math.sin(a);
    function tx(px, py) { return { x: x + px * c - py * s, y: y + px * s + py * c }; }
    var p1 = tx(13, 0), p2 = tx(-8, -9), p3 = tx(-5, 0), p4 = tx(-8, 9);
    ctx.fillStyle = '#004040'; ctx.beginPath(); ctx.moveTo(p1.x + 2, p1.y + 2); ctx.lineTo(p2.x + 2, p2.y + 2); ctx.lineTo(p4.x + 2, p4.y + 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = C.white; ctx.lineWidth = 1; ctx.stroke();
    var q = tx(-4, 0); ctx.fillStyle = C.blue; ctx.fillRect(Math.round(q.x - 3), Math.round(q.y - 3), 6, 6);
    ctx.fillStyle = C.white; ctx.fillRect(Math.round(q.x - 1), Math.round(q.y - 1), 2, 2);
    ctx.fillStyle = C.yellow; ctx.fillRect(Math.round(x - 11), Math.round(y - 2), 3, 4); ctx.fillRect(Math.round(x - 11), Math.round(y + 5), 3, 2);
  }
  function render() {
    if (!ctx || dead) { return; }
    var i, b, t = elapsed;
    ctx.fillStyle = C.face; ctx.fillRect(0, 0, CW, CH);
    /* status panel */
    ctx.fillStyle = C.title; ctx.fillRect(0, 0, CW, 24);
    text('Hover!', 8, 17, C.white, 'bold 13px Tahoma, "MS Sans Serif", sans-serif');
    text('ENTERTAINMENT PACK', 88, 16, '#a0c0ff', '10px Tahoma, sans-serif');
    button(468, 4, 70, 17, 'New Game', false); button(543, 4, 42, 17, pausedByUser ? 'Resume' : 'Pause', pausedByUser);
    raised(590, 4, 40, 17); text('F1 Help', 594, 16, C.dark, '10px Tahoma, sans-serif');
    raised(8, 31, 624, 31);
    text('SCORE', 18, 44, C.grey, '10px Tahoma, sans-serif'); text(String(score), 18, 57, C.dark, 'bold 14px "Courier New", monospace');
    text('BEST', 112, 44, C.grey, '10px Tahoma, sans-serif'); text(String(bestScore), 112, 57, C.dark, 'bold 14px "Courier New", monospace');
    text('BEACONS', 220, 44, C.grey, '10px Tahoma, sans-serif'); text(collected + '/' + beacons.length, 220, 57, C.dark, 'bold 14px "Courier New", monospace');
    text('FUEL', 312, 44, C.grey, '10px Tahoma, sans-serif');
    sunken(346, 39, 120, 15); ctx.fillStyle = fuel > 30 ? C.green : C.red; ctx.fillRect(348, 41, Math.max(0, Math.round(116 * fuel / 100)), 11); text(Math.round(fuel) + '%', 474, 51, C.dark, '10px Tahoma, sans-serif');
    text('TIME ' + Math.floor(elapsed) + 's', 548, 51, C.dark, 'bold 11px "Courier New", monospace');
    /* arena */
    sunken(FIELD.x - 2, FIELD.y - 2, FIELD.w + 4, FIELD.h + 4);
    ctx.fillStyle = C.blue; ctx.fillRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h);
    for (i = 0; i < FIELD.w; i += 16) { ctx.fillStyle = (i / 16 % 2) ? C.blueDark : C.blue; ctx.fillRect(FIELD.x + i, FIELD.y, 1, FIELD.h); }
    for (i = 0; i < FIELD.h; i += 16) { ctx.fillStyle = (i / 16 % 2) ? C.blueDark : C.blue; ctx.fillRect(FIELD.x, FIELD.y + i, FIELD.w, 1); }
    for (i = 0; i < blocks.length; i++) {
      b = blocks[i]; ctx.fillStyle = '#202020'; ctx.fillRect(b.x + 2, b.y + 2, b.w, b.h); ctx.fillStyle = '#606060'; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = C.hi; ctx.fillRect(b.x, b.y, b.w, 2); ctx.fillRect(b.x, b.y, 2, b.h); ctx.fillStyle = C.dark; ctx.fillRect(b.x, b.y + b.h - 2, b.w, 2); ctx.fillRect(b.x + b.w - 2, b.y, 2, b.h);
      ctx.fillStyle = '#808080'; ctx.fillRect(b.x + 5, b.y + 5, Math.max(1, b.w - 10), 2);
    }
    for (i = 0; i < beacons.length; i++) { drawBeacon(beacons[i], t); }
    for (i = 0; i < drones.length; i++) { drawDrone(drones[i], t); }
    drawPlayer(t);
    if (state !== 'playing' || pausedByUser || pausedForFocus || !focused) {
      ctx.fillStyle = 'rgba(0,0,32,0.70)'; ctx.fillRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h);
      ctx.fillStyle = C.white; ctx.font = 'bold 22px Tahoma, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(state === 'won' ? 'COURSE CLEAR!' : (state === 'lost' ? 'GAME OVER' : 'PAUSED'), CW / 2, FIELD.y + 143);
      ctx.font = '11px Tahoma, sans-serif';
      ctx.fillText(state === 'won' ? 'Press F2 or click New Game to fly again' : (state === 'lost' ? 'Press F2 or click New Game' : 'Press Space or click Pause to resume'), CW / 2, FIELD.y + 166);
      ctx.textAlign = 'left';
    }
    if (messageUntil > nowSeconds() && state === 'playing') {
      ctx.fillStyle = C.yellow; ctx.font = 'bold 11px Tahoma, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(message, CW / 2, FIELD.y + FIELD.h - 10); ctx.textAlign = 'left';
    }
    ctx.fillStyle = C.face; ctx.fillRect(0, CH - 25, CW, 25); raised(8, CH - 21, 624, 18);
    text('Arrows / WASD steer   •   Hold mouse to fly toward pointer   •   Space pauses', 16, CH - 8, C.dark, '10px Tahoma, sans-serif');
  }
  function tick() {
    if (dead) { return; }
    var t = clock(), dt = lastClock ? (t - lastClock) / 1000 : 0;
    lastClock = t;
    if (!isFinite(dt) || dt < 0 || dt > 0.25) { dt = 0; }
    update(Math.min(dt, 0.08)); render();
  }
  function pointerPos(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * CW / r.width, y: (ev.clientY - r.top) * CH / r.height };
  }
  function onMouseDown(ev) {
    if (dead) { return; }
    if (ev.button !== 0) { ev.preventDefault(); return; }
    var p = pointerPos(ev); ev.preventDefault();
    if (rectHit(468, 4, 70, 17, p.x, p.y)) { newGame(true); return; }
    if (rectHit(543, 4, 42, 17, p.x, p.y)) { pausedByUser = !pausedByUser; render(); return; }
    if (rectHit(590, 4, 40, 17, p.x, p.y)) { showHelp(); return; }
    if (p.y >= FIELD.y && p.y < FIELD.y + FIELD.h) { pointer.active = true; pointer.x = p.x; pointer.y = p.y; mouseDown = true; }
    try { win.focus(); } catch (e) {}
  }
  function onMouseMove(ev) {
    if (dead || !pointer.active) { return; }
    var p = pointerPos(ev); pointer.x = p.x; pointer.y = p.y;
  }
  function onMouseUp() { pointer.active = false; mouseDown = false; }
  function onKey(ev) {
    if (dead) { return; }
    var k = String(ev.key || '').toLowerCase();
    if (k === 'arrowup' || k === 'w') { keys.up = ev.type !== 'keyup'; ev.preventDefault(); }
    else if (k === 'arrowdown' || k === 's') { keys.down = ev.type !== 'keyup'; ev.preventDefault(); }
    else if (k === 'arrowleft' || k === 'a') { keys.left = ev.type !== 'keyup'; ev.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { keys.right = ev.type !== 'keyup'; ev.preventDefault(); }
    else if (ev.type === 'keydown' && (k === ' ' || k === 'spacebar')) { pausedByUser = !pausedByUser; render(); ev.preventDefault(); }
    else if (ev.type === 'keydown' && (k === 'f2' || k === 'n')) { newGame(true); ev.preventDefault(); }
    else if (ev.type === 'keydown' && k === 'f1') { showHelp(); ev.preventDefault(); }
  }
  function showHelp() {
    if (W98.dialog && typeof W98.dialog.alert === 'function') {
      W98.dialog.alert('How to Play Hover!', 'Pilot the cyan hovercraft with the arrow keys or WASD.\n\nCollect every yellow signal beacon. Sentinels drain fuel on contact, and the course timer is running. Hold the mouse button in the arena to steer toward the pointer.\n\nF2 or New Game starts a deterministic new course. Space pauses the flight.', 'info');
    }
  }
  function showAbout() {
    try { if (W98.aboutDialog && appDef) { W98.aboutDialog(appDef); return; } } catch (e) {}
    if (W98.dialog && typeof W98.dialog.alert === 'function') { W98.dialog.alert('About Hover!', 'Microsoft Hover!\nWindows 98 Entertainment Pack\n\nA tiny deterministic hovercraft course for the Web desktop.', 'info'); }
  }
  function setMenu() {
    if (!win || dead) { return; }
    try {
      win.setMenu([
        { label: '&Game', items: [
          { label: '&New Game', accel: 'F2', onclick: function () { newGame(true); } },
          { label: '&Pause', accel: 'Space', checked: pausedByUser, type: 'check', onclick: function () { pausedByUser = !pausedByUser; render(); setMenu(); } },
          { type: 'sep' },
          { label: '&Easy Course', type: 'radio', checked: difficulty === 0, onclick: function () { difficulty = 0; saveSettings(); newGame(true); setMenu(); } },
          { label: '&Normal Course', type: 'radio', checked: difficulty === 1, onclick: function () { difficulty = 1; saveSettings(); newGame(true); setMenu(); } },
          { label: '&Hard Course', type: 'radio', checked: difficulty === 2, onclick: function () { difficulty = 2; saveSettings(); newGame(true); setMenu(); } },
          { type: 'sep' },
          { label: '&Sound', type: 'check', checked: soundOn, onclick: function () { soundOn = !soundOn; saveSettings(); setMenu(); } },
          { type: 'sep' },
          { label: 'E&xit', onclick: function () { if (win) { win.close(); } } }
        ] },
        { label: '&Help', items: [
          { label: '&How to Play', accel: 'F1', onclick: showHelp },
          { type: 'sep' },
          { label: '&About Hover!', onclick: showAbout }
        ] }
      ]);
    } catch (e) {}
  }
  function cleanup() {
    if (dead) { return; }
    dead = true; focused = false; pointer.active = false;
    if (timerId !== null) { try { win.clearInterval(timerId); } catch (e) {} timerId = null; }
    try { document.removeEventListener('mouseup', onMouseUp); } catch (e) {}
    try {
      if (canvas) {
        canvas.removeEventListener('mousedown', onMouseDown); canvas.removeEventListener('mousemove', onMouseMove); canvas.removeEventListener('contextmenu', blockContext);
      }
      if (win && win.el) { win.el.removeEventListener('keydown', onKey); win.el.removeEventListener('keyup', onKey); }
    } catch (e) {}
    saveSettings();
    beacons = []; drones = []; blocks = [];
  }
  function blockContext(ev) { ev.preventDefault(); }

  appDef = {
    id: APP_ID, title: APP_TITLE, icon: 'hover', width: CW, height: CH,
    minWidth: CW, minHeight: CH, resizable: false, maximizable: false,
    desktop: true, startMenuGroup: 'Games', singleton: true,
    text: 'Pilot a hovercraft through a deterministic course of signal beacons.',
    create: function (w) {
      win = w; dead = false; focused = true; pausedByUser = false; pausedForFocus = false; lastClock = clock();
      loadSettings();
      win.el.style.display = 'block'; win.el.style.overflow = 'hidden'; win.el.style.padding = '0'; win.el.style.background = C.face;
      canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH; canvas.style.display = 'block'; canvas.style.imageRendering = 'pixelated'; canvas.style.cursor = 'crosshair';
      win.el.appendChild(canvas); ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (!ctx) { var unsupported = document.createElement('div'); unsupported.textContent = 'Hover! requires canvas support.'; unsupported.style.padding = '8px'; win.el.replaceChild(unsupported, canvas); return {}; }
      ctx.imageSmoothingEnabled = false;
      if ('webkitImageSmoothingEnabled' in ctx) { ctx.webkitImageSmoothingEnabled = false; }
      try { win.setTitle(APP_TITLE); if (win.setIcon) { win.setIcon('hover'); } } catch (e) {}
      try { if (win.setClientSize) { win.setClientSize(CW, CH); } } catch (e) {}
      try { if (win.claimKeys) { win.claimKeys(); } } catch (e) {}
      canvas.addEventListener('mousedown', onMouseDown); canvas.addEventListener('mousemove', onMouseMove); canvas.addEventListener('contextmenu', blockContext);
      document.addEventListener('mouseup', onMouseUp);
      win.el.addEventListener('keydown', onKey); win.el.addEventListener('keyup', onKey);
      var pauseForWindow = function () {
        focused = false; pausedForFocus = true;
        keys.up = keys.down = keys.left = keys.right = false;
        pointer.active = false; render();
      };
      var resumeForWindow = function () { focused = true; pausedForFocus = false; render(); };
      try { win.on('close', cleanup); } catch (e) {}
      try { win.on('blur', pauseForWindow); win.on('minimize', pauseForWindow); } catch (e) {}
      try { win.on('focus', resumeForWindow); win.on('restore', resumeForWindow); } catch (e) {}
      setMenu(); newGame(false); timerId = win.setInterval(tick, 33); render();
      /* Keyboard listeners are attached directly to the focused client.  Do
         not also return an onKey hook: Window already forwards client key
         events to hooks, and registering both would toggle Pause twice. */
      return { onClose: cleanup };
    }
  };
  W98.registerApp(appDef);
}());
