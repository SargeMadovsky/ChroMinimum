"""Small paired diagnostic on separate fresh profiles; not a general browser benchmark."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--runs', type=int, default=3, choices=range(1, 6))
    a = p.parse_args()
    output = a.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    results = {name: [] for name in ('baseline', 'candidate')}
    for index in range(a.runs):
        for name in (('baseline', 'candidate') if index % 2 == 0 else ('candidate', 'baseline')):
            runtime = getattr(a, name).resolve(strict=True)
            case = output / f'{index}-{name}'
            with (output / f'{index}-{name}.stdout').open('w', encoding='utf-8') as log:
                process = subprocess.run([sys.executable, str(ROOT / 'scripts/smoke-component-bundle.py'),
                    '--bundle', str(runtime / 'core/seed'), '--installed-launcher', str(runtime / 'chrominimum.exe'),
                    '--output', str(case), '--case', 'html'], stdout=log, stderr=subprocess.STDOUT, timeout=100)
            report = json.loads((case / 'result.json').read_text(encoding='utf-8'))
            assert process.returncode == 0 and report['passed']
            first = next(r['received_seconds'] for r in report['requests'] if r.get('path') == 'smoke.html')
            results[name].append(first)
            print(f'{name} {index}: first GET {first:.3f}s', flush=True)
    summary = {name: dict(first_get_seconds=values, median=statistics.median(values)) for name, values in results.items()}
    summary['limitations'] = 'Fresh isolated profiles, warm OS cache from hash checks, few samples, uncontrolled background load; no CPU/RAM comparison.'
    (output / 'comparison.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
