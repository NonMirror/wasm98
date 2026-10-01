/* ===========================================================================
 * vm.js — "Virtual Machine Manager"
 *
 * The console for the hypervisor in hypervisor.wasm: partitions and their
 * virtual processors, the SLAT map, the guest's own screen and serial log,
 * VMBus channels, SynIC message queues, hypercalls and the hypervisor log.
 * Everything shown here is read out of the running hypervisor module; the
 * buttons drive the real partition state machine, and the Debug menu can fire
 * a hypercall, inject the isolation-violation writes the SLAT guards, or
 * bugcheck the host kernel (which takes the desktop down to a STOP screen).
 *
 * Classic script.  Registers itself with W98.registerApp().
 * =========================================================================*/
(function () {
  'use strict';

  var global = typeof window !== 'undefined' ? window : this;
  var ID = 'vm';
  var TABS = ['Guest Screen', 'Details', 'Guest Log', 'Hypervisor Log', 'VMBus', 'SLAT & Memory'];
  var W = { sel: 0, tab: 0, canvas: null, ctx: null, img: null, logTail: 0 };
  /* the hypercalls the Debug menu issues */
  var HYPERCALL = {
    QUERY_TIME: 0x0051, SET_VP_REGISTER: 0x0052, MAP_GPA_PAGES: 0x0053,
    UNMAP_GPA_PAGES: 0x0054, POST_MESSAGE: 0x005C, SIGNAL_EVENT: 0x005D,
    GET_VP_INDEX: 0x0047, SET_OS_ID: 0x0048
  };

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
  }
  function hex(v, w) {
    var s = (v >>> 0).toString(16).toUpperCase();
    while (s.length < (w || 0)) s = '0' + s;
    return '0x' + s;
  }
  function kb(n) { return Math.round(n / 1024) + ' KB'; }
  /* The hypervisor glue exposes W98HV; this app reads it through a facade so
     the window code can use the hypervisor's own vocabulary. */
  var FACADE = null;
  function fallback() {
    var z = function () { return []; }, n = function () { return null; }, s0 = function () { return ''; };
    return {
      mode: 'none', error: 'hv.js is not loaded', FB_W: 400, FB_H: 120,
      partitionList: z, vpList: z, vmbus: z, guestFields: n, guestLog: s0, log: s0,
      memory: function () { return {}; }, sched: function () { return {}; },
      limits: function () { return { gpaLimit: 0xB0000 }; },
      hypercalls: function () { return 0; }, slatFaults: function () { return 0; },
      refTime: function () { return 0; }, gpaState: function () { return 0; },
      step: function () { return 0; }, pump: function () { return 0; },
      guestScreen: n, create: function () { return 0; }, start: function () { return 1; },
      pause: function () { return 1; }, resume: function () { return 1; }, stop: function () { return 1; },
      reset: function () { return 1; }, remove: function () { return 1; },
      vmbusDrain: n, injectStray: function () { return 0; }, injectOob: function () { return 0; },
      hypercall: n, HC: HYPERCALL
    };
  }
  function hv() {
    var A = global && global.W98HV;
    if (!A) return fallback();
    if (FACADE && FACADE.__src === A) return FACADE;
    var w = A.debug.exports();
    var view = function () { return new Uint8Array(w.memory.buffer); };
    FACADE = {
      __src: A,
      mode: A.mode, error: A.error, ready: A.ready, FB_W: 400, FB_H: 120, HC: HYPERCALL,
      limits: A.limits, partitionList: A.partitionList, partition: A.partition,
      create: function (nm) { return A.createPartition(nm); },
      start: function (id) { return A.startPartition(id); },
      pause: function (id) { return A.pausePartition(id); },
      resume: function (id) { return A.resumePartition(id); },
      stop: function (id) { return A.stopPartition(id); },
      reset: function (id) { return A.resetPartition(id); },
      remove: function (id) { return A.deletePartition(id); },
      guestFields: A.guestFields, guestLog: A.guestLog,
      vpList: function (id) {
        return A.vpList().filter(function (v) { return v.partition === id; });
      },
      vmbus: A.vmbus, vmbusStats: A.vmbusStats, vmbusDrain: A.vmbusDrain,
      memory: A.memory, sched: A.sched,
      hypercalls: A.hypercalls, slatFaults: A.slatFaults, partitionFaults: A.partitionFaults,
      refTime: A.refTime, log: A.hypervisorLog || A.log,
      step: A.step, pump: function (ms) { return A.step(ms); },
      running: function () {
        return A.partitionList().some(function (p) { return p.hasGuest && p.state === 3; });
      },
      guestScreen: function (id) {
        var fb = A.framebuffer(id);
        return fb && fb.rgba ? fb.rgba : null;
      },
      gpaState: function (id, gpa) { return w.hv_gpa_state(id, gpa >>> 0); },
      injectStray: function (id) { return w.hv_debug_guest_stray_write(id); },
      injectOob: function (id, gpa) { return w.hv_debug_guest_oob_write(id, gpa >>> 0) >>> 0; },
      mapGpa: function (id, gpa, pages, flags) {
        return w.hv_map_gpa(id, gpa >>> 0, pages || 1, flags === undefined ? 3 : flags) >>> 0;
      },
      /* a hypercall from the host: build the frame in the guest's hypercall
         page, then enter the VM the way the guest itself would */
      hypercall: function (id, code, inGpa, outGpa, a0, a1, a2, a3) {
        var vps = A.vpList().filter(function (v) { return v.partition === id; });
        if (!vps.length) return null;
        var frame = A.debug.scratch() + 8192;
        var b = view(), dv = new DataView(w.memory.buffer);
        [code >>> 0, 0, inGpa >>> 0, outGpa >>> 0, a0 >>> 0, a1 >>> 0, a2 >>> 0, a3 >>> 0]
          .forEach(function (v, i) { dv.setUint32(frame + i * 4, v, true); });
        w.hv_write_gpa(id, 0xE000, frame, 32);
        var st = w.hv_vmcall(vps[0].id) >>> 0;
        var out = A.debug.scratch() + 8256;
        w.hv_read_gpa(id, outGpa >>> 0, out, 16);
        var dv2 = new DataView(w.memory.buffer);
        return { status: st, out: [dv2.getUint32(out, true), dv2.getUint32(out + 4, true),
                                  dv2.getUint32(out + 8, true), dv2.getUint32(out + 12, true)] };
      }
    };
    return FACADE;
  }

  W98.registerApp({
    id: ID,
    title: 'Virtual Machine Manager',
    icon: 'hv',
    width: 704,
    height: 452,
    minWidth: 560,
    minHeight: 360,
    resizable: true,
    maximizable: true,
    singleton: true,
    startMenuGroup: 'System Tools',
    create: create
  });

  function create(win) {
    var H = hv();
    global.W98 = global.W98 || W98;
    win.el.style.display = 'flex';
    win.el.style.flexDirection = 'column';
    win.el.style.overflow = 'hidden';

    /* ------------------------------------------------------------ chrome */
    var bar = document.createElement('div');
    bar.className = 'w98-toolbar';
    bar.style.flex = '0 0 auto';
    var buttons = [
      ['New', 'Create a child partition', actNew],
      ['Start', 'Start the selected partition', function () { act('start'); }],
      ['Pause', 'Pause', function () { act('pause'); }],
      ['Resume', 'Resume', function () { act('resume'); }],
      ['Stop', 'Stop', function () { act('stop'); }],
      ['Reset', 'Reset the partition', function () { act('reset'); }],
      ['Delete', 'Delete', function () { act('delete'); }]
    ];
    buttons.forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'w98-toolbtn';
      el.type = 'button';
      el.textContent = b[0];
      el.title = b[1];
      el.onclick = function () { W98.sound.click(); b[2](); };
      bar.appendChild(el);
    });
    win.el.appendChild(bar);

    var split = document.createElement('div');
    split.style.cssText = 'flex:1 1 auto;display:flex;gap:6px;padding:6px;min-height:0';
    win.el.appendChild(split);

    var leftBox = document.createElement('div');
    leftBox.style.cssText = 'flex:0 0 216px;display:flex;flex-direction:column;min-height:0';
    var leftLabel = document.createElement('div');
    leftLabel.textContent = 'Partitions';
    leftLabel.style.cssText = 'padding:2px 0 3px 0';
    leftBox.appendChild(leftLabel);
    var list = document.createElement('div');
    list.className = 'w98-listbox';
    list.style.cssText = 'flex:1 1 auto;overflow:auto';
    list.tabIndex = 0;
    leftBox.appendChild(list);
    split.appendChild(leftBox);

    var rightBox = document.createElement('div');
    rightBox.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0';
    split.appendChild(rightBox);

    var tabs = document.createElement('div');
    tabs.className = 'w98-tabs';
    rightBox.appendChild(tabs);
    var page = document.createElement('div');
    page.className = 'w98-field';
    page.style.cssText = 'flex:1 1 auto;overflow:auto;padding:6px;min-height:0';
    rightBox.appendChild(page);

    TABS.forEach(function (name, i) {
      var t = document.createElement('button');
      t.className = 'w98-tab';
      t.type = 'button';
      t.textContent = name;
      t.onclick = function () { W98.sound.click(); W.tab = i; renderTabs(); renderPage(); };
      tabs.appendChild(t);
    });

    /* -------------------------------------------------------------- menus */
    win.setMenu([
      { label: '&File', items: [
        { label: '&New Partition…', onclick: actNew },
        { type: 'sep' },
        { label: '&Delete Partition', onclick: function () { act('delete'); } },
        { type: 'sep' },
        { label: 'E&xit', onclick: function () { win.close(); } }
      ] },
      { label: '&Action', items: [
        { label: '&Start', onclick: function () { act('start'); } },
        { label: '&Pause', onclick: function () { act('pause'); } },
        { label: '&Resume', onclick: function () { act('resume'); } },
        { label: 'Sto&p', onclick: function () { act('stop'); } },
        { label: '&Reset', onclick: function () { act('reset'); } }
      ] },
      { label: '&View', items: TABS.map(function (name, i) {
        return { label: name, type: 'radio', checked: i === 0, onclick: function () { W.tab = i; renderTabs(); renderPage(); } };
      }).concat([
        { type: 'sep' },
        { label: '&Refresh Now', onclick: function () { refresh(true); } }
      ]) },
      { label: '&Debug', items: [
        { label: 'Hypercall: &Query Time', onclick: hcQueryTime },
        { label: 'Hypercall: &Map Pages', onclick: hcMapPages },
        { label: 'Send &VMBus Message', onclick: sendVmbus },
        { type: 'sep' },
        { label: 'Inject Stray &Write (canary)', onclick: injectStray },
        { label: 'Inject &Out-of-Bounds Write', onclick: injectOob },
        { type: 'sep' },
        { label: '&Bugcheck the Host Kernel…', onclick: bugcheck }
      ] },
      { label: '&Help', items: [
        { label: '&About Virtual Machine Manager…', onclick: function () { W98.aboutDialog(appDef); } }
      ] }
    ]);

    /* ------------------------------------------------------------ actions */
    function selected() {
      var list2 = H.partitionList();
      for (var i = 0; i < list2.length; i++) if (list2[i].id === W.sel) return list2[i];
      return list2[0] || null;
    }
    function act(what) {
      var p = selected();
      if (!p) return;
      if (p.root && (what === 'delete' || what === 'stop' || what === 'reset')) {
        W98.dialog.alert('Virtual Machine Manager',
          'The root partition owns the physical machine: it cannot be ' +
          (what === 'delete' ? 'deleted' : what) + '.', 'warn');
        return;
      }
      var r = H[what](p.id);
      if (r) {
        W98.sound.error();
        W98.dialog.alert('Virtual Machine Manager',
          'The hypervisor refused ' + what + ' on partition ' + p.id + ' (' + p.stateName + ').', 'warn');
      } else {
        refresh(true);
      }
    }
    function actNew() {
      W98.dialog.prompt('New Partition', 'Name for the new partition:', 'Windows 98 Guest')
        .then(function (name) {
          if (name === null || name === undefined) return;
          var id = H.create(name || 'New partition');
          if (!id) { W98.dialog.alert('Virtual Machine Manager', 'No free partition slot, or the hypervisor ran out of memory.', 'error'); return; }
          W.sel = id;
          refresh(true);
        });
    }
    function hcQueryTime() {
      var p = selected(); if (!p) return;
      var r = H.hypercall(p.id, H.HC.QUERY_TIME, 0, 0x92000, 0, 0, 0, 0);
      W98.dialog.alert('Hypercall 0x' + H.HC.QUERY_TIME.toString(16).toUpperCase(),
        r ? ('HV_STATUS 0x' + r.status.toString(16).toUpperCase() + '\n' +
             'reference time  ' + r.out[0] + ' ms\n' +
             'processor index ' + r.out[1] + '\n' +
             'guest OS id     ' + hex(r.out[2])) : 'no virtual processor', 'info');
      refresh(true);
    }
    function hcMapPages() {
      var p = selected(); if (!p) return;
      var r = H.hypercall(p.id, H.HC.MAP_GPA_PAGES, 0, 0x92000, 0x80000, 2, 3, 0);
      var body = r
        ? ('HV_STATUS 0x' + r.status.toString(16).toUpperCase() + '\n' +
           'result word ' + hex(r.out[0]) + '\n' +
           'GPA 0x80000 is now ' + ['unmapped', 'mapped', 'read-only', 'read/write'][H.gpaState(p.id, 0x80000)])
        : 'no virtual processor';
      W98.dialog.alert('Hypercall 0x' + H.HC.MAP_GPA_PAGES.toString(16).toUpperCase(), body, 'info');
      refresh(true);
    }
    function sendVmbus() {
      var p = selected(); if (!p) return;
      var ch = H.vmbus().filter(function (c) { return c.partition === p.id; })[0];
      if (!ch) { W98.dialog.alert('VMBus', 'This partition has no VMBus channel.', 'warn'); return; }
      var msg = H.vmbusDrain(ch.id);
      var kr = W98.kernel && W98.kernel.vmbusTx
        ? (W98.kernel.vmbusTx(msg ? msg.len : 64) >>> 0) : null;
      var kstats = W98.kernel && W98.kernel.vmbusStats
        ? { count: W98.kernel.vmbusStats(0), bytes: W98.kernel.vmbusStats(1) } : null;
      W98.dialog.alert('VMBus channel ' + ch.chid,
        (msg ? ('message type ' + hex(msg.type) + '\n' + msg.payload.slice(0, 300) + '\n\n')
             : 'The outbound ring is empty: the guest has not sent anything yet.\n\n') +
        'Relayed through the kernel\'s VMBus driver: HV_STATUS ' + hex(kr) + '\n' +
        (kstats ? ('IRPs sent ' + kstats.count + ', ' + kstats.bytes + ' bytes') : ''), 'info');
    }
    function injectStray() {
      var p = selected(); if (!p) return;
      if (!p.canaryLo) { W98.dialog.alert('Debug', 'This partition has no guard pages yet.', 'warn'); return; }
      W98.dialog.confirm('Inject Stray Write',
        'Write outside partition ' + p.id + "'s guest window?\n\n" +
        'The hypervisor checks the guard pages on the next VM entry; the partition ' +
        'will be faulted and the violation logged.').then(function (yes) {
        if (!yes) return;
        H.injectStray(p.id);
        var vps = H.vpList(p.id);
        if (vps.length) H.pump(20);
        refresh(true);
        W.tab = 3; renderTabs(); renderPage();
      });
    }
    function injectOob() {
      var p = selected(); if (!p) return;
      var gpa = hv().limits().gpaLimit + 0x4000;   /* outside the guest window */
      var st = H.injectOob(p.id, gpa);
      W98.dialog.alert('Inject Out-of-Bounds Write',
        'Guest write to GPA ' + hex(gpa) + ' (past the ' + hex(hv().limits().gpaLimit) + ' window)\n\n' +
        (st ? 'HV_STATUS ' + hex(st) + ' — the SLAT refused it' : 'the write was refused'), 'info');
      refresh(true);
    }
    function bugcheck() {
      var k = W98.kernel;
      if (!k || !k.exec) { W98.dialog.alert('Debug', 'The kernel is not running as WebAssembly.', 'warn'); return; }
      W98.dialog.confirm('Bugcheck',
        'Force a bugcheck in kernel.wasm (STOP 0x0000007B, INACCESSIBLE_BOOT_DEVICE)?\n\n' +
        'The kernel halts, prints a minidump, and the desktop shows the blue screen.').then(function (yes) {
        if (!yes) return;
        var ex = k.exec();
        if (ex.halt) ex.halt(0x0000007B);
        var dump = ex.bugcheckDump ? ex.bugcheckDump() : '';
        if (W98.stopScreen) W98.stopScreen(dump, 0x0000007B);
      });
    }

    /* ------------------------------------------------------------- render */
    function renderTabs() {
      for (var i = 0; i < tabs.children.length; i++) {
        tabs.children[i].classList.toggle('active', i === W.tab);
      }
    }
    function renderList() {
      var parts = H.partitionList();
      list.innerHTML = '';
      if (!parts.length) {
        var empty = document.createElement('div');
        empty.className = 'w98-listitem';
        empty.textContent = '(no partitions)';
        list.appendChild(empty);
      }
      parts.forEach(function (p) {
        var row = document.createElement('div');
        row.className = 'w98-listitem' + (p.id === W.sel ? ' selected' : '');
        row.textContent = p.name + '  [' + p.stateName + ']';
        row.onclick = function () {
          W.sel = p.id;
          W98.sound.click();
          renderList(); renderPage();
        };
        list.appendChild(row);
      });
      if (!selected() && parts.length) W.sel = parts[0].id;
    }
    function grid(rows) {
      var t = document.createElement('table');
      t.style.cssText = 'border-collapse:collapse;font:11px "MS Sans Serif",Tahoma,sans-serif';
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        var a = document.createElement('td');
        a.style.cssText = 'padding:1px 10px 1px 0;white-space:nowrap;color:#000';
        a.textContent = r[0];
        var b = document.createElement('td');
        b.style.cssText = 'padding:1px 0;white-space:nowrap' + (r[2] ? ';color:#800000' : '');
        b.textContent = r[1];
        tr.appendChild(a); tr.appendChild(b);
        t.appendChild(tr);
      });
      return t;
    }
    function mono(text) {
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;font:11px "Lucida Console",monospace;white-space:pre-wrap;word-break:break-word';
      pre.textContent = text;
      return pre;
    }
    function groupBox(title) {
      var f = document.createElement('fieldset');
      f.className = 'w98-groupbox';
      var lg = document.createElement('legend');
      lg.textContent = title;
      f.appendChild(lg);
      return f;
    }
    function renderPage() {
      var p = selected();
      page.innerHTML = '';
      if (H.mode !== 'wasm') {
        page.appendChild(mono('The hypervisor module did not load.\n\n' +
          (H.error ? 'reason: ' + H.error + '\n\n' : '') +
          'hypervisor.wasm was expected next to kernel.wasm.'));
        return;
      }
      if (!p) { page.appendChild(mono('No partition selected.')); return; }
      var mem = H.memory(), sched = H.sched();

      if (W.tab === 0) {                                  /* guest screen */
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
        W.canvas = document.createElement('canvas');
        W.canvas.width = H.FB_W;
        W.canvas.height = H.FB_H;
        /* show the guest screen as large as the pane allows, never smaller
           than 1:1 and never more than 3x (integer scaling, no smoothing) */
        var avail = Math.max(200, page.clientWidth - 24);
        var scale = Math.max(1, Math.min(3, Math.floor(avail / H.FB_W)));
        W.scale = scale;
        W.canvas.style.cssText = 'width:' + (H.FB_W * scale) + 'px;height:' + (H.FB_H * scale) +
          'px;image-rendering:pixelated;background:#000;border:1px solid #000';
        wrap.appendChild(W.canvas);
        W.ctx = W.canvas.getContext('2d');
        W.img = W.ctx.createImageData(H.FB_W, H.FB_H);
        var legend = document.createElement('div');
        legend.style.cssText = 'font:11px "MS Sans Serif",Tahoma,sans-serif';
        legend.textContent = 'Guest framebuffer ' + H.FB_W + 'x' + H.FB_H + 'x32bpp read from GPA 0x10000 ' +
          'through the partition\'s SLAT, shown at ' + scale + ':1. The guest writes this itself.';
        wrap.appendChild(legend);
        page.appendChild(wrap);
        drawScreen(p.id);
      } else if (W.tab === 1) {                            /* details */
        var g = H.guestFields(p.id);
        var vps = H.vpList(p.id);
        var box1 = groupBox('Partition');
        box1.appendChild(grid([
          ['Id', String(p.id)],
          ['Name', p.name],
          ['State', p.stateName],
          ['Type', p.root ? 'Root partition' : ('Child of partition ' + p.parent)],
          ['Virtual processors', String(p.vps)],
          ['Guest image', p.hasGuest ? 'loaded' : 'not loaded'],
          ['Hypercalls', String(p.hypercalls)],
          ['Scheduler runs', String(p.runs)],
          ['SLAT faults', String(p.faults), p.faults > 0],
          ['Canary faults', String(p.canaryFaults), p.canaryFaults > 0]
        ]));
        page.appendChild(box1);
        if (g) {
          var box2 = groupBox('Guest');
          box2.appendChild(grid([
            ['Boot stage', g.stageName + ' (' + g.stage + '/11)'],
            ['Boot flags', g.booted ? '0x1FF (boot complete)' : hex(g.bootFlags)],
            ['Heartbeats', String(g.heartbeat)],
            ['Timer interrupts', String(g.timerHits)],
            ['VMBus messages', String(g.vmbusMessages)],
            ['Commands', String(g.commands) + (g.lastCommand ? ('  (last: ' + g.lastCommand + ')') : '')],
            ['Halted', g.halted ? 'yes' : 'no', !!g.halted]
          ]));
          page.appendChild(box2);
        }
        vps.forEach(function (v) {
          var box = groupBox('Virtual processor ' + v.index + ' (vp ' + v.id + ')');
          box.appendChild(grid([
            ['State', v.stateName],
            ['Run time', v.runMs + ' ms'],
            ['Instructions', String(v.instr)],
            ['Hypercalls', String(v.hypercalls)],
            ['Preemptions', String(v.preempts)],
            ['Timer fires', String(v.timerFires)],
            ['SynIC SCONTROL', hex(v.synic.scontrol)],
            ['SynIC SIMP / SIEFP', hex(v.synic.simp) + ' / ' + hex(v.synic.siefp)],
            ['SynIC messages', String(v.synic.messages) + ' (' + v.synic.dropped + ' dropped)'],
            ['SINT0', 'vector ' + v.sints[0].vector + (v.sints[0].masked ? ', masked' : ', unmasked')],
            ['SINT2', 'vector ' + v.sints[2].vector + (v.sints[2].masked ? ', masked' : ', unmasked') +
              ', ' + v.sints[2].count + ' delivered'],
            ['Synthetic timer', v.timer.armed ? ('armed, ' + v.timer.fires + ' fires') : 'disarmed'],
            ['Registers', v.registers.map(function (r) { return hex(r); }).join(' ')]
          ]));
          page.appendChild(box);
        });
      } else if (W.tab === 2) {                            /* guest log */
        var txt = H.guestLog(p.id) || '(the guest has not written anything yet)';
        var pre = mono(txt);
        page.appendChild(pre);
        if (W.logTail !== 1) page.scrollTop = page.scrollHeight;
      } else if (W.tab === 3) {                            /* hypervisor log */
        page.appendChild(mono(H.log() || '(empty)'));
        page.scrollTop = page.scrollHeight;
      } else if (W.tab === 4) {                            /* VMBus */
        var chans = H.vmbus(), vstats = H.vmbusStats ? H.vmbusStats() : H.vmbus().stats;
        var box = groupBox('Channels');
        var t = document.createElement('table');
        t.style.cssText = 'border-collapse:collapse;font:11px "MS Sans Serif",Tahoma,sans-serif;width:100%';
        var head = ['#', 'Partition', 'State', 'Offer id', 'Messages', 'In / Out', 'Dropped'];
        var hr = document.createElement('tr');
        head.forEach(function (h) {
          var th = document.createElement('th');
          th.textContent = h;
          th.style.cssText = 'text-align:left;padding:2px 10px 2px 0;border-bottom:1px solid #808080';
          hr.appendChild(th);
        });
        t.appendChild(hr);
        chans.forEach(function (c) {
          var tr = document.createElement('tr');
          [c.id, c.partition, c.stateName, hex(c.offerLo), c.messages,
            kb(c.inBytes) + ' / ' + kb(c.outBytes), c.dropped].forEach(function (cell) {
            var td = document.createElement('td');
            td.textContent = String(cell);
            td.style.cssText = 'padding:1px 10px 1px 0';
            tr.appendChild(td);
          });
          t.appendChild(tr);
        });
        box.appendChild(t);
        page.appendChild(box);
        var box2 = groupBox('Totals');
        box2.appendChild(grid([
          ['Channels', String(vstats.channels) + ' (' + vstats.open + ' open)'],
          ['Messages', String(vstats.messages)],
          ['Dropped', String(vstats.dropped), vstats.dropped > 0],
          ['Inbound bytes', kb(vstats.inBytes)],
          ['Outbound bytes', kb(vstats.outBytes)]
        ]));
        page.appendChild(box2);
      } else {                                             /* SLAT & memory */
        var boxA = groupBox('Physical memory');
        boxA.appendChild(grid([
          ['Installed', kb(mem.total)],
          ['Present (mapped)', kb(mem.present)],
          ['Deposited (not present)', kb(mem.deposited)],
          ['Free', kb(mem.free)],
          ['Pages deposited total', String(mem.deposits)],
          ['SLAT faults (all partitions)', String(H.slatFaults()), H.slatFaults() > 0],
          ['Scheduler slices', String(sched.slices) + ', ' + sched.preemptions + ' preemptions'],
          ['Runnable VPs', String(sched.runnable)]
        ]));
        page.appendChild(boxA);
        var boxB = groupBox('Second level address translation — guest window of partition ' + p.id);
        var mapWrap = document.createElement('div');
        mapWrap.style.cssText = 'display:grid;grid-template-columns:repeat(22,11px);gap:1px;margin:2px 0';
        var limit = H.limits().gpaLimit;
        var pages = Math.floor(limit / 4096);
        var legend = { 0: ['#808080', 'unmapped'], 1: ['#0000c0', 'mapped, not present'],
                       2: ['#008040', 'present, read-only'], 3: ['#00a000', 'present, read/write'] };
        for (var i = 0; i < pages; i++) {
          var st = H.gpaState(p.id, i * 4096);
          var cell = document.createElement('div');
          cell.style.cssText = 'width:11px;height:11px;background:' + legend[st][0];
          cell.title = 'GPA ' + hex(i * 4096) + ' — ' + legend[st][1];
          mapWrap.appendChild(cell);
        }
        boxB.appendChild(mapWrap);
        var lg = document.createElement('div');
        lg.style.cssText = 'font:11px "MS Sans Serif",Tahoma,sans-serif;margin-top:4px';
        lg.innerHTML = 'Each cell is one 4 KB guest page; the hypervisor maps them to host pages per ' +
          'partition, so the same GPA in two partitions is different memory. ';
        boxB.appendChild(lg);
        page.appendChild(boxB);
        var boxC = groupBox('Deposits (this partition)');
        boxC.appendChild(grid([
          ['Mapped pages', String(p.mappedPages) + ' (' + kb(p.mappedBytes) + ')'],
          ['Pages deposited', String(p.deposits)],
          ['Guard page (low)', hex(p.canaryLo)],
          ['Guard page (high)', hex(p.canaryHi)],
          ['Guest window', 'GPA 0x00000 – ' + hex(limit)]
        ]));
        page.appendChild(boxC);
      }
    }
    function drawScreen(id) {
      if (!W.ctx) return;
      var rgba = H.guestScreen(id);
      if (!rgba) {
        W.ctx.fillStyle = '#000';
        W.ctx.fillRect(0, 0, H.FB_W, H.FB_H);
        W.ctx.fillStyle = '#00c000';
        W.ctx.font = '12px "Lucida Console",monospace';
        W.ctx.fillText('no guest image', 8, 20);
        return;
      }
      W.img.data.set(rgba);
      W.ctx.putImageData(W.img, 0, 0);
    }

    /* ------------------------------------------------------------- status */
    function renderStatus() {
      var parts = H.partitionList();
      var running = parts.filter(function (p) { return p.state === 3; });
      win.setStatus([
        { text: parts.length + ' partition' + (parts.length === 1 ? '' : 's'), width: 130 },
        { text: running.length + ' running', width: 100 },
        { text: 'Hypercalls ' + H.hypercalls(), width: 130 },
        { text: 'SLAT faults ' + H.slatFaults(), width: 140 },
        { text: 'Ref time ' + H.refTime() + ' ms' }
      ]);
    }
    function refresh(full) {
      renderStatus();
      if (full) renderList();
      if (W.tab === 0) drawScreen(W.sel);
      if (H.mode !== 'wasm') renderPage();
    }

    /* ------------------------------------------------------- initial state */
    function boot() {
      if (H.mode !== 'wasm' && H.ready) {
        H.ready.then(function () {
          if (H.mode === 'wasm') { pick(); renderList(); renderTabs(); renderPage(); renderStatus(); }
        });
      }
      pick();
      renderList();
      renderTabs();
      renderPage();
      renderStatus();
    }
    /* open on a machine that is actually running: the hypervisor boots its own
       guest partition, and a console that starts on the root partition would
       show nothing but an empty screen. */
    function pick() {
      if (H.mode !== 'wasm') return;
      var list2 = H.partitionList();
      if (!list2.length) return;
      var g = list2.filter(function (p) { return p.hasGuest; })[0];
      if (!g) {
        var id = H.create('Windows 98 Guest');
        if (id) { H.start(id); for (var i = 0; i < 12; i++) H.pump(50); g = H.partition(id); }
      }
      if (g && (!W.sel || !H.partition(W.sel))) W.sel = g.id;
      else if (!W.sel) W.sel = list2[list2.length - 1].id;
    }

    boot();
    /* a small surface for the shell's own smoke tests and for debugging */
    global.W98VMM = {
      win: win, state: W, parts: function () { return H.partitionList(); },
      selected: function () { return selected(); }, draw: function () { renderPage(); },
      refresh: function () { refresh(true); }, h: function () { return H; }
    };
    win.setInterval(function () {
      if (H.mode === 'wasm' && H.running()) H.pump(100);   /* keep the guests running */
      refresh(false);
    }, 700);

    return {
      onFocus: function () { refresh(false); },
      onClose: function () { W.canvas = null; W.ctx = null; W.img = null; }
    };
  }

  var appDef = W98.getApp ? W98.getApp(ID) : null;
})();
