#!/usr/bin/python3
"""Install a new Linux/systemd instance. Existing instances are never overwritten."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import subprocess
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user', required=True, help='Existing non-root user already logged in to Codex')
    parser.add_argument('--prefix', default='/opt/codex-local-service')
    parser.add_argument('--port', type=int, default=3467)
    parser.add_argument('--model', default='gpt-6-astra')
    parser.add_argument('--egress-proxy', help='Optional HTTP(S) egress proxy URL, without embedded credentials')
    parser.add_argument('--no-start', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run this installer with sudo/root.')
    user = pwd.getpwnam(args.user)
    if user.pw_uid == 0:
        parser.error('Select a non-root service user.')
    prefix = Path(args.prefix).resolve()
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(prefix)):
        parser.error('Installation prefix must be an absolute path without spaces or special characters.')
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', user.pw_dir) or not re.fullmatch(r'[A-Za-z0-9_-]+', args.user):
        parser.error('Unsupported service user/home path.')
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged port between 1024 and 65535.')
    config_dir = Path('/etc/codex-proxy')
    unit_path = Path('/etc/systemd/system/codex-proxy.service')
    ctl_path = Path('/usr/local/bin/codex-proxyctl')
    state = Path('/var/lib/codex-proxy')
    for path in [prefix, config_dir, unit_path, ctl_path, state]:
        if path.exists() or path.is_symlink():
            parser.error(f'Already exists: {path}. Inspect/reuse the existing installation.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', args.port))
    search_path = f'{user.pw_dir}/.local/node/bin:{user.pw_dir}/.local/bin:/usr/local/bin:/usr/bin:/bin'
    binaries = {name: shutil.which(name, path=search_path) for name in ['node', 'npm', 'codex']}
    if not all(binaries.values()):
        parser.error('Install Node.js >=20, npm and the official Codex CLI for the service user first.')
    node_version = subprocess.check_output([binaries['node'], '--version'], text=True).strip()
    if int(node_version.lstrip('v').split('.')[0]) < 20:
        parser.error('Node.js >=20 is required.')
    egress = ''
    if args.egress_proxy:
        url = urlsplit(args.egress_proxy)
        if url.scheme not in ['http', 'https'] or not url.hostname or url.username or url.password or any(c in args.egress_proxy for c in '\n\r%"\\ '):
            parser.error('Use a plain HTTP(S) egress URL without credentials or special characters.')
        egress = f'Environment=HTTP_PROXY={args.egress_proxy}\nEnvironment=HTTPS_PROXY={args.egress_proxy}'
    runner = ['runuser', '-u', args.user, '--', 'env', f'PATH={search_path}', f'HOME={user.pw_dir}']
    subprocess.run(runner + [binaries['codex'], 'login', 'status'], check=True)
    shutil.copytree(SOURCE, prefix, ignore=shutil.ignore_patterns(
        '.git', 'node_modules', 'dist', '__pycache__', '*.pyc', '.env', '.env.*', '*.key', '*.log',
        'LOCAL.md', 'backup-location.txt', 'provenance.json', 'codex-proxy.service'))
    for path in [prefix, *prefix.rglob('*')]:
        os.chown(path, user.pw_uid, user.pw_gid, follow_symlinks=False)
    subprocess.run(runner + [binaries['npm'], 'ci', '--ignore-scripts'], cwd=prefix/'upstream', check=True)
    subprocess.run(runner + [binaries['npm'], 'run', 'build'], cwd=prefix/'upstream', check=True)
    config_dir.mkdir(mode=0o755)
    key_path = config_dir/'proxy.key'
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(secrets.token_urlsafe(40) + '\n')
    os.chown(key_path, user.pw_uid, user.pw_gid)
    config = json.loads((prefix/'config/client.example.json').read_text())
    config.update(base_url=f'http://127.0.0.1:{args.port}/v1', model=args.model,
                  node_bin=binaries['node'], codex_bin=binaries['codex'])
    (config_dir/'client.json').write_text(json.dumps(config, indent=2) + '\n')
    state.mkdir(mode=0o700)
    work = state/'inference'; work.mkdir(mode=0o700)
    for path in [state, work]:
        os.chown(path, user.pw_uid, user.pw_gid)
    unit = (prefix/'deploy/codex-proxy.service.in').read_text()
    for key, value in {'SERVICE_USER': args.user, 'HOME': user.pw_dir, 'PATH': search_path,
                       'PREFIX': str(prefix), 'EGRESS_ENV': egress}.items():
        unit = unit.replace('@' + key + '@', value)
    unit_path.write_text(unit)
    ctl = prefix/'scripts/codex-proxyctl'; ctl.chmod(0o755)
    ctl_path.symlink_to(ctl)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'codex-proxy.service'], check=True)
    if not args.no_start:
        subprocess.run(['systemctl', 'start', 'codex-proxy.service'], check=True)
    print('Installed. Run codex-proxyctl check; use codex-proxyctl smoke for a real model request.')


if __name__ == '__main__':
    main()
