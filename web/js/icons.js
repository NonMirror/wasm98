/* ============================================================================
   icons.js — the icon set.
   ----------------------------------------------------------------------------
   Prefers the vendored authentic assets in web/assets (see assets/MANIFEST.json,
   produced by the asset pass).  For any key the asset set does not carry it
   falls back to a hand-drawn 32x32 canvas icon in the Windows 98 palette, so a
   missing asset degrades instead of leaving a hole.

     W98Icons.el(key, size)      -> <img>/<canvas>, cached, always something
     W98Icons.url(key, size)     -> asset URL or null
     W98Icons.paint(ctx,key,size) -> draw into any 2d context
     W98Icons.has(key)           -> true when a real asset exists
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------- palette */
  var C = {
    K: '#000000', W: '#ffffff', F: '#c0c0c0', L: '#dfdfdf', S: '#808080', D: '#404040',
    N: '#000080', B: '#0000a8', C1: '#00a8a8', T: '#008080', G: '#008000', Y: '#ffff00',
    G2: '#c0c000', O: '#ff8000', R: '#ff0000', M: '#800000', P: '#800080', V: '#ff00ff',
    GREY: '#a0a0a0', SIL: '#d4d0c8', MANILA: '#ffe9a8', MANILA2: '#d8b060',
    TEAL: '#008080', SKY: '#3a6ea5', SKY2: '#a0c8f0', BROWN: '#7b5b3a', BROWN2: '#a0784a',
  };

  /* a 3x5 pixel font, one hex digit per row (bit2 = leftmost) */
  var FONT = {
    A: '25755', B: '65656', C: '34443', D: '65556', E: '74647', F: '74644', G: '34553',
    H: '55755', I: '72227', J: '11152', K: '55655', L: '44447', M: '57755', N: '57555',
    O: '25552', P: '65644', Q: '25553', R: '65655', S: '34216', T: '72222', U: '55552',
    V: '55552', W: '55755', X: '55255', Y: '55222', Z: '71247',
    '0': '25552', '1': '26227', '2': '61247', '3': '64616', '4': '55711', '5': '74616',
    '6': '24752', '7': '71244', '8': '25252', '9': '25312', '?': '61222', '.': '00002',
    '-': '00700', '\\': '44441', ':': '00200', '/': '11244', '!': '22202'
  };

  function makeCtx(size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    cv.style.width = cv.style.height = size + 'px';
    cv.style.imageRendering = 'pixelated';
    var ctx = cv.getContext('2d');
    var u = size / 32;                       /* one 32-grid unit in device px */
    ctx.imageSmoothingEnabled = false;
    var g = {
      cv: cv, ctx: ctx, u: u, size: size,
      r: function (x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.max(1, Math.round(w * u)), Math.max(1, Math.round(h * u))); },
      px: function (x, y, col) { g.r(x, y, 1, 1, col); },
      bevel: function (x, y, w, h, up, face) {
        g.r(x, y, w, h, face || C.F);
        if (up) {
          g.r(x, y, w, 1, C.L); g.r(x, y, 1, h, C.L);
          g.r(x, y + h - 1, w, 1, C.K); g.r(x + w - 1, y, 1, h, C.K);
          g.r(x + 1, y + h - 2, w - 2, 1, C.S); g.r(x + w - 2, y + 1, 1, h - 2, C.S);
        } else {
          g.r(x, y, w, h, face || C.F);
          g.r(x, y, w, 1, C.S); g.r(x, y, 1, h, C.S);
          g.r(x, y + h - 1, w, 1, C.W); g.r(x + w - 1, y, 1, h, C.W);
        }
      },
      sunken: function (x, y, w, h, face) {
        g.r(x, y, w, h, face || C.F);
        g.r(x, y, w, 1, C.S); g.r(x, y, 1, h, C.S);
        g.r(x + 1, y + 1, w - 2, 1, C.K); g.r(x + 1, y + 1, 1, h - 2, C.K);
        g.r(x, y + h - 1, w, 1, C.W); g.r(x + w - 1, y, 1, h, C.W);
      },
      line: function (x1, y1, x2, y2, wd, col) {
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, wd * u);
        ctx.beginPath(); ctx.moveTo(x1 * u + u / 2, y1 * u + u / 2);
        ctx.lineTo(x2 * u + u / 2, y2 * u + u / 2); ctx.stroke();
      },
      poly: function (pts, col) {
        ctx.fillStyle = col; ctx.beginPath();
        for (var i = 0; i < pts.length; i++) {
          var fn = i ? 'lineTo' : 'moveTo';
          ctx[fn](pts[i][0] * u + (u > 1 ? u / 2 : 0.5), pts[i][1] * u + (u > 1 ? u / 2 : 0.5));
        }
        ctx.closePath(); ctx.fill();
      },
      disc: function (cx, cy, r, col) {
        ctx.fillStyle = col; ctx.beginPath();
        ctx.arc(cx * u, cy * u, r * u, 0, Math.PI * 2); ctx.fill();
      },
      /* vector-ish circles are too modern for 1998, so pixelate them */
      ball: function (cx, cy, r, col, hi) {
        for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) {
          if (xx * xx + yy * yy <= r * r + r / 2) g.px(cx + xx, cy + yy, col);
        }
        if (hi) {
          g.px(cx - r + 1, cy - r + 1, hi); g.px(cx - r + 2, cy - r + 1, hi);
          g.px(cx - r + 1, cy - r + 2, hi);
        }
      },
      text: function (x, y, s, col, scale) {
        scale = scale || 1; col = col || C.K;
        s = String(s).toUpperCase();
        for (var i = 0; i < s.length; i++) {
          var gl = FONT[s[i]] || FONT['?'];
          for (var ry = 0; ry < 5; ry++) {
            var bits = parseInt(gl[ry], 16);
            for (var rx = 0; rx < 3; rx++)
              if (bits & (4 >> rx)) g.r(x + i * 4 * scale + rx * scale, y + ry * scale, scale, scale, col);
          }
        }
      }
    };
    return g;
  }

  /* --------------------------------------------------- shared icon parts */
  function page(g, accent, label, lines) {
    /* the classic document: white page, folded corner, coloured stripe, label */
    g.poly([[7, 3], [20, 3], [25, 8], [25, 29], [7, 29]], C.K);
    g.poly([[8, 4], [19, 4], [24, 9], [24, 28], [8, 28]], C.W);
    g.poly([[19, 4], [19, 9], [24, 9]], C.L);
    g.line(19, 4, 19, 9, 1, C.S);
    g.r(9, 2, 12, 3, accent || C.N);
    if (label) g.text(10, 1, label, C.W, 1);
    if (lines !== false) {
      for (var i = 0; i < 6; i++) g.r(10, 11 + i * 3, 12 - (i % 3) * 2, 1, C.S);
    }
  }
  function folderShape(g, col, shade, dark) {
    g.poly([[3, 8], [12, 8], [14, 10], [29, 10], [29, 27], [3, 27]], C.K);
    g.poly([[4, 9], [12, 9], [14, 11], [28, 11], [28, 26], [4, 26]], col);
    g.r(4, 9, 9, 2, shade);
    g.poly([[4, 26], [28, 26], [28, 27], [4, 27]], dark);
    g.r(28, 11, 1, 15, dark);
  }
  function monitor(g, inner) {
    g.r(2, 4, 28, 21, C.K);
    g.r(3, 5, 26, 19, C.L);
    g.r(4, 6, 24, 15, C.K);
    if (inner) inner(5, 7, 22, 13); else { g.r(5, 7, 22, 13, C.T); g.r(5, 7, 22, 4, C.C1); }
    g.r(3, 22, 26, 1, C.S);
    g.r(2, 25, 6, 2, C.S); g.r(24, 25, 6, 2, C.S);
    g.r(11, 25, 10, 2, C.F); g.r(10, 27, 12, 2, C.F);
    g.r(10, 27, 12, 1, C.L); g.r(10, 28, 12, 1, C.K);
    g.r(9, 29, 14, 1, C.S);
  }
  function speakerShape(g, x, y, sc) {
    g.r(x, y + 3 * sc, 4 * sc, 5 * sc, C.K);
    g.r(x + 1, y + 4 * sc, 3 * sc, 3 * sc, C.F);
    g.poly([[x + 4 * sc, y + 3 * sc], [x + 9 * sc, y], [x + 9 * sc, y + 11 * sc], [x + 4 * sc, y + 8 * sc]], C.K);
    g.poly([[x + 5 * sc, y + 4 * sc], [x + 8 * sc, y + 2 * sc], [x + 8 * sc, y + 9 * sc], [x + 5 * sc, y + 7 * sc]], C.F);
  }
  function messageIcon(g, kind) {
    if (kind === 'error') {
      g.ball(16, 16, 12, C.R); g.ball(16, 16, 11, C.R);
      g.r(12, 8, 8, 2, C.W); g.r(8, 12, 2, 8, C.W); g.r(22, 12, 2, 8, C.W); g.r(12, 22, 8, 2, C.W);
      g.line(9, 9, 23, 23, 2, C.W); g.line(23, 9, 9, 23, 2, C.W);
    } else if (kind === 'warning') {
      g.poly([[16, 3], [30, 27], [2, 27]], C.K);
      g.poly([[16, 6], [28, 26], [4, 26]], C.Y);
      g.r(15, 11, 2, 9, C.K); g.r(15, 22, 2, 2, C.K);
    } else if (kind === 'question') {
      g.ball(16, 16, 12, C.N); g.ball(16, 16, 11, C.N);
      g.text(12, 7, '?', C.W, 2);
      g.r(15, 21, 2, 3, C.W);
    } else {
      g.ball(16, 16, 12, C.N);
      g.r(14, 8, 4, 2, C.W); g.r(17, 9, 2, 8, C.W); g.r(16, 16, 4, 2, C.W); g.r(15, 21, 3, 3, C.W);
    }
  }

  /* ------------------------------------------------------- the painters */
  var P = {};
  function def(key, fn) { P[key] = fn; }

  def('folder', function (g) { folderShape(g, C.Y, '#ffff80', C.G2); });
  def('folder-open', function (g) {
    g.poly([[3, 10], [12, 10], [14, 12], [28, 12], [26, 27], [3, 27]], C.K);
    g.poly([[4, 11], [12, 11], [14, 13], [27, 13], [25, 26], [4, 26]], '#ffe070');
    g.poly([[4, 16], [30, 16], [26, 27], [4, 27]], C.K);
    g.poly([[5, 17], [29, 17], [25, 26], [5, 26]], '#fff0a0');
    g.r(5, 11, 8, 2, '#ffff80');
  });
  def('programs', function (g) {
    folderShape(g, C.Y, '#ffff80', C.G2);
    g.r(9, 13, 14, 11, C.K); g.r(10, 14, 12, 9, C.F);
    g.r(10, 14, 12, 3, C.N); g.r(11, 18, 10, 4, C.W);
  });
  def('documents', function (g) {
    folderShape(g, C.Y, '#ffff80', C.G2);
    g.poly([[8, 12], [16, 12], [20, 16], [20, 26], [8, 26]], C.K);
    g.poly([[9, 13], [15, 13], [19, 17], [19, 25], [9, 25]], C.W);
    g.r(11, 17, 6, 1, C.S); g.r(11, 19, 6, 1, C.S); g.r(11, 21, 4, 1, C.S);
  });
  def('pictures', function (g) {
    folderShape(g, C.Y, '#ffff80', C.G2);
    g.r(8, 12, 16, 13, C.K); g.r(9, 13, 14, 11, C.SKY2);
    g.r(9, 13, 14, 4, C.SKY);
    g.disc(20, 16, 2, C.Y);
    g.poly([[9, 24], [14, 18], [18, 24]], C.G);
    g.poly([[15, 24], [19, 20], [23, 24]], '#006000');
  });
  def('web-folders', function (g) {
    folderShape(g, C.Y, '#ffff80', C.G2);
    g.ball(16, 19, 7, C.N); g.ball(16, 19, 6, C.C1);
    g.r(10, 18, 12, 1, C.W); g.r(16, 13, 1, 13, C.W);
  });
  def('my-computer', function (g) {
    monitor(g, function (x, y, w, h) { g.r(x, y, w, h, C.T); g.r(x, y, w, 4, C.C1); });
    g.r(0, 0, 32, 1, 'rgba(0,0,0,0)');
  });
  def('recycle-bin', function (g) {
    g.poly([[8, 10], [24, 10], [22, 28], [10, 28]], C.K);
    g.poly([[9, 11], [23, 11], [21, 27], [11, 27]], C.F);
    g.r(7, 8, 18, 3, C.K); g.r(8, 9, 16, 2, C.L);
    g.r(13, 5, 6, 3, C.K); g.r(14, 6, 4, 2, C.L);
    g.r(12, 14, 1, 10, C.S); g.r(16, 14, 1, 10, C.S); g.r(20, 14, 1, 10, C.S);
    g.r(19, 3, 4, 3, C.G); g.r(20, 3, 2, 1, C.G); g.r(18, 4, 1, 1, C.G); g.r(23, 4, 1, 1, C.G);
  });
  def('recycle-bin-full', function (g) {
    g.poly([[10, 8], [14, 3], [17, 8]], C.W);
    g.poly([[15, 8], [20, 2], [22, 8]], C.W);
    P['recycle-bin'](g);
    g.r(14, 4, 6, 1, C.S);
  });
  def('floppy-3-5', function (g) {
    g.r(4, 4, 24, 24, C.K);
    g.r(5, 5, 22, 22, '#303030');
    g.r(10, 5, 12, 9, C.SIL); g.r(11, 6, 10, 7, C.GREY);
    g.r(19, 6, 3, 6, '#505050');
    g.r(7, 16, 18, 11, C.W); g.r(8, 17, 16, 9, C.L);
    g.r(10, 18, 4, 1, C.S); g.r(10, 20, 4, 1, C.S);
    g.r(5, 5, 22, 1, C.GREY);
  });
  def('hard-disk', function (g) {
    /* a drive bay with a stack of platters behind it */
    g.bevel(2, 8, 28, 17, true);
    g.r(4, 11, 24, 3, C.L);
    g.r(6, 15, 20, 8, C.SIL);
    g.ball(12, 19, 4, C.W); g.ball(12, 19, 3, C.GREY); g.ball(12, 19, 1, C.K);
    g.ball(21, 19, 3, C.W); g.ball(21, 19, 2, C.GREY);
    g.r(24, 11, 2, 2, C.G);
    g.r(4, 25, 24, 2, C.S);
  });
  def('cdrom', function (g) {
    g.bevel(2, 10, 28, 14, true);
    g.r(5, 13, 14, 8, C.L);
    g.disc(12, 17, 4, C.SIL); g.disc(12, 17, 1, C.K);
    g.ball(24, 15, 3, C.W); g.ball(24, 15, 2, C.SKY2);
    g.r(5, 22, 8, 1, C.S);
  });
  def('network', function (g) {
    g.r(2, 8, 12, 9, C.K); g.r(3, 9, 10, 7, C.T);
    g.r(9, 17, 15, 4, C.K); g.r(10, 18, 13, 2, C.SIL);
    g.r(18, 20, 12, 9, C.K); g.r(19, 21, 10, 7, C.C1);
    g.r(1, 20, 4, 2, C.S);
  });
  def('network-neighborhood', function (g) {
    g.ball(16, 14, 10, C.N); g.ball(16, 14, 9, C.C1);
    g.r(8, 13, 16, 1, C.W); g.r(16, 6, 1, 16, C.W);
    g.r(10, 10, 12, 1, C.W);
  });
  def('control-panel', function (g) {
    g.bevel(3, 5, 26, 23, true);
    g.r(5, 7, 22, 4, C.N);
    g.r(7, 14, 8, 8, C.L); g.r(8, 15, 6, 6, C.W);
    g.disc(11, 18, 2, C.S);
    g.r(18, 14, 8, 2, C.W); g.r(18, 18, 8, 2, C.W); g.r(18, 22, 8, 2, C.W);
    g.r(21, 13, 2, 4, C.K); g.r(24, 17, 2, 4, C.K); g.r(19, 21, 2, 4, C.K);
  });
  def('printer', function (g) {
    g.r(8, 3, 16, 8, C.W); g.r(9, 4, 14, 6, C.L);
    g.bevel(3, 11, 26, 12, true);
    g.r(6, 14, 20, 2, C.K);
    g.r(9, 21, 14, 6, C.W); g.r(10, 22, 12, 4, C.L);
    g.r(24, 13, 2, 2, C.G);
  });
  def('add-remove', function (g) {
    /* the Add/Remove Programs box: a big + and - on a carton */
    g.poly([[5, 7], [27, 7], [27, 27], [5, 27]], C.K);
    g.poly([[6, 8], [26, 8], [26, 26], [6, 26]], C.F);
    g.r(6, 8, 20, 2, C.L);
    g.r(9, 12, 8, 3, C.G); g.r(11, 10, 4, 7, C.G);
    g.r(18, 21, 7, 3, C.R);
  });
  def('modem', function (g) {
    g.bevel(2, 14, 24, 12, true);
    g.r(5, 17, 8, 3, C.K); g.r(5, 21, 12, 2, C.S);
    g.r(22, 17, 2, 2, C.G);
    g.line(22, 20, 22, 4, 2, C.S); g.line(22, 4, 30, 4, 2, C.S);
    g.r(18, 2, 8, 4, C.K); g.r(19, 3, 6, 2, C.F);
  });
  def('display', function (g) {
    monitor(g, function (x, y, w, h) {
      g.r(x, y, w, h, C.T);
      g.poly([[x, y + h], [x + 8, y + 3], [x + 15, y + h]], '#00c000');
      g.disc(x + 17, y + 3, 2, C.Y);
    });
  });
  def('sounds', function (g) { speakerShape(g, 5, 10, 2); });
  def('volume', function (g) { speakerShape(g, 5, 10, 2); });
  def('speaker', function (g) { speakerShape(g, 5, 10, 2); });
  def('mouse', function (g) {
    g.r(14, 3, 2, 7, C.S);
    g.poly([[10, 9], [22, 9], [24, 20], [20, 29], [12, 29], [8, 20]], C.K);
    g.poly([[11, 10], [21, 10], [23, 20], [19, 28], [13, 28], [9, 20]], C.SIL);
    g.r(16, 10, 1, 8, C.K); g.r(11, 13, 10, 1, C.K);
    g.r(12, 11, 3, 2, C.W);
  });
  def('keyboard', function (g) {
    g.bevel(2, 10, 28, 14, true);
    for (var r = 0; r < 3; r++) for (var c = 0; c < 8; c++) {
      if (r === 2 && c > 2 && c < 6) continue;
      g.r(4 + c * 3, 12 + r * 3, 2, 2, (r === 1 && c === 3) ? C.S : C.W);
    }
    g.r(7, 21, 10, 2, C.W);
  });
  def('fonts', function (g) {
    page(g, C.M, 'TTF');
    g.r(11, 12, 10, 1, C.W);
    g.poly([[11, 22], [13, 14], [16, 14], [20, 22], [18, 22], [16, 17], [14, 22]], C.K);
  });
  def('datetime', function (g) {
    g.r(4, 6, 24, 22, C.K); g.r(5, 7, 22, 20, C.W);
    g.r(5, 7, 22, 4, C.M);
    g.r(8, 3, 3, 5, C.S); g.r(21, 3, 3, 5, C.S);
    g.r(21, 14, 7, 7, C.W); g.r(21, 14, 7, 1, C.K); g.r(24, 14, 1, 5, C.K);
    g.line(24, 17, 24, 15, 1, C.K); g.line(24, 17, 26, 17, 1, C.K);
    g.r(8, 13, 4, 1, C.F); g.r(8, 16, 6, 1, C.F); g.r(8, 19, 5, 1, C.F); g.r(8, 22, 7, 1, C.F);
  });
  def('system', function (g) {
    monitor(g, function (x, y, w, h) { g.r(x, y, w, h, C.T); g.r(x, y, w, 4, C.C1); });
    g.ball(25, 8, 6, C.Y); g.poly([[25, 4], [30, 12], [20, 12]], C.Y);
    g.text(23, 6, '!', C.K, 2);
  });
  def('help', function (g) {
    g.poly([[4, 5], [16, 8], [16, 28], [4, 25]], C.M);
    g.poly([[28, 5], [16, 8], [16, 28], [28, 25]], C.R);
    g.poly([[4, 5], [16, 8], [28, 5], [28, 3], [16, 6], [4, 3]], C.W);
    g.text(12, 12, '?', C.W, 3);
  });
  def('find', function (g) {
    /* a magnifier on its own, the way the 1998 Find icon reads */
    g.ball(13, 13, 10, C.K);
    g.ball(13, 13, 9, C.L); g.ball(13, 13, 8, C.W);
    g.ball(13, 13, 5, C.SKY2);
    g.poly([[13, 6], [17, 11], [13, 15], [9, 11]], C.Y);
    g.px(11, 10, C.W);
    g.line(19, 19, 28, 28, 3, C.SIL);
    g.line(19, 19, 28, 28, 1, C.K);
  });
  def('run', function (g) {
    g.bevel(2, 8, 28, 16, true);
    g.r(5, 11, 22, 5, C.W); g.r(6, 12, 20, 3, C.L);
    g.poly([[12, 17], [20, 21], [12, 25]], C.G);
    g.r(22, 18, 6, 2, C.S); g.r(22, 21, 6, 2, C.S);
  });
  def('settings', function (g) {
    g.ball(16, 16, 8, C.SIL); g.ball(16, 16, 3, C.S);
    for (var a = 0; a < 8; a++) {
      g.r(15 + Math.round(9 * Math.cos(a * 0.785)), 15 + Math.round(9 * Math.sin(a * 0.785)), 3, 3, C.SIL);
    }
    for (var b = 0; b < 8; b++) g.px(15 + Math.round(12 * Math.cos(b * 0.785)), 15 + Math.round(12 * Math.sin(b * 0.785)), C.K);
  });
  def('shutdown', function (g) {
    g.bevel(3, 6, 26, 19, true);
    g.r(6, 9, 20, 12, C.K);
    g.r(6, 9, 20, 3, C.N);
    g.r(2, 25, 28, 3, C.F);
    g.ball(24, 16, 5, C.R);
    g.r(23, 12, 2, 5, C.W); g.r(25, 12, 2, 5, C.W);
  });
  def('logoff', function (g) {
    g.bevel(3, 6, 18, 19, true);
    g.r(6, 9, 12, 8, C.T);
    g.poly([[20, 16], [28, 16], [28, 14], [31, 18], [28, 22], [28, 20], [20, 20]], C.K);
    g.poly([[20, 17], [27, 17], [29, 18], [27, 19], [20, 19]], C.Y);
  });
  def('notepad', function (g) {
    g.r(6, 4, 20, 24, C.K); g.r(7, 5, 18, 22, C.W);
    g.r(7, 5, 18, 4, C.N);
    g.r(9, 12, 14, 1, C.S); g.r(9, 15, 14, 1, C.S); g.r(9, 18, 14, 1, C.S);
    g.r(9, 21, 9, 1, C.S); g.r(9, 24, 12, 1, C.S);
    g.r(20, 14, 3, 14, C.G2); g.poly([[20, 28], [23, 28], [21, 31]], C.MANILA2);
  });
  def('paint', function (g) {
    g.poly([[3, 12], [16, 4], [29, 12], [29, 20], [16, 28], [3, 20]], C.K);
    g.poly([[5, 12], [16, 6], [27, 12], [27, 19], [16, 26], [5, 19]], C.SIL);
    g.r(10, 14, 3, 3, C.R); g.r(14, 12, 3, 3, C.B); g.r(18, 14, 3, 3, C.Y);
    g.r(14, 17, 3, 3, C.G);
    g.r(12, 20, 6, 4, C.K); g.r(13, 21, 4, 2, C.GREY);
    g.line(24, 6, 29, 1, 3, C.MANILA2);
    g.poly([[29, 1], [31, 3], [29, 5], [27, 3]], C.S);
  });
  def('calculator', function (g) {
    g.bevel(5, 3, 22, 26, true);
    g.r(8, 6, 16, 6, C.L); g.sunken(8, 6, 16, 6, C.L);
    g.r(10, 8, 12, 3, '#a0f0a0');
    for (var r2 = 0; r2 < 3; r2++) for (var c2 = 0; c2 < 4; c2++) {
      g.r(8 + c2 * 5, 15 + r2 * 5, 4, 4, C.W);
      g.r(8 + c2 * 5, 15 + r2 * 5, 4, 1, C.F);
    }
  });
  def('charmap', function (g) {
    g.bevel(2, 4, 28, 24, true);
    g.r(5, 7, 22, 18, C.W);
    g.text(6, 8, 'A', C.K, 1); g.text(11, 8, 'B', C.K, 1); g.text(16, 8, 'C', C.K, 1);
    g.text(6, 15, 'A', C.M, 1); g.text(11, 15, 'E', C.K, 1); g.text(16, 15, '?', C.K, 1);
    g.r(5, 16, 22, 1, C.S);
    g.r(17, 23, 10, 2, C.S);
  });
  def('media-player', function (g) {
    g.bevel(2, 5, 28, 22, true);
    g.r(5, 8, 22, 12, C.K);
    g.poly([[13, 10], [22, 14], [13, 18]], C.L);
    g.r(5, 21, 8, 2, C.S);
    g.r(14, 22, 3, 3, C.W); g.r(18, 22, 3, 3, C.W); g.r(22, 22, 3, 3, C.W);
  });
  def('minesweeper', function (g) {
    g.bevel(2, 2, 28, 28, true);
    g.r(5, 5, 22, 22, C.W);
    g.ball(16, 15, 7, C.K);
    g.r(15, 6, 2, 4, C.K); g.r(15, 22, 2, 4, C.K);
    g.r(6, 14, 4, 2, C.K); g.r(22, 14, 4, 2, C.K);
    g.r(8, 7, 2, 2, C.K); g.r(22, 7, 2, 2, C.K);
    g.px(13, 12, C.W); g.px(14, 12, C.W);
    g.r(19, 3, 1, 8, C.K); g.poly([[20, 3], [27, 6], [20, 9]], C.R);
  });
  def('solitaire', function (g) {
    g.r(4, 6, 17, 22, C.K); g.r(5, 7, 15, 20, C.W);
    g.r(5, 7, 15, 3, C.R);
    g.poly([[12, 13], [9, 19], [15, 19]], C.R);
    g.poly([[8, 16], [12, 23], [16, 16]], C.R);
    g.r(14, 4, 17, 22, C.K); g.r(15, 5, 15, 20, C.N);
    for (var i = 0; i < 5; i++) for (var j = 0; j < 4; j++)
      if ((i + j) % 2) g.r(16 + j * 3, 6 + i * 4, 3, 4, C.B);
  });
  def('freecell', function (g) {
    /* four fanned cards with the free-cell row above, like the real game */
    for (var i = 0; i < 4; i++) g.r(3 + i * 7, 4, 12, 17, C.K), g.r(4 + i * 7, 5, 10, 15, C.W);
    for (var k = 0; k < 4; k++) {
      var x = 3 + k * 7, red = (k % 2 === 1);
      g.r(x + 1, 6, 8, 2, red ? C.R : C.K);
      g.text(x + 2, 9, ['A', '2', '3', '4'][k], red ? C.R : C.K, 1);
      if (!red) g.text(x + 6, 12, 'S', C.K, 1);
    }
    g.poly([[9, 24], [12, 29], [6, 29]], C.M);
    g.poly([[10, 27], [14, 31], [6, 31]], C.R);
  });
  def('jezzball', function (g) {
    /* the black room, a growing wall and two balls */
    g.r(2, 5, 28, 22, C.K);
    g.r(3, 6, 13, 20, '#303060');
    g.r(18, 6, 11, 20, '#202048');
    g.r(16, 6, 2, 20, C.W);
    g.r(3, 15, 27, 2, C.W);
    g.r(16, 6, 2, 7, C.R);
    g.ball(9, 10, 4, C.W); g.px(8, 9, C.SIL);
    g.ball(23, 22, 4, C.W); g.px(22, 21, C.SIL);
  });
  def('pinball', function (g) {
    g.r(4, 2, 24, 28, C.K);
    g.poly([[5, 3], [27, 3], [27, 29], [5, 29]], '#101860');
    g.poly([[7, 20], [25, 20], [27, 26], [5, 26]], '#202878');
    g.r(6, 4, 20, 4, C.K); g.r(7, 5, 18, 2, C.R);
    g.ball(16, 14, 6, C.Y); g.ball(16, 14, 3, C.O);
    g.line(10, 19, 12, 24, 2, C.SIL); g.line(22, 19, 20, 24, 2, C.SIL);
    g.ball(16, 25, 3, C.SIL); g.px(15, 24, C.W);
  });
  def('dos', function (g) {
    /* plain MS-DOS: the C:\> prompt with a blinking-cursor block */
    g.bevel(1, 4, 30, 24, true);
    g.r(4, 7, 24, 18, C.K);
    g.text(6, 10, 'C:\\>', C.L, 1);
    g.r(21, 10, 4, 5, C.L);
    g.text(6, 19, 'DOS', C.GREY, 1);
  });
  def('dos-prompt', function (g) {
    g.bevel(1, 3, 30, 26, true);
    g.r(4, 6, 24, 20, C.K);
    g.text(6, 9, 'C:\\>', C.L, 1);
    g.r(6, 17, 12, 1, C.L);
    g.r(6, 19, 8, 1, C.L);
  });
  def('cmd', function (g) { P['dos-prompt'](g); });
  def('explorer', function (g) {
    /* folder with a small list window: the Explorer metaphor */
    g.poly([[2, 8], [11, 8], [13, 10], [27, 10], [27, 26], [2, 26]], C.K);
    g.poly([[3, 9], [10, 9], [13, 11], [26, 11], [26, 25], [3, 25]], C.Y);
    g.r(3, 9, 7, 2, '#ffff80');
    g.r(6, 13, 18, 11, C.K); g.r(7, 14, 16, 9, C.W);
    g.r(7, 14, 16, 2, C.N);
    g.r(9, 17, 5, 1, C.T); g.r(9, 19, 5, 1, C.S); g.r(9, 21, 4, 1, C.S);
    g.r(16, 17, 6, 5, C.SIL); g.r(16, 17, 6, 1, C.S);
  });
  def('ie', function (g) {
    g.disc(16, 17, 11, C.K);
    g.disc(16, 17, 10, C.SKY);
    g.poly([[11, 21], [11, 12], [17, 12], [17, 15], [14, 15], [14, 21]], C.W);
    g.r(11, 17, 7, 2, C.W);
    g.text(13, 14, 'e', C.W, 3);
    for (var a = 0; a < 20; a++) {
      var t = a / 20 * Math.PI * 2;
      g.px(16 + Math.round(13 * Math.cos(t)), 11 + Math.round(4 * Math.sin(t)), C.Y);
    }
  });
  def('outlook', function (g) {
    g.r(3, 9, 22, 16, C.K); g.r(4, 10, 20, 14, C.W);
    g.poly([[4, 10], [14, 18], [24, 10]], C.K);
    g.poly([[5, 11], [14, 17], [23, 11]], C.C1);
    g.r(18, 14, 11, 11, C.K); g.r(19, 15, 9, 9, C.SKY);
    g.line(23, 19, 23, 16, 1, C.W); g.line(23, 19, 26, 19, 1, C.W);
  });
  def('task-manager', function (g) {
    g.bevel(2, 6, 28, 20, true);
    g.r(5, 9, 22, 11, C.K);
    g.poly([[6, 18], [10, 13], [14, 16], [18, 11], [22, 15], [26, 10], [26, 19], [6, 19]], C.G);
    for (var i = 0; i < 22; i++) g.px(5 + i, 9 + (i % 3), C.S);
    g.r(5, 22, 10, 2, C.L); g.r(17, 22, 10, 2, C.L);
  });
  def('briefcase', function (g) {
    g.r(11, 5, 10, 4, C.K); g.r(12, 6, 8, 2, C.BROWN);
    g.bevel(2, 9, 28, 17, true, C.BROWN2);
    g.r(2, 15, 28, 2, C.BROWN);
    g.r(14, 15, 4, 3, C.G2);
  });
  def('scheduled-tasks', function (g) {
    g.r(4, 6, 22, 22, C.K); g.r(5, 7, 20, 20, C.W);
    g.r(5, 7, 20, 4, C.M);
    g.r(8, 3, 3, 5, C.S); g.r(18, 3, 3, 5, C.S);
    g.r(8, 14, 12, 1, C.S); g.r(8, 17, 12, 1, C.S);
    g.line(19, 22, 27, 26, 2, C.G);
    g.poly([[25, 28], [29, 24], [31, 29]], C.G);
  });
  def('dial-up', function (g) {
    g.r(2, 6, 14, 10, C.K); g.r(3, 7, 12, 8, C.T);
    g.bevel(14, 18, 16, 11, true);
    g.r(17, 21, 10, 2, C.S); g.r(17, 25, 6, 2, C.S);
    g.line(9, 16, 9, 22, 2, C.S); g.line(9, 22, 16, 22, 2, C.S);
  });
  def('text-file', function (g) { page(g, C.N, 'TXT'); });
  def('ini-file', function (g) { page(g, C.M, 'INI'); });
  def('bmp-file', function (g) { page(g, C.T, 'BMP'); });
  def('exe-file', function (g) { page(g, C.N, 'EXE'); });
  def('dll-file', function (g) { page(g, C.P, 'DLL'); });
  def('wav-file', function (g) { page(g, C.G2, 'WAV'); });
  def('unknown-file', function (g) { page(g, C.S, '?'); });
  def('unknown', function (g) { page(g, C.S, '?'); });
  def('error', function (g) { messageIcon(g, 'error'); });
  def('warning', function (g) { messageIcon(g, 'warning'); });
  def('info', function (g) { messageIcon(g, 'info'); });
  def('question', function (g) { messageIcon(g, 'question'); });
  def('exclamation', function (g) { messageIcon(g, 'warning'); });
  def('check', function (g) {
    g.line(6, 16, 13, 24, 3, C.K);
    g.line(13, 24, 27, 6, 3, C.K);
  });
  def('arrow-right', function (g) { g.poly([[10, 8], [22, 16], [10, 24]], C.K); });
  def('arrow-down', function (g) { g.poly([[8, 11], [16, 23], [24, 11]], C.K); });
  def('chevron', function (g) { g.poly([[12, 9], [21, 16], [12, 23]], C.K); });
  def('arrow-up', function (g) { g.poly([[8, 22], [16, 10], [24, 22]], C.K); g.poly([[11, 21], [16, 14], [21, 21]], C.G); });
  def('arrow-left', function (g) { g.poly([[22, 8], [10, 16], [22, 24]], C.K); });
  def('back', function (g) { g.poly([[24, 8], [12, 16], [24, 24]], C.G); g.r(4, 14, 9, 4, C.G); });
  def('forward', function (g) { g.poly([[8, 8], [20, 16], [8, 24]], C.G); g.r(19, 14, 9, 4, C.G); });
  def('up', function (g) { g.poly([[8, 24], [16, 10], [24, 24]], C.G); g.r(13, 18, 6, 8, C.G); });
  def('cut', function (g) {
    g.line(9, 5, 16, 18, 2, C.S); g.line(23, 5, 16, 18, 2, C.S);
    g.ball(9, 24, 3, C.SIL); g.ball(23, 24, 3, C.SIL);
    g.r(15, 18, 3, 10, C.L);
  });
  def('copy', function (g) {
    g.r(6, 4, 14, 18, C.K); g.r(7, 5, 12, 16, C.W);
    g.r(12, 10, 14, 18, C.K); g.r(13, 11, 12, 16, C.W);
    g.r(15, 14, 8, 1, C.S); g.r(15, 17, 8, 1, C.S); g.r(15, 20, 8, 1, C.S);
  });
  def('paste', function (g) {
    g.r(8, 6, 16, 22, C.K); g.r(9, 7, 14, 20, C.MANILA);
    g.r(12, 3, 8, 5, C.S); g.r(13, 4, 6, 3, C.L);
    g.r(11, 14, 10, 1, C.S); g.r(11, 18, 10, 1, C.S); g.r(11, 22, 6, 1, C.S);
  });
  def('undo', function (g) {
    g.line(20, 20, 14, 10, 3, C.G);
    g.poly([[8, 6], [18, 12], [8, 16]], C.G);
  });
  def('delete', function (g) {
    g.r(10, 8, 12, 16, C.K); g.r(11, 9, 10, 14, C.F);
    g.r(9, 6, 14, 3, C.K); g.r(13, 3, 6, 3, C.K);
    g.line(13, 12, 19, 20, 2, C.R); g.line(19, 12, 13, 20, 2, C.R);
  });
  def('props', function (g) {
    g.r(8, 5, 16, 22, C.K); g.r(9, 6, 14, 20, C.W);
    g.r(11, 10, 10, 1, C.S); g.r(11, 14, 10, 1, C.S); g.r(11, 18, 10, 1, C.S);
    g.ball(22, 22, 5, C.F); g.ball(23, 23, 3, C.R);
  });
  def('views', function (g) {
    g.r(4, 5, 10, 10, C.F); g.r(4, 5, 10, 1, C.W); g.r(19, 5, 10, 10, C.F);
    g.r(4, 18, 10, 10, C.F); g.r(19, 18, 10, 10, C.F);
  });
  def('search', function (g) {
    g.ball(14, 13, 8, C.W); g.ball(14, 13, 7, C.L);
    for (var a = 0; a < 16; a++) g.px(14 + Math.round(8 * Math.cos(a * .4)), 13 + Math.round(8 * Math.sin(a * .4)), C.K);
    g.line(19, 19, 28, 28, 3, C.GREY);
  });
  def('favorites', function (g) { g.poly([[10, 3], [11, 7], [5, 4], [8, 10], [3, 12], [9, 14], [7, 21], [12, 17], [15, 23], [16, 16], [22, 17], [17, 12], [21, 7], [15, 8]], C.Y); g.poly([[10, 3], [11, 7], [5, 4], [8, 10], [3, 12], [9, 14], [7, 21], [12, 17], [15, 23], [16, 16], [22, 17], [17, 12], [21, 7], [15, 8]], C.Y); });
  def('history', function (g) {
    g.ball(15, 16, 11, C.F); g.ball(15, 16, 10, C.W);
    for (var a = 0; a < 22; a++) {
      var t = a / 22 * Math.PI * 2;
      g.px(15 + Math.round(10 * Math.cos(t)), 16 + Math.round(10 * Math.sin(t)), C.K);
    }
    g.poly([[15, 11], [15, 18], [20, 18], [20, 16], [17, 16], [17, 11]], C.N);
    g.poly([[6, 16], [12, 12], [12, 20]], C.G);
  });
  def('print', function (g) {
    g.r(10, 4, 12, 6, C.W); g.bevel(4, 10, 24, 12, true);
    g.r(9, 20, 14, 8, C.W); g.r(10, 21, 12, 6, C.L); g.r(24, 13, 2, 2, C.G);
  });
  def('home', function (g) {
    g.poly([[16, 3], [29, 14], [3, 14]], C.M);
    g.r(6, 14, 20, 14, C.F); g.r(13, 18, 6, 10, C.M); g.r(8, 16, 4, 4, C.C1); g.r(20, 16, 4, 4, C.C1);
  });
  def('refresh', function (g) {
    g.ball(16, 16, 11, C.G); g.ball(16, 16, 7, C.W);
    g.poly([[10, 4], [22, 3], [16, 14]], C.G); g.poly([[22, 22], [20, 28], [24, 28]], C.G);
  });
  def('stop', function (g) { g.ball(16, 16, 12, C.R); g.r(9, 9, 14, 14, C.W); g.r(10, 10, 12, 12, C.R); });
  def('mail', function (g) {
    g.r(3, 9, 26, 16, C.K); g.r(4, 10, 24, 14, C.W);
    g.poly([[5, 11], [16, 19], [27, 11]], C.K); g.poly([[6, 12], [16, 18], [26, 12]], C.C1);
  });
  def('newfolder', function (g) { folderShape(g, C.Y, '#ffff80', C.G2); g.r(13, 14, 6, 2, C.G); g.r(15, 12, 2, 6, C.G); });
  def('drive-c', function (g) { P['hard-disk'](g); });
  def('drive-a', function (g) {
    /* 3.5" drive face: the slot and the eject button, seen from the front */
    g.bevel(3, 9, 26, 15, true);
    g.r(6, 12, 20, 6, '#303030');
    g.r(7, 13, 18, 4, '#585858');
    g.r(6, 13, 3, 4, C.SIL);
    g.r(22, 19, 5, 3, C.L); g.r(22, 19, 5, 1, C.W);
    g.r(6, 19, 12, 2, C.S);
  });
  def('drive-d', function (g) { P['cdrom'](g); });
  def('scandisk', function (g) {
    g.bevel(3, 6, 26, 18, true); g.r(6, 9, 20, 12, C.W);
    g.poly([[8, 17], [12, 11], [16, 15], [20, 10], [24, 14], [24, 19], [8, 19]], C.G);
  });
  def('accessibility', function (g) {
    g.ball(16, 10, 5, C.K);
    g.line(16, 15, 16, 24, 3, C.K);
    g.line(9, 19, 23, 19, 3, C.K);
    g.line(16, 24, 11, 29, 2, C.K); g.line(16, 24, 21, 29, 2, C.K);
  });
  def('modems', function (g) { P['modem'](g); });
  def('multimedia', function (g) { speakerShape(g, 3, 8, 2); g.r(24, 10, 4, 8, C.SIL); });
  def('network-config', function (g) { P['network'](g); });
  def('power', function (g) {
    g.r(4, 5, 24, 22, C.K); g.r(5, 6, 22, 20, C.F);
    g.r(7, 8, 18, 16, C.L);
    g.line(16, 10, 16, 16, 2, C.G); g.line(16, 16, 21, 16, 2, C.G);
  });
  def('regional', function (g) {
    g.ball(16, 16, 11, C.C1);
    g.r(5, 15, 22, 2, C.W); g.r(15, 5, 2, 22, C.W);
    g.line(10, 8, 22, 24, 1, C.W); g.line(22, 8, 10, 24, 1, C.W);
  });
  def('users', function (g) {
    g.ball(11, 12, 4, C.K); g.poly([[4, 27], [18, 27], [18, 22], [4, 22]], C.N);
    g.ball(22, 14, 3, C.K); g.poly([[17, 27], [29, 27], [29, 23], [17, 23]], C.P);
  });
  def('add-hardware', function (g) {
    g.bevel(3, 6, 26, 18, true); g.r(6, 9, 20, 12, C.W);
    g.r(9, 12, 6, 6, C.T); g.r(17, 12, 6, 6, C.G); g.r(14, 14, 4, 2, C.S);
  });
  def('internet-options', function (g) { P['ie'](g); });
  def('outlook-express', function (g) { P['outlook'](g); });
  def('windows-update', function (g) { P['ie'](g); });
  def('hourglass', function (g) {
    g.r(6, 4, 20, 3, C.K); g.r(6, 25, 20, 3, C.K);
    g.poly([[9, 7], [23, 7], [17, 16], [23, 25], [9, 25], [15, 16]], C.K);
    g.poly([[11, 9], [21, 9], [16, 15], [21, 23], [11, 23], [16, 15]], C.Y);
    g.r(13, 20, 6, 3, C.S);
  });
  def('my-briefcase', function (g) { P['briefcase'](g); });
  def('my-documents', function (g) { P['documents'](g); });
  def('my-pictures', function (g) { P['pictures'](g); });
  /* the hypervisor: a processor die with pins, carrying a V */
  def('hv', function (g) {
    var i;
    for (i = 0; i < 4; i++) {
      g.r(3, 7 + i * 4, 3, 2, C.F);
      g.r(26, 7 + i * 4, 3, 2, C.F);
    }
    g.r(6, 3, 20, 26, C.K);
    g.r(7, 4, 18, 24, '#000080');
    g.poly([[11, 8], [14, 8], [17, 20], [14, 20]], C.W);
    g.poly([[23, 8], [20, 8], [17, 20], [20, 20]], C.W);
    g.r(7, 4, 18, 2, C.C1);
    g.r(7, 26, 18, 2, C.S);
  });
  def('startflag', function (g) { flag(g, 32); });
  def('win-flag', function (g) { flag(g, 32); });
  function flag(g, s) {
    var u = s / 32;
    g.poly([[3, 12], [14, 6], [14, 14], [3, 20]], C.R);
    g.poly([[15, 5], [29, 1], [29, 10], [15, 14]], C.G);
    g.poly([[3, 21], [14, 16], [14, 25], [3, 30]], C.SKY);
    g.poly([[15, 16], [29, 12], [29, 22], [15, 26]], C.Y);
    g.r(3, 12, 1, 1, C.K);
  }

  /* ------------------------------------------------------------- assets */
  var assets = null, assetKeys = {}, assetKeys16 = {};
  function loadAssets() {
    return fetch('assets/MANIFEST.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        assets = m || null;
        if (m) {
          assetKeys = m.icons || {};
          assetKeys16 = m.icons16 || {};
        }
        return assets;
      })
      .catch(function () { assets = null; return null; });
  }
  function url(key, size) {
    if (!assets) return null;
    var rec = (size <= 16 ? assetKeys16[key] : null) || assetKeys[key];
    if (!rec) rec = assetKeys16[key];
    if (!rec) return null;
    return 'assets/' + (rec.file || ('icons/' + key + '.png'));
  }

  var cache = {};
  var missing = {};
  function canvasFor(key, size) {
    var id = key + '@' + size;
    if (cache[id]) return cache[id];
    var cv;
    var painter = P[key] || P[unknownFallback(key)];
    /* procedural art is authored on a 32x32 grid */
    var g = makeCtx(32);
    if (painter) { try { painter(g); } catch (e) { console.warn('icon painter failed: ' + key, e); } }
    var src = g.cv;
    cv = document.createElement('canvas');
    cv.width = cv.height = size;
    cv.style.width = cv.style.height = size + 'px';
    cv.style.imageRendering = 'pixelated';
    var c2 = cv.getContext('2d');
    c2.imageSmoothingEnabled = false;
    c2.drawImage(src, 0, 0, size, size);
    cache[id] = cv;
    return cv;
  }
  function unknownFallback(key) {
    if (!missing[key]) { missing[key] = 1; }
    return 'unknown-file';
  }

  var imgCache = {};
  function el(key, size) {
    size = size || 32;
    var u = url(key, size);
    if (u) {
      var id = u + '@' + size;
      if (imgCache[id]) return imgCache[id].cloneNode();
      var img = document.createElement('img');
      img.src = u; img.width = size; img.height = size;
      img.style.width = img.style.height = size + 'px';
      img.style.imageRendering = 'pixelated';
      img.className = 'w98-icon';
      imgCache[id] = img;
      return img.cloneNode();
    }
    var cv = canvasFor(key, size);
    var out = cv.cloneNode(true);
    out.getContext('2d').drawImage(cv, 0, 0);
    out.className = 'w98-icon';
    return out;
  }
  function paint(ctx, key, x, y, size) {
    var u = url(key, size);
    if (u) {
      var img = el(key, size);
      ctx.drawImage(img, x, y, size, size);
      return true;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvasFor(key, 32), x, y, size, size);
    return false;
  }

  global.W98Icons = {
    el: el, url: url, paint: paint, loadAssets: loadAssets,
    has: function (key) { return !!url(key, 32); },
    keys: function () { return Object.keys(P); },
    missing: function () { return Object.keys(missing); },
    manifest: function () { return assets; },
    canvas: canvasFor,
    C: C
  };
})(window);
