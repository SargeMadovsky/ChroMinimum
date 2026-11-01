"""Synthetic acceptance and refusal cases for the offline media report checker."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('check-media-report.py')
spec = importlib.util.spec_from_file_location('media_report', SCRIPT)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cm-media-report-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rows = [dict(file=name, status='playing', currentTime=0.5,
                          decodedFrames=15, readyState=4, error=None, playError=None)
                     for name in ('bear-1280x720.mp4', 'bear-vp9-opus.webm')]
        self.rows.append(dict(file='bear-audio-lc-aac.aac', status='decoded',
                              decodedAudioFrames=44100, audioChannels=2,
                              audioSampleRate=44100, audioPeak=0.25, error=None))
        (self.root / 'smoke.log').write_text('browser_created\nshutdown_complete\n')

    def check(self, rows=None):
        (self.root / 'playback.json').write_text(json.dumps(self.rows if rows is None else rows))
        return report.check(self.root)

    def test_complete_evidence_passes(self):
        self.assertTrue(self.check()['passed'])

    def test_missing_duplicate_or_malformed_observations_fail(self):
        for rows in (self.rows[:2], self.rows + [self.rows[0]], {}, [None]):
            with self.subTest(rows=rows):
                self.assertFalse(self.check(rows)['passed'])

    def test_timeouts_errors_and_no_frames_fail(self):
        for patch in ({'status': 'timeout'}, {'decodedFrames': 0},
                      {'currentTime': 0}, {'error': {'code': 4}},
                      {'playError': 'NotAllowedError'}, {'readyState': 0}):
            rows = copy.deepcopy(self.rows)
            rows[0].update(patch)
            with self.subTest(patch=patch):
                self.assertFalse(self.check(rows)['passed'])

    def test_aac_requires_non_silent_pcm_and_finite_numbers(self):
        for field in ('decodedAudioFrames', 'audioChannels', 'audioSampleRate', 'audioPeak'):
            for value in (None, 0, -1, True, '44100', float('nan'), float('inf')):
                rows = copy.deepcopy(self.rows)
                rows[2][field] = value
                with self.subTest(field=field, value=value):
                    self.assertFalse(self.check(rows)['passed'])

    def test_missing_corrupt_evidence_and_false_shutdown_marker_fail(self):
        self.assertFalse(report.check(self.root)['passed'])
        (self.root / 'playback.json').write_text('{')
        self.assertFalse(report.check(self.root)['passed'])
        for text in ('', 'not_shutdown_complete', 'shutdown_complete_extra'):
            (self.root / 'smoke.log').write_text(text)
            self.assertFalse(self.check()['passed'])

    def test_cli_exit_codes(self):
        self.check()
        passed = subprocess.run([sys.executable, str(SCRIPT), str(self.root)],
                                capture_output=True, text=True)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertTrue(json.loads(passed.stdout)['passed'])
        self.check(self.rows[:2])
        failed = subprocess.run([sys.executable, str(SCRIPT), str(self.root)],
                                capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1, failed.stderr)
        self.assertFalse(json.loads(failed.stdout)['passed'])


if __name__ == '__main__':
    unittest.main()
