#!/usr/bin/python3
"""Launch the selected private transport; create a virtual display only for browser mode."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
config = json.loads(Path('/etc/codex-proxy/web.json').read_text())
env = os.environ.copy()
env.update(CODEX_CHATGPT_WEB_HOME=config['state_dir'], CODEX_WEB_CHROME=config['chrome_bin'],
           CODEX_WEB_PORT=str(config.get('port', 3468)),
           CODEX_WEB_EGRESS_PROXY=config.get('egress_proxy', env.get('CODEX_WEB_EGRESS_PROXY', '')),
           CODEX_WEB_LOGIN_CHROME=config.get('login_chrome_bin', config['chrome_bin']),
           CODEX_WEB_HTTP_PYTHON=config.get('http_python', '/opt/codex-proxy-web/http-venv/bin/python'))
os.chdir(root)
transport = config.get('transport', 'browser')
if transport not in ('browser', 'http'):
    raise SystemExit('Unsupported web transport')
if transport == 'browser' and not env.get('DISPLAY'):
    os.execve('/usr/bin/xvfb-run', ['/usr/bin/xvfb-run', '--server-num=97',
        '--auth-file=/var/lib/codex-proxy/web/Xauthority', '--server-args=-screen 0 1280x800x24 -nolisten tcp',
        '/usr/bin/python3', str(Path(__file__).resolve())], env)
entry = 'http-bridge.ts' if transport == 'http' else 'bridge.ts'
os.execve(config['bun_bin'], [config['bun_bin'], 'run', str(root/'web'/entry)], env)
