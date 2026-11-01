"""Brand the pinned downloads WebUI resource; never alters DLLs or the input PAK."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-src', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    policy = json.loads((repo / 'patches/chromium/downloads-branding-154.json').read_text())
    if args.output.exists():
        raise ValueError('Output must be new')
    original = args.input.read_bytes()
    if sha(original) != policy['resources_pak_sha256']:
        raise ValueError('Unknown resource package; review the pinned inputs')
    logo = (repo / 'assets/chrominimum.svg').read_bytes()
    if sha(logo) != policy['logo_sha256']:
        raise ValueError('Logo differs from reviewed asset')
    # Downloads BUILD.gn does not enable generate_code_cache in this pinned
    # source. Refuse a recipe that adds it instead of leaving stale bytecode.
    build = (args.chromium_src / 'chrome/browser/resources/downloads/BUILD.gn').read_text()
    if 'generate_code_cache' in build:
        raise ValueError('Downloads code-cache configuration needs review')
    sys.path.insert(0, str(args.chromium_src / 'tools/grit'))
    from grit.format import data_pack
    pack = data_pack.ReadDataPackFromString(original)
    resource_id = policy['resource_id']
    if len(pack.resources) != policy['resource_count'] or sha(pack.resources[resource_id]) != policy['resource_sha256']:
        raise ValueError('Downloads resource identity mismatch')
    script = gzip.decompress(pack.resources[resource_id]).decode('utf-8')
    newline = '\n'
    prefix = '    @search-changed="${this.onSearchChanged_}">' + newline
    following = '  <cr-button id="clearAll"'
    needle = prefix + following
    if script.count(needle) != 1:
        raise ValueError('Downloads toolbar template needs review')
    image = ('  <img slot="product-logo" id="chrominimum-downloads-logo" '
             'alt="ChroMinimum" width="32" height="32" '
             'style="margin-inline-end:16px" src="data:image/svg+xml;base64,'
             + base64.b64encode(logo).decode('ascii') + '">' + newline)
    replacement = script.replace(needle, prefix + image + following).encode('utf-8')
    resources = dict(pack.resources)
    resources[resource_id] = gzip.compress(replacement, compresslevel=9, mtime=0)
    result = data_pack.WriteDataPackToString(resources, pack.encoding)
    checked = data_pack.ReadDataPackFromString(result)
    changed = [key for key in pack.resources if pack.resources[key] != checked.resources[key]]
    if set(pack.resources) != set(checked.resources) or changed != [resource_id]:
        raise ValueError('Unexpected resource changes')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    report = dict(input_sha256=sha(original), output_sha256=sha(result),
                  changed_resource_ids=changed, resource_count=len(resources),
                  logo_sha256=sha(logo), size_delta_bytes=len(result)-len(original),
                  runtime_validated=False, code_cache_generated=False)
    args.output.with_suffix('.branding.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
