# Host file exchange and virtual media

The desktop keeps the host boundary in `web/js/host-file-bridge.js`.  A browser
picker is the only way to obtain host files: the bridge uses an ordinary file
input for a file collection and the browser's explicit directory-selection mode
for a directory.  It never scans a host path, makes a network request, or stores
host bytes in `localStorage`.

## Media model

Inserted media is a deterministic, versioned manifest (`version: 1`, kind
`w98-host-media`).  Paths are normalized to DOS separators and sorted
case-insensitively before the manifest is materialized in the kernel VFS.  The
manifest carries the media kind, drive, label, capacity, write-protection bit,
and each file's relative path, length, MIME type, and last-modified time.  This
is intentionally a filesystem-backed model rather than a raw FAT image; the UI
labels it as **virtual media**.

The floppy app uses `A:\` and the virtual CD-ROM uses `D:\`.  The default floppy
capacity is 1.44 MiB and the default CD capacity is 700 MiB.  Capacity is
checked before mounting and on every guest write.  Floppy and CD media are
read-only by default; a write attempt returns a Win98-style write-protected
error.  A full medium returns a disk-full error.  Eject removes the floppy app's
materialized tree and invalidates both app generations and bridge media tokens,
so old paths cannot be used after ejection.

## App and shell integration

`Insert Floppy...` opens the picker and media details window.  `Transfer` can
copy picked files into `C:\My Documents`, export selected guest files with a
browser download, and accept a drop only on its explicit import target.  The
Explorer folder pane also accepts a host drop when the current target is a
guest directory; the drop is routed through the same bridge and therefore still
requires the browser-provided `File` objects.

The materialized files are ordinary VFS entries.  Explorer lists them and the
DOS prompt can `DIR`, `TYPE`, and `COPY` them.  DOS and Explorer surface the
same write-protected and disk-full errors.  If WebAssembly cannot load, the
existing JavaScript kernel shim supplies the same VFS API, so transfer and
media operations remain usable for the session.

## Validation

Run the syntax check from the repository root:

```sh
node --check web/js/host-file-bridge.js
node --check web/js/apps/transfer.js
node --check web/js/apps/floppy.js
```
