# User restore-point snapshot format

Wasm98 restore points use a small, versioned JSON envelope.  The envelope is
intentionally limited to persistent state; it does not attempt to capture live
JavaScript objects, open windows, timers, processes, or function closures.

An exported snapshot is UTF-8 JSON with this top-level shape:

```json
{
  "format": "W98-SNAPSHOT",
  "version": 1,
  "createdAt": "2026-10-02T12:34:56.000Z",
  "name": "Before installing a game",
  "description": "Optional note shown in System Restore",
  "state": {
    "fs": "KFS1 ...",
    "reg": "KREG1 ..."
  }
}
```

`format` is the fixed discriminator. `version` is the envelope version, and
must be an integer supported by the reader (currently `1`). `createdAt` is an
ISO-8601 timestamp supplied by the creator. `name` is the user-visible restore
point name; `description` may be an empty string.  Names are unique within a
browser profile.  The state object contains the kernel's own serialized images:

* `state.fs` is the line-oriented `KFS1` filesystem image.
* `state.reg` is the registry hive image emitted by the kernel (`KREG1` and
  newer `KREG2` images are accepted so existing data remains compatible).

The kernel remains the sole owner of these two encodings.  Snapshot code stores
and transports the opaque strings; it must not parse or recreate filesystem or
registry records itself.  Desktop settings and application settings are
represented by their registry values and therefore travel with `state.reg`.

An implementation may add non-semantic metadata fields in a future envelope,
but readers must continue to validate the required fields above.  Unknown
fields are ignored when the version is supported.  A version greater than the
highest supported version, a different `format`, invalid JSON, missing state,
or a state member that is not a string is rejected before any kernel state is
changed.

## IndexedDB storage

Named restore points are kept in a separate IndexedDB database named
`w98-system-restore`.  Automatic persistence continues to use the existing
`w98-kernel` records (`fs`, `reg`, and `savedAt`); the two databases are kept
separate so opening the restore database can never interfere with an older
kernel database schema.  User snapshots are never used as the automatic boot
record.  Consequently a malformed imported point or
a failed restore cannot overwrite the current automatic snapshot.

The browser fallback (shim mode) uses the same envelope and IndexedDB records;
it captures the shim's filesystem and registry through the same `W98Kernel.fs`
and `W98Kernel.reg` interfaces.  If IndexedDB is unavailable, the UI reports
that named restore points cannot be persisted while leaving the in-memory
desktop usable.

## Restore and import rules

Creating a point serializes the current state and writes one complete record.
Duplicate names are rejected rather than silently replacing an existing point.
Deleting a point removes only that named record.  Restoring a point validates
the complete envelope first, then replaces the filesystem and registry through
the kernel's `KFS1`/`KREG1` loaders and reinitializes the desktop.  Import uses
the same validation path and does not write anything until validation succeeds;
malformed, unsupported, or future-version files therefore leave current state
untouched.

Export is a browser download of the exact envelope JSON.  The file can be
imported into a fresh profile as long as its version and state encodings are
supported by that wasm98 build.

