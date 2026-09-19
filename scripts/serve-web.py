#!/usr/bin/python3
"""Launch the private browser adapter inside systemd's virtual display."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
config = json.loads(Path('/etc/codex-proxy/web.json').read_text())
env = os.environ.copy()
env.update(CODEX_CHATGPT_WEB_HOME=config['state_dir'], CODEX_WEB_CHROME=config['chrome_bin'],
           CODEX_WEB_PORT=str(config.get('port', 3468)),
           CODEX_WEB_LOGIN_CHROME=config.get('login_chrome_bin', config['chrome_bin']))
os.chdir(root)
os.execve(config['bun_bin'], [config['bun_bin'], 'run', str(root/'web/bridge.ts')], env)
