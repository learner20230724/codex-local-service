#!/usr/bin/python3
"""Add the optional browser channel to an existing Codex Local Service installation."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user', required=True)
    parser.add_argument('--bun', required=True, help='Verified Bun 1.4.0 executable')
    parser.add_argument('--chrome', required=True, help='Chrome/Chromium executable')
    parser.add_argument('--login-chrome', help='Optional supported stable Chrome executable for manual account login')
    parser.add_argument('--egress-proxy', default='')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root/sudo.')
    user = pwd.getpwnam(args.user)
    if user.pw_uid == 0 or not re.fullmatch(r'[A-Za-z0-9_-]+', args.user):
        parser.error('Use a non-root service user.')
    for value in [str(ROOT), args.bun, args.chrome, args.login_chrome or args.chrome]:
        if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value):
            parser.error('Use absolute executable/project paths without spaces or special characters.')
    if not all(Path(p).is_file() for p in [args.bun, args.chrome, args.login_chrome or args.chrome, '/etc/codex-proxy/client.json']):
        parser.error('Existing proxy configuration and both runtime executables are required.')
    if not shutil.which('xvfb-run'):
        parser.error('Install Xvfb and Chromium system libraries first.')
    version = subprocess.check_output([args.bun, '--version'], text=True).strip()
    if version != '1.4.0':
        parser.error('This pinned adapter requires Bun 1.4.0.')
    if args.egress_proxy:
        url = urlsplit(args.egress_proxy)
        if url.scheme not in ['http', 'https'] or not url.hostname or url.username or url.password or re.search(r'[\s%"\\]', args.egress_proxy):
            parser.error('Use a plain HTTP(S) egress URL without embedded credentials.')
    targets = ['/etc/codex-proxy/web.json', '/etc/codex-proxy/routing.json', '/etc/systemd/system/codex-proxy-web.service']
    for value in targets:
        if Path(value).exists():
            parser.error('Existing web installation: inspect/update it rather than overwrite '+value)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 3468))
    if Path('/tmp/.X11-unix/X97').exists():
        parser.error('Display :97 is already in use. Select another display in the service template.')
    for path in [ROOT/'.runtime', Path('/var/lib/codex-proxy/web')]:
        path.mkdir(mode=0o700, parents=True, exist_ok=True); os.chown(path, user.pw_uid, user.pw_gid)
    runner = ['runuser', '-u', args.user, '--']
    subprocess.run(runner + ['python3', str(ROOT/'scripts/prepare-web.py'), '--bun', args.bun], check=True)
    def chrome_wrapper(name, executable):
        wrapper = Path('/var/lib/codex-proxy/web')/name
        wrapper.write_text('#!/bin/sh\nif [ -n "$CODEX_WEB_EGRESS_PROXY" ]; then\n exec '+executable+' "--proxy-server=$CODEX_WEB_EGRESS_PROXY" "$@"\nfi\nexec '+executable+' "$@"\n')
        wrapper.chmod(0o700); os.chown(wrapper, user.pw_uid, user.pw_gid)
        return str(wrapper)
    web = json.loads((ROOT/'config/web.example.json').read_text())
    web.update(bun_bin=args.bun, chrome_bin=chrome_wrapper('chrome', args.chrome),
               login_chrome_bin=chrome_wrapper('login-chrome', args.login_chrome or args.chrome))
    for name, data in [('web.json', web), ('routing.json', json.loads((ROOT/'config/routing.example.json').read_text()))]:
        path = Path('/var/lib/codex-proxy/routing.json') if name == 'routing.json' else Path('/etc/codex-proxy')/name
        with path.open('x') as stream: stream.write(json.dumps(data, indent=2)+'\n')
        path.chmod(0o600); os.chown(path, user.pw_uid, user.pw_gid)
        if name == 'routing.json':
            (Path('/etc/codex-proxy')/name).symlink_to(path)
    unit = (ROOT/'deploy/codex-proxy-web.service.in').read_text()
    for name, value in {'SERVICE_USER': args.user, 'PREFIX': str(ROOT), 'EGRESS_PROXY': args.egress_proxy}.items():
        unit = unit.replace('@'+name+'@', value)
    Path(targets[2]).write_text(unit)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'codex-proxy-web.service'], check=True)
    print('Web channel installed. Build/restart the main proxy when idle; then codex-proxyctl web-login.')

if __name__ == '__main__':
    main()
