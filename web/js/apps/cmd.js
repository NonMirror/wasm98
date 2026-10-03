/* ============================================================================
   cmd.js — MS-DOS Prompt.  Runs against the WebAssembly kernel's filesystem,
   process table and memory accounting, so DIR/MEM/TASKLIST/CHKDSK report real
   state rather than canned text.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98, I = window.W98Icons, U = W98.util;
  var el = U.el, esc = U.escapeHtml;

  var DOS_GAMES = null;
  function loadDosGames() {
    if (DOS_GAMES) return Promise.resolve(DOS_GAMES);
    return fetch('games/dos/manifest.json').then(function (r) { return r.ok ? r.json() : []; })
      .then(function (m) { DOS_GAMES = (m.games || m || []); return DOS_GAMES; })
      .catch(function () { DOS_GAMES = []; return DOS_GAMES; });
  }

  function pad(s, n, right) {
    s = String(s);
    while (s.length < n) s = right ? s + ' ' : ' ' + s;
    return s;
  }
  function dosDate(ms) {
    var d = new Date(ms);
    return U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) + '-' + String(d.getFullYear()).slice(2) +
      '  ' + U.pad2(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12) + ':' + U.pad2(d.getMinutes()) +
      ' ' + (d.getHours() < 12 ? 'a' : 'p');
  }

  W98.registerApp({
    id: 'cmd',
    title: 'MS-DOS Prompt',
    icon: 'dos-prompt',
    width: 640, height: 400,
    minWidth: 320, minHeight: 200,
    desktop: false,
    startMenuGroup: null,
    create: function (win) {
      var cwd = 'C:\\WINDOWS';
      var boot = Date.now();
      var lines = [];

      win.el.style.background = '#000';
      win.el.style.color = '#c0c0c0';
      win.el.style.fontFamily = '"Lucida Console", "Courier New", monospace';
      win.el.style.fontSize = '13px';
      win.el.style.lineHeight = '15px';
      win.el.style.padding = '2px 4px';
      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';

      var out = el('div');
      out.style.cssText = 'white-space:pre;overflow:auto;flex:1 1 auto;min-height:0';
      var line = el('div');
      line.style.cssText = 'white-space:pre;flex:0 0 auto;display:flex;align-items:center';
      var promptEl = el('span');
      var input = el('input');
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.style.cssText = 'flex:1 1 auto;background:transparent;border:none;outline:none;color:#c0c0c0;' +
        'font:inherit;padding:0;caret-color:#c0c0c0';
      line.appendChild(promptEl);
      line.appendChild(input);
      win.el.appendChild(out);
      win.el.appendChild(line);

      function promptText() {
        return cwd + '>';
      }
      function updatePrompt() { promptEl.textContent = promptText(); }
      function print(text) {
        String(text).split('\n').forEach(function (l) { lines.push(l); });
        if (lines.length > 2000) lines = lines.slice(-1500);
        out.textContent = lines.join('\n');
        out.scrollTop = out.scrollHeight;
      }
      function clear() { lines = []; out.textContent = ''; }

      /* ---------------------------------------------------- path helpers */
      function resolve(p) {
        if (!p) return cwd;
        p = String(p).replace(/\//g, '\\');
        if (/^[A-Za-z]:/.test(p)) return p.replace(/\\$/, '') || p;
        if (/^\\/.test(p)) return 'C:' + p;
        return W98.fs.join(cwd, p);
      }
      function shortName(name) {
        var base = name, ext = '';
        var i = name.lastIndexOf('.');
        if (i > 0) { base = name.slice(0, i); ext = name.slice(i + 1); }
        return (base.slice(0, 8).toUpperCase() + (ext ? '.' + ext.slice(0, 3).toUpperCase() : ''));
      }
      function ok(msg) { if (msg) print(msg); }
      function mediaStatus(drive) {
        try {
          if (W98.media && typeof W98.media.status === 'function') return W98.media.status(drive);
          if (W98.media && typeof W98.media.state === 'function') {
            var s = W98.media.state();
            return s[String(drive).toUpperCase() === 'A' ? 'floppy' : 'cdrom'] || null;
          }
        } catch (e) { }
        return null;
      }
      function mutationError(result, path) {
        if (typeof result === 'number' && result >= 0) return false;
        var e = null;
        try { e = W98.media && typeof W98.media.lastError === 'function' ? W98.media.lastError() : null; } catch (x) { }
        if (e && e.message) print(e.message);
        else print('Write fault - ' + (path || 'the disk') + '.');
        return true;
      }

      /* ---------------------------------------------------- commands */
      var CMDS = {};

      CMDS.HELP = function () {
        print('For more information on a specific command, type HELP command-name\n');
        [
          ['ATTRIB', 'Displays or changes file attributes.'],
          ['CD', 'Displays the name of or changes the current directory.'],
          ['CHKDSK', 'Checks the kernel filesystem and displays a status report.'],
          ['CLS', 'Clears the screen.'],
          ['COPY', 'Copies one or more files to another location.'],
          ['DATE', 'Displays or sets the date.'],
          ['DEL', 'Deletes one or more files.'],
          ['DIR', 'Displays a list of files and subdirectories in a directory.'],
          ['EDIT', 'Starts the MS-DOS Editor (opens Notepad).'],
          ['EXIT', 'Quits the MS-DOS Prompt and returns to Windows.'],
          ['KERNEL', 'Displays WebAssembly kernel information and the system log.'],
          ['MD', 'Creates a directory.'],
          ['MEM', 'Displays the amount of memory used and free in the kernel.'],
          ['MORE', 'Displays output one screen at a time.'],
          ['PROMPT', 'Changes the command prompt.'],
          ['RD', 'Removes a directory.'],
          ['REG', 'Reads and writes the registry.'],
          ['REN', 'Renames a file or files.'],
          ['SET', 'Displays, sets or removes environment variables.'],
          ['START', 'Starts a program or opens a document.'],
          ['TASKLIST', 'Lists the processes in the kernel process table.'],
          ['TIME', 'Displays or sets the system time.'],
          ['TREE', 'Graphically displays the directory structure.'],
          ['TYPE', 'Displays the contents of a text file.'],
          ['VER', 'Displays the Windows version.'],
          ['VOL', 'Displays a disk volume label and serial number.']
        ].forEach(function (c) { print('  ' + c[0] + new Array(Math.max(2, 12 - c[0].length)).join(' ') + c[1]); });
      };

      CMDS.VER = function () { print('\nWindows 98 [Version 4.10.1998]\nkernel.wasm build ' + W98.version + ' (' + W98.kernelMode() + ')'); };
      CMDS.VOL = function (a) {
        var d = ((a || '').trim().charAt(0) || cwd.charAt(0)).toUpperCase(), m = mediaStatus(d);
        if (m) print('\n Volume in drive ' + d + ' is ' + m.label + '\n Volume Serial Number is ' + (m.manifestId || '1998-0528').slice(-8).toUpperCase());
        else if ((d === 'A' || d === 'D') && !W98.fs.exists(d + ':\\')) print('Drive ' + d + ' is not ready.');
        else print('\n Volume in drive ' + d + ' is MS-DOS_98\n Volume Serial Number is 1998-0528');
      };

      CMDS.CLS = function () { clear(); };
      CMDS.EXIT = function () { win.close(); };

      CMDS.DIR = function (a) {
        var wide = a.indexOf('/W') >= 0;
        var args = a.split(/\s+/).filter(function (x) { return x && x.charAt(0) !== '/'; });
        var target = resolve(args[0] || '');
        var list = W98.fs.list(target);
        if (!list) { print('Invalid directory - ' + target); return; }
        var drive = target.slice(0, 2), media = mediaStatus(drive.charAt(0));
        if ((drive.charAt(0).toUpperCase() === 'A' || drive.charAt(0).toUpperCase() === 'D') && !media) { print('Drive ' + drive.charAt(0).toUpperCase() + ' is not ready.'); return; }
        print('\n Volume in drive ' + drive.charAt(0) + ' is ' + (media ? media.label : 'MS-DOS_98'));
        print(' Volume Serial Number is ' + (media ? (media.manifestId || '1998-0528').slice(-8).toUpperCase() : '1998-0528'));
        print(' Directory of ' + target + '\n');
        var dirs = list.filter(function (e) { return e.dir; }), files = list.filter(function (e) { return !e.dir; });
        var totalBytes = files.reduce(function (x, y) { return x + y.size; }, 0);
        var d = new Date();
        var stamp = U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) + '-' + String(d.getFullYear()).slice(2);
        var clock = U.pad2((d.getHours() % 12) || 12) + ':' + U.pad2(d.getMinutes()) +
          (d.getHours() < 12 ? 'a' : 'p');
        function cols(name) {
          /* the 8.3 split MS-DOS always prints: NAME    EXT */
          var base = name, ext = '';
          var i = name.lastIndexOf('.');
          if (i > 0) { base = name.slice(0, i); ext = name.slice(i + 1); }
          return pad(base.slice(0, 8).toUpperCase(), 8) + ' ' + pad(ext.slice(0, 3).toUpperCase(), 3);
        }
        if (wide) {
          var row = '';
          dirs.concat(files).forEach(function (e, i) {
            var cell = e.dir ? ('[' + e.name.slice(0, 12).toUpperCase() + ']') : cols(e.name).replace(' ', '.');
            row += pad(cell, 19);
            if (i % 4 === 3) { print(row); row = ''; }
          });
          if (row) print(row);
        } else {
          function entry(name, size, isDir) {
            print(cols(name) + '  ' + (isDir ? '<DIR>       ' : pad(Number(size).toLocaleString('en-US'), 12)) +
              '  ' + stamp + '  ' + clock);
          }
          function dote(name) {
            print(pad(name, 8) + ' ' + pad('', 3) + '  <DIR>      ' + '  ' + stamp + '  ' + clock);
          }
          dote('.');
          if (target !== drive + '\\') dote('..');
          dirs.forEach(function (e) { entry(e.name, 0, true); });
          files.forEach(function (e) { entry(e.name, e.size, false); });
        }
        var st = W98.stats();
        var free = media ? media.free : 2 * 1024 * 1024 * 1024 - st.BYTES;
        print(pad(files.length + ' file(s)', 15, true) + pad(totalBytes.toLocaleString('en-US'), 16) + ' bytes');
        print(pad(dirs.length + ' dir(s)', 15, true) + pad(free.toLocaleString('en-US'), 16) +
          ' bytes free (kernel heap ' + Math.round(st.HEAP_FREE / 1024) + ' KB)');
      };

      CMDS.CD = function (a) {
        a = a.trim();
        if (/^[AD]:/i.test(cwd) && !mediaStatus(cwd.charAt(0))) { print('Drive ' + cwd.charAt(0).toUpperCase() + ' is not ready.'); return; }
        if (!a || a === '.') { print(cwd); return; }
        if (a === '\\') { cwd = 'C:\\'; updatePrompt(); return; }
        if (/^[A-Za-z]:$/.test(a)) {
          var drv = a.charAt(0).toUpperCase();
          if ((drv === 'A' || drv === 'D') && !mediaStatus(drv)) { print('Drive ' + drv + ' is not ready.'); return; }
          cwd = drv + ':\\'; updatePrompt(); return;
        }
        var t = resolve(a);
        if (!W98.fs.exists(t)) { print('Invalid directory'); return; }
        if (!W98.fs.isDir(t)) { print('Invalid directory'); return; }
        cwd = W98.fs.norm ? W98.fs.norm(t) : t;
        if (cwd.length > 3 && cwd.slice(-1) !== '\\') cwd = cwd;
        updatePrompt();
      };
      CMDS.CHDIR = CMDS.CD;

      CMDS.TYPE = function (a) {
        var f = a.trim().split(/\s+/)[0];
        if (!f) { print('Required parameter missing'); return; }
        var t = resolve(f);
        var bytes = W98.fs.readBytes(t);
        if (!bytes) { print('File not found - ' + t); return; }
        var isBin = false;
        for (var i = 0; i < Math.min(400, bytes.length); i++) if (bytes[i] === 0) { isBin = true; break; }
        if (isBin) { print('This file is binary. Use an application to view it.'); return; }
        print(new TextDecoder().decode(bytes).replace(/\r/g, ''));
      };

      CMDS.COPY = function (a) {
        var p = a.split(/\s+/).filter(Boolean);
        if (p.length < 2) { print('The syntax of the command is incorrect.'); return; }
        var src = resolve(p[0]), dst = resolve(p[1]);
        var bytes = W98.fs.readBytes(src);
        if (!bytes) { print('File not found - ' + src + '\n        0 file(s) copied.'); return; }
        if (W98.fs.isDir(dst)) dst = W98.fs.join(dst, p[0].split('\\').pop());
        var copied = W98.fs.writeBytes(dst, bytes);
        if (mutationError(copied, dst)) { print('        0 file(s) copied.'); return; }
        print('        1 file(s) copied.');
      };

      CMDS.DEL = function (a) {
        var f = a.trim().split(/\s+/)[0];
        if (!f) { print('Required parameter missing'); return; }
        var t = resolve(f);
        if (W98.fs.isDir(t)) { print('Access denied - ' + t); return; }
        var removed = W98.fs.remove(t);
        if (mutationError(removed, t)) return;
        if (removed === 0 || !W98.fs.exists(t)) print('Deleted ' + t);
        else print('File not found - ' + t);
      };
      CMDS.ERASE = CMDS.DEL;

      CMDS.REN = function (a) {
        var p = a.split(/\s+/).filter(Boolean);
        if (p.length < 2) { print('The syntax of the command is incorrect.'); return; }
        var src = resolve(p[0]);
        if (!W98.fs.exists(src)) { print('File not found - ' + src); return; }
        mutationError(W98.fs.rename(src, W98.fs.join(W98.fs.parent(src), p[1])), src);
      };

      CMDS.MD = function (a) { var t = resolve(a.trim()); mutationError(W98.fs.mkdir(t), t); };
      CMDS.MKDIR = CMDS.MD;
      CMDS.RD = function (a) {
        var t = resolve(a.trim());
        var list = W98.fs.list(t) || [];
        if (list.length) { print('Directory not empty - ' + t); return; }
        mutationError(W98.fs.remove(t), t);
      };
      CMDS.RMDIR = CMDS.RD;

      CMDS.ECHO = function (a) { print(a.trim() === '' ? 'ECHO is on.' : a.trim()); };

      CMDS.MEM = function () {
        var st = W98.stats();
        print('\nMemory Type        Total       Used       Free');
        print('----------------  ---------  ---------  ---------');
        print('Kernel heap       ' + pad(Math.round(st.HEAP_SIZE / 1024) + ' KB', 11) + pad(Math.round(st.HEAP_USED / 1024) + ' KB', 11) + pad(Math.round(st.HEAP_FREE / 1024) + ' KB', 11));
        print('Temp buffer       ' + pad(Math.round(st.TMP_CAP / 1024) + ' KB', 11) + pad('-', 11) + pad(Math.round(st.TMP_CAP / 1024) + ' KB', 11));
        print('Volume (C:)       ' + pad('2048 MB', 11) + pad(Math.round(st.BYTES / 1024) + ' KB', 11) + pad(Math.round((2 * 1024 * 1024 * 1024 - st.BYTES) / 1024) + ' KB', 11));
        print('\nLargest executable program size is the whole heap: ' + Math.round(st.HEAP_FREE / 1024) + ' KB');
        print('kernel heap peak since boot: ' + Math.round(W98.heapPeak() / 1024) + ' KB');
        print('\nProcesses: ' + st.NDESC + '   Timers: ' + st.QUEUE + '   Syscalls: ' + st.SYSCALLS);
        print('Uptime: ' + Math.floor(st.UPTIME / 1000) + ' s   Scheduler switches: ' + st.SWITCHES);
      };

      CMDS.CHKDSK = function () {
        var st = W98.stats();
        print('\nVolume MS-DOS_98     created 05-28-1998 12:00p');
        print('Volume Serial Number is 1998-0528\n');
        print('Checking the kernel filesystem (kernel.wasm, in-memory VFS)...');
        var bad = 0, checked = 0;
        (function walk(p, depth) {
          var list = W98.fs.list(p) || [];
          list.forEach(function (e) {
            checked++;
            if (e.name.length > 63 || /[\\/:*?"<>|]/.test(e.name)) { bad++; print('  bad filename: ' + p + '\\' + e.name); }
            if (e.dir && depth < 8) walk(W98.fs.join(p, e.name), depth + 1);
          });
        })(  'C:\\', 0);
        print('  ' + checked + ' entries checked, ' + bad + ' problems found.');
        var bytes = st.BYTES;
        print('\n  ' + Math.round(bytes / 1024) + ' KB in ' + st.FILES + ' files');
        print('  ' + Math.round(st.HEAP_USED / 1024) + ' KB used by the kernel heap (peak ' + Math.round(W98.heapPeak() / 1024) + ' KB)');
        print('  ' + checked + ' directory entries in ' + st.NODES + ' nodes');
        print('  ' + (bad ? 'File system has errors' : 'No errors found on this volume'));
      };

      CMDS.TASKLIST = function () {
        print('\nImage Name                     PID   CPU Time   State      Window');
        print('=============================  =====  =========  =========  ======');
        var procs = W98.kernelProcs ? W98.kernelProcs() : [];
        procs.forEach(function (p) {
          var w = W98.windowByPid(p.pid);
          print(pad(p.name, 29) + '  ' + pad(p.pid, 5) + '  ' +
            pad((p.cpuUs / 1000000).toFixed(3) + ' s', 9) + '  ' +
            pad(['', 'Running', 'Minimized', 'Hidden', 'Zombie'][p.state] || '?', 9) + '  ' +
            (w ? 'z=' + w.z : '-'));
        });
      };

      CMDS.KERNEL = function () {
        var st = W98.stats();
        print('\nWebAssembly kernel image');
        print('  module        : web/wasm/kernel.wasm (' + (W98.kernelMode() === 'wasm' ? Math.round(W98.moduleBytes() / 1024) + ' KB' : 'not loaded - shim') + ')');
        print('  ABI version   : 0x' + (st.VERSION >>> 0).toString(16).padStart(8, '0'));
        print('  syscalls      : ' + st.SYSCALLS + ' total, ' + st.TICKS + ' heartbeats');
        print('  heap          : ' + Math.round(st.HEAP_USED / 1024) + ' KB used, ' + Math.round(st.HEAP_FREE / 1024) + ' KB free, peak ' + Math.round(W98.heapPeak() / 1024) + ' KB');
        print('  filesystem    : ' + st.FILES + ' files, ' + st.BYTES + ' bytes, ' + st.NODES + ' nodes');
        print('  registry      : ' + st.REG + ' values');
        print('  processes     : ' + st.NDESC + ' (next pid ' + st.NEXT_PID + ')');
        print('  timers        : ' + st.QUEUE + ' queued, ' + st.TIMERS + ' fired, ' + st.DROPPED + ' dropped');
        print('  scheduler     : ' + st.SWITCHES + ' switches, quantum ' + st.SLICE + ' ms, current pid ' + st.CURRENT);
        print('\nKernel log (most recent ' + Math.min(12, 12) + ' lines):');
        var log = W98.kernelLog().trim().split('\n').slice(-12);
        log.forEach(function (l) { print('  ' + l); });
      };

      CMDS.REG = function (a) {
        var p = a.trim().split(/\s+/);
        if (p[0] && p[0].toUpperCase() === 'QUERY' && p[1]) {
          print('\n' + p[1]);
          var prefix = p[1].toUpperCase();
          var seen = 0;
          W98.registry.forEach(function () { });
          /* the kernel registry is a flat list; probe the values we know about */
          ['.Current'].forEach(function (n) { });
          var hits = W98.regSearch ? W98.regSearch(prefix) : [];
          hits.forEach(function (h) { print('    ' + h.name + '    REG_SZ    ' + h.value); seen++; });
          if (!seen) print('    (no values found)');
          return;
        }
        if (p[0] && p[0].toUpperCase() === 'SET' && p.length >= 4) {
          W98.reg.set(p[1], p[2], p.slice(3).join(' '));
          print('Value ' + p[2] + ' set.');
          return;
        }
        print('REG QUERY <key>            displays values under a key');
        print('REG SET <key> <name> <v>   writes a value');
      };

      CMDS.SET = function (a) {
        if (!a.trim()) {
          print('COMSPEC=C:\\WINDOWS\\COMMAND.COM');
          print('PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND');
          print('PROMPT=' + promptText().replace(cwd, '$p'));
          print('TEMP=C:\\WINDOWS\\TEMP');
          print('windir=C:\\WINDOWS');
          return;
        }
        print(a.trim());
      };
      CMDS.PATH = function () { print('PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND'); };
      CMDS.PROMPT = function (a) { print(a ? 'Prompt set to ' + a.trim() : 'PROMPT=' + promptText()); };

      CMDS.DATE = function () { print('Current date is ' + new Date().toDateString()); };
      CMDS.TIME = function () { print('Current time is ' + new Date().toLocaleTimeString()); };

      CMDS.TREE = function (a) {
        var root = resolve(a.trim() || '');
        print('Directory PATH listing for Volume MS-DOS_98');
        print('Volume Serial Number is 1998-0528');
        print(root);
        (function walk(p, prefix, depth) {
          if (depth > 4) return;
          var list = (W98.fs.list(p) || []).filter(function (e) { return e.dir; });
          list.forEach(function (e, i) {
            var last = i === list.length - 1;
            print(prefix + (last ? '\\---' : '+---') + e.name);
            if (depth < 4) walk(W98.fs.join(p, e.name), prefix + (last ? '    ' : '|   '), depth + 1);
          });
        })(root, '', 0);
      };

      CMDS.EDIT = function (a) { W98.launch('notepad', a.trim() ? { path: resolve(a.trim()) } : undefined); };
      CMDS.START = function (a) { runExternal(a.trim()); };
      CMDS.WIN = function () { W98.launch('explorer', { path: 'C:\\', special: 'computer' }); };
      CMDS.FORMAT = function (a) {
        if (!a.trim()) { print('Required parameter missing'); return; }
        print('WARNING: ALL DATA ON NON-REMOVABLE DISK\nDRIVE ' + a.trim() + ': WILL BE LOST!\nProceed with Format (Y/N)? N');
        print('\nFormat terminated. The kernel volume is read-only to you; it lives in WebAssembly.');
      };
      CMDS.ATTRIB = function (a) { print(a ? 'A    ' + resolve(a.trim()) : 'A    C:\\*.*'); };
      CMDS.MORE = function (a) {
        if (a.trim()) { CMDS.TYPE(a); return; }
        print('MORE: displays output one screen at a time (you are using it)');
      };
      CMDS.FDISK = function () { print('FDISK is not supported: the kernel presents a fixed C: volume and virtual removable media.'); };
      CMDS.MSCDEX = function () {
        var m = mediaStatus('D');
        print('MSCDEX Version 2.25\n' + (m ? 'Drive D: = CD-ROM ' + m.label : 'CD-ROM device driver not loaded.'));
      };

      function runExternal(cmd) {
        if (!cmd) return;
        var lc = cmd.toLowerCase().replace(/\.exe$/, '').replace(/\.com$/, '');
        var map = {
          notepad: 'notepad', edit: 'notepad', mspaint: 'paint', paint: 'paint', pbrush: 'paint',
          calc: 'calculator', charmap: 'charmap', mplayer: 'mplayer', msimn: 'ie', iexplore: 'ie',
          control: 'control', taskmgr: 'taskmgr', explorer: 'explorer', winver: 'winver', sol: 'solitaire',
          freecell: 'freecell', winmine: 'minesweeper', jezzball: 'jezzball', pinball: 'pinball',
          '3d pinball': 'pinball', cmd: 'cmd', command: 'cmd', run: 'run', find: 'find', help: 'help'
        };
        if (map[lc]) { W98.launch(map[lc]); return; }
        var full = resolve(cmd);
        if (W98.fs.exists(full)) {
          if (W98.fs.isDir(full)) { W98.launch('explorer', { path: full }); return; }
          var ext = (full.split('.').pop() || '').toLowerCase();
          if (ext === 'txt' || ext === 'bat' || ext === 'sys' || ext === 'ini') { W98.launch('notepad', { path: full }); return; }
          if (ext === 'bmp') { W98.launch('paint', { path: full }); return; }
          if (ext === 'wav') { W98.launch('mplayer', { path: full }); return; }
        }
        loadDosGames().then(function (games) {
          var hit = games.filter(function (g) {
            return (g.id || '').toLowerCase() === lc || (g.title || '').toLowerCase().indexOf(lc) === 0;
          })[0];
          if (hit) {
            print('Starting ' + (hit.title || hit.id) + ' under DOSBox (WebAssembly)...');
            W98.launch('dosgame', { bundle: hit.file, title: hit.title || hit.id, exe: hit.exe });
            return;
          }
          print('Bad command or file name');
        });
      }

      /* ---------------------------------------------------- the shell loop */
      var history2 = [], histIdx = -1;
      function exec(raw) {
        var cmd = raw.trim();
        if (!cmd) return;
        var sp = cmd.indexOf(' ');
        var name = (sp < 0 ? cmd : cmd.slice(0, sp)).toUpperCase();
        var rest = sp < 0 ? '' : cmd.slice(sp + 1);
        print(promptText() + cmd);
        history2.push(cmd);
        histIdx = history2.length;
        if (CMDS[name]) {
          try { CMDS[name](rest); }
          catch (e) { print('Kernel call failed: ' + e.message); }
          return;
        }
        if (/^[A-Za-z]:$/.test(cmd)) { CMDS.CD(cmd); return; }
        if (name === 'CD' || name === 'CHDIR') { CMDS.CD(rest); return; }
        if (/\.(exe|com|bat)$/i.test(name)) { runExternal(cmd); return; }
        print('Bad command or file name');
      }

      function tabComplete() {
        var v = input.value;
        var sp = v.lastIndexOf(' ');
        var frag = sp < 0 ? v : v.slice(sp + 1);
        if (!frag) return;
        var dirPart = frag.indexOf('\\') >= 0 ? W98.fs.parent(resolve(frag)) : cwd;
        try {
          var base = (frag.split('\\').pop() || '').toLowerCase();
          var hits = (W98.fs.list(dirPart) || []).filter(function (e) { return e.name.toLowerCase().indexOf(base) === 0; });
          if (!hits.length) return;
          var name = hits[0].name;
          input.value = (sp < 0 ? '' : v.slice(0, sp + 1)) + name;
        } catch (e) { }
      }

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = input.value;
          input.value = '';
          exec(v);
          win.el.scrollTop = win.el.scrollHeight;
          e.preventDefault();
          return;
        }
        if (e.key === 'ArrowUp') {
          if (histIdx > 0) { histIdx--; input.value = history2[histIdx]; }
          e.preventDefault(); return;
        }
        if (e.key === 'ArrowDown') {
          if (histIdx < history2.length - 1) { histIdx++; input.value = history2[histIdx]; }
          else { histIdx = history2.length; input.value = ''; }
          e.preventDefault(); return;
        }
        if (e.key === 'Tab') { tabComplete(); e.preventDefault(); return; }
        if (e.key === 'Escape') { input.value = ''; e.preventDefault(); return; }
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
          print(promptText() + input.value + '^C');
          input.value = '';
          e.preventDefault();
          return;
        }
        if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { clear(); e.preventDefault(); }
      });
      win.el.addEventListener('mousedown', function () { input.focus(); });
      win.setMenu([
        {
          label: '&File', items: [
            { label: '&New', onclick: function () { clear(); print(banner()); } },
            { label: '&Close', onclick: function () { win.close(); } },
            { label: 'E&xit', onclick: function () { win.close(); } }
          ]
        },
        {
          label: '&Edit', items: [
            { label: '&Mark', onclick: function () { W98.dialog.alert('MS-DOS Prompt', 'Mark is not available in this window.', 'info'); } },
            { label: '&Paste', disabled: true },
            { label: '&Scroll', onclick: function () { out.scrollTop = 0; } }
          ]
        },
        {
          label: '&View', items: [
            { label: '&Toolbar', type: 'check', checked: false, disabled: true },
            { label: '&Font...', onclick: function () { W98.dialog.alert('Font', 'The raster font is fixed: 8x16 VGA, 80 columns.', 'info'); } }
          ]
        },
        {
          label: '&Properties', items: [
            { label: 'Show kernel statistics', onclick: function () { promptEl.textContent = ''; exec('KERNEL'); updatePrompt(); } },
            { label: 'Show kernel heap', onclick: function () { promptEl.textContent = ''; exec('MEM'); updatePrompt(); } }
          ]
        }
      ]);
      win.setIcon('dos-prompt');

      function banner() {
        return 'Microsoft(R) Windows 98\n   (C)Copyright Microsoft Corp 1981-1998.\n';
      }
      clear();
      print(banner());
      print('This prompt runs on kernel.wasm: the volume, the registry and the process');
      print('table you can list with TASKLIST are all served from WebAssembly.  Type HELP.\n');
      updatePrompt();
      setTimeout(function () { input.focus(); }, 60);
      win.on('focus', function () { try { input.focus(); } catch (e) { } });
      void boot; void dosDate;
      return {};
    }
  });
})();
