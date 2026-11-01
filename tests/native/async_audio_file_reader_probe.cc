// Standalone lifecycle probe for the experimental Chromium AudioFileReader API.
// Uses a delayed fake decoder: this does not prove AAC -> PCM decoding.
#include <cstdio>
#include <cmath>
#include <memory>
#include <vector>

#include "base/at_exit.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_executor.h"
#include "base/win/scoped_com_initializer.h"
#include "media/base/audio_bus.h"
#include "media/base/decoder_buffer.h"
#include "media/filters/audio_file_reader.h"
#include "media/filters/in_memory_url_protocol.h"
#include "media/filters/win/media_foundation_audio_decoder.h"

namespace {
struct Counts {
  int decodes = 0;
  int eos = 0;
};

class DelayedDecoder final : public media::AudioDecoder {
 public:
  DelayedDecoder(Counts* counts, bool disconnect)
      : counts_(counts), disconnect_(disconnect) {}
  media::AudioDecoderType GetDecoderType() const override {
    return media::AudioDecoderType::kTesting;
  }
  void Initialize(const media::AudioDecoderConfig&, media::CdmContext*,
                  InitCB callback, const OutputCB&,
                  const media::WaitingCB&) override {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(callback),
                                 media::DecoderStatus::Codes::kOk));
  }
  void Decode(scoped_refptr<media::DecoderBuffer> buffer,
              DecodeCB callback) override {
    ++counts_->decodes;
    if (buffer->end_of_stream()) ++counts_->eos;
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(callback),
            disconnect_ ? media::DecoderStatus::Codes::kDisconnected
                        : media::DecoderStatus::Codes::kOk));
  }
  void Reset(base::OnceClosure callback) override {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, std::move(callback));
  }
 private:
  raw_ptr<Counts> counts_;
  bool disconnect_;
};

void Probe(base::span<const uint8_t> bytes, bool disconnect, bool cancel_open,
           bool cancel_read) {
  media::InMemoryUrlProtocol protocol(bytes, false);
  auto reader = std::make_unique<media::AudioFileReader>(&protocol);
  Counts counts;
  int open_calls = 0;
  bool opened = false;
  reader->OpenAsync(std::make_unique<DelayedDecoder>(&counts, disconnect),
      base::BindOnce([](int* calls, bool* opened, bool ok) {
        ++*calls; *opened = ok;
      }, &open_calls, &opened));
  CHECK_EQ(open_calls, 0);
  if (cancel_open) reader.reset();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(open_calls, 1);
  CHECK_EQ(opened, !cancel_open);
  if (cancel_open) {
    CHECK_EQ(counts.decodes, 0);
    return;
  }
  int read_calls = 0;
  bool read_ok = false;
  reader->ReadAsync(base::BindOnce(
      [](int* calls, bool* success, bool ok,
         std::vector<std::unique_ptr<media::AudioBus>> packets) {
        ++*calls; *success = ok; CHECK(packets.empty());
      }, &read_calls, &read_ok));
  CHECK_EQ(read_calls, 0);
  if (cancel_read) reader.reset();
  base::RunLoop().RunUntilIdle();
  CHECK_EQ(read_calls, 1);
  CHECK_EQ(read_ok, !disconnect && !cancel_read);
  if (disconnect || cancel_read) {
    CHECK_EQ(counts.decodes, 1);
    CHECK_EQ(counts.eos, 0);
  } else {
    CHECK_GT(counts.decodes, 1);
    CHECK_EQ(counts.eos, 1);
  }
}

void ProbeMediaFoundation(base::span<const uint8_t> bytes, const char* label) {
  media::InMemoryUrlProtocol protocol(bytes, false);
  media::AudioFileReader reader(&protocol);
  bool opened = false;
  auto decoder = media::MediaFoundationAudioDecoder::Create();
  CHECK(decoder);
  reader.OpenAsync(std::move(decoder), base::BindOnce(
      [](bool* opened, bool ok) { *opened = ok; }, &opened));
  base::RunLoop().RunUntilIdle();
  CHECK(opened);
  bool done = false;
  int64_t frames = 0;
  float peak = 0;
  reader.ReadAsync(base::BindOnce(
      [](bool* done, int64_t* frames, float* peak, bool ok,
         std::vector<std::unique_ptr<media::AudioBus>> packets) {
        CHECK(ok);
        for (const auto& packet : packets) {
          CHECK_EQ(packet->channels(), 2);
          *frames += packet->frames();
          for (float sample : packet->channel(0)) {
            CHECK(std::isfinite(sample));
            *peak = std::max(*peak, std::abs(sample));
          }
        }
        *done = true;
      }, &done, &frames, &peak));
  base::RunLoop().RunUntilIdle();
  CHECK(done);
  CHECK_EQ(reader.sample_rate(), 48000);
  CHECK_EQ(frames, 134144);
  CHECK_GT(peak, 0.1f);
  CHECK_LT(peak, 0.11f);
  std::fprintf(stderr, "%s frames=%lld rate=48000 channels=2 peak=%.9f\n",
               label, static_cast<long long>(frames), peak);
}
}  // namespace

int main(int argc, char** argv) {
  base::AtExitManager exit;
  base::CommandLine::Init(argc, argv);
  const auto arguments = base::CommandLine::ForCurrentProcess()->GetArgs();
  CHECK(arguments.size() == 1 || arguments.size() == 2);
  auto bytes = base::ReadFileToBytes(base::FilePath(
      base::CommandLine::ForCurrentProcess()->GetArgs()[0]));
  CHECK(bytes && !bytes->empty());
  base::SingleThreadTaskExecutor executor;
  Probe(*bytes, false, false, false);
  Probe(*bytes, true, false, false);
  Probe(*bytes, false, true, false);
  Probe(*bytes, false, false, true);
  if (arguments.size() == 2) {
    base::win::ScopedCOMInitializer com(base::win::ScopedCOMInitializer::kMTA);
    CHECK(com.Succeeded());
    ProbeMediaFoundation(*bytes, "ADTS");
    auto m4a = base::ReadFileToBytes(base::FilePath(arguments[1]));
    CHECK(m4a && !m4a->empty());
    ProbeMediaFoundation(*m4a, "M4A");
    std::puts("{\"passed\":true,\"cases\":6,\"pcm_tested\":true}");
  } else {
    std::puts("{\"passed\":true,\"cases\":4,\"pcm_tested\":false}");
  }
}
