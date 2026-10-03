/*
 * Hearts -- Windows 98 Entertainment Pack extension.
 * A compact four-player Hearts table with deterministic deals, keyboard play,
 * and a hard-edged canvas presentation.  This file is intentionally standalone.
 */
(function () {
  'use strict';
  if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

  var ID = 'hearts';
  var REG = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Entertainment Pack\\Hearts';
  var FACE = '#c0c0c0', HI = '#ffffff', SHADOW = '#808080', DARK = '#000000';
  var FELT = '#007f00', FELT_DARK = '#005500', RED = '#800000', BLUE = '#000080';
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  var SUITS = ['♣', '♦', '♥', '♠'];
  var CSS = [
    '.hearts-root{display:flex;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;background:#c0c0c0;color:#000;font:11px Tahoma,"MS Sans Serif",sans-serif}',
    '.hearts-root *{box-sizing:border-box}',
    '.hearts-toolbar{height:29px;display:flex;align-items:center;gap:4px;padding:3px 4px;flex:none;border-bottom:1px solid #808080}',
    '.hearts-btn{height:22px;min-width:62px;padding:1px 8px;background:#c0c0c0;border:0;color:#000;font:11px Tahoma,"MS Sans Serif",sans-serif;box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #000,inset 2px 2px 0 #dfdfdf,inset -2px -2px 0 #808080;cursor:default}',
    '.hearts-btn:active,.hearts-btn.down{padding:2px 7px 0 9px;box-shadow:inset 1px 1px 0 #000,inset -1px -1px 0 #fff,inset 2px 2px 0 #808080,inset -2px -2px 0 #dfdfdf}',
    '.hearts-btn:focus{outline:1px dotted #000;outline-offset:-4px}',
    '.hearts-btn[disabled]{color:#808080;text-shadow:1px 1px #fff}',
    '.hearts-spacer{flex:1}',
    '.hearts-check{display:flex;align-items:center;gap:3px;white-space:nowrap}',
    '.hearts-check input{width:13px;height:13px;margin:0}',
    '.hearts-canvas{display:block;flex:1 1 auto;min-height:300px;width:100%;image-rendering:pixelated;background:#007f00;outline:0}',
    '.hearts-status{height:21px;flex:none;display:flex;align-items:center;padding:2px 6px;border-top:1px solid #fff;background:#c0c0c0;color:#000}',
    '.hearts-status span{margin-right:16px;white-space:nowrap}',
    '.hearts-status .hearts-hint{margin-left:auto;margin-right:0;color:#000080}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-' + ID)) { return; }
    var st = document.createElement('style'); st.id = 'w98app-' + ID;
    st.appendChild(document.createTextNode(CSS)); (document.head || document.documentElement).appendChild(st);
  }

  function regGet(name, fallback) {
    try {
      if (W98.reg && typeof W98.reg.get === 'function') {
        var v = W98.reg.get(REG, name, fallback);
        return (v === undefined || v === null) ? fallback : v;
      }
    } catch (e) {}
    return fallback;
  }
  function regSet(name, value) {
    try { if (W98.reg && typeof W98.reg.set === 'function') { W98.reg.set(REG, name, value); } } catch (e) {}
  }
  function goodSeed(v, fallback) {
    var n = Number(v);
    if (!isFinite(n) || n < 1 || n > 0xffffffff) { return fallback >>> 0; }
    return (n >>> 0) || (fallback >>> 0);
  }
  function goodScore(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 && n <= 999999 ? Math.floor(n) : 0;
  }
  function boolPref(v, fallback) {
    if (v === true || v === 1 || v === '1' || v === 'true') { return true; }
    if (v === false || v === 0 || v === '0' || v === 'false') { return false; }
    return fallback;
  }

  /* W98.tick is the desktop clock.  The zero fallback only keeps the app
   * paintable if the kernel has not finished booting yet. */
  function clockMs() {
    try {
      if (typeof W98.tick === 'function') {
        var t = W98.tick();
        if (typeof t === 'number' && isFinite(t)) { return t; }
      }
    } catch (e) {}
    return 0;
  }

  function cardSuit(c) { return Math.floor(c / 13); }
  function cardRank(c) { return c % 13; }
  function isHeart(c) { return cardSuit(c) === 2; }
  function isQueenSpades(c) { return cardSuit(c) === 3 && cardRank(c) === 10; }
  function cardPenalty(c) { return isHeart(c) ? 1 : (isQueenSpades(c) ? 13 : 0); }
  function rankValue(c) { return cardRank(c) + 2; }
  function sortCards(a, b) { return cardSuit(a) - cardSuit(b) || cardRank(a) - cardRank(b); }

  function create(win) {
    ensureCss();
    var root = document.createElement('div'); root.className = 'hearts-root';
    win.el.style.display = 'flex'; win.el.style.overflow = 'hidden';
    win.el.appendChild(root);
    var toolbar = document.createElement('div'); toolbar.className = 'hearts-toolbar'; root.appendChild(toolbar);
    var canvas = document.createElement('canvas'); canvas.className = 'hearts-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Hearts table'); root.appendChild(canvas);
    var status = document.createElement('div'); status.className = 'hearts-status';
    var phaseText = document.createElement('span'); var scoreText = document.createElement('span');
    var bestText = document.createElement('span'); var hintText = document.createElement('span'); hintText.className = 'hearts-hint';
    status.appendChild(phaseText); status.appendChild(scoreText); status.appendChild(bestText); status.appendChild(hintText); root.appendChild(status);
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) { canvas.style.display = 'none'; phaseText.textContent = 'Canvas support is required.'; return {}; }

    var sound = boolPref(regGet('Sound', true), true);
    var best = goodScore(regGet('HighScore', 0));
    var seedBase = goodSeed(regGet('LastSeed', 0x98c0ffee), 0x98c0ffee);
    var dead = false, focused = true, timer = null, keyTarget = canvas;
    var G = null;
    var layout = { w: 640, h: 360, cardW: 58, cardH: 80, handX: 16, handY: 250, handGap: 6 };

    function button(label, title, fn) {
      var b = document.createElement('button'); b.className = 'hearts-btn'; b.textContent = label; b.title = title;
      b.addEventListener('click', function () { if (!dead) { fn(); canvas.focus(); } }); toolbar.appendChild(b); return b;
    }
    var newBtn = button('New Game', 'Deal a new game (N)', function () { newGame(); });
    var passBtn = button('Pass Selected', 'Pass the three highlighted cards (Enter)', function () { passCards(); });
    var aboutBtn = button('About', 'About Hearts', showAbout);
    var spacer = document.createElement('div'); spacer.className = 'hearts-spacer'; toolbar.appendChild(spacer);
    var soundLabel = document.createElement('label'); soundLabel.className = 'hearts-check';
    var soundBox = document.createElement('input'); soundBox.type = 'checkbox'; soundBox.checked = sound; soundBox.setAttribute('aria-label', 'Sound');
    soundLabel.appendChild(soundBox); soundLabel.appendChild(document.createTextNode('Sound')); toolbar.appendChild(soundLabel);
    soundBox.addEventListener('change', function () { sound = !!soundBox.checked; regSet('Sound', sound); });

    try {
      win.setMenu([
        { label: '&Game', items: [
          { label: '&New Game', accel: 'N', onclick: function () { newGame(); } },
          { label: '&Pass Selected', accel: 'Enter', onclick: passCards },
          { type: 'sep' },
          { label: '&Sound', type: 'check', checked: sound, onclick: function () { sound = !sound; soundBox.checked = sound; regSet('Sound', sound); } },
          { type: 'sep' },
          { label: 'E&xit', onclick: function () { win.close(); } }
        ] },
        { label: '&Help', items: [
          { label: '&About Hearts...', onclick: showAbout }
        ] }
      ]);
    } catch (e) {}

    function randNext(state) { return (Math.imul(state, 1664525) + 1013904223) >>> 0; }
    function shuffle(seed) {
      var d = [], i, j, t, r = seed >>> 0;
      for (i = 0; i < 52; i++) { d[i] = i; }
      for (i = 51; i > 0; i--) { r = randNext(r); j = r % (i + 1); t = d[i]; d[i] = d[j]; d[j] = t; }
      return { deck: d, state: r };
    }
    function nextSeed() { seedBase = randNext(seedBase); if (!seedBase) { seedBase = 0x12345678; } regSet('LastSeed', seedBase); return seedBase; }

    function newGame(seed) {
      if (seed === undefined) { seed = nextSeed(); }
      seed = goodSeed(seed, 0x98c0ffee); regSet('LastSeed', seed);
      var sh = shuffle(seed), hands = [[], [], [], []], i;
      for (i = 0; i < 52; i++) { hands[i % 4].push(sh.deck[i]); }
      for (i = 0; i < 4; i++) { hands[i].sort(sortCards); }
      G = { seed: seed, rng: sh.state, hands: hands, scores: [0, 0, 0, 0], roundPoints: [0, 0, 0, 0], round: 1, passDir: 1, phase: 'pass', selected: [], cursor: 0, turn: 0, trick: [], trickNo: 0, heartsBroken: false, banner: 'Select three cards to pass', nextAt: 0, aiDue: 0, lastWinner: -1 };
      passBtn.disabled = false; startTimer(); render(); updateStatus();
    }

    function showAbout() {
      var msg = 'Hearts\r\n\r\nA Windows 98 Entertainment Pack table for four players.\r\nPass three cards, follow suit, and avoid hearts and the queen of spades.\r\n\r\nKeyboard: Arrow keys select a card; Space selects; Enter plays or passes; N starts a new game.';
      try {
        if (W98.dialog && typeof W98.dialog.alert === 'function') { W98.dialog.alert('About Hearts', msg, 'info'); return; }
      } catch (e) {}
    }

    function playTone(freq, ms) {
      if (!sound) { return; }
      try { if (W98.sound && typeof W98.sound.tone === 'function') { W98.sound.tone(freq, ms, 'square'); } } catch (e) {}
    }
    function updateStatus() {
      if (!G) { return; }
      phaseText.textContent = G.phase === 'pass' ? 'Pass 3 cards' : G.phase === 'play' ? (G.turn === 0 ? 'Your turn' : 'Thinking…') : G.phase === 'gameover' ? 'Game over' : 'Round complete';
      scoreText.textContent = 'You: ' + G.scores[0];
      bestText.textContent = 'High score: ' + best;
      hintText.textContent = focused ? 'Arrows: select  Space: mark  Enter: play  N: new' : 'PAUSED — click the Hearts window to resume';
      passBtn.disabled = !(G.phase === 'pass' && G.selected.length === 3 && focused);
    }

    function chooseAI(hand, passing) {
      var arr = hand.slice();
      arr.sort(function (a, b) { return cardPenalty(b) - cardPenalty(a) || rankValue(b) - rankValue(a) || a - b; });
      if (!passing) { arr.sort(function (a, b) { return rankValue(a) - rankValue(b) || cardPenalty(a) - cardPenalty(b) || a - b; }); }
      return arr.slice(0, 3);
    }
    function removeCards(hand, cards) {
      var i, j, c;
      for (i = 0; i < cards.length; i++) { c = cards[i]; for (j = hand.length - 1; j >= 0; j--) { if (hand[j] === c) { hand.splice(j, 1); break; } } }
    }
    function passCards() {
      if (!G || G.phase !== 'pass' || G.selected.length !== 3 || !focused) { return; }
      var outgoing = [G.selected.slice(), [], [], []], i, target;
      for (i = 1; i < 4; i++) { outgoing[i] = chooseAI(G.hands[i], true); }
      var incoming = [[], [], [], []];
      for (i = 0; i < 4; i++) {
        target = (i + G.passDir) % 4;
        removeCards(G.hands[i], outgoing[i]);
        incoming[target] = incoming[target].concat(outgoing[i]);
      }
      for (i = 0; i < 4; i++) { G.hands[i] = G.hands[i].concat(incoming[i]).sort(sortCards); }
      G.selected = []; G.cursor = 0; G.phase = 'play'; G.trick = []; G.trickNo = 0; G.heartsBroken = false; G.banner = 'Play the 2 of clubs';
      G.turn = findCardHolder(0); if (G.turn !== 0) { scheduleAI(500); }
      playTone(720, 30); updateStatus(); render();
    }
    function findCardHolder(card) { for (var i = 0; i < 4; i++) { if (G.hands[i].indexOf(card) >= 0) { return i; } } return 0; }

    function hasSuit(hand, suit) { for (var i = 0; i < hand.length; i++) { if (cardSuit(hand[i]) === suit) { return true; } } return false; }
    function legal(card, who) {
      var hand = G.hands[who], leadSuit = G.trick.length ? cardSuit(G.trick[0].card) : -1, hasLead = leadSuit >= 0 && hasSuit(hand, leadSuit), firstTrick = G.trickNo === 0;
      if (G.trick.length === 0) {
        if (firstTrick && card !== 0) { return false; }
        if (!G.heartsBroken && isHeart(card) && hasSuit(hand, 0) === false && hasSuit(hand, 1) === false && hasSuit(hand, 3) === false) { return true; }
        if (!G.heartsBroken && isHeart(card) && (hasSuit(hand, 0) || hasSuit(hand, 1) || hasSuit(hand, 3))) { return false; }
        return true;
      }
      if (hasLead && cardSuit(card) !== leadSuit) { return false; }
      if (!hasLead && firstTrick && (isHeart(card) || isQueenSpades(card))) {
        for (var i = 0; i < hand.length; i++) { if (!isHeart(hand[i]) && !isQueenSpades(hand[i])) { return false; } }
      }
      return true;
    }
    function playCard(who, cardIndex) {
      if (!G || G.phase !== 'play' || G.turn !== who || !focused) { return false; }
      var hand = G.hands[who], card = hand[cardIndex];
      if (card === undefined || !legal(card, who)) {
        G.banner = G.trickNo === 0 && G.trick.length === 0 ? 'The 2 of clubs must lead' : 'You must follow suit';
        playTone(220, 35); updateStatus(); render(); return false;
      }
      hand.splice(cardIndex, 1); G.trick.push({ who: who, card: card });
      if (isHeart(card)) { G.heartsBroken = true; }
      G.cursor = 0; playTone(620 + cardRank(card) * 12, 22);
      if (G.trick.length === 4) { finishTrick(); } else { G.turn = (who + 1) % 4; if (G.turn !== 0) { scheduleAI(420); } }
      updateStatus(); render(); return true;
    }
    function aiPlay() {
      if (!G || G.phase !== 'play' || G.turn === 0 || !focused) { return; }
      var hand = G.hands[G.turn], choices = [];
      for (var i = 0; i < hand.length; i++) { if (legal(hand[i], G.turn)) { choices.push(i); } }
      if (!choices.length) { return; }
      choices.sort(function (a, b) { var ca = hand[a], cb = hand[b]; return cardPenalty(ca) - cardPenalty(cb) || rankValue(ca) - rankValue(cb) || ca - cb; });
      playCard(G.turn, choices[0]);
    }
    function finishTrick() {
      var lead = cardSuit(G.trick[0].card), winner = G.trick[0].who, high = rankValue(G.trick[0].card), points = 0, i;
      for (i = 0; i < G.trick.length; i++) {
        var item = G.trick[i]; if (cardPenalty(item.card)) { points += cardPenalty(item.card); }
        if (cardSuit(item.card) === lead && rankValue(item.card) > high) { high = rankValue(item.card); winner = item.who; }
      }
      G.roundPoints[winner] += points; G.lastWinner = winner; G.trickNo++; G.banner = points ? ('+' + points + ' point' + (points === 1 ? '' : 's')) : '';
      G.trick = []; G.turn = winner;
      if (G.trickNo >= 13) { finishRound(); } else if (G.turn !== 0) { scheduleAI(550); }
      updateStatus(); render();
    }
    function finishRound() {
      var i, moon = -1;
      for (i = 0; i < 4; i++) { if (G.roundPoints[i] === 26) { moon = i; break; } }
      for (i = 0; i < 4; i++) { G.scores[i] += moon >= 0 ? (i === moon ? 0 : 26) : G.roundPoints[i]; }
      if (G.scores[0] > best) { best = G.scores[0]; regSet('HighScore', best); }
      G.banner = moon === 0 ? 'Shooting the moon!' : 'Round complete'; G.phase = G.scores.some(function (s) { return s >= 100; }) ? 'gameover' : 'roundover';
      G.nextAt = clockMs() + 1300; stopTimer(); if (G.phase === 'roundover') { startTimer(); }
      updateStatus(); render();
    }
    function advanceRound() {
      if (!G || G.phase !== 'roundover') { return; }
      var seed = nextSeed(), sh = shuffle(seed), i;
      G.seed = seed; G.rng = sh.state; G.hands = [[], [], [], []];
      for (i = 0; i < 52; i++) { G.hands[i % 4].push(sh.deck[i]); }
      for (i = 0; i < 4; i++) { G.hands[i].sort(sortCards); }
      G.round++; G.passDir = G.round % 4; if (!G.passDir) { G.passDir = 4; }
      G.roundPoints = [0, 0, 0, 0]; G.phase = 'pass'; G.selected = []; G.cursor = 0; G.trickNo = 0; G.heartsBroken = false; G.nextAt = 0; G.banner = 'Select three cards to pass'; startTimer(); updateStatus(); render();
    }
    function scheduleAI(ms) { G.aiDue = clockMs() + ms; startTimer(); }

    function startTimer() {
      if (dead || !focused || timer !== null) { return; }
      if (typeof win.setInterval === 'function') { timer = win.setInterval(timerTick, 100); }
    }
    function stopTimer() {
      if (timer === null) { return; }
      try { if (typeof win.clearInterval === 'function') { win.clearInterval(timer); } } catch (e) {}
      timer = null;
    }
    function timerTick() {
      if (dead || !focused || !G) { return; }
      var t = clockMs();
      if (G.aiDue && t >= G.aiDue) { G.aiDue = 0; aiPlay(); }
      if (G.nextAt && t >= G.nextAt) { G.nextAt = 0; if (G.phase === 'roundover') { advanceRound(); } }
      if ((G.phase === 'play' && G.turn === 0) || G.phase === 'pass' || G.phase === 'gameover') { stopTimer(); }
      updateStatus();
    }

    function toggleSelection(index) {
      if (!G || G.phase !== 'pass' || !focused) { return; }
      var p = G.selected.indexOf(index);
      if (p >= 0) { G.selected.splice(p, 1); }
      else if (G.selected.length < 3) { G.selected.push(index); }
      G.selected.sort(function (a, b) { return a - b; }); updateStatus(); render();
    }
    function selectedCardIndexAt(x, y) {
      if (!G || y < layout.handY || y > layout.handY + layout.cardH + 12) { return -1; }
      var i, hit = -1;
      for (i = 0; i < G.hands[0].length; i++) {
        var xx = layout.handX + i * layout.handGap;
        if (x >= xx && x < xx + layout.cardW) { hit = i; }
      }
      return hit;
    }
    function onMouse(e) {
      if (!focused || dead) { return; }
      var r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * canvas.width / r.width, y = (e.clientY - r.top) * canvas.height / r.height, idx = selectedCardIndexAt(x, y);
      if (idx < 0) { return; }
      canvas.focus();
      if (G.phase === 'pass') { toggleSelection(idx); }
      else if (G.phase === 'play' && G.turn === 0) { playCard(0, idx); }
      e.preventDefault();
    }
    function onKeyDown(e) {
      if (dead || !G) { return false; }
      var k = e.key || e.keyCode;
      if (k === 'n' || k === 'N' || k === 'F2' || k === 78) { newGame(); e.preventDefault(); return true; }
      if (k === 'a' || k === 'A') { showAbout(); e.preventDefault(); return true; }
      if (k === 'ArrowLeft' || k === 37) { if (G.hands[0].length) { G.cursor = (G.cursor + G.hands[0].length - 1) % G.hands[0].length; render(); } e.preventDefault(); return true; }
      if (k === 'ArrowRight' || k === 39) { if (G.hands[0].length) { G.cursor = (G.cursor + 1) % G.hands[0].length; render(); } e.preventDefault(); return true; }
      if (k === ' ' || k === 'Spacebar' || k === 32) { toggleSelection(G.cursor); e.preventDefault(); return true; }
      if (k === 'Enter' || k === 13) { if (G.phase === 'pass') { passCards(); } else if (G.phase === 'play' && G.turn === 0) { playCard(0, G.cursor); } e.preventDefault(); return true; }
      return false;
    }

    function resize() {
      var r = root.getBoundingClientRect(), w = Math.max(500, Math.floor(r.width)), h = Math.max(300, Math.floor(r.height - toolbar.offsetHeight - status.offsetHeight));
      var dpr = 1; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; layout.w = w; layout.h = h;
      layout.cardW = Math.max(38, Math.min(62, Math.floor((w - 48) / 12))); layout.cardH = Math.floor(layout.cardW * 1.38); layout.handGap = Math.max(4, Math.floor((w - 32 - layout.cardW) / 12)); layout.handX = Math.max(10, Math.floor((w - (layout.cardW + 12 * layout.handGap)) / 2)); layout.handY = Math.max(190, h - layout.cardH - 17); render();
    }

    function drawCard(x, y, card, selected, dim) {
      var w = layout.cardW, h = layout.cardH, suit = cardSuit(card), rank = cardRank(card), col = (suit === 1 || suit === 2) ? RED : DARK;
      ctx.save(); ctx.globalAlpha = dim ? 0.55 : 1; ctx.fillStyle = HI; ctx.fillRect(x, y, w, h); ctx.strokeStyle = DARK; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (selected) { ctx.strokeStyle = '#ffff00'; ctx.lineWidth = 3; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4); ctx.lineWidth = 1; }
      ctx.fillStyle = col; ctx.font = 'bold ' + Math.max(11, Math.floor(w * 0.25)) + 'px Tahoma'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(RANKS[rank], x + 3, y + 2); ctx.font = Math.max(12, Math.floor(w * 0.29)) + 'px Arial'; ctx.fillText(SUITS[suit], x + 3, y + Math.floor(w * 0.27));
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = Math.max(18, Math.floor(w * 0.55)) + 'px Arial'; ctx.fillText(SUITS[suit], x + w / 2, y + h / 2 + 3);
      ctx.restore();
    }
    function drawBack(x, y, label) {
      var w = layout.cardW, h = layout.cardH; ctx.fillStyle = '#000080'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = DARK; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.strokeStyle = '#8080d0';
      for (var p = -h; p < w + h; p += 8) { ctx.beginPath(); ctx.moveTo(x + p, y + 2); ctx.lineTo(x + p + h, y + h - 2); ctx.moveTo(x + p, y + h - 2); ctx.lineTo(x + p + h, y + 2); ctx.stroke(); }
      ctx.fillStyle = HI; ctx.font = 'bold 11px Tahoma'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + w / 2, y + h / 2);
    }
    function render() {
      if (!ctx || !G) { return; }
      var w = layout.w, h = layout.h, i, x, y; ctx.clearRect(0, 0, w, h); ctx.fillStyle = FELT; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = FELT_DARK; ctx.strokeRect(4.5, 4.5, w - 9, h - 9);
      ctx.fillStyle = HI; ctx.font = 'bold 12px Tahoma'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('HEARTS', 13, 10);
      ctx.font = '11px Tahoma'; ctx.fillText('Round ' + G.round, 13, 26);
      for (i = 1; i < 4; i++) { var ox = i === 1 ? w - 90 : i === 2 ? Math.floor(w / 2) - 30 : 13; var oy = i === 2 ? 45 : 10; drawBack(ox, oy + (i === 2 ? 0 : 15), ['You', 'East', 'North', 'West'][i]); ctx.fillStyle = HI; ctx.font = '11px Tahoma'; ctx.fillText(['', 'East  ' + G.scores[1], 'North  ' + G.scores[2], 'West  ' + G.scores[3]][i], ox, oy + layout.cardH + 19); }
      /* trick in the centre */
      var tx = Math.floor(w / 2) - layout.cardW - 26, ty = Math.floor(h / 2) - layout.cardH / 2 + 5;
      for (i = 0; i < G.trick.length; i++) { var it = G.trick[i]; var dx = it.who === 0 ? 0 : it.who === 1 ? layout.cardW + 15 : it.who === 2 ? 0 : -(layout.cardW + 15); var dy = it.who === 2 ? -(layout.cardH + 8) : it.who === 0 ? layout.cardH + 8 : 0; drawCard(tx + dx, ty + dy, it.card, false, false); }
      ctx.fillStyle = '#ffff00'; ctx.font = 'bold 12px Tahoma'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(G.banner || '', Math.floor(w / 2), Math.floor(h / 2) - layout.cardH - 16);
      /* human hand */
      ctx.textAlign = 'left'; ctx.fillStyle = HI; ctx.font = '11px Tahoma'; ctx.fillText('YOU', layout.handX, layout.handY - 15);
      for (i = 0; i < G.hands[0].length; i++) { x = layout.handX + i * layout.handGap; y = layout.handY - (G.phase === 'pass' && G.selected.indexOf(i) >= 0 ? 7 : 0); drawCard(x, y, G.hands[0][i], G.phase === 'pass' && G.selected.indexOf(i) >= 0, G.phase === 'play' && G.turn !== 0); }
      if (G.hands[0].length && (G.phase === 'pass' || (G.phase === 'play' && G.turn === 0))) { x = layout.handX + G.cursor * layout.handGap; ctx.strokeStyle = '#ffff00'; ctx.setLineDash([2, 2]); ctx.strokeRect(x - 2, layout.handY - 2, layout.cardW + 4, layout.cardH + 4); ctx.setLineDash([]); }
      if (!focused) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = HI; ctx.font = 'bold 16px Tahoma'; ctx.textAlign = 'center'; ctx.fillText('PAUSED', w / 2, h / 2); }
      if (G.phase === 'gameover') { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#ffff00'; ctx.font = 'bold 22px Tahoma'; ctx.textAlign = 'center'; ctx.fillText('GAME OVER', w / 2, h / 2 - 10); ctx.font = '12px Tahoma'; ctx.fillText('Press N for a new game', w / 2, h / 2 + 17); }
    }

    function pause() { if (dead) { return; } focused = false; stopTimer(); if (G) { G.selected = []; } updateStatus(); render(); }
    function resume() { if (dead) { return; } focused = true; try { canvas.focus(); } catch (e) {} updateStatus(); render(); if (G && ((G.phase === 'play' && G.turn !== 0) || G.phase === 'roundover')) { startTimer(); } }
    function cleanup() { dead = true; stopTimer(); G = null; }

    canvas.addEventListener('mousedown', onMouse);
    canvas.addEventListener('keydown', onKeyDown);
    try { win.claimKeys(); } catch (e) {}
    try { win.on('resize', resize); } catch (e) {}
    try { win.on('focus', resume); } catch (e) {}
    try { win.on('blur', pause); } catch (e) {}
    try { win.on('minimize', pause); win.on('restore', resume); } catch (e) {}
    try { win.on('close', cleanup); } catch (e) {}
    win.setTitle && win.setTitle('Hearts');
    try { if (win.setIcon) { win.setIcon('freecell'); } } catch (e) {}
    newGame(seedBase); resize(); canvas.focus();
    return { onClose: cleanup, onResize: resize, onFocus: resume, onBlur: pause };
  }

  W98.registerApp({ id: ID, title: 'Hearts', icon: 'freecell', width: 640, height: 470, minWidth: 560, minHeight: 420, resizable: true, maximizable: false, singleton: true, startMenuGroup: 'Games', desktop: true, create: create });
})();
