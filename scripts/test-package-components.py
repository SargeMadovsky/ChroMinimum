"""Offline packaging checks using synthetic files, never a user profile."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('component_packager', Path(__file__).with_name('package-components.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cm-packaging-')
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.licenses = self.root / 'licenses.html'
        self.licenses.write_text('Synthetic license fixture')
        for name in packager.RUNTIME | set().union(*(packager.locale_names(x) for x in packager.LOCALES)):
            file = self.bundle / name
            file.parent.mkdir(exist_ok=True)
            file.write_bytes(name.encode())
        for name in ('secret.pdb', 'CMakeLists.txt', 'profile/passwords', 'locales/de.pak'):
            file = self.bundle / name
            file.parent.mkdir(exist_ok=True)
            file.write_text('must not ship')

    def tearDown(self):
        self.temp.cleanup()

    def build(self, name='out', **changes):
        args = dict(bundle=self.bundle, output=self.root / name, sequence=1, min_safe=0,
                    engine='154.0.34', tag='test', licenses=self.licenses, issued=1000)
        args.update(changes)
        return packager.build(**args)

    def test_split_contents_and_reproducible_archives(self):
        first, second = self.build(), self.build('again')
        self.assertEqual(first, second)
        seen = set()
        for package in first['packages']:
            path = self.root / 'out' / package['url'].rsplit('/', 1)[1]
            self.assertEqual(packager.digest(path), package['sha256'])
            self.assertEqual(path.stat().st_size, package['size'])
            with tarfile.open(path) as archive:
                names = set(archive.getnames())
                self.assertFalse(names & seen)
                seen.update(names)
                if package['component']['kind'] == 'locale':
                    self.assertEqual(names, packager.locale_names(package['component']['locale']))
                else:
                    self.assertFalse(any(n.startswith('locales/') for n in names))
                    self.assertTrue(packager.RUNTIME <= names)
                    self.assertIn('LICENSES-RUST.html', names)
        self.assertFalse({'secret.pdb', 'CMakeLists.txt', 'profile/passwords', 'locales/de.pak'} & seen)

    def test_missing_input_fails_before_output_creation(self):
        (self.bundle / 'locales/ru.pak').unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.build()
        self.assertFalse((self.root / 'out').exists())

    def test_existing_output_is_not_overwritten(self):
        out = self.root / 'out'
        out.mkdir()
        (out / 'sentinel').write_text('keep')
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual((out / 'sentinel').read_text(), 'keep')

    def test_archive_inspector_rejects_extra_duplicate_and_traversal_entries(self):
        expected = {'locales/ru.pak': self.bundle / 'locales/ru.pak'}
        for names in [('evil.dll',), ('../ru.pak',), ('locales/ru.pak', 'locales/ru.pak')]:
            path = self.root / 'bad.tar.gz'
            with tarfile.open(path, 'w:gz') as archive:
                for name in names:
                    data = expected['locales/ru.pak'].read_bytes()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            with self.assertRaises(ValueError):
                packager.inspect(path, expected)

    def test_inspector_detects_content_mismatch_and_links(self):
        file = self.bundle / 'locales/ru.pak'
        expected = {'locales/ru.pak': file}
        path = self.root / 'payload.tar.gz'
        packager.archive(path, expected)
        file.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            packager.inspect(path, expected)
        path = self.root / 'link.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            info = tarfile.TarInfo('locales/ru.pak')
            info.type = tarfile.SYMTYPE
            info.linkname = '../outside'
            archive.addfile(info)
        with self.assertRaises(ValueError):
            packager.inspect(path, expected)

    def test_bad_release_parameters_are_rejected(self):
        for changes in [dict(sequence=0), dict(sequence=-1), dict(sequence=2**64), dict(min_safe=2),
                        dict(tag='../bad'), dict(tag='..'), dict(engine=''), dict(issued=-1)]:
            with self.assertRaises(ValueError):
                self.build(**changes)


if __name__ == '__main__':
    unittest.main()
