import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('plan', ROOT / 'scripts/prepare-platform-codecs-check.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)

class Guards(unittest.TestCase):
    def test_valid_flags(self):
        plan.validate_args({**plan.OVERRIDES, 'is_debug':'false', 'target_cpu':'"x64"'})
    def test_reject_each_unsafe_variant(self):
        for key in plan.OVERRIDES:
            with self.subTest(key=key), self.assertRaises(ValueError):
                plan.validate_args({**plan.OVERRIDES, key:'wrong', 'is_debug':'false', 'target_cpu':'"x64"'})
    def test_duplicate_argument(self):
        with self.assertRaises(ValueError):plan.parse_args('ffmpeg_branding="Chromium"\nffmpeg_branding="Chrome"')
    def test_config_and_registry(self):
        config='\n'.join('#define '+name+' 0' for name in ['CONFIG_AAC_DECODER','CONFIG_AAC_FIXED_DECODER','CONFIG_H264_DECODER','CONFIG_LIBOPENH264_DECODER'])
        self.assertEqual(plan.inspect_ffmpeg(config,'&ff_flac_decoder, &ff_libopus_decoder')['registered_codecs'],['flac_decoder','libopus_decoder'])
        with self.assertRaises(ValueError):plan.inspect_ffmpeg(config.replace('CONFIG_AAC_DECODER 0','CONFIG_AAC_DECODER 1'),'&ff_flac_decoder')
        with self.assertRaises(ValueError):plan.inspect_ffmpeg(config,'&ff_h264_decoder')
        with self.assertRaises(ValueError):plan.inspect_ffmpeg('', '&ff_flac_decoder')

if __name__=='__main__':unittest.main()
