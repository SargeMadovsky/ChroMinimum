"""Validate patch preconditions, idempotence and rejection of changed source."""
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHES = [ROOT / ('patches/chromium/'+name+'.patch') for name in ('0012-cef-native-external-protocols','0013-cef-explicit-numeric-protocol')]


class NativeProtocolPatch(unittest.TestCase):
    def test_apply_reapply_and_reject_changed_input(self):
        for patch in PATCHES:
            with self.subTest(patch=patch.name):
                policy = json.loads(patch.with_suffix('.json').read_text(encoding='utf-8'))
                relative = next(iter(policy['files']))
                source = Path('E:/cm-platform154/chromium/src') / relative
                if not source.exists():
                    self.skipTest('Pinned local Chromium checkout unavailable')
                content = source.read_bytes().replace(b'\r\n', b'\n')
                identity = policy['files'][relative]
                self.assertIn(hashlib.sha256(content).hexdigest(), identity.values())
                with tempfile.TemporaryDirectory(prefix='native-protocol-patch-') as tmp:
                    target = Path(tmp) / relative
                    target.parent.mkdir(parents=True)
                    target.write_bytes(content)
                    if hashlib.sha256(content).hexdigest() == identity['after_sha256']:
                        subprocess.run(['git','apply','--reverse','-'],cwd=tmp,input=patch.read_bytes().replace(b'\r\n', b'\n'),check=True)
                    command = ['python',str(ROOT/'scripts/apply-native-external-protocols.py'),'--chromium-src',tmp,'--patch',patch.name[:4]]
                    subprocess.run(command,check=True,capture_output=True)
                    first = target.read_bytes()
                    subprocess.run(command,check=True,capture_output=True)
                    self.assertEqual(first,target.read_bytes())
                    changed = first+b'\n// unexpected upstream change\n'
                    target.write_bytes(changed)
                    result = subprocess.run(command,capture_output=True)
                    self.assertNotEqual(result.returncode,0)
                    self.assertIn(b'Unexpected source',result.stderr)
                    self.assertEqual(target.read_bytes(),changed)



if __name__ == '__main__':
    unittest.main()
