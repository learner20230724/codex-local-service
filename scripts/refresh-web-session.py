#!/usr/bin/python3
"""Refresh the optional HTTP channel from the private existing ChatGPT browser login."""
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
config = json.loads(Path('/etc/codex-proxy/web.json').read_text())
if config.get('transport') != 'http':
    raise SystemExit('web-refresh is for HTTP transport; finish any browser login first.')
env = os.environ.copy()
env['CODEX_WEB_EGRESS_PROXY'] = config.get('egress_proxy', env.get('CODEX_WEB_EGRESS_PROXY', ''))
owner = pwd.getpwuid(Path(config['state_dir']).stat().st_uid)
command = ['/usr/bin/xvfb-run', '--auto-servernum', '--server-args=-screen 0 1280x800x24 -nolisten tcp',
           config['bun_bin'], 'run', str(root/'web/capture-session.ts')]
if os.geteuid() == 0:
    command = ['runuser', '-u', owner.pw_name, '--'] + command
elif os.geteuid() != owner.pw_uid:
    raise SystemExit('Use the existing web service identity to refresh its login.')
child = subprocess.Popen(command, cwd=root, env=env, start_new_session=True)
try:
    sys.exit(child.wait(timeout=150))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    raise SystemExit('Existing-session refresh timed out; use Codex fallback and inspect web status.')
