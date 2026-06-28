#!/usr/bin/env python3
"""Static server for the FM Navigate prototype with caching disabled.

Babel-standalone fetches the .jsx files at runtime; the default http.server
lets the browser heuristically cache them, so edits don't show on reload.
This handler sends no-store on every response.
"""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # SPA fallback: serve index.html for clean-route paths (no file
        # extension) that don't map to a real file, so History-API deep links
        # survive a refresh locally — mirrors the 404.html trick on Pages.
        rel = self.path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        fs = os.path.join(ROOT, rel)
        if rel and not os.path.exists(fs) and "." not in os.path.basename(rel):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_header(self, key, value):
        # Drop Last-Modified so the browser can't do an If-Modified-Since 304.
        if key.lower() == "last-modified":
            return
        super().send_header(key, value)


if __name__ == "__main__":
    handler = partial(NoCacheHandler, directory=ROOT)
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
