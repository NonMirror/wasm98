#!/usr/bin/env python3
"""Static server for the Windows 98 desktop.

Serves ./web with the headers a WASM desktop needs:
  * correct MIME type for .wasm, .jsdos, .woff2
  * COOP/COEP so DOSBox-WASM (js-dos) can use SharedArrayBuffer + threads
  * no caching, so editing a file and hitting reload always shows the change
"""
import argparse
import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
PORT = 8098


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".jsdos": "application/zip",
        ".mjs": "text/javascript",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".js": "text/javascript",
        ".json": "application/json",
        ".wav": "audio/wav",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        if " 200 " in msg or " 304 " in msg:
            return                      # keep the console readable
        sys.stderr.write("  [http] %s\n" % msg)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=PORT)
    ap.add_argument("--open", action="store_true", help="print the URL only")
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=ROOT)
    with Server(("127.0.0.1", args.port), handler) as httpd:
        url = "http://127.0.0.1:%d/" % args.port
        if args.open:
            print(url)
            return
        print("Windows 98 (web) is being served at %s" % url)
        print("  document root: %s" % os.path.realpath(ROOT))
        print("  COOP/COEP enabled for WASM threads.  Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nshutting down")


if __name__ == "__main__":
    main()
