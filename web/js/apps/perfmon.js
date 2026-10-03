/* ============================================================================
   perfmon.js — Performance Monitor.  A read-only view of the counters exposed
   by the WASM98 kernel and hypervisor.  The graphs intentionally use the
   familiar Windows 98 controls and do not write to the kernel.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = typeof window !== 'undefined' ? window.W98 : null;
  if (!W98 || typeof W98.registerApp !== 'function') return;
  var U = W98.util || {};
  var el = U.el || function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  var esc = U.escapeHtml || function (s) {
    return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var MAX_HISTORY = 120;
  var DEFAULT_INTERVAL = 1000;
  var GRAPH_W = 330;
  var GRAPH_H = 74;

  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  /* The WASM glue currently uses uppercase counter names while older test
     fixtures and the public contract use lower camel case.  Read either
     spelling so the monitor remains useful across both surfaces. */
  function stat(st, upper, lower) {
    if (!st || typeof st !== 'object') return null;
    var v = st[upper];
    if (v === undefined && lower) v = st[lower];
    return num(v);
  }
  function fmt(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '\u2014';
    var n = Number(v);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(digits == null ? 1 : digits) + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(digits == null ? 1 : digits) + 'K';
    return n.toFixed(digits == null ? 0 : digits);
  }
  function stamp() {
    var t = safe(function () { return typeof W98.tick === 'function' ? W98.tick() : Date.now(); }, Date.now());
    return typeof t === 'number' && isFinite(t) ? t : Date.now();
  }
  function appendText(parent, text, cls) {
    var s = el('span', cls || '', String(text));
    parent.appendChild(s);
    return s;
  }

  /* The hypervisor is optional.  Keep all probes in one place: a failed or
     half-loaded module is represented by null values and never reaches UI. */
  function hvSurface() {
    var direct = safe(function () { return window.W98HV; }, null);
    if (direct) return direct;
    return safe(function () { return W98.hv; }, null);
  }
  function hvSnapshot() {
    var hv = hvSurface(), out = {
      available: false, hypercalls: null, vmbus: null, heartbeat: null,
      channels: null, channelMessages: null, slatFaults: null, partitions: null
    };
    if (!hv) return out;
    /* hv.js deliberately exports a complete zero-valued shim in mode=none;
       do not mistake that shape for a live hypervisor. */
    var disabled = hv.mode === 'none';
    var hs = null;
    if (typeof hv.stats === 'function') hs = safe(function () { return hv.stats(); }, null);
    if (hs && typeof hs === 'object') {
      out.available = !disabled && hs.mode !== 'none';
      out.hypercalls = num(hs.hypercalls);
      out.channelMessages = num(hs.channelMessages != null ? hs.channelMessages : hs.messages);
      out.channels = num(hs.channels != null ? hs.channels : hs.openChannels);
      out.slatFaults = num(hs.slatFaults);
      out.heartbeat = num(hs.guestHeartbeats != null ? hs.guestHeartbeats : (hs.heartbeats != null ? hs.heartbeats : hs.heartbeat));
    }
    if (typeof hv.vmbusStats === 'function') {
      var vs = safe(function () { return hv.vmbusStats(); }, null);
      if (vs && typeof vs === 'object') {
        if (!disabled) out.available = true;
        if (out.channels === null) out.channels = num(vs.channels != null ? vs.channels : vs.open);
        if (out.channelMessages === null) out.channelMessages = num(vs.messages);
      }
    }
    /* Some builds export vmbusStats on W98 rather than W98HV. */
    if (typeof W98.vmbusStats === 'function') {
      var wv = safe(function () { return W98.vmbusStats(); }, null);
      if (wv && typeof wv === 'object') {
        if (!disabled) out.available = true;
        if (out.channels === null) out.channels = num(wv.channels != null ? wv.channels : wv.open);
        if (out.channelMessages === null) out.channelMessages = num(wv.messages);
      }
    }
    if (out.hypercalls === null && typeof hv.hypercalls === 'function') {
      out.hypercalls = num(safe(function () { return hv.hypercalls(); }, null));
    }
    if (out.slatFaults === null && typeof hv.slatFaults === 'function') {
      out.slatFaults = num(safe(function () { return hv.slatFaults(); }, null));
    }
    var parts = typeof hv.partitions === 'function' ? safe(function () { return hv.partitions(); }, []) : [];
    if (!Array.isArray(parts)) parts = [];
    out.partitions = parts.length;
    var hb = out.heartbeat === null ? 0 : out.heartbeat, hbSeen = out.heartbeat !== null;
    parts.forEach(function (p) {
      if (!p) return;
      var h = num(p.heartbeat);
      if (h === null && typeof hv.guest === 'function' && p.id != null) {
        var g = safe(function () { return hv.guest(p.id); }, null);
        h = g && num(g.heartbeat);
      }
      if (h !== null) { hb += h; hbSeen = true; }
    });
    out.heartbeat = hbSeen ? hb : null;
    out.available = out.available || (!disabled && parts.length > 0);
    /* The kernel WASM image also exposes a small VMBus transport counter. It
       is useful when hypervisor.wasm is absent, so expose that layer's message
       count instead of presenting an empty graph. */
    if ((!out.available || disabled) && W98.kernel && typeof W98.kernel.vmbusStats === 'function') {
      var km = num(safe(function () { return W98.kernel.vmbusStats(0); }, null));
      var kb = num(safe(function () { return W98.kernel.vmbusStats(1); }, null));
      if (km !== null || kb !== null) {
        out.channelMessages = km;
        out.kernelBytes = kb;
        out.available = true;
      }
    }
    return out;
  }

  function statsSnapshot() {
    var st = safe(function () { return typeof W98.stats === 'function' ? W98.stats() : {}; }, {}) || {};
    var ps = safe(function () { return typeof W98.kernelProcs === 'function' ? W98.kernelProcs() : []; }, []) || [];
    if (!Array.isArray(ps)) ps = [];
    var procs = ps.map(function (p) {
      return { pid: p && p.pid != null ? p.pid : 0, name: String(p && p.name || ('PID ' + (p && p.pid || 0))), cpuUs: num(p && p.cpuUs) };
    });
    var hv = hvSnapshot();
    var peak = num(st.heapPeak);
    if (peak === null && typeof W98.heapPeak === 'function') {
      peak = num(safe(function () { return W98.heapPeak(); }, null));
    }
    return { t: stamp(), st: st, procs: procs, hv: hv, heapPeak: peak };
  }

  function deltaRate(cur, old, elapsed) {
    var c = num(cur), o = num(old);
    if (c === null || o === null || !(elapsed > 0)) return null;
    return Math.max(0, c - o) * 1000 / elapsed;
  }

  function lineCanvas(canvas, series, labels, colors, unavailable) {
    var ctx = safe(function () { return canvas.getContext('2d'); }, null);
    if (!ctx) return;
    var w = canvas.width || GRAPH_W, h = canvas.height || GRAPH_H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#303030'; ctx.lineWidth = 1;
    for (var gy = 1; gy < 4; gy++) {
      ctx.beginPath(); ctx.moveTo(0, Math.round(h * gy / 4)); ctx.lineTo(w, Math.round(h * gy / 4)); ctx.stroke();
    }
    var max = 1, seen = false;
    series.forEach(function (s) {
      if (!s || !s.length) return;
      s.forEach(function (v) { if (num(v) !== null) { max = Math.max(max, v); seen = true; } });
    });
    if (unavailable || !seen) {
      ctx.fillStyle = '#c0c0c0'; ctx.font = '11px Tahoma'; ctx.textAlign = 'center';
      ctx.fillText('Unavailable', w / 2, h / 2 + 4); return;
    }
    series.forEach(function (s, si) {
      if (!s || !s.length) return;
      ctx.strokeStyle = colors[si] || '#00ff00'; ctx.beginPath();
      var first = true, len = s.length;
      s.forEach(function (v, i) {
        if (num(v) === null) { first = true; return; }
        var x = len < 2 ? 0 : Math.round(i * (w - 2) / (len - 1)) + 1;
        var y = h - 3 - Math.round(Math.max(0, v) / max * (h - 8));
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    if (labels && labels.length) {
      ctx.font = '10px Tahoma'; ctx.textAlign = 'left';
      labels.forEach(function (l, i) { ctx.fillStyle = colors[i] || '#00ff00'; ctx.fillText(l, 4 + i * 74, 11); });
    }
  }

  function barsCanvas(canvas, procs) {
    var ctx = safe(function () { return canvas.getContext('2d'); }, null);
    if (!ctx) return;
    var w = canvas.width || GRAPH_W, h = canvas.height || GRAPH_H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (!procs.length) {
      ctx.fillStyle = '#c0c0c0'; ctx.font = '11px Tahoma'; ctx.textAlign = 'center'; ctx.fillText('No processes', w / 2, h / 2 + 4); return;
    }
    if (!procs.some(function (p) { return num(p.cpuUs) !== null; })) {
      ctx.fillStyle = '#c0c0c0'; ctx.font = '11px Tahoma'; ctx.textAlign = 'center'; ctx.fillText('CPU data unavailable', w / 2, h / 2 + 4); return;
    }
    var list = procs.slice().sort(function (a, b) {
      var av = num(a.cpuUs), bv = num(b.cpuUs);
      return (bv === null ? -Infinity : bv) - (av === null ? -Infinity : av);
    }).slice(0, 8);
    var max = 1, i;
    list.forEach(function (p) { var cpuUs = num(p.cpuUs); if (cpuUs !== null) max = Math.max(max, cpuUs); });
    var rowH = Math.max(9, Math.floor((h - 4) / list.length));
    ctx.font = '10px Tahoma'; ctx.textAlign = 'left';
    list.forEach(function (p, j) {
      var cpuUs = num(p.cpuUs), y = j * rowH + 2, bw = cpuUs === null ? 0 : Math.round((cpuUs / max) * Math.max(20, w - 104));
      ctx.fillStyle = '#c0c0c0'; ctx.fillText(String(p.name).slice(0, 14), 2, y + rowH - 2);
      ctx.fillStyle = '#000080'; ctx.fillRect(96, y + 1, bw, rowH - 3);
      ctx.fillStyle = '#fff'; ctx.fillText(fmt(cpuUs === null ? null : cpuUs / 1000, 1) + ' ms', 100 + bw, y + rowH - 2);
    });
  }

  function create(win) {
    var interval = DEFAULT_INTERVAL, paused = false, rafCancel = null, timer = null;
    var last = null, lastSample = 0;
    var history = {
      heap: [], heapPeak: [], processes: [], queue: [], syscalls: [], ticks: [],
      files: [], registry: [], hypercalls: [], vmbus: [], heartbeat: []
    };
    var rows = {}, status;

    win.el.style.display = 'flex'; win.el.style.flexDirection = 'column'; win.el.style.overflow = 'hidden';
    var toolbar = el('div', 'row');
    toolbar.style.cssText = 'flex:0 0 auto;gap:5px;padding:4px;align-items:center';
    var pause = el('button', '', 'Pause'); pause.style.minWidth = '64px'; toolbar.appendChild(pause);
    toolbar.appendChild(el('span', '', 'Sample every'));
    var intervalSel = el('select');
    [[250, '250 ms'], [500, '500 ms'], [1000, '1 second'], [2000, '2 seconds'], [5000, '5 seconds']].forEach(function (x) {
      var o = el('option', '', x[1]); o.value = String(x[0]); intervalSel.appendChild(o);
    });
    intervalSel.value = String(interval); toolbar.appendChild(intervalSel);
    var refresh = el('button', '', 'Refresh'); refresh.style.minWidth = '62px'; toolbar.appendChild(refresh);
    status = el('span', 'grow', 'Running'); status.style.textAlign = 'right'; toolbar.appendChild(status);
    win.el.appendChild(toolbar);

    var body = el('div', 'col grow');
    body.style.cssText = 'overflow:auto;padding:4px;gap:5px;background:#c0c0c0';
    win.el.appendChild(body);
    var grid = el('div', 'col');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:5px;align-content:start';
    body.appendChild(grid);

    function panel(key, title, labels, colors, kind) {
      var p = el('div', 'col');
      p.style.cssText = 'min-width:0;padding:3px;gap:2px;background:#c0c0c0;';
      var head = el('div', '', title); head.style.fontWeight = 'bold'; p.appendChild(head);
      var well = el('div', 'w98-sunken');
      well.style.cssText = 'height:' + GRAPH_H + 'px;min-height:' + GRAPH_H + 'px;background:#000;overflow:hidden';
      var cv = el('canvas'); cv.width = GRAPH_W; cv.height = GRAPH_H; cv.style.cssText = 'width:100%;height:100%;image-rendering:pixelated';
      well.appendChild(cv); p.appendChild(well);
      var read = el('div', ''); read.style.cssText = 'font:11px "MS Sans Serif",Tahoma,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      p.appendChild(read); grid.appendChild(p); rows[key] = { canvas: cv, read: read, labels: labels, colors: colors, kind: kind };
    }
    panel('cpu', 'CPU time by process', [], ['#00ff00'], 'bars');
    panel('heap', 'Heap usage and peak', ['Used', 'Peak'], ['#00ff00', '#ffff00'], 'heap');
    panel('procq', 'Processes and timer queue', ['Processes', 'Timers'], ['#00ffff', '#ff80ff'], 'procq');
    panel('rate', 'Syscalls and ticks per second', ['Syscalls/s', 'Ticks/s'], ['#00ff00', '#00ffff'], 'rate');
    panel('io', 'Filesystem and registry counts', ['Files', 'Registry'], ['#ffff00', '#00ff00'], 'io');
    panel('hv', 'Hyper-V counters', ['Hypercalls', 'VMBus', 'Heartbeat'], ['#00ff00', '#00ffff', '#ffff00'], 'hv');

    function setStatus() {
      status.textContent = paused ? 'Paused' : 'Running';
      pause.textContent = paused ? 'Resume' : 'Pause';
      if (typeof win.setStatus === 'function') {
        var st = safe(function () { return W98.stats(); }, {}) || {};
        win.setStatus([{ text: 'Processes: ' + (stat(st, 'NDESC', 'procs') == null ? '\u2014' : stat(st, 'NDESC', 'procs')), width: 110 },
          { text: paused ? 'Sampling paused' : ('Interval: ' + interval + ' ms'), width: 145 }]);
      }
    }
    function push(name, value) {
      if (!history[name]) history[name] = [];
      history[name].push(value);
      if (history[name].length > MAX_HISTORY) history[name].shift();
    }
    function render() {
      var r;
      r = rows.cpu; barsCanvas(r.canvas, last ? last.procs : []);
      r.read.textContent = last && last.procs.length ? last.procs.slice().sort(function (a, b) {
        var av = num(a.cpuUs), bv = num(b.cpuUs);
        return (bv === null ? -Infinity : bv) - (av === null ? -Infinity : av);
      }).slice(0, 3).map(function (p) { var cpuUs = num(p.cpuUs); return p.name + ': ' + fmt(cpuUs === null ? null : cpuUs / 1000, 1) + ' ms'; }).join('  ') : 'No process CPU data';
      r = rows.heap; lineCanvas(r.canvas, [history.heap, history.heapPeak], r.labels, r.colors, !last || history.heap.every(function (v) { return v === null; }));
      r.read.textContent = 'Used: ' + fmt(last && stat(last.st, 'HEAP_USED', 'heapUsed'), 0) + ' bytes   Peak: ' + fmt(last && last.heapPeak, 0) + ' bytes';
      r = rows.procq; lineCanvas(r.canvas, [history.processes, history.queue], r.labels, r.colors, !last);
      r.read.textContent = 'Processes: ' + (last && stat(last.st, 'NDESC', 'procs') !== null ? fmt(stat(last.st, 'NDESC', 'procs')) : '\u2014') + '   Timer queue: ' + (last && stat(last.st, 'QUEUE', 'timerQueue') !== null ? fmt(stat(last.st, 'QUEUE', 'timerQueue')) : '\u2014');
      r = rows.rate; lineCanvas(r.canvas, [history.syscalls, history.ticks], r.labels, r.colors, !last);
      r.read.textContent = 'Syscalls/s: ' + fmt(last && last.rates && last.rates.syscalls, 1) + '   Ticks/s: ' + fmt(last && last.rates && last.rates.ticks, 1);
      r = rows.io; lineCanvas(r.canvas, [history.files, history.registry], r.labels, r.colors, !last);
      r.read.textContent = 'Files: ' + (last && stat(last.st, 'FILES', 'files') !== null ? fmt(stat(last.st, 'FILES', 'files')) : '\u2014') + '   Registry values: ' + (last && stat(last.st, 'REG', 'registry') !== null ? fmt(stat(last.st, 'REG', 'registry')) : '\u2014');
      r = rows.hv; lineCanvas(r.canvas, [history.hypercalls, history.vmbus, history.heartbeat], r.labels, r.colors, !last || !last.hv.available);
      r.read.textContent = 'Hypercalls: ' + fmt(last && last.hv.hypercalls, 0) + '   VMBus msgs: ' + fmt(last && last.hv.channelMessages, 0) + ' (' + fmt(last && last.hv.channels, 0) + ' ch)   Guest heartbeat: ' + fmt(last && last.hv.heartbeat, 0);
      setStatus();
    }
    function sample() {
      if (paused) return;
      var cur = statsSnapshot(), elapsed = last ? cur.t - last.t : 0;
      cur.rates = {
        syscalls: last ? deltaRate(stat(cur.st, 'SYSCALLS', 'syscalls'), stat(last.st, 'SYSCALLS', 'syscalls'), elapsed) : null,
        ticks: last ? deltaRate(stat(cur.st, 'TICKS', 'ticks'), stat(last.st, 'TICKS', 'ticks'), elapsed) : null
      };
      push('heap', stat(cur.st, 'HEAP_USED', 'heapUsed'));
      push('heapPeak', cur.heapPeak);
      push('processes', stat(cur.st, 'NDESC', 'procs'));
      push('queue', stat(cur.st, 'QUEUE', 'timerQueue'));
      push('syscalls', cur.rates.syscalls); push('ticks', cur.rates.ticks);
      push('files', stat(cur.st, 'FILES', 'files')); push('registry', stat(cur.st, 'REG', 'registry'));
      push('hypercalls', cur.hv.hypercalls); push('vmbus', cur.hv.channelMessages); push('heartbeat', cur.hv.heartbeat);
      last = cur; render();
    }
    function stopSchedule() {
      if (rafCancel) { try { rafCancel(); } catch (e) {} rafCancel = null; }
      if (timer) { try { (win.clearInterval || clearInterval)(timer); } catch (e2) {} timer = null; }
    }
    function startSchedule() {
      stopSchedule(); if (paused) return;
      lastSample = Date.now();
      if (typeof W98.raf === 'function') {
        rafCancel = W98.raf(function () {
          var now = Date.now();
          if (now - lastSample >= interval) { lastSample = now; sample(); }
        });
      } else {
        var setI = win.setInterval || setInterval;
        timer = setI(sample, interval);
      }
    }
    pause.onclick = function () { paused = !paused; setStatus(); if (paused) stopSchedule(); else { sample(); startSchedule(); } };
    intervalSel.onchange = function () { interval = parseInt(intervalSel.value, 10) || DEFAULT_INTERVAL; if (!paused) startSchedule(); setStatus(); };
    refresh.onclick = function () { sample(); };
    win.on('close', function () { stopSchedule(); });
    win.on('key', function (e) { if (e.key === 'F5') sample(); });

    sample(); startSchedule();
    return {};
  }

  W98.registerApp({
    id: 'perfmon', title: 'Performance Monitor', icon: 'task-manager',
    width: 690, height: 470, minWidth: 520, minHeight: 350,
    resizable: true, maximizable: true, singleton: true,
    startMenuGroup: 'System Tools', create: create
  });
})();
