// Direct raw-AAC MFT probe, matching Chromium GetAacAudioType's input layout.
// Test-only process; never linked into ChroMinimum.
#define NOMINMAX
#include <windows.h>
#include <mmreg.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <mftransform.h>
#include <wrl/client.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>
using Microsoft::WRL::ComPtr;
struct Failure { HRESULT hr; const char* stage; };
static void Check(HRESULT hr, const char* stage) { if (FAILED(hr)) throw Failure{hr,stage}; }

struct Frame { size_t offset; size_t length; };
static void Decode(const wchar_t* path) {
  std::ifstream input(path,std::ios::binary);
  std::vector<BYTE> bytes{std::istreambuf_iterator<char>(input),std::istreambuf_iterator<char>()};
  if (bytes.size()<7 || bytes.size()>1024*1024) throw Failure{E_INVALIDARG,"file_size"};
  std::vector<Frame> frames;
  for (size_t at=0;at<bytes.size();) {
    if (bytes.size()-at<7 || bytes[at]!=0xff || (bytes[at+1]&0xf6)!=0xf0)
      throw Failure{E_INVALIDARG,"adts_sync"};
    const unsigned object_type=(bytes[at+2]>>6)+1;
    const unsigned frequency=(bytes[at+2]>>2)&15;
    const unsigned channels=((bytes[at+2]&1)<<2)|(bytes[at+3]>>6);
    if (object_type!=2 || frequency!=3 || channels!=2 || (bytes[at+6]&3)!=0)
      throw Failure{E_INVALIDARG,"fixture_not_lc_48000_stereo_single_block"};
    const size_t header=(bytes[at+1]&1)?7:9;
    const size_t length=((bytes[at+3]&3)<<11)|(bytes[at+4]<<3)|(bytes[at+5]>>5);
    if (length<=header || length>bytes.size()-at) throw Failure{E_INVALIDARG,"adts_length"};
    frames.push_back({at+header,length-header});at+=length;
  }
  MFT_REGISTER_TYPE_INFO registration{MFMediaType_Audio,MFAudioFormat_AAC};
  IMFActivate** activations=nullptr; UINT32 count=0;
  Check(MFTEnumEx(MFT_CATEGORY_AUDIO_DECODER,MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT |
      MFT_ENUM_FLAG_SORTANDFILTER,&registration,nullptr,&activations,&count),"enumerate");
  if (!count) { CoTaskMemFree(activations); throw Failure{MF_E_TOPO_CODEC_NOT_FOUND,"no_decoder"}; }
  ComPtr<IMFTransform> decoder;
  HRESULT hr=activations[0]->ActivateObject(IID_PPV_ARGS(&decoder));
  for (UINT32 n=0;n<count;++n) activations[n]->Release();
  CoTaskMemFree(activations);Check(hr,"activate");
  const auto vtable=*reinterpret_cast<void***>(decoder.Get()); HMODULE module=nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(vtable[0]),&module) || module!=GetModuleHandleW(L"MSAudDecMFT.dll"))
    throw Failure{E_FAIL,"unexpected_decoder_module"};
  wchar_t module_path[MAX_PATH]{},system[MAX_PATH]{};
  const DWORD path_length=GetModuleFileNameW(module,module_path,MAX_PATH);
  const UINT system_length=GetSystemDirectoryW(system,MAX_PATH);
  if (!path_length || path_length>=MAX_PATH || !system_length || system_length>=MAX_PATH ||
      _wcsnicmp(module_path,system,system_length)!=0 || module_path[system_length]!=L'\\')
    throw Failure{E_FAIL,"decoder_not_system_directory"};
  // Same HEAACWAVEINFO + AudioSpecificConfig construction as pinned Chromium.
  std::vector<BYTE> wave(sizeof(HEAACWAVEINFO)+2,0);
  auto* aac=reinterpret_cast<HEAACWAVEINFO*>(wave.data());
  aac->wfx.wFormatTag=WAVE_FORMAT_MPEG_HEAAC;
  aac->wfx.nChannels=2;aac->wfx.wBitsPerSample=32;aac->wfx.nSamplesPerSec=48000;
  aac->wfx.nAvgBytesPerSec=48000*8;aac->wfx.nBlockAlign=1;
  aac->wfx.cbSize=static_cast<WORD>(wave.size()-sizeof(WAVEFORMATEX));
  aac->wPayloadType=0;aac->wAudioProfileLevelIndication=0xfe;aac->wStructType=0;
  wave[sizeof(HEAACWAVEINFO)]=0x11;wave[sizeof(HEAACWAVEINFO)+1]=0x90; // LC/48k/stereo
  ComPtr<IMFMediaType> type;
  Check(MFCreateMediaType(&type),"input_type");
  Check(MFInitMediaTypeFromWaveFormatEx(type.Get(),&aac->wfx,static_cast<UINT32>(wave.size())),"input_wave");
  Check(decoder->SetInputType(0,type.Get(),0),"set_raw_input");
  ComPtr<IMFSample> output_sample;ComPtr<IMFMediaBuffer> output_buffer;
  const auto configure=[&]() {
    for (DWORD n=0;n<64;++n) {
      ComPtr<IMFMediaType> output;Check(decoder->GetOutputAvailableType(0,n,&output),"output_type");
      GUID subtype{};Check(output->GetGUID(MF_MT_SUBTYPE,&subtype),"output_subtype");
      UINT32 channels=0,rate=0;
      if (subtype!=MFAudioFormat_Float) continue;
      Check(output->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS,&channels),"output_channels");
      Check(output->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND,&rate),"output_rate");
      if (channels!=2 || rate!=48000) continue;
      Check(decoder->SetOutputType(0,output.Get(),0),"set_float_output");
      MFT_OUTPUT_STREAM_INFO info{};Check(decoder->GetOutputStreamInfo(0,&info),"output_stream_info");
      if (!info.cbSize || info.cbSize>16*1024*1024) throw Failure{E_FAIL,"output_buffer_size"};
      output_sample.Reset();output_buffer.Reset();
      Check(MFCreateSample(&output_sample),"output_sample");
      Check(MFCreateAlignedMemoryBuffer(info.cbSize,info.cbAlignment?info.cbAlignment-1:0,&output_buffer),"output_buffer");
      Check(output_sample->AddBuffer(output_buffer.Get()),"output_add_buffer");return;
    }
    throw Failure{MF_E_INVALIDMEDIATYPE,"no_matching_float_output"};
  };
  configure();
  Check(decoder->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,0),"begin_streaming");
  Check(decoder->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM,0),"start_stream");
  uint64_t output_bytes=0,output_samples=0,nonzero=0;double peak=0;
  const auto pump=[&]() {
    for (unsigned n=0;n<2048;++n) {
      Check(output_buffer->SetCurrentLength(0),"clear_output");
      MFT_OUTPUT_DATA_BUFFER data{};data.pSample=output_sample.Get();DWORD status=0;
      const HRESULT result=decoder->ProcessOutput(0,1,&data,&status);
      if (data.pEvents) data.pEvents->Release();
      if (result==MF_E_TRANSFORM_NEED_MORE_INPUT) return;
      if (result==MF_E_TRANSFORM_STREAM_CHANGE) { configure();continue; }
      Check(result,"process_output");
      BYTE* pcm=nullptr;DWORD length=0;Check(output_buffer->Lock(&pcm,nullptr,&length),"lock_pcm");
      bool valid=length%8==0;
      for (DWORD i=0;i+3<length;i+=4) {
        float value=0;std::memcpy(&value,pcm+i,4);
        if (!std::isfinite(value)) valid=false;
        else { peak=std::max(peak,std::abs(static_cast<double>(value)));nonzero+=value!=0; }
      }
      Check(output_buffer->Unlock(),"unlock_pcm");
      if (!valid) throw Failure{E_FAIL,"invalid_float_pcm"};
      output_bytes+=length;output_samples+=length!=0;
    }
    throw Failure{E_FAIL,"output_loop_limit"};
  };
  for (size_t n=0;n<frames.size();++n) {
    const auto frame=frames[n];ComPtr<IMFSample> sample;ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateSample(&sample),"input_sample");
    Check(MFCreateMemoryBuffer(static_cast<DWORD>(frame.length),&buffer),"input_buffer");
    BYTE* destination=nullptr;Check(buffer->Lock(&destination,nullptr,nullptr),"input_lock");
    std::memcpy(destination,bytes.data()+frame.offset,frame.length);Check(buffer->Unlock(),"input_unlock");
    Check(buffer->SetCurrentLength(static_cast<DWORD>(frame.length)),"input_length");
    Check(sample->AddBuffer(buffer.Get()),"input_add_buffer");
    Check(sample->SetSampleTime(static_cast<LONGLONG>(n)*1024*10000000/48000),"input_timestamp");
    Check(sample->SetSampleDuration(1024LL*10000000/48000),"input_duration");
    hr=decoder->ProcessInput(0,sample.Get(),0);
    if (hr==MF_E_NOTACCEPTING) { pump();hr=decoder->ProcessInput(0,sample.Get(),0); }
    Check(hr,"process_raw_input");pump();
  }
  Check(decoder->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN,0),"drain");pump();
  if (!output_samples || !nonzero || peak<=0) throw Failure{E_FAIL,"silent_or_empty_output"};
  std::printf("{\"passed\":true,\"input\":\"raw_AAC_LC\",\"asc_hex\":\"1190\",\"adts_headers_stripped\":true,\"input_packets\":%zu,\"output\":\"float32\",\"channels\":2,\"sample_rate\":48000,\"pcm_frames\":%llu,\"output_samples\":%llu,\"nonzero_values\":%llu,\"peak\":%.8f,\"drained\":true,\"decoder_module\":\"MSAudDecMFT.dll\",\"decoder_in_system_directory\":true}\n",frames.size(),output_bytes/8,output_samples,nonzero,peak);
}

int wmain(int argc,wchar_t** argv) {
  if (argc!=2 || std::wcslen(argv[1])<3 || argv[1][1]!=L':') return 2;
  HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if (FAILED(hr)) return 3;
  hr=MFStartup(MF_VERSION);if (FAILED(hr)) {CoUninitialize();return 4;}
  int result=0;
  try {Decode(argv[1]);} catch (const Failure& e) {
    std::printf("{\"passed\":false,\"stage\":\"%s\",\"hresult\":\"0x%08lx\"}\n",e.stage,static_cast<unsigned long>(e.hr));result=1;
  }
  MFShutdown();CoUninitialize();return result;
}
