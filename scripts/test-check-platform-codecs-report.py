import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('check', ROOT / 'scripts/check-platform-codecs-report.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class Evidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root/'effective-args.txt').write_text('\n'.join(k+'='+v for k,v in {**checker.plan.OVERRIDES,'is_debug':'false','target_cpu':'"x64"'}.items()))
        (self.root/'ffmpeg-config_components.h').write_text('\n'.join('#define '+n+' 0' for n in ['CONFIG_AAC_DECODER','CONFIG_AAC_FIXED_DECODER','CONFIG_H264_DECODER','CONFIG_LIBOPENH264_DECODER']))
        (self.root/'ffmpeg-codec_list.c').write_text('&ff_flac_decoder, &ff_libopus_decoder')
        (self.root/'ffmpeg-includes.json').write_text('["//third_party/ffmpeg/chromium/config/Chromium/win/x64"]')
        self.rows=[{'file':n,'ended':True,'status':'playing','error':None,'playError':None,'decodedFrames':82,'currentTime':2.7,'visibility':'visible'} for n in ['bear-1280x720.mp4','bear-vp9-opus.webm']]
        self.rows.append({'file':'bear-audio-lc-aac.aac','status':'error','error':{'name':'EncodingError'},'decodedAudioFrames':0})
        self.selection={'players':[{'kAudioTracks':'[{"codec":"aac"}]','kAudioDecoderName':'MediaFoundationAudioDecoder','kVideoDecoderName':'D3D11VideoDecoder','kIsPlatformAudioDecoder':'true'}]}
        self.tokens=[{'Role':role,'Error':0,'Restricted':role!='browser','IntegrityRid':rid} for role,rid in [('browser',8192),('gpu-process',4096),('renderer',0)]]
        self.tokens.append({'Role':'utility','Subtype':'network.mojom.NetworkService','Error':0,'AppContainer':1,'IntegrityRid':4096,'SandboxType':'network'})
        (self.root/'smoke.log').write_text('shutdown_complete\n')
        self.write()
    def tearDown(self):self.temp.cleanup()
    def write(self):
        for name,value in [('playback',self.rows),('platform-selection',self.selection),('tokens',self.tokens)]:
            (self.root/(name+'.json')).write_text(json.dumps(value))
    def test_candidate_behavior(self):
        result=checker.check(self.root);self.assertTrue(result['passed'],result);self.assertFalse(result['binary_absence_proven'])
    def test_fallback_refused(self):
        self.selection['players'][0]['kAudioDecoderName']='FFmpegAudioDecoder';self.write();self.assertFalse(checker.check(self.root)['passed'])
    def test_unexpected_webaudio_success(self):
        self.rows[-1].update(status='decoded',error=None,decodedAudioFrames=100);self.write();self.assertFalse(checker.check(self.root)['passed'])
    def test_infinite_progress_refused(self):
        self.rows[0]['currentTime']=float('inf');self.write();self.assertFalse(checker.check(self.root)['passed'])
    def test_admin_refused(self):
        self.tokens[0]['IntegrityRid']=12288;self.write();self.assertFalse(checker.check(self.root)['passed'])
    def test_sandbox_refused(self):
        self.tokens[-1]['AppContainer']=0;self.write();self.assertFalse(checker.check(self.root)['passed'])
    def test_missing_evidence(self):
        (self.root/'ffmpeg-codec_list.c').unlink();self.assertFalse(checker.check(self.root)['passed'])
    def test_old_config_refused(self):
        (self.root/'effective-args.txt').write_text('ffmpeg_branding="Chrome"');self.assertFalse(checker.check(self.root)['passed'])


if __name__=='__main__':unittest.main()
