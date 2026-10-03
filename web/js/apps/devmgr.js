/* ============================================================================
   devmgr.js — Windows 98 style Device Manager.

   The device list is supplied by web/js/devices.js.  That adapter keeps a
   deterministic virtual inventory in the registry and optionally annotates
   devices with facts read from W98HV.  The UI deliberately treats every
   entry as virtual unless the adapter says otherwise; browser hardware is
   never changed by this window.
   ========================================================================== */
(function () {
  'use strict';
  var W98 = window.W98;
  if (!W98 || typeof W98.registerApp !== 'function') return;
  var I = window.W98Icons || {};
  var U = W98.util || {};
  var el = U.el || function (tag, cls, txt) {
    var n = document.createElement(tag || 'div');
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  var esc = U.escapeHtml || function (s) {
    return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[c];
    });
  };

  var REG = 'HKEY_CURRENT_USER\\Software\\W98\\DeviceManager';
  var VIEWS = { type: 'by type', connection: 'by connection', resources: 'by resources' };
  var CLASS_ORDER = ['System', 'Display', 'Keyboard', 'Mouse', 'Disk drives', 'CD-ROM', 'Sound', 'Modem', 'Network', 'Bus', 'Other'];
  var ICONS = {
    Computer: 'my-computer', System: 'system', Display: 'display', Keyboard: 'keyboard', Mouse: 'mouse',
    'Disk drives': 'hard-disk', 'CD-ROM': 'cdrom', Sound: 'speaker', Modem: 'modem', Network: 'network',
    Bus: 'system', Other: 'unknown'
  };

  function model() { return W98.devices || null; }
  function safe(fn, dflt) { try { var v = fn(); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function allDevices(showHidden) {
    var m = model();
    if (!m || typeof m.list !== 'function') return [];
    var a = safe(function () { return m.list({ showHidden: !!showHidden }); }, []);
    if (!Array.isArray(a)) a = [];
    return a.filter(function (d) { return d && (showHidden ? true : (!d.hidden && !d.removed)); });
  }
  function nameOf(d) { return String(d && (d.friendlyName || d.name || d.id) || 'Device'); }
  function classOf(d) { return String(d && (d.class || d.deviceClass) || 'Other'); }
  function sourceOf(d) { return d && (d.availability || d.source) || 'modeled-virtual'; }
  function sourceLabel(d) {
    if (d && (d.virtual || String(sourceOf(d)).toLowerCase().indexOf('virtual') >= 0 || String(sourceOf(d)).toLowerCase().indexOf('hypervisor') >= 0)) return 'Modeled virtual device';
    return 'Unavailable physical hardware (simulated)';
  }
  function isWarn(d) {
    if (!d) return false;
    var status = String(d.status || '').toLowerCase();
    return !!(d.problemCode || d.problem || d.conflictId || d.conflict || status === 'conflict' || status === 'error' || status === 'missing driver');
  }
  function statusOf(d) {
    if (!d) return 'Unknown';
    if (d.removed || d.present === false) return 'Removed (rescan to restore)';
    if (d.enabled === false) return 'Disabled';
    if (d.problemCode || d.problem || d.conflictId || d.conflict) return d.status || 'Resource conflict';
    return d.status || 'Working properly';
  }
  function iconFor(dOrClass) {
    var c = typeof dOrClass === 'string' ? dOrClass : classOf(dOrClass);
    if (ICONS[c]) return ICONS[c];
    var l = c.toLowerCase();
    if (l.indexOf('display') >= 0) return 'display';
    if (l.indexOf('keyboard') >= 0) return 'keyboard';
    if (l.indexOf('mouse') >= 0) return 'mouse';
    if (l.indexOf('disk') >= 0 || l.indexOf('storage') >= 0) return 'hard-disk';
    if (l.indexOf('cd') >= 0) return 'cdrom';
    if (l.indexOf('sound') >= 0 || l.indexOf('audio') >= 0) return 'speaker';
    if (l.indexOf('modem') >= 0) return 'modem';
    if (l.indexOf('network') >= 0) return 'network';
    if (l.indexOf('system') >= 0 || l.indexOf('bus') >= 0) return 'system';
    return 'unknown';
  }
  function iconNode(key, size) {
    try { return I.el ? I.el(key, size || 16) : el('span', '', ''); } catch (e) { return el('span', '', ''); }
  }
  function regGet(name, dflt) { return safe(function () { return W98.reg.get(REG, name, dflt); }, dflt); }
  function regSet(name, value) { safe(function () { W98.reg.set(REG, name, value); }, null); }

  W98.registerApp({
    id: 'devmgr', title: 'Device Manager', icon: 'system', width: 670, height: 470,
    minWidth: 520, minHeight: 330, resizable: true, singleton: true, startMenuGroup: 'System Tools',
    create: function (win) {
      var view = regGet('View', 'type');
      if (!VIEWS[view]) view = 'type';
      var showHidden = regGet('ShowHidden', '0') === '1';
      var selected = null;
      var expanded = {};
      var flat = [];
      var treeSig = '';
      var closed = false;
      var unsub = null;

      win.el.style.display = 'flex';
      win.el.style.flexDirection = 'column';

      var toolbar = el('div', 'w98-toolbar');
      win.el.appendChild(toolbar);
      var main = el('div', 'row');
      main.style.cssText = 'flex:1 1 auto;min-height:0;align-items:stretch;padding:2px;gap:2px';
      win.el.appendChild(main);
      var left = el('div', 'col');
      left.style.cssText = 'flex:0 0 286px;min-width:200px;gap:0';
      var treeHead = el('div');
      treeHead.style.cssText = 'height:17px;line-height:17px;padding:0 4px;background:#fff;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-shadow:inset -1px -1px #dfdfdf,inset 1px 1px grey';
      var tree = el('ul', 'w98-tree');
      tree.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;margin:0;overflow:auto';
      left.appendChild(treeHead); left.appendChild(tree); main.appendChild(left);
      var right = el('div', 'col');
      right.style.cssText = 'flex:1 1 auto;min-width:0;min-height:0;gap:0;padding-left:4px';
      var paneHead = el('div');
      paneHead.style.cssText = 'height:17px;line-height:17px;padding:0 4px;font-weight:bold;overflow:hidden;white-space:nowrap';
      var page = el('div', 'w98-tabpage');
      page.style.cssText = 'overflow:auto;padding:8px;min-height:0';
      right.appendChild(paneHead); right.appendChild(page); main.appendChild(right);

      function current() {
        if (!selected) return null;
        var list = allDevices(true);
        for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(selected)) return list[i];
        return null;
      }
      function button(label, icon, title, fn) {
        var b = el('button', 'w98-toolbtn');
        if (icon) b.appendChild(iconNode(icon, 16));
        b.appendChild(el('span', '', label)); b.title = title || label; b.onclick = fn;
        toolbar.appendChild(b); return b;
      }
      var tools = {};
      tools.view = button('View', 'views', 'Change the device tree view', function () { chooseView(); });
      tools.scan = button('Scan', 'refresh', 'Scan for hardware changes', scan);
      var sep = el('div', 'w98-toolbar-sep'); toolbar.appendChild(sep);
      tools.props = button('Properties', 'props', 'View selected device properties', properties);
      tools.enable = button('Enable', 'check', 'Enable selected device', function () { toggle(true); });
      tools.disable = button('Disable', 'warning', 'Disable selected device', function () { toggle(false); });
      tools.remove = button('Remove', 'delete', 'Remove selected device', remove);
      tools.driver = button('Update Driver', 'add-hardware', 'Install a local mock driver', updateDriver);
      var sep2 = el('div', 'w98-toolbar-sep'); toolbar.appendChild(sep2);
      tools.conflict = button('Conflict', 'warning', 'Simulate a resource conflict', createConflict);
      tools.resolve = button('Resolve', 'check', 'Resolve the selected resource conflict', resolveConflict);

      function chooseView() {
        var dlg = W98.dialog.custom({ title: 'View devices', width: 300, height: 190, owner: win, icon: 'system' });
        var box = dlg.box; box.style.padding = '10px';
        box.appendChild(el('div', '', 'Arrange devices:'));
        var opts = el('div', 'col'); opts.style.cssText = 'gap:4px;margin:8px 0';
        Object.keys(VIEWS).forEach(function (key) {
          var lab = el('label', 'field-row'); var rb = el('input'); rb.type = 'radio'; rb.name = 'dm-view'; rb.checked = view === key; rb.value = key;
          lab.appendChild(rb); lab.appendChild(el('span', '', 'View ' + VIEWS[key])); opts.appendChild(lab);
        });
        box.appendChild(opts);
        var btns = el('div', 'dlg-buttons'); var ok = el('button', 'default', 'OK'); var cancel = el('button', '', 'Cancel');
        btns.appendChild(ok); btns.appendChild(cancel); box.appendChild(btns);
        cancel.onclick = function () { dlg.close(); };
        ok.onclick = function () {
          var rb2 = box.querySelector('input[name="dm-view"]:checked');
          if (rb2) { view = rb2.value; regSet('View', view); expanded = {}; treeSig = ''; render(); }
          dlg.close();
        };
      }
      function showHiddenToggle() {
        showHidden = !showHidden; regSet('ShowHidden', showHidden ? '1' : '0'); treeSig = ''; render();
      }
      function refreshModel() {
        var m = model();
        if (m && typeof m.rescan === 'function') safe(function () { m.rescan(); }, null);
        treeSig = ''; render();
      }
      function scan() {
        var m = model();
        if (m && typeof m.rescan === 'function') safe(function () { m.rescan(); }, null);
        treeSig = ''; render();
        try { W98.sound.play('MenuCommand'); } catch (e) { }
      }
      function toggle(enable) {
        var d = current(), m = model(); if (!d || !m) return;
        var fn = enable ? (m.enable || m.setEnabled) : (m.disable || m.setEnabled);
        if (typeof fn !== 'function') return;
        safe(function () { return fn.call(m, d.id, enable); }, null);
        treeSig = ''; render();
      }
      function remove() {
        var d = current(), m = model(); if (!d || !m || typeof m.remove !== 'function') return;
        W98.dialog.confirm('Device Manager', 'Remove "' + nameOf(d) + '" from this virtual machine?\n\nThe device can be restored with Scan for hardware changes.').then(function (ok) {
          if (!ok) return;
          var result = safe(function () { return m.remove(d.id); }, false);
          if (result === false) {
            W98.dialog.alert('Device Manager', 'The device cannot be removed while a virtual handle is open. Close the handle and try again.', 'warn');
            return;
          }
          selected = null; treeSig = ''; render();
        });
      }
      function properties() {
        var d = current(); if (!d) return;
        var dlg = W98.dialog.custom({ title: nameOf(d) + ' Properties', width: 430, height: 360, owner: win, icon: iconFor(d) });
        var box = dlg.box; box.style.padding = '10px';
        var tabs = el('div', 'w98-tabs'); var body = el('div', 'col'); body.style.cssText = 'gap:7px;margin-top:8px;min-height:200px';
        box.appendChild(tabs); box.appendChild(body);
        var defs = ['General', 'Driver', 'Resources'];
        function row(k, v) { var r = el('div', 'row'); r.style.gap = '7px'; r.appendChild(el('div', '', k + ':')); var val = el('div', 'grow'); val.textContent = v == null || v === '' ? '(none)' : String(v); r.appendChild(val); body.appendChild(r); }
        function draw(i) {
          body.innerHTML = '';
          if (i === 0) {
            var h = el('div', 'row'); h.style.gap = '8px'; h.appendChild(iconNode(iconFor(d), 32)); h.appendChild(el('div', '', nameOf(d))); body.appendChild(h);
            row('Hardware ID', d.hardwareId); row('Class', classOf(d)); row('Status', statusOf(d)); row('State', d.enabled === false ? 'Disabled' : 'Enabled');
            row('PnP state', d.pnpState || 'PNP_STARTED'); row('Power state', d.powerState || (d.enabled === false ? 'D3' : 'D0'));
            row('Open handles', d.openHandles || 0);
            row('Source', sourceLabel(d));
            if (d.hvBacked) row('W98HV', d.hvAvailable ? 'Available (hypervisor-backed metadata)' : 'Unavailable; virtual fixture retained');
            if (d.parent) row('Parent bus', d.parent);
            if (d.problemCode || d.problem) row('Problem', d.problemCode || d.problem);
          } else if (i === 1) {
            row('Driver version', d.driverVersion || 'Not installed'); row('Provider', d.driverProvider || 'Windows 98 virtual-device layer');
            row('Driver status', d.driverVersion ? 'This is a local-only mock driver.' : 'No driver is installed.');
          } else {
            var rs = d.resources || [];
            if (!Array.isArray(rs)) { var legacy = rs; rs = []; Object.keys(legacy).forEach(function (lk) { rs.push({ type: lk, value: legacy[lk] }); }); }
            if (!rs.length) row('Resources', 'None assigned');
            rs.forEach(function (r) { row(String(r.type || 'Resource').toUpperCase(), r.value); });
            row('Conflict', isWarn(d) ? (d.conflict || d.problem || 'Simulated conflict') : 'No conflicts');
          }
        }
        defs.forEach(function (label, i) { var b = el('button', 'w98-tab', label); b.style.minWidth = '0'; b.onclick = function () { tabs.querySelectorAll('button').forEach(function (n) { n.classList.remove('active'); }); b.classList.add('active'); draw(i); }; tabs.appendChild(b); if (i === 0) b.classList.add('active'); });
        draw(0);
        var btns = el('div', 'dlg-buttons'); var ok = el('button', 'default', 'OK'); ok.onclick = function () { dlg.close(); }; btns.appendChild(ok); box.appendChild(btns);
      }
      function updateDriver() {
        var d = current(), m = model(); if (!d || !m) return;
        var dlg = W98.dialog.custom({ title: 'Update Driver', width: 400, height: 240, owner: win, icon: 'add-hardware' });
        var box = dlg.box; box.style.padding = '10px';
        box.appendChild(el('div', '', 'Device: ' + nameOf(d)));
        box.appendChild(el('div', '', 'The wizard searches this Windows 98 image only. No network or browser hardware is accessed.'));
        var path = el('input'); path.type = 'text'; path.value = 'C:\\WINDOWS\\INF\\VIRTUAL.INF'; path.style.width = '100%'; path.style.marginTop = '10px'; box.appendChild(path);
        var status = el('div', 'w98-sunken', 'Ready to install a local mock driver.'); status.style.cssText = 'padding:5px;margin-top:8px'; box.appendChild(status);
        var btns = el('div', 'dlg-buttons'); var install = el('button', 'default', 'Install'); var cancel = el('button', '', 'Cancel'); btns.appendChild(install); btns.appendChild(cancel); box.appendChild(btns);
        cancel.onclick = function () { dlg.close(); };
        install.onclick = function () {
          var ver = '4.10.1998-local';
          safe(function () { return m.updateDriver(d.id, ver, path.value); }, null);
          status.textContent = 'Driver installed locally (' + ver + ').'; install.disabled = true; treeSig = ''; render();
        };
      }
      function createConflict() {
        var d = current(), m = model();
        if (!d || !m) return;
        var fn = m.createConflict || m.simulateConflict;
        if (typeof fn !== 'function') return;
        var mine = (d.resources || [])[0] || { type: 'IRQ', value: '5' };
        var other = allDevices(true).filter(function (x) {
          return x.id !== d.id && x.present !== false && (x.resources || []).some(function (r) { return String(r.type).toLowerCase() === String(mine.type).toLowerCase(); });
        })[0];
        if (!other) other = allDevices(true).filter(function (x) { return x.id !== d.id && x.present !== false; })[0];
        if (!other) return;
        safe(function () { return fn.call(m, d.id, other.id, mine.type, mine.value); }, null); treeSig = ''; render();
      }
      function resolveConflict() {
        var d = current(), m = model(); if (!d || !m) return;
        var fn = m.resolveConflict;
        if (typeof fn !== 'function') return;
        var cid = d.conflictId;
        if (!cid && typeof m.conflicts === 'function') {
          var cs = safe(function () { return m.conflicts(); }, []);
          var c = cs.filter(function (x) { return x && (x.a === d.id || x.b === d.id); })[0];
          cid = c && c.id;
        }
        if (!cid) return;
        safe(function () { return fn.call(m, cid); }, null); treeSig = ''; render();
      }

      function leafNode(d) { return { kind: 'device', id: String(d.id), label: nameOf(d), dev: d, children: [] }; }
      function groupNode(key, label, children) { return { kind: 'group', id: 'g:' + key, label: label, children: children || [] }; }
      function buildTree(devs) {
        var groups = [], by = {};
        var computer = devs.filter(function (d) { return String(d.id) === 'ROOT\\COMPUTER'; })[0] || null;
        function add(key, label, d) { if (!by[key]) { by[key] = groupNode(key, label, []); groups.push(by[key]); } by[key].children.push(leafNode(d)); }
        if (view === 'type') {
          devs.forEach(function (d) { if (d !== computer) { var c = classOf(d); add(c, c, d); } });
          groups.sort(function (a, b) { var ai = CLASS_ORDER.indexOf(a.label), bi = CLASS_ORDER.indexOf(b.label); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label); });
        } else if (view === 'connection') {
          var parentNames = {}; devs.forEach(function (x) { parentNames[String(x.id)] = nameOf(x); });
          devs.forEach(function (d) { if (d !== computer) { var p = d.parent || 'ROOT\\COMPUTER'; var pl = parentNames[String(p)] || String(p); add(String(p), pl, d); } });
          groups.sort(function (a, b) { return a.label.localeCompare(b.label); });
        } else {
          devs.forEach(function (d) { if (d === computer) return;
            var r = d.resources || [];
            if (!Array.isArray(r)) { var legacy = r; r = []; Object.keys(legacy).forEach(function (lk) { r.push({ type: lk, value: legacy[lk] }); }); }
            if (!r.length) add('none', 'No resources', d);
            else r.forEach(function (res) { var k = String(res.type || 'Resource').toUpperCase(); add(k, k, d); });
          });
          groups.sort(function (a, b) { return a.label.localeCompare(b.label); });
        }
        groups.forEach(function (g) { g.children.sort(function (a, b) { return a.label.localeCompare(b.label); }); });
        var root = groupNode('computer', 'Computer', groups);
        root.dev = computer || null;
        return root;
      }
      function sigFor(node) {
        var s = node.id + ':' + (expanded[node.id] ? 1 : 0);
        node.children.forEach(function (n) { s += '|' + n.id + ':' + n.label + ':' + (n.dev ? statusOf(n.dev) : '') + ':' + (expanded[n.id] ? 1 : 0); });
        return s;
      }
      function renderNode(node, depth, parent) {
        var li = el('li'); li.dataset.nodeId = node.id;
        var has = node.children && node.children.length > 0; var open = expanded[node.id] !== false;
        li.tabIndex = 0; li.setAttribute('role', 'treeitem'); li.setAttribute('aria-level', String(depth + 1));
        if (has) li.setAttribute('aria-expanded', open ? 'true' : 'false');
        var tw = el('div', has ? 'tw' : 'tw empty', has ? (open ? '-' : '+') : ''); li.appendChild(tw);
        var iw = el('span'); var d = node.dev; iw.appendChild(iconNode(d ? (isWarn(d) ? 'warning' : iconFor(d)) : iconFor(node.label), 16)); li.appendChild(iw);
        var label = el('span'); label.textContent = node.label; if (d && (d.enabled === false || d.removed)) label.style.color = '#808080'; li.appendChild(label);
        if (d && isWarn(d)) { var warn = el('span', '', ' !'); warn.style.color = '#806000'; li.appendChild(warn); }
        if (d) li.dataset.deviceId = d.id;
        li.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (d) selected = String(d.id); else selected = null; markSelection(); renderPane(); updateButtons(); win.setMenu(menuDef()); };
        li.ondblclick = function () { if (d) properties(); };
        li.onkeydown = function (e) {
          var rows = flat.filter(function (f) { return f.node.getBoundingClientRect().height > 0; });
          var at = rows.indexOf(flat.filter(function (f) { return f.node === li; })[0]);
          var target = null;
          if (e.key === 'ArrowDown' || e.key === 'Down') target = rows[Math.min(rows.length - 1, at + 1)];
          else if (e.key === 'ArrowUp' || e.key === 'Up') target = rows[Math.max(0, at - 1)];
          else if (e.key === 'ArrowRight' || e.key === 'Right') {
            if (has && !open) { expanded[node.id] = true; treeSig = ''; render(); focusTreeNode(node.id); return e.preventDefault(); }
            if (has && open) target = rows[at + 1];
          } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
            if (has && open) { expanded[node.id] = false; treeSig = ''; render(); focusTreeNode(node.id); return e.preventDefault(); }
            if (parent) {
              var pf = flat.filter(function (f) { return f.item === parent; })[0];
              target = pf && rows.indexOf(pf) >= 0 ? pf : null;
            }
          } else if (e.key === 'Enter' || e.key === ' ') {
            if (d) properties(); else if (has) { expanded[node.id] = !open; treeSig = ''; render(); focusTreeNode(node.id); }
            return e.preventDefault();
          }
          if (target) {
            selected = target.item.dev ? String(target.item.dev.id) : null;
            target.node.focus(); markSelection(); renderPane(); updateButtons(); win.setMenu(menuDef()); e.preventDefault();
          }
        };
        tw.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (!has) return; expanded[node.id] = !open; treeSig = ''; render(); };
        flat.push({ node: li, item: node, depth: depth });
        if (has) {
          var ul = el('ul'); ul.style.display = open ? '' : 'none';
          node.children.forEach(function (c) { ul.appendChild(renderNode(c, depth + 1, node)); }); li.appendChild(ul);
        }
        return li;
      }
      function markSelection() {
        flat.forEach(function (f) { f.node.classList.toggle('sel', !!selected && f.item.kind === 'device' && String(f.item.id) === String(selected)); });
      }
      function focusTreeNode(id) {
        for (var i = 0; i < flat.length; i++) if (flat[i].item.id === id) { flat[i].node.focus(); return; }
      }
      function renderPane() {
        var d = current(); page.innerHTML = ''; paneHead.textContent = d ? nameOf(d) : 'Device Manager';
        if (!d) {
          var box = el('div', 'col'); box.style.cssText = 'gap:8px'; box.appendChild(el('div', '', 'Select a device to view its status and properties.'));
          box.appendChild(el('div', 'w98-sunken', 'Devices shown here are modeled virtual devices. Browser hardware is not changed.')); page.appendChild(box); return;
        }
        var head = el('div', 'row'); head.style.gap = '10px'; head.appendChild(iconNode(isWarn(d) ? 'warning' : iconFor(d), 32));
        var title = el('div', 'col'); title.appendChild(el('div', '', nameOf(d))); title.appendChild(el('div', '', statusOf(d))); head.appendChild(title); page.appendChild(head);
        var source = sourceLabel(d);
        var note = el('div', 'w98-sunken'); note.style.cssText = 'padding:6px;margin-top:8px'; note.textContent = source + '. Changes are persisted in W98.reg.'; page.appendChild(note);
        var details = el('div', 'col'); details.style.cssText = 'gap:4px;margin-top:10px';
        [['Hardware ID', d.hardwareId], ['Class', classOf(d)], ['Driver', d.driverVersion || 'Not installed'], ['Enabled', d.enabled === false ? 'No' : 'Yes'], ['PnP state', d.pnpState || 'PNP_STARTED'], ['Power state', d.powerState || (d.enabled === false ? 'D3' : 'D0')], ['Open handles', d.openHandles || 0], ['Problem code', d.problemCode || d.problem || 'None']].forEach(function (r) { var row = el('div', 'row'); row.style.gap = '8px'; row.appendChild(el('div', '', r[0] + ':')); row.appendChild(el('div', 'grow', r[1] == null || r[1] === '' ? '(none)' : String(r[1]))); details.appendChild(row); });
        if (d.hvBacked) { var hvRow = el('div', 'row'); hvRow.style.gap = '8px'; hvRow.appendChild(el('div', '', 'W98HV:')); hvRow.appendChild(el('div', 'grow', d.hvAvailable ? 'Available (hypervisor-backed metadata)' : 'Unavailable; virtual fixture retained')); details.appendChild(hvRow); }
        page.appendChild(details);
      }
      function updateButtons() {
        var d = current(), has = !!d, root = has && String(d.id) === 'ROOT\\COMPUTER';
        tools.props.disabled = !has; tools.remove.disabled = !has || root; tools.driver.disabled = !has || root; tools.conflict.disabled = !has || root; tools.resolve.disabled = !has || root || !isWarn(d); tools.enable.disabled = !has || root || d.enabled !== false; tools.disable.disabled = !has || root || d.enabled === false;
      }
      function render() {
        var devs = allDevices(showHidden); var root = buildTree(devs); treeHead.textContent = 'Computer';
        var sig = view + ':' + (showHidden ? 1 : 0) + ':' + sigFor(root); devs.forEach(function (d) { sig += ':' + d.id + ':' + statusOf(d); });
        if (sig !== treeSig) { treeSig = sig; var scroll = tree.scrollTop; tree.innerHTML = ''; flat = []; tree.appendChild(renderNode(root, 0, null)); tree.scrollTop = scroll; }
        markSelection(); renderPane(); updateButtons(); win.setMenu(menuDef());
        win.setStatus([{ text: devs.length + ' device' + (devs.length === 1 ? '' : 's'), width: 150 }, { text: showHidden ? 'Hidden devices shown' : 'Hidden devices not shown' }, { text: W98.devices ? 'Virtual inventory' : 'Device model unavailable' }]);
      }
      function menuDef() {
        var d = current();
        return [
          { label: '&File', items: [{ label: '&Close', onclick: function () { win.close(); } }] },
          { label: '&View', items: [
            { label: 'View &by type', type: 'radio', checked: view === 'type', onclick: function () { view = 'type'; regSet('View', view); expanded = {}; treeSig = ''; render(); } },
            { label: 'View by &connection', type: 'radio', checked: view === 'connection', onclick: function () { view = 'connection'; regSet('View', view); expanded = {}; treeSig = ''; render(); } },
            { label: 'View by &resources', type: 'radio', checked: view === 'resources', onclick: function () { view = 'resources'; regSet('View', view); expanded = {}; treeSig = ''; render(); } },
            { type: 'sep' }, { label: 'Show &hidden devices', type: 'check', checked: showHidden, onclick: showHiddenToggle },
            { type: 'sep' }, { label: '&Refresh', accel: 'F5', onclick: refreshModel }
          ] },
          { label: '&Action', items: [
            { label: '&Properties', disabled: !d, onclick: properties }, { label: 'Enable', disabled: !d || d.id === 'ROOT\\COMPUTER' || d.enabled !== false, onclick: function () { toggle(true); } },
            { label: 'Disable', disabled: !d || d.id === 'ROOT\\COMPUTER' || d.enabled === false, onclick: function () { toggle(false); } }, { label: '&Remove', disabled: !d || d.id === 'ROOT\\COMPUTER', onclick: remove },
            { label: 'Update &Driver...', disabled: !d || d.id === 'ROOT\\COMPUTER', onclick: updateDriver }, { type: 'sep' }, { label: 'Simulate &Resource Conflict', disabled: !d || d.id === 'ROOT\\COMPUTER', onclick: createConflict }, { label: '&Resolve Resource Conflict', disabled: !d || d.id === 'ROOT\\COMPUTER' || !isWarn(d), onclick: resolveConflict },
            { type: 'sep' }, { label: 'Scan for hardware changes', onclick: scan }
          ] },
          { label: '&Help', items: [{ label: '&Device Manager Help', onclick: function () { W98.dialog.alert('Device Manager Help', 'Device Manager lists the deterministic virtual hardware exposed by this Windows 98 image.\n\nYellow warning icons indicate simulated conflicts or missing drivers. Browser hardware is never modified.', 'info'); } }, { type: 'sep' }, { label: '&About Device Manager...', onclick: function () { W98.aboutDialog('devmgr'); } }] }
        ];
      }
      win.setMenu(menuDef());
      win.claimKeys();
      win.el.addEventListener('keydown', function (e) { if (!e) return; if (e.key === 'F5') { e.preventDefault(); scan(); } });
      if (model() && typeof model().on === 'function') {
        unsub = safe(function () { return model().on('change', function () { if (!closed) { treeSig = ''; render(); } }); }, null);
      } else if (model() && typeof model().subscribe === 'function') {
        unsub = safe(function () { return model().subscribe(function () { if (!closed) { treeSig = ''; render(); } }); }, null);
      }
      render();
      return { onClose: function () { closed = true; if (typeof unsub === 'function') safe(function () { unsub(); }, null); } };
    }
  });
}());
