#!/bin/sh
# Start the Windows 98 desktop on a local port.
set -e
cd "$(dirname "$0")"

if [ ! -f web/wasm/kernel.wasm ]; then
  echo "building the WebAssembly kernel..."
  ./tools/build_kernel.sh
fi

PORT="${1:-8098}"
exec python3 tools/serve.py -p "$PORT"
