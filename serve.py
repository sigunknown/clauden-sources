"""Run the mirrored clauden.best site locally: python serve.py, then open http://localhost:8766

Clean routes like /pricing are served from pricing.html. API calls (/v1/...) return 404:
the backend is not part of the mirror, so login and chats do not work.
"""
import functools
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        local = super().translate_path(path)
        if not os.path.exists(local) and os.path.exists(local + ".html"):
            return local + ".html"
        return local


print(f"Serving {ROOT} on http://localhost:{PORT}")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
