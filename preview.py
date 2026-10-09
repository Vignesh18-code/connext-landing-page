"""Preview the site on your own computer:  python3 preview.py   then open http://localhost:5190

Python's built-in `http.server` cannot seek inside a video (it ignores byte-range requests), so the
timeline would jump back to the start. This tiny server supports ranges and also sends the same
Content-Security-Policy as site/_headers, so what you see here matches the live site.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, 'site')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5190

CSP = ''
try:
    with open(os.path.join(ROOT, '_headers')) as headers:
        for line in headers:
            if line.strip().startswith('Content-Security-Policy:'):
                # upgrade-insecure-requests only makes sense on https
                CSP = line.split(':', 1)[1].strip().replace('; upgrade-insecure-requests', '')
except OSError:
    pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        self._remaining = None
        match = re.match(r'bytes=(\d*)-(\d*)$', (self.headers.get('Range') or '').strip())
        path = self.translate_path(self.path)
        if not match or not os.path.isfile(path):
            return super().send_head()

        size = os.path.getsize(path)
        start = int(match.group(1)) if match.group(1) else max(0, size - int(match.group(2) or 0))
        end = min(int(match.group(2)), size - 1) if match.group(1) and match.group(2) else size - 1
        if start > end:
            self.send_error(416)
            return None

        f = open(path, 'rb')
        f.seek(start)
        self._remaining = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self._remaining))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        if self._remaining is None:
            return super().copyfile(source, outputfile)
        left = self._remaining
        while left > 0:
            chunk = source.read(min(64 * 1024, left))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                break    # the browser moved on (it seeked elsewhere)
            left -= len(chunk)

    def end_headers(self):
        self.send_header('Accept-Ranges', 'bytes')
        if CSP:
            self.send_header('Content-Security-Policy', CSP)
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'Connext landing page: http://localhost:{PORT}   (Ctrl+C to stop)')
    try:
        ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
