"""Configure a dedicated CEF checkout without Chrome Updater test binaries."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import pprint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-root', type=Path, required=True)
    args = parser.parse_args()
    policy = json.loads((Path(__file__).resolve().parents[1] /
                         'patches/chromium/source-build.json').read_text(encoding='utf-8'))
    config = args.build_root.resolve() / 'chromium/.gclient'
    url = 'https://chromium.googlesource.com/chromium/src.git@' + policy['chromium']
    if config.exists():
        tree = ast.parse(config.read_text(encoding='utf-8'))
        if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assign):
            raise ValueError('Unexpected existing gclient configuration; preserve and review it')
        assignment = tree.body[0]
        if len(assignment.targets) != 1 or not isinstance(assignment.targets[0], ast.Name) or assignment.targets[0].id != 'solutions':
            raise ValueError('Expected only a solutions assignment')
        solutions = ast.literal_eval(assignment.value)
        if len(solutions) != 1 or solutions[0].get('name') != 'src' or solutions[0].get('url') != url:
            raise ValueError('Existing gclient checkout does not match pinned Chromium')
        solution = solutions[0]
    else:
        solution = {'name': 'src', 'url': url, 'managed': False,
                    'deps_file': 'DEPS', 'safesync_url': '',
                    'custom_vars': {'checkout_pgo_profiles': False,
                                    'source_tarball': False, 'siso_version': 'latest'}}
    excluded = []
    for product in ('chrome', 'chromium'):
        for arch in ('arm64', 'x86', 'x86_64'):
            for suffix in ('', '_sans_iid'):
                excluded.append(f'src/third_party/updater/{product}_win_{arch}{suffix}/cipd')
    overrides = solution.setdefault('custom_deps', {})
    for name in excluded:
        if name in overrides:
            if overrides[name] is not None:
                raise ValueError('Unexpected updater override')
            del overrides[name]
    source = config.parent / 'src/DEPS'
    original = source.read_text(encoding='utf-8')
    if hashlib.sha256(original.encode()).hexdigest() != policy['chromium_deps_sha256']:
        raise ValueError('Upstream DEPS changed; review test-package exclusions')
    tree = ast.parse(original)
    deps = [node.value for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'deps'
                    for target in node.targets)]
    if len(deps) != 1 or not isinstance(deps[0], ast.Dict):
        raise ValueError('Expected one DEPS dictionary')
    lines = original.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    changes = []
    for key, value in zip(deps[0].keys, deps[0].values):
        if isinstance(key, ast.Constant) and key.value in excluded:
            changes.append((offsets[value.lineno - 1] + value.col_offset,
                            offsets[value.end_lineno - 1] + value.end_col_offset))
    if len(changes) != len(excluded):
        raise ValueError('Not all expected updater test dependencies found')
    generated = original
    for start, end in sorted(changes, reverse=True):
        generated = generated[:start] + 'None' + generated[end:]
    # All edits are pinned dictionary values; the remaining original text stays intact.
    ast.parse(generated)
    (source.parent / 'DEPS.chrominimum').write_text(generated, encoding='utf-8')
    solution['deps_file'] = 'DEPS.chrominimum'
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text('solutions = ' + pprint.pformat([solution], sort_dicts=True) + '\n', encoding='utf-8')
    print(json.dumps({'configuration': str(config), 'excluded_updater_test_packages': excluded}))


if __name__ == '__main__':
    main()
