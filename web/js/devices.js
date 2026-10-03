/* ============================================================================
   devices.js — deterministic virtual hardware model for Device Manager
   ----------------------------------------------------------------------------
   This is deliberately a small model rather than a claim that browser hardware
   has been changed.  Every entry is a W98-modeled device.  When the optional
   W98HV surface is present the Hyper-V entries are annotated with its status;
   otherwise they continue to work as virtual fixtures.

   State is kept in the kernel registry below
   HKEY_LOCAL_MACHINE\System\CurrentControlSet\Enum.  The model is loaded
   before the kernel is ready without writing defaults, so restoring W98.reg
   cannot be overwritten by the early boot queue.  Defaults are persisted on
   the w98-kernel-ready event and every user operation writes through W98.reg.
   ========================================================================== */
(function (global) {
  'use strict';

  var W98 = global.W98 || (global.W98 = {});
  var REG_BASE = 'HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Enum';
  var META_KEY = REG_BASE + '\\_W98DeviceModel';
  var MODEL_VERSION = 1;
  var listeners = { change: [], ready: [], rescan: [], conflict: [] };
  var devices = [];
  var byId = {};
  var conflicts = [];
  var generation = 0;
  var ready = false;
  var seeded = false;
  var hvAvailable = false;

  function copy(v) {
    if (v == null || typeof v !== 'object') return v;
    if (Object.prototype.toString.call(v) === '[object Array]') return v.map(copy);
    var out = {}, k;
    for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = copy(v[k]);
    return out;
  }

  function regGet(path, name, dflt) {
    try {
      if (W98.reg && typeof W98.reg.get === 'function') return W98.reg.get(path, name, dflt);
    } catch (e) { /* registry is best effort */ }
    return dflt;
  }
  function regSet(path, name, value) {
    try { if (W98.reg && typeof W98.reg.set === 'function') W98.reg.set(path, name, value); }
    catch (e) { /* registry is best effort */ }
  }
  function parseBool(v, dflt) {
    if (v == null || v === '') return !!dflt;
    return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
  }
  function parseJson(v, dflt) {
    if (v == null || v === '') return dflt;
    try { return JSON.parse(v); } catch (e) { return dflt; }
  }
  function keyFor(id) { return REG_BASE + '\\' + id; }

  /* The order here is the order displayed by a fresh Windows 98 installation. */
  var DEFAULTS = [
    {
      id: 'ROOT\\COMPUTER', hardwareId: 'ROOT\\COMPUTER', friendlyName: 'Computer',
      class: 'Computer', driverVersion: 'W98 Core 1.0', parent: null,
      resources: [], virtual: true
    },
    {
      id: 'ACPI\\PNP0100', hardwareId: 'ACPI\\PNP0100', friendlyName: 'System timer',
      class: 'System devices', driverVersion: 'W98 Core 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '0' }], virtual: true
    },
    {
      id: 'W98\\KERNEL', hardwareId: 'W98\\KERNEL', friendlyName: 'WebAssembly kernel',
      class: 'System devices', driverVersion: 'W98 Kernel 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'Memory', value: '0x00020000-0x0002FFFF' }], virtual: true
    },
    {
      id: 'W98\\DISPLAY0', hardwareId: 'W98\\DISPLAY0', friendlyName: 'Virtual display adapter',
      class: 'Display adapters', driverVersion: 'W98 Display 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'Memory', value: '0x00010000-0x0001FFFF' }], virtual: true
    },
    {
      id: 'W98\\KBD0', hardwareId: 'W98\\KBD0', friendlyName: 'Virtual keyboard',
      class: 'Keyboard', driverVersion: 'W98 Input 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '1' }, { type: 'I/O', value: '0x0060-0x0064' }], virtual: true
    },
    {
      id: 'W98\\MOUSE0', hardwareId: 'W98\\MOUSE0', friendlyName: 'Virtual mouse',
      class: 'Mouse', driverVersion: 'W98 Input 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '12' }, { type: 'I/O', value: '0x0060-0x0064' }], virtual: true
    },
    {
      id: 'W98\\DISK0', hardwareId: 'W98\\DISK0', friendlyName: 'Virtual hard disk',
      class: 'Disk drives', driverVersion: 'W98 Storage 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'I/O', value: '0x01F0-0x01F7' }, { type: 'IRQ', value: '14' }], virtual: true
    },
    {
      id: 'W98\\FLOPPY0', hardwareId: 'W98\\FLOPPY0', friendlyName: 'Virtual floppy drive',
      class: 'Floppy disk controllers', driverVersion: 'W98 Storage 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'I/O', value: '0x03F0-0x03F7' }, { type: 'IRQ', value: '6' }], virtual: true
    },
    {
      id: 'W98\\CDROM0', hardwareId: 'W98\\CDROM0', friendlyName: 'Virtual CD-ROM',
      class: 'CDROM', driverVersion: 'W98 Storage 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'I/O', value: '0x0170-0x0177' }, { type: 'IRQ', value: '15' }], virtual: true
    },
    {
      id: 'W98\\SOUND0', hardwareId: 'W98\\SOUND0', friendlyName: 'Virtual sound card',
      class: 'Sound, video and game controllers', driverVersion: 'W98 Audio 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '5' }, { type: 'DMA', value: '1' }, { type: 'I/O', value: '0x0220-0x022F' }], virtual: true
    },
    {
      id: 'W98\\MODEM0', hardwareId: 'W98\\MODEM0', friendlyName: 'Virtual modem',
      class: 'Modems', driverVersion: '', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '3' }, { type: 'I/O', value: '0x02F8-0x02FF' }],
      virtual: true, driverMissing: true, problemCode: 28
    },
    {
      id: 'W98\\NET0', hardwareId: 'W98\\NET0', friendlyName: 'Virtual network adapter',
      class: 'Network adapters', driverVersion: 'W98 Network 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'IRQ', value: '10' }, { type: 'I/O', value: '0x0300-0x031F' }], virtual: true
    },
    {
      id: 'VMBUS\\ROOT', hardwareId: 'VMBUS\\ROOT', friendlyName: 'Hyper-V synthetic bus',
      class: 'System devices', driverVersion: 'W98HV 1.0', parent: 'ROOT\\COMPUTER',
      resources: [{ type: 'Memory', value: '0x0000E000-0x0000EFFF' }], virtual: true, hvBacked: true
    },
    {
      id: 'VMBUS\\HEARTBEAT', hardwareId: 'VMBUS\\HEARTBEAT', friendlyName: 'Guest heartbeat device',
      class: 'System devices', driverVersion: 'W98HV 1.0', parent: 'VMBUS\\ROOT',
      resources: [{ type: 'IRQ', value: '11' }], virtual: true, hvBacked: true
    }
  ];

  function makeDevice(d) {
    var x = copy(d);
    x.name = x.friendlyName;
    x.displayName = x.friendlyName;
    x.type = x.class;
    x.present = true;
    x.removed = false;
    x.hidden = false;
    x.enabled = true;
    x.pnpState = 'PNP_STARTED';
    x.powerState = 'D0';
    x.openHandles = 0;
    x.status = 'OK';
    x.problem = '';
    x.problemCode = x.problemCode == null ? null : x.problemCode;
    x.conflictId = null;
    x.source = x.hvBacked ? 'hypervisor/virtual' : 'modeled-virtual';
    x.availability = 'modeled';
    /* `physical` describes this record; physicalAvailability describes what
       the browser can expose.  Keeping the two separate lets the UI say
       "modeled virtual device" without implying that a host device was
       enumerated or changed. */
    x.physical = 'modeled';
    x.physicalAvailability = 'unavailable';
    x.physicalStatus = 'unavailable';
    x.driverMissing = !!x.driverMissing;
    return x;
  }

  function rebuildIndex() {
    byId = {};
    devices.forEach(function (d) { byId[d.id] = d; });
  }

  function hvState() {
    var h = global.W98HV || (W98 && W98.hv);
    if (!h) return false;
    try {
      if (h.mode === 'wasm') return true;
      if (typeof h.info === 'function') {
        var i = h.info();
        return !!(i && (i.mode === 'wasm' || i.partitions !== undefined && i.version));
      }
    } catch (e) { /* unavailable surface */ }
    return false;
  }

  function updateHvAnnotations() {
    hvAvailable = hvState();
    devices.forEach(function (d) {
      if (!d.hvBacked) return;
      d.hvAvailable = hvAvailable;
      d.availability = 'modeled';
      d.notes = hvAvailable ? 'Backed by the W98HV hypervisor surface.' :
        'W98HV is unavailable; this virtual fixture remains inspectable.';
    });
  }

  function activeConflictFor(id) {
    for (var i = 0; i < conflicts.length; i++) {
      var c = conflicts[i];
      if (!c.resolved && (c.a === id || c.b === id)) return c;
    }
    return null;
  }

  function recalc(d) {
    var c = activeConflictFor(d.id);
    d.conflictId = c ? c.id : null;
    if (!d.present || d.removed) {
      d.pnpState = 'PNP_REMOVED'; d.powerState = 'D3';
    } else if (d.pnpState === 'PNP_QUERY_REMOVE') {
      d.powerState = 'D3';
    } else {
      d.pnpState = 'PNP_STARTED'; d.powerState = d.enabled ? 'D0' : 'D3';
    }
    if (!d.present || d.removed) {
      d.status = 'Removed'; d.problem = 'Device was removed; scan for hardware changes to restore it.';
      return;
    }
    if (!d.enabled) {
      d.status = 'Disabled'; d.problem = 'This device has been disabled.';
      return;
    }
    if (d.driverMissing || !d.driverVersion) {
      d.status = 'Missing driver'; d.problemCode = d.problemCode || 28;
      d.problem = 'No driver is installed for this device.';
      return;
    }
    if (c) {
      d.status = 'Conflict'; d.problemCode = 12;
      d.problem = 'Resources conflict with ' + (byId[c.a === d.id ? c.b : c.a] || {}).friendlyName + '.';
      return;
    }
    if (d.problemCode === 12 || d.problemCode === 28) d.problemCode = null;
    d.status = 'OK'; d.problem = '';
  }

  function recalcAll() { devices.forEach(recalc); }

  function restoreDevice(d) {
    var key = keyFor(d.id), v;
    v = regGet(key, 'FriendlyName', null); if (v != null && v !== '') d.friendlyName = d.name = d.displayName = String(v);
    v = regGet(key, 'HardwareID', null); if (v != null && v !== '') d.hardwareId = String(v);
    v = regGet(key, 'Class', null); if (v != null && v !== '') d.class = String(v);
    v = regGet(key, 'DriverVersion', null); if (v != null) d.driverVersion = String(v);
    v = regGet(key, 'DriverMissing', null); if (v != null) d.driverMissing = parseBool(v, d.driverMissing);
    v = regGet(key, 'Enabled', null); if (v != null) d.enabled = parseBool(v, d.enabled);
    v = regGet(key, 'PnpState', null); if (v != null && v !== '') d.pnpState = String(v);
    v = regGet(key, 'PowerState', null); if (v != null && v !== '') d.powerState = String(v);
    v = regGet(key, 'OpenHandles', null); if (v != null) d.openHandles = Math.max(0, parseInt(v, 10) || 0);
    v = regGet(key, 'Present', null); if (v != null) d.present = parseBool(v, d.present);
    v = regGet(key, 'Removed', null); if (v != null) d.removed = parseBool(v, d.removed);
    v = regGet(key, 'Hidden', null); if (v != null) d.hidden = parseBool(v, d.hidden);
    v = regGet(key, 'Parent', null); if (v != null) d.parent = String(v) || null;
    v = regGet(key, 'ProblemCode', null); if (v != null && v !== '') d.problemCode = parseInt(v, 10) || null;
    v = parseJson(regGet(key, 'Resources', null), null); if (v && Object.prototype.toString.call(v) === '[object Array]') d.resources = v;
    v = regGet(key, 'Source', null); if (v != null && v !== '') d.source = String(v);
    v = regGet(key, 'Virtual', null); if (v != null) d.virtual = parseBool(v, d.virtual);
    if (d.removed) d.present = false;
  }

  function load() {
    devices = DEFAULTS.map(makeDevice);
    devices.forEach(restoreDevice);
    /* Keep a compact hive-level snapshot as a restore fallback.  Some kernel
       builds can restore the parent Enum hive before all nested instance keys
       are queryable; the snapshot preserves the same bounded state without
       changing the public registry layout. */
    var saved = parseJson(regGet(META_KEY, 'State', ''), null);
    if (Object.prototype.toString.call(saved) === '[object Array]') {
      saved.forEach(function (s) {
        if (!s || !s.id) return;
        var d = null, i;
        for (i = 0; i < devices.length; i++) if (devices[i].id === s.id) { d = devices[i]; break; }
        if (!d) return;
        if (s.hardwareId != null) d.hardwareId = String(s.hardwareId);
        if (s.friendlyName != null) d.friendlyName = d.name = d.displayName = String(s.friendlyName);
        if (s.class != null) d.class = String(s.class);
        if (s.driverVersion != null) d.driverVersion = String(s.driverVersion);
        if (s.driverMissing != null) d.driverMissing = !!s.driverMissing;
        if (s.enabled != null) d.enabled = !!s.enabled;
        if (s.pnpState != null) d.pnpState = String(s.pnpState);
        if (s.powerState != null) d.powerState = String(s.powerState);
        if (s.openHandles != null) d.openHandles = Math.max(0, parseInt(s.openHandles, 10) || 0);
        if (s.present != null) d.present = !!s.present;
        if (s.removed != null) d.removed = !!s.removed;
        if (s.hidden != null) d.hidden = !!s.hidden;
        if (s.parent != null) d.parent = String(s.parent) || null;
        if (s.problemCode != null) d.problemCode = s.problemCode === '' ? null : (parseInt(s.problemCode, 10) || null);
        if (Object.prototype.toString.call(s.resources) === '[object Array]') d.resources = copy(s.resources);
        if (s.source != null) d.source = String(s.source);
        if (s.virtual != null) d.virtual = !!s.virtual;
      });
    }
    generation = parseInt(regGet(META_KEY, 'Generation', '0'), 10) || 0;
    var old = parseJson(regGet(META_KEY, 'Conflicts', ''), []);
    conflicts = Object.prototype.toString.call(old) === '[object Array]' ? old : [];
    conflicts = conflicts.filter(function (c) { return c && c.id && c.a && c.b; });
    rebuildIndex();
    updateHvAnnotations();
    recalcAll();
  }

  function persistDevice(d) {
    var key = keyFor(d.id);
    regSet(key, 'HardwareID', d.hardwareId);
    regSet(key, 'FriendlyName', d.friendlyName);
    regSet(key, 'Class', d.class);
    regSet(key, 'DriverVersion', d.driverVersion || '');
    regSet(key, 'DriverMissing', d.driverMissing ? '1' : '0');
    regSet(key, 'Status', d.status);
    regSet(key, 'Enabled', d.enabled ? '1' : '0');
    regSet(key, 'PnpState', d.pnpState || 'PNP_STARTED');
    regSet(key, 'PowerState', d.powerState || (d.enabled ? 'D0' : 'D3'));
    regSet(key, 'OpenHandles', String(Math.max(0, d.openHandles || 0)));
    regSet(key, 'Present', d.present ? '1' : '0');
    regSet(key, 'Removed', d.removed ? '1' : '0');
    regSet(key, 'Hidden', d.hidden ? '1' : '0');
    regSet(key, 'Virtual', d.virtual ? '1' : '0');
    regSet(key, 'Source', d.source || 'modeled-virtual');
    regSet(key, 'PhysicalHardware', 'unavailable');
    regSet(key, 'Resources', JSON.stringify(d.resources || []));
    regSet(key, 'Parent', d.parent || '');
    regSet(key, 'ProblemCode', d.problemCode == null ? '' : String(d.problemCode));
  }
  function stateSnapshot() {
    return devices.map(function (d) {
      return {
        id: d.id, hardwareId: d.hardwareId, friendlyName: d.friendlyName, class: d.class,
        driverVersion: d.driverVersion || '', driverMissing: !!d.driverMissing,
        enabled: !!d.enabled, pnpState: d.pnpState || 'PNP_STARTED',
        powerState: d.powerState || (d.enabled ? 'D0' : 'D3'), openHandles: Math.max(0, d.openHandles || 0),
        present: !!d.present, removed: !!d.removed, hidden: !!d.hidden,
        parent: d.parent || '', problemCode: d.problemCode == null ? '' : d.problemCode,
        resources: copy(d.resources || []), source: d.source || 'modeled-virtual', virtual: !!d.virtual
      };
    });
  }
  function persistAll() {
    regSet(META_KEY, 'ModelVersion', String(MODEL_VERSION));
    regSet(META_KEY, 'Generation', String(generation));
    regSet(META_KEY, 'PhysicalHardwareAvailable', '0');
    regSet(META_KEY, 'Conflicts', JSON.stringify(conflicts));
    regSet(META_KEY, 'State', JSON.stringify(stateSnapshot()));
    devices.forEach(persistDevice);
    seeded = true;
  }

  function emit(type, extra) {
    var ev = { type: type, generation: generation };
    var k;
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) ev[k] = extra[k];
    (listeners[type] || []).slice().forEach(function (fn) { try { fn(copy(ev)); } catch (e) { /* observer errors do not break model */ } });
    if (type !== 'change' && listeners.change) listeners.change.slice().forEach(function (fn) { try { fn(copy(ev)); } catch (e2) {} });
  }

  function find(id) { return byId[String(id)] || null; }
  function list(opts) {
    opts = opts || {};
    updateHvAnnotations();
    return devices.filter(function (d) {
      /* Removed records are hidden from the normal view, but the Device
         Manager's Show hidden devices switch (showHidden) reveals them. */
      if (!opts.showHidden && opts.includeRemoved !== true && (!d.present || d.removed)) return false;
      if (!opts.showHidden && d.hidden) return false;
      if (opts.class && d.class !== opts.class) return false;
      return true;
    }).map(copy);
  }
  function tree(opts) {
    var all = list(opts), map = {}, roots = [];
    all.forEach(function (d) { d.children = []; map[d.id] = d; });
    all.forEach(function (d) {
      var p = d.parent && map[d.parent];
      if (p) p.children.push(d); else roots.push(d);
    });
    return roots;
  }
  function touch(d, type) {
    recalc(d); generation++;
    persistDevice(d); regSet(META_KEY, 'Generation', String(generation));
    regSet(META_KEY, 'Conflicts', JSON.stringify(conflicts));
    regSet(META_KEY, 'State', JSON.stringify(stateSnapshot()));
    emit(type || 'change', { deviceId: d.id, device: copy(d) });
    return copy(d);
  }

  function setEnabled(id, value) {
    var d = find(id); if (!d || !d.present || d.removed || d.id === 'ROOT\\COMPUTER') return false;
    d.enabled = !!value; return touch(d, d.enabled ? 'enable' : 'disable');
  }
  function openVirtualHandle(id) {
    var d = find(id);
    if (!d || !d.present || d.removed || !d.enabled || d.pnpState === 'PNP_QUERY_REMOVE') return false;
    d.openHandles = Math.max(0, d.openHandles || 0) + 1;
    return touch(d, 'open-handle');
  }
  function closeVirtualHandle(id) {
    var d = find(id);
    if (!d || !d.openHandles) return false;
    d.openHandles--;
    return touch(d, 'close-handle');
  }
  function queryRemove(id) {
    var d = find(id);
    if (!d || d.id === 'ROOT\\COMPUTER') return { ok: false, reason: 'invalid-device' };
    if (!d.present || d.removed) return { ok: false, reason: 'already-removed', status: 'DELETE_PENDING' };
    if (d.openHandles) return { ok: false, reason: 'open-handles', status: 'DEVICE_BUSY', openHandles: d.openHandles };
    d.pnpState = 'PNP_QUERY_REMOVE'; d.powerState = 'D3';
    var out = touch(d, 'query-remove'); out.ok = true; return out;
  }
  function cancelQueryRemove(id) {
    var d = find(id);
    if (!d || d.pnpState !== 'PNP_QUERY_REMOVE') return false;
    d.pnpState = 'PNP_STARTED'; d.powerState = d.enabled ? 'D0' : 'D3';
    return touch(d, 'cancel-remove');
  }
  function remove(id) {
    var d = find(id); if (!d || d.id === 'ROOT\\COMPUTER') return false;
    var q = d.pnpState === 'PNP_QUERY_REMOVE' ? { ok: true } : queryRemove(id);
    if (!q || q.ok !== true) return false;
    d = find(id);
    d.enabled = false; d.present = false; d.removed = true;
    conflicts.slice().forEach(function (c) { if (!c.resolved && (c.a === d.id || c.b === d.id)) resolveConflict(c.id, true); });
    return touch(d, 'remove');
  }
  function rescan() {
    generation++;
    devices.forEach(function (d) {
      if (d.removed || !d.present) { d.removed = false; d.present = true; d.enabled = true; }
      d.pnpState = 'PNP_ADDED'; d.powerState = 'D3';
      recalc(d); persistDevice(d);
    });
    persistAll(); emit('rescan', { devices: list({ showHidden: true }) });
    return list({ showHidden: true });
  }
  function updateDriver(id, version) {
    var d = find(id); if (!d || d.id === 'ROOT\\COMPUTER') return false;
    d.driverMissing = false; d.driverVersion = String(version || 'W98 Virtual Driver 1.0');
    return touch(d, 'driver');
  }

  function createConflict(aId, bId, resourceType, resourceValue) {
    var a = find(aId), b = find(bId);
    if (!a || !b || a.id === b.id) return false;
    var existing = activeConflictFor(a.id);
    if (existing && (existing.a === b.id || existing.b === b.id)) return copy(existing);
    resourceType = String(resourceType || 'IRQ');
    var ar = (a.resources || []).filter(function (r) { return String(r.type).toLowerCase() === resourceType.toLowerCase(); })[0];
    resourceValue = String(resourceValue || (ar && ar.value) || '5');
    /* Keep the fixture identifier stable across reloads. */
    var pair = [a.id, b.id].sort().join('-').replace(/[^A-Za-z0-9_-]/g, '_');
    var id = 'CONFLICT-' + pair + '-' + resourceType.toUpperCase();
    var c = { id: id, a: a.id, b: b.id, resource: { type: resourceType, value: resourceValue },
      before: { a: copy(a.resources), b: copy(b.resources) }, resolved: false };
    b.resources = (b.resources || []).filter(function (r) {
      return !(String(r.type).toLowerCase() === resourceType.toLowerCase());
    });
    b.resources.push({ type: resourceType, value: resourceValue });
    /* A resolved fixture can be recreated with the same stable id. */
    conflicts = conflicts.filter(function (old) { return old.id !== id || !old.resolved; });
    conflicts.push(c); recalcAll(); generation++;
    persistAll(); emit('conflict', { conflict: copy(c), deviceId: b.id });
    return copy(c);
  }
  function resolveConflict(id, silent) {
    var c = null, i;
    for (i = 0; i < conflicts.length; i++) if (conflicts[i].id === id) { c = conflicts[i]; break; }
    /* Accept a device id as a convenience for Properties/Resources pages. */
    if (!c) for (i = 0; i < conflicts.length; i++) {
      if (!conflicts[i].resolved && (conflicts[i].a === id || conflicts[i].b === id)) { c = conflicts[i]; break; }
    }
    if (!c || c.resolved) return false;
    if (c.before) {
      if (find(c.a)) find(c.a).resources = copy(c.before.a);
      if (find(c.b)) find(c.b).resources = copy(c.before.b);
    }
    c.resolved = true; recalcAll(); generation++;
    persistAll();
    if (!silent) emit('conflict', { conflict: copy(c), resolved: true });
    return copy(c);
  }
  function conflictList() { return conflicts.filter(function (c) { return !c.resolved; }).map(copy); }

  var api = {
    REGISTRY_PATH: REG_BASE,
    modelVersion: MODEL_VERSION,
    list: list,
    getDevices: list,
    get: function (id) { var d = find(id); return d ? copy(d) : null; },
    tree: tree,
    snapshot: function () { return { modelVersion: MODEL_VERSION, generation: generation, hvAvailable: hvAvailable, devices: list({ showHidden: true }), conflicts: conflictList() }; },
    physicalInfo: function () { return { physicalHardwareAvailable: false, description: 'Browser hardware is unavailable to this virtual machine. The entries below are modeled virtual devices.', hypervisorAvailable: hvAvailable }; },
    setEnabled: setEnabled,
    setDeviceEnabled: setEnabled,
    disable: function (id) { return setEnabled(id, false); },
    enable: function (id) { return setEnabled(id, true); },
    remove: remove,
    removeDevice: remove,
    rescan: rescan,
    scan: rescan,
    scanHardwareChanges: rescan,
    updateDriver: updateDriver,
    updateDeviceDriver: updateDriver,
    createConflict: createConflict,
    simulateConflict: createConflict,
    makeConflict: createConflict,
    resolveConflict: resolveConflict,
    clearConflict: resolveConflict,
    openVirtualHandle: openVirtualHandle,
    closeVirtualHandle: closeVirtualHandle,
    queryRemove: queryRemove,
    cancelQueryRemove: cancelQueryRemove,
    conflicts: conflictList,
    on: function (type, fn) {
      if (typeof type === 'function') { fn = type; type = 'change'; }
      if (typeof fn !== 'function') return function () {};
      type = listeners[type] ? type : 'change'; listeners[type].push(fn);
      return function () { var i = listeners[type].indexOf(fn); if (i >= 0) listeners[type].splice(i, 1); };
    },
    subscribe: function (fn) { return api.on('change', fn); },
    load: function () { load(); return api.snapshot(); },
    persist: persistAll,
    get generation() { return generation; },
    get hvAvailable() { return hvAvailable; },
    get initialized() { return seeded; }
  };

  load();
  W98.devices = api;
  W98.deviceModel = api;

  /* Kernel restore happens after scripts have loaded.  Reload the registry
     before seeding defaults, then publish one ready event for Device Manager. */
  function onKernelReady(event) {
    load();
    if (!seeded) persistAll();
    ready = true;
    emit('ready', { mode: event && event.detail && event.detail.mode || 'unknown' });
  }
  if (global.addEventListener) global.addEventListener('w98-kernel-ready', onKernelReady);
  else onKernelReady();
  if (global.addEventListener) global.addEventListener('w98-hv-ready', function () {
    updateHvAnnotations();
    emit('change', { hypervisor: hvAvailable });
  });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
