# AAC: проверка путей 2026-10-27

Новая platform-only DLL `4047c4a120d42eca2dd08bfa239506ec38d18b5d376a5f21bc2368a7a9b38f31`
сравнена с прежней DLL со встроенным FFmpeg AAC. Один AAC-LC поток
(48 kHz, stereo) использован как ADTS и перепакован без перекодирования в M4A.
Профили одноразовые на E:, sandbox сохранён; оба запуска штатно завершились.

| Путь | Platform-only | Прежняя сборка с AAC |
|---|---|---|
| Media element, M4A | EOF, MediaFoundationAudioDecoder | EOF |
| Media element, ADTS | Ошибка открытия demuxer | EOF |
| OfflineAudioContext, ADTS и M4A | EncodingError, PCM нет | PCM, ненулевой сигнал |
| AudioContext, ADTS и M4A | EncodingError, PCM нет | PCM, ненулевой сигнал |
| WAV, оба AudioContext | PCM, ненулевой сигнал | PCM, ненулевой сигнал |

В каждом из четырёх успешных AAC WebAudio контролей прежняя сборка выдала
123244 PCM frames при44100Hz; WAV-контроли дали22050frames. Новая сборка
явно отклоняет AAC, это не тайм-аут и не неисправность WebAudio в целом.

## Причины по закреплённым исходникам

`media/filters/audio_file_reader.cc`, AudioFileReader::OpenDecoder():
синхронный WebAudio reader выбирает Symphonia/Opus либо FFmpegAudioDecoder;
MediaFoundationAudioDecoder в этом пути не подключён. Исправление0008
восстановило конфигурацию AAC из MP4, но не добавляет новый decoder в WebAudio.

`third_party/ffmpeg/chromium/config/Chromium/win/x64/config_components.h`:
CONFIG_AAC_DECODER=0, CONFIG_AAC_PARSER=0, CONFIG_AAC_DEMUXER=0.
ADTS media-element тест отказал с FFmpegDemuxer: open context failed,
то есть до выбора системного декодера. ADTS demux/parsing и WebAudio decoding
являются разными оставшимися задачами. Их исправления здесь не реализованы.

Это обычные формы AAC-LC, не тест HE-AAC/DRM/всех частот и каналов.
Работу AAC в hdrezka/MSE и MP4 не переносить автоматически на WebAudio.

[Машиночитаемый результат и SHA фикстур](reports/aac-matrix-20261027/summary.json).
Raw evidence: `.local/aac-matrix-20261027/platform-final/` и `reference-retry/`.

Продолжение: [ADTS demux-only, 13 native-проверок](ADTS_DEMUX_20261027.md). Это следующий эксперимент; исходная матрица выше остаётся результатом прежней DLL.

Следующий этап: [системный AAC для WebAudio — исходники, ограничения и план](WEBAUDIO_PLATFORM_AAC_PLAN.md).
