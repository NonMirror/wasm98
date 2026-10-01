/* ============================================================================
   vmconsole.js — Virtual Machine Connection.  The guest's screen, exactly as
   a console window shows it: a black area with the guest framebuffer drawn
   1:1 (pixelated) inside a sunken frame, scaled 1x or 2x from the View menu.
   The pixels come from W98HV.framebuffer(), the partition state from
   W98HV.partitions(), and keystrokes and clicks go back out through
   W98HV.sendToGuest().  With no hypervisor, or no running partition, the
   window says so instead of showing anything invented.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98;
  if (!W98) return;
  var I = window.W98Icons;
  var U = W98.util;
  var el = U.el, esc = U.escapeHtml;

  var PART_STATE = ['Empty', 'Created', 'Initialized', 'Running', 'Paused', 'Stopped', 'Faulted', 'Deleted'];

  /* The documented surface is the global W98HV (HV_ABI.md section 4).  The
     build in web/js/hv.js exposes the hypervisor as W98.hv with different method
     names, so that object is adapted to the documented shape instead of showing
     a dead window.  Every accessor forwards to the hypervisor: no value is
     invented here, and values this build cannot report stay blank. */
  var adapted = null, adaptedSrc = null;
  function hvSurface() {
    var g;
    try { g = window; } catch (e) { return null; }
    var direct = g.W98HV;
    if (direct && typeof direct.partitions === 'function') return direct;
    var hv = g.W98 && g.W98.hv;
    if (hv && typeof hv.partitionList === 'function' && typeof hv.create === 'function') {
      if (adaptedSrc !== hv) {
        adapted = adaptW98Hv(hv);
        adaptedSrc = hv;
      }
      return adapted;
    }
    return null;
  }
  function adaptW98Hv(hv) {
    function call(fn, dflt) {
      try {
        var v = fn();
        return v === undefined ? dflt : v;
      } catch (e) { return dflt; }
    }
    function vpsOf(id) { return call(function () { return hv.vpList(id); }, []) || []; }
    var api = { _adapted: true, ready: hv.ready || null };
    Object.defineProperty(api, 'mode', {
      get: function () { return hv.mode === 'wasm' ? 'wasm' : 'none'; }, enumerable: true
    });
    Object.defineProperty(api, 'error', {
      get: function () { return hv.error || null; }, enumerable: true
    });
    api.info = function () {
      var lim = call(function () { return hv.limits(); }, {}) || {};
      return {
        vendor: call(function () { return hv.vendor(); }, '') || '',
        maxPartitions: lim.maxPartitions,
        maxVps: lim.maxVps,
        refTimeMs: call(function () { return hv.refTime(); }, null),
        hypercallCount: call(function () { return hv.hypercalls(); }, null),
        slatFaults: call(function () { return hv.slatFaults(); }, null),
        moduleBytes: typeof hv.moduleBytes === 'number' ? hv.moduleBytes : null
      };
    };
    api.partitions = function () {
      var list = call(function () { return hv.partitionList(); }, []) || [];
      return list.map(function (p) {
        return {
          id: p.id, name: p.name, state: p.state, stateName: p.stateName,
          vps: p.vps, memoryBytes: p.mappedBytes, mappedPages: p.mappedPages,
          deposits: p.deposits, hypercalls: p.hypercalls, faults: p.faults, runs: p.runs,
          root: p.root, hasGuest: p.hasGuest
        };
      });
    };
    api.vps = function () {
      var out = [];
      api.partitions().forEach(function (p) {
        vpsOf(p.id).forEach(function (v) {
          out.push({
            id: v.id, partition: p.id, index: v.index, state: v.state, stateName: v.stateName,
            runMs: v.runMs, hypercalls: v.hypercalls, faults: v.faults, instr: v.instr,
            sliceLeft: v.sliceLeft, preempts: v.preempts, synic: v.synic, sints: v.sints
          });
        });
      });
      return out;
    };
    api.createPartition = function (name) { return call(function () { return hv.create(name); }, 0); };
    api.startPartition = function (id) { return call(function () { return hv.start(id); }, -1); };
    api.pausePartition = function (id) { return call(function () { return hv.pause(id); }, -1); };
    api.resumePartition = function (id) { return call(function () { return hv.resume(id); }, -1); };
    api.stopPartition = function (id) { return call(function () { return hv.stop(id); }, -1); };
    api.resetPartition = function (id) { return call(function () { return hv.reset(id); }, -1); };
    api.deletePartition = function (id) { return call(function () { return hv.remove(id); }, -1); };
    api.framebuffer = function (id) {
      var rgba = call(function () { return hv.guestScreen(id); }, null);
      if (!rgba) return null;
      return { gpa: 0x10000, width: hv.FB_W || 400, height: hv.FB_H || 120, rgba: rgba };
    };
    api.stats = function () {
      var hb = 0;
      api.partitions().forEach(function (p) {
        var g = call(function () { return hv.guestFields(p.id); }, null);
        if (g && typeof g.heartbeat === 'number') hb += g.heartbeat;
      });
      var vb = call(function () { return hv.vmbus(); }, null) || {};
      var vbs = vb.stats || {};
      return {
        hypercalls: call(function () { return hv.hypercalls(); }, null),
        slatFaults: call(function () { return hv.slatFaults(); }, null),
        heartbeats: hb,
        refTimeMs: call(function () { return hv.refTime(); }, null),
        vmbusMessages: vbs.messages, vmbusInBytes: vbs.inBytes, vmbusOutBytes: vbs.outBytes
      };
    };
    /* this build has no push callback: the guest log is polled and the new lines
       are handed over in the documented message shape */
    var handlers = [], seenLog = {}, pollTimer = null;
    function emit(msg) {
      handlers.slice().forEach(function (fn) {
        try { fn(msg); } catch (e) { /* ignore */ }
      });
    }
    api.onGuestMessage = function (fn) {
      if (typeof fn !== 'function') return;
      handlers.push(fn);
      if (!pollTimer && typeof setInterval === 'function') pollTimer = setInterval(pump, 300);
    };
    function pump() {
      if (!handlers.length || api.mode !== 'wasm') return;
      api.partitions().forEach(function (p) {
        var text = call(function () { return hv.guestLog(p.id); }, '') || '';
        var prev = seenLog[p.id];
        if (typeof prev === 'string' && text.length > prev.length && text.indexOf(prev) === 0) {
          text.slice(prev.length).split('\n').forEach(function (line) {
            if (line) emit({ partition: p.id, text: line, bytes: null });
          });
        }
        seenLog[p.id] = text;
      });
    }
    /* this build exposes no guest-command channel, so sendToGuest is absent and
       the window says so instead of pretending the keystroke was delivered */
    return api;
  }
  function safe(fn, dflt) {
    try {
      var v = fn();
      return (v === undefined || v === null) ? dflt : v;
    } catch (e) { return dflt; }
  }
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function str(x) { return x == null ? '' : String(x); }
  function fmtNum(x) {
    var n = num(x);
    if (n == null) return '-';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function partStateCode(p) { return p ? num(p.state) : null; }
  function partStateName(p) {
    if (p && typeof p.stateName === 'string' && p.stateName) return p.stateName;
    var c = partStateCode(p);
    if (c == null) return null;
    return PART_STATE[c] != null ? PART_STATE[c] : 'State ' + c;
  }
  function snd(which) {
    try {
      if (W98.sound && typeof W98.sound[which] === 'function') W98.sound[which]();
    } catch (e) { /* silence */ }
  }
  function bytesToText(b) {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    var out = '';
    try {
      for (var i = 0; i < b.length && i < 4096; i++) {
        var c = b[i];
        out += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? '' : '.');
      }
    } catch (e) { return out; }
    return out;
  }

  /* W98HV.onGuestMessage may be a single-callback hook (the build in
     web/js/hv.js keeps one), so subscribe through a small fan-out bus so the
     manager and every console window all see the messages the guest posts. */
  function subscribeGuest(fn) {
    if (typeof fn !== 'function') return false;
    var h = hvSurface();
    if (!h || typeof h.onGuestMessage !== 'function') return false;
    var g;
    try { g = window; } catch (e) { return false; }
    var bus = g.__w98HvMsgBus;
    if (!bus) {
      bus = g.__w98HvMsgBus = { subs: [], installed: false };
    }
    bus.subs.push(fn);
    if (!bus.installed) {
      bus.installed = true;
      try {
        h.onGuestMessage(function (m) {
          bus.subs.slice().forEach(function (f) {
            try { f(m); } catch (e) { /* a listener must not break delivery */ }
          });
        });
      } catch (e) {
        bus.installed = false;
        bus.subs.pop();
        return false;
      }
    }
    return true;
  }

  W98.registerApp({
    id: 'vmconsole',
    title: 'Partition 1 - Virtual Machine Connection',
    icon: 'display',
    width: 420, height: 260,
    minWidth: 320, minHeight: 200,
    resizable: false,
    singleton: false,
    startMenuGroup: 'System Tools',
    create: function (win, args) {
      args = args || {};

      /* ---------------------------------------------------------- state */
      var closed = false;
      var partId = num(args.partition);
      var partition = null;          /* the W98HV record for partId, or null */
      var stateName = null;          /* from the hypervisor, never guessed */
      var scale = 1;                 /* 1 | 2 | 'fit' */
      var line = '';                 /* input being typed for the guest */
      var lastMsg = null;            /* last message the guest sent us */
      var hbSeen = 0;                /* heartbeat messages we saw arrive */
      var imgData = null;
      var canvasW = 0, canvasH = 0;
      var hookDone = false;
      var readyDone = false;
      var lastMouseAt = -1000;
      var menuSig = '';
      var shownMsg = '';

      /* --------------------------------------------------------- chrome */
      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';
      win.el.style.background = 'var(--face)';

      var host = el('div', 'grow');
      host.style.cssText = 'position:relative;overflow:auto;display:flex;align-items:center;' +
        'justify-content:center;padding:6px;background:#808080;min-height:0';
      var screen = el('div');
      screen.style.cssText = 'position:relative;background:#000;box-shadow:inset -1px -1px #fff,inset 1px 1px grey;' +
        'display:flex;align-items:center;justify-content:center';
      var canvas = el('canvas');
      canvas.style.cssText = 'image-rendering:pixelated;display:block;background:#000';
      var msg = el('div');
      msg.style.cssText = 'display:none;position:absolute;left:0;top:0;right:0;bottom:0;' +
        'align-items:center;justify-content:center;text-align:center;color:#c0c0c0;' +
        'font:12px Tahoma,sans-serif;padding:12px;white-space:pre-line';
      screen.appendChild(canvas);
      screen.appendChild(msg);
      host.appendChild(screen);
      win.el.appendChild(host);

      /* ------------------------------------------------------- selecting */
      function isRootPart(p) {
        if (!p) return true;
        if (p.isRoot === true || p.root === true) return true;
        return /^root$/i.test(str(p.name));
      }
      function pickPartition() {
        var h = hvSurface();
        if (!h || typeof h.partitions !== 'function' || h.mode !== 'wasm') return { err: hvReason(h) };
        var list = safe(function () { return h.partitions(); }, null);
        if (Object.prototype.toString.call(list) !== '[object Array]') list = [];
        var i;
        if (partId != null) {
          for (i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === partId) return { part: list[i] };
          }
          return { err: null, gone: true };
        }
        /* default to the first child partition: the root partition is the
           hypervisor's own, it has no guest and therefore no screen */
        for (i = 0; i < list.length; i++) {
          if (list[i] && !isRootPart(list[i]) && list[i].hasGuest) { partId = list[i].id; return { part: list[i] }; }
        }
        for (i = 0; i < list.length; i++) {
          if (list[i] && !isRootPart(list[i])) { partId = list[i].id; return { part: list[i] }; }
        }
        if (list.length) { partId = list[0].id; return { part: list[0] }; }
        return { err: null, none: true };
      }
      function hvReason(h) {
        if (!h) return 'The hypervisor glue (web/js/hv.js) is not loaded in this build.';
        var r = h.reason || h.error || h.message || h.statusText;
        if (typeof r === 'string' && r) return r;
        if (h.mode !== 'wasm') return 'hypervisor.wasm has not been loaded, so no hypervisor is running.';
        return 'The hypervisor did not report itself as available.';
      }

      /* ------------------------------------------------------ guest screen */
      function framebuffer() {
        var h = hvSurface();
        if (!h || typeof h.framebuffer !== 'function' || partId == null) return null;
        return safe(function () { return h.framebuffer(partId); }, null);
      }
      function showMessage(text) {
        if (text === shownMsg) return;
        shownMsg = text;
        msg.textContent = text;
        msg.style.display = 'flex';
        canvas.style.display = 'none';
      }
      function hideMessage() {
        if (!shownMsg) return;
        shownMsg = '';
        msg.style.display = 'none';
        canvas.style.display = 'block';
      }
      function applyScale(w, h) {
        var s = 1;
        if (scale === 'fit') {
          var availW = Math.max(40, host.clientWidth - 14);
          var availH = Math.max(30, host.clientHeight - 14);
          s = Math.min(availW / w, availH / h);
          if (s >= 1) s = Math.max(1, Math.floor(s));
          else if (!(s > 0.1)) s = 0.1;
        } else {
          s = scale;
        }
        var sw = Math.max(1, Math.round(w * s));
        var sh = Math.max(1, Math.round(h * s));
        if (canvas.style.width !== sw + 'px') canvas.style.width = sw + 'px';
        if (canvas.style.height !== sh + 'px') canvas.style.height = sh + 'px';
        if (screen.style.width !== sw + 'px') screen.style.width = sw + 'px';
        if (screen.style.height !== sh + 'px') screen.style.height = sh + 'px';
      }
      function paint() {
        if (closed) return;
        var h = hvSurface();
        if (!h || h.mode !== 'wasm') {
          showMessage('Hyper-V is not available on this machine.\n\n' + hvReason(h));
          return;
        }
        if (partition === null) {
          showMessage(partId == null
            ? 'There is no virtual machine to connect to.\n\nThe hypervisor owns no partitions.'
            : 'The virtual machine is no longer available.\n\nThis console was connected to partition ' + partId +
              ', which the hypervisor no longer reports.');
          return;
        }
        var st = partStateCode(partition);
        var running = (st === 3 || st === 4);
        var fb = framebuffer();
        if (!running) {
          /* the console follows a running machine; anything else gets the
             message a real VM Connection shows instead of a stale screen */
          showMessage('The virtual machine is not running.\n\nPartition ' + str(partId) + ' \u2014 ' +
            (partStateName(partition) || 'Unknown') + '\nUse the Action menu to start it.');
          return;
        }
        if (!fb || !fb.rgba) {
          if (partition.hasGuest === false) {
            showMessage('This partition has no guest, so it has no screen.\n\nPartition ' + str(partId) +
              ' \u2014 ' + (partStateName(partition) || 'Unknown'));
            return;
          }
          showMessage('The guest has not produced a framebuffer yet.\n\nPartition ' + str(partId) + ' \u2014 ' +
            (partStateName(partition) || 'Unknown'));
          return;
        }
        var w = num(fb.width), hgt = num(fb.height);
        if (!w || !hgt) { showMessage('The guest reported a framebuffer without a size.'); return; }
        var need = w * hgt * 4;
        var bytes = fb.rgba;
        if (bytes.subarray && bytes.length > need) bytes = bytes.subarray(0, need);
        if (bytes.length < need) {
          showMessage('The guest framebuffer is incomplete (' + bytes.length + ' of ' + need + ' bytes).');
          return;
        }
        try {
          if (canvas.width !== w || canvas.height !== hgt) {
            canvas.width = w;
            canvas.height = hgt;
            canvasW = w; canvasH = hgt;
            imgData = null;
          }
          var ctx = canvas.getContext('2d');
          if (!imgData) imgData = ctx.createImageData(w, hgt);
          imgData.data.set(bytes);
          /* a console framebuffer is opaque: the guest's X byte is not an alpha
             channel, so never let a zero there hide the guest's screen */
          var px = imgData.data;
          for (var a = 3; a < px.length; a += 4) if (px[a] !== 255) px[a] = 255;
          ctx.putImageData(imgData, 0, 0);
        } catch (e) {
          showMessage('The guest framebuffer could not be rendered.');
          return;
        }
        hideMessage();
        applyScale(w, hgt);
      }

      /* -------------------------------------------------------- status bar */
      function heartbeats() {
        var h = hvSurface();
        var st = safe(function () { return h.stats(); }, null);
        var fromApi = null;
        if (st && typeof st === 'object') {
          var keys = ['heartbeats', 'heartbeat', 'guestHeartbeats', 'heartbeatMessages'];
          for (var i = 0; i < keys.length; i++) {
            if (typeof st[keys[i]] === 'number') { fromApi = st[keys[i]]; break; }
          }
        }
        if (fromApi == null && partition && typeof partition.heartbeat === 'number') fromApi = partition.heartbeat;
        /* both numbers are real: the guest's own counter and the heartbeat
           messages this window has seen arrive — report the larger */
        if (fromApi == null) return hbSeen;
        return hbSeen > fromApi ? hbSeen : fromApi;
      }
      function status() {
        var stateText = partition ? (partStateName(partition) || 'Unknown') : (stateName || 'Not connected');
        var last = line
          ? 'input> ' + line + '_'
          : (lastMsg == null ? '(no messages from the guest yet)' : lastMsg);
        win.setStatus([
          { text: 'Partition ' + (partId == null ? '-' : partId) + ': ' + stateText, width: 152 },
          { text: 'Heartbeats: ' + fmtNum(heartbeats()), width: 104 },
          { text: last }
        ]);
      }

      /* --------------------------------------------------------- messages */
      function ensureHooks() {
        var h = hvSurface();
        if (!hookDone && h && typeof h.onGuestMessage === 'function') {
          hookDone = subscribeGuest(function (m) { onGuestMessage(m); });
        }
        if (!readyDone && h && h.ready && typeof h.ready.then === 'function') {
          readyDone = true;
          try {
            h.ready.then(function () { poll(); paint(); }, function () { poll(); paint(); });
          } catch (e) { /* ignore */ }
        }
      }
      function onGuestMessage(m) {
        if (closed || !m) return;
        var from = num(m.partition);
        if (from != null && partId != null && from !== partId) return;
        var text = (typeof m.text === 'string' && m.text) ? m.text : bytesToText(m.bytes);
        if (!text) text = '(empty message)';
        lastMsg = text;
        if (/heartbeat/i.test(text)) hbSeen++;
        status();
      }

      /* ------------------------------------------------------------- actions */
      function availability() {
        var code = partStateCode(partition);
        var bad = !partition;
        return {
          start: !bad && (code === 0 || code === 1 || code === 2 || code === 5),
          pause: !bad && code === 3,
          resume: !bad && code === 4,
          reset: !bad && (code === 3 || code === 4),
          off: !bad && (code === 2 || code === 3 || code === 4 || code === 6)
        };
      }
      function runAction(fnName, verb) {
        var h = hvSurface();
        if (!partition) { snd('beep'); return; }
        if (!h || typeof h[fnName] !== 'function') {
          W98.dialog.alert('Virtual Machine Connection',
            'This hypervisor build does not implement ' + fnName + '.', 'warn');
          return;
        }
        try {
          h[fnName](partId);
        } catch (e) {
          W98.dialog.alert('Virtual Machine Connection',
            'The hypervisor refused to ' + verb + ' partition ' + partId + '.\n\n' +
            (e && e.message ? e.message : String(e)), 'error');
          return;
        }
        poll();
        paint();
      }
      function turnOff() {
        W98.dialog.confirm('Turn Off',
          'Are you sure you want to turn off this virtual machine?\n\n' +
          'The guest is stopped immediately, like pulling its power cord.\n' +
          'Anything it has not saved to disk will be lost.')
          .then(function (yes) { if (yes) runAction('stopPartition', 'turn off'); });
      }
      function reset() {
        W98.dialog.confirm('Reset',
          'Are you sure you want to reset this virtual machine?\n\n' +
          'The guest restarts and its unsaved state is lost.')
          .then(function (yes) { if (yes) runAction('resetPartition', 'reset'); });
      }
      /** keyboard/mouse input goes to the guest through W98HV.sendToGuest */
      var inputWarned = false;
      function sendToGuest(text) {
        var h = hvSurface();
        if (!h || typeof h.sendToGuest !== 'function' || partId == null) {
          if (h && partId != null && !inputWarned) {
            inputWarned = true;
            W98.dialog.alert('Virtual Machine Connection',
              'This hypervisor build has no guest-input channel (the ABI in HV_ABI.md\n' +
              'section 4 calls it W98HV.sendToGuest and this build does not expose it),\n' +
              'so keystrokes and clicks cannot be delivered to the guest.', 'warn');
          } else {
            snd('beep');
          }
          return false;
        }
        try {
          h.sendToGuest(partId, text);
          return true;
        } catch (e) {
          /* the ABI says "bytes": retry with the byte values before giving up */
          try {
            var bytes = new Uint8Array(text.length);
            for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
            h.sendToGuest(partId, bytes);
            return true;
          } catch (e2) {
            W98.dialog.alert('Virtual Machine Connection',
              'The hypervisor refused the input.\n\n' + (e2 && e2.message ? e2.message : String(e2)), 'error');
            return false;
          }
        }
      }
      function sendCtrlAltDel() { sendToGuest('ctrl+alt+del'); }
      function about() {
        var lines = [
          'Microsoft Virtual Machine Connection',
          'Version 4.10.1998 (kernel.wasm build)',
          'Copyright \u00a9 1981-1998 Microsoft Corporation',
          '',
          'Partition:    ' + (partId == null ? '-' : partId),
          'State:        ' + (partition ? (partStateName(partition) || 'Unknown') : 'not connected'),
          'Framebuffer:  ' + (canvasW && canvasH ? canvasW + ' \u00d7 ' + canvasH + ' pixels' : 'none'),
          '',
          'The screen you see is the guest partition\'s own framebuffer, read out of',
          'hypervisor.wasm. Keys you type are forwarded to the guest in the guest\'s own',
          'command format; Ctrl+Alt+Del is sent from the Action menu.'
        ];
        W98.dialog.alert('About Virtual Machine Connection', lines.join('\n'), 'info');
      }
      function helpTopics() {
        if (W98.getApp && W98.getApp('help')) { W98.launch('help'); return; }
        W98.dialog.alert('Virtual Machine Connection Help',
          'Virtual Machine Connection\n\n' +
          'The window shows the guest\'s framebuffer 1:1. Use View to show it at 1x, 2x or\n' +
          'scaled to fit the window.\n\n' +
          'Type a command and press Enter to send it to the guest (the guest understands\n' +
          'ping, log <text> and halt). Clicks inside the screen are forwarded as pointer\n' +
          'positions, and Action > Send Ctrl+Alt+Del sends that key combination.', 'info');
      }

      function setScale(next) {
        scale = next;
        imgData = null;
        var fb = framebuffer();
        if (fb && num(fb.width) && num(fb.height)) applyScale(num(fb.width), num(fb.height));
        syncMenu();
        paint();
      }

      /* --------------------------------------------------------- menu bar */
      function menuDef() {
        var can = availability();
        var disconnected = !partition;
        return [
          {
            label: '&Action', items: [
              { label: '&Start', disabled: disconnected || !can.start, onclick: function () { runAction('startPartition', 'start'); } },
              { label: '&Pause', disabled: disconnected || !can.pause, onclick: function () { runAction('pausePartition', 'pause'); } },
              { label: '&Resume', disabled: disconnected || !can.resume, onclick: function () { runAction('resumePartition', 'resume'); } },
              { type: 'sep' },
              { label: '&Reset', disabled: disconnected || !can.reset, onclick: reset },
              { label: 'Turn &Off', disabled: disconnected || !can.off, onclick: turnOff },
              { type: 'sep' },
              { label: 'Send &Ctrl+Alt+Del', disabled: disconnected, onclick: sendCtrlAltDel }
            ]
          },
          {
            label: '&View', items: [
              { label: '&1x', type: 'radio', checked: scale === 1, onclick: function () { setScale(1); } },
              { label: '&2x', type: 'radio', checked: scale === 2, onclick: function () { setScale(2); } },
              { label: '&Fit', type: 'radio', checked: scale === 'fit', onclick: function () { setScale('fit'); } },
              { type: 'sep' },
              { label: '&Refresh Screen', accel: 'F5', onclick: function () { poll(); paint(); } }
            ]
          },
          {
            label: '&Help', items: [
              { label: '&Virtual Machine Connection Help Topics', onclick: helpTopics },
              { type: 'sep' },
              { label: '&About Virtual Machine Connection\u2026', onclick: about }
            ]
          }
        ];
      }
      function syncMenu() {
        var can = availability();
        var sig = [selSig(), scale, partition ? 1 : 0, can.start ? 1 : 0, can.pause ? 1 : 0,
          can.resume ? 1 : 0, can.reset ? 1 : 0, can.off ? 1 : 0].join(',');
        if (sig === menuSig) return;
        menuSig = sig;
        win.setMenu(menuDef());
      }
      function selSig() {
        if (!partition) return 'x' + (partId == null ? '' : partId);
        return 'p' + partition.id + ':' + str(partition.state);
      }

      /* -------------------------------------------------------------- poll */
      function poll() {
        if (closed) return;
        try {
          ensureHooks();
          var r = pickPartition();
          if (r.err) {
            partition = null;
            showMessage('Hyper-V is not available on this machine.\n\n' + r.err);
            win.setTitle('Virtual Machine Connection');
            win.setStatus([
              { text: 'Partition ' + (partId == null ? '-' : partId) + ': not connected', width: 152 },
              { text: 'Heartbeats: -', width: 104 },
              { text: r.err }
            ]);
            syncMenu();
            return;
          }
          if (r.none) {
            partition = null;
            showMessage('There is no virtual machine to connect to.\n\nThe hypervisor owns no partitions.');
            win.setTitle('Virtual Machine Connection');
            syncMenu();
            status();
            return;
          }
          if (r.gone) {
            partition = null;
            showMessage('The virtual machine is no longer available.\n\nThis console was connected to partition ' +
              partId + ', which the hypervisor no longer reports.');
            win.setTitle('Partition ' + partId + ' - Virtual Machine Connection');
            syncMenu();
            status();
            return;
          }
          partition = r.part;
          win.setTitle(str(partition.name || ('Partition ' + partId)) + ' - Virtual Machine Connection');
          syncMenu();
          status();
        } catch (e) {
          try { console.error('vmconsole poll', e); } catch (e2) { /* ignore */ }
        }
      }

      /* ---------------------------------------------------------- input */
      win.claimKeys();
      win.on('key', function (e) {
        if (!e || closed) return;
        var k = e.key;
        if (k === 'Backspace') {
          line = line.slice(0, -1);
          e.preventDefault();
          status();
          return;
        }
        if (k === 'Enter') {
          e.preventDefault();
          var text = line;
          line = '';
          if (text) sendToGuest(text);
          else snd('beep');
          status();
          return;
        }
        if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          line += k;
          e.preventDefault();
          status();
        }
      });
      screen.addEventListener('mousedown', function (e) {
        win.focus();
        win.claimKeys();
        if (!partition || canvas.style.display === 'none') return;
        var now = num(safe(function () { return W98.tick(); }, null));
        if (now == null) now = Date.now();
        if (now - lastMouseAt < 250) return;
        lastMouseAt = now;
        var r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var gx = Math.floor((e.clientX - r.left) / r.width * (canvasW || canvas.width));
        var gy = Math.floor((e.clientY - r.top) / r.height * (canvasH || canvas.height));
        sendToGuest('mouse ' + gx + ' ' + gy);
      });
      win.on('resize', function () {
        if (scale === 'fit') {
          var fb = framebuffer();
          if (fb && num(fb.width) && num(fb.height)) applyScale(num(fb.width), num(fb.height));
        }
      });

      /* -------------------------------------------------------------- loop */
      var cancelRaf = null, lastPoll = 0;
      if (typeof W98.raf === 'function') {
        try {
          cancelRaf = W98.raf(function () {
            paint();
            /* watchdog: the kernel-scheduled poll above is the primary timer,
               but the screen must keep following the guest even if the kernel's
               timer queue stops delivering */
            var now = Date.now();
            if (now - lastPoll >= 500) {
              lastPoll = now;
              poll();
            }
          });
        } catch (e) { cancelRaf = null; }
      }
      var paintTimer = win.setInterval(function () { if (!cancelRaf) paint(); }, 100);
      var pollTimer = win.setInterval(poll, 500);

      poll();
      paint();
      lastPoll = Date.now();

      return {
        onFocus: function () { win.claimKeys(); },
        onResize: function () {
          if (scale === 'fit') {
            var fb = framebuffer();
            if (fb && num(fb.width) && num(fb.height)) applyScale(num(fb.width), num(fb.height));
          }
        },
        onClose: function () {
          closed = true;
          if (cancelRaf) { try { cancelRaf(); } catch (e) { /* ignore */ } cancelRaf = null; }
          try { win.clearInterval(paintTimer); } catch (e) { /* ignore */ }
          try { win.clearInterval(pollTimer); } catch (e) { /* ignore */ }
          imgData = null;
        }
      };
    }
  });
})();
