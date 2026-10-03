/* ============================================================================
 * kernel-lab.js — read-only WinDbg-inspired diagnostics for wasm98.
 *
 * Every value is obtained through the documented W98/W98HV surfaces.  The
 * executive currently exposes aggregate counters rather than object records;
 * the command views say so explicitly instead of manufacturing rows.
 * ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98;
  if (!W98 || typeof W98.registerApp !== 'function') return;
  // Diagnostic data is always text, including names supplied by other apps.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  var MAX_LINES = 420;
  var MAX_REGISTRY = 180;
  var MAX_SCAN = 4096;
  var MAX_RECORDS = 200;
  var MAX_CHARS = 65536;
  var MAX_CELL = 1024;
  var MAX_COMMAND = 256;
  var NOT_EXPOSED = 'not exposed by this build';
  var STATE = ['', 'Running', 'Minimized', 'Hidden', 'Zombie'];
  var PART_STATE = ['empty', 'created', 'initialised', 'running', 'paused', 'stopped', 'faulted', 'deleted'];

  function text(v) {
    if (v === undefined || v === null) return NOT_EXPOSED;
    return clip(String(v));
  }
  function clip(value, limit) {
    var s = String(value), n = limit || MAX_CELL;
    return s.length > n ? s.slice(0, n) + ' [truncated]' : s;
  }
  function num(v) {
    return v === undefined || v === null ? NOT_EXPOSED : String(v);
  }
  function hex(v, width) {
    if (v === undefined || v === null || v === '') return NOT_EXPOSED;
    var s = (Number(v) >>> 0).toString(16).toUpperCase();
    while (s.length < (width || 8)) s = '0' + s;
    return '0x' + s;
  }
  function safe(fn, dflt) {
    try {
      var v = fn();
      return v === undefined || v === null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function stats() { return safe(function () { return W98.stats ? W98.stats() : {}; }, {}); }
  function execApi() {
    return safe(function () {
      if (typeof W98.exec === 'function') return W98.exec();
      if (W98.kernel && typeof W98.kernel.exec === 'function') return W98.kernel.exec();
      return null;
    }, null);
  }
  function logText() {
    return safe(function () {
      if (typeof W98.logText === 'function') return W98.logText() || '';
      if (typeof W98.kernelLog === 'function') return W98.kernelLog() || '';
      if (W98.kernel && typeof W98.kernel.logText === 'function') return W98.kernel.logText() || '';
      return '';
    }, '');
  }
  function hvApi() {
    // W98.hv may be the separate NT executive facade, not the hypervisor.
    var candidates = [global.W98HV, W98.hv];
    for (var i = 0; i < candidates.length; i++) {
      var h = candidates[i];
      if (h && h.mode !== 'none' && (typeof h.partitions === 'function' || typeof h.partitionList === 'function')) return h;
    }
    return null;
  }
  function hvCall(h, names, args, dflt) {
    if (!h) return dflt;
    for (var i = 0; i < names.length; i++) {
      if (typeof h[names[i]] === 'function') return safe(function () { return h[names[i]].apply(h, args || []); }, dflt);
    }
    return dflt;
  }
  function lines() { return Array.prototype.slice.call(arguments); }
  function link(label, action) { return { label: String(label), action: action }; }
  function line(value) { return { text: String(value === undefined ? '' : value) }; }
  function bounded(arr, n) { return (arr || []).slice(0, n || MAX_LINES); }

  function processList() {
    var ps = safe(function () { return typeof W98.kernelProcs === 'function' ? W98.kernelProcs() : []; }, []);
    return Array.isArray(ps) ? ps : [];
  }
  function registryList(prefix) {
    if (typeof W98.regEnum !== 'function') return null;
    var total = safe(function () {
      return typeof W98.regCount === 'function' ? W98.regCount() : stats().REG;
    }, null);
    var out = [], scanned = 0, exhausted = false;
    var bound = typeof total === 'number' && total >= 0 ? Math.min(total, MAX_SCAN) : MAX_SCAN;
    for (var i = 0; i < bound; i++) {
      var r = safe(function () { return W98.regEnum(i); }, null);
      scanned++;
      if (!r) { exhausted = true; break; }
      if (prefix && String(r.path || '').toLowerCase().indexOf(prefix.toLowerCase()) !== 0) continue;
      out.push(r);
      if (out.length >= MAX_REGISTRY) break;
    }
    return { rows: out, count: total, scanned: scanned,
      truncated: !exhausted && (typeof total !== 'number' || scanned < total) };
  }
  function windowRecord(pid) {
    if (typeof W98.windowByPid !== 'function') return undefined;
    return safe(function () {
      var w = W98.windowByPid(pid);
      // Copy public metadata only; retain no shell window/DOM references.
      return w ? { title: w.title, width: w.width, height: w.height } : null;
    }, undefined);
  }
  function windowDetails(pid, w) {
    if (w === undefined) return [line('Windows: ' + NOT_EXPOSED)];
    if (w === null) return [line('No window is associated with PID ' + pid + '.')];
    return lines('Window for PID ' + pid, 'title      : ' + text(w.title),
      'client size: ' + num(w.width) + ' × ' + num(w.height),
      '', 'Metadata snapshot; the target window is not focused or changed.').map(line);
  }
  function processDetails(p) {
    var out = [line('Process details')];
    out.push(line('name       : ' + text(p.name)));
    out.push(line('pid        : ' + num(p.pid)));
    out.push(line('state      : ' + (STATE[p.state] || text(p.state))));
    out.push(line('cpu time   : ' + (p.cpuUs === undefined ? NOT_EXPOSED : (Number(p.cpuUs) / 1000000).toFixed(3) + ' s')));
    out.push(line('started    : ' + num(p.started) + ' ms'));
    out.push(line('flags      : ' + num(p.flags)));
    var w = windowRecord(p.pid);
    out.push({ parts: [line('window     : '), link(w ? text(w.title) : 'Windows for PID ' + p.pid, function () { return windowDetails(p.pid, w); })] });
    out.push(line('thread list: ' + NOT_EXPOSED));
    return out;
  }
  function commandHelp() {
    return lines(
      'Kernel Lab commands (read-only):',
      '  !process [pid]       processes and shell windows',
      '  !thread              NT dispatcher thread counters',
      '  !handle              executive handle counters',
      '  !timer               kernel timer counters',
      '  !pool                paged/nonpaged pool counters',
      '  !irp                 I/O request packet counters',
      '  !object              executive object counters',
      '  !registry [prefix]    enumerate registry values',
      '  !partition            hypervisor partitions and VPs',
      '  !vmbus                kernel and hypervisor VMBus state',
      '  !bugcheck             last exposed bugcheck/dump',
      '  !help                 this help',
      '',
      'Use the Crash Lab buttons below to inspect the log or run the',
      'existing controlled bugcheck after an explicit confirmation.'
    ).map(line);
  }

  function renderProcess(args) {
    var ps = processList(), out = lines('!process  (kernel process table)', 'Image name                     PID     CPU time      State       Window', '----------------------------------------------------------------------------');
    if (args) {
      var wanted = parseInt(args, 10);
      ps = ps.filter(function (p) { return p.pid === wanted || String(p.name).toLowerCase().indexOf(args.toLowerCase()) >= 0; });
    }
    if (!ps.length) return out.concat([line(args ? 'No matching process.' : '(no processes)')]);
    ps.slice(0, MAX_RECORDS).forEach(function (p) {
      var w = windowRecord(p.pid);
      var row = line('');
      row.parts = [
        link(text(p.name), function () { return processDetails(p); }),
        line('  '),
        link(String(p.pid), function () { return processDetails(p); }),
        line('  ' + (p.cpuUs === undefined ? NOT_EXPOSED : (Number(p.cpuUs) / 1000000).toFixed(3) + ' s')),
        line('  ' + (STATE[p.state] || text(p.state))),
        line('  '),
        link(w ? text(w.title) : 'Windows for PID ' + p.pid, function () { return windowDetails(p.pid, w); })
      ];
      out.push(row);
    });
    if (ps.length > MAX_RECORDS) out.push(line('[Showing first ' + MAX_RECORDS + ' of ' + ps.length + ' processes]'));
    out.push(line(''));
    out.push(line('PID and Window values are selectable links; selection only changes this diagnostic view.'));
    return out;
  }
  function renderThread() {
    var e = execApi();
    if (!e) return lines('!thread', 'NT executive snapshot: ' + NOT_EXPOSED).map(line);
    return lines('!thread  (NT dispatcher)',
      'threads             : ' + num(e.threads),
      'current thread      : ' + num(e.currentTid),
      'ready / running     : ' + num(e.ready) + ' / ' + num(e.running),
      'waiting             : ' + num(e.waiting),
      'ready depth         : ' + num(e.readyDepth),
      'dispatcher waits    : ' + num(e.waits) + ' (timeouts ' + num(e.waitTimeouts) + ')',
      'context switches    : ' + num(e.switches),
      'per-thread records  : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderHandle() {
    var e = execApi();
    return lines('!handle  (NT handle table)',
      'total handles       : ' + (e ? num(e.handles) : NOT_EXPOSED),
      'access checks       : ' + (e ? num(e.accessChecks) : NOT_EXPOSED),
      'access denied       : ' + (e ? num(e.accessDenies) : NOT_EXPOSED),
      'per-handle records  : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderTimer() {
    var s = stats(), e = execApi();
    return lines('!timer  (kernel timer queue)',
      'queued timers       : ' + num(s.QUEUE),
      'timers fired        : ' + num(s.TIMERS),
      'timers dropped      : ' + num(s.DROPPED),
      'wait timeouts       : ' + (e ? num(e.waitTimeouts) : NOT_EXPOSED),
      'timer records       : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderPool() {
    var e = execApi();
    return lines('!pool  (NT memory manager — bytes)',
      'paged pool          : ' + (e ? num(e.poolPaged) : NOT_EXPOSED),
      'paged pool peak     : ' + (e ? num(e.poolPagedPeak) : NOT_EXPOSED),
      'nonpaged pool       : ' + (e ? num(e.poolNonpaged) : NOT_EXPOSED),
      'nonpaged pool peak  : ' + (e ? num(e.poolNonpagedPeak) : NOT_EXPOSED),
      'pool allocations    : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderIrp() {
    var e = execApi();
    return lines('!irp  (I/O request packets)',
      'created             : ' + (e ? num(e.irpCreated) : NOT_EXPOSED),
      'completed           : ' + (e ? num(e.irpCompleted) : NOT_EXPOSED),
      'failed              : ' + (e ? num(e.irpFailed) : NOT_EXPOSED),
      'cancelled           : ' + (e ? num(e.irpCancelled) : NOT_EXPOSED),
      'stack overflows     : ' + (e ? num(e.irpOverflow) : NOT_EXPOSED),
      'individual IRPs     : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderObject() {
    var e = execApi();
    return lines('!object  (executive object namespace)',
      'objects             : ' + (e ? num(e.objects) : NOT_EXPOSED),
      'object peak         : ' + (e ? num(e.objectPeak) : NOT_EXPOSED),
      'deletions           : ' + (e ? num(e.objectDeletes) : NOT_EXPOSED),
      'named object tree   : ' + NOT_EXPOSED,
      'per-object records  : ' + NOT_EXPOSED
    ).map(line);
  }
  function renderRegistry(args) {
    var r = registryList(args), out = [line('!registry' + (args ? ' ' + args : ''))];
    if (!r) return out.concat([line('Registry enumeration: ' + NOT_EXPOSED)]);
    if (!r.rows.length) out.push(line(args ? 'No values matched in the scanned range.' : '(no enumerated registry values)'));
    r.rows.forEach(function (v) {
      out.push(line(text(v.path) + ' | ' + (v.name === '' ? '(Default)' : text(v.name)) + ' = ' + (v.value === '' ? '(empty string)' : text(v.value))));
    });
    out.push(line('Shown ' + r.rows.length + ' matches; scanned ' + r.scanned + ' entries; total: ' + num(r.count) + '.'));
    if (r.truncated) out.push(line('[Enumeration bounded: at most ' + MAX_REGISTRY + ' matches / ' + MAX_SCAN + ' entries per command.]'));
    return out;
  }
  function renderPartition() {
    var h = hvApi(), out = lines('!partition  (Hyper-V partition state)');
    if (!h) return out.concat([line('Hypervisor unavailable — partition state is ' + NOT_EXPOSED + '.')]);
    var ps = hvCall(h, ['partitions', 'partitionList'], [], null);
    if (!Array.isArray(ps)) return out.concat([line('Partition records: ' + NOT_EXPOSED)]);
    var vps = hvCall(h, ['vps'], [], null);
    if (!Array.isArray(vps) && typeof h.vpList === 'function') {
      vps = [];
      ps.forEach(function (p) {
        var pv = safe(function () { return h.vpList(p.id); }, []);
        if (Array.isArray(pv)) vps = vps.concat(pv);
      });
    }
    if (!Array.isArray(vps)) vps = null;
    out.push(line('id   Name                         State       VPs   Memory       Mapped pages'));
    out.push(line('--------------------------------------------------------------------------------'));
    if (!ps.length) out.push(line('(no partitions)'));
    ps.slice(0, MAX_RECORDS).forEach(function (p) {
      var name = text(p.name).slice(0, 28);
      var row = line('');
      var vpCount = p.vpCount;
      if (vpCount === undefined) vpCount = Array.isArray(p.vps) ? p.vps.length : p.vps;
      row.parts = [link(String(p.id), function () { return partitionDetails(p, vps); }), line('   ' + name + '  ' + text(p.stateName || PART_STATE[p.state]) + '  ' + num(vpCount) + '   ' + num(p.memoryBytes) + '   ' + num(p.mappedPages))];
      out.push(row);
      (vps || []).slice(0, MAX_RECORDS).filter(function (v) { return v.partition === p.id; }).forEach(function (v) {
        out.push({ text: '       VP ' + v.index + '  ', parts: [line('       VP ' + v.index + '  '), link('id=' + v.id, function () { return vpDetails(v); })] });
      });
    });
    return out;
  }
  function partitionDetails(p, vps) {
    var vpCount = p.vpCount;
    if (vpCount === undefined) vpCount = Array.isArray(p.vps) ? p.vps.length : p.vps;
    var out = lines('Partition details', 'id          : ' + num(p.id), 'name        : ' + text(p.name),
      'state       : ' + text(p.stateName === undefined ? PART_STATE[p.state] : p.stateName),
      'vps         : ' + num(vpCount), 'memory bytes: ' + num(p.memoryBytes), 'mapped pages: ' + num(p.mappedPages),
      'hypercalls  : ' + num(p.hypercalls), 'faults      : ' + num(p.faults), 'runs        : ' + num(p.runs)).map(line);
    if (!vps) out.push(line('VP records: ' + NOT_EXPOSED));
    else vps.slice(0, MAX_RECORDS).filter(function (v) { return v.partition === p.id; }).forEach(function (v) {
      out.push({ parts: [link('VP ' + v.index + ' (id ' + v.id + ')', function () { return vpDetails(v); })] });
    });
    return out;
  }
  function vpDetails(v) {
    return lines('Virtual processor details', 'id          : ' + num(v.id), 'partition   : ' + num(v.partition), 'index       : ' + num(v.index), 'state       : ' + text(v.stateName), 'run time    : ' + num(v.runMs) + ' ms', 'hypercalls  : ' + num(v.hypercalls), 'faults      : ' + num(v.faults), 'instructions: ' + num(v.instr), 'preempts    : ' + num(v.preempts)).map(line);
  }
  function renderVmbus() {
    var h = hvApi(), out = lines('!vmbus  (kernel transport and Hyper-V channels)'), ks = execApi();
    var ktx = safe(function () { return W98.vmbusStats ? W98.vmbusStats() : null; }, null);
    if (typeof ktx === 'number') ktx = { count: ktx, bytes: safe(function () { return W98.vmbusStats(1); }, undefined) };
    if (!ktx && W98.kernel && typeof W98.kernel.vmbusStats === 'function') ktx = safe(function () { return { count: W98.kernel.vmbusStats(0), bytes: W98.kernel.vmbusStats(1) }; }, null);
    out.push(line('kernel messages     : ' + (ks ? num(ks.vmbusMsgs) : NOT_EXPOSED)));
    out.push(line('kernel tx count     : ' + (ktx && ktx.count !== undefined ? num(ktx.count) : NOT_EXPOSED)));
    out.push(line('kernel tx bytes     : ' + (ktx && ktx.bytes !== undefined ? num(ktx.bytes) : NOT_EXPOSED)));
    if (!h) return out.concat([line('hypervisor channels : ' + NOT_EXPOSED + ' (hypervisor unavailable)')]);
    var s = hvCall(h, ['vmbusStats'], [], {}), ch = hvCall(h, ['vmbus'], [], null);
    if (ch && !Array.isArray(ch)) { s = ch.stats || s; ch = ch.channels; }
    if (!Array.isArray(ch)) ch = null;
    out.push(line('hypervisor channels : ' + num(s.channels === undefined ? (ch ? ch.length : undefined) : s.channels)));
    out.push(line('channel messages    : ' + num(s.messages === undefined ? s.channelMessages : s.messages)));
    out.push(line('dropped             : ' + num(s.dropped === undefined ? s.channelDropped : s.dropped)));
    (ch || []).slice(0, MAX_RECORDS).forEach(function (c) { out.push(line('channel ' + num(c.id || c.slot) + ' partition=' + num(c.partition) + ' state=' + text(c.stateName || c.state) + ' in=' + num(c.inBytes) + ' out=' + num(c.outBytes))); });
    return out;
  }
  function parseBugcheck(dump) {
    var m = String(dump || '').match(/\*\*\* STOP:\s*0x([0-9A-Fa-f]+)\s*\(0x([0-9A-Fa-f]+),\s*0x([0-9A-Fa-f]+),\s*0x([0-9A-Fa-f]+),\s*0x([0-9A-Fa-f]+)/);
    return m ? { code: '0x' + m[1].toUpperCase(), params: m.slice(2).map(function (x) { return '0x' + x.toUpperCase(); }) } : null;
  }
  function bugcheckSnapshot() {
    var e = execApi(), direct = safe(function () {
      return W98.hv && typeof W98.hv.bugcheck === 'function' ? W98.hv.bugcheck() : null;
    }, null);
    var dump = direct && direct.dump !== undefined ? direct.dump : (e && typeof e.bugcheckDump === 'function' ? safe(function () { return e.bugcheckDump(); }, '') : '');
    var parsed = parseBugcheck(dump), params = direct && Array.isArray(direct.params) ? direct.params : null;
    return { exec: e, direct: direct, dump: dump, parsed: parsed, params: params };
  }
  function renderBugcheck() {
    var snap = bugcheckSnapshot(), e = snap.exec, direct = snap.direct, s = stats(), dump = snap.dump;
    var parsed = snap.parsed, params = snap.params || (parsed && parsed.params), out = lines('!bugcheck  (last exposed kernel bugcheck)');
    var hasDirectCode = direct && direct.code !== undefined && (direct.halted || direct.code || direct.count);
    if (hasDirectCode) out.push(line('code                : ' + hex(direct.code)));
    else if (parsed) out.push(line('code                : ' + parsed.code));
    else {
      out.push(line('code                : ' + (e && e.bugchecks === 0 ? 'no bugcheck recorded this boot' : NOT_EXPOSED)));
    }
    if (params) {
      out.push(line('parameter 1         : ' + hex(params[0])));
      out.push(line('parameter 2         : ' + hex(params[1])));
      out.push(line('parameter 3         : ' + hex(params[2])));
      out.push(line('parameter 4         : ' + hex(params[3])));
    } else {
      out.push(line('parameters          : ' + NOT_EXPOSED));
    }
    out.push(line('bugcheck count      : ' + (direct && direct.count !== undefined ? num(direct.count) : (e ? num(e.bugchecks) : NOT_EXPOSED))));
    out.push(line('halted               : ' + (direct && direct.halted !== undefined ? (direct.halted ? 'yes' : 'no') : (e && e.haltedFlag !== undefined ? (e.haltedFlag ? 'yes' : 'no') : NOT_EXPOSED))));
    out.push(line('legacy panic code    : ' + hex(s.PANIC)));
    if (dump) { out.push(line('')); out.push(line('Dump (bounded to 120 lines):')); bounded(String(dump).split('\n'), 120).forEach(function (x) { out.push(line(x)); }); }
    return out;
  }

  W98.registerApp({
    id: 'kernel-lab', title: 'Kernel Lab', icon: 'task-manager', width: 820, height: 560,
    minWidth: 640, minHeight: 400, resizable: true, maximizable: true,
    singleton: true, startMenuGroup: 'System Tools',
    create: function (win) {
      var current = commandHelp(), timer = null, output, details, tree, status, crashOut;
      win.el.style.cssText += ';display:flex;flex-direction:column;min-height:0;overflow:hidden';
      var toolbar = el('div', 'w98-toolbar'); toolbar.style.flex = '0 0 auto';
      var prompt = el('label', '', 'Command:'); prompt.htmlFor = 'kernel-lab-command'; prompt.style.margin = '0 5px 0 2px'; toolbar.appendChild(prompt);
      var input = el('input', 'w98-field'); input.id = 'kernel-lab-command'; input.type = 'text'; input.placeholder = '!process'; input.maxLength = MAX_COMMAND; input.setAttribute('aria-label', 'Kernel Lab command'); input.spellcheck = false; input.style.cssText = 'width:210px;margin-right:4px'; toolbar.appendChild(input);
      var run = el('button', 'default', 'Run'); run.type = 'button'; toolbar.appendChild(run);
      var refresh = el('button', '', 'Refresh'); refresh.type = 'button'; refresh.style.marginLeft = '4px'; toolbar.appendChild(refresh);
      win.el.appendChild(toolbar);

      var main = el('div'); main.style.cssText = 'display:flex;flex:1 1 auto;min-height:0;gap:5px;padding:5px 5px 0'; win.el.appendChild(main);
      var treeBox = el('div'); treeBox.style.cssText = 'flex:0 0 150px;display:flex;flex-direction:column;min-height:0';
      treeBox.appendChild(el('div', '', 'Object tree')); tree = el('div', 'w98-listbox'); tree.style.cssText = 'overflow:auto;flex:1 1 auto'; treeBox.appendChild(tree); main.appendChild(treeBox);
      var center = el('div'); center.style.cssText = 'display:flex;flex-direction:column;min-width:0;min-height:0;flex:1 1 auto';
      output = el('div', 'w98-sunken'); output.tabIndex = 0; output.setAttribute('aria-label', 'Kernel Lab command output'); output.style.cssText = 'background:#000;color:#c0c0c0;font:12px "Lucida Console",monospace;white-space:pre-wrap;overflow:auto;flex:1 1 auto;min-height:0;padding:4px'; center.appendChild(output); main.appendChild(center);
      var right = el('div'); right.style.cssText = 'flex:0 0 220px;display:flex;flex-direction:column;min-height:0'; right.appendChild(el('div', '', 'Details')); details = el('div', 'w98-sunken'); details.tabIndex = 0; details.setAttribute('aria-label', 'Kernel Lab selection details'); details.style.cssText = 'background:#fff;overflow:auto;flex:1 1 auto;min-height:0;padding:5px;white-space:pre-wrap;font:11px "Lucida Console",monospace'; right.appendChild(details); main.appendChild(right);

      var crash = el('fieldset', 'w98-groupbox'); crash.style.cssText = 'flex:0 0 auto;margin:5px;padding:4px'; crash.appendChild(el('legend', '', 'Crash Lab (explicit action)'));
      var crashButtons = el('span'); var logBtn = el('button', '', 'Inspect kernel log'); var panicBtn = el('button', '', 'Controlled bugcheck…'); panicBtn.style.marginLeft = '5px'; crashButtons.appendChild(logBtn); crashButtons.appendChild(panicBtn); crash.appendChild(crashButtons);
      crashOut = el('div', 'w98-sunken'); crashOut.style.cssText = 'margin-top:4px;max-height:100px;overflow:auto;white-space:pre-wrap;font:11px "Lucida Console",monospace;padding:3px'; crash.appendChild(crashOut); win.el.appendChild(crash);
      status = el('div'); win.el.appendChild(status);

      var defs = [
        ['!help', 'help'], ['!process', 'process'], ['!thread', 'thread'], ['!handle', 'handle'], ['!timer', 'timer'], ['!pool', 'pool'], ['!irp', 'irp'], ['!object', 'object'], ['!registry', 'registry'], ['!partition', 'partition'], ['!vmbus', 'vmbus'], ['!bugcheck', 'bugcheck']
      ];
      defs.forEach(function (d) { var b = el('button', 'w98-listitem', d[0]); b.type = 'button'; b.style.cssText = 'display:block;width:100%;text-align:left'; b.onclick = function () { input.value = d[0]; runCommand(d[0]); }; tree.appendChild(b); });

      function showRows(rows, target) {
        target.innerHTML = '';
        var used = 0;
        function appendText(node, value) {
          var remaining = MAX_CHARS - used;
          if (remaining <= 0) return;
          var s = clip(value, Math.min(MAX_CELL, remaining));
          if (s.length > remaining) s = s.slice(0, remaining);
          used += s.length;
          node.appendChild(document.createTextNode(s));
        }
        var count = Math.min(rows.length, MAX_LINES);
        for (var i = 0; i < count; i++) {
          var r = rows[i], row = el('div');
          if (r.parts) {
            r.parts.forEach(function (part) {
              if (part && part.action) { var a = el('button'); a.type = 'button'; appendText(a, part.label); a.style.cssText = 'border:0;background:transparent;color:#0000a8;text-decoration:underline;padding:0;font:inherit;cursor:pointer'; a.onclick = function () { var result = part.action(); if (result) { current = result; showRows(current, details); } }; row.appendChild(a); }
              else { var span = el('span'); appendText(span, part && part.text !== undefined ? part.text : String(part || '')); row.appendChild(span); }
            });
          } else appendText(row, r && r.text !== undefined ? r.text : String(r || ''));
          target.appendChild(row);
        }
        if (rows.length > MAX_LINES || used >= MAX_CHARS) { var trunc = el('div'); appendText(trunc, '[output truncated at ' + (used >= MAX_CHARS ? MAX_CHARS + ' characters' : MAX_LINES + ' lines') + ']'); target.appendChild(trunc); }
        target.scrollTop = 0;
      }
      function showDetails(rows) { showRows(rows || [line(NOT_EXPOSED)], details); }
      function runCommand(raw) {
        var cmd = clip(String(raw || '').trim(), MAX_COMMAND);
        if (!cmd) cmd = '!help';
        var p = cmd.split(/\s+/), name = p.shift().toLowerCase(), arg = p.join(' '), rows;
        switch (name) {
          case '!help': case '?': rows = commandHelp(); break;
          case '!process': rows = renderProcess(arg); break;
          case '!thread': rows = renderThread(); break;
          case '!handle': rows = renderHandle(); break;
          case '!timer': rows = renderTimer(); break;
          case '!pool': rows = renderPool(); break;
          case '!irp': rows = renderIrp(); break;
          case '!object': rows = renderObject(); break;
          case '!registry': rows = renderRegistry(arg); break;
          case '!partition': rows = renderPartition(); break;
          case '!vmbus': rows = renderVmbus(); break;
          case '!bugcheck': rows = renderBugcheck(); break;
          default: rows = [line('Unknown command: ' + name), line(''), line('Type !help for the command list and usage.')];
        }
        current = rows; showRows(rows, output); showDetails([line('Select a process, PID, window, partition, or VP link for details.')]);
        status.textContent = 'Kernel Lab · tick ' + num(safe(function () { return W98.tick(); }, null)) + ' · output ' + Math.min(rows.length, MAX_LINES) + '/' + rows.length + ' lines';
      }
      function inspectLog() {
        var log = logText(), ls = String(log || '').split('\n');
        crashOut.textContent = clip(ls.slice(-120).join('\n') || ('Kernel log: ' + NOT_EXPOSED), MAX_CHARS);
      }
      function triggerBugcheck() {
        W98.dialog.confirm('Kernel Lab', 'Run the existing controlled kernel bugcheck (STOP 0x0000007B)?\n\nThe NT executive may halt. The current log, dump, and last snapshot remain readable until the normal recovery/reload path.').then(function (yes) {
          if (!yes) return;
          var e = execApi(), ok = false;
          if (e && typeof e.halt === 'function') { e.halt(0x0000007B); ok = true; }
          else if (typeof W98.panic === 'function') { W98.panic(0x0000000E); ok = true; }
          var snap = bugcheckSnapshot(), dump = snap.dump, parsed = snap.parsed;
          if (snap.direct && snap.direct.code !== undefined) parsed = { code: hex(snap.direct.code), params: (snap.direct.params || []).map(function (v) { return hex(v); }) };
          var result = ['controlled action: ' + (ok ? 'requested' : NOT_EXPOSED)];
          if (parsed) result.push('bugcheck code: ' + parsed.code + '\nparameters: ' + parsed.params.join(', '));
          else result.push('bugcheck code: ' + (ok ? 'not exposed by this build' : NOT_EXPOSED) + '\nparameters: ' + NOT_EXPOSED);
          if (e && typeof e.halt === 'function') result.push('', 'Recovery note: the NT executive dispatcher is halted. The legacy kernel clock, timer queue, and process accounting may still advance; reloading recreates volatile process, thread, timer, hypervisor, and dump state. Persisted filesystem and registry data can be restored.');
          else if (ok) result.push('', 'Recovery note: the legacy panic was requested, but this build does not expose an NT halt state. Reload recreates volatile kernel and hypervisor state; persisted filesystem and registry data can be restored.');
          else result.push('', 'Recovery note: no panic/bugcheck entry point was exposed by this build; no state was changed.');
          crashOut.textContent = clip(result.join('\n'), MAX_CHARS);
          runCommand('!bugcheck');
        });
      }
      run.onclick = function () { runCommand(input.value); };
      refresh.onclick = function () { runCommand(input.value || '!help'); };
      input.onkeydown = function (e) { if (e.key === 'Enter') runCommand(input.value); };
      logBtn.onclick = inspectLog; panicBtn.onclick = triggerBugcheck;
      win.setMenu([{ label: '&View', items: [{ label: '&Refresh', accel: 'F5', onclick: function () { runCommand(input.value || '!help'); } }, { type: 'sep' }, { label: 'E&xit', onclick: function () { win.close(); } }] }, { label: '&Crash Lab', items: [{ label: '&Inspect Kernel Log', onclick: inspectLog }, { label: '&Controlled Bugcheck…', onclick: triggerBugcheck }] }, { label: '&Help', items: [{ label: '&Command Help', onclick: function () { runCommand('!help'); } }, { label: '&About Kernel Lab', onclick: function () { W98.aboutDialog('kernel-lab'); } }] }]);
      timer = win.setInterval(function () { status.textContent = 'Kernel Lab · tick ' + num(safe(function () { return W98.tick(); }, null)) + ' · current view ' + (input.value || '!help'); }, 1000);
      win.on('close', function () { if (timer) win.clearInterval(timer); });
      runCommand('!help');
      return {};
    }
  });
})(typeof window !== 'undefined' ? window : this);
