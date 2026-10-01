#!/bin/sh
# Build the WebAssembly hypervisor used by the Windows 98 desktop.
# Freestanding: no libc, no entry point, everything exported to JS.
# guest/guest.c is linked into the same image and is only entered through
# hv_vm_entry(), so the module is both the hypervisor and its first guest.
set -e
cd "$(dirname "$0")/.."

OUT=web/wasm/hypervisor.wasm
mkdir -p web/wasm

clang \
  --target=wasm32-unknown-unknown \
  -O2 \
  -std=c11 \
  -fno-builtin \
  -fno-stack-protector \
  -nostdlib \
  -Wall -Wextra -Wno-unused-parameter \
  -Wl,--no-entry \
  -Wl,--export-all \
  -Wl,--lto-O2 \
  -Wl,-z,stack-size=1048576 \
  -Wl,--initial-memory=33554432 \
  -Wl,--max-memory=33554432 \
  -o "$OUT" \
  hypervisor/hv.c guest/guest.c

SIZE=$(wc -c < "$OUT")
echo "built $OUT ($SIZE bytes)"
