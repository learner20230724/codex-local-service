#!/usr/bin/python3
"""Launch the shared inference service; official Codex owns OAuth credentials."""
import json
import os
from pathlib import Path
import tomllib
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
config = json.loads(Path('/etc/codex-proxy/client.json').read_text())
address = urlsplit(config['base_url'])
if address.scheme != 'http' or address.hostname != '127.0.0.1':
    raise SystemExit('This service must bind to the local loopback interface.')
key = Path(config['api_key_file']).read_text().strip()
if not key:
    raise SystemExit('Local proxy key is empty.')
env = os.environ.copy()
defaults = {
    'CODEX_PROXY_PORT': str(address.port),
    'CODEX_PROXY_POOL_MAX': str(config.get('pool_max', 2)),
    'CODEX_PROXY_INIT_POOL': '0',
    'CODEX_PROXY_TIMEOUT_MS': '240000',
    'CODEX_PROXY_INIT_TIMEOUT_MS': '30000',
    'CODEX_PROXY_TURN_START_TIMEOUT_MS': '30000',
    'CODEX_PROXY_DEFAULT_MODEL': config['model'],
    'CODEX_PROXY_STATS_FILE': '/var/lib/codex-proxy/stats/daily.json',
}
for name, value in defaults.items():
    env.setdefault(name, value)
env.update({
    # Names retained for compatibility with the existing audited local patch.
    'LEARNING_PROXY_KEY': key,
    'CODEX_PROXY_HOST': '127.0.0.1',
    'CODEX_PROXY_CODEX_BIN': config['codex_bin'],
    'CODEX_PROXY_SANDBOX': 'read-only',
    'CODEX_PROXY_APPROVAL_POLICY': 'never',
    'CODEX_PROXY_DEBUG': '0',
    'CODEX_PROXY_ROUTING_FILE': '/etc/codex-proxy/routing.json' if Path('/etc/codex-proxy/routing.json').exists() else '',
    'CODEX_PROXY_TRACE': '0',
    'CODEX_PROXY_CORS': '0',
    'DEBUG': '0',
})
# Only integration names are read; auth.json is exclusively handled by Codex.
codex_config = Path(env.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
names = list(tomllib.loads(codex_config.read_text()).get('mcp_servers', {})) if codex_config.exists() else []
env['LEARNING_DISABLED_MCP'] = json.dumps(names)
os.chdir(config['work_dir'])
node = config['node_bin']
os.execve(node, [node, str(ROOT / 'upstream/dist/server/standalone.js')], env)
