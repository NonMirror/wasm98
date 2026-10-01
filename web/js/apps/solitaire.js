/* =====================================================================
 * solitaire.js -- Klondike Solitaire for the Windows 98 Web desktop.
 *
 * Single-file classic script (no modules).  Everything is procedural:
 * every card face and back is painted once into one sprite atlas
 * canvas, no image files, no external assets, no network.
 *
 * Architectural notes:
 *   - three stacked <canvas> layers inside win.el:
 *       board  (static board, redrawn on state change / resize)
 *       drag   (only the stack that follows the cursor -- redrawn per
 *               mousemove so the whole board is never re-rendered)
 *       fx     (persistent layer for the bouncing-card win animation,
 *               it accumulates card stamps to produce the classic
 *               "trail" effect; only W98.raf drives it)
 *   - the WASM kernel owns timers, the registry and the clock
 *     (win.setInterval / win.setTimeout / W98.tick).
 * ===================================================================== */
(function () {
'use strict';

if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') {
    return;                                     // not inside the shell
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */
var APP_ID    = 'solitaire';
var APP_TITLE = 'Solitaire';
var REG_PATH  = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Solitaire';

var CARD_W = 71;                                // the official card size
var CARD_H = 96;

var SPADES = 0, HEARTS = 1, DIAMONDS = 2, CLUBS = 3;
var RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

var INK_RED   = '#cc0000';
var INK_BLACK = '#000000';
var INK_GOLD  = '#e2b31d';
var INK_SKIN  = '#ffd8ae';

/* Standard / Vegas scoring tables (Windows Solitaire units). */
var SCORE = {
    WASTE_TO_TABLEAU:      10,      // waste      -> tableau column
    WASTE_TO_FOUNDATION:   10,      // waste      -> foundation
    TABLEAU_TO_FOUNDATION: 10,      // tableau    -> foundation
    FLIP_TABLEAU:           5,      // turning over the newly exposed tableau card
    FOUNDATION_TO_TABLEAU: -15,     // dragging a card back out of a foundation
    RECYCLE_DRAW_ONE:      -15,     // one more pass through the deck (draw one)
    RECYCLE_DRAW_THREE:    -20,     // one more pass through the deck (draw three)
    TIMED:                  -2      // every 10 s while the score is >= 0
};
var VEGAS_START    = -52;           // Vegas deals you in for $52
var VEGAS_PER_CARD = 5;             // ...and pays $5 per foundation card

var NUM_BACKS  = 4;                 // classic blue lattice + 3 more
var SPRITE_GAP = 1;                 // 1 px gutter between atlas cells
var CELL_W = CARD_W + SPRITE_GAP;
var CELL_H = CARD_H + SPRITE_GAP;
var ATLAS_COLS = 8;
var ATLAS_ROWS = 7;                 // 52 faces + 4 backs = 56 = 8 x 7

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */
function isRedSuit(suit) { return suit === HEARTS || suit === DIAMONDS; }
function rnd(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}
function ctx2d(c) {
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    if ('webkitImageSmoothingEnabled' in x) x.webkitImageSmoothingEnabled = false;
    return x;
}
function inRect(x, y, r) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

/* ------------------------------------------------------------------ */
/* card art -- suits                                                   */
/* ------------------------------------------------------------------ */
function suitPath(ctx, suit, x, y, w, h) {
    var cx = x + w / 2, bot = y + h;
    ctx.beginPath();
    if (suit === HEARTS) {
        ctx.moveTo(cx, bot);
        ctx.bezierCurveTo(x - w * 0.06, y + h * 0.62, x + w * 0.02, y - h * 0.02, cx, y + h * 0.30);
        ctx.bezierCurveTo(x + w * 0.98, y - h * 0.02, x + w * 1.06, y + h * 0.62, cx, bot);
    } else if (suit === SPADES) {
        ctx.moveTo(cx, y);
        ctx.bezierCurveTo(cx - w * 0.44, y + h * 0.30, x, y + h * 0.44, x, y + h * 0.66);
        ctx.bezierCurveTo(x, y + h * 0.88, x + w * 0.34, y + h * 0.92, cx - w * 0.05, y + h * 0.74);
        ctx.bezierCurveTo(cx - w * 0.10, y + h * 0.70, cx - w * 0.07, y + h * 0.85, cx - w * 0.19, bot);
        ctx.lineTo(cx + w * 0.19, bot);
        ctx.bezierCurveTo(cx + w * 0.07, y + h * 0.85, cx + w * 0.10, y + h * 0.70, cx + w * 0.05, y + h * 0.74);
        ctx.bezierCurveTo(x + w * 0.66, y + h * 0.92, x + w, y + h * 0.88, x + w, y + h * 0.66);
        ctx.bezierCurveTo(x + w, y + h * 0.44, cx + w * 0.44, y + h * 0.30, cx, y);
    } else if (suit === DIAMONDS) {
        ctx.moveTo(cx, y);
        ctx.lineTo(x + w, y + h * 0.5);
        ctx.lineTo(cx, bot);
        ctx.lineTo(x, y + h * 0.5);
    }
    ctx.closePath();
}

function fillSuit(ctx, suit, x, y, w, h, color) {
    ctx.fillStyle = color;
    if (suit === CLUBS) {
        var r = w * 0.30, cx = x + w / 2;
        ctx.beginPath();
        ctx.moveTo(cx + r, y + h * 0.27); ctx.arc(cx, y + h * 0.27, r, 0, Math.PI * 2);
        ctx.moveTo(x + w * 0.25 + r, y + h * 0.62); ctx.arc(x + w * 0.25, y + h * 0.62, r, 0, Math.PI * 2);
        ctx.moveTo(x + w * 0.75 + r, y + h * 0.62); ctx.arc(x + w * 0.75, y + h * 0.62, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.09, y + h * 0.72);
        ctx.quadraticCurveTo(cx - w * 0.26, y + h * 0.90, cx - w * 0.32, y + h);
        ctx.lineTo(cx + w * 0.32, y + h);
        ctx.quadraticCurveTo(cx + w * 0.26, y + h * 0.90, cx + w * 0.09, y + h * 0.72);
        ctx.closePath();
        ctx.fill();
    } else {
        suitPath(ctx, suit, x, y, w, h);
        ctx.fill();
    }
}

function drawPip(ctx, suit, cx, cy, size, color, invert) {
    var h = size;
    var w = (suit === DIAMONDS) ? size * 0.70 : size * 0.82;
    ctx.save();
    ctx.translate(cx, cy);
    if (invert) ctx.rotate(Math.PI);
    fillSuit(ctx, suit, -w / 2, -h / 2, w, h, color);
    ctx.restore();
}

/* Standard pip layouts for a 71x96 card.  Entries are
 * [x, y, scale, inverted] with x/y as fractions of the card box. */
function pipLayout(rank) {
    var L = [], xl = 0.32, xr = 0.68, cx = 0.5;
    var y3 = [0.18, 0.50, 0.82];
    var y4 = [0.15, 0.38, 0.62, 0.85];
    var inv = function (y) { return y > 0.52 ? 1 : 0; };
    function col(cols, ys) {
        for (var k = 0; k < ys.length; k++) {
            for (var c = 0; c < cols.length; c++) L.push([cols[c], ys[k], 1, inv(ys[k])]);
        }
    }
    switch (rank) {
        case 1:  return [[0.5, 0.5, 1.85, 0]];
        case 2:  return [[cx, y3[0], 1, 0], [cx, y3[2], 1, 1]];
        case 3:  return [[cx, y3[0], 1, 0], [cx, 0.5, 1, 0], [cx, y3[2], 1, 1]];
        case 4:  return [[xl, y3[0], 1, 0], [xr, y3[0], 1, 0], [xl, y3[2], 1, 1], [xr, y3[2], 1, 1]];
        case 5:  return [[xl, y3[0], 1, 0], [xr, y3[0], 1, 0], [cx, 0.5, 1, 0],
                         [xl, y3[2], 1, 1], [xr, y3[2], 1, 1]];
        case 6:  col([xl, xr], y3); return L;
        case 7:  col([xl, xr], y3); L.push([cx, 0.34, 1, 0]); return L;
        case 8:  col([xl, xr], y3); L.push([cx, 0.34, 1, 0], [cx, 0.66, 1, 1]); return L;
        case 9:  col([xl, xr], y4); L.push([cx, 0.5, 1, 0]); return L;
        case 10: col([xl, xr], y4); L.push([cx, 0.28, 1, 0], [cx, 0.72, 1, 1]); return L;
    }
    return L;
}

/* ------------------------------------------------------------------ */
/* card art -- rank / suit corner index (drawn twice, mirrored)        */
/* ------------------------------------------------------------------ */
function drawIndex(ctx, ox, oy, suit, rank, color, flip, small) {
    ctx.save();
    if (flip) {
        ctx.translate(ox + CARD_W / 2, oy + CARD_H / 2);
        ctx.rotate(Math.PI);
        ctx.translate(-(ox + CARD_W / 2), -(oy + CARD_H / 2));
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold ' + (small ? 11 : 13) + 'px Tahoma, "MS Sans Serif", Arial, sans-serif';
    ctx.fillText(RANK_LABEL[rank], ox + 3, oy + 2);
    drawPip(ctx, suit, ox + 8, oy + 27, small ? 9 : 11, color, false);
    ctx.restore();
}

/* ------------------------------------------------------------------ */
/* card art -- court figures (J/Q/K), stylised + mirrored halves       */
/* ------------------------------------------------------------------ */
function drawBust(ctx, x, y, w, h, suit, rank, color) {
    var cx = x + w / 2;
    var robe = isRedSuit(suit) ? '#a01722' : '#232345';
    /* torso */
    ctx.fillStyle = robe;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + h * 0.78);
    ctx.bezierCurveTo(x + w * 0.10, y + h * 0.56, x + w * 0.28, y + h * 0.50, cx, y + h * 0.50);
    ctx.bezierCurveTo(x + w * 0.72, y + h * 0.50, x + w * 0.90, y + h * 0.56, x + w, y + h * 0.78);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
    /* white collar */
    ctx.fillStyle = '#f4f4f4';
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.17, y + h * 0.50);
    ctx.lineTo(cx, y + h * 0.76);
    ctx.lineTo(cx + w * 0.17, y + h * 0.50);
    ctx.closePath();
    ctx.fill();
    /* gold livery trim */
    ctx.strokeStyle = INK_GOLD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.06, y + h * 0.74); ctx.lineTo(x + w * 0.30, y + h * 0.74);
    ctx.moveTo(x + w * 0.70, y + h * 0.74); ctx.lineTo(x + w * 0.94, y + h * 0.74);
    ctx.stroke();
    /* suit emblem on the chest */
    drawPip(ctx, suit, cx, y + h * 0.60, h * 0.20, color, false);
    /* head */
    var hy = y + h * 0.30, hr = h * 0.155;
    ctx.fillStyle = INK_SKIN;
    ctx.beginPath();
    ctx.arc(cx, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#54402c';
    ctx.lineWidth = 1;
    ctx.stroke();
    /* hair / beard / crown per rank */
    if (rank === 13) {                                  /* King */
        ctx.fillStyle = '#e8e8e8';                      /* beard */
        ctx.beginPath();
        ctx.moveTo(cx - hr * 0.95, hy + hr * 0.30);
        ctx.quadraticCurveTo(cx, hy + hr * 2.5, cx + hr * 0.95, hy + hr * 0.30);
        ctx.quadraticCurveTo(cx, hy + hr * 0.95, cx - hr * 0.95, hy + hr * 0.30);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#6b4a1f';
        ctx.beginPath();
        ctx.arc(cx, hy - hr * 0.55, hr * 0.95, Math.PI, Math.PI * 2);
        ctx.fill();
    } else if (rank === 12) {                           /* Queen */
        ctx.fillStyle = isRedSuit(suit) ? '#a01722' : '#2b2b2b';
        ctx.beginPath();                                /* hair */
        ctx.moveTo(cx - hr * 1.05, hy + hr * 1.5);
        ctx.lineTo(cx - hr * 1.05, hy - hr * 0.2);
        ctx.quadraticCurveTo(cx, hy - hr * 1.9, cx + hr * 1.05, hy - hr * 0.2);
        ctx.lineTo(cx + hr * 1.05, hy + hr * 1.5);
        ctx.quadraticCurveTo(cx, hy + hr * 0.9, cx - hr * 1.05, hy + hr * 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = INK_SKIN;
        ctx.beginPath();
        ctx.arc(cx, hy, hr, 0, Math.PI * 2);
        ctx.fill();
    } else {                                            /* Jack */
        ctx.fillStyle = robesHair(suit);
        ctx.beginPath();
        ctx.arc(cx, hy - hr * 0.42, hr * 0.98, Math.PI, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx - hr * 0.98, hy - hr * 0.45, hr * 0.3, hr * 1.1);
        ctx.fillRect(cx + hr * 0.68, hy - hr * 0.45, hr * 0.3, hr * 1.1);
    }
    /* face */
    ctx.fillStyle = '#101010';
    ctx.fillRect(Math.round(cx - hr * 0.58), Math.round(hy - hr * 0.12), 1, 2);
    ctx.fillRect(Math.round(cx + hr * 0.38), Math.round(hy - hr * 0.12), 1, 2);
    ctx.fillStyle = '#a03a3a';
    ctx.fillRect(Math.round(cx - hr * 0.30), Math.round(hy + hr * 0.42), Math.round(hr * 0.6), 1);
    /* headgear */
    ctx.fillStyle = INK_GOLD;
    if (rank === 13) {                                  /* tall crown */
        ctx.beginPath();
        ctx.moveTo(cx - hr * 0.95, hy - hr * 0.80);
        ctx.lineTo(cx - hr * 0.95, hy - hr * 1.35);
        ctx.lineTo(cx - hr * 0.48, hy - hr * 0.95);
        ctx.lineTo(cx, hy - hr * 1.60);
        ctx.lineTo(cx + hr * 0.48, hy - hr * 0.95);
        ctx.lineTo(cx + hr * 0.95, hy - hr * 1.35);
        ctx.lineTo(cx + hr * 0.95, hy - hr * 0.80);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = INK_RED;
        ctx.fillRect(Math.round(cx - 0.5), Math.round(hy - hr * 1.45), 1, 2);
    } else if (rank === 12) {                           /* tiara */
        ctx.beginPath();
        ctx.moveTo(cx - hr * 0.9, hy - hr * 0.85);
        ctx.lineTo(cx - hr * 0.9, hy - hr * 1.25);
        ctx.lineTo(cx, hy - hr * 0.80);
        ctx.lineTo(cx + hr * 0.9, hy - hr * 1.25);
        ctx.lineTo(cx + hr * 0.9, hy - hr * 0.85);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#3a6ecf';
        ctx.fillRect(Math.round(cx - 0.5), Math.round(hy - hr * 1.05), 1, 2);
    } else {                                            /* flat cap + feather */
        ctx.beginPath();
        ctx.moveTo(cx - hr * 1.05, hy - hr * 0.70);
        ctx.lineTo(cx + hr * 1.05, hy - hr * 0.70);
        ctx.lineTo(cx + hr * 0.85, hy - hr * 1.30);
        ctx.lineTo(cx - hr * 0.85, hy - hr * 1.30);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#3a6ecf';
        ctx.beginPath();
        ctx.moveTo(cx + hr * 0.4, hy - hr * 1.25);
        ctx.quadraticCurveTo(cx + hr * 1.5, hy - hr * 1.9, cx + hr * 0.9, hy - hr * 2.3);
        ctx.stroke();
    }
}
function robesHair(suit) { return isRedSuit(suit) ? '#7a4a12' : '#1f1f1f'; }

function drawCourt(ctx, ox, oy, suit, rank, color) {
    var px = ox + 17, pw = CARD_W - 34, py = oy + 4, ph = CARD_H - 8;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    var bx = px + 1, by = py + 1, bw = pw - 2, bh = ph / 2 - 1;
    drawBust(ctx, bx, by, bw, bh, suit, rank, color);
    ctx.save();
    ctx.translate(ox + CARD_W / 2, oy + CARD_H / 2);
    ctx.rotate(Math.PI);
    ctx.translate(-(ox + CARD_W / 2), -(oy + CARD_H / 2));
    drawBust(ctx, bx, by, bw, bh, suit, rank, color);
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(px, py + ph / 2 + 0.5);
    ctx.lineTo(px + pw, py + ph / 2 + 0.5);
    ctx.stroke();
    drawIndex(ctx, ox, oy, suit, rank, color, false, true);
    drawIndex(ctx, ox, oy, suit, rank, color, true, true);
}

/* ------------------------------------------------------------------ */
/* card art -- face + back sprites                                     */
/* ------------------------------------------------------------------ */
function drawFaceSprite(ctx, ox, oy, suit, rank) {
    var color = isRedSuit(suit) ? INK_RED : INK_BLACK;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, oy, CARD_W, CARD_H);
    if (rank >= 11) {
        drawCourt(ctx, ox, oy, suit, rank, color);
    } else {
        var lay = pipLayout(rank);
        var size = (rank === 1) ? CARD_H * 0.42 : CARD_H * 0.155;
        for (var i = 0; i < lay.length; i++) {
            drawPip(ctx, suit, ox + lay[i][0] * CARD_W, oy + lay[i][1] * CARD_H,
                    size * lay[i][2], color, !!lay[i][3]);
        }
        drawIndex(ctx, ox, oy, suit, rank, color, false, false);
        drawIndex(ctx, ox, oy, suit, rank, color, true, false);
    }
    /* crisp 1px black outline, no radius, no shadow */
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, CARD_W - 1, CARD_H - 1);
}

var BACK_STYLES = [
    { base: '#00007f', ink: '#ffffff', pat: 'lattice' },   /* the classic blue back */
    { base: '#7f0000', ink: '#ffd0d0', pat: 'lattice' },
    { base: '#006400', ink: '#d8ffd8', pat: 'weave' },
    { base: '#2e003e', ink: '#ffffff', pat: 'stars' }
];

function drawBackSprite(ctx, ox, oy, v) {
    var st = BACK_STYLES[v % BACK_STYLES.length];
    ctx.save();
    ctx.fillStyle = st.base;
    ctx.fillRect(ox, oy, CARD_W, CARD_H);
    ctx.strokeStyle = st.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 2.5, oy + 2.5, CARD_W - 5, CARD_H - 5);
    ctx.beginPath();
    ctx.rect(ox + 4, oy + 4, CARD_W - 8, CARD_H - 8);
    ctx.clip();
    var i, j, x0 = ox + 4, y0 = oy + 4, x1 = ox + CARD_W - 4, y1 = oy + CARD_H - 4;
    ctx.strokeStyle = st.ink;
    ctx.lineWidth = 1;
    if (st.pat === 'lattice') {
        ctx.beginPath();
        for (i = 0; i < (CARD_H + CARD_W); i += 6) {
            ctx.moveTo(x0 + i + 0.5, y0); ctx.lineTo(x0 + i - CARD_H + 0.5, y1);
            ctx.moveTo(x0 + i + 0.5, y0); ctx.lineTo(x0 + i + CARD_H + 0.5, y1);
        }
        ctx.stroke();
        ctx.fillStyle = st.ink;
        for (j = 0; j < CARD_H; j += 6) {
            for (i = 0; i < CARD_W; i += 6) {
                ctx.fillRect(x0 + i + ((j / 6) % 2 ? 3 : 0), y0 + j + 2, 1, 1);
            }
        }
    } else if (st.pat === 'weave') {
        ctx.beginPath();
        for (j = 0; j < CARD_H; j += 4) {
            ctx.moveTo(x0, y0 + j + 0.5); ctx.lineTo(x1, y0 + j + 0.5);
        }
        ctx.stroke();
        ctx.beginPath();
        for (j = 0; j < CARD_H; j += 8) {
            for (i = ((j / 8) % 2) ? 4 : 0; i < CARD_W; i += 8) {
                ctx.moveTo(x0 + i + 0.5, y0 + j + 1);
                ctx.lineTo(x0 + i + 0.5, y0 + j + 4);
            }
        }
        ctx.stroke();
    } else {
        ctx.fillStyle = st.ink;
        for (j = 0; j < CARD_H; j += 12) {
            for (i = 0; i < CARD_W; i += 12) {
                var sx = x0 + i + 4, sy = y0 + j + 4 + ((i / 12) % 2 ? 6 : 0);
                ctx.fillRect(sx - 3, sy, 7, 1);
                ctx.fillRect(sx, sy - 3, 1, 7);
                ctx.fillRect(sx - 2, sy - 2, 2, 2);
                ctx.fillRect(sx + 1, sy + 1, 2, 2);
            }
        }
    }
    ctx.restore();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, CARD_W - 1, CARD_H - 1);
}

/* ------------------------------------------------------------------ */
/* the sprite atlas: 56 sprites, built once per page                   */
/* ------------------------------------------------------------------ */
var ATLAS = null;

function buildAtlas() {
    var c = mkCanvas(ATLAS_COLS * CELL_W, ATLAS_ROWS * CELL_H);
    var ctx = ctx2d(c);
    var s, r, b, idx;
    for (s = 0; s < 4; s++) {
        for (r = 1; r <= 13; r++) {
            idx = s * 13 + (r - 1);
            drawFaceSprite(ctx, (idx % ATLAS_COLS) * CELL_W + SPRITE_GAP,
                                ((idx / ATLAS_COLS) | 0) * CELL_H + SPRITE_GAP, s, r);
        }
    }
    for (b = 0; b < NUM_BACKS; b++) {
        idx = 52 + b;
        drawBackSprite(ctx, (idx % ATLAS_COLS) * CELL_W + SPRITE_GAP,
                            ((idx / ATLAS_COLS) | 0) * CELL_H + SPRITE_GAP, b);
    }
    return c;
}

function atlas() {
    if (!ATLAS) ATLAS = buildAtlas();
    return ATLAS;
}

function drawSprite(ctx, idx, x, y, w, h) {
    var sx = (idx % ATLAS_COLS) * CELL_W + SPRITE_GAP;
    var sy = ((idx / ATLAS_COLS) | 0) * CELL_H + SPRITE_GAP;
    ctx.drawImage(atlas(), sx, sy, CARD_W, CARD_H, x, y, w, h);
}

/* sprite index for a card id: id === suit * 13 + rank - 1 (0..51) */
function backSprite() { return 52 + (opts ? opts.deck : 0); }

/* ------------------------------------------------------------------ */
/* runtime state                                                       */
/* ------------------------------------------------------------------ */
var win = null, root = null;
var boardC = null, boardCtx = null, dragC = null, dragCtx = null, fxC = null, fxCtx = null;

var piles = { stock: [], waste: [], found: [[], [], [], []],
              tab: [[], [], [], [], [], [], []] };
var cardsById = {};                       /* id -> card object (per deal) */

var opts = { draw3: true, deck: 0, vegas: false, timed: true };

var score = 0, moves = 0, penTick = 0;
var gameStarted = false, startTicked = 0, accSec = 0;
var undoCards = [], won = false, selection = null;
var cur = { slot: 0, card: 0 };           /* keyboard cursor */
var drag = null;                          /* active drag state */
var modal = null;                         /* open dialog */
var tabOff = [[], [], [], [], [], [], []];

var tickId = null, timers = [], autoRunning = false, autoSteps = 0;
var fxCancel = null, fxParts = [], fxRunning = false, fxSndAt = 0;
var flick = null, flickId = null;         /* the stock -> waste flick */
var lastStatus = '', lastClick = null;

/* 12 keyboard-reachable stacks: stock, waste, found 0..3, tab 0..6 */
var KBD_SLOTS = 13;

var L = { w: 0, h: 0, cw: CARD_W, ch: CARD_H, gapX: 14, gapY: 12,
          colX: [0, 0, 0, 0, 0, 0, 0], topY: 6, tabY: 120,
          fanUp: 18, fanDown: 11, wasteFan: 16, scale: 1 };

/* ------------------------------------------------------------------ */
/* layout -- everything is recomputed from win.width / win.height       */
/* ------------------------------------------------------------------ */
function layout() {
    var w = Math.max(120, win.width | 0);
    var h = Math.max(90, win.height | 0);
    var mx = 6, my = 6;
    var availW = Math.max(60, w - mx * 2);
    var s = availW / (7 * CARD_W + 6 * 2);
    if (s > 1) s = 1;
    var cw = Math.max(24, Math.floor(CARD_W * s));
    var ch = Math.max(32, Math.round(cw * CARD_H / CARD_W));
    var gapX = Math.floor((availW - 7 * cw) / 6);
    gapX = clamp(gapX, 2, 20);
    var totalW = 7 * cw + 6 * gapX;
    var startX = mx + Math.max(0, Math.floor((availW - totalW) / 2));

    L.w = w; L.h = h; L.cw = cw; L.ch = ch;
    L.gapX = gapX;
    for (var i = 0; i < 7; i++) L.colX[i] = startX + i * (cw + gapX);
    L.topY = my;
    L.gapY = clamp(Math.round(ch * 0.14), 6, 22);
    L.tabY = my + ch + L.gapY;
    L.wasteFan = Math.max(6, Math.round(cw * 0.22));
    /* authentic fan: face-down cards peek out as thin slivers,
       face-up cards show roughly a fifth of the card */
    L.fanDown = clamp(Math.round(ch * 0.045), 3, 8);
    var room = h - L.tabY - my - ch;
    L.fanUp = Math.max(6, Math.round(ch * 0.20));
    if (room > 0) L.fanUp = clamp(Math.floor(room / 6), 4, L.fanUp);

    sizeCanvases();
    layoutTab();
}

function sizeCanvases() {
    var list = [boardC, dragC, fxC], i;
    for (i = 0; i < list.length; i++) {
        if (!list[i]) continue;
        list[i].width = L.w;
        list[i].height = L.h;
    }
    boardCtx = ctx2d(boardC);
    dragCtx = ctx2d(dragC);
    fxCtx = ctx2d(fxC);
}

/* vertical offsets of every tableau card, compressed to fit the board */
function layoutTab() {
    var maxB = L.h - 4;
    for (var t = 0; t < 7; t++) {
        var p = piles.tab[t], offs = [], y = L.tabY, i;
        for (i = 0; i < p.length; i++) {
            offs.push(y);
            y += p[i].up ? L.fanUp : L.fanDown;
        }
        if (offs.length) {
            var last = offs.length - 1;
            var need = offs[last] + L.ch;
            if (need > maxB) {
                var span = offs[last] - L.tabY;
                if (span > 0) {
                    var k = Math.max(0, (maxB - L.ch - L.tabY)) / span;
                    for (i = 0; i < offs.length; i++) {
                        offs[i] = Math.round(L.tabY + (offs[i] - L.tabY) * k);
                    }
                }
            }
        }
        tabOff[t] = offs;
    }
}

/* geometry helpers -------------------------------------------------- */
function slotRect(type, idx) {
    if (type === 'stock') return { x: L.colX[0], y: L.topY, w: L.cw, h: L.ch };
    if (type === 'waste') return { x: L.colX[1], y: L.topY, w: L.cw, h: L.ch };
    if (type === 'found') return { x: L.colX[3 + idx], y: L.topY, w: L.cw, h: L.ch };
    return { x: L.colX[idx], y: L.tabY, w: L.cw, h: L.ch };
}

/* where the top waste card is drawn */
function wasteTopX() {
    var n = piles.waste.length;
    if (!n) return L.colX[1];
    return L.colX[1] + Math.max(0, Math.min(n, 3) - 1) * L.wasteFan;
}

function cardRect(type, idx, ci) {
    if (type === 'tab') {
        var off = tabOff[idx] || [];
        return { x: L.colX[idx], y: (off[ci] !== undefined ? off[ci] : L.tabY), w: L.cw, h: L.ch };
    }
    if (type === 'waste') return { x: wasteTopX(), y: L.topY, w: L.cw, h: L.ch };
    if (type === 'found') return { x: L.colX[3 + idx], y: L.topY, w: L.cw, h: L.ch };
    return { x: L.colX[0], y: L.topY, w: L.cw, h: L.ch };
}

function pileArr(type, idx) {
    if (type === 'stock') return piles.stock;
    if (type === 'waste') return piles.waste;
    if (type === 'found') return piles.found[idx] || [];
    return piles.tab[idx] || [];
}

function topOf(arr) { return arr.length ? arr[arr.length - 1] : null; }

/* ------------------------------------------------------------------ */
/* painting                                                            */
/* ------------------------------------------------------------------ */
function spriteFor(card) { return card.up ? card.id : backSprite(); }

function drawCardAt(ctx, spriteIdx, x, y, w, h) {
    drawSprite(ctx, spriteIdx, Math.round(x), Math.round(y),
               w !== undefined ? w : L.cw, h !== undefined ? h : L.ch);
}

function drawSlot(ctx, r) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5,
                   Math.round(r.w) - 1, Math.round(r.h) - 1);
}

/* the little circular arrow the real game shows on an exhausted deck */
function drawRecycle(ctx, r) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    var rad = Math.min(r.w, r.h) * 0.20;
    var a0 = Math.PI * 0.34, a1 = Math.PI * 1.72;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, a0, a1);
    ctx.stroke();
    var ax = cx + rad * Math.cos(a1), ay = cy + rad * Math.sin(a1);
    var tx = -Math.sin(a1), ty = Math.cos(a1), s = rad * 0.8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(ax + tx * s, ay + ty * s);
    ctx.lineTo(ax - ty * s * 0.9 - tx * s * 0.4, ay + tx * s * 0.9 - ty * s * 0.4);
    ctx.lineTo(ax + ty * s * 0.9 - tx * s * 0.4, ay - tx * s * 0.9 - ty * s * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/* the period-correct dotted focus rectangle */
function focusRect(ctx, r) {
    var x = Math.round(r.x) + 0.5, y = Math.round(r.y) + 0.5;
    var w = Math.round(r.w) - 1, h = Math.round(r.h) - 1;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(x, y, w, h);
    ctx.lineDashOffset = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
}

/* is this card currently lifted onto the drag layer? */
function isDragged(type, pileIdx, ci) {
    if (!drag || !drag.active) return false;
    if (drag.from.type !== type || drag.from.pile !== pileIdx) return false;
    return ci >= drag.from.card;
}

function render() {
    if (!boardCtx) return;
    layoutTab();
    var ctx = boardCtx, i, t, f;
    ctx.fillStyle = '#008000';                      /* table felt */
    ctx.fillRect(0, 0, L.w, L.h);

    drawSlot(ctx, slotRect('stock', 0));
    drawSlot(ctx, slotRect('waste', 0));
    for (f = 0; f < 4; f++) drawSlot(ctx, slotRect('found', f));
    for (t = 0; t < 7; t++) drawSlot(ctx, slotRect('tab', t));

    if (piles.stock.length) drawCardAt(ctx, backSprite(), L.colX[0], L.topY);
    else if (piles.waste.length) drawRecycle(ctx, slotRect('stock', 0));

    var n = piles.waste.length;
    if (n) {
        var first = Math.max(0, n - 3);
        for (i = first; i < n; i++) {
            if (isDragged('waste', 0, i)) continue;
            if (isFlicking(piles.waste[i])) continue;
            drawCardAt(ctx, piles.waste[i].id, L.colX[1] + (i - first) * L.wasteFan, L.topY);
        }
    }

    for (f = 0; f < 4; f++) {
        var fp = piles.found[f];
        if (!fp.length) continue;
        if (isDragged('found', f, fp.length - 1)) continue;
        drawCardAt(ctx, fp[fp.length - 1].id, L.colX[3 + f], L.topY);
    }

    for (t = 0; t < 7; t++) {
        var p = piles.tab[t], off = tabOff[t];
        for (i = 0; i < p.length; i++) {
            if (isDragged('tab', t, i)) continue;
            drawCardAt(ctx, spriteFor(p[i]), L.colX[t], off[i] !== undefined ? off[i] : L.tabY);
        }
    }

    drawSelection(ctx);
    drawKeyboardCursor(ctx);
}

function outlineRun(ctx, type, idx, from) {
    var p = pileArr(type, idx), i;
    if (!p.length) {
        focusRect(ctx, slotRect(type, idx));
        return;
    }
    for (i = Math.max(0, from); i < p.length; i++) {
        focusRect(ctx, cardRect(type, idx, i));
    }
}

function drawSelection(ctx) {
    if (!selection || (drag && drag.active)) return;
    outlineRun(ctx, selection.type, selection.pile, selection.card);
}

function slotOfCursor() {
    var s = cur.slot;
    if (s === 0) return { type: 'stock', pile: 0 };
    if (s === 1) return { type: 'waste', pile: 0 };
    if (s < 6) return { type: 'found', pile: s - 2 };
    return { type: 'tab', pile: s - 6 };
}

function drawKeyboardCursor(ctx) {
    var sl = slotOfCursor(), arr = pileArr(sl.type, sl.pile);
    var fromTop = Math.min(cur.card, Math.max(0, arr.length - 1));
    var ci = arr.length ? arr.length - 1 - fromTop : -1;
    var r;
    if (sl.type === 'stock') r = slotRect('stock', 0);
    else if (sl.type === 'waste') r = cardRect('waste', 0, 0);
    else if (sl.type === 'found') r = slotRect('found', sl.pile);
    else r = cardRect('tab', sl.pile, ci < 0 ? 0 : ci);
    focusRect(ctx, r);
}

/* the drag layer: only the lifted stack, redrawn on every mousemove */
function renderDrag() {
    if (!dragCtx) return;
    dragCtx.clearRect(0, 0, L.w, L.h);
    if (!drag || !drag.active) return;
    var pos = dragPreview();
    var i, card;
    for (i = 0; i < drag.cards.length; i++) {
        card = drag.cards[i];
        drawCardAt(dragCtx, card.id, pos.x, pos.y + i * (card.up ? L.fanUp : L.fanDown));
    }
    if (pos.target) {
        var r = pos.targetRect;
        dragCtx.strokeStyle = '#ffffff';
        dragCtx.lineWidth = 2;
        dragCtx.strokeRect(Math.round(r.x) + 1, Math.round(r.y) + 1,
                           Math.round(r.w) - 2, Math.round(r.h) - 2);
    }
}

/* where should the dragged stack be painted? (snaps to legal targets) */
function dragPreview() {
    var x = drag.mx - drag.grabX;
    var y = drag.my - drag.grabY;
    var tgt = dropTargetFor(drag);
    var res = { x: x, y: y, target: null, targetRect: null };
    if (tgt && canPlace(drag.cards, tgt.type, tgt.pile)) {
        var arr = pileArr(tgt.type, tgt.pile);
        res.x = (tgt.type === 'found') ? L.colX[3 + tgt.pile] : L.colX[tgt.pile];
        if (tgt.type === 'tab') {
            res.y = arr.length ? (tabOff[tgt.pile][arr.length - 1] + (arr[arr.length - 1].up ? L.fanUp : L.fanDown))
                               : L.tabY;
        } else {
            res.y = L.topY;
        }
        res.target = tgt;
        res.targetRect = cardRect(tgt.type, tgt.pile, Math.max(0, arr.length - 1));
    }
    return res;
}

/* ------------------------------------------------------------------ */
/* rules                                                               */
/* ------------------------------------------------------------------ */
function canPlace(cards, dstType, dstIdx) {
    if (!cards || !cards.length) return false;
    var c = cards[0];
    if (dstType === 'found') {
        if (cards.length > 1) return false;
        var f = piles.found[dstIdx];
        if (!f.length) return c.rank === 1;                       /* ace first */
        var tf = f[f.length - 1];
        return tf.suit === c.suit && tf.rank + 1 === c.rank;
    }
    if (dstType === 'tab') {
        var p = piles.tab[dstIdx];
        if (!p.length) return c.rank === 13;                      /* king to empty */
        var tp = p[p.length - 1];
        if (!tp.up) return false;
        return isRedSuit(tp.suit) !== isRedSuit(c.suit) && tp.rank === c.rank + 1;
    }
    return false;
}

/* the run a press picks up: every face-up card from ci down */
function draggableRun(type, pileIdx, ci) {
    var arr = pileArr(type, pileIdx);
    if (type === 'stock' || !arr.length || ci < 0 || ci >= arr.length) return null;
    var cards = [], i;
    for (i = ci; i < arr.length; i++) {
        if (!arr[i].up) return null;
        cards.push(arr[i]);
    }
    return cards.length ? cards : null;
}

function pushUndo() {
    if (opts.vegas) return;                                       /* Vegas: no undo */
    undoCards.push(snapshot());
}

function snapshot() {
    var up = [], i, t, f;
    for (i = 0; i < piles.stock.length; i++) if (piles.stock[i].up) up.push(piles.stock[i].id);
    for (i = 0; i < piles.waste.length; i++) if (piles.waste[i].up) up.push(piles.waste[i].id);
    for (f = 0; f < 4; f++) for (i = 0; i < piles.found[f].length; i++) if (piles.found[f][i].up) up.push(piles.found[f][i].id);
    for (t = 0; t < 7; t++) for (i = 0; i < piles.tab[t].length; i++) if (piles.tab[t][i].up) up.push(piles.tab[t][i].id);
    function ids(a) { var o = [], k; for (k = 0; k < a.length; k++) o.push(a[k].id); return o; }
    return {
        stock: ids(piles.stock), waste: ids(piles.waste),
        found: [ids(piles.found[0]), ids(piles.found[1]), ids(piles.found[2]), ids(piles.found[3])],
        tab: [ids(piles.tab[0]), ids(piles.tab[1]), ids(piles.tab[2]), ids(piles.tab[3]),
              ids(piles.tab[4]), ids(piles.tab[5]), ids(piles.tab[6])],
        up: up, score: score, moves: moves
    };
}

function applySnapshot(sn) {
    var i, t, f;
    function build(ids) {
        var o = [], k;
        for (k = 0; k < ids.length; k++) {
            var c = cardsById[ids[k]];
            if (!c) continue;
            c.up = false;
            o.push(c);
        }
        return o;
    }
    piles.stock = build(sn.stock);
    piles.waste = build(sn.waste);
    for (f = 0; f < 4; f++) piles.found[f] = build(sn.found[f] || []);
    for (t = 0; t < 7; t++) piles.tab[t] = build(sn.tab[t] || []);
    for (i = 0; i < (sn.up || []).length; i++) {
        var cu = cardsById[sn.up[i]];
        if (cu) cu.up = true;
    }
    score = sn.score;
    moves = sn.moves;
}

function undoMove() {
    if (opts.vegas) {                                     /* no score rollback in Vegas */
        sfxError();
        return;
    }
    if (!undoCards.length) { sfxError(); return; }
    var sn = undoCards.pop();
    modal = null;
    drag = null;
    selection = null;
    applySnapshot(sn);
    won = false;
    lastClick = null;
    render();
    updateStatus();
    rebuildMenu();
    saveGame();
    sfxFlip();
}

/* a card was uncovered: flip it and pay for it */
function flipExposed(pileIdx) {
    var p = piles.tab[pileIdx];
    var t = topOf(p);
    if (t && !t.up) {
        t.up = true;
        if (!opts.vegas) score += SCORE.FLIP_TABLEAU;
        sfxFlip();
        return true;
    }
    return false;
}

/* the one and only move primitive */
function doMove(fromType, fromPile, fromCard, toType, toPile) {
    if (won || autoRunning) return false;
    if (fromType === toType && fromPile === toPile) return false;
    var src = pileArr(fromType, fromPile);
    if (!src.length || fromCard < 0 || fromCard >= src.length) return false;
    var cards = src.slice(fromCard), i;
    if (!canPlace(cards, toType, toPile)) return false;

    pushUndo();
    src.length = fromCard;
    var dst = pileArr(toType, toPile);
    for (i = 0; i < cards.length; i++) dst.push(cards[i]);

    if (!opts.vegas) {
        if (toType === 'found') {
            score += (fromType === 'waste') ? SCORE.WASTE_TO_FOUNDATION : SCORE.TABLEAU_TO_FOUNDATION;
        } else if (toType === 'tab') {
            if (fromType === 'waste') score += SCORE.WASTE_TO_TABLEAU;
            else if (fromType === 'found') score += SCORE.FOUNDATION_TO_TABLEAU;
        }
    } else if (toType === 'found') {
        score += VEGAS_PER_CARD;                         /* $5 per foundation card */
    } else if (fromType === 'found' && toType === 'tab') {
        score -= VEGAS_PER_CARD;
    }
    moves++;
    if (fromType === 'tab') flipExposed(fromPile);
    selection = null;
    cur.slot = slotIndexFor(toType, toPile);
    cur.card = 0;
    sfxPlace(toType === 'found');
    afterMove();
    return true;
}

function slotIndexFor(type, pile) {
    if (type === 'stock') return 0;
    if (type === 'waste') return 1;
    if (type === 'found') return 2 + pile;
    return 6 + pile;
}

function startClock() {
    if (!gameStarted) {
        gameStarted = true;
        startTicked = W98.tick();
    }
}

function afterMove() {
    startClock();
    layoutTab();
    render();
    updateStatus();
    rebuildMenu();
    saveGame();
    checkWin();
    checkAutoComplete();
}

/* stock click: deal one (or three) / recycle the waste */
function drawStock() {
    if (won || autoRunning) return;
    var drawn = [];
    if (!piles.stock.length) {
        if (!piles.waste.length) return;                  /* empty + empty: no-op */
        pushUndo();
        var n = piles.waste.length, i;
        for (i = n - 1; i >= 0; i--) {
            piles.waste[i].up = false;
            piles.stock.push(piles.waste[i]);
        }
        piles.waste.length = 0;
        if (!opts.vegas) {
            score += opts.draw3 ? SCORE.RECYCLE_DRAW_THREE : SCORE.RECYCLE_DRAW_ONE;
        }
        moves++;
        sfxFlip();
    } else {
        pushUndo();
        var k = opts.draw3 ? 3 : 1;
        drawn = [];
        for (i = 0; i < k && piles.stock.length; i++) {
            var c = piles.stock.pop();
            c.up = true;
            piles.waste.push(c);
            drawn.push(c);
        }
        moves++;
        sfxPlace(false);
    }
    selection = null;
    if (drawn.length) startFlick(drawn);       /* the classic flick over to the waste */
    afterMove();
}

/* double click / "A" key: try to bank the card on a foundation */
function sendToFoundation(type, pileIdx, ci) {
    if (won || autoRunning) return false;
    var arr = pileArr(type, pileIdx);
    if (!arr.length || ci !== arr.length - 1) return false;
    var card = arr[ci];
    if (!card.up) return false;
    var f;
    for (f = 0; f < 4; f++) {
        if (canPlace([card], 'found', f)) return doMove(type, pileIdx, ci, 'found', f);
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* automatic finish when the tableau can no longer hold anything        */
/* ------------------------------------------------------------------ */
function checkAutoComplete() {
    if (won || autoRunning || !gameStarted) return;
    var tabEmpty = true, allUp = true, t, i;
    for (t = 0; t < 7; t++) {
        var p = piles.tab[t];
        if (p.length) tabEmpty = false;
        for (i = 0; i < p.length; i++) if (!p[i].up) allUp = false;
    }
    var haveLoose = piles.stock.length || piles.waste.length;
    if (!tabEmpty && !(allUp && !haveLoose)) return;
    if (tabEmpty && !haveLoose) return;                    /* nothing left, just not won */
    autoRunning = true;
    autoSteps = 0;
    autoStep();
}

function autoStep() {
    if (!autoRunning) return;
    if (++autoSteps > 400) { autoRunning = false; return; }
    var t, f, moved = false;
    /* 1. any exposed card that fits a foundation */
    for (t = 0; t < 7 && !moved; t++) {
        var p = piles.tab[t];
        if (!p.length) continue;
        var c = p[p.length - 1];
        if (!c.up) continue;
        for (f = 0; f < 4; f++) {
            if (canPlace([c], 'found', f)) {
                applyAutoMove('tab', t, p.length - 1, 'found', f);
                moved = true;
                break;
            }
        }
    }
    if (!moved && piles.waste.length) {
        var w = piles.waste[piles.waste.length - 1];
        if (w.up) {
            for (f = 0; f < 4; f++) {
                if (canPlace([w], 'found', f)) {
                    applyAutoMove('waste', 0, piles.waste.length - 1, 'found', f);
                    moved = true;
                    break;
                }
            }
        }
    }
    if (moved) {
        later(autoStep, 55);
        return;
    }
    /* 2. nothing playable: if the tableau is empty, keep cycling the deck */
    var tabEmpty = true;
    for (t = 0; t < 7; t++) if (piles.tab[t].length) tabEmpty = false;
    if (tabEmpty && (piles.stock.length || piles.waste.length)) {
        drawStock();
        if (won) { autoRunning = false; return; }
        later(autoStep, 55);
        return;
    }
    autoRunning = false;
    checkWin();
}

function applyAutoMove(fromType, fromPile, fromCard, toType, toPile) {
    var src = pileArr(fromType, fromPile);
    var cards = src.slice(fromCard);
    src.length = fromCard;
    var dst = pileArr(toType, toPile), i;
    for (i = 0; i < cards.length; i++) dst.push(cards[i]);
    moves++;
    layoutTab();
    render();
    updateStatus();
    saveGame();
    sfxPlace(true);
}

function foundationCount() {
    return piles.found[0].length + piles.found[1].length +
           piles.found[2].length + piles.found[3].length;
}

function checkWin() {
    if (won) return;
    if (foundationCount() === 52) onWin();
}

function onWin() {
    won = true;
    selection = null;
    drag = null;
    autoRunning = false;
    stopFxAnim(false);
    regSet('GamesWon', regGetInt('GamesWon', 0) + 1);
    regSet('BestScore', Math.max(score, regGetInt('BestScore', 0)));
    regSet('BestTime', bestTime(accElapsed()));
    regSet('SaveGame', '');                       /* next launch deals fresh */
    updateStatus();
    rebuildMenu();
    startWinFx();
    sfxWin();
}

/* ------------------------------------------------------------------ */
/* persistence (registry)                                              */
/* ------------------------------------------------------------------ */
function regGet(name, def) {
    try {
        if (!W98.reg || typeof W98.reg.get !== 'function') return def;
        var v = W98.reg.get(REG_PATH, name, def);
        return (v === undefined || v === null) ? def : v;
    } catch (e) { return def; }
}
function regGetInt(name, def) {
    var v = parseInt(regGet(name, def), 10);
    return isNaN(v) ? def : v;
}
function regSet(name, val) {
    try {
        if (W98.reg && typeof W98.reg.set === 'function') {
            W98.reg.set(REG_PATH, name, String(val));
        }
    } catch (e) { /* the registry is best effort, never fatal */ }
}

function bestTime(sec) {
    var b = regGetInt('BestTime', 0);
    return (!b || sec < b) ? sec : b;
}

function loadOptions() {
    opts.draw3 = regGetInt('Draw', 3) !== 1;
    opts.deck = clamp(regGetInt('Deck', 0), 0, NUM_BACKS - 1);
    opts.vegas = String(regGet('Scoring', 'Standard')).toLowerCase() === 'vegas';
    opts.timed = regGetInt('Timed', 1) !== 0;
}

function saveOptions() {
    regSet('Draw', opts.draw3 ? 3 : 1);
    regSet('Deck', opts.deck);
    regSet('Scoring', opts.vegas ? 'Vegas' : 'Standard');
    regSet('Timed', opts.timed ? 1 : 0);
}

function accElapsed() {
    if (!gameStarted) return accSec;
    return accSec + Math.floor((W98.tick() - startTicked) / 1000);
}

function saveGame() {
    if (won) { regSet('SaveGame', ''); return; }
    if (!gameStarted && !moves) { regSet('SaveGame', ''); return; }
    var st = {
        v: 1, deck: opts.deck, vegas: opts.vegas ? 1 : 0, timed: opts.timed ? 1 : 0,
        draw3: opts.draw3 ? 1 : 0, score: score, moves: moves, time: accElapsed(),
        started: gameStarted ? 1 : 0,
        stock: idsOf(piles.stock), waste: idsOf(piles.waste),
        found: [idsOf(piles.found[0]), idsOf(piles.found[1]), idsOf(piles.found[2]), idsOf(piles.found[3])],
        tab: [idsOf(piles.tab[0]), idsOf(piles.tab[1]), idsOf(piles.tab[2]), idsOf(piles.tab[3]),
              idsOf(piles.tab[4]), idsOf(piles.tab[5]), idsOf(piles.tab[6])],
        up: upIds()
    };
    regSet('SaveGame', JSON.stringify(st));
    saveOptions();
}

function idsOf(a) { var o = [], i; for (i = 0; i < a.length; i++) o.push(a[i].id); return o; }
function upIds() {
    var up = [], t, f, i;
    function scan(a) { for (var k = 0; k < a.length; k++) if (a[k].up) up.push(a[k].id); }
    scan(piles.stock); scan(piles.waste);
    for (f = 0; f < 4; f++) scan(piles.found[f]);
    for (t = 0; t < 7; t++) scan(piles.tab[t]);
    return up;
}

function restoreGame() {
    var raw = regGet('SaveGame', '');
    if (!raw || typeof raw !== 'string') return false;
    var st;
    try { st = JSON.parse(raw); } catch (e) { return false; }
    if (!st || st.v !== 1) return false;
    var seen = {}, total = 0, t, f, i;
    function check(a, into) {
        if (!a || !a.length && !into) { /* empty piles are fine */ }
        if (!a) return null;
        var o = [];
        for (var k = 0; k < a.length; k++) {
            var id = a[k];
            if (typeof id !== 'number' || id < 0 || id > 51 || seen[id]) return null;
            seen[id] = 1;
            total++;
            o.push(id);
        }
        return o;
    }
    var stock = check(st.stock, true), waste = check(st.waste, true);
    if (!stock || !waste) return false;
    var found = [], tab = [];
    for (f = 0; f < 4; f++) { var fv = check(st.found && st.found[f], true); if (!fv) return false; found.push(fv); }
    for (t = 0; t < 7; t++) { var tv = check(st.tab && st.tab[t], true); if (!tv) return false; tab.push(tv); }
    if (total !== 52) return false;

    /* rebuild the canonical deck, then lay the saved cards back out */
    newDeck();
    function build(ids) { var o = [], k; for (k = 0; k < ids.length; k++) { var c = cardsById[ids[k]]; c.up = false; o.push(c); } return o; }
    piles.stock = build(stock);
    piles.waste = build(waste);
    for (f = 0; f < 4; f++) piles.found[f] = build(found[f]);
    for (t = 0; t < 7; t++) piles.tab[t] = build(tab[t]);
    for (i = 0; i < (st.up || []).length; i++) {
        var cu = cardsById[st.up[i]];
        if (cu) cu.up = true;
    }
    opts.draw3 = st.draw3 ? true : false;
    opts.deck = clamp(st.deck | 0, 0, NUM_BACKS - 1);
    opts.vegas = !!st.vegas;
    opts.timed = !!st.timed;
    score = st.score | 0;
    moves = st.moves | 0;
    accSec = st.time | 0;
    undoCards = [];
    won = false;
    gameStarted = !!st.started;
    startTicked = W98.tick();
    penTick = Math.floor(accSec / 10);
    return true;
}

/* ------------------------------------------------------------------ */
/* kernel timers (nothing is left running when the window goes away)    */
/* ------------------------------------------------------------------ */
function later(fn, ms) {
    var id = win.setTimeout(function () {
        var i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
        fn();
    }, ms);
    timers.push(id);
    return id;
}
function clearLater(id) {
    try { win.clearTimeout(id); } catch (e) {}
    var i = timers.indexOf(id);
    if (i >= 0) timers.splice(i, 1);
}
function clearAllTimers() {
    var i;
    for (i = 0; i < timers.length; i++) { try { win.clearTimeout(timers[i]); } catch (e) {} }
    timers = [];
    flickId = null;
}

/* ------------------------------------------------------------------ */
/* sound                                                               */
/* ------------------------------------------------------------------ */
function tone(f, ms, type) {
    try {
        if (W98.sound && typeof W98.sound.tone === 'function') W98.sound.tone(f, ms, type || 'square');
    } catch (e) {}
}
function sfxFlip()  { tone(760, 24, 'square'); }
function sfxPlace(bank) { tone(bank ? 1046 : 520, 28, 'square'); }
function sfxError() { tone(150, 80, 'square'); }
function sfxDeal() {
    var notes = [392, 494, 587, 698], i;
    for (i = 0; i < notes.length; i++) {
        later((function (f) { return function () { tone(f, 40, 'square'); }; })(notes[i]), i * 65);
    }
}
function sfxWin() {
    var notes = [523, 659, 784, 1047, 1319, 1568], i;
    for (i = 0; i < notes.length; i++) {
        later((function (f) { return function () { tone(f, 150, 'triangle'); }; })(notes[i]), 240 + i * 140);
    }
}

/* ------------------------------------------------------------------ */
/* the classic bouncing-card win animation (W98.raf only)               */
/* ------------------------------------------------------------------ */
function startWinFx() {
    if (fxRunning || !fxCtx) return;
    fxRunning = true;
    fxCtx.clearRect(0, 0, L.w, L.h);
    fxParts = [];
    var f, i, c, p;
    for (f = 0; f < 4; f++) {
        for (i = 0; i < piles.found[f].length; i++) {
            c = piles.found[f][i];
            p = {
                id: c.id, age: 0,
                x: L.colX[3 + f] + rnd(-2, 2), y: L.topY + rnd(-2, 2),
                vx: rnd(-4.5, 4.5), vy: -rnd(3, 9),
                delay: fxParts.length * 30
            };
            fxParts.push(p);
        }
    }
    fxStartAt = W98.tick();
    fxSndAt = 0;
    fxFrames = 0;
    fxCancel = W98.raf(fxFrame);
}

function fxFrame(dt) {
    if (!fxRunning) return;
    var steps = clamp((dt || 16.7) / 16.7, 0.4, 3);
    var now = W98.tick(), i, p, bounced;
    /* two independent stops: the kernel clock and a plain frame budget */
    if (now - fxStartAt > 45000 || ++fxFrames > 3600) fxParts.length = 0;
    for (i = fxParts.length - 1; i >= 0; i--) {
        p = fxParts[i];
        if (p.delay > 0) { p.delay -= (dt || 16.7); continue; }
        p.age += (dt || 16.7);
        p.vy += 0.40 * steps;
        p.x += p.vx * steps;
        p.y += p.vy * steps;
        bounced = false;
        if (p.x < 0) { p.x = 0; p.vx = -p.vx * 0.86; bounced = true; }
        if (p.x + L.cw > L.w) { p.x = Math.max(0, L.w - L.cw); p.vx = -p.vx * 0.86; bounced = true; }
        if (p.y + L.ch > L.h) {
            p.y = Math.max(0, L.h - L.ch);
            p.vy = -p.vy * 0.82;
            if (Math.abs(p.vy) < 3) p.vy = -rnd(5, 9);
            bounced = true;
        }
        if (bounced) fxBounce();
        /* once the novelty wears off every card leaves through the top */
        if (p.age > 5200 && p.vy > -12) p.vy = -rnd(16, 22);
        if (p.y + L.ch < -4 || p.y > L.h + L.ch + 8) { fxParts.splice(i, 1); continue; }
        drawCardAt(fxCtx, p.id, p.x, p.y);                   /* leaves the classic trail */
    }
    if (!fxParts.length) { stopFxAnim(false); return; }
}

function fxBounce() {
    var now = W98.tick();
    if (now - fxSndAt < 60) return;                          /* never machine-gun the mixer */
    fxSndAt = now;
    tone(rnd(680, 1500), 16, 'square');
}

function stopFxAnim(clear) {
    fxRunning = false;
    if (fxCancel) { try { fxCancel(); } catch (e) {} fxCancel = null; }
    fxParts = [];
    if (clear && fxCtx) fxCtx.clearRect(0, 0, L.w, L.h);
}
var fxStartAt = 0;
var fxFrames = 0;

/* ------------------------------------------------------------------ */
/* the stock -> waste flick (drawn on the drag layer, kernel timers)    */
/* ------------------------------------------------------------------ */
function isFlicking(card) {
    if (!flick) return false;
    for (var i = 0; i < flick.ids.length; i++) if (flick.ids[i] === card.id) return true;
    return false;
}

function startFlick(drawn) {
    if (!dragCtx || !drawn || !drawn.length) return;
    var n = piles.waste.length, first = Math.max(0, n - 3);
    var ids = [], tx = [], i;
    for (i = 0; i < drawn.length; i++) {
        ids.push(drawn[i].id);
        tx.push(L.colX[1] + (n - drawn.length + i - first) * L.wasteFan);
    }
    if (flickId) { clearLater(flickId); flickId = null; }
    flick = { ids: ids, tx: tx, t0: W98.tick(), dur: 130, frames: 0 };
    stepFlick();
}

function stepFlick() {
    flickId = null;
    if (!flick || !dragCtx) return;
    var k = (W98.tick() - flick.t0) / flick.dur;
    /* the frame cap keeps the flick finite even if the kernel clock stalls */
    if (k >= 1 || ++flick.frames > 24 || (drag && drag.active)) {
        flick = null;
        dragCtx.clearRect(0, 0, L.w, L.h);
        render();
        return;
    }
    dragCtx.clearRect(0, 0, L.w, L.h);
    for (var i = 0; i < flick.ids.length; i++) {
        var x = L.colX[0] + (flick.tx[i] - L.colX[0]) * k;
        var y = L.topY - Math.sin(Math.PI * k) * 6;
        drawCardAt(dragCtx, flick.ids[i], x, y);
    }
    flickId = later(stepFlick, 16);
}

/* ------------------------------------------------------------------ */
/* status bar                                                          */
/* ------------------------------------------------------------------ */
function fmtTime(sec) {
    if (sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
}
function money(v) { return (v < 0 ? '-$' + Math.abs(v) : '$' + v); }

function updateStatus() {
    if (!win || typeof win.setStatus !== 'function') return;
    var s = 'Score: ' + (opts.vegas ? money(score) : score);
    var t = 'Time: ' + fmtTime(accElapsed());
    var m = won ? 'You win!' : (autoRunning ? 'Finishing…' : 'Moves: ' + moves);
    var sig = s + '|' + t + '|' + m;
    if (sig === lastStatus) return;
    lastStatus = sig;
    try {
        win.setStatus([{ text: s, width: 140 }, { text: t, width: 110 }, { text: m }]);
    } catch (e) {}
}

function onTick() {
    if (!won && gameStarted) {
        var s10 = Math.floor(accElapsed() / 10);
        if (s10 > penTick) {
            penTick = s10;
            /* the clock costs you -- but never pushes you below zero-watch rules */
            if (opts.timed && !opts.vegas && score >= 0) score += SCORE.TIMED;
        }
    }
    updateStatus();
}

/* ------------------------------------------------------------------ */
/* menus                                                               */
/* ------------------------------------------------------------------ */
var lastMenuSig = '';

function undoDisabled() { return opts.vegas || !undoCards.length || won; }
function menuSignature() {
    return (opts.draw3 ? '3' : '1') + '|' + (opts.vegas ? 'v' : 's') + '|' + (opts.timed ? 't' : 'n') +
           '|' + opts.deck + '|' + (undoDisabled() ? 'x' : 'u');
}
/* The shell closes a menu before running its command, so setMenu can be called
   straight from a menu handler; no kernel timer is involved (which also means the
   menu bar is there the moment the window opens). */
function rebuildMenu() {
    if (!win || typeof win.setMenu !== 'function') return;
    if (menuSignature() === lastMenuSig) return;
    applyMenu();
}
function applyMenu() {
    var sig = menuSignature();
    if (sig === lastMenuSig) return;
    lastMenuSig = sig;
    try {
        win.setMenu([
            { label: '&Game', items: [
                { label: '&Deal', accel: 'F2', onclick: dealNew },
                { label: '&Undo', accel: 'Ctrl+Z', disabled: undoDisabled(), onclick: undoMove },
                { type: 'sep' },
                { label: 'Dra&w one', type: 'radio', checked: !opts.draw3,
                  onclick: function () { setDrawMode(false); } },
                { label: 'Draw &three', type: 'radio', checked: opts.draw3,
                  onclick: function () { setDrawMode(true); } },
                { type: 'sep' },
                { label: '&Options…', onclick: openOptionsDialog },
                { type: 'sep' },
                { label: 'E&xit', onclick: function () { win.close(); } }
            ]},
            { label: '&Deck', items: [
                { label: '&Deck…', onclick: openDeckDialog },
                { type: 'sep' }
            ].concat(deckMenuItems()) },
            { label: '&Help', items: [
                { label: '&How to Play', accel: 'F1', onclick: showHelp },
                { type: 'sep' },
                { label: '&About Solitaire…', onclick: showAbout }
            ]}
        ]);
    } catch (e) {}
}

var DECK_NAMES = ['&Classic blue', '&Ruby red', '&Emerald', '&Amethyst'];

function deckMenuItems() {
    var out = [], i;
    for (i = 0; i < NUM_BACKS; i++) {
        out.push((function (n) {
            return {
                label: DECK_NAMES[n] || ('Deck ' + (n + 1)),
                type: 'radio', checked: opts.deck === n,
                onclick: function () { setDeck(n); }
            };
        })(i));
    }
    return out;
}

function setDeck(n) {
    if (n < 0 || n >= NUM_BACKS || n === opts.deck) return;
    opts.deck = n;
    saveOptions();
    if (fxCtx) fxCtx.clearRect(0, 0, L.w, L.h);
    render();                                        /* the backs are sprites: repaint */
    rebuildMenu();
    saveGame();
}

function setDrawMode(three) {
    opts.draw3 = !!three;
    saveOptions();
    layoutTab();
    render();
    updateStatus();
    rebuildMenu();
}

/* ------------------------------------------------------------------ */
/* dialogs (real Win98 style modal boxes inside the client area)        */
/* ------------------------------------------------------------------ */
var STYLE_ID = 'solitaire-app-style';
function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
        '.solitaire-root{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;' +
        'background:#008000;cursor:default;-webkit-user-select:none;-moz-user-select:none;' +
        'user-select:none;touch-action:none}' +
        '.solitaire-canvas{position:absolute;left:0;top:0;pointer-events:none;' +
        'image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges}' +
        '.solitaire-dlg{position:absolute;z-index:60}' +
        '.solitaire-dlg .window-body{display:flex;flex-direction:column;gap:6px}' +
        '.solitaire-dlg .sd-btns{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}' +
        '.solitaire-dlg fieldset{margin:0}' +
        '.solitaire-dlg .sd-pick{display:inline-block;padding:1px;border:1px solid transparent}' +
        '.solitaire-dlg .sd-pick.sel{background:#000080}' +
        '.solitaire-dlg .sd-scroll{height:150px;overflow:auto;background:#ffffff;color:#000;' +
        'border:2px solid;border-color:#808080 #ffffff #ffffff #808080;padding:6px}' +
        '.solitaire-dlg .sd-scroll h4{margin:6px 0 2px;font-size:11px}' +
        '.solitaire-dlg .sd-scroll p{margin:2px 0 6px}';

    (document.head || document.documentElement).appendChild(st);
}

function closeDlg() {
    if (!modal) return;
    document.removeEventListener('keydown', dlgKey, true);
    if (modal.el && modal.el.parentNode) modal.el.parentNode.removeChild(modal.el);
    modal = null;
}

function dlgKey(e) {
    if (!modal) return;
    var k = e.key;
    if (k === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        closeDlg();
    } else if (k === 'Enter') {
        var ok = modal.onOk;
        e.preventDefault(); e.stopPropagation();
        closeDlg();
        if (ok) ok();
    }
}

/* a real Win98 modal dialog: .window chrome, a real button row */
function openDlg(spec) {
    closeDlg();
    var el = document.createElement('div');
    el.className = 'window solitaire-dlg';
    el.style.width = (spec.width || 240) + 'px';

    var tb = document.createElement('div');
    tb.className = 'title-bar';
    var ttx = document.createElement('div');
    ttx.className = 'title-bar-text';
    ttx.textContent = spec.title;
    var tbc = document.createElement('div');
    tbc.className = 'title-bar-controls';
    var xb = document.createElement('button');
    xb.setAttribute('aria-label', 'Close');
    xb.title = 'Close';
    xb.onclick = function () { closeDlg(); };
    tbc.appendChild(xb);
    tb.appendChild(ttx);
    tb.appendChild(tbc);

    var body = document.createElement('div');
    body.className = 'window-body';

    var btns = document.createElement('div');
    btns.className = 'sd-btns';
    var okB = document.createElement('button');
    okB.className = 'default';
    okB.textContent = spec.okText || 'OK';
    var caB = document.createElement('button');
    caB.textContent = 'Cancel';
    if (spec.buttons === 'close') caB.style.display = 'none';
    okB.onclick = function () {
        var fn = (modal && modal.onOk) || spec.onOk;
        closeDlg();
        if (fn) fn();
    };
    caB.onclick = function () { closeDlg(); };
    btns.appendChild(okB);
    btns.appendChild(caB);

    el.appendChild(tb);
    el.appendChild(body);
    root.appendChild(el);

    modal = { el: el, onOk: spec.onOk };
    if (spec.build) spec.build(body, el);
    body.appendChild(btns);

    var l = Math.max(4, Math.floor((L.w - el.offsetWidth) / 2));
    var t = Math.max(4, Math.floor((L.h - el.offsetHeight) / 2));
    el.style.left = l + 'px';
    el.style.top = t + 'px';

    document.addEventListener('keydown', dlgKey, true);
    try { okB.focus(); } catch (e) {}
    return el;
}

/* ---- Deck… -------------------------------------------------------- */
function openDeckDialog() {
    openDlg({
        title: 'Deck',
        width: 232,
        okText: 'OK',
        build: function (body) {
            var wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;gap:10px;align-items:flex-start';

            var prev = mkCanvas(CARD_W, CARD_H);
            prev.style.cssText = 'border:1px solid #000;background:#008000';

            var grid = document.createElement('div');
            grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px';

            var sel = opts.deck, picks = [];
            function paint() {
                var pctx = ctx2d(prev);
                pctx.clearRect(0, 0, CARD_W, CARD_H);
                drawSprite(pctx, 52 + sel, 0, 0, CARD_W, CARD_H);
                for (var i = 0; i < picks.length; i++) {
                    if (i === sel) picks[i].className = 'sd-pick sel';
                    else picks[i].className = 'sd-pick';
                }
            }
            for (var i = 0; i < NUM_BACKS; i++) {
                var mini = mkCanvas(48, 65);
                var mctx = ctx2d(mini);
                drawSprite(mctx, 52 + i, 0, 0, 48, 65);
                var cell = document.createElement('div');
                cell.className = 'sd-pick';
                cell.appendChild(mini);
                (function (n) {
                    cell.onclick = function () { sel = n; paint(); };
                })(i);
                picks.push(cell);
                grid.appendChild(cell);
            }
            wrap.appendChild(prev);
            wrap.appendChild(grid);
            body.appendChild(wrap);
            paint();

            modal.onOk = function () {
                if (sel !== opts.deck) {
                    opts.deck = sel;
                    saveOptions();
                    render();
                    saveGame();
                }
            };
        }
    });
}

/* ---- Options… ----------------------------------------------------- */
function openOptionsDialog() {
    openDlg({
        title: 'Options',
        width: 236,
        build: function (body) {
            function fieldset(legend) {
                var fs = document.createElement('fieldset');
                var lg = document.createElement('legend');
                lg.textContent = legend;
                fs.appendChild(lg);
                return fs;
            }
            function radio(name, label, checked) {
                var lab = document.createElement('label');
                var inp = document.createElement('input');
                inp.type = 'radio';
                inp.name = 'sol-' + name;
                inp.checked = !!checked;
                lab.appendChild(inp);
                lab.appendChild(document.createTextNode(' ' + label));
                lab._input = inp;
                return lab;
            }
            function check(label, checked) {
                var lab = document.createElement('label');
                var inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.checked = !!checked;
                lab.appendChild(inp);
                lab.appendChild(document.createTextNode(' ' + label));
                lab._input = inp;
                return lab;
            }

            var fsDraw = fieldset('Draw');
            var rOne = radio('draw', 'Draw one', !opts.draw3);
            var rThree = radio('draw', 'Draw three', opts.draw3);
            fsDraw.appendChild(rOne);
            fsDraw.appendChild(rThree);

            var fsScore = fieldset('Scoring');
            var sStd = radio('score', 'Standard', !opts.vegas);
            var sVeg = radio('score', 'Vegas', opts.vegas);
            fsScore.appendChild(sStd);
            fsScore.appendChild(sVeg);

            var fsTime = fieldset('Timed game');
            var cTime = check('Keep score for a timed game', opts.timed);
            fsTime.appendChild(cTime);

            body.appendChild(fsDraw);
            body.appendChild(fsScore);
            body.appendChild(fsTime);

            modal.onOk = function () {
                var newDraw3 = rThree._input.checked;
                var newVegas = sVeg._input.checked;
                var newTimed = cTime._input.checked;

                opts.draw3 = newDraw3;
                opts.timed = newTimed;
                if (newVegas !== opts.vegas) {
                    opts.vegas = newVegas;
                    if (moves === 0) score = opts.vegas ? VEGAS_START : 0;
                }
                saveOptions();
                layoutTab();
                render();
                updateStatus();
                rebuildMenu();
                saveGame();
            };
        }
    });
}

/* ---- Help / About -------------------------------------------------- */
function showHelp() {
    var html = '';
    html += '<h4>Object</h4><p>Build the four foundations up in suit from Ace to King.</p>';
    html += '<h4>Tableau</h4><p>Build the seven columns down in alternating colors ' +
            '(red on black, black on red). Only a King may start an empty column.</p>';
    html += '<h4>Playing</h4><p>Click the deck to turn cards over; it goes round again ' +
            'when it is exhausted. Drag cards with the mouse, or click a card and then ' +
            'click where you want it to go. Double-click a card to send it home.</p>';
    html += '<h4>Keyboard</h4><p>Arrow keys move the highlight, Enter picks a card up and ' +
            'puts it down, F2 deals, Ctrl+Z undoes, D turns the deck.</p>';
    html += '<h4>Scoring</h4><p>Standard: waste to a column +' + SCORE.WASTE_TO_TABLEAU +
            ', to a foundation +' + SCORE.TABLEAU_TO_FOUNDATION + ', turning a column card +' +
            SCORE.FLIP_TABLEAU + ', out of a foundation ' + SCORE.FOUNDATION_TO_TABLEAU +
            ', another pass through the deck ' + SCORE.RECYCLE_DRAW_THREE + '/' +
            SCORE.RECYCLE_DRAW_ONE + '.</p>';
    html += '<p>Vegas deals you in at ' + money(VEGAS_START) + ' and pays ' +
            money(VEGAS_PER_CARD) + ' a card; there is no undo.</p>';
    openDlg({
        title: 'How to Play Solitaire', width: 320, buttons: 'close', okText: 'OK',
        build: function (body) {
            var d = document.createElement('div');
            d.className = 'sd-scroll';
            d.innerHTML = html;
            body.appendChild(d);
        }
    });
}

function showAbout() {
    var lines = 'Klondike Solitaire\n\n' +
        'Score mode: ' + (opts.vegas ? 'Vegas' : 'Standard') + '\n' +
        'Draw: ' + (opts.draw3 ? 'three' : 'one') + '\n' +
        'Games played: ' + regGetInt('GamesPlayed', 0) + '\n' +
        'Games won: ' + regGetInt('GamesWon', 0) + '\n' +
        'Best score: ' + regGetInt('BestScore', 0) + '\n' +
        'Best time: ' + fmtTime(regGetInt('BestTime', 0));
    var used = false;
    if (typeof W98.aboutDialog === 'function') {
        try {
            W98.aboutDialog({ id: APP_ID, title: APP_TITLE, icon: APP_ICON, version: '1.0', notes: lines });
            used = true;
        } catch (e) { used = false; }
    }
    if (used) return;
    openDlg({
        title: 'About Solitaire', width: 260, buttons: 'close', okText: 'OK',
        build: function (body) {
            var d = document.createElement('div');
            d.className = 'sd-scroll';
            d.style.height = 'auto';
            d.style.whiteSpace = 'pre';
            d.textContent = APP_TITLE + ' 1.0\n\n' + lines;
            body.appendChild(d);
        }
    });
}

/* ------------------------------------------------------------------ */
/* mouse input                                                         */
/* ------------------------------------------------------------------ */
function pos(e) {
    var r = boardC.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function hitTest(x, y) {
    if (inRect(x, y, slotRect('stock', 0))) return { type: 'stock', pile: 0, card: -1 };

    var n = piles.waste.length;
    if (n) {
        var wx = wasteTopX();
        if (inRect(x, y, { x: wx, y: L.topY, w: L.cw, h: L.ch })) return { type: 'waste', pile: 0, card: n - 1 };
    } else if (inRect(x, y, slotRect('waste', 0))) {
        return { type: 'waste', pile: 0, card: -1 };
    }

    var f, t, i;
    for (f = 0; f < 4; f++) {
        if (inRect(x, y, slotRect('found', f))) {
            var fp = piles.found[f];
            return { type: 'found', pile: f, card: fp.length ? fp.length - 1 : -1 };
        }
    }
    for (t = 0; t < 7; t++) {
        if (x < L.colX[t] || x >= L.colX[t] + L.cw) continue;
        var p = piles.tab[t], off = tabOff[t];
        if (!p.length) {
            if (y >= L.tabY && y < L.tabY + L.ch) return { type: 'tab', pile: t, card: -1 };
            continue;
        }
        if (y < off[0] || y >= off[p.length - 1] + L.ch) continue;
        for (i = p.length - 1; i >= 0; i--) {
            if (y >= off[i]) return { type: 'tab', pile: t, card: i };
        }
    }
    return null;
}

function pileBounds(type, idx) {
    var r = slotRect(type, idx);
    if (type === 'tab') {
        var p = piles.tab[idx], off = tabOff[idx];
        if (p.length) r.h = (off[p.length - 1] - L.tabY) + L.ch;
    }
    return r;
}

/* where the cursor is holding the dragged stack */
function dropTargetFor(d) {
    var x = d.mx - d.grabX + L.cw / 2;
    var y = d.my - d.grabY + L.ch / 2;
    var f, t, r;
    for (f = 0; f < 4; f++) {
        r = slotRect('found', f);
        if (x >= r.x - 4 && x < r.x + r.w + 4 && y >= r.y - 6 && y < r.y + r.h + 6) {
            return { type: 'found', pile: f };
        }
    }
    for (t = 0; t < 7; t++) {
        r = pileBounds('tab', t);
        if (x >= r.x - 3 && x < r.x + r.w + 3 && y >= L.tabY - 10 && y < r.y + r.h + 10) {
            return { type: 'tab', pile: t };
        }
    }
    return null;
}

function draggableFrom(hit) { return draggableRun(hit.type, hit.pile, hit.card); }

function onDown(e) {
    if (!win || modal) return;
    if (e.button !== undefined && e.button !== 0) return;
    var p = pos(e);
    var hit = hitTest(p.x, p.y);
    try { win.focus(); } catch (err) {}

    if (!hit) {
        if (selection) { selection = null; render(); }
        return;
    }
    if (hit.type === 'stock') {
        selection = null;
        cur.slot = 0; cur.card = 0;
        drawStock();
        return;
    }
    if (hit.card < 0) {
        if (selection) {
            if (!tryPlaceSelection(hit.type, hit.pile)) sfxError();
        } else {
            cur.slot = slotIndexFor(hit.type, hit.pile);
            cur.card = 0;
            render();
        }
        return;
    }
    if (selection && !(selection.type === hit.type && selection.pile === hit.pile)) {
        if (tryPlaceSelection(hit.type, hit.pile)) return;
    }
    var cards = draggableFrom(hit);
    if (!cards) { render(); return; }
    var r = cardRect(hit.type, hit.pile, hit.card);
    drag = {
        from: { type: hit.type, pile: hit.pile, card: hit.card },
        cards: cards, active: false,
        sx: p.x, sy: p.y, mx: p.x, my: p.y,
        grabX: clamp(p.x - r.x, 0, L.cw), grabY: clamp(p.y - r.y, 0, L.ch)
    };
    if (selection) { selection = null; render(); }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    if (e.preventDefault) e.preventDefault();
}

function onMove(e) {
    if (!drag) return;
    var p = pos(e);
    drag.mx = p.x; drag.my = p.y;
    if (!drag.active && (Math.abs(p.x - drag.sx) > 3 || Math.abs(p.y - drag.sy) > 3)) {
        drag.active = true;
        render();                                /* one board repaint per drag */
    }
    if (drag.active) renderDrag();               /* everything else is the small layer */
    if (e.preventDefault) e.preventDefault();
}

function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.active) {
        handleClick(d.from.type, d.from.pile, d.from.card);
        return;
    }
    var tgt = dropTargetFor(d);
    renderDrag();                                /* clears the drag layer */
    if (tgt && canPlace(d.cards, tgt.type, tgt.pile)) {
        if (!doMove(d.from.type, d.from.pile, d.from.card, tgt.type, tgt.pile)) {
            render();
            sfxError();
        }
    } else {
        render();                                /* snap back home */
        if (tgt) sfxError();
    }
}

function handleClick(type, pile, ci) {
    var now = W98.tick();
    var key = type + ':' + pile + ':' + ci;
    var dbl = lastClick && lastClick.key === key && (now - lastClick.t) < 450;
    lastClick = { key: key, t: now };

    cur.slot = slotIndexFor(type, pile);
    cur.card = 0;

    if (dbl) {
        lastClick = null;
        selection = null;
        if (sendToFoundation(type, pile, ci)) return;
        sfxError();
        render();
        return;
    }
    if (type === 'found') {
        selection = { type: 'found', pile: pile, card: ci };
        render();
        return;
    }
    if (selection && selection.type === type && selection.pile === pile && selection.card === ci) {
        selection = null;
        render();
        return;
    }
    selection = { type: type, pile: pile, card: ci };
    render();
}

function tryPlaceSelection(toType, toPile) {
    if (!selection) return false;
    var sel = selection;
    if (sel.type === toType && sel.pile === toPile) {
        selection = null;
        render();
        return true;
    }
    var cards = pileArr(sel.type, sel.pile).slice(sel.card);
    if (canPlace(cards, toType, toPile)) return doMove(sel.type, sel.pile, sel.card, toType, toPile);
    return false;
}

/* ------------------------------------------------------------------ */
/* keyboard input                                                      */
/* ------------------------------------------------------------------ */
function isOurFocus() {
    var ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return true;
    if (ae === win.el) return true;
    return !!(win.el.contains && win.el.contains(ae));
}

function maxFromTop() {
    var sl = slotOfCursor(), arr = pileArr(sl.type, sl.pile), i, n = 0;
    for (i = arr.length - 1; i >= 0 && arr[i].up; i--) n++;
    return Math.max(0, n - 1);
}

function onKey(e) {
    if (!win || modal) return;
    if (!isOurFocus()) return;
    var k = e.key || '';
    var sl;
    switch (k) {
        case 'F2': dealNew(); break;
        case 'F1': showHelp(); break;
        case 'Escape':
            if (selection) { selection = null; render(); }
            break;
        case 'ArrowLeft':
            cur.slot = (cur.slot + KBD_SLOTS - 1) % KBD_SLOTS; cur.card = 0; render(); break;
        case 'ArrowRight':
            cur.slot = (cur.slot + 1) % KBD_SLOTS; cur.card = 0; render(); break;
        case 'ArrowUp':
            cur.card = Math.max(0, cur.card - 1); render(); break;
        case 'ArrowDown':
            cur.card = Math.min(maxFromTop(), cur.card + 1); render(); break;
        case 'Enter':
        case ' ':
        case 'Spacebar':
            activateCursor(); break;
        case 'd': case 'D':
            cur.slot = 0; cur.card = 0; drawStock(); break;
        case 'a': case 'A':
            sl = slotOfCursor();
            sendToFoundation(sl.type, sl.pile, pileArr(sl.type, sl.pile).length - 1);
            break;
        case 'z': case 'Z':
            if (e.ctrlKey || e.metaKey) undoMove();
            else return;
            break;
        default:
            return;
    }
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
}

function activateCursor() {
    var sl = slotOfCursor(), arr = pileArr(sl.type, sl.pile);
    if (selection) {
        if (tryPlaceSelection(sl.type, sl.pile)) return;
        sfxError();
        return;
    }
    if (sl.type === 'stock') { drawStock(); return; }
    if (!arr.length) { sfxError(); return; }
    var ci = Math.max(0, arr.length - 1 - cur.card);
    if (arr[ci] && arr[ci].up && draggableRun(sl.type, sl.pile, ci)) {
        selection = { type: sl.type, pile: sl.pile, card: ci };
        sfxPlace(false);
        render();
    } else {
        sfxError();
    }
}

/* ------------------------------------------------------------------ */
/* dealing                                                             */
/* ------------------------------------------------------------------ */
function newDeck() {
    cardsById = {};
    var list = [], s, r;
    for (s = 0; s < 4; s++) {
        for (r = 1; r <= 13; r++) {
            var id = s * 13 + (r - 1);
            var c = { id: id, suit: s, rank: r, up: false };
            cardsById[id] = c;
            list.push(c);
        }
    }
    return list;
}

function dealNew() { deal(); }

function deal() {
    stopFxAnim(true);
    autoRunning = false;
    clearAllTimers();
    var deck = shuffle(newDeck());
    piles.stock = [];
    piles.waste = [];
    var f, t, i, c;
    for (f = 0; f < 4; f++) piles.found[f] = [];
    for (t = 0; t < 7; t++) {
        piles.tab[t] = [];
        for (i = 0; i <= t; i++) {
            c = deck.pop();
            c.up = (i === t);                       /* only the top card turns up */
            piles.tab[t].push(c);
        }
    }
    while (deck.length) {
        c = deck.pop();
        c.up = false;
        piles.stock.push(c);
    }
    undoCards = [];
    won = false;
    selection = null;
    drag = null;
    lastClick = null;
    flick = null;
    flickId = null;
    moves = 0;
    score = opts.vegas ? VEGAS_START : 0;
    accSec = 0;
    startTicked = W98.tick();
    gameStarted = false;
    penTick = 0;
    cur = { slot: 6, card: 0 };
    lastStatus = '';
    layout();
    render();
    if (dragCtx) dragCtx.clearRect(0, 0, L.w, L.h);
    if (fxCtx) fxCtx.clearRect(0, 0, L.w, L.h);
    updateStatus();
    rebuildMenu();
    regSet('SaveGame', '');
    saveOptions();
    regSet('GamesPlayed', regGetInt('GamesPlayed', 0) + 1);
    sfxDeal();
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */
function onResize() {
    if (!win) return;
    var wasDragging = drag && drag.active;
    drag = null;
    layout();
    render();
    if (wasDragging && dragCtx) dragCtx.clearRect(0, 0, L.w, L.h);
}

function onFocus() { /* nothing to do: the board is always current */ }
function onBlur() {
    if (drag) {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        drag = null;
        render();
        if (dragCtx) dragCtx.clearRect(0, 0, L.w, L.h);
    }
}

function onClose() {
    saveGame();                                   /* reload resumes this deal */
    closeDlg();
    stopFxAnim(true);
    clearAllTimers();
    if (tickId !== null) { try { win.clearInterval(tickId); } catch (e) {} tickId = null; }
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('keydown', onKey, false);
    if (root && root.removeEventListener) root.removeEventListener('mousedown', onDown, false);
    drag = null;
    flick = null;
    flickId = null;
    win = null;
}

/* a tiny read-only hook so automated tests can inspect the game */
function makeTestHook() {
    return {
        state: function () {
            function ids(a) { var o = [], i; for (i = 0; i < a.length; i++) o.push(a[i].id); return o; }
            return {
                score: score, moves: moves, won: won, started: gameStarted,
                time: accElapsed(), draw3: opts.draw3, vegas: opts.vegas,
                deck: opts.deck, timed: opts.timed,
                undo: undoCards.length, auto: autoRunning, fx: fxRunning,
                up: upIds(),
                stock: ids(piles.stock), waste: ids(piles.waste),
                found: [ids(piles.found[0]), ids(piles.found[1]), ids(piles.found[2]), ids(piles.found[3])],
                tab: [ids(piles.tab[0]), ids(piles.tab[1]), ids(piles.tab[2]), ids(piles.tab[3]),
                      ids(piles.tab[4]), ids(piles.tab[5]), ids(piles.tab[6])]
            };
        },
        deal: deal,
        draw: drawStock,
        undo: undoMove,
        rects: function () {
            return { cw: L.cw, ch: L.ch, colX: L.colX.slice(), topY: L.topY, tabY: L.tabY,
                     fanUp: L.fanUp, fanDown: L.fanDown, wasteFan: L.wasteFan,
                     w: L.w, h: L.h, tabOff: tabOff.map(function (a) { return a.slice(); }) };
        },
        /* test-only: empty the deck onto the tableau, face up, aces exposed */
        testRevealAll: function () {
            var t = 0, c, i, k, s2, ace, idx, p2;
            while (piles.stock.length) {
                c = piles.stock.pop();
                c.up = true;
                piles.tab[t % 7].push(c);
                t++;
            }
            while (piles.waste.length) {
                c = piles.waste.pop();
                c.up = true;
                piles.tab[t % 7].push(c);
                t++;
            }
            for (i = 0; i < 7; i++) {
                for (k = 0; k < piles.tab[i].length; k++) piles.tab[i][k].up = true;
            }
            for (s2 = 0; s2 < 4; s2++) {
                ace = cardsById[s2 * 13];
                for (p2 = 0; p2 < 7; p2++) {
                    idx = piles.tab[p2].indexOf(ace);
                    if (idx >= 0) {
                        piles.tab[p2].splice(idx, 1);
                        piles.tab[p2].push(ace);
                        break;
                    }
                }
            }
            layoutTab();
            render();
            updateStatus();
            startClock();                      /* the completion only runs mid-game */
            checkAutoComplete();
        },
        /* test-only: put a card straight onto a foundation (win animation tests) */
        stackFoundations: function () {
            var s, r, i, c;
            for (s = 0; s < 4; s++) {
                piles.found[s] = [];
                for (r = 1; r <= 13; r++) {
                    c = cardsById[s * 13 + (r - 1)];
                    c.up = true;
                    piles.found[s].push(c);
                }
            }
            piles.stock = []; piles.waste = [];
            for (i = 0; i < 7; i++) piles.tab[i] = [];
            score = 0;
            render();
            updateStatus();
            checkWin();
        }
    };
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */
var APP_ICON = 'solitaire';

/* every per-window value is reset here: closing and re-launching the app must not
   carry anything over from the previous window */
function resetRuntime() {
    score = 0;
    moves = 0;
    penTick = 0;
    gameStarted = false;
    startTicked = 0;
    accSec = 0;
    undoCards = [];
    won = false;
    selection = null;
    cur = { slot: 6, card: 0 };
    drag = null;
    flick = null;
    flickId = null;
    timers = [];
    tickId = null;
    autoRunning = false;
    autoSteps = 0;
    fxCancel = null;
    fxParts = [];
    fxRunning = false;
    fxSndAt = 0;
    fxStartAt = 0;
    fxFrames = 0;
    lastStatus = '';
    lastMenuSig = '';
    lastClick = null;
    tabOff = [[], [], [], [], [], [], []];
    piles = { stock: [], waste: [], found: [[], [], [], []],
              tab: [[], [], [], [], [], [], []] };
    cardsById = {};
}

function create(winObj) {
    win = winObj;
    resetRuntime();
    win.el.style.overflow = 'hidden';
    injectStyle();

    root = document.createElement('div');
    root.className = 'solitaire-root';
    win.el.appendChild(root);

    boardC = mkCanvas(1, 1); boardC.className = 'solitaire-canvas'; boardC.style.zIndex = '1';
    dragC  = mkCanvas(1, 1); dragC.className  = 'solitaire-canvas'; dragC.style.zIndex  = '2';
    fxC    = mkCanvas(1, 1); fxC.className    = 'solitaire-canvas'; fxC.style.zIndex    = '3';
    root.appendChild(boardC);
    root.appendChild(dragC);
    root.appendChild(fxC);

    atlas();                                        /* build the 56 sprites once */

    /* title bar / taskbar icon: the authentic Solitaire icon, by key --
       setIcon() resolves W98.icons.url('solitaire') internally (the shell asset
       when the manifest is loaded, the procedural painter otherwise). */
    try {
        if (typeof win.setIcon === 'function') win.setIcon(APP_ICON);
    } catch (e) {}

    loadOptions();
    layout();
    if (!restoreGame()) {
        deal();                                     /* fresh deck */
    } else {
        layoutTab();
        render();
        updateStatus();
    }
    rebuildMenu();
    tickId = win.setInterval(onTick, 1000);

    root.addEventListener('mousedown', onDown, false);
    document.addEventListener('keydown', onKey, false);
    if (typeof win.claimKeys === 'function') win.claimKeys();
    if (typeof win.on === 'function') {
        win.on('resize', onResize);
        win.on('blur', onBlur);
    }

    try { win.el.__solitaireTestHook = makeTestHook(); } catch (e) {}

    return { onClose: onClose, onResize: onResize, onFocus: onFocus, onBlur: onBlur };
}

W98.registerApp({
    id: APP_ID,
    title: APP_TITLE,
    icon: 'solitaire',
    width: 585,                    /* the authentic 1998 client area */
    height: 396,
    minWidth: 585,
    minHeight: 396,
    resizable: false,
    maximizable: false,
    desktop: true,
    startMenuGroup: 'Games',
    singleton: true,
    create: create
});

})();
