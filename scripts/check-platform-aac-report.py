"""Check isolated system AAC playback and live sandbox-token evidence."""
import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('media_check', Path(__file__).with_name('check-media-report.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = module.check(args.report)
    failures = result['failures']
    try:
        tokens = json.loads((args.report / 'tokens.json').read_text(encoding='utf-8-sig'))
        selection = json.loads((args.report / 'platform-selection.json').read_text(encoding='utf-8'))
        playback = json.loads((args.report / 'playback.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        failures.append(f'Incomplete platform evidence: {error}')
        result['passed'] = False
        print(json.dumps(result, indent=2))
        raise SystemExit(1)
    for name in ('bear-1280x720.mp4', 'bear-vp9-opus.webm'):
        rows = [row for row in playback if row.get('file') == name]
        if len(rows) != 1 or rows[0].get('ended') is not True:
            failures.append(f'{name}: end of clip not reached')
    if selection.get('selected') is not True:
        failures.append('Media Foundation AAC was not selected')
    browsers = [t for t in tokens if t['Role'] == 'browser']
    gpu = [t for t in tokens if t['Role'] == 'gpu-process']
    renderers = [t for t in tokens if t['Role'] == 'renderer']
    network = [t for t in tokens if t['Subtype'] == 'network.mojom.NetworkService']
    if len(browsers) != 1 or browsers[0]['Error'] != 0:
        failures.append('Missing browser token')
    else:
        for role, rows in [('GPU', gpu), ('renderer', renderers)]:
            if not rows or not all(t['Error'] == 0 and t['Restricted'] and
                                   t['IntegrityRid'] < browsers[0]['IntegrityRid'] for t in rows):
                failures.append(f'Missing restricted {role} token below browser integrity')
    if not network or not all(t['Error'] == 0 and t['SandboxType'] == 'network' and
                              t['AppContainer'] == 1 and t['IntegrityRid'] <= 4096 for t in network):
        failures.append('Missing Low AppContainer network sandbox')
    result['passed'] = not failures
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
