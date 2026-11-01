"""Offline regression checks; all runtime and profile data are synthetic."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'media_stage', Path(__file__).with_name('stage-media-experiment.py'))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cm-media-stage-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.distribution = self.root / 'distribution'
        self.adapter = self.root / 'adapter'
        self.output = self.root / 'output'
        names = ['CREDITS.html']
        names += ['Release/' + name for name in (
            'bootstrap.exe', 'libcef.dll', 'chrome_elf.dll', 'd3dcompiler_47.dll',
            'v8_context_snapshot.bin', 'vk_swiftshader.dll',
            'vk_swiftshader_icd.json', 'vulkan-1.dll')]
        names += ['Resources/' + name for name in (
            'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat')]
        names += [f'Resources/locales/{locale}{suffix}.pak'
                  for locale in ('ru', 'en-US')
                  for suffix in ('', '_FEMININE', '_MASCULINE', '_NEUTER')]
        for name in names:
            self.write(self.distribution / name, name.encode())
        for name in ('chrominimum.dll', 'chrominimum.exe.manifest'):
            self.write(self.adapter / name, name.encode())
        self.write(self.adapter / 'profile/passwords', b'must not copy')

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def build(self, output=None):
        return stage.stage(self.distribution, self.adapter, output or self.output)

    def test_contents_and_hashes(self):
        manifest = self.build()
        self.assertEqual(manifest['status'], 'staged_not_validated')
        self.assertEqual(len(manifest['files']), 23)
        actual = {p.relative_to(self.output / 'runtime').as_posix()
                  for p in (self.output / 'runtime').rglob('*') if p.is_file()}
        self.assertEqual(actual, set(manifest['files']))
        for name, entry in manifest['files'].items():
            data = (self.output / 'runtime' / name).read_bytes()
            self.assertEqual(data, Path(entry['source']).read_bytes())
            self.assertEqual(entry['bytes'], len(data))
            self.assertEqual(entry['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual((self.output / 'runtime/chrominimum.exe').read_bytes(),
                         b'Release/bootstrap.exe')

    def test_optional_dxc_pair_is_copied(self):
        for name in ('dxcompiler.dll', 'dxil.dll'):
            self.write(self.distribution / 'Release' / name, b'optional')
        self.assertEqual(len(self.build()['files']), 25)

    def test_missing_and_empty_inputs_leave_no_output(self):
        source = self.distribution / 'Release/libcef.dll'
        source.unlink()
        for data in (None, b''):
            if data is not None:
                source.write_bytes(data)
            with self.assertRaises(ValueError):
                self.build()
            self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.write(self.output / 'sentinel', b'keep')
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(list(self.output.iterdir()), [self.output / 'sentinel'])
        self.assertEqual((self.output / 'sentinel').read_bytes(), b'keep')

    def test_overlapping_and_parent_segment_paths_are_rejected(self):
        for output in (self.distribution / 'out', self.adapter / 'out',
                       self.root / 'missing/../output'):
            with self.subTest(output=output), self.assertRaises(ValueError):
                self.build(output)
        self.assertFalse((self.distribution / 'out').exists())
        self.assertFalse((self.adapter / 'out').exists())
        self.assertFalse((self.root / 'missing').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows junction regression')
    def test_output_through_junction_is_rejected_before_writes(self):
        target = self.root / 'target'
        target.mkdir()
        link = self.root / 'junction'
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.addCleanup(link.rmdir)
        with self.assertRaisesRegex(ValueError, 'Reparse point or symlink'):
            self.build(link / 'new-parent/output')
        self.assertEqual(list(target.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
