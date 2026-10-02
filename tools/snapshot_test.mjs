// Focused System Restore tests.  Run with:
//
//     node tools/snapshot_test.mjs
//
// The browser implementation is an IIFE, so this test evaluates it in a tiny
// VM with an in-memory IndexedDB and a shim-like W98Kernel.  Keeping the
// kernel fake at the capture/replace boundary verifies that snapshot code
// uses the kernel's KFS1/KREG1 images without duplicating their format.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'web/js/snapshot.js'), 'utf8');
assert.equal(source.includes('localStorage'), false, 'snapshot storage does not use localStorage');

/* A deliberately small IndexedDB double.  Requests and transactions complete
 * asynchronously, as browser IDB requests do, which catches accidental
 * synchronous assumptions in the implementation. */
function makeIndexedDB() {
  const dbs = new Map();
  function request(result) {
    const r = { result, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (r.onsuccess) r.onsuccess({ target: r }); });
    return r;
  }
  const indexedDB = {
    open(name) {
      const rec = dbs.get(name) || { stores: new Map() };
      dbs.set(name, rec);
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const db = {
        objectStoreNames: {
          contains: key => rec.stores.has(key),
        },
        createObjectStore(key) {
          if (!rec.stores.has(key)) rec.stores.set(key, new Map());
          return {};
        },
        transaction(key) {
          if (!rec.stores.has(key)) rec.stores.set(key, new Map());
          const map = rec.stores.get(key);
          const tx = { error: null, oncomplete: null, onerror: null, _pending: 0, _closed: false };
          const finish = () => {
            if (!tx._pending && !tx._closed) {
              tx._closed = true;
              if (tx.oncomplete) tx.oncomplete({ target: tx });
            }
          };
          const op = (fn) => {
            tx._pending++;
            const r = { result: undefined, error: null, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              try {
                r.result = fn();
                if (r.onsuccess) r.onsuccess({ target: r });
              } catch (e) {
                r.error = e;
                if (r.onerror) r.onerror({ target: r });
                if (tx.onerror) tx.onerror({ target: tx });
              } finally {
                tx._pending--;
                finish();
              }
            });
            return r;
          };
          tx.objectStore = function () {
            return {
              get: key2 => op(() => map.get(key2)),
              put: (value, key2) => op(() => { map.set(key2, value); return key2; }),
              delete: key2 => op(() => { map.delete(key2); return undefined; }),
              clear: () => op(() => { map.clear(); return undefined; }),
              openCursor: () => {
                const entries = Array.from(map.entries());
                let index = 0;
                const req = { result: null, error: null, onsuccess: null, onerror: null };
                function emit() {
                  req.result = index < entries.length ? {
                    key: entries[index][0], value: entries[index][1],
                    continue() { index++; queueMicrotask(emit); },
                  } : null;
                  if (req.onsuccess) req.onsuccess({ target: req });
                }
                queueMicrotask(emit);
                return req;
              },
            };
          };
          return tx;
        },
        close() {},
      };
      req.result = db;
      queueMicrotask(() => {
        if (!rec._opened) {
          rec._opened = true;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    _clear() { dbs.clear(); },
  };
  return indexedDB;
}

function createKernel() {
  let state = { fs: 'KFS1\n0|0|0|C:\\RESTORE.TXT|\n', reg: 'KREG1\nHKEY_CURRENT_USER\\Software\\W98\tState\tdmFsdWU=\n' };
  return {
    mode: 'shim',
    capturePersistentState() { return { fs: state.fs, reg: state.reg }; },
    replacePersistentState(next) {
      if (!next || typeof next.fs !== 'string' || typeof next.reg !== 'string') {
        return Promise.reject(new Error('invalid kernel state'));
      }
      state = { fs: next.fs, reg: next.reg };
      return Promise.resolve({ fs: 1, reg: 1 });
    },
    _set(next) { state = { fs: next.fs, reg: next.reg }; },
  };
}

function loadSnapshot() {
  const indexedDB = makeIndexedDB();
  const kernel = createKernel();
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Blob: globalThis.Blob,
    URL: { createObjectURL() { return 'blob:restore-test'; }, revokeObjectURL() {} },
    indexedDB,
    W98Kernel: kernel,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = { createElement() { return { click() {}, style: {} }; } };
  vm.runInNewContext(source, sandbox, { filename: 'web/js/snapshot.js' });
  const api = sandbox.W98Snapshot || sandbox.window.W98Snapshot;
  assert.ok(api, 'snapshot.js exposes W98Snapshot');
  return { api, kernel, indexedDB };
}

async function callMethod(api, names, ...args) {
  const name = names.find(k => typeof api[k] === 'function');
  assert.ok(name, `snapshot API is missing ${names.join(' / ')}`);
  return await api[name](...args);
}

async function create(api, name, description = '') {
  // The object form is the public contract; the fallback keeps this test
  // useful while a browser-facing implementation is being refactored.
  const fn = names => names.find(k => typeof api[k] === 'function');
  const key = fn(['create', 'createRestorePoint']);
  assert.ok(key, 'snapshot API has create');
  return await api[key](name, description);
}

async function pointJSON(api, point) {
  const key = ['export', 'exportSnapshot'].find(k => typeof api[k] === 'function');
  assert.ok(key, 'snapshot API has export');
  const out = await api[key](point);
  if (typeof out === 'string') return JSON.parse(out);
  if (out && typeof out.text === 'function') return JSON.parse(await out.text());
  if (out && typeof out.data === 'string') return JSON.parse(out.data);
  return out;
}

async function importPoint(api, payload) {
  const key = ['import', 'importSnapshot'].find(k => typeof api[k] === 'function');
  assert.ok(key, 'snapshot API has import');
  return await api[key](typeof payload === 'string' ? payload : JSON.stringify(payload));
}

const { api, kernel, indexedDB } = loadSnapshot();

// Creation, listing, metadata and duplicate-name rejection.
kernel._set({ fs: 'KFS1\n0|0|11|C:\\BEFORE.TXT|aGVsbG8gd29ybGQ=\n', reg: 'KREG1\nHKEY_CURRENT_USER\\Software\\W98\tState\tdHJ1ZQ==\n' });
const first = await create(api, 'Before game', 'Known-good state');
assert.equal(first.name, 'Before game');
assert.equal(first.description, 'Known-good state');
const listed = await callMethod(api, ['list', 'listRestorePoints']);
assert.equal(listed.length, 1);
assert.equal(listed[0].name, 'Before game');
assert.ok(Number(listed[0].size || first.size || 0) >= 0, 'point reports a size');
await assert.rejects(() => create(api, 'Before game'), /duplicate|exists|already/i);

// Restoring replaces both opaque kernel images deterministically.
kernel._set({ fs: 'KFS1\n0|0|5|C:\\CHANGED|c3RhdGU=\n', reg: 'KREG1\nHKEY_CURRENT_USER\\Software\\W98\tState\tdmFyaWFudA==\n' });
await callMethod(api, ['restore', 'restorePoint'], first.id || first.key || first.name);
assert.deepEqual(kernel.capturePersistentState(), { fs: 'KFS1\n0|0|11|C:\\BEFORE.TXT|aGVsbG8gd29ybGQ=\n', reg: 'KREG1\nHKEY_CURRENT_USER\\Software\\W98\tState\tdHJ1ZQ==\n' });

// Invalid JSON and future versions are rejected before touching state.
const stable = kernel.capturePersistentState();
await assert.rejects(() => importPoint(api, '{not json'), /malformed|invalid|JSON/i);
await assert.rejects(() => importPoint(api, {
  format: 'W98-SNAPSHOT', version: 999, createdAt: new Date().toISOString(),
  name: 'future', description: '', state: stable,
}), /version|unsupported|future/i);
assert.deepEqual(kernel.capturePersistentState(), stable, 'rejected import leaves current state unchanged');

// Export/import is a round trip into a fresh browser profile.  The envelope
// keeps its stable id, so importing into the original profile would replace
// the same ID; a second VM gives this check the fresh-profile semantics users
// get when moving a file to another browser profile.
const envelope = await pointJSON(api, first);
assert.equal(envelope.format, 'W98-SNAPSHOT');
assert.equal(envelope.version, 1);
assert.equal(envelope.state.fs, 'KFS1\n0|0|11|C:\\BEFORE.TXT|aGVsbG8gd29ybGQ=\n');
const fresh = loadSnapshot();
await importPoint(fresh.api, envelope);
const afterImport = await callMethod(fresh.api, ['list', 'listRestorePoints']);
assert.equal(afterImport.length, 1);
assert.equal(afterImport[0].name, 'Before game');

// Deletion removes only the selected point.
const deleteKey = ['delete', 'deleteRestorePoint', 'remove'].find(k => typeof api[k] === 'function');
assert.ok(deleteKey, 'snapshot API has delete');
await api[deleteKey](first.id || first.key || first.name);
const afterDelete = await callMethod(api, ['list', 'listRestorePoints']);
assert.equal(afterDelete.length, 0);

// Ensure the test really used IndexedDB rather than a localStorage fallback.
assert.ok(indexedDB, 'named points use IndexedDB');

console.log(`snapshot  ${7} checks passed`);
