#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-"$ROOT_DIR/web/games/w98-ctf.iso"}
BUILD_DIR=${TMPDIR:-/tmp}/wasm98-ctf-build-$$

mkdir -p "$BUILD_DIR/source"
cleanup() {
  BUILD_DIR_TO_REMOVE="$BUILD_DIR" python3 - <<'PY'
import os
import shutil
shutil.rmtree(os.environ['BUILD_DIR_TO_REMOVE'], ignore_errors=True)
PY
}
trap cleanup EXIT HUP INT TERM

clang --target=i386-pc-none-elf -march=i386 -m16 -c \
  "$ROOT_DIR/tools/w98_ctf_boot.S" -o "$BUILD_DIR/boot.o"
ld.lld -m elf_i386 --image-base=0 -Ttext 0x7c00 \
  --oformat binary -nostdlib "$BUILD_DIR/boot.o" -o "$BUILD_DIR/boot.bin"

python3 - "$BUILD_DIR/boot.bin" "$BUILD_DIR/source/BOOT.IMG" <<'PY'
from pathlib import Path
import sys

src = Path(sys.argv[1]).read_bytes()
if len(src) != 512 or src[510:512] != b'\x55\xaa':
    raise SystemExit('boot sector must be exactly 512 bytes with a 0xaa55 signature')
Path(sys.argv[2]).write_bytes(src + b'\0' * (1474560 - len(src)))
PY
cp "$ROOT_DIR/web/games/w98-ctf/CHALLENGE.TXT" "$BUILD_DIR/source/CHALLENGE.TXT"

mkdir -p "$(dirname -- "$OUT")"
hdiutil makehybrid -ov -o "$OUT" -iso \
  -eltorito-boot "$BUILD_DIR/source/BOOT.IMG" "$BUILD_DIR/source"

ISO_OUT="$OUT" python3 - <<'PY'
from pathlib import Path
import os
import struct

path = Path(os.environ['ISO_OUT'])
b = bytearray(path.read_bytes())
sector = 2048
if b[16 * sector + 1:16 * sector + 6] != b'CD001':
    raise SystemExit('not an ISO9660 image')

boot_record = b[17 * sector:18 * sector]
catalog_lba = int.from_bytes(boot_record[71:75], 'little')
catalog = catalog_lba * sector
if b[catalog] != 1 or b[catalog + 30:catalog + 32] != b'\x55\xaa':
    raise SystemExit('invalid El Torito validation entry')

# DOSBox-X boots El Torito emulated-diskette images through A:.
entry = catalog + 32
b[entry + 1] = 0x02                         # 1.44 MB floppy emulation
struct.pack_into('<H', b, entry + 6, 2880)  # 2880 512-byte sectors
path.write_bytes(b)
print('wrote', path)
PY
