"""Create a new installer payload from an explicit runtime allowlist, never profiles."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('components', ROOT / 'scripts/package-components.py')
components = importlib.util.module_from_spec(spec)
spec.loader.exec_module(components)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--launcher', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--baseline', type=Path, default=ROOT / 'installer/seed-baseline.json')
    p.add_argument('--icon-tool', type=Path, default=ROOT / 'target/release/bundle.exe')
    a = p.parse_args()
    runtime = a.runtime.resolve(strict=True)
    credits = (runtime / 'CREDITS.html').read_text(encoding='utf-8')
    if len(credits) < 100_000 or 'This is sample credits page.' in credits:
        raise ValueError('Full generated Chromium CREDITS.html is required; sample credits cannot ship')
    baseline = json.loads(a.baseline.read_text(encoding='utf-8'))
    # Reviewed baseline: source security level 1, plus the required media
    # capability. Neither is inferred from arbitrary version strings.
    for name, expected in baseline['files'].items():
        if components.digest(runtime / name) != expected:
            raise ValueError(f'Runtime differs from reviewed installer baseline: {name}')
    output = a.output.resolve()
    files = {f'core/seed/{name}': runtime / name for name in components.RUNTIME}
    for locale in components.LOCALES:
        files.update({f'core/seed/{name}': runtime / name for name in components.locale_names(locale)})
    files['chrominimum.exe'] = a.launcher.resolve(strict=True)
    for name in ('LICENSE', 'THIRD_PARTY.md'):
        files[name] = ROOT / name
    for name in ('LICENSES-RUST.html', 'LICENSES-UPDATER.html'):
        files[name] = ROOT / 'dist' / name
    for name in ('cef/LICENSE', 'cef-rs/LICENSE-APACHE', 'cef-rs/LICENSE-MIT'):
        files[f'third_party/{name}'] = ROOT / 'third_party' / name
    for file in files.values():
        components.regular(file)
    if output.exists() or output == runtime or runtime in output.parents:
        raise ValueError('Payload directory must be new and outside the runtime')
    output.mkdir(parents=True)
    inspection = {}
    for name, source in sorted(files.items()):
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    subprocess.run([str(a.icon_tool.resolve(strict=True)), '--icon', str(output / 'chrominimum.exe')], check=True)
    for name in sorted(files):
        target = output / name
        inspection[name] = dict(bytes=target.stat().st_size, sha256=components.digest(target))
    for locale in components.LOCALES:
        (output / f'install-{locale}.json').write_text(json.dumps(
            dict(format=1, ui_locale=locale, locales=[locale]), separators=(',', ':')), encoding='utf-8')
    baseline['files']['chrominimum.dll'] = inspection['core/seed/chrominimum.dll']['sha256']
    (output / 'core/seed/installer-seed.json').write_text(json.dumps(baseline, indent=2), encoding='utf-8')
    policy_file = output / 'core/seed/installer-seed.json'
    inspection['core/seed/installer-seed.json'] = dict(bytes=policy_file.stat().st_size, sha256=components.digest(policy_file))
    (output / 'payload-inspection.json').write_text(json.dumps(inspection, indent=2), encoding='utf-8')
    print(json.dumps(dict(files=len(inspection), bytes=sum(f['bytes'] for f in inspection.values()))))


if __name__ == '__main__':
    main()
