# Проверка CEF без встроенных H.264/AAC — подготовка 2026-10-26

Отдельная [AAC/WebAudio матрица](AAC_WEB_AUDIO_CHECK_20261027.md) подтвердила
работу M4A через системный decoder и два ограничения: AAC decodeAudioData
в обоих AudioContext и открытие сырого ADTS (AAC demux/parser отключены).
Прежняя bundled AAC сборка прошла положительные контроли; WAV работает в обеих.

Статус: полная сборка на E: успешно завершилась2026-10-27 03:54:39UTC
(08:54:39 Asia/Qyzylorda), Ninja exit0,23146/23146действий последнего запуска.
Созданы libcef.dll, bootstrap.exe и bootstrapc.exe; DLL307088896байт.
Последний непрерывный запуск занял5ч27м; это не суммарное время всех попыток.
Результаты последующих browser-проверок приведены ниже; универсальное
отсутствие встроенных декодеров в итоговом бинарнике пока не доказано.
SHA256 артефактов первичной сборки и статус:
[отчёт сборки](reports/platform-codecs-build-20261027/summary.json).
Runtime-проверка2026-10-27: отдельный комплект
`dist/ChroMinimum-platform-only-test-20261027`. MP4 H264 и WebM достигли EOF,
но прямой MP4 потерял AAC дорожку: FFmpegDemuxer сообщает unknown sample_format.
Это реальная регрессия, итоговый checker не принят. Точный захваченный MSE
hdrezka прошёл>1с/readyState4 с MediaFoundationAudioDecoder+D3D11VideoDecoder;
обычный Medium token, restricted renderer/GPU, network AppContainer подтверждены,
clean shutdown. AAC WebAudio явно отказал EncodingError, как ожидалось.
Новый runtime требует ALL APPLICATION PACKAGES RX ACL (права применены,
sandbox не отключался). Символьный индекс фактически связанного FFmpeg thin
archive не содержит AAC/H264 codec definitions; OpenH264 нет в прямом link.
Это ограниченный аудит, не универсальный binary absence proof.
Владелец подтвердил «Всё работает» в ручной проверке видео/звука/fullscreen
на hdrezka2026-10-27. Скриншот показывает D3D11VideoDecoder и
MediaFoundationAudioDecoder. Перемотка/длительная стабильность отдельно
не подтверждены. Обнаруженная тогда проблема AAC в прямом MP4 исправлена
патчем0008 ниже; ограничение WebAudio остаётся.
[Отчёт runtime](reports/platform-only-runtime-20261027/summary.json).
Исправление прямого MP4 AAC в работе: patch0008 меняет только
AVCodecContextToAudioDecoderConfig на Windows с proprietary registration:
AAC с неизвестным sample_format получает номинальный S16 (как MP4 MSE),
известные форматы и другие codecs не меняются; фактический PCM формат
согласует системный decoder. Дополнительные декодеры/сеть/службы не добавляются,
расход ветвления при demux ожидается пренебрежимым, замеров пока нет.
SHA-защищённый патч применён только в эксперименте E:, запущена инкрементальная
сборка libcef (один исходник и зависимая линковка). Журнал/статус:
`.local/platform-mp4-aac-fix-20261027/`. Новый runtime ещё не проверен;
прежний подтверждённый комплект dist/20261027 сохранён.
Сборка patch0008 завершилась2026-10-27 12:24:52UTC(exit0),1ч44м,
46действий: один C++ объект, зависимые generators/code cache и DLL relink.
DLL SHA2564047c4a120d42eca2dd08bfa239506ec38d18b5d376a5f21bc2368a7a9b38f31.
Новый комплект `dist/ChroMinimum-platform-only-mp4fix-test-20261027`.
Два runtime-прогона подтверждают восстановленную AAC дорожку прямого MP4,
MF Audio+D3D11 Video и clean shutdown. Оба прерваны видимостью/паузой
(visible→blur→hidden→pause); EOF не принят, не считать это decoder failure.
Ожидаемый WebAudio EncodingError сохранён. [Итог](reports/platform-mp4-aac-fix-20261027/summary.json).
Повторный audible-прогон той же DLL прошёл: MP4 AAC/H264 и WebM/Opus
видимо дошли до EOF(82кадра), muted=false, системный AAC/D3D11 выбран,
Medium browser и restricted/AppContainer sandbox, clean shutdown подтверждены.
check-platform-codecs-report.py passed=true. Точный MSE hdrezka отдельно
прошёл>1с/visible/MF+D3D11/clean shutdown после patch0008. Ранние hidden/pause
прогоны сохранены как непринятые. Исправление прямого MP4 локально принято;
Владелец подтвердил ручной hdrezka после patch0008: «Всё работает»;
на скриншоте19с воспроизведения и MF Audio+D3D11Video. Длительный просмотр
и seek отдельно не приняты. WebRTC и более широкий binary audit ещё ожидаются.
Исторический срез: на2026-10-27 01:46UTC восьмичасовое окно наблюдения завершено: сборка
продолжается без новых ошибок,18927/23146действий последнего запуска,
на E: свободно79.6GiB. Worker32888/Ninja31276 оставлены работать;
повторные автоматические проверки прекращены по согласованному сроку.
Итог окна: .local/platform-codecs-build-20261026/monitoring-window-result.json.
Локальные журнал/статус: `.local/platform-codecs-build-20261026/`.
Worker запущен отдельным процессом; окно просмотра журнала можно закрывать
независимо от сборки. TEMP/TMP и относительный ThinLTO cache находятся на E:.
Первый запуск остановился до компиляции на отсутствующем CIPD `esbuild.exe`
в отдельном DevTools worktree. Бинарник скопирован из прежнего baseline на E:;
SHA256 обеих копий совпал: `e994538826fba1e34f9154b7a3bcd7fef1a2173b1c26a00e131eaa68f8e34013`.
DEPS фиксирует пакет `version:3@0.25.1.chromium.2`. Сборка возобновлена,
первый статус сохранён в `status-attempt1.json`, журнал дополнен.
Второй запуск выявил отсутствующий hook-output `gpu/webgpu/DAWN_VERSION`.
Штатный `lastchange.py` создал его и dawn_commit_hash.h из pinned Dawn
38bc7fb0b3a024d05212958ae843e4ddf8c44ff1. Проверка 185311 входов через
`ninja -t inputs` после восстановления не нашла отсутствующих внешних
исходных путей; будущие генерируемые outputs не считаются ошибкой.
Сборка возобновлена; второй статус сохранён в `status-attempt2.json`.
Третий запуск прошёл285действий и отказал на нативном npm-пакете
`@rollup/rollup-win32-x64-msvc`, также отсутствующем в Git worktree.
Его два файла восстановлены из baseline, SHA сверены (`rollup-restored.json`).
`git ls-files --others --ignored` для baseline DevTools/node_modules показал
только эти два файла. Статус отказа сохранён в `status-attempt3.json`;
сборка продолжена с сохранением готовых outputs.
Четвёртый отказ: find_std_rlibs.py получил реальный Rust libdir на C:
через junction и не смог вычислить relpath от output на E:. Junction
`third_party/rust-toolchain` заменена физической копией на E: (7226файлов,
2.754GiB, robocopy без ошибок; rustc.exe SHA совпал). `rustc --print target-libdir`
теперь возвращает E:. Скрипты Chromium не менялись; сборка возобновлена,
статус отказа сохранён в `status-attempt4.json`.
Пятый запуск выполнил4948действий и остановился на validateDefinitionDeps:
TypeScript-Go раскрывал junction `third_party/typescript/windows-amd64/src`
в C:, что ломало relpath от E:. Только эта junction заменена копией на E:;
повторный `tsc --listFilesOnly` для отказавшего mojo target не содержит C:.
Сборка возобновлена с прежними outputs, `status-attempt5.json` сохранён.
Шестой запуск выполнил ещё4272действия за1664.516с и остановился на SwiftShader
Vulkan.res: отсутствовал `build/toolchain/win/rc/win/rc.exe`. Он восстановлен
из baseline с проверкой pinned rc.exe.sha1
`dea7da0d9bfcb8dad6cf53ca608dddac3459faaa`; SHA256 записан в rc-restored.json.
Других отсутствующих native tools среди ignored baseline/build не обнаружено.
Оценка оставшегося времени по этому отрезку грубая:6–10ч с запасом на линковку,
без учёта новых остановок; гарантией срока не является.
Отдельный `Vulkan.res` успешно собран после восстановления rc.exe. Полная
сборка возобновлена, сохранён status-attempt6.json и открыто окно журнала
только текущей попытки. Чтение полного графа на E: перед этой одиночной
целью заняло несколько минут; молчание при старте само по себе не означает отказ.
Седьмой запуск прошёл ещё976действий и отказал в ANGLE commit_id.py:
Git HEAD отдельного worktree хранится на C:, os.path.relpath от output E:
не поддерживает разные диски. Build-only патч0007 сохраняет относительные
пути на одном диске, иначе пишет абсолютный путь с depfile escaping.
Фактический генератор прошёл; отдельный Ninja принял C:/.../HEAD как зависимость,
повторный запуск дал no work to do. Это изменение сборочного helper,
не runtime/codec-политики; baseline C: не менялся. Запуск возобновлён,
отказ сохранён в status-attempt7.json. Патч и SHA лежат в patches/chromium/0007*.
Первая heartbeat-проверка18:06UTC обнаружила отказ после ещё4179действий:
Dawn generate-sources-gn.py не нашёл tools/golang/windows-amd64/bin/go.exe.
Из baseline восстановлен Windows Go1.26.6 на E: (11509файлов/208.58MiB,
robocopy без ошибок, SHA256 go.exe совпал). Все GOCACHE/GOPATH/GOMODCACHE
worker направлены на E:, GOTELEMETRY=off. Отказавший generator отдельно
успешно выполнен с кодом0, затем сборка возобновлена. История:
status-attempt8.json, dawn-go-restored.json, dawn-generator-check.log.
Heartbeat19:26UTC: предыдущий запуск остановился19:09UTC после8129действий
на отсутствующем skia/ext/skia_commit_hash.h. Штатный lastchange_skia hook
восстановил header из Skia2466dcf3937437e217e7f284afe0e1aae15891ce.
Точная отказавшая команда gpu_host_impl.obj повторена с кодом0
(skia-header-compile-check.log). Сборка возобновлена, status-attempt9.json
сохранён; при проверке свободно около91GiB на E:.
Heartbeat22:26UTC: запуск остановился22:14UTC после13549действий на
отсутствующем gpu/config/gpu_lists_version.h. Штатный gpu_lists_version hook
восстановил header из pinned Chromium b859317bf11f6be47f9b7799ec690a0a42a1fb33.
Точная gpu_internals_ui.obj команда после исправления прошла с кодом0;
лог gpu-lists-header-compile-check.log. Сборка возобновлена,
status-attempt10.json сохранён. Все четыре применимых Windows version hooks
из DEPS (LASTCHANGE/GPU lists/Skia/Dawn) теперь выполнены.
Рабочая копия эксперимента перенесена на `E:\cm-platform154`: проверены
464 исходных файла и регистрация семи Git worktree. Новые TEMP/TMP и вывод
сборки направлены на E:. Зависимости через junction могут читаться из прежнего
`C:\cm-media154`; эта исходная сборка сохраняется. Временный дубль
`C:\cm-platform154` удалён. Служебный `LASTCHANGE.committime` сгенерирован
штатным `build/util/lastchange.py` из pinned checkout. Для VS Build Tools
нужен `vswhere -products '*'`, иначе путь установки не обнаруживается.
Полный GN на E: успешно завершён: 35212 целей из 5026 файлов, 264.721 с.
На этапе проверки графа компиляция не запускалась. Фактические include_dirs выбирают Chromium/win/x64;
из 226 FFmpeg sources нет AAC/H.264 декодеров, остаётся h2645_parse.c (parser).
`ninja -n` остановился на планировании регенерации manifest, поэтому объём
получен отдельно через `ninja -t commands`: 59574 команды достижимого графа,
48633 с clang-cl. Это размер полного графа, не замер времени и не точное число
оставшихся incremental действий. Чистая сборка будет значительной;
владелец отдельно разрешил её запуск после этой оценки.
[Отчёт полного графа](reports/platform-codecs-full-graph-20261026/summary.json).
Рабочий system-codecs комплект 20261026 и установленный браузер не менялись.
Цель — проверить отсутствие встроенных реализаций H.264/AAC, сохранив
регистрацию форматов/контейнеры и системное декодирование Windows. Это
технический эксперимент, не доказательство отсутствия любых патентных условий.

## Рецепт

Pinned Chromium b859317bf11f6be47f9b7799ec690a0a42a1fb33 / CEF
14c5a089e8452874cb1a556dc3fde26ed2d87723. В новом изолированном checkout
нужны прежние патчи 0001–0003, системный AAC0004, ADTS/RAW0005 и GN0006.

| GN-параметр | Кандидат | Зачем |
|---|---|---|
| proprietary_codecs | true | Сохранить MIME/контейнеры/платформенную регистрацию |
| ffmpeg_branding | Chromium | Выбрать FFmpeg без AAC/H.264 декодеров |
| enable_ffmpeg_video_decoders | false | Не использовать FFmpeg video fallback |
| media_use_openh264 | false | Не включать встроенный OpenH264, включая WebRTC H.264 |
| chrominimum_platform_codecs_only | true | Явное guarded исключение0006, default=false |

`proprietary_codecs=true` здесь не является доказательством наличия встроенного
декодера: эти параметры управляют разными слоями. Но и одних GN-флагов
недостаточно для доказательства отсутствия кода в итоговой DLL.

Подготовщик:

```powershell
python scripts/prepare-platform-codecs-check.py --chromium-src C:/cm-media154/chromium/src --output .local/new-platform-codecs-plan
```

Для другого checkout добавлять `--baseline-args <сохранённый official args.gn>`;
копировать весь старый output не нужно. Подготовщик проверяет pinned HEAD,
пишет только новый каталог плана, фиксирует SHA и состояния патчей. Он не
применяет патчи, не вызывает GN/Ninja/компилятор. Финальные файлы текущей
подготовки: `.local/platform-codecs-only-check-20261026-final/`.
`ready_for_full_gn=false` ожидаем: текущие живые исходники не изменялись.

## Выявленный GN-блокер и его ограниченное решение

Попытка отдельного полного GN gen без0006 остановилась на media/BUILD.gn:
`proprietary codecs and ffmpeg_branding set to Chromium are incompatible`.
До Ninja dry-run выполнение не дошло; объём компиляции ещё не измерен.
Лог: `.local/platform-codecs-only-check-20261026-verified/gn-gen.log`.
Отдельный failed-GN output C:/cm-media154/chromium/src/out/Release_Platform_Codecs_Only_x64
создан только для этого опыта, компиляция не запускалась. Старый output не менялся.

[0006](../patches/chromium/0006-platform-codecs-only-gn.patch) сохраняет старую
проверку по умолчанию. Исключение разрешено только при Windows + регистрации
форматов + FFmpeg Chromium + отключённых FFmpeg video и OpenH264. Патч пока
не применён к живым исходникам. Его точный код guard проверен настоящим GN
в минимальном изолированном проекте: 8 сочетаний, включая отказ Linux,
встроенного OpenH264/видео и отключённой регистрации. Это не проверка полного
Chromium-графа после патча.

## Следующая стадия: GN и оценка, до компиляции

В отдельном pinned checkout применить все требуемые патчи и проверить SHA
из metadata0004/0005/0006. Для0006 обычный `git apply --check` перед записью;
его полный diff и source hashes сохранены в patches/chromium. Затем получить
свежий план и убедиться, что ready_for_full_gn=true. Только там:

```powershell
gn gen out/Release_Platform_Codecs_Only_x64
gn args out/Release_Platform_Codecs_Only_x64 --list --short
gn desc out/Release_Platform_Codecs_Only_x64 //third_party/ffmpeg:ffmpeg_internal sources --format=json
gn desc out/Release_Platform_Codecs_Only_x64 //third_party/ffmpeg:ffmpeg_internal include_dirs --format=json
gn desc out/Release_Platform_Codecs_Only_x64 //cef:libcef deps --all --format=json
ninja -C out/Release_Platform_Codecs_Only_x64 -n libcef bootstrap bootstrapc
```

Скопировать args.gn плана в новый output перед GN. Эти команды — генерирование
и dry run, не разрешение автоматически начать компиляцию. Нужно сохранить
effective args, FFmpeg sources/includes, deps и число pending задач. Здесь
меняется конфигурация нескольких подсистем; прошлые5мин линковки к этому
эксперименту неприменимы. Новый output может потребовать значительной, вплоть
до почти полной, компиляции. CPU/RAM/диск/время пока неизвестны; не начинать
длительный build под видом простой перелинковки.

## Что доказывать после сборки

1. Состав: выбран include `config/Chromium/win/x64`, AAC/H.264/OpenH264 decoder
   и encoder macros=0, codec_list без этих codec entries. Фактический GN graph
   и link inputs не должны подтягивать старые Chrome FFmpeg lib/objects,
   libavcodec/h264dec.c, libavcodec/aac/aacdec* или OpenH264 implementation.
   SHA итоговой DLL и итоговых inputs связать с отчётом. Простое отсутствие
   строки в DLL или успешный playback не являются доказательством состава.
2. Runtime: RAW MP4 AAC/H.264 и точный PlayerJS MSE-вход идут через
   MediaFoundationAudioDecoder + D3D11/MediaFoundation video. Никакого успешного
   AAC fallback на FFmpeg/Symphonia. Ordinary Medium browser, restricted GPU/
   renderer, Low AppContainer network, штатный shutdown.
3. Регрессии: WebM/Opus, VP9/AV1, MP3/FLAC/WAV, SVG/PDF, three.js/WebGL и
   WebRTC VP8/VP9. Затем сайт, физический звук, seek/reset/fullscreen,
   длинный просмотр и сравнение ресурсов на прежнем ПК.
4. Отрицательные условия: отсутствие системного AAC/Media Feature Pack или
   H.264 GPU decoder должно давать понятный отказ, не бесконечную загрузку.
   Windows N/другие ОС не объявлять проверенными без отдельных испытаний.

Подготовлен `scripts/check-platform-codecs-report.py`. В диагностический каталог
нужно добавить raw GN `effective-args.txt`, фактически выбранные
`ffmpeg-config_components.h`, `ffmpeg-codec_list.c`, `ffmpeg-includes.json`.
Затем использовать прежний isolated media runner с системным режимом и
fixtures и вызвать новый checker. Он проверяет поведение, конфигурацию и
sandbox; намеренно возвращает binary_absence_proven=false, поскольку аудит
итоговых link/binary identity выполняется отдельно. Старый check-platform-aac-
report требует успешный WebAudio AAC и для этого эксперимента не подходит.

## Ограничения, которые нельзя скрывать

- AAC `WebAudio.decodeAudioData()` пока использует FFmpeg. В первом кандидате
  ожидаем явную ошибку, а не PCM; это потеря функции, не готовность к релизу.
  Успех требует расследования (либо оставшийся codec, либо новый системный путь).
- Встроенного software H.264 fallback не будет. Возможности системного пути
  зависят от Windows/GPU; универсальное воспроизведение не обещается.
- Отключение OpenH264 отключает bundled WebRTC H.264. VP8/VP9 конференции
  должны проверяться отдельно; отсутствие H.264 нужно явно отразить.
- FFmpeg полностью не удаляется: открытые декодеры и demux могут оставаться.
  Не называть результат стандартным неизменённым CEF или «без всех кодеков».

Подготовительные проверки: 4 unittest группы конфигурации, 8 GN policy cases,
8 тестов checker (включая отказ fallback, admin, broken sandbox, старого
конфига, неожиданного WebAudio PCM и отсутствующих данных). Все прошли.
[Отчёт подготовки](reports/platform-codecs-plan-20261026/summary.json).

ADTS этап 2026-10-27: [patch0009 и 13 native-проверок](ADTS_DEMUX_20261027.md); браузерное воспроизведение этого изменения ещё не принято.
