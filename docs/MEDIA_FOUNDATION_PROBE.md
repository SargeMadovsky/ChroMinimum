# Отдельная проверка Media Foundation — 2026-10-23

Результат: Windows 10 build 19045 на устройстве владельца декодировала H.264 и
AAC-LC системными Media Foundation transforms. Это консольный тест вне CEF,
без сети, личных профилей, аудиовывода или видеовывода. Он не проверяет browser
sandbox, синхронизацию A/V, сайт hdrezka или право публичного распространения.
Новая компиляция CEF не запускалась; продуктовые бинарники не изменены.

## Доказательства

Исходник `scripts/probe-mf-decode.cc`, проверяющий runner
`scripts/test-mf-decode.py`. SourceReader читает закреплённые локальные fixtures,
проверяет native H.264/AAC и запрашивает несжатые NV12/PCM16. Чтение до EOF,
ненулевые данные, возрастающее время и параметры выходного формата обязательны.
Для видео runner также сверяет объём NV12 с размером/числом кадров. Для AAC
проверяются PCM frames/peak, stereo и 48000 Hz. ADTS header fixture независимо
прочитан: audio_object_type=2 (AAC-LC), 48000 Hz, 2 канала.

| Проверка | Результат |
|---|---|
| bear-1280x720.mp4 | 82 NV12 кадра, 1280×720, 113356800 байт, EOF |
| bear-audio-lc-aac.aac | 134144 PCM frames, stereo 48000 Hz/16-bit, peak 0,10245, EOF |
| Запрос видео из AAC-файла | отказ 0xc00d36b3 на выборе потока, exit=1 |
| Отсутствующий файл | отказ до открытия, exit=2 |

DXVA отключён, hardware transforms не включались; D3D manager не передавался.
Через IMFSourceReaderEx::GetTransformForStream получен фактически выбранный
decoder, по адресу его vtable установлен модуль:

- H.264: `msmpeg2vdec.dll` из System32.
- AAC: `MSAudDecMFT.dll` из System32.

Это идентификация загруженного модуля, не отдельная проверка Authenticode.
Прямые импорты probe: MFPlat.DLL, MFReadWrite.dll, ole32.dll, KERNEL32.dll;
FFmpeg/CEF в стенд не линкуются. EXE 158208 байт, MSVC static CRT, компиляция
/W4 /WX прошла. Время процессов около 0,286 и 0,042 с в одном прогоне — не
сравнительный benchmark и не оценка накладных расходов будущей интеграции.

Отчёты `docs/reports/mf-probe-20261023/identified/`: results.json, metadata.json,
dependents.txt. В metadata закреплены SHA fixtures, EXE и исходника. Первичный
прогон без идентификации decoder сохранён отдельно в родительском каталоге.

## Воспроизведение

В Developer PowerShell x64 с Windows SDK 10.0.28000.0:

```powershell
cl.exe /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT scripts/probe-mf-decode.cc /Fo.local/mf-probe-20261023/probe.obj /Fe.local/mf-probe-20261023/probe.exe /link mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib
python scripts/test-mf-decode.py --exe .local/mf-probe-20261023/probe.exe --fixtures docs/reports/media-fixtures-2026-10-21 --output docs/reports/mf-probe-repeat
```

Каталог output должен быть новым. Для зависшего synchronous ReadSample внешний
runner ограничивает каждый процесс 45 с; внутренний цикл тоже имеет предел.
Новых зависимостей/процессов/таймеров в приложение не добавлено. Необходимо
создать каталог .local/mf-probe-20261023 перед компиляцией.

## Карта следующей интеграции — исходники прочитаны, патча нет

Закреплённый Chromium b859317bf11f6be47f9b7799ec690a0a42a1fb33:

1. `media/mojo/services/gpu_mojo_media_client_win.cc` объявляет platform AAC
   только kXHE_AAC и только с Win11 22H2. В
   `media/filters/win/media_foundation_audio_decoder.cc:GetTypeInfo` тот же
   фильтр. Для AAC-LC нужны изменение списка поддерживаемых конфигураций,
   корректное заполнение input media type/ASC и испытание actual decode в CEF.
2. Штатный Windows video path в GpuMojoMediaClientWin использует D3D11 и зависит
   от GPU/workarounds. Удаление FFmpeg H.264 может лишить старое железо software
   fallback. Успех системного software decoder в этом стенде не подключает его
   автоматически к Chromium. Нужен отдельно проверенный путь для этой ситуации.
3. WebAudio: `content/renderer/renderer_blink_platform_impl.cc` →
   `content/renderer/media/audio_decoder.cc` →
   `media/filters/audio_file_reader.cc:OpenDecoder`. По умолчанию там
   FFmpegAudioDecoder (для некоторых иных кодеков — отдельные декодеры).
   Поэтому patch только platform playback не подтверждает AAC в decodeAudioData;
   существующий WebAudio AAC acceptance-test нельзя молча убрать.
4. `media/BUILD.gn` запрещает proprietary_codecs=true вместе с
   ffmpeg_branding=Chromium при включённом media_use_ffmpeg. Просто заменить
   branding недостаточно; необходима проверенная конфигурация/интеграция.

До новой длительной сборки нужен ограниченный проект патча с этими границами.
Нельзя отключать sandbox ради COM/MFT; доступность декодеров в нужном процессе
и Windows N/других системах не подтверждена. Добавление системного пути также
не является автоматическим юридическим разрешением на распространение.

Первичные API-источники Microsoft:
[Source Reader](https://learn.microsoft.com/en-us/windows/win32/medfound/processing-media-data-with-the-source-reader),
[AAC decoder](https://learn.microsoft.com/en-us/windows/win32/medfound/aac-decoder),
[H.264 decoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-decoder),
[GetTransformForStream](https://learn.microsoft.com/en-us/windows/win32/api/mfreadwrite/nf-mfreadwrite-imfsourcereaderex-gettransformforstream).

[Обзор распространения](MEDIA_DISTRIBUTION_REVIEW.md), [карта CEF](CEF_KNOWLEDGE.md).
