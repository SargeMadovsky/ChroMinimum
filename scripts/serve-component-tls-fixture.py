"""Loopback-only HTTPS fixture. Never installs certificates or serves private keys."""
import argparse
import functools
import http.server
import json
import ssl
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    args = parser.parse_args()
    packages = args.packages.resolve(strict=True)
    fixture = args.fixture.resolve(strict=True)
    allowed = {p.name for p in packages.glob('*.tar.gz') if p.is_file() and not p.is_symlink()}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            name = self.path.removeprefix('/')
            if name not in allowed:
                self.send_error(404)
                return
            with (fixture / 'requests.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps({'path': self.path}) + '\n')
            super().do_GET()

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(packages)))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(fixture / 'server.pem', fixture / 'server-key.pem')
    server.socket = context.wrap_socket(server.socket, server_side=True)
    (fixture / 'origin.txt').write_text(f'https://localhost:{server.server_port}', encoding='utf-8')
    print('fixture_ready', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
