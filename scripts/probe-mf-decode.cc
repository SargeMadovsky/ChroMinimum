// Isolated Windows Media Foundation probe. Not linked into the browser.
#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <mftransform.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwchar>

using Microsoft::WRL::ComPtr;
struct Failure { HRESULT hr; const char* stage; };
static void Check(HRESULT hr, const char* stage) {
  if (FAILED(hr)) throw Failure{hr, stage};
}

static void Decode(const wchar_t* path, bool audio) {
  ComPtr<IMFAttributes> attributes;
  Check(MFCreateAttributes(&attributes, 2), "attributes");
  Check(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, FALSE), "hardware_policy");
  Check(attributes->SetUINT32(MF_SOURCE_READER_DISABLE_DXVA, TRUE), "dxva_policy");
  ComPtr<IMFSourceReader> reader;
  Check(MFCreateSourceReaderFromURL(path, attributes.Get(), &reader), "open_source");
  const DWORD stream = audio ? MF_SOURCE_READER_FIRST_AUDIO_STREAM : MF_SOURCE_READER_FIRST_VIDEO_STREAM;
  Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE), "deselect");
  Check(reader->SetStreamSelection(stream, TRUE), "select");
  ComPtr<IMFMediaType> native;
  Check(reader->GetNativeMediaType(stream, 0, &native), "native_type");
  GUID subtype{};
  Check(native->GetGUID(MF_MT_SUBTYPE, &subtype), "native_subtype");
  if (subtype != (audio ? MFAudioFormat_AAC : MFVideoFormat_H264))
    throw Failure{MF_E_INVALIDMEDIATYPE, "unexpected_input_codec"};
  ComPtr<IMFMediaType> target;
  Check(MFCreateMediaType(&target), "output_type");
  Check(target->SetGUID(MF_MT_MAJOR_TYPE, audio ? MFMediaType_Audio : MFMediaType_Video), "output_major");
  Check(target->SetGUID(MF_MT_SUBTYPE, audio ? MFAudioFormat_PCM : MFVideoFormat_NV12), "output_subtype");
  if (audio) Check(target->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "pcm_bits");
  Check(reader->SetCurrentMediaType(stream, nullptr, target.Get()), "configure_decoder");
  ComPtr<IMFMediaType> actual;
  Check(reader->GetCurrentMediaType(stream, &actual), "actual_type");
  GUID output{};
  Check(actual->GetGUID(MF_MT_SUBTYPE, &output), "actual_subtype");
  if (output != (audio ? MFAudioFormat_PCM : MFVideoFormat_NV12))
    throw Failure{MF_E_INVALIDMEDIATYPE, "unexpected_output_codec"};
  UINT32 channels=0, rate=0, bits=0, width=0, height=0;
  if (audio) {
    Check(actual->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels), "channels");
    Check(actual->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate), "sample_rate");
    Check(actual->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits), "actual_bits");
    if (!channels || !rate || bits != 16) throw Failure{MF_E_INVALIDMEDIATYPE, "invalid_pcm"};
  } else {
    Check(MFGetAttributeSize(actual.Get(), MF_MT_FRAME_SIZE, &width, &height), "frame_size");
  }
  uint64_t samples=0, bytes=0, nonzero=0, checksum=14695981039346656037ULL;
  int peak=0;
  LONGLONG first=-1, last=-1;
  bool eos=false;
  const auto start=GetTickCount64();
  for (unsigned iteration=0; iteration<10000; ++iteration) {
    if (GetTickCount64()-start>30000) throw Failure{HRESULT_FROM_WIN32(ERROR_TIMEOUT), "read_deadline"};
    DWORD index=0, flags=0;
    LONGLONG timestamp=0;
    ComPtr<IMFSample> sample;
    Check(reader->ReadSample(stream, 0, &index, &flags, &timestamp, &sample), "read_sample");
    if (flags & MF_SOURCE_READERF_ERROR) throw Failure{E_FAIL, "reader_error"};
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED)
      throw Failure{MF_E_INVALIDMEDIATYPE, "unexpected_format_change"};
    if (sample) {
      ComPtr<IMFMediaBuffer> buffer;
      Check(sample->ConvertToContiguousBuffer(&buffer), "buffer");
      BYTE* data=nullptr; DWORD length=0;
      Check(buffer->Lock(&data, nullptr, &length), "lock_buffer");
      for (DWORD n=0;n<length;++n) {
        nonzero += data[n]!=0;
        checksum=(checksum ^ data[n])*1099511628211ULL;
      }
      if (audio) for (DWORD n=0;n+1<length;n+=2) {
        const int value=static_cast<int16_t>(static_cast<unsigned>(data[n]) | (static_cast<unsigned>(data[n+1])<<8));
        peak=std::max(peak, value<0 ? -value : value);
      }
      Check(buffer->Unlock(), "unlock_buffer");
      if (length) { ++samples; bytes+=length; if (first<0) first=timestamp; last=timestamp; }
    }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { eos=true; break; }
  }
  if (!eos || samples<2 || !nonzero || last<=first || (audio && !peak))
    throw Failure{E_FAIL, "insufficient_decoded_data"};
  // Inspect the actual decoder returned by SourceReader, rather than merely
  // enumerating available registrations. The vtable address identifies its DLL.
  ComPtr<IMFSourceReaderEx> extended;
  Check(reader.As(&extended), "extended_reader");
  ComPtr<IMFTransform> decoder;
  GUID category{};
  Check(extended->GetTransformForStream(stream, 0, &category, &decoder), "selected_decoder");
  if (category != (audio ? MFT_CATEGORY_AUDIO_DECODER : MFT_CATEGORY_VIDEO_DECODER))
    throw Failure{E_FAIL, "unexpected_transform_category"};
  const auto vtable=*reinterpret_cast<void***>(decoder.Get());
  HMODULE module=nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCWSTR>(vtable[0]), &module))
    throw Failure{HRESULT_FROM_WIN32(GetLastError()), "decoder_module"};
  wchar_t module_path[MAX_PATH]{}, system_path[MAX_PATH]{};
  const DWORD module_length=GetModuleFileNameW(module, module_path, MAX_PATH);
  const UINT system_length=GetSystemDirectoryW(system_path, MAX_PATH);
  if (!module_length || module_length>=MAX_PATH || !system_length || system_length>=MAX_PATH)
    throw Failure{E_FAIL, "module_path"};
  const bool in_system=_wcsnicmp(module_path,system_path,system_length)==0 && module_path[system_length]==L'\\';
  const wchar_t* basename=std::wcsrchr(module_path,L'\\');
  basename=basename ? basename+1 : module_path;
  char module_name[MAX_PATH]{};
  for (size_t n=0;basename[n] && n<MAX_PATH-1;++n) {
    const wchar_t c=basename[n];
    module_name[n]=(c>=L'a' && c<=L'z') || (c>=L'A' && c<=L'Z') ||
                   (c>=L'0' && c<=L'9') || c==L'.' || c==L'_' || c==L'-' ? static_cast<char>(c) : '_';
  }
  std::printf("{\"passed\":true,\"input\":\"%s\",\"output\":\"%s\",\"samples\":%llu,\"bytes\":%llu,\"nonzero_bytes\":%llu,\"checksum_fnv64\":\"%016llx\",\"first_100ns\":%lld,\"last_100ns\":%lld,\"channels\":%u,\"sample_rate\":%u,\"bits\":%u,\"pcm_peak\":%.8f,\"pcm_frames\":%llu,\"width\":%u,\"height\":%u,\"eos\":true,\"hardware_transforms_enabled\":false,\"dxva_disabled\":true,\"decoder_module\":\"%s\",\"decoder_in_system_directory\":%s}\n",
    audio?"AAC":"H264",audio?"PCM16":"NV12",samples,bytes,nonzero,checksum,first,last,
    channels,rate,bits,peak/32768.0,audio?bytes/(2*channels):0,width,height,module_name,in_system?"true":"false");
}

int wmain(int argc, wchar_t** argv) {
  if (argc!=3 || (std::wcscmp(argv[1], L"aac") && std::wcscmp(argv[1], L"h264")) ||
      std::wcslen(argv[2])<3 || argv[2][1]!=L':' || GetFileAttributesW(argv[2])==INVALID_FILE_ATTRIBUTES) {
    std::puts("{\"passed\":false,\"stage\":\"usage_or_missing_local_file\"}"); return 2;
  }
  HRESULT hr=CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return 3;
  hr=MFStartup(MF_VERSION, MFSTARTUP_FULL);
  if (FAILED(hr)) { CoUninitialize(); return 4; }
  int result=0;
  try { Decode(argv[2], std::wcscmp(argv[1], L"aac")==0); }
  catch (const Failure& error) {
    std::printf("{\"passed\":false,\"stage\":\"%s\",\"hresult\":\"0x%08lx\"}\n", error.stage, static_cast<unsigned long>(error.hr)); result=1;
  }
  MFShutdown(); CoUninitialize(); return result;
}
