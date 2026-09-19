#!/usr/bin/python3
"""Measure complete service cgroups; CPU percent is relative to one logical CPU."""
import argparse
import json
import subprocess
import time

def sample(unit):
    text = subprocess.check_output(['systemctl', 'show', unit, '-p', 'MemoryCurrent', '-p', 'MemoryPeak', '-p', 'CPUUsageNSec', '-p', 'TasksCurrent'], text=True)
    return {key: int(value) if value.isdigit() else None for key, value in (line.split('=', 1) for line in text.splitlines())}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600:
        parser.error('seconds must be between 1 and 3600')
    units = ['codex-proxy.service', 'codex-proxy-web.service']
    start = time.monotonic(); first = {u: sample(u) for u in units}; peak = {u: first[u]['MemoryCurrent'] or 0 for u in units}
    while time.monotonic()-start < args.seconds:
        time.sleep(min(1, max(0, args.seconds-(time.monotonic()-start))))
        last = {u: sample(u) for u in units}
        for unit in units: peak[unit] = max(peak[unit], last[unit]['MemoryCurrent'] or 0)
    elapsed = time.monotonic()-start
    print(json.dumps({'seconds': round(elapsed, 2), 'services': {
        u: {'current_mib': round((last[u]['MemoryCurrent'] or 0)/1048576, 1),
            'sample_peak_mib': round(peak[u]/1048576, 1),
            'service_lifetime_peak_mib': round((last[u]['MemoryPeak'] or 0)/1048576, 1),
            'average_cpu_percent': round(((last[u]['CPUUsageNSec'] or 0)-(first[u]['CPUUsageNSec'] or 0))/1e9/elapsed*100, 2),
            'tasks': last[u]['TasksCurrent']} for u in units}}, indent=2))

if __name__ == '__main__':
    main()
