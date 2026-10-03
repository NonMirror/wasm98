/* ===========================================================================
 * shellapps.js — the small built-in Windows 98 shell applications
 *
 *   run      Start > Run…                     pick a program to start
 *   find     Start > Find > Files or Folders  the 1998 search window
 *   help     Start > Help                     Windows Help (Help Topics)
 *   recycle  desktop Recycle Bin              C:\RECYCLED details view
 *   winver   Start > Run: WINVER              the About Windows box
 *   ie       desktop Internet Explorer        IE4 frame over the kernel FS
 *
 * Classic script (NOT a module).  Registers six apps with W98.registerApp().
 * Uses only the documented W98 / win API from CONTRACT.md.
 * =========================================================================*/
(function () {
  'use strict';

  var ICONS = W98.icons;

  /* =========================================================== utilities ==*/
  var HEX = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return HEX[c]; }); }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  /* '&x' draws the classic underlined accelerator in a label */
  function accel(el2, text) {
    var parts = String(text).split('&');
    el2.textContent = '';
    for (var i = 0; i < parts.length; i++) {
      if (i > 0 && parts[i].length) {
        var u = document.createElement('u');
        u.textContent = parts[i].charAt(0);
        el2.appendChild(u);
        el2.appendChild(document.createTextNode(parts[i].slice(1)));
      } else {
        el2.appendChild(document.createTextNode(parts[i]));
      }
    }
    return el2;
  }
  function lab(cls, text) { return accel(mk('label', cls, ''), text); }
  function icon(key, size) {
    try { return ICONS.el(key, size); } catch (e) { return mk('span'); }
  }
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  var TYPE_BY_EXT = {
    txt: 'Text Document', log: 'Text Document', ini: 'Configuration Settings',
    sys: 'System file', bat: 'MS-DOS Batch File', bak: 'Backup File',
    exe: 'Application', com: 'Application', dll: 'Application Extension',
    bmp: 'Bitmap Image', dib: 'Bitmap Image', png: 'Bitmap Image', gif: 'GIF Image',
    jpg: 'JPEG Image', jpeg: 'JPEG Image', wav: 'Wave Sound', mid: 'MIDI Sequence',
    mp3: 'MP3 Format Sound', avi: 'Video Clip', htm: 'HTML Document',
    html: 'HTML Document', url: 'Internet Shortcut', lnk: 'Shortcut',
    tmp: 'Temporary File', jsdos: 'DOS Game Bundle'
  };
  function extOf(name) {
    var base = String(name == null ? '' : name).split('\\').pop();
    var dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }
  function baseName(p) {
    var a = String(p == null ? '' : p).split('\\');
    return a[a.length - 1] || String(p == null ? '' : p);
  }
  function dirName(p) {
    var s = String(p == null ? '' : p).replace(/\\$/, '');
    var i = s.lastIndexOf('\\');
    return i <= 2 ? s.slice(0, 3) : s.slice(0, i);
  }
  function typeName(entry) {
    if (entry.dir) return 'File Folder';
    var e = extOf(entry.name);
    return TYPE_BY_EXT[e] || (e ? e.toUpperCase() + ' File' : 'File');
  }
  function sizeText(n, isDir) {
    if (isDir) return '';
    n = Number(n) || 0;
    if (n < 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return Math.round(n / 1024) + ' KB';
  }
  function joinPath(a, b) {
    if (safe(function () { return W98.fs.join(a, b); }, null)) return W98.fs.join(a, b);
    return String(a).replace(/\\$/, '') + '\\' + b;
  }
  function parentPath(p) { return safe(function () { return W98.fs.parent(p); }, dirName(p)); }
  function stampOf(mtime) {
    var s = safe(function () { return W98.fs.timeString(mtime); }, '');
    return s || '--/--/----';
  }
  function nowStamp() {
    var d = new Date();
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + '/' + d.getFullYear();
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* open a filesystem object the way Explorer does */
  function openEntry(p) {
    if (!p) return;
    try {
      if (safe(function () { return W98.fs.isDir(p); }, false)) { W98.launch('explorer', { path: p }); return; }
      var e = extOf(p);
      if (e === 'bmp' || e === 'dib' || e === 'png' || e === 'jpg' || e === 'gif') W98.launch('paint', { path: p });
      else if (e === 'wav' || e === 'mid' || e === 'mp3' || e === 'avi') W98.launch('mplayer', { path: p });
      else if (e === 'htm' || e === 'html' || e === 'url') W98.launch('ie', { path: p });
      else if (e === 'exe' || e === 'com') {
        W98.dialog.alert('Windows', 'Cannot run \'' + baseName(p) + '\'.\nThis file is not a valid Windows application.', 'error');
      } else W98.launch('notepad', { path: p });
    } catch (err) { /* never throw out of a click handler */ }
  }
  function propertiesOf(p) {
    var st = safe(function () { return W98.fs.stat(p); }, null) || {};
    var e = safe(function () { return W98.fs.list(parentPath(p)); }, []) || [];
    var found = null, i;
    for (i = 0; i < e.length; i++) if (e[i].name.toLowerCase() === baseName(p).toLowerCase()) found = e[i];
    var text = (baseName(p) || '') + '\n' +
      'Type: ' + (st.dir ? 'File Folder' : (TYPE_BY_EXT[extOf(p)] || 'File')) + '\n' +
      'Location: ' + parentPath(p) + '\n' +
      'Size: ' + (st.dir ? '' : (st.size || 0) + ' bytes (' + sizeText(st.size, false) + ')') + '\n' +
      'Modified: ' + (found ? stampOf(found.mtime) : '--/--/----') + '\n' +
      'MS-DOS name: ' + baseName(p).slice(0, 8).toUpperCase() + '\n' +
      'Attributes: ' + (st.dir ? 'Directory' : 'Archive');
    return W98.dialog.alert(baseName(p) + ' Properties', text, 'info');
  }

  /* one <style> element for all six apps, ids all prefixed sa- */
  var CSS = [
    '.sa-root{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;',
    '  background:#c0c0c0;font:11px Tahoma,"MS Sans Serif",sans-serif;color:#000;overflow:hidden}',
    '.sa-root *{box-sizing:border-box}',
    '.sa-grow{flex:1 1 auto;min-width:0;min-height:0}',
    '.sa-row{display:flex;align-items:center;gap:6px}',
    '.sa-spread{display:flex;align-items:center;justify-content:space-between;gap:6px}',
    '.sa-toolbar{margin:0}',
    '.sa-colhead{display:flex;align-items:center;gap:4px;font:11px Tahoma,sans-serif}',
    /* ---------- list views (details tables) ---------- */
    '.sa-panel{background:#fff;box-shadow:inset -1px -1px #fff,inset 1px 1px grey,inset -2px -2px #dfdfdf,',
    '  inset 2px 2px #0a0a0a;overflow:auto;flex:1 1 auto;min-height:30px;position:relative}',
    '.sa-table{width:100%;table-layout:fixed;border-collapse:collapse}',
    '.sa-table>*>tr>*{height:17px}',
    '.sa-table tbody tr{cursor:default}',
    '.sa-table td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;font:11px Tahoma,sans-serif}',
    '.sa-table th{border-right:1px solid #808080;border-bottom:1px solid #808080}',
    '.sa-table td .sa-cellic{display:inline-block;width:16px;height:16px;vertical-align:-3px;margin-right:3px}',
    '.sa-empty{position:absolute;left:0;right:0;top:46px;text-align:center;color:#808080;font:11px Tahoma,sans-serif}',
    '.sa-empty .ic{display:block;margin:0 auto 8px;width:32px;height:32px;opacity:.55}',
    '.sa-iconview{display:flex;flex-wrap:wrap;align-content:flex-start;gap:2px;padding:4px}',
    '.sa-iconsel{width:76px;padding:4px 2px;text-align:center;font:11px Tahoma,sans-serif}',
    '.sa-iconsel .ic{display:block;width:32px;height:32px;margin:0 auto 3px}',
    '.sa-iconsel.small{display:flex;align-items:center;gap:4px;width:auto;padding:0 4px;height:18px}',
    '.sa-iconsel.small .ic{width:16px;height:16px;margin:0}',
    '.sa-iconsel .lb{overflow:hidden;text-overflow:ellipsis}',
    '.sa-iconsel.sel{background:#000080;color:#fff}',
    '.sa-iconsel.sel .lb{background:#000080;color:#fff}',
    '.sa-iconsel.small .lb{white-space:nowrap}',
    /* ---------- combo box (Run + IE address bar) ---------- */
    '.sa-combo{position:relative;flex:1 1 auto;min-width:0;display:flex;height:20px}',
    '.sa-combo>input{flex:1 1 auto;width:100%;min-width:0;height:20px;border:0;border-radius:0;outline:0;',
    '  padding:2px 3px;background:#fff;font:11px Tahoma,sans-serif;color:#000;',
    '  box-shadow:inset -1px -1px #fff,inset 1px 1px grey,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a}',
    '.sa-combo>input:focus{outline:none}',
    '.sa-cbtn{flex:0 0 16px;width:16px;min-width:0;min-height:0;height:20px;padding:0;margin-left:-1px;position:relative}',
    '.sa-cbtn:after{content:"";position:absolute;left:5px;top:7px;width:0;height:0;',
    '  border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #000}',
    '.sa-drop{position:absolute;left:0;right:0;top:100%;z-index:30;display:none;background:#fff;',
    '  box-shadow:inset -1px -1px #fff,inset 1px 1px grey,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a;',
    '  overflow:auto;max-height:120px}',
    '.sa-drop.on{display:block}',
    '.sa-drop-item{height:16px;line-height:16px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sa-drop-item.sel{background:#000080;color:#fff}',
    /* ---------- tabs ---------- */
    '.sa-tabs{display:flex;margin:0 0 -1px 3px;position:relative;z-index:2;flex:0 0 auto}',
    '.sa-tabpage{background:#c0c0c0;box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #dfdfdf,',
    '  inset -2px -2px grey,inset 2px 2px #fff;padding:8px;flex:0 0 auto}',
    /* ---------- status ---------- */
    '.sa-note{font:11px Tahoma,sans-serif;color:#404040}',
    /* ---------- run ---------- */
    '.sa-run{padding:11px 10px 8px}',
    '.sa-run-top{display:flex;gap:11px;margin-bottom:12px}',
    '.sa-run-top .ic{flex:0 0 32px;width:32px;height:32px}',
    '.sa-run-top .tx{flex:1 1 auto;line-height:14px;padding-top:1px}',
    '.sa-run-row{margin-bottom:12px}',
    '.sa-run-row>label{flex:0 0 auto}',
    '.sa-run-btns{display:flex;justify-content:flex-end;gap:6px;margin-top:auto}',
    '.sa-run-btns>button{min-width:75px}',
    /* ---------- find ---------- */
    '.sa-find{padding:6px;gap:6px}',
    '.sa-find .fld{flex:1 1 auto;min-width:0;height:21px;font:11px Tahoma,sans-serif}',
    '.sa-find-lookin{flex:0 1 210px;min-width:0}',
    '.sa-find-opt{padding:6px 8px}',
    '.sa-find-opt .sa-row{margin-bottom:5px}',
    '.sa-find-list{flex:1 1 auto;min-height:36px;display:flex;flex-direction:column}',
    '.sa-find-list .sa-panel{border-top:0}',
    /* ---------- help ---------- */
    '.sa-help{padding:5px 6px 6px;gap:5px}',
    '.sa-help-panes{display:flex;gap:5px;flex:1 1 auto;min-height:0}',
    '.sa-help-left{flex:0 0 40%;min-width:110px;display:flex;flex-direction:column;gap:4px;min-height:0}',
    '.sa-help-right{flex:1 1 auto;min-width:0;background:#fff;padding:12px 14px;overflow:auto;',
    '  box-shadow:inset -1px -1px #fff,inset 1px 1px grey,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a;',
    '  font:12px Tahoma,"MS Sans Serif",sans-serif;line-height:15px}',
    '.sa-help-right h2{font:bold 14px Tahoma,sans-serif;color:#000080;margin:0 0 2px}',
    '.sa-help-right hr{border:0;border-top:1px solid #808080;border-bottom:1px solid #fff;margin:5px 0 9px}',
    '.sa-help-right p{margin:0 0 9px}',
    '.sa-help-right ul{margin:0 0 9px 0;padding-left:20px}',
    '.sa-help-right li{margin:0 0 3px}',
    '.sa-help-right a{color:#0000ee;cursor:pointer;text-decoration:underline}',
    '.sa-help-right a:hover{color:#ee0000}',
    '.sa-help-right .rel{margin-top:10px;padding-top:6px;border-top:1px solid #808080;font-size:11px}',
    '.sa-help-list{flex:1 1 auto;min-height:40px}',
    '.sa-help-foot{display:flex;justify-content:flex-end;gap:6px;flex:0 0 auto}',
    /* ---------- recycle ---------- */
    '.sa-rec{padding:0;gap:0}',
    '.sa-rec-body{padding:4px 5px 3px;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
    /* ---------- ie ---------- */
    '.sa-ie{padding:0;gap:0}',
    '.sa-ie-tb{height:30px;gap:2px}',
    '.sa-ie-tb .w98-toolbtn{width:26px;justify-content:center;padding:1px 3px}',
    '.sa-ie-tb .w98-toolbtn[disabled]{opacity:.45}',
    '.sa-ie-logo{flex:1 1 auto;display:flex;justify-content:flex-end;align-items:center;padding-right:2px}',
    '.sa-ie-logo canvas{image-rendering:pixelated}',
    '.sa-ie-addr{display:flex;align-items:center;gap:4px;padding:2px 4px;flex:0 0 auto}',
    '.sa-ie-addr>label{flex:0 0 auto}',
    '.sa-ie-view{flex:1 1 auto;min-height:0;margin:0 3px 3px;background:#fff;overflow:auto;position:relative;',
    '  box-shadow:inset -1px -1px #fff,inset 1px 1px grey,inset -2px -2px #dfdfdf,inset 2px 2px #0a0a0a}',
    '.sa-ie-page{padding:14px 18px;font:13px Tahoma,"MS Sans Serif",sans-serif;line-height:1.35;color:#000;',
    '  min-height:100%}',
    '.sa-ie-page.sz0{font-size:11px}.sa-ie-page.sz1{font-size:12px}.sa-ie-page.sz2{font-size:13px}',
    '.sa-ie-page.sz3{font-size:15px}.sa-ie-page.sz4{font-size:17px}',
    '.sa-ie-page h1{font:bold 24px Tahoma,sans-serif;margin:0 0 8px;color:#000080}',
    '.sa-ie-page h2{font:bold 18px Tahoma,sans-serif;margin:14px 0 6px;color:#000080}',
    '.sa-ie-page h3{font:bold 15px Tahoma,sans-serif;margin:12px 0 5px;color:#000080}',
    '.sa-ie-page h4{font:bold 13px Tahoma,sans-serif;margin:10px 0 4px}',
    '.sa-ie-page p{margin:0 0 10px}',
    '.sa-ie-page ul,.sa-ie-page ol{margin:0 0 10px 0;padding-left:26px}',
    '.sa-ie-page li{margin:0 0 3px}',
    '.sa-ie-page hr{border:0;border-top:1px solid #808080;border-bottom:1px solid #fff;margin:10px 0}',
    '.sa-ie-page a{color:#0000ee;text-decoration:underline;cursor:pointer}',
    '.sa-ie-page a:visited{color:#551a8b}',
    '.sa-ie-page img{border:1px solid #000;background:#fff;max-width:100%}',
    '.sa-ie-page .imgmiss{display:inline-block;width:32px;height:32px;border:1px solid #808080;',
    '  background:#fff;color:#ff0000;font:bold 12px Tahoma,sans-serif;text-align:center;line-height:32px}',
    '.sa-ie-page table{border-collapse:collapse;margin:0 0 10px}',
    '.sa-ie-page td,.sa-ie-page th{border:1px solid #808080;padding:2px 6px;font-size:12px}',
    '.sa-ie-page th{background:#c0c0c0}',
    '.sa-ie-page pre,.sa-ie-page tt{font:12px "Lucida Console","Courier New",monospace}',
    '.sa-ie-page .center{text-align:center}',
    '.sa-ie-page .welcome{text-align:center;background:#000080;color:#fff;padding:14px;margin:-14px -18px 14px}',
    '.sa-ie-page .welcome h1{color:#fff;font-size:26px;margin:0}',
    '.sa-ie-page .welcome .sub{color:#c0c0ff;font-size:12px}',
    '.sa-ie-error{background:#fff}'
  ].join('\n');

  function ensureCss() {
    if (document.getElementById('w98app-shellapps')) return;
    var st = document.createElement('style');
    st.id = 'w98app-shellapps';
    st.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(st);
  }

  /* =========================================================================
   * 1. RUN — 'Run' dialog
   * =======================================================================*/
  var RUNMRU = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RunMRU';
  var RUN_MAX = 10;
  var runComboText = null;        /* null = show the MRU; '' = cleared by Cancel */

  function mruRead() {
    var out = [], order = '', i;
    try { order = String(W98.reg.get(RUNMRU, 'MRUList', '') || ''); } catch (e) { order = ''; }
    for (i = 0; i < order.length; i++) {
      var nm = order.charAt(i);
      if (!/^[a-z]$/.test(nm)) continue;
      var v = safe(function (n) { return W98.reg.get(RUNMRU, n, null); }.bind(null, nm), null);
      if (v != null && String(v) !== '') out.push(String(v).replace(/\u0001+$/, ''));
    }
    if (!out.length) {   /* fall back to a,b,c… for anything else that writes this key */
      for (i = 0; i < 26; i++) {
        var n2 = String.fromCharCode(97 + i);
        var v2 = safe(function (n) { return W98.reg.get(RUNMRU, n, null); }.bind(null, n2), null);
        if (v2 != null && String(v2) !== '') out.push(String(v2).replace(/\u0001+$/, ''));
      }
    }
    return out;
  }

  function mruRemember(text) {
    var list = mruRead().filter(function (c) { return c.toLowerCase() !== text.toLowerCase(); });
    list.unshift(text);
    list = list.slice(0, RUN_MAX);
    for (var i = 0; i < 26; i++) {
      var n = String.fromCharCode(97 + i);
      if (i >= list.length) safe(function (nm) { W98.reg.del(RUNMRU, nm); }.bind(null, n), null);
    }
    var names = '';
    for (var j = 0; j < list.length; j++) {
      var nm2 = String.fromCharCode(97 + j);
      names += nm2;
      safe(function (name, val) { W98.reg.set(RUNMRU, name, val); }.bind(null, nm2, list[j] + '\u0001'), null);
    }
    safe(function () { W98.reg.set(RUNMRU, 'MRUList', names); }, null);
  }

  var RUN_ALIAS = {
    winver: 'winver', calc: 'calculator', calculator: 'calculator',
    notepad: 'notepad', mspaint: 'paint', pbrush: 'paint', paint: 'paint',
    command: 'cmd', cmd: 'cmd', command_prompt: 'cmd',
    explorer: 'explorer', control: 'control', taskmgr: 'taskmgr',
    sol: 'solitaire', solitaire: 'solitaire', freecell: 'freecell',
    winmine: 'minesweeper', minesweeper: 'minesweeper', jezzball: 'jezzball',
    pinball: 'pinball', charmap: 'charmap', mplayer: 'mplayer', mplay32: 'mplayer',
    iexplore: 'ie', ie: 'ie', help: 'help', winhelp: 'help', find: 'find',
    regedit: 'regedit', wordpad: 'wordpad', cliconfg: 'control'
  };

  function splitCommand(text) {
    var raw = String(text).trim();
    var prog = raw, rest = '';
    if (raw.charAt(0) === '"') {
      var end = raw.indexOf('"', 1);
      if (end > 0) { prog = raw.slice(1, end); rest = raw.slice(end + 1).trim(); }
    } else {
      var sp = raw.search(/\s/);
      if (sp > 0) { prog = raw.slice(0, sp); rest = raw.slice(sp + 1).trim(); }
    }
    return { prog: prog, args: rest };
  }

  /* what does this command line mean? */
  function resolveRun(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { kind: 'empty' };
    var parts = splitCommand(s);
    var prog = parts.prog, rest = parts.args;
    var bare = prog.toLowerCase().replace(/["']/g, '');
    var stripped = bare.replace(/\.(exe|com|bat|pif|scr)$/, '');
    var leaf = stripped.split('\\').pop().split('/').pop();
    var lookup = leaf;
    if (/^[a-z]:$/.test(lookup)) lookup = '';

    if (stripped === 'crash98') return { kind: 'crash' };

    /* 1. the real Windows command names */
    if (RUN_ALIAS[lookup]) {
      return { kind: 'app', id: RUN_ALIAS[lookup], args: rest ? { path: rest } : {} };
    }
    /* 2. anything registered with the shell */
    var reg = W98.apps[bare] || W98.apps[stripped] || W98.apps[lookup] ||
      W98.apps[leaf.replace(/\.(exe|com)$/, '')];
    if (reg) return { kind: 'app', id: reg.id, args: rest ? { path: rest } : {} };

    /* 3. a path (or a bare name that exists on the volume) */
    var cand = [prog];
    if (!/[\\/]/.test(prog) && !/^[a-z]:/i.test(prog)) {
      cand.push('C:\\WINDOWS\\' + prog);
      cand.push('C:\\WINDOWS\\SYSTEM\\' + prog);
      cand.push('C:\\' + prog);
      cand.push('C:\\WINDOWS\\COMMAND\\' + prog);
    }
    for (var i = 0; i < cand.length; i++) {
      var p = safe(function () { return W98.fs.norm(cand[i]); }, cand[i]);
      if (safe(function () { return W98.fs.exists(p); }, false)) return { kind: 'path', path: p };
    }
    /* an unquoted path with spaces: Windows splits on the first space, so only
       accept the whole line when the first word means nothing at all */
    var whole = safe(function () { return W98.fs.norm(s); }, s);
    if (whole && /\s/.test(s) && safe(function () { return W98.fs.exists(whole); }, false)) {
      return { kind: 'path', path: whole };
    }
    return { kind: 'unknown', text: prog };
  }

  /* W98.launch accepts left/top, which is how the shell places its own dialogs;
     the About Windows box is the one 98 dialog that opens centred on the desktop. */
  function launchCentred(id, args) {
    try {
      if (id === 'winver' && typeof window.innerWidth === 'number' && window.innerWidth > 440) {
        var left = Math.round((window.innerWidth - 402) / 2);
        var top = Math.round((window.innerHeight - 260) / 2);
        return W98.launch(id, args, { left: Math.max(4, left), top: Math.max(4, top) });
      }
    } catch (e) { /* fall through to the ordinary cascade position */ }
    return W98.launch(id, args);
  }

  function runCommand(text, winRef) {
    var r = resolveRun(text);
    if (r.kind === 'empty') { W98.sound.beep(); return false; }
    if (r.kind === 'unknown') {
      W98.dialog.alert('Run',
        'Windows cannot find \'' + r.text + '\'. Make sure you typed the name correctly, and then try again.',
        'error');
      return false;
    }
    mruRemember(String(text).trim());
    if (r.kind === 'crash') {
      if (winRef) winRef.close();
      setTimeout(function () { safe(function () { W98.crash(); }, null); }, 60);
      return true;
    }
    if (r.kind === 'app') { launchCentred(r.id, r.args); return true; }
    if (r.kind === 'path') { openEntry(r.path); return true; }
    return false;
  }

  W98.registerApp({
    id: 'run',
    title: 'Run',
    icon: 'run',
    width: 360, height: 160,
    minWidth: 360, minHeight: 160,
    resizable: false,
    maximizable: false,
    minimizable: false,
    singleton: true,
    startMenuGroup: 'Accessories',
    create: function (win, args) {
      ensureCss();
      var root = mk('div', 'sa-root sa-run');
      win.el.appendChild(root);

      var top = mk('div', 'sa-run-top');
      var ic = mk('div', 'ic');
      ic.appendChild(icon('run', 32));
      var tx = mk('div', 'tx', 'Type the name of a program, folder, document, or Internet ' +
        'resource, and Windows will open it for you.');
      top.appendChild(ic); top.appendChild(tx);
      root.appendChild(top);

      var row = mk('div', 'sa-row sa-run-row');
      row.appendChild(lab('', '&Open:'));
      var combo = mk('div', 'sa-combo');
      var input = mk('input');
      input.type = 'text';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Open');
      combo.appendChild(input);
      var arrow = mk('button', 'sa-cbtn');
      arrow.type = 'button';
      arrow.tabIndex = -1;
      arrow.title = 'Recently used commands';
      combo.appendChild(arrow);
      var drop = mk('div', 'sa-drop');
      combo.appendChild(drop);
      row.appendChild(combo);
      root.appendChild(row);

      var btns = mk('div', 'sa-run-btns');
      var okB = mk('button', 'default', 'OK');
      var cancelB = mk('button', '', 'Cancel');
      var browseB = mk('button', '', 'Browse...');
      btns.appendChild(okB); btns.appendChild(cancelB); btns.appendChild(browseB);
      root.appendChild(btns);

      var dropOpen = false;

      function fillDrop() {
        drop.innerHTML = '';
        var list = mruRead();
        if (!list.length) {
          var d = mk('div', 'sa-drop-item sa-note', '(no recent commands)');
          drop.appendChild(d);
          return;
        }
        for (var i = 0; i < list.length; i++) {
          (function (item) {
            var r2 = mk('div', 'sa-drop-item', item);
            r2.title = item;
            r2.addEventListener('mousedown', function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              input.value = item;
              closeDrop();
              input.focus();
            });
            drop.appendChild(r2);
          })(list[i]);
        }
      }
      function openDrop() {
        fillDrop();
        var avail = (win.height || 160) - 6;
        var top2 = 0;
        var node = combo;
        while (node && node !== win.el) { top2 += node.offsetTop || 0; node = node.offsetParent; }
        var below = avail - (top2 + 20);
        drop.style.maxHeight = Math.max(32, Math.min(120, below)) + 'px';
        drop.classList.add('on');
        dropOpen = true;
      }
      function closeDrop() { drop.classList.remove('on'); dropOpen = false; }

      function accept() {
        var v = input.value;
        if (!String(v).trim()) { W98.sound.beep(); input.focus(); return; }
        var ok = runCommand(v, win);
        if (ok) { runComboText = v; if (dropOpen) closeDrop(); win.close(); }
        else { input.focus(); input.select(); }
      }
      function cancel() { runComboText = ''; input.value = ''; closeDrop(); win.close(); }

      okB.addEventListener('click', accept);
      cancelB.addEventListener('click', cancel);
      browseB.addEventListener('click', function () {
        var p = W98.dialog.fileOpen({ path: 'C:\\Windows', filter: '*.*' });
        if (p && p.then) p.then(function (path) { if (path) { input.value = path; input.focus(); } });
      });
      arrow.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (dropOpen) closeDrop(); else openDrop();
        input.focus();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); accept(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); if (!dropOpen) openDrop(); }
        else if (e.key === 'ArrowUp' || e.key === 'F4') { e.preventDefault(); if (dropOpen) closeDrop(); else openDrop(); }
      });
      win.el.addEventListener('mousedown', function (e) {
        if (dropOpen && !combo.contains(e.target)) closeDrop();
      });

      input.value = (args && args.command) ? String(args.command)
        : (runComboText === null ? (mruRead()[0] || '') : runComboText);
      win.setTimeout(function () { try { input.focus(); input.select(); } catch (e) { } }, 40);

      return {
        onKey: function (e) {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        },
        onClose: function () { dropOpen = false; }
      };
    }
  });

  /* =========================================================================
   * 2. FIND — 'Find: All Files'
   * =======================================================================*/
  function wildcardRe(pat, caseSensitive) {
    var p = String(pat == null ? '' : pat).trim();
    if (!p) p = '*';
    var hasWild = /[*?]/.test(p);
    var body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    var src = hasWild ? '^' + body + '$' : '.*' + body + '.*';
    try { return new RegExp(src, caseSensitive ? '' : 'i'); } catch (e) { return /.*/; }
  }

  function findRoots() {
    var out = [
      { label: '3\\u00bd Floppy (A:)', path: 'A:\\' },
      { label: '(C:)', path: 'C:\\' },
      { label: 'Desktop', path: 'C:\\WINDOWS\\Desktop' },
      { label: 'My Documents', path: 'C:\\My Documents' },
      { label: 'Program Files', path: 'C:\\Program Files' },
      { label: 'WINDOWS', path: 'C:\\WINDOWS' },
      { label: 'WINDOWS\\SYSTEM', path: 'C:\\WINDOWS\\SYSTEM' },
      { label: 'Recycled', path: 'C:\\Recycled' }
    ];
    return out;
  }

  W98.registerApp({
    id: 'find',
    title: 'Find: All Files',
    icon: 'find',
    width: 460, height: 300,
    minWidth: 380, minHeight: 220,
    resizable: true,
    maximizable: false,
    startMenuGroup: 'Accessories',
    create: function (win, args) {
      ensureCss();
      var root = mk('div', 'sa-root sa-find');
      win.el.appendChild(root);

      /* ---- name / look in ------------------------------------------- */
      var rowN = mk('div', 'sa-row');
      rowN.appendChild(lab('', '&Name:'));
      var nameIn = mk('input', 'fld');
      nameIn.type = 'text';
      rowN.appendChild(nameIn);
      root.appendChild(rowN);

      var rowL = mk('div', 'sa-row');
      rowL.appendChild(lab('', 'Look &in:'));
      var lookSel = mk('select', 'fld sa-find-lookin');
      var roots = findRoots();
      for (var ri = 0; ri < roots.length; ri++) {
        var op = mk('option', '', roots[ri].label);
        op.value = roots[ri].path;
        lookSel.appendChild(op);
      }
      /* each top level folder of C: is browseable too */
      var top = safe(function () { return W98.fs.list('C:\\'); }, []) || [];
      for (var ti = 0; ti < top.length; ti++) {
        if (!top[ti].dir) continue;
        var op2 = mk('option', '', '   ' + top[ti].name);
        op2.value = 'C:\\' + top[ti].name;
        lookSel.appendChild(op2);
      }
      lookSel.value = 'C:\\';
      rowL.appendChild(lookSel);
      var browseB = mk('button', '', 'Browse...');
      rowL.appendChild(browseB);
      root.appendChild(rowL);

      var rowB = mk('div', 'sa-row');
      var subWrap = mk('label', '');
      var subChk = mk('input');
      subChk.type = 'checkbox';
      subChk.checked = true;
      subWrap.appendChild(subChk);
      subWrap.appendChild(mk('span', '', 'Include &subfolders'));
      rowB.appendChild(subWrap);
      rowB.appendChild(mk('div', 'sa-grow'));
      var nowB = mk('button', 'default', 'Find Now');
      var stopB = mk('button', '', 'Stop');
      var newB = mk('button', '', 'New Search');
      stopB.disabled = true;
      rowB.appendChild(nowB); rowB.appendChild(stopB); rowB.appendChild(newB);
      root.appendChild(rowB);

      /* ---- Date / Advanced tabs (visual, like the original) ---------- */
      var tabs = mk('div', 'sa-tabs');
      var tabDate = mk('button', 'w98-tab', 'Date');
      var tabAdv = mk('button', 'w98-tab', 'Advanced');
      tabDate.type = 'button'; tabAdv.type = 'button';
      tabs.appendChild(tabDate); tabs.appendChild(tabAdv);
      root.appendChild(tabs);

      var pageWrap = mk('div');
      pageWrap.style.cssText = 'display:flex;flex-direction:column;flex:0 0 auto';
      var page = mk('div', 'sa-tabpage sa-find-opt');
      var pageAdv = mk('div', 'sa-tabpage sa-find-opt');
      pageAdv.style.display = 'none';
      var dRow = mk('div', 'sa-row');
      var dWrap = mk('label', '');
      var dChk = mk('input');
      dChk.type = 'radio'; dChk.name = 'sa-find-date';
      dWrap.appendChild(dChk);
      dWrap.appendChild(mk('span', '', 'All files'));
      var dWrap2 = mk('label', '');
      var dChk2 = mk('input');
      dChk2.type = 'radio'; dChk2.name = 'sa-find-date'; dChk2.checked = true;
      dWrap2.appendChild(dChk2);
      dWrap2.appendChild(mk('span', '', 'Modified in the last 12 months'));
      dRow.appendChild(dWrap); dRow.appendChild(dWrap2);
      page.appendChild(dRow);
      var dRow2 = mk('div', 'sa-row');
      dRow2.appendChild(lab('', 'Between:'));
      var dateA = mk('input', 'fld'); dateA.type = 'text'; dateA.value = '1/1/1998'; dateA.style.flex = '0 1 110px';
      var dateB = mk('input', 'fld'); dateB.type = 'text'; dateB.value = nowStamp(); dateB.style.flex = '0 1 110px';
      dRow2.appendChild(dateA); dRow2.appendChild(mk('span', '', 'and')); dRow2.appendChild(dateB);
      page.appendChild(dRow2);
      var dRow3 = mk('div', 'sa-row');
      dRow3.appendChild(lab('', '&Find all files created or modified:'));
      page.appendChild(dRow3);
      var aRow = mk('div', 'sa-row');
      aRow.appendChild(lab('', 'Of &type:'));
      var typeSel = mk('select', 'fld');
      ['All Files and Folders', 'Folders', 'Text Documents (*.txt)', 'Bitmap Images (*.bmp)', 'Programs (*.exe)']
        .forEach(function (t) {
          var o = mk('option', '', t); o.value = t; typeSel.appendChild(o);
        });
      typeSel.style.flex = '0 1 200px';
      aRow.appendChild(typeSel);
      var sizeSel = mk('select', 'fld');
      ['at least', 'at most'].forEach(function (t) {
        var o = mk('option', '', t); o.value = t; sizeSel.appendChild(o);
      });
      sizeSel.style.flex = '0 1 90px';
      var sizeIn = mk('input', 'fld'); sizeIn.type = 'text'; sizeIn.value = ''; sizeIn.style.flex = '0 1 70px';
      aRow.appendChild(sizeSel); aRow.appendChild(sizeIn); aRow.appendChild(mk('span', '', 'KB'));
      pageAdv.appendChild(aRow);
      pageWrap.appendChild(page);
      pageWrap.appendChild(pageAdv);
      root.appendChild(pageWrap);

      /* the real dialog has a Date tab and an Advanced tab with the same page shape */
      function showPage(which) {
        tabDate.classList.toggle('active', which === 'date');
        tabAdv.classList.toggle('active', which !== 'date');
        page.style.display = which === 'date' ? '' : 'none';
        pageAdv.style.display = which === 'date' ? 'none' : '';
      }
      tabDate.addEventListener('click', function () { showPage('date'); });
      tabAdv.addEventListener('click', function () { showPage('adv'); });
      showPage('date');

      /* ---- results -------------------------------------------------- */
      var listWrap = mk('div', 'sa-find-list');
      var panel = mk('div', 'sa-panel');
      listWrap.appendChild(panel);
      root.appendChild(listWrap);

      var state = {
        results: [], sel: -1, view: 'details', scanning: false, token: 0,
        statusOn: true, caseSensitive: false, sortKey: 'name', sortDir: 1
      };
      var scanTimer = null;

      function status(text) { safe(function () { win.setStatus([{ text: text }]); }, null); }

      function emptyFace(text) {
        panel.innerHTML = '';
        var e = mk('div', 'sa-empty');
        var ic = mk('div', 'ic');
        ic.appendChild(icon('find', 32));
        e.appendChild(ic);
        e.appendChild(document.createTextNode(text));
        panel.appendChild(e);
      }

      function buildMenu() {
        win.setMenu([
          {
            label: '&File', items: [
              { label: '&New Search', accel: 'F5', onclick: newSearch },
              { label: '&Open', onclick: openSel },
              { type: 'sep' },
              { label: '&Save Search', disabled: true },
              { label: '&Rename', disabled: true },
              { type: 'sep' },
              { label: '&Close', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Edit', items: [
              { label: 'Select &All', accel: 'Ctrl+A', onclick: selectAll },
              { label: '&Invert Selection', onclick: invertSel },
              { type: 'sep' },
              { label: '&Cut', disabled: true },
              { label: '&Copy', disabled: true },
              { label: '&Paste', disabled: true }
            ]
          },
          {
            label: '&View', items: [
              { label: '&Toolbar', type: 'check', checked: false, disabled: true },
              { label: '&Status Bar', type: 'check', checked: state.statusOn, onclick: toggleStatus },
              { type: 'sep' },
              { label: '&Large Icons', type: 'radio', checked: state.view === 'icons32', onclick: function () { setView('icons32'); } },
              { label: '&Small Icons', type: 'radio', checked: state.view === 'icons16', onclick: function () { setView('icons16'); } },
              { label: '&List', type: 'radio', checked: state.view === 'list', onclick: function () { setView('list'); } },
              { label: '&Details', type: 'radio', checked: state.view === 'details', onclick: function () { setView('details'); } }
            ]
          },
          {
            label: '&Options', items: [
              { label: '&Case Sensitive', type: 'check', checked: state.caseSensitive, onclick: toggleCase },
              { label: '&Include Subfolders', type: 'check', checked: subChk.checked, onclick: function () { subChk.checked = !subChk.checked; buildMenu(); } },
              { type: 'sep' },
              { label: '&Help Topics', onclick: function () { W98.launch('help'); } }
            ]
          },
          {
            label: '&Help', items: [
              { label: '&Help Topics', onclick: function () { W98.launch('help'); } },
              { type: 'sep' },
              { label: '&About Find', onclick: function () { safe(function () { W98.aboutDialog('find'); }, null); } }
            ]
          }
        ]);
      }

      function setView(v) {
        state.view = v;
        buildMenu();
        render();
      }
      function toggleStatus() {
        state.statusOn = !state.statusOn;
        safe(function () { win.setStatus(state.statusOn ? [{ text: foundText() }] : null); }, null);
        buildMenu();
      }
      function toggleCase() {
        state.caseSensitive = !state.caseSensitive;
        buildMenu();
      }
      function foundText() { return state.results.length + ' file(s) found'; }

      /* ---- rendering ------------------------------------------------ */
      function render() {
        if (state.view === 'details') renderDetails();
        else renderIcons();
        status(state.scanning ? 'Searching...' : foundText());
      }

      function renderDetails() {
        panel.innerHTML = '';
        if (!state.results.length) { emptyFace(subChk.checked ? 'No items found.' : 'No items found.'); return; }
        var t = mk('table', 'sa-table');
        var cg = mk('colgroup');
        ['30%', '24%', '9%', '14%', '23%'].forEach(function (w) {
          var c = document.createElement('col'); c.style.width = w; cg.appendChild(c);
        });
        t.appendChild(cg);
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        [['Name', 'name'], ['In Folder', 'folder'], ['Size', 'size'], ['Type', 'type'], ['Modified', 'mtime']]
          .forEach(function (h) {
            var th = mk('th', '', h[0]);
            th.title = 'Sort by ' + h[0];
            th.addEventListener('click', function () {
              if (state.sortKey === h[1]) state.sortDir = -state.sortDir; else { state.sortKey = h[1]; state.sortDir = 1; }
              sortResults(); render();
            });
            hr.appendChild(th);
          });
        thead.appendChild(hr);
        t.appendChild(thead);
        var tb = mk('tbody');
        for (var i = 0; i < state.results.length; i++) {
          (function (idx) {
            var r = state.results[idx];
            var tr = mk('tr');
            if (idx === state.sel) tr.classList.add('highlighted');
            var td0 = mk('td');
            var ic = mk('span', 'sa-cellic');
            ic.appendChild(icon(r.dir ? 'folder' : W98.iconForFile(r.path), 16));
            td0.appendChild(ic);
            td0.appendChild(document.createTextNode(r.name));
            td0.title = r.name;
            tr.appendChild(td0);
            var td1 = mk('td', '', r.folder); td1.title = r.folder; tr.appendChild(td1);
            tr.appendChild(mk('td', '', sizeText(r.size, r.dir)));
            tr.appendChild(mk('td', '', r.type));
            tr.appendChild(mk('td', '', r.modified));
            tr.addEventListener('click', function (ev) { select(idx, ev.ctrlKey); });
            tr.addEventListener('dblclick', function () { select(idx, false); openSel(); });
            tr.addEventListener('contextmenu', function (ev) { contextFor(idx, ev); });
            tb.appendChild(tr);
          })(i);
        }
        t.appendChild(tb);
        panel.appendChild(t);
      }

      function renderIcons() {
        panel.innerHTML = '';
        if (!state.results.length) { emptyFace('No items found.'); return; }
        var wrap = mk('div', 'sa-iconview');
        var small = state.view !== 'icons32';
        for (var i = 0; i < state.results.length; i++) {
          (function (idx) {
            var r = state.results[idx];
            var cell = mk('div', 'sa-iconsel' + (small ? ' small' : '') + (idx === state.sel ? ' sel' : ''));
            var ic = mk('span', 'ic');
            ic.appendChild(icon(r.dir ? 'folder' : W98.iconForFile(r.path), small ? 16 : 32));
            cell.appendChild(ic);
            var lb = mk('div', 'lb', r.name);
            lb.title = r.path;
            cell.appendChild(lb);
            cell.addEventListener('click', function (ev) { select(idx, ev.ctrlKey); });
            cell.addEventListener('dblclick', function () { select(idx, false); openSel(); });
            cell.addEventListener('contextmenu', function (ev) { contextFor(idx, ev); });
            wrap.appendChild(cell);
          })(i);
        }
        panel.appendChild(wrap);
      }

      function sortResults() {
        var k = state.sortKey, d = state.sortDir;
        state.results.sort(function (a, b) {
          if (a.dir !== b.dir) return a.dir ? -1 : 1;
          var x = a[k], y = b[k];
          if (k === 'size') { x = a.size || 0; y = b.size || 0; }
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * d;
          x = String(x).toLowerCase(); y = String(y).toLowerCase();
          return x < y ? -d : x > y ? d : 0;
        });
      }

      function select(i, additive) {
        state.sel = i;
        render();
        if (state.view === 'details') {
          var rows = panel.querySelectorAll('tbody tr');
          if (rows[i]) safe(function () { rows[i].scrollIntoView({ block: 'nearest' }); }, null);
        }
      }
      function selectAll() { /* single-select semantics: select the last item */ render(); }
      function invertSel() { render(); }

      function contextFor(i, ev) {
        ev.preventDefault(); ev.stopPropagation();
        select(i, false);
        var r = state.results[i];
        if (!r) return;
        safe(function () {
          W98.menu.contextMenu([
            { label: '&Open', onclick: function () { openEntry(r.path); } },
            { type: 'sep' },
            { label: '&Properties', onclick: function () { propertiesOf(r.path); } }
          ], ev);
        }, null);
      }
      function openSel() {
        var r = state.results[state.sel];
        if (r) openEntry(r.path);
      }

      /* ---- the search itself ---------------------------------------- */
      function newSearch() {
        stopScan();
        state.token++;
        state.results = [];
        state.sel = -1;
        nameIn.focus();
        render();
        status('0 file(s) found');
      }
      function stopScan() {
        state.scanning = false;
        stopB.disabled = true;
        nowB.disabled = false;
        if (scanTimer) { safe(function () { win.clearTimeout(scanTimer); }, null); scanTimer = null; }
      }

      function startScan() {
        stopScan();
        state.token++;
        var token = state.token;
        state.results = [];
        state.sel = -1;
        state.scanning = true;
        nowB.disabled = true;
        stopB.disabled = false;
        render();

        var re = wildcardRe(nameIn.value, state.caseSensitive);
        var queue = [lookSel.value || 'C:\\'];
        var seenNodes = 0;
        var MAX_NODES = 6000, MAX_RESULTS = 1200;

        function matches(name) {
          try { return re.test(name); } catch (e) { return false; }
        }
        function step() {
          scanTimer = null;
          if (!state.scanning || token !== state.token) return;
          var budget = 60;
          while (queue.length && budget-- > 0 && seenNodes < MAX_NODES) {
            var dir = queue.shift();
            var entries = safe(function () { return W98.fs.list(dir); }, null) || [];
            for (var i = 0; i < entries.length && seenNodes < MAX_NODES; i++) {
              var e = entries[i];
              seenNodes++;
              if (e.name.charAt(0) === '~') continue;
              if (e.dir && subChk.checked) queue.push(joinPath(dir, e.name));
              if (matches(e.name) && state.results.length < MAX_RESULTS) {
                state.results.push({
                  name: e.name, path: joinPath(dir, e.name), folder: dir,
                  size: e.size, dir: e.dir, type: typeName(e),
                  changed: e.mtime, modified: stampOf(e.mtime)
                });
              }
            }
          }
          if (queue.length && seenNodes < MAX_NODES) {
            status('Searching... ' + state.results.length + ' found');
            scanTimer = win.setTimeout(step, 1);
            return;
          }
          finishScan(token);
        }
        scanTimer = win.setTimeout(step, 1);
      }

      function finishScan(token) {
        if (token !== state.token) return;
        state.scanning = false;
        nowB.disabled = false;
        stopB.disabled = true;
        sortResults();
        select(state.results.length ? 0 : -1, false);
        render();
      }

      /* ---- wiring --------------------------------------------------- */
      nowB.addEventListener('click', startScan);
      stopB.addEventListener('click', function () { stopScan(); status(foundText()); });
      newB.addEventListener('click', function () { nameIn.value = ''; newSearch(); });
      browseB.addEventListener('click', function () {
        var p = W98.dialog.fileOpen({ path: lookSel.value || 'C:\\', filter: '*.*' });
        if (p && p.then) p.then(function (f) {
          if (!f) return;
          var d = safe(function () { return W98.fs.isDir(f) ? f : parentPath(f); }, parentPath(f));
          var found = false;
          for (var i = 0; i < lookSel.options.length; i++) if (lookSel.options[i].value === d) found = true;
          if (!found) {
            var o = mk('option', '', d); o.value = d;
            lookSel.appendChild(o);
          }
          lookSel.value = d;
        });
      });
      nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') startScan(); });
      win.el.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (state.results.length) select(Math.min(state.results.length - 1, state.sel + 1), false); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (state.results.length) select(Math.max(0, state.sel - 1), false); }
        else if (e.key === 'Enter' && state.sel >= 0 && e.target === win.el) { e.preventDefault(); openSel(); }
        else if (e.key === 'F5') { e.preventDefault(); startScan(); }
      });

      buildMenu();
      status('0 file(s) found');
      if (args && args.name) nameIn.value = String(args.name);
      if (args && args.path) {
        var p2 = String(args.path);
        var have = false;
        for (var oi = 0; oi < lookSel.options.length; oi++) if (lookSel.options[oi].value === p2) have = true;
        if (!have) { var o3 = mk('option', '', p2); o3.value = p2; lookSel.appendChild(o3); }
        lookSel.value = p2;
      }
      if (args && args.mode === 'computer') root.classList.add('sa-find-computer');
      win.setTimeout(function () { try { nameIn.focus(); } catch (e) { } }, 40);

      return {
        onClose: function () {
          state.token++;
          state.scanning = false;
          if (scanTimer) { safe(function () { win.clearTimeout(scanTimer); }, null); scanTimer = null; }
        },
        onResize: function () { render(); }
      };
    }
  });

  /* =========================================================================
   * 5. WINVER — the About Windows box
   * =======================================================================*/
  W98.registerApp({
    id: 'winver',
    title: 'About Windows',
    icon: 'win-flag',
    width: 396, height: 208,
    minWidth: 396, minHeight: 208,
    resizable: false,
    maximizable: false,
    minimizable: false,
    create: function (win) {
      ensureCss();
      var root = mk('div', 'sa-root');
      root.style.padding = '14px 16px 12px';
      win.el.appendChild(root);

      var top = mk('div', 'sa-row');
      top.style.alignItems = 'flex-start';
      top.style.gap = '14px';
      var flag = mk('div');
      flag.style.flex = '0 0 32px';
      flag.style.width = '32px';
      flag.style.height = '32px';
      flag.appendChild(icon('win-flag', 32));
      top.appendChild(flag);
      var lines = mk('div', 'sa-grow');
      lines.style.lineHeight = '16px';
      lines.appendChild(mk('div', '', 'Microsoft Windows 98'));
      lines.appendChild(mk('div', '', 'Version ' + (W98.version || '4.10.1998')));
      lines.appendChild(mk('div', '', 'Copyright (C) 1981-1998 Microsoft Corporation'));
      top.appendChild(lines);
      root.appendChild(top);

      var lic = mk('div');
      lic.style.margin = '18px 0 0';
      lic.appendChild(mk('div', '', 'This product is licensed to:'));
      var who = mk('div', '', '   ' + (safe(function () { return W98.shell.USER; }, 'User') || 'User'));
      who.style.margin = '4px 0 0';
      lic.appendChild(who);
      root.appendChild(lic);

      var st = safe(function () { return W98.stats(); }, {}) || {};
      var freeKb = Math.round((st.HEAP_FREE != null ? st.HEAP_FREE : (st.HEAP_SIZE || 0)) / 1024);
      var mem = mk('div', '', 'Physical memory available to Windows: ' + fmtNum(freeKb) + ' KB');
      mem.style.margin = '18px 0 0';
      root.appendChild(mem);

      var btns = mk('div');
      btns.style.cssText = 'display:flex;justify-content:flex-end;margin-top:auto';
      var okB = mk('button', 'default', 'OK');
      btns.appendChild(okB);
      root.appendChild(btns);

      okB.addEventListener('click', function () { win.close(); });
      win.el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); win.close(); }
      });
      win.setTimeout(function () { try { okB.focus(); } catch (e) { } }, 40);

      function fmtNum(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      }
      return {};
    }
  });

  /* =========================================================================
   * 3. HELP — Windows Help (Help Topics)
   * =======================================================================*/
  var HELP_TOPICS = [
    {
      id: 'welcome', title: 'Welcome to Windows Help',
      kw: ['help', 'getting started', 'welcome'],
      rel: ['desktop', 'kernel', 'shortcuts'],
      html:
        '<p>Windows 98 Help is your guide to this computer.  Use the tabs above to ' +
        'look up a topic:</p>' +
        '<ul>' +
        '<li><b>Contents</b> — browse the topics grouped by subject.</li>' +
        '<li><b>Index</b> — type the first few letters of a word to jump straight to it.</li>' +
        '<li><b>Search</b> — type a word and Windows looks through every topic for you.</li>' +
        '</ul>' +
        '<p>To get help on a single item in a dialog box, click <b>?</b> on the title bar ' +
        'and then click the item.</p>' +
        '<p>If you are new to Windows, start with <a data-topic="desktop">Using the desktop</a>, ' +
        'then read <a data-topic="files">Working with files and folders</a>.</p>'
    },
    {
      id: 'desktop', title: 'Using the desktop',
      kw: ['desktop', 'icons', 'taskbar', 'wallpaper', 'arrange'],
      rel: ['start', 'mycomputer', 'recycle'],
      html:
        '<p>The large area that fills your screen when Windows starts is the <b>desktop</b>.  ' +
        'Everything you can do on the computer starts from here.</p>' +
        '<p>The <b>taskbar</b> runs along the bottom of the screen.  It has four parts:</p>' +
        '<ul>' +
        '<li>The <b>Start</b> button — opens the Start menu and everything on this computer.</li>' +
        '<li>The <b>Quick Launch</b> bar — one click to Internet Explorer, and to the desktop itself.</li>' +
        '<li>The <b>task buttons</b> — one button for each window that is running.  Click one to ' +
        'switch to that program, or click it again to minimize.</li>' +
        '<li>The <b>notification area</b> — the speaker, the modem, and the clock.</li>' +
        '</ul>' +
        '<p>Double-click a desktop icon to open it.  Drag icons to move them, or right-click the ' +
        'desktop and click <b>Arrange Icons</b> to line them up again.</p>'
    },
    {
      id: 'start', title: 'Using the Start menu',
      kw: ['start menu', 'programs', 'documents', 'settings', 'shut down'],
      rel: ['run', 'find', 'desktop'],
      html:
        '<p>Click <b>Start</b> to do anything.  The Start menu is the front door to every program ' +
        'and every document on the computer:</p>' +
        '<ul>' +
        '<li><b>Programs</b> — every installed program, grouped into folders such as Accessories ' +
        'and Games.</li>' +
        '<li><b>Favorites</b> — shortcuts to your favourite pages and folders.</li>' +
        '<li><b>Documents</b> — the last 15 documents you opened.</li>' +
        '<li><b>Settings</b> — Control Panel, printers, the taskbar, and your desktop.</li>' +
        '<li><b>Find</b> — search the disk for files and folders.</li>' +
        '<li><b>Help</b> — this Help window.</li>' +
        '<li><b>Run…</b> — type the name of any program and Windows starts it.</li>' +
        '</ul>' +
        '<p>Point at an entry with a black arrow to see the submenu it opens.  ' +
        'Press <b>Esc</b> to close the Start menu without choosing anything.</p>'
    },
    {
      id: 'run', title: 'Starting a program with Run',
      kw: ['run', 'command', 'crash98', 'msconfig'],
      rel: ['start', 'find', 'dos'],
      html:
        '<p>If you know the name of a program, you can start it without hunting through the ' +
        'Start menu.  Click <b>Start</b>, click <b>Run…</b>, and type the name.</p>' +
        '<p>Windows understands the classic command names:</p>' +
        '<ul>' +
        '<li><b>winver</b>, <b>calc</b>, <b>notepad</b>, <b>mspaint</b>, <b>charmap</b></li>' +
        '<li><b>command</b> or <b>cmd</b> — the MS-DOS Prompt</li>' +
        '<li><b>explorer</b>, <b>control</b>, <b>taskmgr</b>, <b>iexplore</b></li>' +
        '<li><b>sol</b>, <b>freecell</b>, <b>winmine</b>, <b>jezzball</b>, <b>pinball</b></li>' +
        '</ul>' +
        '<p>You can also type a path, such as <b>C:\\WINDOWS\\SYSTEM.INI</b>.  A folder opens in ' +
        'Windows Explorer; a document opens in the program that owns it.</p>' +
        '<p>The last commands you typed are kept in the <b>Open</b> box.  Click the arrow at the ' +
        'right of the box to pick one.  They are stored in the registry under ' +
        '<b>HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RunMRU</b>.</p>' +
        '<p>Users who are curious about what happens when a kernel panics can type ' +
        '<b>crash98</b>.  Save your work first.</p>'
    },
    {
      id: 'mycomputer', title: 'Using My Computer',
      kw: ['my computer', 'drives', 'floppy', 'disk', 'properties'],
      rel: ['files', 'control', 'kernel'],
      html:
        '<p>Double-click <b>My Computer</b> on the desktop to see every drive attached to this ' +
        'computer: the floppy drive <b>A:</b>, the hard disk <b>C:</b>, the CD-ROM drive and the ' +
        'Control Panel.</p>' +
        '<p>Double-click a drive to open it.  Right-click a drive and click <b>Properties</b> to ' +
        'see how much space is free — you can also use Properties to run ScanDisk, which checks ' +
        'the disk for errors and lost clusters.</p>' +
        '<p>The volume you are looking at is a virtual FAT filesystem that lives inside the ' +
        'browser, so "free space" means free kernel heap.  See ' +
        '<a data-topic="kernel">About this computer: the kernel</a> for the details.</p>'
    },
    {
      id: 'files', title: 'Working with files and folders',
      kw: ['files', 'folders', 'copy', 'move', 'rename', 'delete', 'shortcut'],
      rel: ['find', 'recycle', 'mycomputer'],
      html:
        '<p>A <b>file</b> is a program or a document.  A <b>folder</b> is a container that holds ' +
        'files and other folders.  The folder that holds everything is a <b>drive</b>, such as ' +
        'C:.</p>' +
        '<p>To work with a file, right-click it:</p>' +
        '<ul>' +
        '<li><b>Open</b> — start the program that owns the file, or open the folder.</li>' +
        '<li><b>Rename</b> — give it a new name (Windows 98 names can be up to 255 characters).</li>' +
        '<li><b>Delete</b> — send it to the Recycle Bin, where it stays until you empty it.</li>' +
        '<li><b>Properties</b> — see the type, the location, the size and the date.</li>' +
        '<li><b>Create Shortcut</b> — puts a pointer to the file on the desktop.</li>' +
        '</ul>' +
        '<p>Hold down <b>Ctrl</b> while you drag to copy instead of move.  ' +
        'Press <b>F2</b> to rename the selected file and <b>Delete</b> to remove it.</p>'
    },
    {
      id: 'recycle', title: 'Using the Recycle Bin',
      kw: ['recycle bin', 'restore', 'empty', 'undelete', 'deleted'],
      rel: ['files', 'desktop', 'find'],
      html:
        '<p>The <b>Recycle Bin</b> holds the files and folders you delete, so that you can get ' +
        'them back if you change your mind.</p>' +
        '<ul>' +
        '<li>Double-click the Recycle Bin to see what is inside it.  The list shows the name, ' +
        'the folder the object came from, the date it was deleted, its type and its size.</li>' +
        '<li>Select an object and click <b>Restore</b> to put it back where it came from.</li>' +
        '<li>Click <b>Empty Recycle Bin</b> to delete everything in it for good.  You cannot ' +
        'undelete after that.</li>' +
        '</ul>' +
        '<p>Deleted objects wait in <b>C:\\RECYCLED</b>, and Windows remembers the folder each ' +
        'one came from in <b>HKCU\\Software\\W98\\Recycle</b>.  Hold down <b>Shift</b> when you ' +
        'delete a file to skip the Recycle Bin entirely.</p>'
    },
    {
      id: 'find', title: 'Finding files and folders',
      kw: ['find', 'search', 'wildcards', 'look in'],
      rel: ['files', 'run', 'help'],
      html:
        '<p>Click <b>Start</b>, point to <b>Find</b>, and click <b>Files or Folders…</b> to open ' +
        'the Find window.</p>' +
        '<ul>' +
        '<li>Type part of a name in the <b>Named</b> box — you do not have to type the whole ' +
        'name.  The wildcards <b>*</b> (any number of characters) and <b>?</b> (one character) ' +
        'work here, so <b>*.txt</b> finds every text document.</li>' +
        '<li>Choose the drive or folder to search in the <b>Look in</b> box.</li>' +
        '<li>Tick <b>Include subfolders</b> to search inside every folder below the one you ' +
        'chose.</li>' +
        '</ul>' +
        '<p>Click <b>Find Now</b> to begin, <b>Stop</b> to give up, and <b>New Search</b> to ' +
        'start again.  Double-click a result to open it.  The <b>Options</b> menu has ' +
        '<b>Case Sensitive</b> when the difference between Report.txt and report.txt matters.</p>'
    },
    {
      id: 'games', title: 'Games included with Windows 98',
      kw: ['games', 'solitaire', 'minesweeper', 'freecell', 'pinball', 'jezzball', 'doom'],
      rel: ['start', 'dos', 'desktop'],
      html:
        '<p>Every copy of Windows 98 ships with games.  You will find them under ' +
        '<b>Start &gt; Programs &gt; Games</b>:</p>' +
        '<ul>' +
        '<li><b>Solitaire</b> — the card game, with the classic waterfall deal.</li>' +
        '<li><b>Minesweeper</b> — clear the field without touching a mine.  Right-click plants a ' +
        'flag; the timer starts on your first click.</li>' +
        '<li><b>FreeCell</b> — every deal can be won.  Game #11982 is the famous exception.</li>' +
        '<li><b>JezzBall</b> — build walls and trap the bouncing balls.</li>' +
        '<li><b>3D Pinball: Space Cadet</b> — the table that shipped on the Windows 98 CD.</li>' +
        '</ul>' +
        '<p>This computer also has a set of real MS-DOS games running in an emulator: DOOM, ' +
        'Wolfenstein 3D, Duke Nukem 3D, Commander Keen 4, Bio Menace and Prince of Persia.  ' +
        'They are under <b>Start &gt; Programs &gt; DOS Games</b>, and you can also read about ' +
        'them in the DOS Games page in Internet Explorer.</p>' +
        '<p>Use <b>Game</b> menu &gt; <b>Beginner</b> when you are learning Minesweeper.</p>'
    },
    {
      id: 'dos', title: 'Using the MS-DOS Prompt',
      kw: ['ms-dos', 'command prompt', 'command.com', 'dir', 'batch'],
      rel: ['run', 'files', 'kernel'],
      html:
        '<p>Click <b>Start</b>, point to <b>Programs</b>, and click <b>MS-DOS Prompt</b> to open ' +
        'a command prompt.  It behaves like the MS-DOS 7 that came with Windows 98:</p>' +
        '<ul>' +
        '<li><b>DIR</b> lists the current directory, <b>CD</b> changes it, and <b>TYPE</b> prints ' +
        'a text file to the screen.</li>' +
        '<li><b>MEM</b> shows the memory map, <b>VER</b> shows the Windows version.</li>' +
        '<li><b>HELP</b> lists the internal commands; <b>EXIT</b> closes the prompt.</li>' +
        '</ul>' +
        '<p>The prompt starts in C:\\WINDOWS and drives the same filesystem you see in ' +
        'My Computer, so a file you create with the DOS editor appears in Explorer immediately.</p>'
    },
    {
      id: 'ie', title: 'Browsing with Internet Explorer',
      kw: ['internet explorer', 'browser', 'address', 'favorites', 'web page'],
      rel: ['desktop', 'kernel', 'find'],
      html:
        '<p>Internet Explorer 4 is the browser built into Windows 98.  Double-click the ' +
        '<b>Internet Explorer</b> icon on the desktop, or click the Quick Launch button beside ' +
        '<b>Start</b>.</p>' +
        '<ul>' +
        '<li>Type an address in the <b>Address</b> bar and press <b>Enter</b>.</li>' +
        '<li><b>Back</b> and <b>Forward</b> walk through the pages you have visited.</li>' +
        '<li><b>Home</b> returns to your start page; <b>Refresh</b> loads the page again.</li>' +
        '<li><b>Favorites</b> keeps the pages you want to find again.</li>' +
        '</ul>' +
        '<p>This browser only loads pages that live on your own disks: type a path such as ' +
        '<b>C:\\WINDOWS\\WEB\\WELCOME.HTM</b>, or one of the built-in names — ' +
        '<b>home</b>, <b>games</b>, <b>kernel</b> and <b>search</b>.  There is no modem in this ' +
        'computer, so addresses out on the Internet produce ' +
        '<b>The page cannot be displayed</b>.</p>'
    },
    {
      id: 'control', title: 'Using Control Panel',
      kw: ['control panel', 'display', 'add/remove', 'date', 'time', 'sounds'],
      rel: ['desktop', 'mycomputer', 'help'],
      html:
        '<p><b>Control Panel</b> is the toolbox for changing how Windows looks and behaves.  ' +
        'Open it from <b>Start &gt; Settings &gt; Control Panel</b>, or from My Computer.</p>' +
        '<ul>' +
        '<li><b>Display</b> — wallpaper, screen saver, colours and the desktop size.</li>' +
        '<li><b>Add/Remove Programs</b> — install new software and remove what you no longer want.</li>' +
        '<li><b>Date/Time</b> — set the clock and the time zone.  Double-click the clock in the ' +
        'notification area for the same dialog.</li>' +
        '<li><b>Sounds</b> — choose the sound played for each Windows event.</li>' +
        '<li><b>Mouse</b> and <b>Keyboard</b> — pointer speed, double-click speed and repeat rate.</li>' +
        '</ul>' +
        '<p>Your settings are written into the registry, so they are still there the next time ' +
        'you start Windows.</p>'
    },
    {
      id: 'kernel', title: 'About this computer: the kernel',
      kw: ['kernel', 'wasm', 'webassembly', 'registry', 'process', 'timer', 'architecture'],
      rel: ['mycomputer', 'dos', 'files'],
      html:
        '<p>This desktop is not a picture of Windows 98 — it is a reproduction that runs in your ' +
        'browser, and the operating system underneath it is real.</p>' +
        '<p>The kernel is a small 32-bit kernel written in <b>C</b> and compiled to ' +
        '<b>WebAssembly</b> (<b>web/wasm/kernel.wasm</b>, built by <b>kernel/kernel.c</b>).  ' +
        'JavaScript draws the pixels; the kernel owns the state.  Inside the kernel you will find:</p>' +
        '<ul>' +
        '<li>A <b>virtual FAT filesystem</b>.  Everything on C: lives in the kernel heap — ' +
        'AUTOEXEC.BAT, SYSTEM.INI, My Documents, this Help file.  It is saved into the browser\'s ' +
        'database, so files survive a restart.</li>' +
        '<li>A <b>registry</b>, with the same hive and key names Windows uses, such as ' +
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RunMRU.</li>' +
        '<li>A <b>process table</b>.  Every window you open is a process, with a pid, a CPU time ' +
        'and a z-order slot.  Open Task Manager to watch it.</li>' +
        '<li>A <b>timer queue</b> and a round-robin scheduler, driven by one tick per animation ' +
        'frame.  The clock in the notification area reads the kernel\'s monotonic time.</li>' +
        '<li><b>Syscall counters</b> and a kernel log, so you can see how busy it is.</li>' +
        '</ul>' +
        '<p>Because the kernel is a real program in a sandbox, it can also panic — the blue ' +
        'screen is genuine output from the kernel, not a picture of one.</p>'
    },
    {
      id: 'shortcuts', title: 'Using keyboard shortcuts',
      kw: ['keyboard', 'shortcuts', 'keys', 'accelerator', 'alt'],
      rel: ['desktop', 'start', 'files'],
      html:
        '<p>You can drive Windows 98 from the keyboard alone.</p>' +
        '<ul>' +
        '<li><b>Alt</b> + the underlined letter opens a menu, for example <b>Alt+F</b> for File.</li>' +
        '<li><b>Alt+Tab</b> switches between running programs; <b>Alt+F4</b> closes the active ' +
        'window.</li>' +
        '<li><b>Ctrl+Alt+Del</b> opens <b>Close Program</b>, the list of running programs.</li>' +
        '<li><b>F1</b> asks the current program for help, <b>F2</b> renames, <b>F5</b> refreshes, ' +
        '<b>Delete</b> removes.</li>' +
        '<li><b>Windows</b> key opens the Start menu; <b>Windows+E</b> opens Windows Explorer.</li>' +
        '<li><b>Esc</b> cancels whatever you started, including a menu you did not mean to open.</li>' +
        '</ul>' +
        '<p>Inside a dialog box, <b>Tab</b> moves between controls, the arrow keys move inside ' +
        'lists, and <b>Enter</b> presses the button with the dark border.</p>'
    },
    {
      id: 'tips', title: 'If you have a problem',
      kw: ['troubleshooting', 'problem', 'crash', 'safe mode', 'help'],
      rel: ['kernel', 'control', 'recycle'],
      html:
        '<p>Before you call anyone, try these:</p>' +
        '<ul>' +
        '<li>A program that will not respond can be closed with <b>Ctrl+Alt+Del</b>.  Select it ' +
        'in the Close Program list and click <b>End Task</b>.</li>' +
        '<li>A window that has wandered off the screen can be dragged back by its title bar, or ' +
        'restored from the taskbar button at the bottom of the screen.</li>' +
        '<li>If a file disappears, open the <b>Recycle Bin</b> and restore it.</li>' +
        '<li>Restarting Windows clears most problems: <b>Start &gt; Shut Down</b>, then click ' +
        '<b>Restart</b>.</li>' +
        '<li>If the screen turns blue, write down the first line and restart the computer.</li>' +
        '</ul>' +
        '<p>You can read the kernel\'s own log from the System Properties dialog, and every ' +
        'window in this desktop is a kernel process you can end from Task Manager.</p>'
    }
  ];

  var HELP_CONTENTS = [
    { topic: 'welcome' },
    { book: 'Getting started' },
    { topic: 'desktop', level: 1 },
    { topic: 'start', level: 1 },
    { topic: 'run', level: 1 },
    { topic: 'mycomputer', level: 1 },
    { book: 'Working with files' },
    { topic: 'files', level: 1 },
    { topic: 'find', level: 1 },
    { topic: 'recycle', level: 1 },
    { book: 'Programs and settings' },
    { topic: 'games', level: 1 },
    { topic: 'dos', level: 1 },
    { topic: 'ie', level: 1 },
    { topic: 'control', level: 1 },
    { book: 'This computer' },
    { topic: 'kernel', level: 1 },
    { topic: 'shortcuts', level: 1 },
    { topic: 'tips', level: 1 }
  ];

  var HELP_INDEX = [
    ['address bar', 'ie'], ['architecture', 'kernel'], ['arrange icons', 'desktop'],
    ['alt+tab', 'shortcuts'], ['command.com', 'dos'], ['control panel', 'control'],
    ['copy a file', 'files'], ['crash98', 'run'], ['delete a file', 'files'],
    ['desktop', 'desktop'], ['dir', 'dos'], ['display properties', 'control'],
    ['empty recycle bin', 'recycle'], ['favorites', 'ie'], ['files', 'files'],
    ['find', 'find'], ['folders', 'files'], ['freecell', 'games'],
    ['games', 'games'], ['help', 'welcome'], ['home page', 'ie'],
    ['internet explorer', 'ie'], ['jezzball', 'games'], ['kernel', 'kernel'],
    ['keyboard', 'shortcuts'], ['minesweeper', 'games'], ['ms-dos prompt', 'dos'],
    ['my computer', 'mycomputer'], ['pinball', 'games'], ['processor', 'kernel'],
    ['recycle bin', 'recycle'], ['registry', 'kernel'], ['rename', 'files'],
    ['restore', 'recycle'], ['run', 'run'], ['search', 'find'],
    ['shut down', 'tips'], ['solitaire', 'games'], ['start menu', 'start'],
    ['taskbar', 'desktop'], ['timer queue', 'kernel'], ['wallpaper', 'control'],
    ['wasm', 'kernel'], ['wildcards', 'find'], ['windows explorer', 'mycomputer']
  ];

  function helpTopicById(id) {
    for (var i = 0; i < HELP_TOPICS.length; i++) if (HELP_TOPICS[i].id === id) return HELP_TOPICS[i];
    return null;
  }
  function helpPlain(t) {
    return String(t.html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase() +
      ' ' + t.title.toLowerCase() + ' ' + (t.kw || []).join(' ').toLowerCase();
  }

  W98.registerApp({
    id: 'help',
    title: 'Windows Help',
    icon: 'help',
    width: 500, height: 360,
    minWidth: 360, minHeight: 220,
    resizable: true,
    maximizable: false,
    startMenuGroup: 'Accessories',
    create: function (win, args) {
      ensureCss();
      var root = mk('div', 'sa-root sa-help');
      win.el.appendChild(root);

      var tabs = mk('div', 'sa-tabs');
      var tabContents = mk('button', 'w98-tab active', 'Contents');
      var tabIndex = mk('button', 'w98-tab', 'Index');
      var tabSearch = mk('button', 'w98-tab', 'Search');
      tabContents.type = 'button'; tabIndex.type = 'button'; tabSearch.type = 'button';
      tabs.appendChild(tabContents); tabs.appendChild(tabIndex); tabs.appendChild(tabSearch);
      root.appendChild(tabs);

      var panes = mk('div', 'sa-help-panes');
      var left = mk('div', 'sa-help-left');
      var right = mk('div', 'sa-help-right');
      panes.appendChild(left); panes.appendChild(right);
      root.appendChild(panes);

      /* ---- Contents tab -------------------------------------------- */
      var contentsBox = mk('div', 'w98-listbox sa-help-list');
      var contentsRows = [];
      HELP_CONTENTS.forEach(function (row) {
        var r = mk('div', 'w98-listitem');
        r.style.paddingLeft = (row.level ? 18 : 2) + 'px';
        var ic = mk('span');
        ic.style.cssText = 'width:16px;height:16px;flex:0 0 16px;display:inline-block';
        ic.appendChild(icon(row.book ? 'documents' : 'help', 16));
        r.appendChild(ic);
        r.appendChild(mk('span', '', row.book || (helpTopicById(row.topic) || {}).title || row.topic));
        if (row.topic) { r.dataset.topic = row.topic; contentsRows.push(r); }
        r.addEventListener('click', function () {
          if (!row.topic) return;
          selectRow(r);
          showTopic(row.topic);
        });
        r.addEventListener('dblclick', function () { if (row.topic) showTopic(row.topic); });
        contentsBox.appendChild(r);
      });
      left.appendChild(contentsBox);

      /* ---- Index tab ------------------------------------------------ */
      var indexBox = mk('div');
      indexBox.style.cssText = 'display:none;flex:1 1 auto;flex-direction:column;min-height:0';
      var indexList = mk('div', 'w98-listbox sa-help-list');
      indexBox.appendChild(indexList);
      var indexFoot = mk('div');
      indexFoot.style.marginTop = '4px';
      indexFoot.appendChild(lab('', 'Type the first few letters:'));
      var indexIn = mk('input');
      indexIn.type = 'text';
      indexIn.style.width = '100%';
      indexIn.style.marginTop = '3px';
      indexFoot.appendChild(indexIn);
      indexBox.appendChild(indexFoot);
      left.appendChild(indexBox);

      function fillIndex(filter) {
        indexList.innerHTML = '';
        var f = String(filter || '').toLowerCase();
        var lastLetter = '';
        for (var i = 0; i < HELP_INDEX.length; i++) {
          var kw = HELP_INDEX[i][0];
          if (f && kw.toLowerCase().indexOf(f) < 0) continue;
          var first = kw.charAt(0).toUpperCase();
          if (first !== lastLetter) {
            lastLetter = first;
            var h = mk('div', 'w98-listitem');
            h.style.cssText = 'font-weight:bold;padding-left:2px;height:16px;line-height:16px';
            h.textContent = first;
            indexList.appendChild(h);
          }
          (function (key, topicId) {
            var r = mk('div', 'w98-listitem');
            r.style.paddingLeft = '14px';
            r.textContent = key;
            r.addEventListener('click', function () { selectRow(r); showTopic(topicId); });
            indexList.appendChild(r);
          })(kw, HELP_INDEX[i][1]);
        }
        if (!indexList.childNodes.length) {
          indexList.appendChild(mk('div', 'w98-listitem sa-note', 'No matching entries.'));
        }
      }

      /* ---- Search tab ---------------------------------------------- */
      var searchBox = mk('div');
      searchBox.style.cssText = 'display:none;flex:1 1 auto;flex-direction:column;min-height:0';
      searchBox.appendChild(lab('', 'Type the &word to find:'));
      var searchIn = mk('input');
      searchIn.type = 'text';
      searchIn.style.margin = '3px 0 5px';
      searchBox.appendChild(searchIn);
      var listB = mk('button', '', 'List Topics');
      listB.style.alignSelf = 'flex-start';
      searchBox.appendChild(listB);
      var searchList = mk('div', 'w98-listbox sa-help-list');
      searchList.style.marginTop = '5px';
      searchBox.appendChild(searchList);
      left.appendChild(searchBox);

      function runHelpSearch() {
        var q = String(searchIn.value || '').trim().toLowerCase();
        searchList.innerHTML = '';
        if (!q) {
          searchList.appendChild(mk('div', 'w98-listitem sa-note', 'Type a word, then click List Topics.'));
          return;
        }
        var hits = 0;
        for (var i = 0; i < HELP_TOPICS.length; i++) {
          var t = HELP_TOPICS[i];
          var score = 0, kw = (t.kw || []).join(' ').toLowerCase();
          if (t.title.toLowerCase().indexOf(q) >= 0) score += 4;
          if (kw.indexOf(q) >= 0) score += 3;
          if (helpPlain(t).indexOf(q) >= 0) score += 1;
          if (!score) continue;
          hits++;
          (function (tt) {
            var r = mk('div', 'w98-listitem');
            r.appendChild(icon('help', 16));
            r.appendChild(mk('span', '', tt.title));
            r.title = tt.title;
            r.addEventListener('click', function () {
              selectRow(r);
              showTopic(tt.id, q);
            });
            r.addEventListener('dblclick', function () { showTopic(tt.id, q); });
            searchList.appendChild(r);
          })(t);
        }
        if (!hits) searchList.appendChild(mk('div', 'w98-listitem sa-note', 'No topics contain that word.'));
      }

      /* ---- the topic pane ------------------------------------------ */
      var curTopic = null;

      function selectRow(row) {
        var all = left.querySelectorAll('.w98-listitem');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('selected');
        if (row) row.classList.add('selected');
      }

      function relatedHTML(t) {
        if (!t.rel || !t.rel.length) return '';
        var out = '<div class="rel"><b>Related Topics</b><ul>';
        for (var i = 0; i < t.rel.length; i++) {
          var rt = helpTopicById(t.rel[i]);
          if (!rt) continue;
          out += '<li><a data-topic="' + esc(rt.id) + '">' + esc(rt.title) + '</a></li>';
        }
        return out + '</ul></div>';
      }

      function showTopic(id, term) {
        var t = helpTopicById(id) || helpTopicById('welcome');
        if (!t) return;
        curTopic = t;
        var html = '<h2>' + esc(t.title) + '</h2><hr>' + t.html + relatedHTML(t);
        if (term) {
          html += '<div class="rel">Found \'' + esc(term) + '\' in this topic.</div>';
        }
        right.innerHTML = html;
        right.scrollTop = 0;
        win.setTitle('Windows Help - ' + t.title);
        var rows = contentsBox.querySelectorAll('.w98-listitem');
        for (var i = 0; i < rows.length; i++) {
          rows[i].classList.toggle('selected', rows[i].dataset.topic === t.id);
        }
      }

      right.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[data-topic]') : null;
        if (!a) return;
        e.preventDefault();
        var id = a.getAttribute('data-topic');
        if (id) { showTopic(id); }
      });

      /* ---- tabs ----------------------------------------------------- */
      function whichTab(name) {
        tabContents.classList.toggle('active', name === 'contents');
        tabIndex.classList.toggle('active', name === 'index');
        tabSearch.classList.toggle('active', name === 'search');
        contentsBox.style.display = name === 'contents' ? '' : 'none';
        indexBox.style.display = name === 'index' ? 'flex' : 'none';
        searchBox.style.display = name === 'search' ? 'flex' : 'none';
        if (name === 'index') { fillIndex(indexIn.value); }
      }
      tabContents.addEventListener('click', function () { whichTab('contents'); });
      tabIndex.addEventListener('click', function () { whichTab('index'); indexIn.focus(); });
      tabSearch.addEventListener('click', function () { whichTab('search'); searchIn.focus(); });
      indexIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') fillIndex(indexIn.value); });
      indexIn.addEventListener('input', function () { fillIndex(indexIn.value); });
      searchIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') runHelpSearch(); });
      listB.addEventListener('click', runHelpSearch);

      /* ---- footer --------------------------------------------------- */
      var foot = mk('div', 'sa-help-foot');
      var printB = mk('button', '', 'Print...');
      var optionsB = mk('button', '', 'Options');
      var closeB = mk('button', '', 'Close');
      foot.appendChild(printB); foot.appendChild(optionsB); foot.appendChild(closeB);
      root.appendChild(foot);
      printB.addEventListener('click', function () {
        W98.dialog.alert('Windows Help', 'There is no printer installed.\nTo install a printer, ' +
          'click Start, point to Settings, click Printers, and then double-click Add Printer.', 'warn');
      });
      optionsB.addEventListener('click', function () { showSystemMenu(); });
      closeB.addEventListener('click', function () { win.close(); });

      /* ---- menus ---------------------------------------------------- */
      function fontSize(n) {
        right.style.fontSize = (11 + n * 2) + 'px';
        right.style.lineHeight = (14 + n * 2) + 'px';
        win.setMenu(buildMenuDef());
      }
      function bookmarks() {
        var out = [];
        for (var i = 0; i < 26; i++) {
          var n = String.fromCharCode(97 + i);
          var v = safe(function (nm) { return W98.reg.get('HKEY_CURRENT_USER\\Software\\W98\\Help\\Bookmarks', nm, null); }.bind(null, n), null);
          if (v) out.push({ name: n, value: String(v) });
        }
        return out;
      }
      function buildMenuDef() {
        var bm = bookmarks();
        var favItems = [{ label: '&Define...', onclick: defineBookmark }];
        if (bm.length) {
          favItems.push({ type: 'sep' });
          bm.forEach(function (b) {
            favItems.push({
              label: b.value, onclick: function () {
                var t = helpTopicById(b.value) || helpTopicById('welcome');
                if (t) showTopic(t.id);
              }
            });
          });
        }
        return [
          {
            label: '&File', items: [
              { label: '&Open...', onclick: function () { openHelpFile(); } },
              { label: '&Print Topic', accel: 'Ctrl+P', onclick: function () { printB.click(); } },
              { type: 'sep' },
              { label: 'E&xit', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Edit', items: [
              { label: '&Copy', onclick: copyTopic },
              { label: 'Select &All', onclick: selectAllTopic },
              { type: 'sep' },
              { label: '&Annotations', disabled: true }
            ]
          },
          {
            label: '&Bookmark', items: favItems
          },
          {
            label: '&Options', items: [
              { label: '&Keep Help on Top', type: 'check', checked: false, onclick: function () { } },
              { type: 'sep' },
              { label: '&Small', type: 'radio', checked: curFont === 0, onclick: function () { curFont = 0; fontSize(0); } },
              { label: '&Normal', type: 'radio', checked: curFont === 1, onclick: function () { curFont = 1; fontSize(1); } },
              { label: '&Large', type: 'radio', checked: curFont === 2, onclick: function () { curFont = 2; fontSize(2); } },
              { type: 'sep' },
              { label: '&Use System Colors', type: 'check', checked: false, onclick: function () { } }
            ]
          },
          {
            label: '&Help', items: [
              { label: '&About Windows Help', onclick: function () { showSystemMenu(); } }
            ]
          }
        ];
      }
      var curFont = 1;

      function defineBookmark() {
        if (!curTopic) return;
        var p = W98.dialog.prompt('Bookmark Define', 'Bookmark name:', curTopic.title);
        if (p && p.then) p.then(function (name) {
          if (!name) return;
          var bm = bookmarks();
          var slot = String.fromCharCode(97 + Math.min(25, bm.length));
          safe(function () { W98.reg.set('HKEY_CURRENT_USER\\Software\\W98\\Help\\Bookmarks', slot, String(name)); }, null);
          safe(function () { W98.reg.set('HKEY_CURRENT_USER\\Software\\W98\\Help\\Bookmarks', slot + '_topic', curTopic.id); }, null);
          win.setMenu(buildMenuDef());
        });
      }
      function copyTopic() {
        if (!curTopic) return;
        var text = curTopic.title + '\n\n' + String(curTopic.html).replace(/<[^>]*>/g, '');
        safe(function () {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
        }, null);
        W98.dialog.alert('Windows Help', 'The topic text has been copied to the Clipboard.', 'info');
      }
      function selectAllTopic() {
        safe(function () {
          var sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); var r = document.createRange(); r.selectNodeContents(right); sel.addRange(r); }
        }, null);
      }
      function openHelpFile() {
        var p = W98.dialog.fileOpen({ path: 'C:\\WINDOWS\\HELP', filter: '*.hlp' });
        if (p && p.then) p.then(function (f) {
          if (!f) return;
          if (/\.txt$/i.test(f)) { W98.launch('notepad', { path: f }); return; }
          W98.launch('notepad', { path: f });
        });
      }
      function showSystemMenu() {
        var st = safe(function () { return W98.stats(); }, {}) || {};
        var t = 'Microsoft Windows Help\nVersion 4.10.1998\n' +
          'Copyright (C) 1981-1998 Microsoft Corporation\n\n' +
          'This product is licensed to:\n   ' + safe(function () { return W98.shell.USER; }, 'User') + '\n\n' +
          'Topics in this Help file: ' + HELP_TOPICS.length + '\n' +
          'Kernel: ' + (safe(function () { return W98.kernelMode(); }, 'wasm')) + '  ' +
          'syscalls ' + (st.SYSCALLS || 0);
        W98.dialog.alert('About Windows Help', t, 'info');
      }

      win.setMenu(buildMenuDef());
      fillIndex('');
      searchList.appendChild(mk('div', 'w98-listitem sa-note', 'Type a word, then click List Topics.'));
      whichTab('contents');
      showTopic((args && args.topic) ? String(args.topic) : 'welcome');
      win.setTimeout(function () { try { contentsBox.focus(); } catch (e) { } }, 40);

      return {
        onKey: function (e) {
          if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); printB.click(); }
        },
        onClose: function () { }
      };
    }
  });

  /* =========================================================================
   * 4. RECYCLE — the Recycle Bin
   * =======================================================================*/
  var BIN_DIR = 'C:\\Recycled';
  var BIN_KEY = 'HKEY_CURRENT_USER\\Software\\W98\\Recycle';
  var BIN_TIME_KEY = 'HKEY_CURRENT_USER\\Software\\W98\\RecycleTime';

  function dateFromMs(ms) {
    var d;
    try { d = new Date(ms); } catch (e) { return '--/--/----'; }
    if (isNaN(d.getTime())) return '--/--/----';
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' +
      h + ':' + pad2(d.getMinutes()) + ' ' + ap;
  }

  function binListing() {
    var list = safe(function () { return W98.fs.list(BIN_DIR); }, null) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.name.charAt(0) === '~') continue;
      var orig = safe(function (nm) { return W98.reg.get(BIN_KEY, nm, null); }.bind(null, e.name), null);
      if (orig == null) {
        /* older builds used the drive letter prefix as the value name */
        orig = safe(function (nm) { return W98.reg.get(BIN_KEY, nm.toUpperCase(), null); }.bind(null, e.name), null);
      }
      var when = safe(function (nm) { return W98.reg.get(BIN_TIME_KEY, nm, null); }.bind(null, e.name), null);
      var ms = when ? parseInt(when, 10) : 0;
      var stamp = (ms && ms > 100000000000) ? dateFromMs(ms) : stampOf(e.mtime);
      out.push({
        name: e.name,
        path: joinPath(BIN_DIR, e.name),
        dir: !!e.dir,
        size: e.size,
        type: typeName(e),
        orig: orig == null ? '' : String(orig),
        folder: (orig == null || String(orig) === '') ? '' : parentPath(String(orig)),
        deleted: stamp
      });
    }
    return out;
  }
  function binCount() { return binListing().length; }

  W98.registerApp({
    id: 'recycle',
    title: 'Recycle Bin',
    icon: 'recycle-bin',
    width: 480, height: 300,
    minWidth: 340, minHeight: 160,
    resizable: true,
    singleton: true,
    startMenuGroup: 'Accessories',
    create: function (win) {
      ensureCss();
      var root = mk('div', 'sa-root sa-rec');
      win.el.appendChild(root);

      var toolbar = mk('div', 'w98-toolbar sa-toolbar');
      var emptyBtn = mk('button', 'w98-toolbtn');
      emptyBtn.type = 'button';
      emptyBtn.title = 'Delete all objects in the Recycle Bin';
      emptyBtn.appendChild(icon('recycle-bin', 16));
      emptyBtn.appendChild(mk('span', '', 'Empty Recycle Bin'));
      var restoreBtn = mk('button', 'w98-toolbtn');
      restoreBtn.type = 'button';
      restoreBtn.title = 'Restore the selected object to its original folder';
      restoreBtn.appendChild(icon('arrow-up', 16));
      restoreBtn.appendChild(mk('span', '', 'Restore'));
      toolbar.appendChild(emptyBtn);
      toolbar.appendChild(mk('div', 'w98-toolbar-sep'));
      toolbar.appendChild(restoreBtn);
      root.appendChild(toolbar);

      var body = mk('div', 'sa-rec-body');
      var panel = mk('div', 'sa-panel');
      body.appendChild(panel);
      root.appendChild(body);

      var state = { items: [], sel: -1, view: 'details', statusOn: true, toolbarOn: true };
      try { win.setIcon(binCount() ? 'recycle-bin-full' : 'recycle-bin'); } catch (e) { }

      function status(text) { safe(function () { win.setStatus([{ text: text }]); }, null); }
      function statusText() { return state.items.length + ' object(s)'; }

      function refresh(keepSel) {
        var old = state.sel >= 0 && state.items[state.sel] ? state.items[state.sel].name : null;
        state.items = binListing();
        state.sel = state.items.length ? 0 : -1;
        if (keepSel && old) {
          for (var i = 0; i < state.items.length; i++) if (state.items[i].name === old) state.sel = i;
        }
        try { win.setIcon(state.items.length ? 'recycle-bin-full' : 'recycle-bin'); } catch (e2) { }
        render();
      }

      function emptyFace() {
        panel.innerHTML = '';
        var e = mk('div', 'sa-empty');
        e.style.top = '40%';
        var ic = mk('div', 'ic');
        ic.appendChild(icon('recycle-bin', 32));
        e.appendChild(ic);
        e.appendChild(document.createTextNode('The Recycle Bin is empty.'));
        panel.appendChild(e);
      }

      function render() {
        if (state.view !== 'details') { renderIcons(); status(statusText()); return; }
        panel.innerHTML = '';
        if (!state.items.length) { emptyFace(); status(statusText()); return; }
        var t = mk('table', 'sa-table');
        var cg = mk('colgroup');
        ['30%', '26%', '16%', '14%', '14%'].forEach(function (w) {
          var c = document.createElement('col'); c.style.width = w; cg.appendChild(c);
        });
        t.appendChild(cg);
        var thead = mk('thead');
        var hr = mk('tr');
        ['Name', 'Original Location', 'Date Deleted', 'Type', 'Size'].forEach(function (h) {
          hr.appendChild(mk('th', '', h));
        });
        thead.appendChild(hr);
        t.appendChild(thead);
        var tb = mk('tbody');
        for (var i = 0; i < state.items.length; i++) {
          (function (idx) {
            var r = state.items[idx];
            var tr = mk('tr');
            if (idx === state.sel) tr.classList.add('highlighted');
            var td0 = mk('td');
            var ic = mk('span', 'sa-cellic');
            ic.appendChild(icon(r.dir ? 'folder' : W98.iconForFile(r.path), 16));
            td0.appendChild(ic);
            td0.appendChild(document.createTextNode(r.name));
            td0.title = r.name;
            tr.appendChild(td0);
            var td1 = mk('td', '', r.folder || r.orig);
            td1.title = r.orig;
            tr.appendChild(td1);
            tr.appendChild(mk('td', '', r.deleted));
            tr.appendChild(mk('td', '', r.type));
            tr.appendChild(mk('td', '', sizeText(r.size, r.dir)));
            tr.addEventListener('click', function () { select(idx); });
            tr.addEventListener('dblclick', function () { select(idx); openSel(); });
            tr.addEventListener('contextmenu', function (ev) { contextFor(idx, ev); });
            tb.appendChild(tr);
          })(i);
        }
        t.appendChild(tb);
        panel.appendChild(t);
        status(statusText());
      }

      function renderIcons() {
        panel.innerHTML = '';
        if (!state.items.length) { emptyFace(); return; }
        var wrap = mk('div', 'sa-iconview');
        for (var i = 0; i < state.items.length; i++) {
          (function (idx) {
            var r = state.items[idx];
            var cell = mk('div', 'sa-iconsel' + (idx === state.sel ? ' sel' : ''));
            var ic = mk('span', 'ic');
            ic.appendChild(icon(r.dir ? 'folder' : W98.iconForFile(r.path), 32));
            cell.appendChild(ic);
            var lb = mk('div', 'lb', r.name);
            lb.title = r.name;
            cell.appendChild(lb);
            cell.addEventListener('click', function () { select(idx); });
            cell.addEventListener('dblclick', function () { select(idx); openSel(); });
            cell.addEventListener('contextmenu', function (ev) { contextFor(idx, ev); });
            wrap.appendChild(cell);
          })(i);
        }
        panel.appendChild(wrap);
      }

      function select(i) { state.sel = i; render(); }

      function selected() { return state.sel >= 0 ? state.items[state.sel] : null; }

      function openSel() {
        var r = selected();
        if (r) openEntry(r.path);
      }

      function contextFor(i, ev) {
        ev.preventDefault(); ev.stopPropagation();
        select(i);
        var r = state.items[i];
        if (!r) return;
        safe(function () {
          W98.menu.contextMenu([
            { label: '&Restore', onclick: function () { restoreItems(); } },
            { type: 'sep' },
            { label: '&Delete', onclick: function () { deleteItems(); } },
            { label: '&Properties', onclick: function () { showProps(i); } }
          ], ev);
        }, null);
      }

      function showProps(i) {
        var r = state.items[i];
        if (!r) return;
        var text = r.name + '\n' +
          'Type: ' + r.type + '\n' +
          'Original Location: ' + (r.orig || '(unknown)') + '\n' +
          'Date Deleted: ' + r.deleted + '\n' +
          'Size: ' + (r.dir ? '' : (r.size || 0) + ' bytes (' + sizeText(r.size, false) + ')') + '\n' +
          'Attributes: Archive';
        W98.dialog.alert(r.name + ' Properties', text, 'info');
      }

      function deleteItems() {
        var r = selected();
        if (!r) { W98.sound.beep(); return; }
        W98.dialog.confirm('Confirm File Delete',
          'Are you sure you want to delete \'' + r.name + '\'?').then(function (yes) {
            if (!yes) return;
            safe(function () { W98.fs.remove(r.path); }, null);
            safe(function () { W98.reg.del(BIN_KEY, r.name); }, null);
            safe(function () { W98.reg.del(BIN_TIME_KEY, r.name); }, null);
            W98.sound.click();
            refresh(false);
          });
      }

      function restoreAll() {
        var items = state.items.slice();
        if (!items.length) { W98.sound.beep(); return; }
        restoreList(items, items.length === 1 ? 'Confirm File Restore' : null);
      }

      function restoreItems() {
        var r = selected();
        if (!r) { W98.sound.beep(); return; }
        restoreList([r], 'Confirm File Restore');
      }

      function restoreList(items, title) {
        var msg = items.length === 1
          ? 'Are you sure you want to restore \'' + items[0].name + '\' to its original folder?'
          : 'Are you sure you want to restore these ' + items.length + ' items to their original folders?';
        W98.dialog.confirm(title || 'Confirm Multiple File Restore', msg).then(function (yes) {
          if (!yes) return;
          var n = 0;
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var target = it.orig;
            if (!target) target = joinPath('C:\\My Documents', it.name);
            var folder = parentPath(target);
            if (!safe(function () { return W98.fs.isDir(folder); }, false)) {
              safe(function () { W98.fs.mkdir(folder); }, null);
            }
            if (safe(function () { return W98.fs.exists(target); }, false)) {
              safe(function () { W98.fs.remove(target); }, null);
            }
            var ok = safe(function () { return W98.fs.rename(it.path, target); }, -1);
            if (ok !== -1) n++;
            safe(function () { W98.reg.del(BIN_KEY, it.name); }, null);
            safe(function () { W98.reg.del(BIN_TIME_KEY, it.name); }, null);
          }
          W98.sound.click();
          if (n) {
            W98.dialog.alert('Recycle Bin', 'Restored ' + n + ' object(s):\n' +
              items.map(function (x) { return x.orig || x.name; }).join('\n'), 'info');
          }
          refresh(false);
        });
      }

      function emptyBin() {
        var items = state.items.slice();
        if (!items.length) { W98.sound.beep(); return; }
        var msg = items.length === 1
          ? 'Are you sure you want to delete \'' + items[0].name + '\'?'
          : 'Are you sure you want to delete these ' + items.length + ' items?';
        W98.dialog.confirm(items.length === 1 ? 'Confirm File Delete' : 'Confirm Multiple File Delete', msg)
          .then(function (yes) {
            if (!yes) return;
            for (var i = 0; i < items.length; i++) {
              safe(function (it) { W98.fs.remove(it.path); }.bind(null, items[i]), null);
              safe(function (it) { W98.reg.del(BIN_KEY, it.name); }.bind(null, items[i]), null);
              safe(function (it) { W98.reg.del(BIN_TIME_KEY, it.name); }.bind(null, items[i]), null);
            }
            safe(function () { W98.sound.play('Recycle'); }, null);
            refresh(false);
          });
      }

      function buildMenu() {
        win.setMenu([
          {
            label: '&File', items: [
              { label: '&Empty Recycle Bin', onclick: emptyBin },
              { label: '&Restore', onclick: restoreItems },
              { label: 'R&estore All', onclick: restoreAll },
              { type: 'sep' },
              { label: '&Delete', onclick: deleteItems },
              { label: '&Properties', onclick: function () { showProps(state.sel); } },
              { type: 'sep' },
              { label: '&Close', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Edit', items: [
              { label: '&Undo Delete', disabled: true },
              { type: 'sep' },
              { label: 'Select &All', disabled: true },
              { label: '&Invert Selection', disabled: true }
            ]
          },
          {
            label: '&View', items: [
              { label: '&Toolbar', type: 'check', checked: state.toolbarOn, onclick: toggleToolbar },
              { label: '&Status Bar', type: 'check', checked: state.statusOn, onclick: toggleStatus },
              { type: 'sep' },
              { label: '&Refresh', accel: 'F5', onclick: function () { refresh(true); } },
              { type: 'sep' },
              { label: 'Lar&ge Icons', type: 'radio', checked: state.view === 'icons32', onclick: function () { setView('icons32'); } },
              { label: '&Details', type: 'radio', checked: state.view === 'details', onclick: function () { setView('details'); } }
            ]
          },
          {
            label: '&Help', items: [
              { label: '&Help Topics', onclick: function () { W98.launch('help', { topic: 'recycle' }); } },
              { type: 'sep' },
              { label: '&About Recycle Bin', onclick: function () { safe(function () { W98.aboutDialog('recycle'); }, null); } }
            ]
          }
        ]);
      }
      function toggleToolbar() {
        state.toolbarOn = !state.toolbarOn;
        toolbar.style.display = state.toolbarOn ? '' : 'none';
        buildMenu();
      }
      function toggleStatus() {
        state.statusOn = !state.statusOn;
        safe(function () { win.setStatus(state.statusOn ? [{ text: statusText() }] : null); }, null);
        buildMenu();
      }
      function setView(v) { state.view = v; buildMenu(); render(); }

      emptyBtn.addEventListener('click', emptyBin);
      restoreBtn.addEventListener('click', restoreItems);
      win.el.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (state.items.length) select(Math.min(state.items.length - 1, state.sel + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (state.items.length) select(Math.max(0, state.sel - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); openSel(); }
        else if (e.key === 'Delete') { e.preventDefault(); deleteItems(); }
        else if (e.key === 'F5') { e.preventDefault(); refresh(true); }
      });

      buildMenu();
      refresh(false);

      return {
        onResize: function () { render(); },
        onFocus: function () { refresh(true); },
        onClose: function () { }
      };
    }
  });

  /* =========================================================================
   * 6. IE — Internet Explorer 4
   * =======================================================================*/
  var IE_DIR = 'C:\\WINDOWS\\WEB';
  var IE_FAV = 'C:\\WINDOWS\\Favorites';

  var IE_HOME_HTML = [
    '<html><head><title>Welcome to Internet Explorer</title></head><body>',
    '<div class="welcome"><h1>Microsoft Internet Explorer</h1>',
    '<div class="sub">Welcome to the World Wide Web</div></div>',
    '<p class="center"><b>Your browser is ready.  Pick a link and start browsing.</b></p>',
    '<p>Internet Explorer 4 puts the Web on your desktop.  Everything you need is on the ',
    'toolbar above: use <b>Back</b> and <b>Forward</b> to move through the pages you have ',
    'visited, <b>Home</b> to come back to this page, and <b>Favorites</b> to keep the pages ',
    'you want to find again.</p>',
    '<hr>',
    '<h3>What you can look at today</h3>',
    '<ul>',
    '<li><a href="games">The games installed on this computer</a> &ndash; the Windows games ',
    'and the real MS-DOS games running in an emulator.</li>',
    '<li><a href="kernel">How this computer works</a> &ndash; the WebAssembly kernel underneath ',
    'this desktop.</li>',
    '<li><a href="search">Search the Internet</a> &ndash; find a site by name.</li>',
    '<li><a href="C:\\My Documents\\Welcome.txt">C:\\My Documents\\Welcome.txt</a> &ndash; ',
    'read a file from the hard disk.</li>',
    '<li><a href="http://www.msn.com">http://www.msn.com</a> &ndash; out on the Internet ',
    '(you will need a modem for this one).</li>',
    '</ul>',
    '<hr>',
    '<p class="center"><small>This page is stored on your own computer at ',
    'C:\\WINDOWS\\WEB\\WELCOME.HTM.</small></p>',
    '</body></html>'
  ].join('');

  var IE_GAMES_HTML = [
    '<html><head><title>The Games on this Computer</title></head><body>',
    '<div class="welcome"><h1>The Games on this Computer</h1>',
    '<div class="sub">Windows 98 &middot; Start &gt; Programs &gt; Games</div></div>',
    '<h2>The Windows games</h2>',
    '<ul>',
    '<li><b>Solitaire</b> &ndash; the card game, with the classic waterfall deal.</li>',
    '<li><b>Minesweeper</b> &ndash; clear the field without touching a mine.</li>',
    '<li><b>FreeCell</b> &ndash; every deal can be won, except game #11982.</li>',
    '<li><b>JezzBall</b> &ndash; build walls and trap the bouncing balls.</li>',
    '<li><b>3D Pinball: Space Cadet</b> &ndash; the table from the Windows 98 CD.</li>',
    '</ul>',
    '<h2>The MS-DOS games</h2>',
    '<p>These are real MS-DOS programs, running in a full emulator, exactly as they ran on a ',
    '486 in 1993.  You will find them under <b>Start &gt; Programs &gt; DOS Games</b>.</p>',
    '<table><tr><th>Game</th><th>Publisher</th><th>Year</th></tr>',
    '<tr><td>DOOM (Shareware)</td><td>id Software</td><td>1993</td></tr>',
    '<tr><td>Wolfenstein 3D (Shareware)</td><td>id Software / Apogee</td><td>1992</td></tr>',
    '<tr><td>Duke Nukem 3D (Shareware)</td><td>3D Realms / Apogee</td><td>1996</td></tr>',
    '<tr><td>Commander Keen 4 (Shareware)</td><td>id Software / Apogee</td><td>1991</td></tr>',
    '<tr><td>Bio Menace (Shareware)</td><td>Apogee Software</td><td>1993</td></tr>',
    '<tr><td>Prince of Persia</td><td>Br&oslash;derbund</td><td>1990</td></tr>',
    '</table>',
    '<hr>',
    '<p><a href="home">Back to the Internet Explorer start page</a></p>',
    '</body></html>'
  ].join('');

  var IE_KERNEL_HTML = [
    '<html><head><title>How this Computer Works</title></head><body>',
    '<div class="welcome"><h1>How this Computer Works</h1>',
    '<div class="sub">Windows 98 in a browser, served by a WebAssembly kernel</div></div>',
    '<p>Everything you can see in this desktop &ndash; the windows, this browser, the files on ',
    'C: &ndash; is served by a small operating system kernel.  JavaScript draws the pixels; ',
    'the kernel owns the state.</p>',
    '<h2>The kernel</h2>',
    '<ul>',
    '<li><b>kernel/kernel.c</b> is compiled to <b>web/wasm/kernel.wasm</b>, a 32-bit ',
    'WebAssembly image.</li>',
    '<li>It holds the <b>virtual FAT filesystem</b>: every file on C: lives in the kernel heap ',
    'and is saved into the browser database, so it survives a restart.</li>',
    '<li>It holds the <b>registry</b>, with the same key names Windows uses &ndash; the Help ',
    'and Run MRU lists are in HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion.',
    '</li>',
    '<li>Every window is a <b>process</b> in the kernel process table, with a pid and a CPU ',
    'time.  Open Task Manager to watch the numbers move.</li>',
    '<li>Timers are served from the kernel <b>timer queue</b> by a round-robin scheduler ',
    'driven by one tick per animation frame.</li>',
    '</ul>',
    '<h2>An illustration from this disk</h2>',
    '<p><img src="C:\\WINDOWS\\WEB\\WIN98.BMP" width="160" height="90" ',
    'alt="A picture stored on the hard disk"></p>',
    '<p>That picture is a 24-bit bitmap on your hard disk, at ',
    '<b>C:\\WINDOWS\\WEB\\WIN98.BMP</b>.  Internet Explorer read the bytes out of the kernel ',
    'filesystem, worked out that it is a bitmap, and handed it to the renderer &ndash; exactly ',
    'the way it would render an image downloaded from a Web server.</p>',
    '<hr>',
    '<p><a href="home">Back to the Internet Explorer start page</a></p>',
    '</body></html>'
  ].join('');

  var IE_SEARCH_HTML = [
    '<html><head><title>Search the Internet</title></head><body>',
    '<div class="welcome"><h1>Search the Internet</h1>',
    '<div class="sub">Find a page by name or by topic</div></div>',
    '<p>Type an address in the <b>Address</b> bar above and press <b>Enter</b>.</p>',
    '<h3>Search engines</h3>',
    '<ul>',
    '<li><a href="http://search.msn.com">MSN Search</a></li>',
    '<li><a href="http://www.yahoo.com">Yahoo!</a></li>',
    '<li><a href="http://www.altavista.com">AltaVista</a></li>',
    '</ul>',
    '<p class="center"><b>This computer has no modem, so these sites cannot be reached.  ',
    'Internet Explorer will tell you so before you try.</b></p>',
    '<hr>',
    '<h3>Looking for something on this computer?</h3>',
    '<p>Use <a href="app:find">Find &gt; Files or Folders</a> to search your own disks.</p>',
    '<p><a href="home">Back to the Internet Explorer start page</a></p>',
    '</body></html>'
  ].join('');

  /* a small 24-bit bitmap written into C:\WINDOWS\WEB so that the kernel page
     has a real image to decode (bytes go in through writeBytes, not writeText) */
  function ieBmpBytes() {
    var W = 160, H = 90, rowSize = (W * 3 + 3) & ~3, size = 54 + rowSize * H;
    var buf = new Uint8Array(size);
    buf[0] = 0x42; buf[1] = 0x4D;
    function u32(off, v) { buf[off] = v & 255; buf[off + 1] = (v >> 8) & 255; buf[off + 2] = (v >> 16) & 255; buf[off + 3] = (v >> 24) & 255; }
    function u16(off, v) { buf[off] = v & 255; buf[off + 1] = (v >> 8) & 255; }
    u32(2, size); u32(10, 54); u32(14, 40);
    u32(18, W); u32(22, H); u16(26, 1); u16(28, 24);
    function insideCloud(x, y, cx, cy, w, h) {
      var dx = (x - cx) / w, dy = (y - cy) / h;
      return dx * dx + dy * dy <= 1;
    }
    var p = 54;
    for (var y = H - 1; y >= 0; y--) {
      for (var x = 0; x < W; x++) {
        var r, g, b2;
        if (y >= 62) {
          var t = (y - 62) / (H - 62);
          r = Math.round(58 - 30 * t); g = Math.round(128 - 40 * t); b2 = Math.round(64 - 30 * t);
        } else {
          var t2 = y / 62;
          r = Math.round(48 + 120 * t2); g = Math.round(80 + 120 * t2); b2 = Math.round(160 + 80 * t2);
        }
        if (insideCloud(x, y, 30, 18, 20, 7) || insideCloud(x, y, 44, 20, 14, 5)) { r = 255; g = 255; b2 = 255; }
        if (insideCloud(x, y, 126, 14, 18, 6)) { r = 255; g = 255; b2 = 255; }
        /* the four panes of the Windows flag */
        if (x >= 58 && x < 104 && y >= 22 && y < 50) {
          var fx = x - 58, fy = y - 22;
          var left = fx < 22, top = fy < 14;
          var paneC = left ? (top ? [255, 0, 0] : [58, 110, 165]) : (top ? [0, 160, 0] : [255, 255, 0]);
          r = paneC[0]; g = paneC[1]; b2 = paneC[2];
          if (fx === 22 || fy === 14) { r = 255; g = 255; b2 = 255; }
          if (fx === 0 || fy === 0 || fx === 45 || fy === 27) { r = 255; g = 255; b2 = 255; }
        }
        buf[p++] = b2; buf[p++] = g; buf[p++] = r;
      }
      p += rowSize - W * 3;
    }
    return buf;
  }

  function ieEnsurePages() {
    var pages = [
      ['WELCOME.HTM', IE_HOME_HTML],
      ['GAMES.HTM', IE_GAMES_HTML],
      ['KERNEL.HTM', IE_KERNEL_HTML],
      ['SEARCH.HTM', IE_SEARCH_HTML]
    ];
    for (var i = 0; i < pages.length; i++) {
      var p = joinPath(IE_DIR, pages[i][0]);
      if (!safe(function () { return W98.fs.exists(p); }, false)) {
        safe(function (q, body) { W98.fs.writeText(q, body); }.bind(null, p, pages[i][1]), null);
      }
    }
    var pic = joinPath(IE_DIR, 'WIN98.BMP');
    if (!safe(function () { return W98.fs.exists(pic); }, false)) {
      safe(function () { W98.fs.writeBytes(pic, ieBmpBytes()); }, null);
    }
  }

  var IE_BUILTIN = {
    home: 'WELCOME.HTM', welcome: 'WELCOME.HTM', 'default.htm': 'WELCOME.HTM',
    games: 'GAMES.HTM', kernel: 'KERNEL.HTM', search: 'SEARCH.HTM'
  };

  /* The local intranet is a filesystem-backed model.  Resolve only its
     explicit host/protocol (and the fixture's relative page names) here so
     ordinary Internet addresses continue through IE's offline error page. */
  function ieLocalIntranetTarget(input) {
    var adapter = W98.localIntranet;
    if (!adapter || typeof adapter.resolve !== 'function') return null;
    var s = String(input == null ? '' : input).replace(/^\s+|\s+$/g, '');
    var isFixture = /^(?:welcome|directory|help|status|files|bulletin|search)(?:\.html?)?(?:[?#].*)?$/i.test(s);
    var isHost = /^(?:https?:\/\/)?(?:intranet\.w98\.local|intranet)(?:[/:?#]|$)/i.test(s) ||
      /^intranet:\/\//i.test(s) || /^C:\\WINDOWS\\INTRANET(?:\\|\/|$)/i.test(s);
    if (!isFixture && !isHost) return null;
    var result = safe(function () { return adapter.resolve(s); }, null);
    if (!result) return null;
    if (!result.ok) return { kind: 'intranet-error', input: s, error: result.error || result };
    return {
      kind: 'file', path: result.filesystemPath || result.path, input: s,
      label: result.label || 'W98 Company Intranet', html: result.html || '', localIntranet: true
    };
  }

  function ieTargetFor(input) {
    var s = String(input == null ? '' : input).replace(/^\s+|\s+$/g, '');
    if (!s || s.toLowerCase() === 'about:blank') return { kind: 'blank', label: 'about:blank' };
    var low = s.toLowerCase();
    if (IE_BUILTIN[low]) return { kind: 'file', path: joinPath(IE_DIR, IE_BUILTIN[low]), input: low };
    var intranetTarget = ieLocalIntranetTarget(s);
    if (intranetTarget) return intranetTarget;
    if (/^(https?|ftp|gopher|mailto|news|javascript):/i.test(s)) return { kind: 'remote', url: s };
    if (/^about:/i.test(s)) return { kind: 'blank', label: s, input: s };
    if (/^app:/i.test(s)) return { kind: 'app', id: s.slice(4), input: s };
    var looksPath = /^[a-z]:/i.test(s) || s.indexOf('\\') >= 0 || s.indexOf('/') >= 0;
    var p = safe(function () { return W98.fs.norm(s); }, s);
    if (looksPath) {
      if (safe(function () { return W98.fs.exists(p); }, false)) return { kind: 'file', path: p, input: s };
      return { kind: 'missing', path: p, input: s };
    }
    /* a bare word: try the WEB folder, then the desktop, then assume it is a Web site */
    var tries = [joinPath(IE_DIR, s), joinPath(IE_DIR, s + '.HTM'), joinPath(IE_DIR, s + '.htm'),
      'C:\\WINDOWS\\' + s, 'C:\\' + s];
    for (var i = 0; i < tries.length; i++) {
      if (safe(function () { return W98.fs.exists(tries[i]); }, false)) {
        return { kind: 'file', path: tries[i], input: s };
      }
    }
    return { kind: 'remote', url: 'http://' + s, input: s };
  }

  function ieMime(path) {
    var e = extOf(path);
    if (e === 'bmp' || e === 'dib') return 'image/bmp';
    if (e === 'png') return 'image/png';
    if (e === 'gif') return 'image/gif';
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
    return 'application/octet-stream';
  }

  /* ---- the HTML subset renderer ------------------------------------- */
  var IE_VOID = { br: 1, hr: 1, img: 1, meta: 1, link: 1, input: 1, area: 1, col: 1, base: 1 };
  var IE_MAP = {
    b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', big: 'big', small: 'small',
    sub: 'sub', sup: 'sup', center: 'div', div: 'div', span: 'span', tt: 'tt', code: 'tt',
    pre: 'pre', blockquote: 'blockquote', p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4',
    h5: 'h4', h6: 'h4', ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd',
    table: 'table', tr: 'tr', td: 'td', th: 'th', thead: 'thead', tbody: 'tbody',
    caption: 'caption', font: 'span', a: 'a', img: 'img', br: 'br', hr: 'hr', pre_: 'pre'
  };

  function ieAttrs(s) {
    var out = {}, re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, m;
    while ((m = re.exec(String(s || '')))) {
      var v = m[2] == null ? '' : m[2].replace(/^["']|["']$/g, '');
      out[m[1].toLowerCase()] = v;
    }
    return out;
  }
  function ieEnt(s) {
    return String(s)
      .replace(/&nbsp;/gi, '\u00a0').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&ndash;/gi, '\u2013').replace(/&mdash;/gi, '\u2014').replace(/&oslash;/gi, '\u00f8')
      .replace(/&copy;/gi, '\u00a9').replace(/&middot;/gi, '\u00b7')
      .replace(/&#(\d+);/g, function (all, n) {
        var c = parseInt(n, 10);
        return isNaN(c) ? all : String.fromCharCode(c);
      });
  }

  function ieRenderInto(container, html, ctx) {
    container.innerHTML = '';
    var src = String(html == null ? '' : html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '');
    var stack = [container];
    var re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    var m, last = 0;

    function current() { return stack[stack.length - 1] || container; }
    function addText(s) {
      if (s === '') return;
      current().appendChild(document.createTextNode(ieEnt(s)));
    }
    function buildImage(node, at) {
      var s = at.src || '';
      node.className = 'sa-img';
      if (/^https?:/i.test(s) || !s) {
        node.className = 'imgmiss';
        node.textContent = 'x';
        return node;
      }
      var p = safe(function () { return W98.fs.norm(s); }, s);
      var bytes = safe(function () { return W98.fs.readBytes(p); }, null);
      if (!bytes || !bytes.length) {
        node.className = 'imgmiss';
        node.textContent = 'x';
        return node;
      }
      try {
        var url = URL.createObjectURL(new Blob([bytes], { type: ieMime(p) }));
        ctx.urls.push(url);
        var img = document.createElement('img');
        img.onerror = function () {
          node.className = 'imgmiss';
          node.innerHTML = '';
          node.textContent = 'x';
        };
        img.src = url;
        img.alt = at.alt || '';
        if (at.width) img.width = parseInt(at.width, 10) || 0;
        if (at.height) img.height = parseInt(at.height, 10) || 0;
        img.style.imageRendering = 'pixelated';
        node.appendChild(img);
      } catch (e) {
        node.className = 'imgmiss';
        node.textContent = 'x';
      }
      return node;
    }

    while ((m = re.exec(src))) {
      addText(src.slice(last, m.index));
      last = re.lastIndex;
      var closing = m[0].charAt(1) === '/';
      var tag = m[1].toLowerCase();
      var at = ieAttrs(m[2]);
      if (tag === 'html' || tag === 'body' || tag === 'meta' || tag === 'link') continue;
      var mapped = IE_MAP[tag] || 'span';

      if (closing) {
        for (var i = stack.length - 1; i > 0; i--) {
          if (stack[i].getAttribute && stack[i].getAttribute('data-tag') === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      if (tag === 'br') { current().appendChild(document.createElement('br')); continue; }
      if (tag === 'hr') { current().appendChild(document.createElement('hr')); continue; }
      if (tag === 'img') { current().appendChild(buildImage(document.createElement('span'), at)); continue; }

      var node2 = document.createElement(mapped);
      node2.setAttribute('data-tag', tag);
      if (at['class']) node2.className = at['class'];
      if (at.style) node2.setAttribute('style', String(at.style).replace(/[<>]/g, ''));
      if (tag === 'a') {
        node2.setAttribute('data-href', at.href || '');
        if (!at.href) node2.setAttribute('data-href', '');
      }
      if (tag === 'font') {
        if (at.color) node2.style.color = at.color.replace(/[^#a-zA-Z0-9(),. -]/g, '');
        if (at.size) node2.style.fontSize = (10 + (parseInt(at.size, 10) || 3) * 2) + 'px';
        if (at.face) node2.style.fontFamily = at.face.replace(/["'<>]/g, '');
      }
      if (at.align && (mapped === 'div' || mapped === 'p' || mapped === 'h1' || mapped === 'h2' || mapped === 'h3')) {
        node2.style.textAlign = at.align;
      }
      if (at.bgcolor && mapped === 'td') node2.style.backgroundColor = at.bgcolor.replace(/[^#a-zA-Z0-9]/g, '');
      if (tag === 'table') {
        node2.style.borderCollapse = 'collapse';
        if (at.border === '0' || at.border == null) node2.classList.add('sa-plain-table');
      }
      current().appendChild(node2);
      if (!IE_VOID[tag]) stack.push(node2);
    }
    addText(src.slice(last));
    return container;
  }

  /* ---- the toolbar icons (16x16, drawn procedurally) ---------------- */
  function ieIcon(name) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 16;
    cv.style.width = cv.style.height = '16px';
    cv.style.imageRendering = 'pixelated';
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    function r(x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
    function px(x, y, c) { r(x, y, 1, 1, c); }
    function poly(pts, c) {
      g.fillStyle = c; g.beginPath();
      for (var i = 0; i < pts.length; i++) { if (i) g.lineTo(pts[i][0] + .5, pts[i][1] + .5); else g.moveTo(pts[i][0] + .5, pts[i][1] + .5); }
      g.closePath(); g.fill();
    }
    function line(x1, y1, x2, y2, c, w) {
      g.strokeStyle = c; g.lineWidth = w || 1;
      g.beginPath(); g.moveTo(x1 + .5, y1 + .5); g.lineTo(x2 + .5, y2 + .5); g.stroke();
    }
    function arc(cx, cy, rad, a0, a1, c, w) {
      g.strokeStyle = c; g.lineWidth = w || 1;
      g.beginPath(); g.arc(cx, cy, rad, a0, a1); g.stroke();
    }
    var K = '#000', W = '#ffffff', S = '#808080', F = '#c0c0c0', G = '#008000', B = '#000080', Y = '#ffff00';
    switch (name) {
      case 'back':
        poly([[2, 8], [11, 2], [11, 14]], G);
        line(2, 8, 11, 2, K); line(2, 8, 11, 14, K); line(11, 2, 11, 14, K);
        r(11, 6, 3, 4, G);
        break;
      case 'forward':
        poly([[14, 8], [5, 2], [5, 14]], G);
        line(14, 8, 5, 2, K); line(14, 8, 5, 14, K); line(5, 2, 5, 14, K);
        r(2, 6, 3, 4, G);
        break;
      case 'stop':
        r(3, 3, 10, 10, '#ff0000');
        r(4, 4, 8, 8, '#e00000');
        line(5, 5, 10, 10, W, 2); line(10, 5, 5, 10, W, 2);
        break;
      case 'refresh':
        arc(8, 8, 5, 0.6, 4.4, G, 2);
        poly([[11, 4], [14, 6], [11, 8]], G);
        line(11, 4, 14, 6, K); line(11, 8, 14, 6, K);
        break;
      case 'home':
        poly([[2, 7], [8, 2], [14, 7]], '#a00000');
        r(3, 7, 10, 7, W);
        r(3, 7, 10, 1, S);
        r(6, 10, 4, 4, B);
        r(4, 9, 2, 2, '#606060');
        break;
      case 'search':
        arc(7, 6, 4, 0, 6.3, B, 2);
        g.fillStyle = W; g.beginPath(); g.arc(7, 6, 2, 0, 6.3); g.fill();
        line(10, 10, 14, 14, S, 2);
        break;
      case 'favorites':
        poly([[8, 2], [10, 6], [14, 6], [11, 9], [12, 14], [8, 11], [4, 14], [5, 9], [2, 6], [6, 6]], Y);
        line(8, 2, 10, 6, K); line(10, 6, 14, 6, K); line(14, 6, 11, 9, K);
        break;
      case 'history':
        r(2, 3, 12, 11, W);
        r(2, 3, 12, 1, S); r(2, 3, 1, 11, S);
        line(4, 5, 12, 5, S);
        line(8, 7, 8, 10, K); line(8, 10, 11, 10, K);
        r(4, 7, 2, 1, S); r(4, 9, 2, 1, S);
        break;
      case 'print':
        r(4, 2, 8, 4, W);
        r(4, 2, 8, 1, S);
        r(2, 6, 12, 6, F);
        r(2, 6, 12, 1, W); r(2, 11, 12, 1, S);
        r(4, 10, 8, 5, W);
        r(4, 10, 8, 1, S);
        r(12, 8, 2, 2, G);
        break;
      case 'mail':
        r(2, 4, 12, 9, W);
        r(2, 4, 12, 1, S); r(2, 4, 1, 9, S); r(13, 4, 1, 9, S); r(2, 12, 12, 1, S);
        line(3, 5, 8, 9, B); line(13, 5, 8, 9, B);
        line(3, 12, 7, 8, '#8080ff'); line(13, 12, 9, 8, '#8080ff');
        break;
      default:
        r(3, 3, 10, 10, F);
        r(3, 3, 10, 1, W); r(3, 12, 10, 1, S);
        break;
    }
    return cv;
  }

  W98.registerApp({
    id: 'ie',
    title: 'Microsoft Internet Explorer',
    icon: 'ie',
    width: 640, height: 460,
    minWidth: 320, minHeight: 180,
    resizable: true,
    maximizable: true,
    create: function (win, args) {
      ensureCss();
      ieEnsurePages();

      var root = mk('div', 'sa-root sa-ie');
      win.el.appendChild(root);

      /* ---- toolbar -------------------------------------------------- */
      var tb = mk('div', 'w98-toolbar sa-ie-tb');
      root.appendChild(tb);

      function toolBtn(name, label, fn) {
        var b = mk('button', 'w98-toolbtn');
        b.type = 'button';
        b.title = label;
        b.appendChild(ieIcon(name));
        b.addEventListener('click', fn);
        tb.appendChild(b);
        return b;
      }
      var backB = toolBtn('back', 'Back', function () { go(-1); });
      var fwdB = toolBtn('forward', 'Forward', function () { go(1); });
      toolBtn('stop', 'Stop', function () { stopLoading(); });
      toolBtn('refresh', 'Refresh', function () { reload(); });
      toolBtn('home', 'Home', function () { openInput('home'); });
      tb.appendChild(mk('div', 'w98-toolbar-sep'));
      toolBtn('search', 'Search', function () { openInput('search'); });
      var favB = toolBtn('favorites', 'Favorites', function (ev) { showFavorites(ev); });
      toolBtn('history', 'History', function (ev) { showHistory(ev); });
      toolBtn('print', 'Print', function () {
        W98.dialog.alert('Print', 'There is no printer installed.\nTo install a printer, use ' +
          'Start > Settings > Printers.', 'warn');
      });
      toolBtn('mail', 'Mail', function () {
        W98.dialog.alert('Internet Explorer', 'Mail and News is not installed on this computer.  ' +
          'Use Start > Programs > Outlook Express to set up an account.', 'info');
      });
      var logoWrap = mk('div', 'sa-ie-logo');
      var logoCv = document.createElement('canvas');
      logoCv.width = 40; logoCv.height = 30;
      logoCv.style.width = '40px'; logoCv.style.height = '30px';
      logoCv.title = 'Internet Explorer';
      logoWrap.appendChild(logoCv);
      tb.appendChild(logoWrap);

      /* the Animated Traveler: the "e" with a dot going round it while loading */
      var logoA = 0;
      function paintLogo() {
        var g = logoCv.getContext('2d');
        g.clearRect(0, 0, 40, 30);
        try { ICONS.paint(g, 'ie', 6, 1, 28); } catch (e) { }
        var a = logoA;
        for (var i = 0; i < 3; i++) {
          var t = a + i * 2.1;
          var x = 20 + Math.round(Math.cos(t) * 16);
          var y = 15 + Math.round(Math.sin(t) * 8);
          g.fillStyle = i === 0 ? '#ffff00' : '#00ffff';
          g.fillRect(x - 1, y - 1, 3, 3);
        }
      }
      paintLogo();

      /* ---- address bar ---------------------------------------------- */
      var addrRow = mk('div', 'sa-ie-addr');
      addrRow.appendChild(accel(mk('label', '', ''), '&Address'));
      var combo = mk('div', 'sa-combo');
      combo.style.flex = '1 1 auto';
      var addrIn = mk('input');
      addrIn.type = 'text';
      addrIn.spellcheck = false;
      addrIn.setAttribute('aria-label', 'Address');
      combo.appendChild(addrIn);
      var addrArrow = mk('button', 'sa-cbtn');
      addrArrow.type = 'button';
      addrArrow.tabIndex = -1;
      addrArrow.title = 'Recently visited addresses';
      combo.appendChild(addrArrow);
      var addrDrop = mk('div', 'sa-drop');
      combo.appendChild(addrDrop);
      addrRow.appendChild(combo);
      var goB = mk('button', '', 'Go');
      addrRow.appendChild(goB);
      goB.addEventListener('click', function () { openInput(addrIn.value); });
      root.appendChild(addrRow);

      /* ---- page view ------------------------------------------------ */
      var view = mk('div', 'sa-ie-view');
      var page = mk('div', 'sa-ie-page sz2');
      view.appendChild(page);
      root.appendChild(view);

      /* ---- state ---------------------------------------------------- */
      var st = {
        history: [], idx: -1, loading: false, font: 2, toolbars: true,
        urls: [], timers: [], rafCancel: null, pending: null, label: 'about:blank'
      };
      var dropOpen = false;

      function status(main, zone) {
        safe(function () { win.setStatus([{ text: main }, { text: zone || 'Internet', width: 90 }]); }, null);
      }

      function clearTimers() {
        for (var i = 0; i < st.timers.length; i++) safe(function (t) { win.clearTimeout(t); }.bind(null, st.timers[i]), null);
        st.timers = [];
      }
      function releaseUrls() {
        for (var i = 0; i < st.urls.length; i++) safe(function (u) { URL.revokeObjectURL(u); }.bind(null, st.urls[i]), null);
        st.urls = [];
      }
      function later(fn, ms) {
        var id = win.setTimeout(function () {
          for (var i = 0; i < st.timers.length; i++) if (st.timers[i] === id) st.timers.splice(i, 1);
          fn();
        }, ms);
        st.timers.push(id);
        return id;
      }
      function stopLoading() {
        clearTimers();
        st.loading = false;
        status('Done');
      }
      function setLoading(on) {
        st.loading = on;
        status(on ? 'Opening page...' : 'Done');
        updateButtons();
      }
      function updateButtons() {
        backB.disabled = !(st.idx > 0);
        fwdB.disabled = !(st.idx >= 0 && st.idx < st.history.length - 1);
      }

      /* ---- rendering ------------------------------------------------ */
      function showHTML(html, label) {
        releaseUrls();
        try {
          ieRenderInto(page, html, st);
        } catch (e) {
          page.innerHTML = '<h2>Internet Explorer cannot display this page</h2>';
        }
        st.label = label || st.label;
        if (label) win.setTitle(label + ' - Microsoft Internet Explorer');
        view.scrollTop = 0;
        page.className = 'sa-ie-page sz' + st.font;
      }

      function errorPage(what, detail) {
        var html =
          '<div class="center"><h2>The page cannot be displayed</h2></div><hr>' +
          '<p>The page you are looking for is currently unavailable. The Web site might be ' +
          'experiencing technical difficulties, or you may need to adjust your browser settings.</p>' +
          '<p><b>' + esc(what) + '</b></p><hr>' +
          '<p>Please try the following:</p><ul>' +
          '<li>Click the Refresh button, or try again later.</li>' +
          '<li>If you typed the page address in the Address bar, make sure that it is spelled correctly.</li>' +
          '<li>To check your connection settings, click the Tools menu, and then click Internet Options. ' +
          'If there is no modem in this computer, you cannot reach sites on the Internet.</li>' +
          '<li>See if your Internet connection settings are being detected. You can set your server to ' +
          'support the use of an automatic configuration file.</li>' +
          '</ul><hr>' +
          '<p class="center"><b>Cannot find server or DNS Error</b><br>Internet Explorer</p>' +
          (detail ? '<p class="center"><small>' + esc(detail) + '</small></p>' : '');
        showHTML(html, 'The page cannot be displayed');
      }
      function missingPage(path) {
        var html =
          '<div class="center"><h2>The page cannot be displayed</h2></div><hr>' +
          '<p>Windows cannot find the file <b>' + esc(path) + '</b> in the local filesystem.  ' +
          'The path may have been typed incorrectly, or the file may have been deleted.</p>' +
          '<p>Check the spelling of the file name and try again.</p><hr>' +
          '<p class="center"><b>Cannot find file or directory</b><br>Internet Explorer</p>';
        showHTML(html, 'The page cannot be displayed');
      }

      function renderTarget(t, opts) {
        opts = opts || {};
        if (t.kind === 'app') { stopLoading(); W98.launch(t.id, {}); return; }
        if (t.kind === 'intranet-error') {
          stopLoading();
          addrIn.value = t.input || '';
          var intranetError = t.error || {};
          errorPage(intranetError.message || 'Cannot find server or DNS Error', intranetError.status || intranetError.code || 'intranet');
          if (!opts.noHistory) push({ input: t.input || '', label: 'The W98 intranet could not be reached' });
          return;
        }
        if (t.kind === 'blank') {
          showHTML('', 'about:blank');
          addrIn.value = 'about:blank';
          if (!opts.noHistory) push({ input: 'about:blank', label: 'about:blank' });
          return;
        }
        if (t.kind === 'remote') {
          stopLoading();
          addrIn.value = t.url;
          errorPage('Cannot find server or DNS Error', t.url);
          if (!opts.noHistory) push({ input: t.input || t.url, label: t.url });
          status('Done');
          return;
        }
        if (t.kind === 'missing') {
          stopLoading();
          addrIn.value = t.path;
          missingPage(t.path);
          if (!opts.noHistory) push({ input: t.input || t.path, label: t.path });
          status('Done');
          return;
        }
        /* a local file */
        var data = safe(function () { return W98.fs.readBytes(t.path); }, null);
        if (!data) {
          if (t.localIntranet && t.html) {
            showHTML(t.html, t.label || t.path);
            addrIn.value = t.input || t.path;
            if (!opts.noHistory) push({ input: t.input || t.path, label: t.label || t.path });
            status('Done', 'W98 intranet');
            return;
          }
          stopLoading();
          addrIn.value = t.path;
          missingPage(t.path);
          if (!opts.noHistory) push({ input: t.input || t.path, label: t.path });
          status('Done');
          return;
        }
        var e = extOf(t.path);
        if (e === 'bmp' || e === 'dib' || e === 'png' || e === 'gif' || e === 'jpg' || e === 'jpeg') {
          showHTML('<p class="center">' + (t.path) + '</p>', baseName(t.path));
          releaseUrls();
          try {
            var url = URL.createObjectURL(new Blob([data], { type: ieMime(t.path) }));
            st.urls.push(url);
            var img = document.createElement('img');
            img.src = url;
            img.style.margin = '0 auto';
            img.style.display = 'block';
            page.appendChild(img);
          } catch (e2) { }
          addrIn.value = t.path;
          if (!opts.noHistory) push({ input: t.input || t.path, label: t.path });
          status('Done');
          return;
        }
        var text = safe(function () { return W98.fs.readText(t.path); }, null);
        if (text == null) {
          stopLoading();
          missingPage(t.path);
          return;
        }
        if (e === 'txt' || e === 'ini' || e === 'bat' || e === 'log' || e === 'sys') {
          showHTML('<h2>' + esc(baseName(t.path)) + '</h2><hr><pre>' + esc(text) + '</pre>', baseName(t.path));
        } else {
          showHTML(text, t.path);
        }
        addrIn.value = t.path;
        if (!opts.noHistory) push({ input: t.input || t.path, label: t.path });
        status('Done');
      }

      function push(entry) {
        st.history = st.history.slice(0, st.idx + 1);
        st.history.push(entry);
        st.idx = st.history.length - 1;
        if (st.history.length > 60) { st.history.shift(); st.idx--; }
        updateButtons();
        fillAddrDrop();
      }

      function openInput(input, opts) {
        var t = ieTargetFor(input);
        setLoading(true);
        later(function () { renderTarget(t, opts || {}); setLoading(false); }, 120);
      }
      function go(delta) {
        var n = st.idx + delta;
        if (n < 0 || n >= st.history.length) return;
        st.idx = n;
        var e = st.history[n];
        var t = ieTargetFor(e.input);
        addrIn.value = e.input;
        setLoading(true);
        later(function () { renderTarget(t, { noHistory: true }); setLoading(false); }, 60);
        updateButtons();
      }
      function reload() {
        var e = st.history[st.idx];
        var t = ieTargetFor(e ? e.input : (addrIn.value || 'home'));
        setLoading(true);
        later(function () { renderTarget(t, { noHistory: true }); setLoading(false); }, 120);
      }
      function home() { openInput('home'); }

      /* page links ---------------------------------------------------- */
      page.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[data-href]') : null;
        if (!a) return;
        e.preventDefault();
        var href = a.getAttribute('data-href') || '';
        if (!href || href.charAt(0) === '#') return;
        openInput(href);
      });

      /* ---- address bar drop-down ------------------------------------ */
      function fillAddrDrop() {
        addrDrop.innerHTML = '';
        var seen = {}, n = 0;
        for (var i = st.history.length - 1; i >= 0 && n < 20; i--) {
          var inp = st.history[i].input;
          if (!inp || seen[inp.toLowerCase()]) continue;
          seen[inp.toLowerCase()] = 1;
          n++;
          (function (value) {
            var r = mk('div', 'sa-drop-item', value);
            r.title = value;
            r.addEventListener('mousedown', function (ev) {
              ev.preventDefault(); ev.stopPropagation();
              addrIn.value = value;
              closeAddrDrop();
              openInput(value);
            });
            addrDrop.appendChild(r);
          })(inp);
        }
        if (!n) addrDrop.appendChild(mk('div', 'sa-drop-item sa-note', '(no pages yet)'));
      }
      function openAddrDrop() {
        fillAddrDrop();
        addrDrop.classList.add('on');
        dropOpen = true;
      }
      function closeAddrDrop() { addrDrop.classList.remove('on'); dropOpen = false; }
      addrArrow.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (dropOpen) closeAddrDrop(); else openAddrDrop();
        addrIn.focus();
      });
      win.el.addEventListener('mousedown', function (e) {
        if (dropOpen && !combo.contains(e.target)) closeAddrDrop();
      });
      addrIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); closeAddrDrop(); openInput(addrIn.value); }
        else if (e.key === 'Escape') { closeAddrDrop(); addrIn.blur(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); if (!dropOpen) openAddrDrop(); }
      });

      /* ---- Favorites / History -------------------------------------- */
      function favoritesItems() {
        var items = [{ label: '&Home Page', icon: 'ie', onclick: function () { home(); } }];
        items.push({ label: '&Games', icon: 'ie', onclick: function () { openInput('games'); } });
        items.push({ label: '&How this Computer Works', icon: 'ie', onclick: function () { openInput('kernel'); } });
        items.push({ type: 'sep' });
        items.push({
          label: '&Add to Favorites...', icon: 'ie', onclick: function () {
            var def = addrIn.value || 'home';
            var pr = W98.dialog.prompt('Add Favorite', 'Name:', baseName(def).replace(/\.[^.]+$/, '') || 'Home Page');
            if (pr && pr.then) pr.then(function (name) {
              if (!name) return;
              var f = joinPath(IE_FAV, String(name).replace(/[\\/:*?"<>|]/g, '_') + '.url');
              safe(function () {
                W98.fs.writeText(f, '[InternetShortcut]\r\nURL=' + def + '\r\n');
              }, null);
              W98.dialog.alert('Favorites', 'The page has been added to your Favorites folder.', 'info');
            });
          }
        });
        var list = safe(function () { return W98.fs.list(IE_FAV); }, null) || [];
        if (list.length) {
          items.push({ type: 'sep' });
          for (var i = 0; i < list.length; i++) {
            (function (entry) {
              var p = joinPath(IE_FAV, entry.name);
              items.push({
                label: entry.name.replace(/\.[^.]+$/, ''), icon: 'ie', onclick: function () {
                  var txt = safe(function () { return W98.fs.readText(p); }, '') || '';
                  var m = /URL=(.+)/i.exec(txt);
                  if (entry.dir) { openInput(p); return; }
                  if (m) { openInput(m[1].replace(/\s+$/, '')); return; }
                  openInput(p);
                }
              });
            })(list[i]);
          }
        }
        return items;
      }
      function showFavorites(ev) {
        var r = favB.getBoundingClientRect ? favB.getBoundingClientRect() : null;
        safe(function () {
          W98.menu.show(favoritesItems(), r ? r.left : (ev ? ev.clientX : 60), r ? r.bottom + 1 : 60, { minWidth: 170 });
        }, null);
      }
      function showHistory(ev) {
        var items = [];
        for (var i = st.history.length - 1; i >= 0; i--) {
          (function (entry) {
            items.push({
              label: String(entry.label || entry.input || '(blank)'), icon: 'ie',
              onclick: function () { openInput(entry.input); }
            });
          })(st.history[i]);
        }
        if (!items.length) items.push({ label: '(no pages visited yet)', disabled: true });
        var r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
        safe(function () {
          W98.menu.show(items, r ? r.left : 300, r ? r.bottom + 1 : 80, { minWidth: 220 });
        }, null);
      }

      /* ---- menus ---------------------------------------------------- */
      function buildMenu() {
        var favs = favoritesItems();
        win.setMenu([
          {
            label: '&File', items: [
              { label: '&New Window', onclick: function () { W98.launch('ie', { path: addrIn.value || 'home' }); } },
              { label: '&Open...', onclick: function () {
                var p = W98.dialog.prompt('Open', 'Type the Internet address of a document or folder:', addrIn.value || 'C:\\');
                if (p && p.then) p.then(function (v) { if (v) openInput(v); });
              } },
              { label: '&Save As...', onclick: function () {
                var e = st.history[st.idx];
                var t = ieTargetFor(e ? e.input : addrIn.value);
                var text = (t.kind === 'file') ? safe(function () { return W98.fs.readText(t.path); }, '') : st.label;
                var pr = W98.dialog.fileSave({ path: 'C:\\My Documents', name: 'Page.htm', filter: '*.htm' });
                if (pr && pr.then) pr.then(function (path) {
                  if (!path) return;
                  safe(function () { W98.fs.writeText(path, (t.kind === 'file' ? '' : '<!-- ') + text); }, null);
                  W98.dialog.alert('Save As', 'The page has been saved as\n' + path, 'info');
                });
              } },
              { type: 'sep' },
              { label: 'Page Set&up...', disabled: true },
              { label: '&Print...', accel: 'Ctrl+P', onclick: function () {
                W98.dialog.alert('Print', 'There is no printer installed.\nTo install a printer, use Start > Settings > Printers.', 'warn');
              } },
              { type: 'sep' },
              { label: '&Send To', items: [{ label: 'Desktop as Shortcut', onclick: function () { addDesktopShortcut(); } }] },
              { label: 'P&roperties', onclick: function () { showProps(); } },
              { type: 'sep' },
              { label: 'C&lose', onclick: function () { win.close(); } }
            ]
          },
          {
            label: '&Edit', items: [
              { label: 'Cu&t', disabled: true },
              { label: '&Copy', accel: 'Ctrl+C', onclick: copySelection },
              { label: '&Paste', disabled: true },
              { type: 'sep' },
              { label: 'Select &All', accel: 'Ctrl+A', onclick: selectAllPage },
              { label: '&Find (on this page)...', onclick: function () {
                var p = W98.dialog.prompt('Find', 'Find what:', '');
                if (p && p.then) p.then(function (needle) { if (needle) findInPage(needle); });
              } }
            ]
          },
          {
            label: '&View', items: [
              { label: '&Toolbars', type: 'check', checked: st.toolbars, onclick: toggleToolbars },
              { label: '&Status Bar', type: 'check', checked: true, onclick: toggleStatusBar },
              { type: 'sep' },
              { label: '&Stop', accel: 'Esc', onclick: stopLoading },
              { label: '&Refresh', accel: 'F5', onclick: reload },
              { type: 'sep' },
              { label: '&Source', onclick: showSource },
              { type: 'sep' },
              { label: '&Largest', type: 'radio', checked: st.font === 4, onclick: function () { setFont(4); } },
              { label: 'Lar&ger', type: 'radio', checked: st.font === 3, onclick: function () { setFont(3); } },
              { label: '&Medium', type: 'radio', checked: st.font === 2, onclick: function () { setFont(2); } },
              { label: 'S&maller', type: 'radio', checked: st.font === 1, onclick: function () { setFont(1); } },
              { label: 'S&mallest', type: 'radio', checked: st.font === 0, onclick: function () { setFont(0); } }
            ]
          },
          {
            label: '&Go', items: [
              { label: '&Back', accel: 'Alt+Left', onclick: function () { go(-1); } },
              { label: '&Forward', accel: 'Alt+Right', onclick: function () { go(1); } },
              { label: '&Home Page', onclick: home },
              { type: 'sep' },
              { label: '&Search the Web', onclick: function () { openInput('search'); } },
              { label: '&Best of the Web', onclick: function () { openInput('http://www.msn.com'); } },
              { label: '&Channels', onClick2: null, onclick: function () { openInput('http://www.msn.com/channels'); } },
              { type: 'sep' },
              { label: '&My Computer', onclick: function () { W98.launch('explorer', { path: 'C:\\' }); } },
              { label: '&Mail', onclick: function () {
                W98.dialog.alert('Internet Explorer', 'Outlook Express is not installed on this computer.', 'info');
              } }
            ]
          },
          { label: 'F&avorites', items: favs },
          {
            label: '&Help', items: [
              { label: '&Help Topics', onclick: function () { W98.launch('help', { topic: 'ie' }); } },
              { type: 'sep' },
              { label: '&About Internet Explorer', onclick: function () { safe(function () { W98.aboutDialog('ie'); }, null); } }
            ]
          }
        ]);
      }
      function toggleToolbars() {
        st.toolbars = !st.toolbars;
        tb.style.display = st.toolbars ? '' : 'none';
        buildMenu();
      }
      function toggleStatusBar() {
        safe(function () { win.setStatus(null); }, null);
      }
      function setFont(n) { st.font = n; page.className = 'sa-ie-page sz' + n; buildMenu(); }
      function copySelection() {
        var sel = safe(function () { return String(window.getSelection()); }, '');
        if (!sel) { W98.dialog.alert('Copy', 'Nothing is selected on this page.', 'info'); return; }
        safe(function () { if (navigator.clipboard) navigator.clipboard.writeText(sel); }, null);
        status('The selection has been copied to the Clipboard.');
      }
      function selectAllPage() {
        safe(function () {
          var sel = window.getSelection();
          if (!sel) return;
          sel.removeAllRanges();
          var r = document.createRange();
          r.selectNodeContents(page);
          sel.addRange(r);
        }, null);
      }
      function findInPage(needle) {
        var text = String(page.innerText || page.textContent || '');
        var i = text.toLowerCase().indexOf(String(needle).toLowerCase());
        status(i < 0 ? 'The text \'' + needle + '\' was not found on this page.' : 'Found \'' + needle + '\' on this page.');
        safe(function () { if (i >= 0) window.find && window.find(needle); }, null);
      }
      function showSource() {
        var e = st.history[st.idx];
        var t = ieTargetFor(e ? e.input : addrIn.value);
        if (t.kind === 'file') {
          W98.launch('notepad', { path: t.path });
          return;
        }
        var one = joinPath('C:\\WINDOWS\\TEMP', 'IE_SOURCE.HTM');
        safe(function () { W98.fs.writeText(one, page.innerHTML); }, null);
        W98.launch('notepad', { path: one });
      }
      function addDesktopShortcut() {
        var e = st.history[st.idx];
        var inp = e ? e.input : (addrIn.value || 'home');
        var name = (st.label || 'Internet Shortcut').replace(/[\\/:*?"<>|]/g, '_');
        if (/\.htm/i.test(name)) name = name.replace(/\.htm$/i, '');
        safe(function () {
          W98.fs.writeText('C:\\WINDOWS\\Desktop\\' + name + ' Shortcut.lnk',
            'W98LNK1\napp:ie\n');
        }, null);
        W98.dialog.alert('Internet Explorer', 'A shortcut to this page has been placed on the desktop.', 'info');
        void inp;
      }
      function showProps() {
        var e = st.history[st.idx];
        var t = ieTargetFor(e ? e.input : addrIn.value);
        var size = (t.kind === 'file') ? (safe(function () { return W98.fs.stat(t.path); }, {}) || {}).size : 0;
        var text = 'Type: HTML Document\nProtocol: HyperText Transfer Protocol (HTTP) or Local File\n' +
          'Address: ' + (t.path || t.url || st.label) + '\n' +
          'Size: ' + (size || 0) + ' bytes\n' +
          'Created: ' + nowStamp() + '\n' +
          'Zone: ' + (t.kind === 'remote' ? 'Internet' : 'My Computer') + '\n' +
          'Available offline: No';
        W98.dialog.alert('Properties', text, 'info');
      }

      /* ---- animation ------------------------------------------------ */
      st.rafCancel = W98.raf(function () {
        if (win.closed) return;
        if (!st.loading) return;
        logoA += 0.22;
        paintLogo();
      });

      /* ---- keyboard ------------------------------------------------- */
      win.el.addEventListener('keydown', function (e) {
        if (e.key === 'F5') { e.preventDefault(); reload(); }
        else if (e.key === 'Escape') { stopLoading(); }
        else if (e.key === 'Backspace' && e.altKey) { e.preventDefault(); go(-1); }
        else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && e.altKey) { e.preventDefault(); go(-1); }
        else if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && e.altKey) { e.preventDefault(); go(1); }
      });
      win.el.addEventListener('mousedown', function (e) {
        if (e.button === 3) go(-1);
        else if (e.button === 4) go(1);
      });

      /* ---- start ---------------------------------------------------- */
      buildMenu();
      status('Done');
      var startInput = 'home';
      if (args && args.url) startInput = String(args.url);
      else if (args && args.path) startInput = String(args.path);
      addrIn.value = '';
      /* paint the first page straight away: don't wait for a timer */
      try {
        var firstTarget = ieTargetFor(startInput);
        renderTarget(firstTarget, {});
        addrIn.value = (firstTarget.path || firstTarget.url || startInput);
        win.setTitle('Microsoft Internet Explorer');
        addrIn.focus();
      } catch (e) {
        try { missingPage(startInput); } catch (e2) { }
      }
      paintLogo();

      return {
        onKey: function (e) {
          if (e.key === 'Escape') stopLoading();
        },
        onResize: function () { /* the page reflows by itself */ },
        onClose: function () {
          st.loading = false;
          clearTimers();
          if (st.rafCancel) { safe(function () { st.rafCancel(); }, null); st.rafCancel = null; }
          releaseUrls();
        }
      };
    }
  });

})();
