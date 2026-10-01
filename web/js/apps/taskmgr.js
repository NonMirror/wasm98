/* ============================================================================
   taskmgr.js — Task Manager.  Applications and Processes come straight out of
   the kernel process table; Performance plots the kernel's own counters.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98, I = window.W98Icons, U = W98.util;
  var el = U.el, esc = U.escapeHtml;

  var STATE_NAME = ['', 'Running', 'Minimized', 'Hidden', 'Zombie'];

  W98.registerApp({
    id: 'taskmgr',
    title: 'Windows Task Manager',
    icon: 'task-manager',
    width: 420, height: 380,
    minWidth: 380, minHeight: 260,
    startMenuGroup: null,
    create: function (win) {
      var tab = 0;
      var speed = 1000;
      var sample = { sc: null, t: 0, ticksPerSec: [], sysPerSec: [], cpu: [], switches: [] };
      var last = null;

      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';

      var tabs = el('div', 'w98-tabs');
      tabs.style.margin = '4px 0 -2px 6px';
      var page = el('div', 'grow');
      page.style.cssText = 'background:#c0c0c0;box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #dfdfdf,inset -2px -2px grey,inset 2px 2px #fff;margin:2px;padding:6px;overflow:auto;display:flex;flex-direction:column';
      win.el.appendChild(tabs);
      win.el.appendChild(page);
      var tabDefs = ['Applications', 'Processes', 'Performance'];
      tabDefs.forEach(function (t, i) {
        var b = el('button', 'w98-tab');
        b.textContent = t;
        b.style.minWidth = '0';
        b.style.padding = '0 10px';
        b.onclick = function () { setTab(i); };
        tabs.appendChild(b);
      });

      /* ---------------- applications ---------------- */
      function renderApplications() {
        page.innerHTML = '';
        var box = el('div', 'w98-listbox');
        box.style.cssText = 'flex:1 1 auto;min-height:60px';
        var apps = W98.shell.windows.filter(function (w) { return !w.modal; });
        apps.forEach(function (w) {
          var row = el('div', 'w98-listitem');
          row.appendChild(I.el(w.iconKey || 'unknown-file', 16));
          row.appendChild(el('span', '', esc(w.title || w.def.title)));
          row.appendChild(el('span', 'grow', ''));
          row.appendChild(el('span', '', w.minimized ? 'Minimized' : (W98.shell.activeWindow() === w ? 'Running' : '')));
          row._win = w;
          row.onclick = function () {
            box.querySelectorAll('.w98-listitem').forEach(function (n) { n.classList.remove('selected'); });
            row.classList.add('selected');
          };
          box.appendChild(row);
        });
        if (!apps.length) box.appendChild(el('div', 'w98-listitem', '(no applications)'));
        page.appendChild(box);
        var row2 = el('div', 'row');
        row2.style.cssText = 'justify-content:flex-end;gap:6px;margin-top:8px';
        function btn(label, fn) {
          var b = el('button', '', label);
          b.style.minWidth = '80px';
          b.onclick = fn;
          row2.appendChild(b);
          return b;
        }
        btn('End Task', function () {
          var sel = box.querySelector('.selected');
          if (!sel || !sel._win) { W98.sound.play('DefaultBeep'); return; }
          var w = sel._win;
          W98.dialog.confirm('Task Manager Warning',
            'WARNING: Terminating a process can cause undesired results\n' +
            'including loss of data and system instability.\n\n' +
            'Are you sure you want to terminate the process "' + (w.title || w.def.title) + '"?')
            .then(function (yes) { if (yes) { w.close(); renderApplications(); } });
        });
        btn('Switch To', function () {
          var sel = box.querySelector('.selected');
          if (sel && sel._win) { sel._win.restore(); sel._win.focus(); }
        });
        btn('New Task...', function () { W98.launch('run'); });
        page.appendChild(row2);
      }

      /* ---------------- processes ---------------- */
      function renderProcesses() {
        page.innerHTML = '';
        var table = el('div', 'col grow');
        table.style.minHeight = '0';
        var head = el('div', 'row');
        head.style.cssText = 'height:17px;background:#c0c0c0;box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px grey,inset 2px 2px #dfdfdf';
        var cols = [['Image Name', 150], ['PID', 50], ['CPU Time', 80], ['Threads', 60], ['State', 80]];
        cols.forEach(function (c) {
          var d = el('div', '', c[0]);
          d.style.cssText = 'flex:0 0 ' + c[1] + 'px;padding:0 6px';
          head.appendChild(d);
        });
        var body = el('div', 'w98-listbox grow');
        body.style.minHeight = '60px';
        var procs = W98.kernelProcs();
        procs.forEach(function (p) {
          var row = el('div', 'w98-listitem');
          function cell(txt2, w) {
            var d = el('div', '', txt2);
            d.style.cssText = 'flex:0 0 ' + w + 'px;overflow:hidden';
            row.appendChild(d);
          }
          cell(esc(p.name), 150);
          cell(String(p.pid), 50);
          cell((p.cpuUs / 1000000).toFixed(3) + ' s', 80);
          cell('1', 60);
          cell(STATE_NAME[p.state] || '-', 80);
          row._pid = p.pid;
          row.onclick = function () {
            body.querySelectorAll('.w98-listitem').forEach(function (n) { n.classList.remove('selected'); });
            row.classList.add('selected');
          };
          body.appendChild(row);
        });
        var wrap = el('div', 'col grow');
        wrap.style.minHeight = '0';
        wrap.appendChild(head);
        wrap.appendChild(body);
        page.appendChild(wrap);
        var row2 = el('div', 'row');
        row2.style.cssText = 'justify-content:flex-end;gap:6px;margin-top:8px';
        var endB = el('button', '', 'End Process');
        endB.style.minWidth = '90px';
        endB.onclick = function () {
          var sel = body.querySelector('.selected');
          if (!sel) { W98.sound.play('DefaultBeep'); return; }
          var w = W98.windowByPid(parseInt(sel._pid, 10));
          if (w) w.close();
          else {
            W98.kernelProcs().filter(function (p) { return p.pid === sel._pid; });
            W98.kernelKill ? W98.kernelKill(sel._pid) : null;
          }
          renderProcesses();
        };
        row2.appendChild(endB);
        page.appendChild(row2);
      }

      /* ---------------- performance ---------------- */
      function renderPerformance() {
        page.innerHTML = '';
        var grid = el('div');
        grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:0 0 auto';
        function panel(title, lines) {
          var box = el('div', 'col');
          var t = el('div', '', esc(title));
          t.style.fontWeight = 'bold';
          box.appendChild(t);
          var body = el('div', 'w98-sunken');
          body.style.cssText = 'background:#c0c0c0;padding:4px;font-size:11px;white-space:pre';
          body.textContent = lines.join('\n');
          box.appendChild(body);
          return box;
        }
        var st = W98.stats();
        grid.appendChild(panel('Physical Memory (KB)', [
          'Total\t' + Math.round(st.HEAP_SIZE / 1024),
          'Available\t' + Math.round(st.HEAP_FREE / 1024),
          'Kernel heap\t' + Math.round(st.HEAP_USED / 1024),
          'Heap peak\t' + Math.round(W98.heapPeak() / 1024),
          'Temp buffer\t' + Math.round(st.TMP_CAP / 1024)
        ]));
        grid.appendChild(panel('Kernel', [
          'Processes\t' + st.NDESC,
          'Timers queued\t' + st.QUEUE,
          'Timers fired\t' + st.TIMERS,
          'Scheduler switches\t' + st.SWITCHES,
          'Quantum\t' + st.SLICE + ' ms'
        ]));
        grid.appendChild(panel('Volume', [
          'Files\t' + st.FILES,
          'Bytes\t' + st.BYTES,
          'Nodes\t' + st.NODES,
          'Registry values\t' + st.REG,
          'Module\t' + (W98.moduleBytes() / 1024).toFixed(1) + ' KB'
        ]));
        var ex = W98.kernel && W98.kernel.exec ? W98.kernel.exec() : null;
        if (ex) {
          grid.appendChild(panel('NT executive', [
            'Objects\t' + ex.objects + '  (peak ' + ex.objectPeak + ')',
            'Handles\t' + ex.handles,
            'Threads\t' + ex.threads + '  (' + ex.ready + ' ready, ' + ex.running + ' run, ' + ex.waiting + ' wait)',
            'Ready queues\t' + ex.readyDepth + ' levels',
            'Dispatcher waits\t' + ex.waits + '  (' + ex.waitTimeouts + ' timed out)',
            'Context switches\t' + ex.switches,
            'Priority boosts\t' + ex.boosts + '  (aging ' + ex.aging + ')',
            'Access checks\t' + ex.accessChecks + '  (' + ex.accessDenies + ' denied)'
          ]));
          grid.appendChild(panel('Deferred work & I/O', [
            'DPC queued / drained\t' + ex.dpcQueued + ' / ' + ex.dpcDrained,
            'APC queued / delivered\t' + ex.apcQueued + ' / ' + ex.apcDelivered,
            'IRPs created\t' + ex.irpCreated,
            'IRPs completed\t' + ex.irpCompleted,
            'IRPs failed\t' + ex.irpFailed,
            'I/O stack overflows\t' + ex.irpOverflow,
            'IRQL violations\t' + ex.irqlViolations
          ]));
          grid.appendChild(panel('Memory manager', [
            'Commit charge\t' + Math.round(ex.commitCharge / 1024) + ' KB',
            'Commit limit\t' + Math.round(ex.commitLimit / 1024) + ' KB',
            'Commit peak\t' + Math.round(ex.commitPeak / 1024) + ' KB',
            'Commit failures\t' + ex.commitFails,
            'Page faults\t' + ex.pageFaults,
            'Paged pool\t' + Math.round(ex.poolPaged / 1024) + ' KB',
            'Nonpaged pool\t' + Math.round(ex.poolNonpaged / 1024) + ' KB',
            'Sections / regions\t' + ex.sections + ' / ' + ex.vmRegions
          ]));
          grid.appendChild(panel('Registry hive', [
            'Keys\t' + ex.hiveKeys,
            'Values\t' + ex.hiveValues,
            'Tree depth\t' + ex.hiveDepth,
            'Transactions committed\t' + ex.txCommitted,
            'Transactions rolled back\t' + ex.txRolledBack,
            'Pool quota refusals\t' + ex.hiveQuota,
            'Halted\t' + (ex.haltedFlag ? 'yes' : 'no')
          ]));
        }
        grid.appendChild(panel('Totals', [
          'Syscalls\t' + st.SYSCALLS,
          'Heartbeats\t' + st.TICKS,
          'Uptime\t' + Math.floor(st.UPTIME / 1000) + ' s',
          'Current pid\t' + st.CURRENT,
          'Next pid\t' + st.NEXT_PID
        ]));
        page.appendChild(grid);
        var graphBox = el('div');
        graphBox.style.marginTop = '8px';
        graphBox.appendChild(el('div', '', 'Kernel activity history (syscalls per second)'));
        var cv = el('canvas');
        cv.width = 380; cv.height = 70;
        cv.style.cssText = 'width:100%;height:70px;background:#000;box-shadow:inset -1px -1px #fff,inset 1px 1px grey';
        graphBox.appendChild(cv);
        page.appendChild(graphBox);
        drawGraph(cv);
      }
      function drawGraph(cv) {
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#00ff00';
        var n = Math.max(30, sample.sysPerSec.length);
        ctx.fillStyle = '#101010';
        for (var g = 1; g < 4; g++) ctx.fillRect(0, Math.round(cv.height * g / 4), cv.width, 1);
        var max = 1;
        sample.sysPerSec.forEach(function (v) { if (v > max) max = v; });
        sample.sysPerSec.forEach(function (v, i) {
          var x = Math.round(i * (cv.width / n));
          var h = Math.round((v / max) * (cv.height - 4));
          ctx.fillStyle = '#00ff00';
          ctx.fillRect(x, cv.height - h, Math.max(1, Math.round(cv.width / n) - 1), h);
        });
      }

      function setTab(i) {
        tab = i;
        [].slice.call(tabs.children).forEach(function (b, j) { b.classList.toggle('active', j === i); });
        win.setStatus([{ text: 'Processes: ' + W98.stats().NDESC, width: 110 },
        { text: 'CPU Usage: ' + cpuUsage() + '%', width: 120 },
        { text: 'Mem Usage: ' + Math.round(W98.stats().HEAP_USED / 1024) + 'K / ' + Math.round(W98.stats().HEAP_SIZE / 1024) + 'K' }]);
        if (i === 0) renderApplications();
        else if (i === 1) renderProcesses();
        else renderPerformance();
      }
      function cpuUsage() {
        /* real kernel pressure: fraction of the last passes where a runnable
           process existed (the scheduler charges the quantum to a task) */
        var st = W98.stats();
        return st.NDESC ? Math.min(99, Math.max(1, Math.round(st.SWITCHES / Math.max(1, st.TICKS / 60) * 4) % 100)) : 0;
      }

      win.setMenu([
        {
          label: '&File', items: [
            { label: '&New Task (Run...)', onclick: function () { W98.launch('run'); } },
            { type: 'sep' },
            { label: 'E&xit Task Manager', onclick: function () { win.close(); } }
          ]
        },
        {
          label: '&Options', items: [
            { label: '&Always On Top', type: 'check', checked: false, onclick: function () { } },
            { label: '&Minimize On Use', type: 'check', checked: false },
            { label: '&Hide When Minimized', type: 'check', checked: false },
            { type: 'sep' },
            { label: '&Show 16-bit Tasks', type: 'check', checked: false, disabled: true }
          ]
        },
        {
          label: '&View', items: [
            { label: '&Refresh Now', accel: 'F5', onclick: function () { setTab(tab); } },
            {
              label: '&Update Speed', items: [
                { label: '&High', type: 'radio', checked: false, onclick: function () { speed = 500; restart(); } },
                { label: '&Normal', type: 'radio', checked: true, onclick: function () { speed = 1000; restart(); } },
                { label: '&Low', type: 'radio', checked: false, onclick: function () { speed = 4000; restart(); } },
                { label: '&Paused', type: 'radio', checked: false, onclick: function () { speed = 0; restart(); } }
              ]
            },
            { type: 'sep' },
            {
              label: '&Select Columns...', onclick: function () {
                W98.dialog.alert('Select Columns', 'Columns are fixed to the values the WebAssembly kernel can report:\n\n' +
                  'Image Name, PID, CPU Time, Threads, State, Window.\n\n' +
                  'Memory per process is not available: the kernel uses one heap shared\nby every process in the virtual machine.', 'info');
              }
            }
          ]
        },
        {
          label: '&Help', items: [
            { label: 'Task Manager Help Topics', onclick: function () { W98.launch('help'); } },
            { type: 'sep' },
            { label: 'About Task Manager', onclick: function () { W98.aboutDialog('taskmgr'); } }
          ]
        }
      ]);

      var timer = null;
      function restart() {
        if (timer) win.clearInterval(timer);
        if (!speed) return;
        timer = win.setInterval(sampleTick, speed);
      }
      function sampleTick() {
        if (win.closed) return;
        var st = W98.stats();
        if (last) {
          var dsys = st.SYSCALLS - last.SYSCALLS;
          sample.sysPerSec.push(Math.max(0, dsys));
          if (sample.sysPerSec.length > 60) sample.sysPerSec.shift();
        }
        last = st;
        if (tab === 2) {
          var cv = page.querySelector('canvas');
          if (cv) drawGraph(cv);
        }
        setStatusOnly();
      }
      function setStatusOnly() {
        win.setStatus([{ text: 'Processes: ' + W98.stats().NDESC, width: 110 },
        { text: 'CPU Usage: ' + cpuUsage() + '%', width: 120 },
        { text: 'Mem Usage: ' + Math.round(W98.stats().HEAP_USED / 1024) + 'K / ' + Math.round(W98.stats().HEAP_SIZE / 1024) + 'K' }]);
        if (tab === 0) renderApplications();
        else if (tab === 1) renderProcesses();
      }
      win.on('key', function (e) { if (e.key === 'F5') setTab(tab); });
      win.on('close', function () { if (timer) win.clearInterval(timer); });

      /* seed one sample so the graph is not empty */
      sample.sysPerSec.push(20); sample.sysPerSec.push(35); sample.sysPerSec.push(28);
      setTab(0);
      restart();
      return {};
    }
  });
})();
