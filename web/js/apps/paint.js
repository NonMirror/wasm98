/* ===========================================================================
 * Microsoft Paint - faithful Windows 98 clone for the W98 web desktop.
 * File: web/js/apps/paint.js   (classic script, NOT a module)
 * Registers itself through W98.registerApp on load.
 * =========================================================================== */
(function () {
  'use strict';

  if (typeof W98 === 'undefined' || !W98 || typeof W98.registerApp !== 'function') { return; }

  /* --------------------------------------------------------------- styles */

  var STYLE_ID = 'paint-style';
  var CSS = [
    '.paint-root{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;',
    'background:#c0c0c0;color:#000;font:11px Tahoma,"MS Sans Serif",Geneva,sans-serif;overflow:hidden;',
    '-webkit-user-select:none;-moz-user-select:none;user-select:none;}',
    '.paint-root,.paint-root *{box-sizing:border-box;}',
    '.paint-body{flex:1 1 auto;display:flex;min-height:0;min-width:0;overflow:hidden;}',
    '.paint-toolbox{flex:0 0 54px;width:54px;padding:1px 0 0 1px;background:#c0c0c0;overflow:hidden;}',
    '.paint-tools{display:grid;grid-template-columns:25px 25px;grid-auto-rows:25px;}',
    '.paint-tool{width:25px;height:25px;min-width:0;padding:0;margin:0;background:#c0c0c0;border:0;',
    'border-radius:0;box-shadow:none;display:flex;align-items:center;justify-content:center;',
    'cursor:default;font:inherit;color:#000;overflow:hidden;outline:0;}',
    '.paint-tool:hover{box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #808080;}',
    '.paint-tool.lit{box-shadow:inset 1px 1px 0 #808080,inset -1px -1px 0 #fff;}',
    '.paint-tool canvas,.paint-subbtn canvas{display:block;image-rendering:pixelated;image-rendering:-moz-crisp-edges;}',
    '.paint-subs{margin-top:3px;display:flex;flex-direction:column;align-items:flex-start;gap:3px;}',
    '.paint-sub{padding:1px;display:flex;gap:0;background:#c0c0c0;border:1px solid;',
    'border-color:#808080 #fff #fff #808080;}',
    '.paint-sub.off{display:none;}',
    '.paint-subbtn{width:24px;height:22px;padding:0;margin:0;background:#c0c0c0;border:0;border-radius:0;',
    'box-shadow:none;display:flex;align-items:center;justify-content:center;cursor:default;font:inherit;outline:0;}',
    '.paint-subbtn:hover{box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #808080;}',
    '.paint-subbtn.lit{box-shadow:inset 1px 1px 0 #808080,inset -1px -1px 0 #fff;}',
    '.paint-sizebtn{width:42px;height:12px;padding:0;margin:0;background:#c0c0c0;border:0;border-radius:0;',
    'box-shadow:none;display:flex;align-items:center;justify-content:center;cursor:default;outline:0;}',
    '.paint-sizebtn:hover{box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #808080;}',
    '.paint-sizebtn.lit{box-shadow:inset 1px 1px 0 #808080,inset -1px -1px 0 #fff;}',
    '.paint-sizeline{background:#000;width:30px;height:1px;}',
    '.paint-zbtn{width:42px;height:15px;font:11px Tahoma,sans-serif;color:#000;}',
    '.paint-canvas-area{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background:#ffffff;',
    'border:1px solid;border-color:#808080 #fff #fff #808080;padding:3px;}',
    '.paint-canvas{display:block;background:#fff;image-rendering:pixelated;image-rendering:-moz-crisp-edges;}',
    '.paint-bottom{flex:0 0 auto;display:flex;align-items:flex-start;background:#c0c0c0;padding:1px 3px 2px 3px;}',
    '.paint-well{display:flex;align-items:center;gap:4px;padding:2px;background:#c0c0c0;',
    'border:1px solid;border-color:#808080 #fff #fff #808080;}',
    '.paint-pal{display:grid;grid-template-columns:repeat(14,18px);grid-auto-rows:18px;}',
    '.paint-sw{width:16px;height:16px;margin:1px;border:1px solid #808080;cursor:default;}',
    '.paint-sw:hover{border-color:#000;}',
    '.paint-cur{position:relative;width:28px;height:28px;flex:0 0 28px;cursor:default;}',
    '.paint-cur i{position:absolute;display:block;width:16px;height:16px;border:1px solid #000;}',
    '.paint-cur .fg{left:0;top:0;z-index:2;}',
    '.paint-cur .bg{left:11px;top:11px;z-index:1;}',
    '.paint-fontbar{flex:0 0 auto;display:none;align-items:center;gap:5px;padding:2px 5px;background:#c0c0c0;',
    'border-bottom:1px solid #808080;white-space:nowrap;overflow:hidden;}',
    '.paint-fontbar.on{display:flex;}',
    '.paint-fontbar select{height:20px;font:11px Tahoma,sans-serif;}',
    '.paint-fontbar input.paint-fsize{width:44px;height:20px;font:11px Tahoma,sans-serif;text-align:right;}',
    '.paint-fontbar button{width:26px;height:22px;font:bold 11px Tahoma,sans-serif;padding:0;}',
    '.paint-fontbar button.paint-it{font-style:italic;}',
    '.paint-modal{position:absolute;left:0;top:0;right:0;bottom:0;z-index:60;}',
    '.paint-dlg{position:absolute;background:#c0c0c0;border:2px solid;border-color:#dfdfdf #000 #000 #dfdfdf;padding:1px;}',
    '.paint-dlg-in{border:1px solid;border-color:#fff #808080 #808080 #fff;display:flex;flex-direction:column;background:#c0c0c0;}',
    '.paint-dlg-title{height:18px;display:flex;align-items:center;padding:0 2px 0 4px;',
    'background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font:bold 11px Tahoma,sans-serif;cursor:default;}',
    '.paint-dlg-title span{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
    '.paint-dlg-x{width:17px;height:15px;min-width:17px;font:bold 9px Tahoma;padding:0;line-height:1;',
    'display:flex;align-items:center;justify-content:center;}',
    '.paint-dlg-body{padding:9px;overflow:auto;}',
    '.paint-dlg-btns{display:flex;justify-content:flex-end;gap:6px;padding:0 9px 9px 9px;}',
    '.paint-dlg-btns button{min-width:66px;height:23px;}',
    '.paint-row{display:flex;align-items:center;gap:6px;margin:5px 0;}',
    '.paint-col{display:flex;flex-direction:column;gap:5px;}',
    '.paint-num{width:54px;height:19px;text-align:right;font:11px Tahoma,sans-serif;}',
    '.paint-grid48{display:grid;grid-template-columns:repeat(24,15px);grid-auto-rows:15px;}',
    '.paint-c48{width:15px;height:15px;border:1px solid #808080;cursor:default;}',
    '.paint-spectrum{display:block;border:1px solid;border-color:#808080 #fff #fff #808080;',
    'image-rendering:pixelated;cursor:crosshair;}',
    '.paint-lum{display:block;border:1px solid;border-color:#808080 #fff #fff #808080;cursor:ns-resize;}',
    '.paint-preview{width:56px;height:32px;border:1px solid;border-color:#808080 #fff #fff #808080;padding:1px;}',
    '.paint-preview i{display:block;width:100%;height:100%;}',
    '.paint-group{border:1px solid #808080;border-top-color:#fff;border-left-color:#fff;padding:6px;background:#c0c0c0;}',
    '.paint-textbox{position:absolute;background:transparent;border:1px dashed #000;color:#000;padding:0;margin:0;',
    'resize:none;overflow:hidden;white-space:pre;outline:0;font:11px Tahoma,sans-serif;z-index:5;}'
  ].join('\n');

  function injectStyle() {
    try {
      if (document.getElementById(STYLE_ID)) { return; }
      var s = document.createElement('style');
      s.id = STYLE_ID;
      s.type = 'text/css';
      s.appendChild(document.createTextNode(CSS));
      var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
      head.appendChild(s);
    } catch (e) { /* ignore */ }
  }

  injectStyle();

  /* ------------------------------------------------------------- constants */

  var HELP_TEXT = 'For Help, click Help Topics on the Help Menu.';
  var UNDO_LIMIT = 8;
  var TMP_BMP = 'C:\\WINDOWS\\TEMP\\~PAINT.BMP';
  var REG_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Paint';

  /* The 28 colors of the MS Paint palette: row 1 = "dark" row, row 2 = bright. */
  var DEFAULT_PALETTE = [
    '#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080',
    '#800080', '#808040', '#004040', '#0080ff', '#004080', '#8000ff', '#804000',
    '#ffffff', '#c0c0c0', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff',
    '#ff00ff', '#ffff80', '#00ff80', '#80ffff', '#8080ff', '#ff0080', '#ff8040'
  ];

  var TOOLS = [
    { id: 'freeform', name: 'Free-Form Select', kind: 'sel',
      hint: 'Selects a free-form part of the picture to move, copy, or edit.' },
    { id: 'select', name: 'Select', kind: 'sel',
      hint: 'Selects a rectangular part of the picture to move, copy, or edit.' },
    { id: 'eraser', name: 'Eraser/Color Eraser', kind: 'paint',
      hint: 'Erases a portion of the picture, using the selected eraser shape.' },
    { id: 'fill', name: 'Fill With Color', kind: 'click',
      hint: 'Fills an area with the current drawing color.' },
    { id: 'pick', name: 'Pick Color', kind: 'click',
      hint: 'Picks up a color from the picture for drawing.' },
    { id: 'magnify', name: 'Magnifier', kind: 'click',
      hint: 'Changes the magnification.' },
    { id: 'pencil', name: 'Pencil', kind: 'paint',
      hint: 'Draws a free-form line one pixel wide.' },
    { id: 'brush', name: 'Brush', kind: 'paint',
      hint: 'Draws a line of the selected width and shape.' },
    { id: 'airbrush', name: 'Airbrush', kind: 'paint',
      hint: 'Draws using an airbrush of the selected size.' },
    { id: 'text', name: 'Text', kind: 'text',
      hint: 'Inserts text into the picture.' },
    { id: 'line', name: 'Line', kind: 'shape',
      hint: 'Draws a straight line of the selected width.' },
    { id: 'curve', name: 'Curve', kind: 'shape',
      hint: 'Draws a curved line of the selected width.' },
    { id: 'rect', name: 'Rectangle', kind: 'shape',
      hint: 'Draws a rectangle of the selected fill style.' },
    { id: 'polygon', name: 'Polygon', kind: 'shape',
      hint: 'Draws a polygon of the selected fill style.' },
    { id: 'ellipse', name: 'Ellipse', kind: 'shape',
      hint: 'Draws an ellipse of the selected fill style.' },
    { id: 'rrect', name: 'Rounded Rectangle', kind: 'shape',
      hint: 'Draws a rounded rectangle of the selected fill style.' }
  ];

  function toolById(id) {
    for (var i = 0; i < TOOLS.length; i++) { if (TOOLS[i].id === id) { return TOOLS[i]; } }
    return TOOLS[6];
  }

  /* ------------------------------------------------------------ primitives */

  function nc(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w) || 1);
    c.height = Math.max(1, Math.round(h) || 1);
    return c;
  }

  function c2(c) {
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    if ('webkitImageSmoothingEnabled' in g) { g.webkitImageSmoothingEnabled = false; }
    return g;
  }

  function copyCanvas(src) {
    var c = nc(src.width, src.height);
    c2(c).drawImage(src, 0, 0);
    return c;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x | 0, y | 0, 1, 1); }

  function pxr(g, x, y, w, h, col) {
    g.fillStyle = col;
    g.fillRect(x | 0, y | 0, Math.max(1, w | 0), Math.max(1, h | 0));
  }

  /* Bresenham pixel line - crisp 1px, optional 50% dash. */
  function bres(g, x0, y0, x1, y1, col, dashed) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx + dy, k = 0, guard = 0;
    for (;;) {
      if (!dashed || (k % 2) === 0) { px(g, x0, y0, col); }
      k++;
      if ((x0 === x1 && y0 === y1) || guard++ > 4096) { break; }
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function strokePoly(g, pts, col, dashed) {
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      bres(g, a[0], a[1], b[0], b[1], col, dashed);
    }
  }

  function fillPoly(g, pts, col) {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
    for (var i = 1; i < pts.length; i++) { g.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5); }
    g.closePath();
    g.fill();
  }

  function ring(g, cx, cy, rx, ry, col, thick) {
    var t = thick || 1, n = Math.max(24, Math.round((rx + ry) * 6));
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2;
      var x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a);
      for (var k = 0; k < t; k++) { px(g, Math.round(x), Math.round(y + k), col); }
    }
  }

  /* ---------------------------------------------------------- tool icons */

  function Icon(g, id) {
    switch (id) {
      case 'freeform':
        strokePoly(g, [[3, 3], [7, 1], [10, 4], [13, 2], [12, 6], [14, 10], [10, 9],
                       [11, 13], [7, 11], [4, 14], [3, 10], [1, 7]], '#000', true);
        break;

      case 'select':
        bres(g, 2, 3, 13, 3, '#000', true);
        bres(g, 13, 3, 13, 12, '#000', true);
        bres(g, 13, 12, 2, 12, '#000', true);
        bres(g, 2, 12, 2, 3, '#000', true);
        break;

      case 'eraser':
        fillPoly(g, [[2, 12], [7, 2], [13, 3], [8, 13]], '#ffffff');
        fillPoly(g, [[5, 6], [8, 3], [11, 4], [8, 6]], '#808080');
        strokePoly(g, [[2, 12], [7, 2], [13, 3], [8, 13]], '#000');
        break;

      case 'fill':
        fillPoly(g, [[2, 7], [8, 1], [14, 7], [8, 13]], '#ffffff');
        strokePoly(g, [[2, 7], [8, 1], [14, 7], [8, 13]], '#000');
        bres(g, 1, 1, 3, 4, '#000');
        bres(g, 3, 4, 1, 4, '#000');
        px(g, 1, 5, '#000');
        break;

      case 'pick':
        fillPoly(g, [[3, 10], [9, 4], [12, 7], [6, 13]], '#ffffff');
        strokePoly(g, [[3, 10], [9, 4], [12, 7], [6, 13]], '#000');
        px(g, 3, 12, '#000'); px(g, 2, 13, '#000'); px(g, 2, 12, '#000');
        pxr(g, 10, 2, 3, 3, '#ffffff');
        px(g, 10, 1, '#000'); px(g, 12, 1, '#000'); px(g, 13, 1, '#000');
        px(g, 13, 2, '#000'); px(g, 13, 4, '#000'); px(g, 10, 5, '#000');
        px(g, 12, 5, '#000'); px(g, 9, 2, '#000'); px(g, 9, 4, '#000');
        break;

      case 'magnify':
        ring(g, 6, 6, 5, 5, '#000');
        bres(g, 10, 10, 14, 14, '#000');
        bres(g, 11, 10, 14, 13, '#000');
        bres(g, 10, 11, 13, 14, '#000');
        break;

      case 'pencil':
        fillPoly(g, [[3, 11], [5, 13], [13, 5], [11, 3]], '#ffe000');
        strokePoly(g, [[3, 11], [5, 13], [13, 5], [11, 3]], '#000');
        fillPoly(g, [[3, 11], [5, 13], [2, 14]], '#000');
        bres(g, 11, 3, 13, 5, '#808080');
        fillPoly(g, [[12, 2], [14, 2], [14, 4], [12, 4]], '#ff8080');
        break;

      case 'brush':
        bres(g, 14, 1, 10, 5, '#000');
        bres(g, 15, 2, 11, 6, '#000');
        fillPoly(g, [[9, 5], [12, 8], [4, 14], [1, 11]], '#000');
        fillPoly(g, [[9, 5], [12, 8], [11, 9], [8, 6]], '#808080');
        px(g, 8, 13, '#808080'); px(g, 11, 11, '#808080');
        break;

      case 'airbrush':
        pxr(g, 10, 1, 4, 9, '#ffffff');
        strokePoly(g, [[10, 1], [14, 1], [14, 10], [10, 10]], '#000');
        pxr(g, 10, 4, 4, 4, '#808080');
        pxr(g, 11, 11, 2, 1, '#000');
        (function () {
          var d = [[8, 12], [5, 13], [7, 14], [4, 10], [6, 9], [3, 12], [9, 14],
                   [2, 11], [5, 15], [1, 14], [3, 8], [8, 9]];
          for (var i = 0; i < d.length; i++) { px(g, d[i][0], d[i][1], '#000'); }
        }());
        break;

      case 'text':
        bres(g, 5, 13, 8, 3, '#000');
        bres(g, 8, 3, 11, 13, '#000');
        bres(g, 6, 9, 10, 9, '#000');
        pxr(g, 2, 13, 4, 1, '#000');
        pxr(g, 10, 13, 4, 1, '#000');
        pxr(g, 7, 2, 3, 1, '#000');
        break;

      case 'line':
        bres(g, 3, 12, 12, 3, '#000');
        pxr(g, 2, 11, 2, 2, '#000');
        pxr(g, 11, 2, 2, 2, '#000');
        break;

      case 'curve':
        (function () {
          for (var x = 2; x <= 13; x++) {
            var t = (x - 2) / 11;
            var y = Math.round(8 - 4.2 * Math.sin(t * Math.PI * 1.5));
            px(g, x, y, '#000');
            px(g, x, y - 1, '#000');
          }
        }());
        pxr(g, 1, 9, 2, 2, '#000');
        pxr(g, 13, 4, 2, 2, '#000');
        break;

      case 'rect':
        pxr(g, 2, 2, 12, 1, '#000');
        pxr(g, 2, 12, 12, 1, '#000');
        pxr(g, 2, 2, 1, 11, '#000');
        pxr(g, 13, 2, 1, 11, '#000');
        break;

      case 'polygon':
        strokePoly(g, [[8, 2], [13, 6], [11, 13], [5, 13], [2, 6]], '#000');
        break;

      case 'ellipse':
        ring(g, 7.5, 7.5, 6, 4.6, '#000');
        break;

      case 'rrect':
        pxr(g, 4, 2, 8, 1, '#000');
        pxr(g, 4, 13, 8, 1, '#000');
        pxr(g, 2, 4, 1, 8, '#000');
        pxr(g, 13, 4, 1, 8, '#000');
        px(g, 3, 3, '#000'); px(g, 12, 3, '#000');
        px(g, 3, 12, '#000'); px(g, 12, 12, '#000');
        break;
    }
  }

  function toolIcon(id) {
    var c = nc(16, 16);
    var g = c2(c);
    try { Icon(g, id); } catch (e) { /* keep the blank icon */ }
    return c;
  }

  /* Icons for the option sub-boxes (selection mode / fill style). */
  function optionIcon(kind) {
    var c = nc(16, 16);
    var g = c2(c);
    try {
      if (kind === 'opaque') {
        pxr(g, 2, 3, 12, 10, '#808080');
        strokePoly(g, [[2, 3], [13, 3], [13, 12], [2, 12]], '#000');
      } else if (kind === 'transparent') {
        pxr(g, 2, 3, 12, 10, '#ffffff');
        strokePoly(g, [[2, 3], [13, 3], [13, 12], [2, 12]], '#000', true);
        bres(g, 2, 12, 13, 3, '#808080');
      } else if (kind === 'outline') {
        pxr(g, 2, 4, 12, 9, '#ffffff');
        strokePoly(g, [[2, 4], [13, 4], [13, 12], [2, 12]], '#000');
      } else if (kind === 'both') {
        pxr(g, 2, 4, 12, 9, '#808080');
        strokePoly(g, [[2, 4], [13, 4], [13, 12], [2, 12]], '#000');
      } else if (kind === 'solid') {
        pxr(g, 2, 4, 12, 9, '#808080');
      }
    } catch (e) { /* ignore */ }
    return c;
  }

  /* --------------------------------------------------------------- color */

  function hex2rgb(h) {
    h = String(h == null ? '#000000' : h).replace('#', '');
    if (h.length === 3) { h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); }
    var n = parseInt(h, 16);
    if (isNaN(n)) { n = 0; }
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgb2hex(r, g, b) {
    r = clamp(Math.round(r), 0, 255); g = clamp(Math.round(g), 0, 255); b = clamp(Math.round(b), 0, 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function packHex(hex) {
    var c = hex2rgb(hex);
    var t = new Uint8Array(4);
    t[0] = c.r; t[1] = c.g; t[2] = c.b; t[3] = 255;
    return new Uint32Array(t.buffer)[0];
  }

  /* Windows HSL: H 0..239, S 0..240, L 0..240 (matches the Paint color dialog). */
  function hsl2rgb(H, S, L) {
    var h = (clamp(H, 0, 240) / 240) * 360;
    var s = clamp(S, 0, 240) / 240;
    var l = clamp(L, 0, 240) / 240;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; }
    else if (h < 120) { r1 = x; g1 = c; }
    else if (h < 180) { g1 = c; b1 = x; }
    else if (h < 240) { g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
  }

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2, s = 0, h = 0;
    if (d > 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) { h = 60 * (((g - b) / d) % 6); }
      else if (mx === g) { h = 60 * (((b - r) / d) + 2); }
      else { h = 60 * (((r - g) / d) + 4); }
    }
    if (h < 0) { h += 360; }
    return {
      h: Math.round(h / 360 * 240),
      s: Math.round(clamp(s, 0, 1) * 240),
      l: Math.round(clamp(l, 0, 1) * 240)
    };
  }

  /* ----------------------------------------------------------- BMP codec */

  /* 24-bit BI_RGB, bottom-up - Paint's own default save format. */
  function encodeBMP(canvas) {
    var w = canvas.width, h = canvas.height;
    var d = c2(canvas).getImageData(0, 0, w, h).data;
    var rowSize = (w * 3 + 3) & ~3;
    var body = rowSize * h;
    var out = new Uint8Array(54 + body);
    var dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4D;
    dv.setUint32(2, 54 + body, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(30, 0, true);
    dv.setUint32(34, body, true);
    dv.setInt32(38, 2835, true);
    dv.setInt32(42, 2835, true);
    var y, x, off, i;
    for (y = 0; y < h; y++) {
      off = 54 + y * rowSize;
      var srcRow = (h - 1 - y) * w * 4;
      for (x = 0; x < w; x++) {
        i = srcRow + x * 4;
        out[off] = d[i + 2]; out[off + 1] = d[i + 1]; out[off + 2] = d[i];
        off += 3;
      }
    }
    return out;
  }

  /* Decodes 1/4/8/24/32-bit BI_RGB (and 32-bit BITFIELDS) BMPs. */
  function decodeBMP(bytes) {
    try {
      if (!bytes || bytes.length < 54) { return null; }
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes[0] !== 0x42 || bytes[1] !== 0x4D) { return null; }
      var dataOff = dv.getUint32(10, true);
      var hdrSize = dv.getUint32(14, true);
      if (hdrSize < 40) { return null; }
      var w = dv.getInt32(18, true);
      var hRaw = dv.getInt32(22, true);
      var topDown = hRaw < 0;
      var h = Math.abs(hRaw);
      var planes = dv.getUint16(26, true);
      var bpp = dv.getUint16(28, true);
      var comp = dv.getUint32(30, true);
      if (w <= 0 || h <= 0 || w > 8192 || h > 8192 || planes !== 1) { return null; }
      if (comp === 1 || comp === 2) { return null; }              /* RLE4/RLE8 unsupported */
      if (comp === 3 && bpp !== 32 && bpp !== 16) { return null; } /* BITFIELDS */
      if (bpp !== 1 && bpp !== 4 && bpp !== 8 && bpp !== 16 && bpp !== 24 && bpp !== 32) { return null; }

      var pal = [], ncol = 0, i, q;
      if (bpp <= 8) {
        ncol = dv.getUint32(46, true);
        if (!ncol) { ncol = 1 << bpp; }
        var p = 14 + hdrSize;
        for (i = 0; i < ncol; i++) {
          q = p + i * 4;
          if (q + 3 >= bytes.length) { break; }
          pal.push([bytes[q + 2], bytes[q + 1], bytes[q]]);
        }
      }
      var cnv = nc(w, h), gc = c2(cnv);
      var imgd = gc.createImageData(w, h), o = imgd.data;
      var rowSize = Math.floor((bpp * w + 31) / 32) * 4;
      var x, y, r, gg, b2, off, oi, pi, byt;
      for (y = 0; y < h; y++) {
        var srcRow = dataOff + (topDown ? y : (h - 1 - y)) * rowSize;
        for (x = 0; x < w; x++) {
          r = gg = b2 = 0;
          if (bpp === 24) { off = srcRow + x * 3; b2 = bytes[off]; gg = bytes[off + 1]; r = bytes[off + 2]; }
          else if (bpp === 32) { off = srcRow + x * 4; b2 = bytes[off]; gg = bytes[off + 1]; r = bytes[off + 2]; }
          else if (bpp === 16) {
            off = srcRow + x * 2;
            var v = bytes[off] | (bytes[off + 1] << 8);
            r = ((v >> 10) & 31) * 255 / 31; gg = ((v >> 5) & 31) * 255 / 31; b2 = (v & 31) * 255 / 31;
          } else if (bpp === 8) {
            pi = bytes[srcRow + x];
            var e8 = pal[pi] || [0, 0, 0]; r = e8[0]; gg = e8[1]; b2 = e8[2];
          } else if (bpp === 4) {
            byt = bytes[srcRow + (x >> 1)];
            pi = (x & 1) ? (byt & 15) : (byt >> 4);
            var e4 = pal[pi] || [0, 0, 0]; r = e4[0]; gg = e4[1]; b2 = e4[2];
          } else {
            byt = bytes[srcRow + (x >> 3)];
            pi = (byt >> (7 - (x & 7))) & 1;
            var e1 = pal[pi] || [0, 0, 0]; r = e1[0]; gg = e1[1]; b2 = e1[2];
          }
          oi = (y * w + x) * 4;
          o[oi] = r; o[oi + 1] = gg; o[oi + 2] = b2; o[oi + 3] = 255;
        }
      }
      gc.putImageData(imgd, 0, 0);
      return cnv;
    } catch (e) { return null; }
  }

  /* ----------------------------------------------------- RIFF .PAL codec */

  function encodePAL(colors) {
    var n = Math.min(256, colors.length);
    var out = new Uint8Array(24 + n * 4);
    var dv = new DataView(out.buffer);
    var put = function (off, s) { for (var i = 0; i < s.length; i++) { out[off + i] = s.charCodeAt(i); } };
    put(0, 'RIFF');
    dv.setUint32(4, 16 + n * 4, true);
    put(8, 'PAL ');
    put(12, 'data');
    dv.setUint32(16, 4 + n * 4, true);
    dv.setUint16(20, 0x0300, true);
    dv.setUint16(22, n, true);
    for (var i = 0; i < n; i++) {
      var c = hex2rgb(colors[i]);
      out[24 + i * 4] = c.r; out[25 + i * 4] = c.g; out[26 + i * 4] = c.b; out[27 + i * 4] = 0;
    }
    return out;
  }

  function decodePAL(bytes) {
    try {
      if (!bytes || bytes.length < 28) { return null; }
      var s4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      if (s4 !== 'RIFF') { return null; }
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var n = dv.getUint16(22, true);
      if (!n || 24 + n * 4 > bytes.length) {
        n = Math.floor((bytes.length - 24) / 4);
      }
      n = clamp(n, 1, 256);
      var out = [];
      for (var i = 0; i < n; i++) {
        out.push(rgb2hex(bytes[24 + i * 4], bytes[25 + i * 4], bytes[26 + i * 4]));
      }
      return out;
    } catch (e) { return null; }
  }

  /* --------------------------------------------------------- flood fill */

  /* Stack based scanline fill on raw ImageData - O(pixels), never recurses. */
  function floodFillCanvas(canvas, sx, sy, hex) {
    var w = canvas.width, h = canvas.height;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) { return false; }
    var g = canvas.getContext('2d');
    var img = g.getImageData(0, 0, w, h);
    var u32 = new Uint32Array(img.data.buffer);
    var fill = packHex(hex);
    var target = u32[sy * w + sx];
    if (target === fill) { return false; }

    var stack = [], sp = 0;
    stack[sp++] = sx; stack[sp++] = sy;
    var w1 = w - 1, h1 = h - 1;
    while (sp > 0) {
      var y = stack[--sp], x = stack[--sp];
      var row = y * w;
      if (u32[row + x] !== target) { continue; }
      var xl = x;
      while (xl > 0 && u32[row + xl - 1] === target) { xl--; }
      var xr = x;
      while (xr < w1 && u32[row + xr + 1] === target) { xr++; }
      for (var i = xl; i <= xr; i++) { u32[row + i] = fill; }
      for (var ny = y - 1; ny <= y + 1; ny += 2) {
        if (ny < 0 || ny > h1) { continue; }
        var nrow = ny * w, inSpan = false;
        for (var j = xl; j <= xr; j++) {
          if (u32[nrow + j] === target) {
            if (!inSpan) { stack[sp++] = j; stack[sp++] = ny; inSpan = true; }
          } else { inSpan = false; }
        }
      }
    }
    g.putImageData(img, 0, 0);
    return true;
  }

  /* Color eraser: repaint every pixel equal to `fromHex` inside the box. */
  function colorErase(canvas, x0, y0, x1, y1, fromHex, toHex) {
    var w = canvas.width, h = canvas.height;
    x0 = clamp(Math.min(x0, x1), 0, w - 1); x1 = clamp(Math.max(x0, x1), 0, w - 1);
    y0 = clamp(Math.min(y0, y1), 0, h - 1); y1 = clamp(Math.max(y0, y1), 0, h - 1);
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    var g = canvas.getContext('2d');
    var img = g.getImageData(x0, y0, bw, bh);
    var u32 = new Uint32Array(img.data.buffer);
    var from = packHex(fromHex), to = packHex(toHex);
    var n = 0;
    for (var i = 0; i < u32.length; i++) {
      if (u32[i] === from) { u32[i] = to; n++; }
    }
    if (n) { g.putImageData(img, x0, y0); }
    return n;
  }

  function getPixelHex(canvas, x, y) {
    try {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) { return null; }
      var d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return rgb2hex(d[0], d[1], d[2]);
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------- draw routines */

  /* All of these work in *document* coordinates so the same code paints the
   * committed bitmap and the on-screen preview (preview runs under a scaled
   * transform). w = 1 gives exact GDI-ish 1px output for lines. */

  function thickLine(g, x0, y0, x1, y1, w, col) {
    if (w <= 1) { bres(g, x0, y0, x1, y1, col); return; }
    var half = Math.floor(w / 2);
    g.fillStyle = col;
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.max(Math.abs(dx), Math.abs(dy));
    var steps = Math.max(1, Math.ceil(len));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
      g.fillRect(x - half, y - half, w, w);
    }
  }

  function drawRectShape(g, x0, y0, x1, y1, w, col, fillCol) {
    var lx = Math.min(x0, x1), rx = Math.max(x0, x1);
    var ty = Math.min(y0, y1), by = Math.max(y0, y1);
    if (fillCol) {
      g.fillStyle = fillCol;
      g.fillRect(lx, ty, rx - lx + 1, by - ty + 1);
    }
    if (col) {
      if (w <= 1) {
        g.fillStyle = col;
        g.fillRect(lx, ty, rx - lx + 1, 1);
        g.fillRect(lx, by, rx - lx + 1, 1);
        g.fillRect(lx, ty, 1, by - ty + 1);
        g.fillRect(rx, ty, 1, by - ty + 1);
      } else {
        g.strokeStyle = col;
        g.lineWidth = w;
        g.strokeRect(lx + w / 2, ty + w / 2, Math.max(0, rx - lx + 1 - w), Math.max(0, by - ty + 1 - w));
      }
    }
  }

  /* Aliased (GDI style) ellipse rasteriser - no antialiasing anywhere.
   * Zingl's integer midpoint ellipse; visits every outline pixel. */
  function ellipseScan(x0, y0, x1, y1, onPixel) {
    var a = Math.abs(x1 - x0), b = Math.abs(y1 - y0), b1 = b & 1;
    if (x0 > x1) { x0 = x1; x1 += a; }
    if (y0 > y1) { y0 = y1; }
    y0 += ((b + 1) / 2) | 0;
    y1 = y0 - b1;
    var dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a;
    var err = dx + dy + b1 * a * a, e2, guard = 0;
    a *= 8 * a; b1 = 8 * b * b;
    do {
      onPixel(x1, y0); onPixel(x0, y0); onPixel(x0, y1); onPixel(x1, y1);
      e2 = 2 * err;
      if (e2 <= dy) { y0++; y1--; err += dy += a; }
      if (e2 >= dx || 2 * err > dy) { x0++; x1--; err += dx += b1; }
    } while (x0 <= x1 && guard++ < 100000);
    while (y0 - y1 < b) {
      onPixel(x0 - 1, y0); onPixel(x1 + 1, y0++);
      onPixel(x0 - 1, y1); onPixel(x1 + 1, y1--);
    }
  }

  function drawEllipseShape(g, x0, y0, x1, y1, w, col, fillCol) {
    var lx = Math.min(x0, x1), rx = Math.max(x0, x1);
    var ty = Math.min(y0, y1), by = Math.max(y0, y1);
    var pts = [], spans = {};
    function mark(px_, py_) {
      pts.push(px_, py_);
      var s = spans[py_];
      if (!s) { spans[py_] = [px_, px_]; }
      else { if (px_ < s[0]) { s[0] = px_; } if (px_ > s[1]) { s[1] = px_; } }
    }
    var ww = Math.max(1, w | 0);
    var outer = Math.floor((ww - 1) / 2);
    for (var i = 0; i < ww; i++) {
      var ins = i - outer;
      try {
        ellipseScan(lx + ins, ty + ins, rx - ins, by - ins, mark);
      } catch (e) { /* keep going */ }
    }
    var y, s2;
    if (fillCol) {
      g.fillStyle = fillCol;
      for (y in spans) {
        if (spans.hasOwnProperty(y)) {
          s2 = spans[y];
          g.fillRect(s2[0], +y, s2[1] - s2[0] + 1, 1);
        }
      }
    }
    if (col) {
      g.fillStyle = col;
      for (i = 0; i < pts.length; i += 2) { g.fillRect(pts[i], pts[i + 1], 1, 1); }
    }
  }

  function drawRoundRectShape(g, x0, y0, x1, y1, w, col, fillCol) {
    var lx = Math.min(x0, x1), rx = Math.max(x0, x1);
    var ty = Math.min(y0, y1), by = Math.max(y0, y1);
    var bw = Math.max(2, rx - lx), bh = Math.max(2, by - ty);
    var r = Math.max(1, Math.min(10, Math.round(Math.min(bw, bh) / 4)));
    var o = (w > 1) ? (w / 2) : 0.5;
    g.beginPath();
    g.moveTo(lx + r + o, ty + o);
    g.lineTo(rx - r + o, ty + o);
    g.quadraticCurveTo(rx + o, ty + o, rx + o, ty + r + o);
    g.lineTo(rx + o, by - r + o);
    g.quadraticCurveTo(rx + o, by + o, rx - r + o, by + o);
    g.lineTo(lx + r + o, by + o);
    g.quadraticCurveTo(lx + o, by + o, lx + o, by - r + o);
    g.lineTo(lx + o, ty + r + o);
    g.quadraticCurveTo(lx + o, ty + o, lx + r + o, ty + o);
    g.closePath();
    if (fillCol) { g.fillStyle = fillCol; g.fill(); }
    if (col) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.stroke();
    }
  }

  function drawPolyShape(g, pts, w, col, fillCol, closeIt) {
    if (!pts || pts.length < 2) { return; }
    g.beginPath();
    g.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
    for (var i = 1; i < pts.length; i++) { g.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5); }
    if (closeIt) { g.closePath(); }
    if (fillCol && closeIt && pts.length > 2) { g.fillStyle = fillCol; g.fill(); }
    if (col) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.lineJoin = 'miter';
      g.stroke();
    }
  }

  /* p = {x0,y0,c1x,c1y,c2x,c2y,x1,y1} - cubic when controls are present. */
  function drawCurveShape(g, p, w, col) {
    g.beginPath();
    g.moveTo(p.x0 + 0.5, p.y0 + 0.5);
    if (p.c1x == null) {
      g.lineTo(p.x1 + 0.5, p.y1 + 0.5);
    } else if (p.c2x == null) {
      g.quadraticCurveTo(p.c1x + 0.5, p.c1y + 0.5, p.x1 + 0.5, p.y1 + 0.5);
    } else {
      g.bezierCurveTo(p.c1x + 0.5, p.c1y + 0.5, p.c2x + 0.5, p.c2y + 0.5, p.x1 + 0.5, p.y1 + 0.5);
    }
    g.strokeStyle = col;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.stroke();
    g.lineCap = 'butt';
  }

  /* Snap the end point of a drag to 45 degree increments (shift key). */
  function snap45(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx === 0 && ady === 0) { return { x: x1, y: y1 }; }
    var ang = Math.atan2(dy, dx);
    var step = Math.PI / 4;
    ang = Math.round(ang / step) * step;
    var len = Math.max(adx, ady) * (Math.abs(Math.cos(ang)) + Math.abs(Math.sin(ang)) > 1.4 ? Math.SQRT2 / 2 : 1);
    len = Math.max(adx, ady) / Math.max(0.0001, Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang))));
    return { x: Math.round(x0 + Math.cos(ang) * len), y: Math.round(y0 + Math.sin(ang) * len) };
  }

  /* Snap a drag box to a square (shift key). */
  function snapSquare(x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0;
    var s = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: x0 + (dx < 0 ? -s : s), y: y0 + (dy < 0 ? -s : s) };
  }

  /* ------------------------------------------------------- dom utilities */

  function el(tag, cls, parent) {
    var d = document.createElement(tag);
    if (cls) { d.className = cls; }
    if (parent) { parent.appendChild(d); }
    return d;
  }

  function mkbtn(parent, cls, label) {
    var b = el('button', cls, parent);
    b.type = 'button';
    if (label != null) { b.textContent = label; }
    return b;
  }

  function fmtPx(n) { return (Math.round(n * 10) / 10) + 'px'; }

  /* Shared between every Paint window in this session. */
  var clipboard = null;
  var lastTextCommitAt = 0;

  var SIZES = [1, 2, 3, 4, 5];
  var ERASER_SIZES = [4, 6, 8, 10, 12];
  var AIR_RADII = [3, 5, 8, 11, 15];
  var ZOOMS = [1, 2, 4, 8];

  /* ======================================================== the app body */

  function createApp(win, args) {
    var root = el('div', 'paint-root');
    win.el.appendChild(root);

    /* ------------------------------------------------------------ state */

    var docW = 64, docH = 64;
    var doc = nc(64, 64), dctx = c2(doc);
    var view = nc(64, 64), vctx = c2(view);

    var zoom = 1;
    var zoomLevel = 1;               /* chosen magnification in the zoom sub-box */
    var fg = '#000000', bg = '#ffffff';
    var tool = 'pencil';
    var sizeIdx = 1;                 /* 1..5 */
    var customW = 0;                 /* user width, 0 = unused */
    var selOpaque = true;
    var fillMode = 0;                /* 0 outline, 1 outline+fill, 2 fill only */
    var palette = loadPalette();
    var undoStack = [], redoStack = [];
    var sel = null;                  /* {x,y,w,h,mask,clip}  (not lifted) */
    var floatSel = null;             /* {x,y,w,h,clip,opaque,pushed} */
    var drag = null;
    var lassoPts = null;
    var polyPts = null;
    var curve = null;
    var textBox = null;
    var dirty = false, docPath = null, docName = 'untitled';
    var capsOn = false, numOn = false;
    var mouse = { x: 0, y: 0, inside: false };
    var timers = [], dialogs = [], docMoves = [], docUps = [];
    var airTimer = 0;
    var lastStatus = '';
    var showToolbox = true, showColorbox = true, showTextbar = true;
    var font = { family: 'MS Sans Serif', size: 12, bold: false, italic: false };

    /* ------------------------------------------------------------ layout */

    var body = el('div', 'paint-body', root);
    var toolbox = el('div', 'paint-toolbox', body);
    var toolGrid = el('div', 'paint-tools', toolbox);
    var subs = el('div', 'paint-subs', toolbox);

    var selBox = el('div', 'paint-sub', subs);
    var sizeBox = el('div', 'paint-sub', subs);
    var zoomBox = el('div', 'paint-sub off', subs);
    var fillBox = el('div', 'paint-sub off', subs);
    sizeBox.style.flexDirection = 'column';
    zoomBox.style.flexDirection = 'column';
    fillBox.style.flexDirection = 'column';
    sizeBox.style.display = 'none';   /* filled in below */

    var area = el('div', 'paint-canvas-area', body);
    area.style.position = 'relative';
    var view_el = el('canvas', 'paint-canvas', area);
    view_el.width = 64; view_el.height = 64;

    var bottom = el('div', 'paint-bottom', root);
    var well = el('div', 'paint-well', bottom);
    var curBox = el('div', 'paint-cur', well);
    var bgSw = el('i', 'bg', curBox);
    var fgSw = el('i', 'fg', curBox);
    var palGrid = el('div', 'paint-pal', well);

    var fontBar = el('div', 'paint-fontbar', root);
    root.insertBefore(fontBar, body);

    /* ------------------------------------------------ toolbox: 16 tools */

    var toolEls = {};
    (function buildTools() {
      for (var i = 0; i < TOOLS.length; i++) {
        var t = TOOLS[i];
        var b = mkbtn(toolGrid, 'paint-tool');
        b.title = t.name;
        b.setAttribute('aria-label', t.name);
        b.appendChild(toolIcon(t.id));
        (function (id) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { setTool(id); });
          b.addEventListener('mouseenter', function () { hint(toolById(id).hint); });
          b.addEventListener('mouseleave', function () { hint(HELP_TEXT); });
        }(t.id));
        toolEls[t.id] = b;
      }
    }());

    /* selection mode sub box (2 options) */
    var selBtns = [];
    (function () {
      var opts = [['opaque', true], ['transparent', false]];
      for (var i = 0; i < opts.length; i++) {
        var b = mkbtn(selBox, 'paint-subbtn');
        b.title = opts[i][0] === 'opaque' ? 'Opaque' : 'Transparent';
        b.appendChild(optionIcon(opts[i][0]));
        (function (val) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { selOpaque = val; updateToolUI(); });
        }(opts[i][1]));
        selBtns.push({ el: b, val: opts[i][1] });
      }
    }());

    /* line width sub box (5 lines + optional custom entry) */
    var sizeBtns = [];
    (function () {
      for (var i = 0; i < 5; i++) {
        var b = mkbtn(sizeBox, 'paint-sizebtn');
        b.title = 'Width ' + SIZES[i] + ' px';
        var line = el('span', 'paint-sizeline', b);
        line.style.height = SIZES[i] + 'px';
        (function (idx) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { sizeIdx = idx + 1; customW = 0; updateToolUI(); });
          b.addEventListener('dblclick', function (e) {
            e.preventDefault();
            askCustomWidth();
          });
        }(i));
        sizeBtns.push(b);
      }
    }());

    /* magnifier sub box */
    var zoomBtns = [];
    (function () {
      for (var i = 0; i < 4; i++) {
        var b = mkbtn(zoomBox, 'paint-subbtn paint-zbtn', ZOOMS[i] + 'x');
        (function (z) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { zoomLevel = z; updateToolUI(); });
        }(ZOOMS[i]));
        zoomBtns.push({ el: b, val: ZOOMS[i] });
      }
    }());

    /* fill style sub box */
    var fillBtns = [];
    (function () {
      var opts = [['outline', 0], ['both', 1], ['solid', 2]];
      for (var i = 0; i < opts.length; i++) {
        var b = mkbtn(fillBox, 'paint-subbtn', null);
        b.style.width = '26px'; b.style.height = '22px';
        b.title = ['Outline', 'Outline and fill', 'Fill only'][i];
        b.appendChild(optionIcon(opts[i][0]));
        (function (v) {
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { fillMode = v; updateToolUI(); });
        }(opts[i][1]));
        fillBtns.push({ el: b, val: opts[i][1] });
      }
    }());

    /* --------------------------------------------------- colour palette */

    var swatchEls = [];
    (function buildPalette() {
      for (var i = 0; i < palette.length; i++) {
        var s = el('div', 'paint-sw', palGrid);
        s.title = palette[i];
        (function (idx) {
          s.addEventListener('mousedown', function (e) { e.preventDefault(); });
          s.addEventListener('click', function () { setColor(palette[idx], false); });
          s.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation(); setColor(palette[idx], true);
          });
          s.addEventListener('dblclick', function (e) {
            e.preventDefault();
            openColorDialog(palette[idx], function (hex) {
              palette[idx] = hex; paintPalette(); savePalette();
            });
          });
        }(i));
        swatchEls.push(s);
      }
    }());

    function paintPalette() {
      for (var i = 0; i < swatchEls.length; i++) {
        swatchEls[i].style.background = palette[i] || '#000000';
        swatchEls[i].title = palette[i] || '';
      }
    }

    function paintCurrent() {
      fgSw.style.background = fg;
      bgSw.style.background = bg;
      fgSw.title = 'Foreground: ' + fg;
      bgSw.title = 'Background: ' + bg;
    }

    function setColor(hex, isBg) {
      if (!hex) { return; }
      if (isBg) { bg = hex; } else { fg = hex; }
      paintCurrent();
      if (textBox) { textBox.style.color = fg; }
    }

    fgSw.addEventListener('dblclick', function () { openColorDialog(fg, function (h) { setColor(h, false); }); });
    bgSw.addEventListener('dblclick', function () { openColorDialog(bg, function (h) { setColor(h, true); }); });

    /* ------------------------------------------------ text tool font bar */

    (function buildFontBar() {
      var fam = el('select', '', fontBar);
      var fams = ['MS Sans Serif', 'Tahoma', 'Arial', 'Times New Roman', 'Courier New',
                  'Comic Sans MS', 'Lucida Console', 'Wingdings'];
      for (var i = 0; i < fams.length; i++) {
        var o = el('option', '', fam);
        o.value = fams[i]; o.textContent = fams[i];
      }
      fam.value = font.family;
      fam.addEventListener('change', function () { font.family = fam.value; updateTextBoxFont(); });

      var sz = el('input', 'paint-fsize', fontBar);
      sz.value = String(font.size);
      sz.addEventListener('change', function () {
        var v = parseInt(sz.value, 10);
        if (!isNaN(v)) { font.size = clamp(v, 4, 200); }
        sz.value = String(font.size);
        updateTextBoxFont();
      });

      var bB = mkbtn(fontBar, '', 'B');
      bB.style.fontWeight = 'bold';
      var bI = mkbtn(fontBar, '', 'I');
      bI.style.fontStyle = 'italic';
      bB.addEventListener('click', function () { font.bold = !font.bold; updateFontButtons(); });
      bI.addEventListener('click', function () { font.italic = !font.italic; updateFontButtons(); });
      fontBar._bB = bB; fontBar._bI = bI;
    }());

    function updateFontButtons() {
      fontBar._bB.className = font.bold ? 'default' : '';
      fontBar._bI.className = font.italic ? 'default' : '';
      updateTextBoxFont();
    }

    function fontString() {
      return (font.italic ? 'italic ' : '') + (font.bold ? 'bold ' : '') + font.size + 'px "' + font.family + '"';
    }

    /* -------------------------------------------------------- the canvas */

    area.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    view_el.addEventListener('mousedown', function (e) {
      if (e.button !== 0 && e.button !== 2) { return; }
      e.preventDefault();
      onDown(e);
    });

    view_el.addEventListener('mousemove', function (e) {
      if (drag || (polyPts && polyPts.length)) { return; }
      handleMove(e);
    });

    view_el.addEventListener('mouseleave', function () {
      mouse.inside = false;
    });

    area.addEventListener('scroll', function () { positionTextBox(); });

    /* ------------------------------------------------------- doc helpers */

    function initDoc(w, h, fillHex) {
      docW = clamp(Math.round(w), 1, 4096);
      docH = clamp(Math.round(h), 1, 4096);
      doc = nc(docW, docH);
      dctx = c2(doc);
      dctx.fillStyle = fillHex || '#ffffff';
      dctx.fillRect(0, 0, docW, docH);
      sel = null; floatSel = null; drag = null; overlayClear();
      undoStack.length = 0; redoStack.length = 0;
      dirty = false;
      zoom = 1;
      view_el.width = docW; view_el.height = docH;
      vctx = c2(view_el);
      render();
      updateStatus();
      updateTitle();
      updateMenus();
    }

    function clearDoc() {
      pushUndo();
      dctx.fillStyle = bg;
      dctx.fillRect(0, 0, docW, docH);
      afterChange();
    }

    function overlayClear() {
      lassoPts = null; polyPts = null; curve = null;
    }

    function snapshot() {
      var c = nc(docW, docH);
      c2(c).drawImage(doc, 0, 0);
      return c;
    }

    function pushUndo() {
      try {
        if (undoStack.length >= UNDO_LIMIT) { undoStack.shift(); }
        undoStack.push(snapshot());
        redoStack.length = 0;
        dirty = true;
        updateMenus();
      } catch (e) { /* out of memory: drop history */ }
    }

    function restoreSnap(c) {
      docW = c.width; docH = c.height;
      doc = nc(docW, docH);
      dctx = c2(doc);
      dctx.drawImage(c, 0, 0);
      sel = null; floatSel = null; drag = null; overlayClear();
      if (zoom > 1 && (docW * zoom > 8192 || docH * zoom > 8192)) { zoom = 1; }
      if (textBox) { removeTextBox(); }
      render();
      updateStatus();
      updateTitle();
      updateMenus();
    }

    function undo() {
      try {
        if (!undoStack.length) { return; }
        var cur = snapshot();
        if (redoStack.length >= UNDO_LIMIT) { redoStack.shift(); }
        redoStack.push(cur);
        restoreSnap(undoStack.pop());
        dirty = true;
      } catch (e) { /* ignore */ }
    }

    function redo() {
      try {
        if (!redoStack.length) { return; }
        var cur = snapshot();
        if (undoStack.length >= UNDO_LIMIT) { undoStack.shift(); }
        undoStack.push(cur);
        restoreSnap(redoStack.pop());
        dirty = true;
      } catch (e) { /* ignore */ }
    }

    function afterChange() {
      dirty = true;
      render();
      updateMenus();
    }

    /* ---------------------------------------------------------- rendering */

    function render() {
      try {
        var w = Math.max(1, Math.round(docW * zoom));
        var h = Math.max(1, Math.round(docH * zoom));
        if (view_el.width !== w || view_el.height !== h) {
          view_el.width = w; view_el.height = h;
        }
        vctx = c2(view_el);
        vctx.fillStyle = '#ffffff';
        vctx.fillRect(0, 0, w, h);
        vctx.drawImage(doc, 0, 0, w, h);

        vctx.save();
        vctx.setTransform(zoom, 0, 0, zoom, 0, 0);
        vctx.imageSmoothingEnabled = false;
        if (drag) { drawDragPreview(vctx); }
        if (polyPts && polyPts.length) { drawPolyPreview(vctx); }
        if (curve) { drawCurvePreview(vctx); }
        if (lassoPts && lassoPts.length > 1) { drawLassoPreview(vctx); }
        vctx.restore();

        if (floatSel) {
          vctx.drawImage(floatSel.clip,
            floatSel.x * zoom, floatSel.y * zoom,
            floatSel.w * zoom, floatSel.h * zoom);
        }
        drawMarquee(vctx);
      } catch (e) { /* never let a frame kill the app */ }
    }

    function drawMarquee(g) {
      var box = null;
      if (drag && (drag.kind === 'marquee' || drag.kind === 'lasso') && drag.start && drag.cur) {
        box = {
          x: Math.min(drag.start.x, drag.cur.x), y: Math.min(drag.start.y, drag.cur.y),
          w: Math.abs(drag.cur.x - drag.start.x), h: Math.abs(drag.cur.y - drag.start.y)
        };
      } else if (floatSel) {
        box = { x: floatSel.x, y: floatSel.y, w: floatSel.w, h: floatSel.h };
      } else if (sel) {
        box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
      }
      if (!box || box.w < 1 || box.h < 1) { return; }
      var x0 = Math.round(box.x * zoom), y0 = Math.round(box.y * zoom);
      var x1 = Math.round((box.x + box.w) * zoom) - 1, y1 = Math.round((box.y + box.h) * zoom) - 1;
      if (x1 < x0 || y1 < y0) { return; }
      var k, phase;
      for (k = x0; k <= x1; k++) {
        phase = (k + y0) & 1;
        g.fillStyle = phase ? '#ffffff' : '#000000';
        g.fillRect(k, y0, 1, 1);
        phase = (k + y1) & 1;
        g.fillStyle = phase ? '#ffffff' : '#000000';
        g.fillRect(k, y1, 1, 1);
      }
      for (k = y0; k <= y1; k++) {
        phase = (x0 + k) & 1;
        g.fillStyle = phase ? '#ffffff' : '#000000';
        g.fillRect(x0, k, 1, 1);
        phase = (x1 + k) & 1;
        g.fillStyle = phase ? '#ffffff' : '#000000';
        g.fillRect(x1, k, 1, 1);
      }
    }

    function drawLassoPreview(g) {
      g.save();
      g.strokeStyle = '#000000';
      g.lineWidth = 1 / zoom;
      g.beginPath();
      g.moveTo(lassoPts[0][0] + 0.5, lassoPts[0][1] + 0.5);
      for (var i = 1; i < lassoPts.length; i++) { g.lineTo(lassoPts[i][0] + 0.5, lassoPts[i][1] + 0.5); }
      g.closePath();
      g.stroke();
      g.restore();
    }

    /* ------------------------------------------------------- status bar */

    function updateStatus() {
      var pos = (mouse.x) + ',' + (mouse.y);
      var s = [
        { text: HELP_TEXT, width: 250 },
        { text: pos, width: 76 },
        { text: docW + ' x ' + docH, width: 76 },
        { text: (capsOn ? 'CAP' : '   ') + ' ' + (numOn ? 'NUM' : '   ') }
      ];
      var key = s[1].text + '|' + s[2].text + '|' + s[3].text + '|' + s[0].text;
      if (key === lastStatus) { return; }
      lastStatus = key;
      try { win.setStatus(s); } catch (e) { /* ignore */ }
    }

    function hint(text) {
      try { win.setStatus([{ text: text, width: 250 }, { text: mouse.x + ',' + mouse.y, width: 76 },
        { text: docW + ' x ' + docH, width: 76 }, { text: (capsOn ? 'CAP' : '   ') + ' ' + (numOn ? 'NUM' : '   ') }]); } catch (e) { }
      lastStatus = '';
    }

    function updateTitle() {
      try {
        win.setTitle((docName || 'untitled') + ' - Paint');
        if (docPath) { win.saveTo(docPath); } else { win.saveTo(''); }
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------- tool state */

    function setTool(id) {
      if (id === tool) { return; }
      if (floatSel) { commitFloat(); }
      if (textBox) { commitText(); }
      if (curve) { commitCurve(); }
      if (polyPts) { closePolygon(); }
      sel = null;
      overlayClear();
      drag = null;
      tool = id;
      var t = toolById(id);
      if (t.kind !== 'paint' && t.kind !== 'click') { stopAir(); }
      updateToolUI();
      render();
    }

    function updateToolUI() {
      for (var k in toolEls) {
        if (toolEls.hasOwnProperty(k)) {
          toolEls[k].className = 'paint-tool' + (k === tool ? ' lit' : '');
        }
      }
      var t = toolById(tool);
      selBox.className = 'paint-sub' + ((t.id === 'select' || t.id === 'freeform' || t.id === 'text') ? '' : ' off');
      sizeBox.style.display = (t.id === 'magnify') ? 'none' : 'flex';
      zoomBox.className = 'paint-sub' + (t.id === 'magnify' ? '' : ' off');
      fillBox.className = 'paint-sub' +
        ((t.id === 'rect' || t.id === 'polygon' || t.id === 'ellipse' || t.id === 'rrect') ? '' : ' off');
      for (var i = 0; i < selBtns.length; i++) {
        selBtns[i].el.className = 'paint-subbtn' + (selBtns[i].val === selOpaque ? ' lit' : '');
      }
      for (i = 0; i < sizeBtns.length; i++) {
        sizeBtns[i].className = 'paint-sizebtn' + ((i + 1 === sizeIdx && !customW) ? ' lit' : '');
      }
      for (i = 0; i < zoomBtns.length; i++) {
        zoomBtns[i].el.className = 'paint-subbtn paint-zbtn' + (zoomBtns[i].val === zoomLevel ? ' lit' : '');
      }
      for (i = 0; i < fillBtns.length; i++) {
        fillBtns[i].el.className = 'paint-subbtn' + (fillBtns[i].val === fillMode ? ' lit' : '');
      }
      fontBar.className = 'paint-fontbar' + ((t.id === 'text' && showTextbar) ? ' on' : '');
      view_el.style.cursor = (t.id === 'text') ? 'text'
        : (t.id === 'pick' ? 'crosshair'
        : (t.id === 'select' || t.id === 'freeform' ? 'crosshair' : 'crosshair'));
      updateStatus();
    }

    function curWidth() { return customW > 0 ? customW : SIZES[clamp(sizeIdx - 1, 0, 4)]; }
    function eraserWidth() { return customW > 0 ? customW : ERASER_SIZES[clamp(sizeIdx - 1, 0, 4)]; }
    function airRadius() { return customW > 0 ? Math.max(3, customW) : AIR_RADII[clamp(sizeIdx - 1, 0, 4)]; }

    function askCustomWidth() {
      W98.dialog.prompt('Paint', 'Custom line width (1-100):', String(curWidth())).then(function (v) {
        if (v == null) { return; }
        var n = parseInt(v, 10);
        if (isNaN(n) || n < 1) { return; }
        customW = clamp(n, 1, 100);
        updateToolUI();
      }).catch(function () { });
    }

    /* ------------------------------------------------------ mouse plumbing */

    function docPoint(e) {
      var r = view_el.getBoundingClientRect();
      return {
        x: Math.floor((e.clientX - r.left) / zoom),
        y: Math.floor((e.clientY - r.top) / zoom)
      };
    }

    function inBox(p, b) {
      return p.x >= b.x && p.y >= b.y && p.x < b.x + b.w && p.y < b.y + b.h;
    }

    function addDocListeners() {
      if (docMoves.length) { return; }
      var mv = function (e) { handleMove(e); };
      var up = function (e) { handleUp(e); };
      docMoves.push(mv); docUps.push(up);
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    }

    function removeDocListeners() {
      var i;
      for (i = 0; i < docMoves.length; i++) { document.removeEventListener('mousemove', docMoves[i], true); }
      for (i = 0; i < docUps.length; i++) { document.removeEventListener('mouseup', docUps[i], true); }
      docMoves.length = 0; docUps.length = 0;
    }

    function onDown(e) {
      try {
        var right = (e.button === 2);
        var p = docPoint(e);
        mouse.x = p.x; mouse.y = p.y; mouse.inside = true;

        if (tool !== 'curve' && curve) { commitCurve(); }
        if (tool !== 'polygon' && polyPts) { closePolygon(); }

        var t = toolById(tool);
        if (t.kind === 'sel') { selDown(p, right); }
        else if (t.id === 'fill') { doFill(p, right); }
        else if (t.id === 'pick') { doPick(p, right); }
        else if (t.id === 'magnify') { doMagnify(p, right); }
        else if (t.id === 'text') { textDown(p, right); }
        else if (t.kind === 'paint') { paintDown(p, right); }
        else if (t.kind === 'shape') {
          if (t.id === 'curve') { curveDown(p, right); }
          else if (t.id === 'polygon') { polyDown(p, right); }
          else { shapeDown(p, right); }
        }
        updateStatus();
      } catch (err) { /* never throw from an event handler */ }
    }

    function handleMove(e) {
      try {
        var p = docPoint(e);
        mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
        if (drag) {
          drag.shift = !!e.shiftKey;
          dragMove(p, e);
        } else if (polyPts && polyPts.length) {
          polyCur = p;
          render();
        }
        updateStatus();
      } catch (err) { /* ignore */ }
    }

    function handleUp(e) {
      try {
        var p = docPoint(e);
        mouse.x = p.x; mouse.y = p.y;
        finishDrag(p, e);
        updateStatus();
      } catch (err) { /* ignore */ }
    }

    /* ------------------------------------------------------------ tools */

    function drawCol(right) { return right ? bg : fg; }

    function shapeColors(right) {
      var c = right ? bg : fg;
      var f = right ? fg : bg;
      return {
        col: (fillMode === 2) ? null : c,
        fill: (fillMode === 0) ? null : f
      };
    }

    function dropDocState() {
      if (floatSel) { commitFloat(); }
      if (sel) { sel = null; }
    }

    /* ---- freehand: pencil / brush / eraser / airbrush ---- */

    function paintDown(p, right) {
      dropDocState();
      var col = (tool === 'eraser') ? bg : drawCol(right);
      var w = 1;
      if (tool === 'brush') { w = curWidth(); }
      else if (tool === 'eraser') { w = eraserWidth(); }
      pushUndo();
      drag = { kind: 'paint', right: right, last: p, cur: p, col: col, w: w };
      if (tool === 'airbrush') {
        spray(p, col);
        startAir(col);
      } else if (tool === 'eraser' && right) {
        eraseArea(p, col);
      } else {
        paintDot(p, col, w);
      }
      addDocListeners();
      render();
    }

    function paintDot(p, col, w) {
      dctx.fillStyle = col;
      if (w <= 1) { dctx.fillRect(p.x, p.y, 1, 1); }
      else {
        var h = Math.floor(w / 2);
        dctx.fillRect(p.x - h, p.y - h, w, w);
      }
    }

    function paintSeg(a, b, col, w) {
      if (w <= 1) { bres(dctx, a.x, a.y, b.x, b.y, col); }
      else { thickLine(dctx, a.x, a.y, b.x, b.y, w, col); }
    }

    function eraseArea(p, col) {
      var w = eraserWidth();
      var h = Math.floor(w / 2);
      var img = dctx.getImageData(p.x - h, p.y - h, w, w);
      var u32 = new Uint32Array(img.data.buffer);
      var from = packHex(fg), to = packHex(bg);
      var n = 0;
      for (var i = 0; i < u32.length; i++) {
        if (u32[i] === from) { u32[i] = to; n++; }
      }
      if (n) { dctx.putImageData(img, p.x - h, p.y - h); }
    }

    function eraseSeg(a, b) {
      var steps = Math.max(1, Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)));
      for (var i = 0; i <= steps; i++) {
        eraseArea({
          x: Math.round(a.x + (b.x - a.x) * i / steps),
          y: Math.round(a.y + (b.y - a.y) * i / steps)
        });
      }
    }

    function spray(p, col) {
      var r = airRadius();
      dctx.fillStyle = col;
      var n = 12;
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var d = Math.sqrt(Math.random()) * r;
        dctx.fillRect(Math.round(p.x + Math.cos(a) * d), Math.round(p.y + Math.sin(a) * d), 1, 1);
      }
    }

    function startAir(col) {
      stopAir();
      airTimer = win.setInterval(function () {
        try {
          if (!drag || drag.kind !== 'paint' || tool !== 'airbrush') { stopAir(); return; }
          spray(drag.cur || drag.last, col);
          render();
        } catch (e) { stopAir(); }
      }, 40);
      timers.push(airTimer);
    }

    function stopAir() {
      if (airTimer) {
        try { win.clearInterval(airTimer); } catch (e) { /* ignore */ }
        airTimer = 0;
      }
    }

    /* ---- click tools ---- */

    function doFill(p, right) {
      var col = drawCol(right);
      if (p.x < 0 || p.y < 0 || p.x >= docW || p.y >= docH) { return; }
      var cur = getPixelHex(doc, p.x, p.y);
      if (cur === null || cur === col) { return; }
      dropDocState();
      pushUndo();
      if (!floodFillCanvas(doc, p.x, p.y, col)) { undoStack.pop(); return; }
      afterChange();
    }

    function doPick(p, right) {
      if (p.x < 0 || p.y < 0 || p.x >= docW || p.y >= docH) { return; }
      var c = getPixelHex(doc, p.x, p.y);
      if (c) { setColor(c, right); }
    }

    function doMagnify(p, right) {
      if (right) { setZoom(1); }
      else { setZoom(zoomLevel); }
    }

    function setZoom(z) {
      z = clamp(z, 1, 8);
      zoom = z;
      if (zoom > 1 && (docW * zoom > 8192 || docH * zoom > 8192)) { zoom = 1; }
      updateToolUI();
      render();
      updateStatus();
    }

    /* ---- shape tools (line / rect / ellipse / rrect) ---- */

    function shapeDown(p, right) {
      dropDocState();
      drag = { kind: 'shape', right: right, start: p, cur: p, shift: false };
      addDocListeners();
      render();
    }

    function shapeEnd(d, shift) {
      var s = d.start, c = d.cur;
      if (shift) {
        if (tool === 'line') { return snap45(s.x, s.y, c.x, c.y); }
        return snapSquare(s.x, s.y, c.x, c.y);
      }
      return { x: c.x, y: c.y };
    }

    function drawShapeInto(g, start, end, right, polyClose) {
      var sc = shapeColors(right);
      var w = curWidth();
      switch (tool) {
        case 'line': thickLine(g, start.x, start.y, end.x, end.y, w, sc.col || fg); break;
        case 'rect': drawRectShape(g, start.x, start.y, end.x, end.y, w, sc.col, sc.fill); break;
        case 'ellipse': drawEllipseShape(g, start.x, start.y, end.x, end.y, w, sc.col, sc.fill); break;
        case 'rrect': drawRoundRectShape(g, start.x, start.y, end.x, end.y, w, sc.col, sc.fill); break;
        case 'polygon': drawPolyShape(g, polyClose || [], w, sc.col, sc.fill, true); break;
      }
    }

    function finishShape(d, p, e) {
      if (!d) { return; }
      var end = shapeEnd(d, !!e.shiftKey);
      if (Math.abs(end.x - d.start.x) < 1 && Math.abs(end.y - d.start.y) < 1) { return; }
      pushUndo();
      drawShapeInto(dctx, d.start, end, d.right, null);
      afterChange();
    }

    function drawDragPreview(g) {
      if (drag.kind !== 'shape') { return; }
      var end = shapeEnd(drag, drag.shift);
      g.save();
      drawShapeInto(g, drag.start, end, drag.right, null);
      g.restore();
    }

    /* ---- polygon ---- */

    var polyRight = false;
    var polyCur = { x: 0, y: 0 };

    function polyDown(p, right) {
      if (!polyPts || !polyPts.length) {
        dropDocState();
        polyPts = [[p.x, p.y]];
        polyCur = p;
        polyRight = right;
        addDocListeners();
        render();
        return;
      }
      var first = polyPts[0];
      if (polyPts.length > 1 && Math.abs(p.x - first[0]) <= 1 && Math.abs(p.y - first[1]) <= 1) {
        closePolygon();
        return;
      }
      polyPts.push([p.x, p.y]);
      polyCur = p;
      render();
    }

    function drawPolyPreview(g) {
      var pts = polyPts.slice(0);
      pts.push([polyCur.x, polyCur.y]);
      var sc = shapeColors(polyRight);
      g.save();
      if (polyCur.x !== pts[0][0] || polyCur.y !== pts[0][1]) {
        pts.push([polyPts[0][0], polyPts[0][1]]);
      }
      drawPolyShape(g, pts, curWidth(), sc.col || (polyRight ? bg : fg), sc.fill, true);
      g.restore();
    }

    function closePolygon() {
      if (!polyPts || polyPts.length < 2) {
        polyPts = null; removeDocListeners(); render(); return;
      }
      pushUndo();
      var sc = shapeColors(polyRight);
      drawPolyShape(dctx, polyPts, curWidth(), sc.col || (polyRight ? bg : fg), sc.fill, true);
      polyPts = null;
      removeDocListeners();
      afterChange();
    }

    /* ---- curve ---- */

    function curveDown(p, right) {
      if (!curve) {
        dropDocState();
        curve = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, c1x: null, c1y: null, c2x: null, c2y: null, right: right, bends: 0 };
        drag = { kind: 'curve', phase: 0, right: right, start: p };
        addDocListeners();
      } else if (curve.bends === 0) {
        curve.c1x = p.x; curve.c1y = p.y;
        drag = { kind: 'curve', phase: 1, right: curve.right, start: p };
      } else {
        curve.c2x = p.x; curve.c2y = p.y;
        drag = { kind: 'curve', phase: 2, right: curve.right, start: p };
      }
      render();
    }

    function drawCurvePreview(g) {
      if (!curve) { return; }
      g.save();
      drawCurveShape(g, curve, curWidth(), curve.right ? bg : fg);
      g.restore();
    }

    function commitCurve() {
      if (!curve) { return; }
      if (Math.abs(curve.x1 - curve.x0) < 1 && Math.abs(curve.y1 - curve.y0) < 1) {
        curve = null; removeDocListeners(); render(); return;
      }
      pushUndo();
      drawCurveShape(dctx, curve, curWidth(), curve.right ? bg : fg);
      curve = null;
      removeDocListeners();
      afterChange();
    }

    /* ---- selection ---- */

    function extractClip(x, y, w, h, mask) {
      var c = nc(w, h), g = c2(c);
      g.drawImage(doc, x, y, w, h, 0, 0, w, h);
      if (mask) {
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(mask, 0, 0);
        g.globalCompositeOperation = 'source-over';
      }
      return c;
    }

    function punchHole(x, y, w, h, mask, color) {
      var c = nc(w, h), g = c2(c);
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      if (mask) {
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(mask, 0, 0);
        g.globalCompositeOperation = 'source-over';
      }
      dctx.drawImage(c, x, y);
    }

    function blitClip(x, y, clip, opaque, fillHex) {
      if (opaque) {
        dctx.fillStyle = fillHex || '#ffffff';
        dctx.fillRect(x, y, clip.width, clip.height);
      }
      dctx.drawImage(clip, x, y);
    }

    function selDown(p, right) {
      if (floatSel) {
        if (inBox(p, floatSel)) { startFloatDrag(p, right); return; }
        commitFloat();
      }
      if (sel && inBox(p, sel)) { liftSel(p, right); return; }
      sel = null;
      if (tool === 'freeform') {
        lassoPts = [[p.x, p.y]];
        drag = { kind: 'lasso', right: right, start: p, cur: p };
      } else {
        drag = { kind: 'marquee', right: right, start: p, cur: p };
      }
      addDocListeners();
      render();
    }

    function liftSel(p, right) {
      pushUndo();
      if (!right) { punchHole(sel.x, sel.y, sel.w, sel.h, sel.mask, bg); }
      floatSel = { x: sel.x, y: sel.y, w: sel.w, h: sel.h, clip: sel.clip, opaque: selOpaque, pushed: true };
      sel = null;
      startFloatDrag(p, right);
      render();
    }

    function startFloatDrag(p, right) {
      drag = { kind: 'floatmove', right: right, ox: p.x - floatSel.x, oy: p.y - floatSel.y, start: p };
      addDocListeners();
    }

    function commitFloat() {
      if (!floatSel) { return; }
      try {
        if (!floatSel.pushed) { pushUndo(); }
        blitClip(floatSel.x, floatSel.y, floatSel.clip, floatSel.opaque, bg);
        floatSel = null;
        sel = null;
        afterChange();
      } catch (e) { floatSel = null; }
    }

    function buildMask(pts, x0, y0, w, h) {
      var c = nc(w, h), g = c2(c);
      g.fillStyle = '#000';
      g.beginPath();
      g.moveTo(pts[0][0] - x0 + 0.5, pts[0][1] - y0 + 0.5);
      for (var i = 1; i < pts.length; i++) { g.lineTo(pts[i][0] - x0 + 0.5, pts[i][1] - y0 + 0.5); }
      g.closePath();
      g.fill();
      return c;
    }

    function finishSelection(d) {
      if (!d) { return; }
      var x0 = Math.min(d.start.x, d.cur.x), x1 = Math.max(d.start.x, d.cur.x);
      var y0 = Math.min(d.start.y, d.cur.y), y1 = Math.max(d.start.y, d.cur.y);
      var pts = (d.kind === 'lasso') ? lassoPts : null;
      if (pts && pts.length > 2) {
        x0 = x1 = pts[0][0]; y0 = y1 = pts[0][1];
        for (var i = 1; i < pts.length; i++) {
          x0 = Math.min(x0, pts[i][0]); x1 = Math.max(x1, pts[i][0]);
          y0 = Math.min(y0, pts[i][1]); y1 = Math.max(y1, pts[i][1]);
        }
      }
      x0 = clamp(x0, 0, docW - 1); y0 = clamp(y0, 0, docH - 1);
      x1 = clamp(x1, 0, docW - 1); y1 = clamp(y1, 0, docH - 1);
      var w = x1 - x0 + 1, h = y1 - y0 + 1;
      lassoPts = null;
      if (w < 2 || h < 2) { sel = null; return; }
      var mask = null;
      if (pts && pts.length > 2) { mask = buildMask(pts, x0, y0, w, h); }
      sel = { x: x0, y: y0, w: w, h: h, mask: mask, clip: extractClip(x0, y0, w, h, mask) };
    }

    function selectAll() {
      if (floatSel) { commitFloat(); }
      sel = { x: 0, y: 0, w: docW, h: docH, mask: null, clip: extractClip(0, 0, docW, docH, null) };
      render();
    }

    function clearSelection() {
      try {
        if (floatSel) { floatSel = null; sel = null; render(); return; }
        if (!sel) { return; }
        pushUndo();
        punchHole(sel.x, sel.y, sel.w, sel.h, sel.mask, bg);
        sel = null;
        afterChange();
      } catch (e) { /* ignore */ }
    }

    function currentClip() {
      if (floatSel) { return floatSel.clip; }
      if (sel) { return sel.clip; }
      return extractClip(0, 0, docW, docH, null);
    }

    function copySel() {
      try {
        var c = currentClip();
        clipboard = copyCanvas(c);
        lastClipInfo = { w: clipboard.width, h: clipboard.height };
        try { W98.fs.writeBytes(TMP_BMP, encodeBMP(clipboard)); } catch (e) { /* ignore */ }
        toSystemClipboard(clipboard);
        updateMenus();
      } catch (e) { /* ignore */ }
    }

    function cutSel() {
      if (!sel && !floatSel) { return; }
      copySel();
      clearSelection();
      updateMenus();
    }

    var lastClipInfo = null;

    function pasteClipboard() {
      try {
        if (clipboard) { makePasteFloat(copyCanvas(clipboard)); return; }
        var bytes = null;
        try { bytes = W98.fs.readBytes(TMP_BMP); } catch (e) { bytes = null; }
        var cnv = bytes ? decodeBMP(bytes) : null;
        if (cnv) { makePasteFloat(cnv); return; }
        var done = false;
        try {
          if (navigator.clipboard && navigator.clipboard.read) {
            navigator.clipboard.read().then(function (items) {
              for (var i = 0; i < items.length; i++) {
                if (items[i].types.indexOf('image/png') >= 0) {
                  items[i].getType('image/png').then(function (blob) {
                    var img = new Image();
                    var url = URL.createObjectURL(blob);
                    img.onload = function () {
                      var c = nc(img.width, img.height);
                      c2(c).drawImage(img, 0, 0);
                      URL.revokeObjectURL(url);
                      makePasteFloat(c);
                    };
                    img.onerror = function () { URL.revokeObjectURL(url); };
                    img.src = url;
                  }).catch(function () { });
                  return;
                }
              }
            }).catch(function () { });
          }
        } catch (e2) { /* ignore */ }
        W98.dialog.alert('Paint', 'There is no image on the clipboard.', 'info');
      } catch (e) { /* ignore */ }
    }

    function makePasteFloat(cnv) {
      if (!cnv) { return; }
      if (floatSel) { commitFloat(); }
      if (sel) { sel = null; }
      floatSel = {
        x: 0, y: 0, w: cnv.width, h: cnv.height,
        clip: cnv, opaque: selOpaque, pushed: false
      };
      render();
      updateMenus();
    }

    function toSystemClipboard(canvas) {
      try {
        if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') { return; }
        canvas.toBlob(function (blob) {
          if (!blob) { return; }
          try {
            navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])['catch'](function () { });
          } catch (e) { /* ignore */ }
        }, 'image/png');
      } catch (e) { /* ignore */ }
    }

    /* ---- text tool ---- */

    var textBoxDoc = { x: 0, y: 0 };

    function textDown(p, right) {
      if (textBox) { commitText(); return; }
      if (Date.now() - lastTextCommitAt < 250) { return; }
      dropDocState();
      var ta = document.createElement('textarea');
      ta.className = 'paint-textbox';
      ta.spellcheck = false;
      ta.rows = 1;
      ta.style.color = fg;
      ta.style.width = '120px';
      ta.style.height = (Math.round(font.size * 1.4) + 4) + 'px';
      ta.style.font = fontString();
      ta.value = '';
      textBox = ta;
      textBoxDoc = { x: p.x, y: p.y };
      area.appendChild(ta);
      positionTextBox();
      ta.addEventListener('input', sizeTextBox);
      ta.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Escape') { commitText(); }
      });
      ta.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      ta.addEventListener('blur', function () { commitText(); });
      try { ta.focus(); } catch (e) { /* ignore */ }
      updateStatus();
    }

    function positionTextBox() {
      if (!textBox) { return; }
      textBox.style.left = (view_el.offsetLeft + textBoxDoc.x * zoom) + 'px';
      textBox.style.top = (view_el.offsetTop + textBoxDoc.y * zoom) + 'px';
    }

    function updateTextBoxFont() {
      if (!textBox) { return; }
      textBox.style.font = fontString();
      textBox.style.color = fg;
      sizeTextBox();
    }

    function sizeTextBox() {
      if (!textBox) { return; }
      try {
        var m = measureCtx;
        if (!m) { m = measureCtx = c2(nc(8, 8)); }
        m.font = fontString();
        var lines = String(textBox.value || '').split('\n');
        var w = 40;
        for (var i = 0; i < lines.length; i++) {
          w = Math.max(w, m.measureText(lines[i]).width);
        }
        textBox.style.width = Math.ceil(w + 8) + 'px';
        textBox.style.height = (lines.length * Math.round(font.size * 1.2) + 4) + 'px';
      } catch (e) { /* ignore */ }
    }

    var measureCtx = null;

    function removeTextBox() {
      if (!textBox) { return; }
      try {
        if (textBox.parentNode) { textBox.parentNode.removeChild(textBox); }
      } catch (e) { /* ignore */ }
      textBox = null;
    }

    function commitText() {
      if (!textBox) { return; }
      var txt = String(textBox.value || '');
      var pos = textBoxDoc;
      var fs = fontString();
      var color = fg;
      var lh = Math.round(font.size * 1.2);
      removeTextBox();
      lastTextCommitAt = Date.now();
      if (!txt) { render(); return; }
      try {
        pushUndo();
        dctx.save();
        dctx.font = fs;
        dctx.fillStyle = color;
        dctx.textBaseline = 'top';
        var lines = txt.split('\n');
        for (var i = 0; i < lines.length; i++) {
          dctx.fillText(lines[i], pos.x, pos.y + i * lh);
        }
        dctx.restore();
        afterChange();
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------- drag finish */

    function dragMove(p, e) {
      var d = drag;
      if (!d) { return; }
      if (d.kind === 'paint') {
        if (tool === 'airbrush') {
          spray(p, d.col);
          d.cur = p; d.last = p;
        } else if (tool === 'eraser' && d.right) {
          eraseSeg(d.last, p);
          d.last = p;
        } else {
          paintSeg(d.last, p, d.col, d.w);
          d.last = p;
        }
        d.cur = p;
        render();
      } else if (d.kind === 'shape') {
        d.cur = p;
        render();
      } else if (d.kind === 'marquee' || d.kind === 'lasso') {
        d.cur = p;
        if (d.kind === 'lasso') {
          if (!lassoPts) { lassoPts = []; }
          var last = lassoPts[lassoPts.length - 1];
          if (!last || Math.abs(last[0] - p.x) + Math.abs(last[1] - p.y) >= 1) {
            lassoPts.push([p.x, p.y]);
          }
          if (lassoPts.length > 2000) { lassoPts.shift(); }
        }
        render();
      } else if (d.kind === 'floatmove') {
        floatSel.x = p.x - d.ox;
        floatSel.y = p.y - d.oy;
        render();
      } else if (d.kind === 'curve') {
        if (d.phase === 0) {
          var end = e && e.shiftKey ? snap45(curve.x0, curve.y0, p.x, p.y) : p;
          curve.x1 = end.x; curve.y1 = end.y;
        } else if (d.phase === 1) {
          curve.c1x = p.x; curve.c1y = p.y;
        } else {
          curve.c2x = p.x; curve.c2y = p.y;
        }
        render();
      }
    }

    function finishDrag(p, e) {
      var d = drag;
      if (!d) { return; }
      drag = null;
      if (d.kind === 'paint') {
        stopAir();
      } else if (d.kind === 'shape') {
        finishShape(d, p, e);
      } else if (d.kind === 'marquee' || d.kind === 'lasso') {
        finishSelection(d);
      } else if (d.kind === 'curve') {
        if (d.phase === 0) {
          if (Math.abs(curve.x1 - curve.x0) < 1 && Math.abs(curve.y1 - curve.y0) < 1) {
            curve = null;
            removeDocListeners();
          }
        } else if (d.phase === 1) {
          curve.bends = 1;
        } else {
          commitCurve();
        }
      }
      removeDocListeners();
      render();
      updateMenus();
    }

    /* ------------------------------------------------------------ resize */

    function onWinResize() {
      try {
        render();
        repositionDialogs();
        updateStatus();
      } catch (e) { /* ignore */ }
    }

    /* ----------------------------------------------------------- keyboard */

    function updateLocks(e) {
      try {
        if (!e || !e.getModifierState) { return; }
        var c = !!e.getModifierState('CapsLock');
        var n = !!e.getModifierState('NumLock');
        if (c !== capsOn || n !== numOn) {
          capsOn = c; numOn = n;
          updateStatus();
        }
      } catch (err) { /* ignore */ }
    }

    function onKeyDown(e) {
      try {
        updateLocks(e);
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) { return; }
        var k = e.key || '';
        var lk = k.toLowerCase();
        var ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.shiftKey && lk === 'n') { e.preventDefault(); clearImage(); return; }
        if (ctrl) {
          switch (lk) {
            case 'z': e.preventDefault(); undo(); return;
            case 'y': e.preventDefault(); redo(); return;
            case 'x': e.preventDefault(); cutSel(); return;
            case 'c': e.preventDefault(); copySel(); return;
            case 'v': e.preventDefault(); pasteClipboard(); return;
            case 'a': e.preventDefault(); selectAll(); return;
            case 'n': e.preventDefault(); newImage(); return;
            case 'o': e.preventDefault(); openFile(); return;
            case 's': e.preventDefault(); saveFile(); return;
            case 'r': e.preventDefault(); flipDialog(); return;
            case 'w': e.preventDefault(); stretchDialog(); return;
            case 'i': e.preventDefault(); invertColors(); return;
            case 'e': e.preventDefault(); attributesDialog(); return;
            case 'f': e.preventDefault(); viewBitmap(); return;
            default: break;
          }
          return;
        }
        if (lk === 'delete' || lk === 'backspace') {
          if (sel || floatSel) { e.preventDefault(); clearSelection(); }
          return;
        }
        if (lk === 'escape') {
          if (floatSel) { commitFloat(); }
          sel = null;
          if (curve) { commitCurve(); }
          if (polyPts) { closePolygon(); }
          render();
          return;
        }
        if (floatSel && (lk === 'arrowleft' || lk === 'arrowright' || lk === 'arrowup' || lk === 'arrowdown')) {
          e.preventDefault();
          var step = e.shiftKey ? 10 : 1;
          if (lk === 'arrowleft') { floatSel.x -= step; }
          if (lk === 'arrowright') { floatSel.x += step; }
          if (lk === 'arrowup') { floatSel.y -= step; }
          if (lk === 'arrowdown') { floatSel.y += step; }
          render();
        }
      } catch (err) { /* ignore */ }
    }

    function onKeyUp(e) {
      updateLocks(e);
    }

    /* ------------------------------------------------------------- dialogs */

    function openDialog(opts) {
      var modal = el('div', 'paint-modal', root);
      var dlg = el('div', 'paint-dlg', modal);
      dlg.style.width = (opts.width || 300) + 'px';
      var inn = el('div', 'paint-dlg-in', dlg);
      var tb = el('div', 'paint-dlg-title', inn);
      var tt = el('span', '', tb);
      tt.textContent = opts.title || 'Paint';
      var xb = mkbtn(tb, 'paint-dlg-x', 'x');
      var bodyEl = el('div', 'paint-dlg-body', inn);
      var btnRow = el('div', 'paint-dlg-btns', inn);
      var rec = { el: modal, dlg: dlg };
      dialogs.push(rec);

      function close() {
        try {
          if (modal.parentNode) { modal.parentNode.removeChild(modal); }
          var i = dialogs.indexOf(rec);
          if (i >= 0) { dialogs.splice(i, 1); }
        } catch (e) { /* ignore */ }
      }

      var api = { close: close, body: bodyEl, root: root, dlg: dlg };
      xb.addEventListener('click', function () { close(); });

      var btns = opts.buttons || [{ label: 'OK', def: true, action: close }];
      for (var i = 0; i < btns.length; i++) {
        (function (b) {
          var elb = mkbtn(btnRow, b.def ? 'default' : '', b.label);
          elb.addEventListener('click', function () {
            try {
              if (b.action && b.action(api) === false) { return; }
            } catch (e) { /* ignore */ }
            close();
          });
          if (b.def) { elb.setAttribute('data-default', '1'); }
        }(btns[i]));
      }

      try { if (opts.build) { opts.build(bodyEl, api); } } catch (e) { /* ignore */ }

      /* centre inside the client area */
      var bw = dlg.offsetWidth || opts.width || 300;
      var bh = dlg.offsetHeight || 200;
      dlg.style.left = Math.max(2, Math.round((root.clientWidth - bw) / 2)) + 'px';
      dlg.style.top = Math.max(2, Math.round((root.clientHeight - bh) / 3)) + 'px';

      /* drag by title bar */
      (function () {
        var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        tb.addEventListener('mousedown', function (e) {
          if (e.target === xb) { return; }
          dragging = true;
          sx = e.clientX; sy = e.clientY;
          ox = parseInt(dlg.style.left, 10) || 0;
          oy = parseInt(dlg.style.top, 10) || 0;
          e.preventDefault();
        });
        var mv = function (e) {
          if (!dragging) { return; }
          dlg.style.left = (ox + e.clientX - sx) + 'px';
          dlg.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
        };
        var up = function () { dragging = false; };
        document.addEventListener('mousemove', mv, true);
        document.addEventListener('mouseup', up, true);
        rec.cleanup = function () {
          document.removeEventListener('mousemove', mv, true);
          document.removeEventListener('mouseup', up, true);
        };
      }());

      modal.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { close(); }
      });
      modal.setAttribute('tabindex', '-1');
      try {
        var first = bodyEl.querySelector('input,select,button');
        if (first) { first.focus(); } else { modal.focus(); }
      } catch (e) { /* ignore */ }

      return api;
    }

    function repositionDialogs() {
      for (var i = 0; i < dialogs.length; i++) {
        try {
          var d = dialogs[i].dlg;
          var bw = d.offsetWidth, bh = d.offsetHeight;
          d.style.left = Math.max(2, Math.round((root.clientWidth - bw) / 2)) + 'px';
          d.style.top = Math.max(2, Math.round((root.clientHeight - bh) / 3)) + 'px';
        } catch (e) { /* ignore */ }
      }
    }

    function closeAllDialogs() { /* dialogs are torn down by cleanup() */ }

    function radioRow(parent, name, label, value, checked) {
      var lab = el('label', 'paint-row', parent);
      var inp = el('input', '', lab);
      inp.type = 'radio';
      inp.name = name;
      inp.value = value;
      inp.checked = !!checked;
      var sp = el('span', '', lab);
      sp.textContent = label;
      return inp;
    }

    /* ---- Flip and Rotate ---- */

    function flipDialog() {
      openDialog({
        title: 'Flip and Rotate', width: 300,
        build: function (b) {
          var g = el('div', 'paint-group', b);
          radioRow(g, 'fr-flip', 'Flip horizontal', 'h', true);
          radioRow(g, 'fr-flip', 'Flip vertical', 'v', false);
          radioRow(g, 'fr-flip', 'Rotate by angle', 'r', false);
          var sub = el('div', 'paint-group', b);
          sub.style.marginTop = '8px';
          sub.style.marginLeft = '16px';
          radioRow(sub, 'fr-ang', '90\u00b0', '90', true);
          radioRow(sub, 'fr-ang', '180\u00b0', '180', false);
          radioRow(sub, 'fr-ang', '270\u00b0', '270', false);
        },
        buttons: [
          { label: 'OK', def: true, action: function (api) {
            var flip = 'h';
            var r = api.body.querySelectorAll('input[name=fr-flip]');
            for (var i = 0; i < r.length; i++) { if (r[i].checked) { flip = r[i].value; } }
            var ang = 90;
            var a = api.body.querySelectorAll('input[name=fr-ang]');
            for (i = 0; i < a.length; i++) { if (a[i].checked) { ang = parseInt(a[i].value, 10); } }
            doFlipRotate(flip, ang);
          } },
          { label: 'Cancel' }
        ]
      });
    }

    function doFlipRotate(flip, ang) {
      try {
        pushUndo();
        var nw = docW, nh = docH;
        if (flip === 'r') {
          nw = (ang === 90 || ang === 270) ? docH : docW;
          nh = (ang === 90 || ang === 270) ? docW : docH;
        }
        var c = nc(nw, nh), g = c2(c);
        g.fillStyle = bg;
        g.fillRect(0, 0, nw, nh);
        g.save();
        if (flip === 'h') {
          g.translate(nw, 0); g.scale(-1, 1);
          g.drawImage(doc, 0, 0);
        } else if (flip === 'v') {
          g.translate(0, nh); g.scale(1, -1);
          g.drawImage(doc, 0, 0);
        } else {
          g.translate(nw / 2, nh / 2);
          g.rotate(ang * Math.PI / 180);
          g.drawImage(doc, -docW / 2, -docH / 2);
        }
        g.restore();
        sel = null; floatSel = null;
        docW = nw; docH = nh; doc = c; dctx = c2(doc);
        dctx.drawImage(c, 0, 0);
        if (zoom > 1 && (docW * zoom > 8192 || docH * zoom > 8192)) { zoom = 1; }
        afterChange();
        updateStatus();
      } catch (e) { /* ignore */ }
    }

    /* ---- Stretch and Skew ---- */

    function stretchDialog() {
      openDialog({
        title: 'Stretch and Skew', width: 300,
        build: function (b) {
          var g = el('div', 'paint-group', b);
          var t = el('div', '', g);
          t.textContent = 'Stretch';
          t.style.fontWeight = 'bold';
          var r1 = el('div', 'paint-row', g);
          var s1 = el('span', '', r1); s1.textContent = 'Horizontal:';
          var i1 = el('input', 'paint-num', r1); i1.type = 'text'; i1.value = '100'; i1.setAttribute('data-k', 'sh');
          var r1b = el('div', 'paint-row', g);
          var s2 = el('span', '', r1b); s2.textContent = 'Vertical:';
          var i2 = el('input', 'paint-num', r1b); i2.type = 'text'; i2.value = '100'; i2.setAttribute('data-k', 'sv');
          var g2 = el('div', 'paint-group', b);
          g2.style.marginTop = '8px';
          var t2 = el('div', '', g2);
          t2.textContent = 'Skew';
          t2.style.fontWeight = 'bold';
          var r2 = el('div', 'paint-row', g2);
          var s3 = el('span', '', r2); s3.textContent = 'Horizontal:';
          var i3 = el('input', 'paint-num', r2); i3.type = 'text'; i3.value = '0'; i3.setAttribute('data-k', 'kh');
          var r3 = el('div', 'paint-row', g2);
          var s4 = el('span', '', r3); s4.textContent = 'Vertical:';
          var i4 = el('input', 'paint-num', r3); i4.type = 'text'; i4.value = '0'; i4.setAttribute('data-k', 'kv');
        },
        buttons: [
          { label: 'OK', def: true, action: function (api) {
            var ins = api.body.querySelectorAll('input[data-k]');
            var v = {};
            for (var i = 0; i < ins.length; i++) {
              var n = parseFloat(ins[i].value);
              v[ins[i].getAttribute('data-k')] = isNaN(n) ? 0 : n;
            }
            doStretchSkew(v.sh == null ? 100 : v.sh, v.sv == null ? 100 : v.sv,
                          v.kh == null ? 0 : v.kh, v.kv == null ? 0 : v.kv);
          } },
          { label: 'Cancel' }
        ]
      });
    }

    function doStretchSkew(sh, sv, kh, kv) {
      try {
        sh = clamp(sh, 1, 500) / 100;
        sv = clamp(sv, 1, 500) / 100;
        kh = clamp(kh, -89, 89);
        kv = clamp(kv, -89, 89);
        pushUndo();
        var sd = dctx.getImageData(0, 0, docW, docH).data;
        var out = nc(docW, docH), g = c2(out);
        var imgd = g.createImageData(docW, docH), dd = imgd.data;
        var bgc = hex2rgb(bg);
        var i;
        for (i = 0; i < dd.length; i += 4) {
          dd[i] = bgc.r; dd[i + 1] = bgc.g; dd[i + 2] = bgc.b; dd[i + 3] = 255;
        }
        var cx = docW / 2, cy = docH / 2;
        var tx = Math.tan(kh * Math.PI / 180), ty = Math.tan(kv * Math.PI / 180);
        for (var y = 0; y < docH; y++) {
          var dyv = y - cy;
          for (var x = 0; x < docW; x++) {
            var dxv = x - cx;
            var ux = dxv - tx * dyv;
            var uy = dyv - ty * dxv;
            var sxp = Math.round(ux / sh + cx);
            var syp = Math.round(uy / sv + cy);
            if (sxp < 0 || syp < 0 || sxp >= docW || syp >= docH) { continue; }
            var si = (syp * docW + sxp) * 4, di = (y * docW + x) * 4;
            dd[di] = sd[si]; dd[di + 1] = sd[si + 1]; dd[di + 2] = sd[si + 2]; dd[di + 3] = 255;
          }
        }
        g.putImageData(imgd, 0, 0);
        sel = null; floatSel = null;
        doc = out; dctx = c2(doc);
        afterChange();
      } catch (e) { /* ignore */ }
    }

    /* ---- Attributes ---- */

    function attributesDialog() {
      openDialog({
        title: 'Attributes', width: 300,
        build: function (b) {
          var unit = 'px';
          var g = el('div', 'paint-group', b);
          var r1 = el('div', 'paint-row', g);
          var l1 = el('span', '', r1); l1.textContent = 'Width:';
          var iw = el('input', 'paint-num', r1); iw.type = 'text'; iw.value = String(docW);
          var r2 = el('div', 'paint-row', g);
          var l2 = el('span', '', r2); l2.textContent = 'Height:';
          var ih = el('input', 'paint-num', r2); ih.type = 'text'; ih.value = String(docH);
          var ug = el('div', 'paint-group', b);
          ug.style.marginTop = '8px';
          var ut = el('div', '', ug); ut.textContent = 'Units';
          var uPx = radioRow(ug, 'attr-unit', 'Pixels', 'px', true);
          var uIn = radioRow(ug, 'attr-unit', 'Inches', 'in', false);
          var uCm = radioRow(ug, 'attr-unit', 'Cm', 'cm', false);
          var cg = el('div', 'paint-group', b);
          cg.style.marginTop = '8px';
          var ct = el('div', '', cg); ct.textContent = 'Colors';
          radioRow(cg, 'attr-col', 'Color', 'c', true);
          radioRow(cg, 'attr-col', 'Black and white', 'bw', false);
          var apply = function (unitNow) {
            var dpi = 96;
            var v = 1;
            if (unitNow === 'in') { v = dpi; } else if (unitNow === 'cm') { v = dpi / 2.54; }
            iw.value = String(Math.round(docW / v * 100) / 100);
            ih.value = String(Math.round(docH / v * 100) / 100);
          };
          var setUnit = function (u) {
            unit = u;
            apply(u);
          };
          uPx.addEventListener('change', function () { if (uPx.checked) { setUnit('px'); } });
          uIn.addEventListener('change', function () { if (uIn.checked) { setUnit('in'); } });
          uCm.addEventListener('change', function () { if (uCm.checked) { setUnit('cm'); } });
          b._get = function () {
            var dpi = 96, v = 1;
            if (unit === 'in') { v = dpi; } else if (unit === 'cm') { v = dpi / 2.54; }
            var w = parseFloat(iw.value), h = parseFloat(ih.value);
            if (isNaN(w)) { w = docW / v; }
            if (isNaN(h)) { h = docH / v; }
            return {
              w: Math.round(w * v), h: Math.round(h * v),
              bw: b.querySelector('input[name=attr-col][value=bw]').checked
            };
          };
        },
        buttons: [
          { label: 'OK', def: true, action: function (api) {
            var v = api.body._get ? api.body._get() : null;
            if (v) { doResize(v.w, v.h, v.bw); }
          } },
          { label: 'Cancel' },
          { label: 'Default', action: function (api) {
            var v2 = api.body._get ? api.body._get() : null;
            doResize(v2 ? v2.w : docW, v2 ? v2.h : docH, false);
          } }
        ]
      });
    }

    function doResize(w, h, bw) {
      try {
        w = clamp(Math.round(w), 1, 4096);
        h = clamp(Math.round(h), 1, 4096);
        pushUndo();
        var c = nc(w, h), g = c2(c);
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);
        g.drawImage(doc, 0, 0);
        sel = null; floatSel = null;
        docW = w; docH = h; doc = c; dctx = c2(doc);
        if (bw) {
          var img = dctx.getImageData(0, 0, w, h), d = img.data;
          for (var i = 0; i < d.length; i += 4) {
            var v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) > 127 ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
          }
          dctx.putImageData(img, 0, 0);
        }
        if (zoom > 1 && (docW * zoom > 8192 || docH * zoom > 8192)) { zoom = 1; }
        afterChange();
        updateStatus();
      } catch (e) { /* ignore */ }
    }

    /* ---- Edit Colors ---- */

    var BASIC48 = [
      '#000000', '#808080', '#800000', '#808000', '#008000', '#008080', '#000080', '#800080',
      '#808040', '#004040', '#0080ff', '#004080', '#8000ff', '#804000', '#ff0000', '#ffff00',
      '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffff80', '#00ff80', '#80ffff', '#8080ff',
      '#ffffff', '#c0c0c0', '#ff0080', '#ff8040', '#ff8080', '#ffc0c0', '#ffffc0', '#c0ffc0',
      '#c0ffff', '#c0c0ff', '#ffc0ff', '#ffd0a0', '#a0d0ff', '#d0d0d0', '#8080c0', '#c08080',
      '#80c080', '#c0c080', '#c080c0', '#80c0c0', '#ff8000', '#8000c0', '#0080c0', '#4080ff'
    ];
    var customColors = ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
                        '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
                        '#ffffff', '#ffffff', '#ffffff', '#ffffff'];

    function openColorDialog(startHex, cb) {
      var cur = startHex || '#000000';
      var hsl = rgb2hsl(hex2rgb(cur).r, hex2rgb(cur).g, hex2rgb(cur).b);
      var pending = cur;

      openDialog({
        title: 'Edit Colors', width: 434,
        build: function (b) {
          var wrap = el('div', '', b);
          var top = el('div', '', wrap);
          var tl = el('div', '', top);
          tl.textContent = 'Basic colors:';
          var grid = el('div', 'paint-grid48', wrap);
          var basicCells = [];
          for (var i = 0; i < BASIC48.length; i++) {
            var c = el('div', 'paint-c48', grid);
            c.style.background = BASIC48[i];
            (function (hex) {
              c.addEventListener('click', function () { setPending(hex); });
            }(BASIC48[i]));
            basicCells.push(c);
          }

          var cols = el('div', '', wrap);
          cols.style.display = 'flex';
          cols.style.gap = '10px';
          cols.style.marginTop = '10px';
          var left = el('div', '', cols);
          var right = el('div', '', cols);
          var leftTitle = el('div', '', left);
          leftTitle.textContent = 'Custom colors:';
          var customGrid = el('div', 'paint-grid48', left);
          customGrid.style.gridTemplateColumns = 'repeat(8,15px)';
          var customCells = [];
          for (i = 0; i < 16; i++) {
            (function (idx) {
              var c = el('div', 'paint-c48', customGrid);
              c.style.background = customColors[idx];
              c.addEventListener('click', function () { setPending(customColors[idx]); });
              customCells.push(c);
            }(i));
          }
          var preview = el('div', 'paint-preview', left);
          preview.style.marginTop = '10px';
          preview.style.display = 'flex';
          preview.style.padding = '1px';
          var pv = el('i', '', preview);
          var pv2 = el('i', '', preview);
          pv.style.width = '50%';
          pv2.style.width = '50%';
          var pvLab = el('div', '', left);
          pvLab.textContent = 'Color | Solid';
          pvLab.style.cssText = 'font:9px Tahoma,sans-serif;text-align:center;color:#000;margin-top:2px';
          var addBtn = mkbtn(left, '', 'Add to Custom Colors');
          addBtn.style.marginTop = '6px';
          addBtn.style.width = '100%';

          right.style.display = 'flex';
          right.style.gap = '6px';
          var specWrap = el('div', '', right);
          var spec = nc(132, 92);
          spec.className = 'paint-spectrum';
          specWrap.appendChild(spec);
          var lum = nc(16, 92);
          lum.className = 'paint-lum';
          specWrap.appendChild(lum);
          var nums = el('div', 'paint-col', right);
          var fields = {};
          var mkNum = function (label, key) {
            var row = el('div', 'paint-row', nums);
            var s = el('span', '', row);
            s.textContent = label;
            var inp = el('input', 'paint-num', row);
            inp.type = 'text';
            inp.style.width = '46px';
            fields[key] = inp;
            return inp;
          };
          mkNum('Hue:', 'h'); mkNum('Sat:', 's'); mkNum('Lum:', 'l');
          var spacer = el('div', '', nums); spacer.style.height = '6px';
          mkNum('Red:', 'r'); mkNum('Green:', 'g'); mkNum('Blue:', 'b');

          var specCtx = c2(spec), lumCtx = c2(lum);
          var marker = { h: hsl.h, s: hsl.s, l: hsl.l };

          function drawSpectrum() {
            var w = spec.width, h = spec.height;
            var img = specCtx.createImageData(w, h), d = img.data;
            for (var y = 0; y < h; y++) {
              var sat = 240 - Math.round(y / (h - 1) * 240);
              for (var x = 0; x < w; x++) {
                var hue = Math.round(x / (w - 1) * 240);
                var rgb = hsl2rgb(hue, sat, 120);
                var o = (y * w + x) * 4;
                d[o] = rgb.r; d[o + 1] = rgb.g; d[o + 2] = rgb.b; d[o + 3] = 255;
              }
            }
            specCtx.putImageData(img, 0, 0);
            /* crosshair */
            var mx = Math.round(marker.h / 240 * (w - 1));
            var my = Math.round((240 - marker.s) / 240 * (h - 1));
            specCtx.fillStyle = '#000';
            specCtx.fillRect(mx - 4, my, 9, 1);
            specCtx.fillRect(mx, my - 4, 1, 9);
            specCtx.fillStyle = '#fff';
            specCtx.fillRect(mx - 4, my + 1, 9, 1);
            specCtx.fillRect(mx + 1, my - 4, 1, 9);
          }

          function drawLumBar() {
            var w = lum.width, h = lum.height;
            var img = lumCtx.createImageData(w, h), d = img.data;
            for (var y = 0; y < h; y++) {
              var L = Math.round((1 - y / (h - 1)) * 240);
              var rgb = hsl2rgb(marker.h, 240, L);
              for (var x = 0; x < w; x++) {
                var o = (y * w + x) * 4;
                d[o] = rgb.r; d[o + 1] = rgb.g; d[o + 2] = rgb.b; d[o + 3] = 255;
              }
            }
            lumCtx.putImageData(img, 0, 0);
            var ly = Math.round((1 - marker.l / 240) * (h - 1));
            lumCtx.fillStyle = '#000';
            lumCtx.fillRect(0, ly, w, 1);
            lumCtx.fillStyle = '#fff';
            lumCtx.fillRect(0, ly + 1, w, 1);
          }

          function syncFields() {
            fields.h.value = String(marker.h);
            fields.s.value = String(marker.s);
            fields.l.value = String(marker.l);
            var rgb = hsl2rgb(marker.h, marker.s, marker.l);
            fields.r.value = String(rgb.r);
            fields.g.value = String(rgb.g);
            fields.b.value = String(rgb.b);
            pending = rgb2hex(rgb.r, rgb.g, rgb.b);
            pv.style.background = pending;
            if (pv2) { pv2.style.background = pending; }
          }

          function setPending(hex) {
            pending = hex;
            var c = hex2rgb(hex);
            var t = rgb2hsl(c.r, c.g, c.b);
            marker.h = t.h; marker.s = t.s; marker.l = t.l;
            pv.style.background = hex;
            if (pv2) { pv2.style.background = hex; }
            drawSpectrum();
            drawLumBar();
            syncFields();
          }

          function setPendingRgb() {
            var r = clamp(parseInt(fields.r.value, 10) || 0, 0, 255);
            var g = clamp(parseInt(fields.g.value, 10) || 0, 0, 255);
            var bb = clamp(parseInt(fields.b.value, 10) || 0, 0, 255);
            var t = rgb2hsl(r, g, bb);
            marker.h = t.h; marker.s = t.s; marker.l = t.l;
            pending = rgb2hex(r, g, bb);
            pv.style.background = pending;
            drawSpectrum(); drawLumBar();
            fields.h.value = String(marker.h); fields.s.value = String(marker.s); fields.l.value = String(marker.l);
          }

          fields.r.addEventListener('change', setPendingRgb);
          fields.g.addEventListener('change', setPendingRgb);
          fields.b.addEventListener('change', setPendingRgb);
          var setHsl = function () {
            marker.h = clamp(parseInt(fields.h.value, 10) || 0, 0, 240);
            marker.s = clamp(parseInt(fields.s.value, 10) || 0, 0, 240);
            marker.l = clamp(parseInt(fields.l.value, 10) || 0, 0, 240);
            var rgb = hsl2rgb(marker.h, marker.s, marker.l);
            pending = rgb2hex(rgb.r, rgb.g, rgb.b);
            pv.style.background = pending;
            fields.r.value = String(rgb.r); fields.g.value = String(rgb.g); fields.b.value = String(rgb.b);
            drawSpectrum(); drawLumBar();
          };
          fields.h.addEventListener('change', setHsl);
          fields.s.addEventListener('change', setHsl);
          fields.l.addEventListener('change', setHsl);

          var specDrag = function (e) {
            var r = spec.getBoundingClientRect();
            var x = clamp((e.clientX - r.left) / r.width, 0, 1);
            var y = clamp((e.clientY - r.top) / r.height, 0, 1);
            marker.h = Math.round(x * 240);
            marker.s = Math.round((1 - y) * 240);
            var rgb = hsl2rgb(marker.h, marker.s, marker.l);
            pending = rgb2hex(rgb.r, rgb.g, rgb.b);
            pv.style.background = pending;
            syncFields();
            drawSpectrum(); drawLumBar();
          };
          spec.addEventListener('mousedown', function (e) {
            e.preventDefault();
            specDrag(e);
            var mv = function (ev) { specDrag(ev); };
            var up = function () {
              document.removeEventListener('mousemove', mv, true);
              document.removeEventListener('mouseup', up, true);
            };
            document.addEventListener('mousemove', mv, true);
            document.addEventListener('mouseup', up, true);
          });

          var lumDrag = function (e) {
            var r = lum.getBoundingClientRect();
            var y = clamp((e.clientY - r.top) / r.height, 0, 1);
            marker.l = Math.round((1 - y) * 240);
            var rgb = hsl2rgb(marker.h, marker.s, marker.l);
            pending = rgb2hex(rgb.r, rgb.g, rgb.b);
            pv.style.background = pending;
            syncFields();
            drawLumBar();
          };
          lum.addEventListener('mousedown', function (e) {
            e.preventDefault();
            lumDrag(e);
            var mv = function (ev) { lumDrag(ev); };
            var up = function () {
              document.removeEventListener('mousemove', mv, true);
              document.removeEventListener('mouseup', up, true);
            };
            document.addEventListener('mousemove', mv, true);
            document.addEventListener('mouseup', up, true);
          });

          addBtn.addEventListener('click', function () {
            for (var i = 0; i < 16; i++) {
              if (customColors[i].toLowerCase() === pending.toLowerCase()) { return; }
            }
            for (i = 15; i > 0; i--) { customColors[i] = customColors[i - 1]; }
            customColors[0] = pending;
            for (i = 0; i < 16; i++) { customCells[i].style.background = customColors[i]; }
          });

          setPending(cur);
        },
        buttons: [
          { label: 'OK', def: true, action: function () { if (cb) { cb(pending); } } },
          { label: 'Cancel' }
        ]
      });
    }

    /* ---- palette files ---- */

    function loadPalette() {
      try {
        var s = W98.reg.get(REG_KEY, 'Palette', '');
        if (s) {
          var arr = String(s).split(',');
          if (arr.length >= 28) { return arr.slice(0, 28); }
        }
      } catch (e) { /* ignore */ }
      return DEFAULT_PALETTE.slice();
    }

    function savePalette() {
      try { W98.reg.set(REG_KEY, 'Palette', palette.join(',')); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------- files */

    function basename(p) {
      if (!p) { return 'untitled'; }
      var s = String(p);
      var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    function newImage() {
      try {
        if (floatSel) { commitFloat(); }
        sel = null;
        initDoc(docW, docH, bg === '#ffffff' ? '#ffffff' : '#ffffff');
        docName = 'untitled';
        docPath = null;
        updateTitle();
        updateStatus();
      } catch (e) { /* ignore */ }
    }

    function openFile() {
      W98.dialog.fileOpen({ path: 'C:\\My Documents', filter: '*.bmp' }).then(function (p) {
        if (!p) { return; }
        var bytes = null;
        try { bytes = W98.fs.readBytes(p); } catch (e) { bytes = null; }
        var cnv = bytes ? decodeBMP(bytes) : null;
        if (!cnv) {
          W98.dialog.alert('Paint', 'Paint cannot read this file. It is not a valid bitmap file, or its format is not currently supported.', 'error');
          return;
        }
        if (floatSel) { commitFloat(); }
        doc = cnv; docW = cnv.width; docH = cnv.height; dctx = c2(doc);
        zoom = 1;
        view_el.width = docW; view_el.height = docH;
        vctx = c2(view_el);
        sel = null; floatSel = null; overlayClear();
        undoStack.length = 0; redoStack.length = 0;
        docPath = p; docName = basename(p);
        dirty = false;
        render(); updateStatus(); updateTitle(); updateMenus();
      })['catch'](function () { });
    }

    function defaultName() {
      return (docName && docName !== 'untitled' ? docName : 'untitled') + '.bmp';
    }

    function saveFile() {
      if (docPath) { writeTo(docPath); return; }
      saveAs();
    }

    function saveAs() {
      W98.dialog.fileSave({
        path: docPath ? String(docPath).replace(/[^\\]*$/, '') : 'C:\\My Documents',
        name: defaultName(), filter: '*.bmp'
      }).then(function (p) {
        if (!p) { return; }
        if (!/\.bmp$/i.test(p)) { p = p + '.bmp'; }
        writeTo(p);
      })['catch'](function () { });
    }

    function writeTo(p) {
      try {
        if (floatSel) { commitFloat(); }
        var bytes = encodeBMP(doc);
        W98.fs.writeBytes(p, bytes);
        docPath = p;
        docName = basename(p);
        dirty = false;
        updateTitle();
      } catch (e) {
        W98.dialog.alert('Paint', 'Could not save the file.', 'error');
      }
    }

    function copyTo() {
      W98.dialog.fileSave({ path: 'C:\\My Documents', name: 'untitled.bmp', filter: '*.bmp' }).then(function (p) {
        if (!p) { return; }
        try {
          var c = nc(docW, docH), g = c2(c);
          g.fillStyle = bg; g.fillRect(0, 0, docW, docH);
          if (sel || floatSel) {
            var src = currentClip();
            g.drawImage(src, floatSel ? floatSel.x : sel.x, floatSel ? floatSel.y : sel.y);
          } else {
            g.drawImage(doc, 0, 0);
          }
          W98.fs.writeBytes(p, encodeBMP(c));
        } catch (e) { /* ignore */ }
      })['catch'](function () { });
    }

    function pasteFrom() {
      W98.dialog.fileOpen({ path: 'C:\\My Documents', filter: '*.bmp' }).then(function (p) {
        if (!p) { return; }
        var bytes = null;
        try { bytes = W98.fs.readBytes(p); } catch (e) { bytes = null; }
        var cnv = bytes ? decodeBMP(bytes) : null;
        if (cnv) { makePasteFloat(cnv); }
        else { W98.dialog.alert('Paint', 'Paint cannot read this file.', 'error'); }
      })['catch'](function () { });
    }

    function getColors() {
      W98.dialog.fileOpen({ path: 'C:\\WINDOWS', filter: '*.pal' }).then(function (p) {
        if (!p) { return; }
        var bytes = null;
        try { bytes = W98.fs.readBytes(p); } catch (e) { bytes = null; }
        var pal = bytes ? decodePAL(bytes) : null;
        if (!pal || !pal.length) {
          W98.dialog.alert('Paint', 'Paint cannot read this file.', 'error');
          return;
        }
        for (var i = 0; i < palette.length; i++) {
          if (i < pal.length) { palette[i] = pal[i]; }
        }
        paintPalette();
        savePalette();
        render();
      })['catch'](function () { });
    }

    function saveColors() {
      W98.dialog.fileSave({ path: 'C:\\WINDOWS', name: 'untitled.pal', filter: '*.pal' }).then(function (p) {
        if (!p) { return; }
        try { W98.fs.writeBytes(p, encodePAL(palette)); } catch (e) { /* ignore */ }
      })['catch'](function () { });
    }

    /* -------------------------------------------------------- image menu */

    function invertColors() {
      try {
        dropDocState();
        pushUndo();
        var img = dctx.getImageData(0, 0, docW, docH), d = img.data;
        for (var i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
        }
        dctx.putImageData(img, 0, 0);
        afterChange();
      } catch (e) { /* ignore */ }
    }

    function clearImage() {
      clearDoc();
    }

    function viewBitmap() {
      try {
        var on = !viewMode;
        viewMode = on;
        toolbox.style.display = on ? 'none' : '';
        bottom.style.display = on ? 'none' : '';
        fontBar.style.display = on ? 'none' : '';
        area.style.background = on ? '#000000' : '#ffffff';
        if (on) {
          var aw = Math.max(1, area.clientWidth - 8), ah = Math.max(1, area.clientHeight - 8);
          var z = Math.min(aw / docW, ah / docH);
          view_el.style.width = Math.floor(docW * z) + 'px';
          view_el.style.height = Math.floor(docH * z) + 'px';
          view_el.style.margin = '4px auto';
        } else {
          view_el.style.width = '';
          view_el.style.height = '';
          view_el.style.margin = '';
          updateToolUI();
        }
      } catch (e) { /* ignore */ }
    }

    var viewMode = false;

    function aboutPaint() {
      try {
        if (typeof W98.aboutDialog === 'function') {
          W98.aboutDialog({
            id: 'paint', title: 'About Paint', name: 'Microsoft Paint',
            version: '4.0.1998', icon: 'paint',
            text: 'Microsoft Paint\nWindows 98\n\nA faithful reproduction of the\nclassic bitmap editor for the\nW98 web desktop.'
          });
          return;
        }
      } catch (e) { /* fall through */ }
      W98.dialog.alert('About Paint', 'Microsoft Paint\nVersion 4.0 (Windows 98)\n\nA faithful reproduction of the classic bitmap editor.', 'info');
    }

    function helpTopics() {
      W98.dialog.alert('Paint Help',
        'For Help on using Paint, click a topic.\n\n' +
        '- Draw a line: choose the Line tool and drag.\n' +
        '- Erase: choose the Eraser and drag.\n' +
        '- Pick a colour: click the colour palette, or right-click for the\n  background colour.\n' +
        '- Undo: Ctrl+Z. Repeat: Ctrl+Y.\n' +
        '- Save as a bitmap: File > Save (Ctrl+S).', 'info');
    }

    /* -------------------------------------------------------------- menus */

    function buildMenu() {
      return [
        { label: '&File', items: [
          { label: '&New', accel: 'Ctrl+N', onclick: newImage },
          { label: '&Open...', accel: 'Ctrl+O', onclick: openFile },
          { label: '&Save', accel: 'Ctrl+S', onclick: saveFile },
          { label: 'Save &As...', onclick: saveAs },
          { type: 'sep' },
          { label: 'Copy To...', onclick: copyTo },
          { label: 'Paste From...', onclick: pasteFrom },
          { type: 'sep' },
          { label: '&Print...', disabled: true },
          { label: 'Page Se&tup...', disabled: true },
          { type: 'sep' },
          { label: 'E&xit', onclick: function () { try { win.close(); } catch (e) { } } }
        ] },
        { label: '&Edit', items: [
          { label: '&Undo', accel: 'Ctrl+Z', disabled: !undoStack.length, onclick: undo },
          { label: '&Repeat', accel: 'Ctrl+Y', disabled: !redoStack.length, onclick: redo },
          { type: 'sep' },
          { label: 'Cu&t', accel: 'Ctrl+X', disabled: !sel && !floatSel, onclick: cutSel },
          { label: '&Copy', accel: 'Ctrl+C', disabled: !sel && !floatSel, onclick: copySel },
          { label: '&Paste', accel: 'Ctrl+V', onclick: pasteClipboard },
          { label: 'Clear Selection', accel: 'Del', disabled: !sel && !floatSel, onclick: clearSelection },
          { type: 'sep' },
          { label: 'Select &All', accel: 'Ctrl+A', onclick: selectAll },
          { label: 'Copy To...', onclick: copyTo },
          { label: 'Paste From...', onclick: pasteFrom }
        ] },
        { label: '&View', items: [
          { label: 'Tool &Box', type: 'check', checked: showToolbox, onclick: function () {
            showToolbox = !showToolbox;
            toolbox.style.display = showToolbox ? '' : 'none';
            updateMenus();
          } },
          { label: '&Color Box', type: 'check', checked: showColorbox, onclick: function () {
            showColorbox = !showColorbox;
            bottom.style.display = showColorbox ? '' : 'none';
            updateMenus();
          } },
          { label: '&Text Toolbar', type: 'check', checked: showTextbar, onclick: function () {
            showTextbar = !showTextbar;
            updateToolUI();
            updateMenus();
          } },
          { type: 'sep' },
          { label: '&View Bitmap', accel: 'Ctrl+F', onclick: viewBitmap },
          { type: 'sep' },
          { label: 'Zoom 100%', onclick: function () { setZoom(1); } },
          { label: 'Zoom 200%', onclick: function () { setZoom(2); } },
          { label: 'Zoom 400%', onclick: function () { setZoom(4); } },
          { label: 'Zoom 800%', onclick: function () { setZoom(8); } }
        ] },
        { label: '&Image', items: [
          { label: '&Flip/Rotate...', accel: 'Ctrl+R', onclick: flipDialog },
          { label: '&Stretch/Skew...', accel: 'Ctrl+W', onclick: stretchDialog },
          { label: '&Invert Colors', accel: 'Ctrl+I', onclick: invertColors },
          { label: '&Attributes...', accel: 'Ctrl+E', onclick: attributesDialog },
          { label: '&Clear Image', accel: 'Ctrl+Shift+N', onclick: clearImage },
          { type: 'sep' },
          { label: 'D&raw Opaque', type: 'check', checked: drawOpaque, onclick: function () {
            drawOpaque = !drawOpaque;
            selOpaque = drawOpaque;
            updateToolUI();
            updateMenus();
          } }
        ] },
        { label: '&Options', items: [
          { label: '&Edit Colors...', onclick: function () { openColorDialog(fg, function (h) { setColor(h, false); }); } },
          { label: '&Get Colors...', onclick: getColors },
          { label: '&Save Colors...', onclick: saveColors }
        ] },
        { label: '&Help', items: [
          { label: '&Help Topics', onclick: helpTopics },
          { type: 'sep' },
          { label: '&About Paint', onclick: aboutPaint }
        ] }
      ];
    }

    var drawOpaque = true;
    var menuTimer = 0;

    function updateMenus() {
      if (menuTimer) { return; }
      menuTimer = win.setTimeout(function () {
        menuTimer = 0;
        try { win.setMenu(buildMenu()); } catch (e) { /* ignore */ }
      }, 0);
      timers.push(menuTimer);
    }

    /* ------------------------------------------------------------ cleanup */

    function cleanup() {
      try { stopAir(); } catch (e) { }
      try { removeDocListeners(); } catch (e) { }
      for (var i = 0; i < timers.length; i++) {
        try { win.clearInterval(timers[i]); } catch (e) { }
        try { win.clearTimeout(timers[i]); } catch (e) { }
      }
      timers.length = 0;
      for (i = dialogs.length - 1; i >= 0; i--) {
        try {
          if (dialogs[i].cleanup) { dialogs[i].cleanup(); }
          if (dialogs[i].el.parentNode) { dialogs[i].el.parentNode.removeChild(dialogs[i].el); }
        } catch (e) { }
      }
      dialogs.length = 0;
      try { removeTextBox(); } catch (e) { }
      try { win.off('resize', onWinResize); } catch (e) { }
      try { view_el.removeEventListener('dblclick', onDblClick); } catch (e) { }
      try { win.el.removeEventListener('keydown', onKeyDown); } catch (e) { }
      try { win.el.removeEventListener('keyup', onKeyUp); } catch (e) { }
      try { win.el.removeEventListener('contextmenu', preventMenu); } catch (e) { }
      try {
        if (root.parentNode) { root.parentNode.removeChild(root); }
      } catch (e) { }
    }

    function preventMenu(e) { e.preventDefault(); }

    function onDblClick(e) {
      if (polyPts && polyPts.length > 2) { closePolygon(); }
    }

    /* ------------------------------------------------------------- startup */

    view_el.addEventListener('dblclick', onDblClick);
    win.el.addEventListener('keydown', onKeyDown);
    win.el.addEventListener('keyup', onKeyUp);
    win.el.addEventListener('contextmenu', preventMenu);
    win.on('resize', onWinResize);
    try { win.claimKeys(); } catch (e) { }
    try {
      if (W98.icons && typeof W98.icons.url === 'function') { win.setIcon(W98.icons.url('paint')); }
      else { win.setIcon('paint'); }
    } catch (e) { }

    paintPalette();
    paintCurrent();

    /* default document fills the drawing area, like a fresh Paint window */
    (function () {
      var aw = win.width || 560, ah = win.height || 400;
      var w = clamp(Math.round(aw - 58 - 12), 64, 4096);
      var h = clamp(Math.round(ah - 44 - 12), 64, 4096);
      initDoc(w, h, '#ffffff');
    }());
    updateToolUI();
    updateMenus();
    updateStatus();
    updateTitle();

    if (typeof args === 'string' && args) {
      try {
        var b = W98.fs.readBytes(args);
        var cnv = b ? decodeBMP(b) : null;
        if (cnv) {
          doc = cnv; docW = cnv.width; docH = cnv.height; dctx = c2(doc);
          view_el.width = docW; view_el.height = docH;
          vctx = c2(view_el);
          docPath = args; docName = basename(args);
          render(); updateTitle(); updateStatus();
        }
      } catch (e) { /* ignore */ }
    }

    return {
      onClose: cleanup,
      onResize: onWinResize,
      onFocus: function () { },
      onBlur: function () { },
      onKey: function () { }
    };
  }

  /* ------------------------------------------------------------ register */

  W98.registerApp({
    id: 'paint',
    title: 'Paint',
    icon: 'paint',
    width: 560,
    height: 400,
    minWidth: 320,
    minHeight: 240,
    resizable: true,
    maximizable: true,
    desktop: true,
    startMenuGroup: 'Accessories',
    singleton: false,
    create: createApp
  });

}());
