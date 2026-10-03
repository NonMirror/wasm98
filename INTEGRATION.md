# Boot and recovery integration

This change adds the stateful boot profile model (`web/js/boot-profile.js`) and
the Win98 recovery utility (`web/js/apps/recovery.js`).  The feature is kept at
the application boundary: recovery actions update the boot-profile/registry
state and never call desktop, taskbar, or window-manager internals.  The
integration worktree is responsible for letting `desk.js` consume that state
when it builds its startup sequence.

## Script order

`W98` is created by `shell.js`, so the profile model must load after `shell.js`
and before `recovery.js`.  The recovery app must load before `desk.js`, because
`desk.js` builds its Start menu and desktop icons after every app has registered.
The existing kernel, icon, shell, and Hyper-V scripts stay ahead of both new
scripts.  A complete order is:

```html
<script src="js/kernel.js"></script>
<script src="js/icons.js"></script>
<script src="js/shell.js"></script>
<script src="js/hv.js"></script>
<script src="js/boot-profile.js"></script>
<!-- existing applications, including notepad.js and cmd.js -->
<script src="js/apps/recovery.js"></script>
<script src="js/desk.js"></script>
```

Do not load `boot-profile.js` as an ES module.  It is a classic script and
publishes `window.W98.bootProfile`.

## `desk.js` boot hook

The normal desktop path remains the default.  After `K.boot()` has restored
the kernel state, the integration should ask the profile model to run the
staged boot using the selected profile and the actual stages that `desk.js`
already performs.  Each stage is a small record with a stable `id`, a
human-readable `label`, and an observed status/detail (plus optional duration
and failure metadata).
The model records the result and returns a boot record, allowing the existing
boot screen to render the same text while the staged process is in progress.

The adapter is intentionally narrow.  Use the exported methods on
`W98.bootProfile` (rather than reading private fields) to:

* read the selected/next profiles, failure flag, simulations, and previous
  result (`getState()`/`state()`, `getSelectedProfile()`,
  `getNextProfile()`, and `lastBootResult()`);
* obtain the six profile definitions and canonical stage definitions
  (`listProfiles()`/`profiles()` and `listStages()`/`stages()`);
* execute the deterministic staged model (`runBoot(options)`; omit
  `options.profile` to use the persisted next/selected profile, and pass
  `options.simulations` for an integration-provided simulation set).  For
  real observations, pass `options.stages` or call
  `recordBoot(stages, options)`; matching stage IDs override the deterministic
  status while the model still persists one complete record;
* read the latest record and its text form (`getLastBootResult()` and
  `getBootLog()`); and
* persist the generated text to `C:\\WINDOWS\\BOOTLOG.TXT` or open it in
  Notepad (`persistBootLog()` and `openBootLog()`).

The integration should pass these stages in this order, preserving the IDs so
the recovery utility can explain a failure:

```js
[
  { id: 'kernel-initialization', label: 'Kernel initialization' },
  { id: 'filesystem-restore',    label: 'Filesystem restore' },
  { id: 'registry-restore',      label: 'Registry restore' },
  { id: 'display',     label: 'Display' },
  { id: 'input',       label: 'Input' },
  { id: 'sound',       label: 'Sound' },
  { id: 'networking',  label: 'Networking' },
  { id: 'hyperv-integration', label: 'Hyper-V integration' },
  { id: 'shell',       label: 'Shell' },
  { id: 'startup-programs', label: 'Startup programs' }
]
```

The current `runBoot` implementation records these ten stages deterministically
and applies the profile's skip policy and failure simulations.  It does not
touch shell internals.  A supplied stage observation has the shape
`{ id, status, detail, durationMs, failure }`; `recordBoot(stages, options)` is
the convenience form.  Preserve these IDs and the record shape when wiring
live startup promises.  Continue recording all stages after a failure when the
selected profile allows it.  If the live startup path stops at a fatal stage,
still submit entries for the remaining stages with `status: 'pending'` or
`status: 'skipped'` so the record remains inspectable.

The desk-side shape is therefore small and explicit:

```js
W98.bootProfile.load();
var profile = W98.bootProfile.consumeNextProfile();
var record = W98.bootProfile.runBoot({
  profile: profile.id,
  stages: observedStages // omit while using the deterministic model
});
if (record.success && profile.id !== 'safe-command') {
  W98.bootProfile.captureLastKnownGood();
}
```

`observedStages` is assembled by the integration around the existing startup
promises.  It should contain one entry for each canonical ID, even when the
stage was skipped by a selected profile.  The model writes the resulting
record and `BOOTLOG.TXT`; the existing boot screen can render its own progress
messages from those records without coupling the recovery utility to shell
DOM state.

Do not call `W98.shell`, inspect `W98.windows`, mutate the desktop DOM, or
launch recovery from inside an app's private window state.  If a profile needs
to start the command prompt, use the public `W98.launch('cmd', args)` path
through the profile/recovery adapter.

## Registry and persistence contract

The profile model owns its persistent keys under the
`HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\BootProfile` branch.
`desk.js` should not duplicate or shadow those values.  The selected profile
survives reload through `W98.reg`; the latest staged record and failed-startup
flag are likewise available through `state()` and `getLastBootResult()`.

On a successful normal boot, the model marks the record successful; the
integration should capture a versioned known-good subset with
`captureLastKnownGood()`.  Last Known Good is a versioned subset of registry
values, so desk integration must not replace it with a full registry snapshot
or write directly to the hive.  Recovery actions (`clearFailedStartup`,
`restoreLastKnownGood`, and `resetStartupPrograms`) are safe to call before the
desktop is ready and only change model-owned state.

## Recovery app expectations

`recovery.js` registers the `recovery` app and uses the public model adapter.
The app can be opened from Start or with `W98.launch('recovery')`; no desk
special case is required.  Its command-prompt action delegates to the public
`W98.launch('cmd', ...)` API.  Its log viewer may open the generated text in
Notepad with `W98.launch('notepad', { text, ... })` when the Notepad contract
supports a text argument, or display the same log inside the recovery window.
It must not reach through a window's parent nodes or call shell internals.

The adapter also exposes deterministic failure simulation.  The integration
should leave these simulations available for smoke testing and map the failed
stage/device/service names into the existing boot screen.  The supported
scenarios are:

* disabled virtual device;
* corrupted startup entry;
* failed local driver;
* simulated registry recovery; and
* interrupted restore.

Each failure should leave a clear failed-startup flag and guidance in the
latest boot record.  Clearing the flag or restoring Last Known Good should be
visible on the next `getState()` call and remain true after a page reload.

## Smoke checks

From the repository root, run syntax checks on both new scripts and the
existing browser scripts they depend on:

```sh
node --check web/js/boot-profile.js
node --check web/js/apps/recovery.js
node --check web/js/kernel.js
node --check web/js/shell.js
```

For a browser smoke pass, start the local server (`./run.sh`), reload once,
open **Start > Programs > Recovery**, and verify:

1. the selected profile shown by Recovery is unchanged after reload;
2. **Last boot result** and **View boot log** show the staged IDs in order;
3. selecting each failure simulation produces a failed stage, failed device or
   service guidance, and a persisted failed-startup flag;
4. **Clear failed startup**, **Reset startup programs**, and **Restore Last
   Known Good** update the displayed state without changing the shell directly;
5. **Command Prompt** opens the existing `cmd` application; and
6. a successful normal boot still reaches the unchanged desktop path.

The deterministic model can also be exercised without a browser by loading the
two scripts in a DOM harness that stubs `W98.reg`, `W98.fs`, and
`W98.registerApp`.  Feed the ten stage IDs above and assert the returned record
instead of relying on wall-clock timing.

## Merged kernel and Hyper-V compatibility

The recovery model does not parse or replace kernel snapshots.  Its profile,
record, Last Known Good subset, failure flag, and bounded `BOOTLOG.TXT` are
stored through `W98.reg` and `W98.fs`; the merged kernel persists `KREG3` and
continues to load `KREG1` and `KREG2`.  This keeps recovery actions from
bypassing the IndexedDB-backed kernel state.

When no live stage observation is supplied, the Hyper-V stage reads only the
documented `W98HV` surface (`mode`, `partitions()`, `guest()`, and `vmbus()`).
It matches partition and channel IDs returned by those methods, never array
slots or contiguous IDs.  An unavailable integration surface or a closed
channel is recorded as a readable degraded stage; a faulted or halted guest is
recorded as `W98-HV-002` with recovery guidance.  A real `desk.js` stage entry
still takes precedence, so the integration can feed its own observation.

The model also inspects the high-level kernel executive state through
`W98.hv.bugcheck()` when the kernel-side adapter is present, and through the
existing `W98.kernel.exec()` executive snapshot otherwise.  A halted kernel or
bugcheck becomes a bounded `W98-KERNEL-HALTED` failure with the dump retained
in the record and log; the recovery UI presents it without trying to resume,
replace, or discard kernel state.  Failure lists, guidance, stage details,
registry values, and logs are capped so malformed integration input remains
readable.
