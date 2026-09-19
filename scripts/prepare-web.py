#!/usr/bin/python3
"""Prepare the pinned web adapter without running its Codex setup or touching login state."""
import argparse
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bun', default='/opt/codex-proxy-web/bin/bun')
    args = parser.parse_args()
    source = root/'web/upstream'
    if not (source/'src/server.ts').exists():
        raise SystemExit('Initialize pinned source first: git submodule update --init --recursive')
    target = root/'.runtime/web'
    if target.exists():
        raise SystemExit('Runtime exists. Stop codex-proxy-web, move .runtime/web aside, then prepare again.')
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('.git', 'node_modules', 'dist', 'artifacts'))
    worker = target/'src/adapters/chatgpt-web/browser-worker.ts'
    text = worker.read_text()
    anchor = '    await assertTemporaryChatPage(page);'
    if text.count(anchor) != 1:
        raise SystemExit('Pinned privacy patch no longer matches upstream. Inspect before upgrading.')
    worker.write_text('import { ensureUnpersonalized } from "./local-privacy";\n' + text.replace(anchor, anchor+'\n    await ensureUnpersonalized(page);'))
    shutil.copyfile(root/'web/privacy.ts', target/'src/adapters/chatgpt-web/local-privacy.ts')
    adapter = target/'src/adapters/chatgpt-web/index.ts'
    text = adapter.read_text()
    anchor = '  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);'
    if text.count(anchor) != 1:
        raise SystemExit('Pinned inference-only warning patch no longer matches upstream.')
    adapter.write_text(text.replace(anchor, '  const warning: string | undefined = undefined; // Plain inference has no Codex tool UI.'))
    subprocess.run([args.bun, 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=target, check=True)
    print('Prepared pinned browser-only source; global Codex configuration and credentials were not accessed.')

if __name__ == '__main__':
    main()
