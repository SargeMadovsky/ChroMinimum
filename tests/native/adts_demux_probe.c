/* Local test of the pinned demux-only FFmpeg archive; no PCM decoder used. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/error.h"
#include "libavutil/mem.h"

typedef struct MemoryInput {
  uint8_t *bytes;
  int64_t size;
  int64_t position;
} MemoryInput;

static int read_memory(void *opaque, uint8_t *buffer, int size) {
  MemoryInput *input = opaque;
  int64_t remaining = input->size - input->position;
  if (remaining <= 0)
    return AVERROR_EOF;
  if (remaining < size)
    size = (int)remaining;
  memcpy(buffer, input->bytes + input->position, size);
  input->position += size;
  return size;
}

static int64_t seek_memory(void *opaque, int64_t offset, int whence) {
  MemoryInput *input = opaque;
  int64_t base;
  if (whence == AVSEEK_SIZE)
    return input->size;
  whence &= ~AVSEEK_FORCE;
  if (whence == SEEK_SET)
    base = 0;
  else if (whence == SEEK_CUR)
    base = input->position;
  else if (whence == SEEK_END)
    base = input->size;
  else
    return AVERROR(EINVAL);
  if (offset < -base || offset > input->size - base)
    return AVERROR(EINVAL);
  input->position = base + offset;
  return input->position;
}

int main(int argc, char **argv) {
  MemoryInput input = {0};
  AVFormatContext *format = NULL;
  AVIOContext *io = NULL;
  AVPacket *packet = NULL;
  uint8_t *io_buffer = NULL;
  FILE *file;
  long length;
  int rate = 0, channels = 0, extra_size = 0;
  int packets = 0, invalid_packets = 0, stream_index = -1;
  int ret = AVERROR_INVALIDDATA, accepted = 0;
  double duration = 0;
  char asc[65] = {0};
  const int aac_decoder_present = avcodec_find_decoder(AV_CODEC_ID_AAC) != NULL;
  const int h264_decoder_present = avcodec_find_decoder(AV_CODEC_ID_H264) != NULL;
  if (argc != 2 || !(file = fopen(argv[1], "rb")))
    return 1;
  if (fseek(file, 0, SEEK_END) || (length = ftell(file)) < 0 ||
      length > 2 * 1024 * 1024 || fseek(file, 0, SEEK_SET)) {
    fclose(file);
    return 1;
  }
  input.bytes = malloc(length ? (size_t)length : 1);
  if (!input.bytes) {
    fclose(file);
    return 1;
  }
  input.size = length;
  if (fread(input.bytes, 1, length, file) != (size_t)length) {
    fclose(file);
    free(input.bytes);
    return 1;
  }
  fclose(file);
  io_buffer = av_malloc(4096);
  if (!io_buffer)
    goto done;
  io = avio_alloc_context(io_buffer, 4096, 0, &input, read_memory, NULL,
                          seek_memory);
  if (!io) {
    av_free(io_buffer);
    goto done;
  }
  format = avformat_alloc_context();
  if (!format)
    goto done;
  format->pb = io;
  format->flags |= AVFMT_FLAG_CUSTOM_IO;
  ret = avformat_open_input(&format, NULL, NULL, NULL);
  if (ret < 0)
    goto done;
  ret = avformat_find_stream_info(format, NULL);
  if (ret < 0)
    goto done;
  for (unsigned i = 0; i < format->nb_streams; ++i) {
    AVCodecParameters *par = format->streams[i]->codecpar;
    if (par->codec_id != AV_CODEC_ID_AAC)
      continue;
    stream_index = (int)i;
    rate = par->sample_rate;
    channels = par->ch_layout.nb_channels;
    extra_size = par->extradata_size;
    for (int j = 0; j < extra_size && j < 32; ++j)
      snprintf(asc + 2 * j, sizeof(asc) - 2 * j, "%02x", par->extradata[j]);
    break;
  }
  packet = av_packet_alloc();
  if (!packet)
    goto done;
  while ((ret = av_read_frame(format, packet)) >= 0) {
    if (packet->stream_index == stream_index) {
      int frame_length = packet->size >= 7
          ? ((packet->data[3] & 3) << 11) | (packet->data[4] << 3) |
                (packet->data[5] >> 5)
          : 0;
      ++packets;
      if (packet->size < 7 || packet->data[0] != 0xff ||
          (packet->data[1] & 0xf6) != 0xf0 || frame_length != packet->size)
        ++invalid_packets;
      duration += packet->duration * av_q2d(format->streams[stream_index]->time_base);
    }
    av_packet_unref(packet);
    if (packets > 100000) {
      ret = AVERROR_INVALIDDATA;
      break;
    }
  }
  accepted = ret == AVERROR_EOF && rate > 0 && channels > 0 &&
      extra_size == 2 && packets > 0 && invalid_packets == 0 &&
      duration > 0 && !aac_decoder_present && !h264_decoder_present;
done:
  printf("{\"accepted\":%s,\"rate\":%d,\"channels\":%d,"
         "\"asc\":\"%s\",\"packets\":%d,\"invalid_packets\":%d,"
         "\"packet_duration_seconds\":%.6f,\"ffmpeg_result\":%d,"
         "\"aac_decoder_present\":%s,\"h264_decoder_present\":%s}\n",
         accepted ? "true" : "false", rate, channels, asc, packets,
         invalid_packets, duration, ret, aac_decoder_present ? "true" : "false",
         h264_decoder_present ? "true" : "false");
  av_packet_free(&packet);
  avformat_close_input(&format);
  if (io) {
    av_freep(&io->buffer);
    avio_context_free(&io);
  }
  free(input.bytes);
  return accepted ? 0 : 2;
}
