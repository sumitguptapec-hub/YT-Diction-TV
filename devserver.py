"""Local-only static file server with caching fully disabled -- the plain
`python -m http.server` was letting the browser reuse stale cached copies of
edited JS module files across reloads during testing."""
import http.server
import functools
import os

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=PUBLIC_DIR)
    http.server.test(HandlerClass=handler, port=3000)
