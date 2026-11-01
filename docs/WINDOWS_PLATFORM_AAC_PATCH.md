# Эксперимент: платформенный AAC в Chromium 154

2026-10-23. Первый ограниченный этап интеграции Windows Media Foundation.
Рабочая alpha.8 и её установщик не изменены. Отдельная тестовая DLL собрана
на третьем этапе ниже; это не релизный runtime.

## Изменение

[Патч 0004](../patches/chromium/0004-windows-platform-aac.patch) закреплён на
Chromium 154.0.8037.98, commit b859317bf11f6be47f9b7799ec690a0a42a1fb33.
[Метаданные](../patches/chromium/0004-windows-platform-aac.json) содержат SHA-256
трёх исходных файлов до и после изменения (после второго этапа ниже).

Существующий MediaFoundationAudioDecoder допускает обычный AAC с профилем
kUnknown; фактический AudioSpecificConfig проверяет MFT. Ограничение xHE-AAC
на Windows 11 22H2+ сохранено. Список платформенных возможностей публикует AAC
только после успешного перечисления доступных AAC MFT — это существенно для
Windows N без Media Feature Pack. Патч не добавляет загрузчик DLL или сервис.

Применение: `python scripts/apply-cef-patches.py --help`, режим
`--platform-aac`. Проверяются версия и оба хеша до первой записи; повторное
применение допустимо, частичное состояние и изменённый upstream отклоняются.
Штатные рецепты сборки автоматически этот эксперимент не включают.

## Выполненные проверки

- Пять проверок применения: чистый checkout, повторное применение, изменение
  upstream, частичный патч, другая версия Chromium. Все прошли.
- Два изменённых C++ файла скомпилированы с реальными командами и флагами
  существующей official Release сборки, включая предупреждения как ошибки.
  Созданы только два временных объекта вне кеша CEF; линковка не выполнялась.
- Отдельный [стенд raw AAC](../scripts/probe-mf-aac-raw.cc), собранный MSVC
  с `/W4 /WX /O2 /MT`, передал 131 пакет AAC-LC без ADTS-заголовков,
  ASC `1190`, в системный `MSAudDecMFT.dll`. Входной HEAACWAVEINFO повторяет
  формат существующего Chromium GetAacAudioType. Выход float32, stereo,
  48000 Hz: 134144 PCM frames, 260096 ненулевых значений, peak 0.10245932.
  Выполнен drain. Другой тип файла и отсутствующий файл отвергнуты.
- Временные изменения живых исходников восстановлены: оба хеша совпали
  с исходными. Хеш рабочего libcef.dll остался
  `ef8d6219fb826b586ca25b60f6583ba0c1453cb9172051521a02f5fb8057e020`.

Компактные доказательства: [reports/platform-aac-20261023](reports/platform-aac-20261023/).
Команда проверки защит патча:

```powershell
python scripts/test-platform-aac-patch.py --chromium-src C:/cm-media154/chromium/src --output .local/platform-aac-check-new
```

Выходной каталог должен быть новым. Исходники для fixtures читаются через
`git show` закреплённого commit; пользовательские профили не используются.
Локальные команды компиляции и журнал: `.local/platform-aac-20261023/`.

## Границы результата и следующий шаг

Это проверка компилируемости патча и формата standalone MFT на Win10 19045.
Она не запускает MediaFoundationAudioDecoder внутри CEF и не подтверждает
его выбор, работу в sandbox, A/V sync, seek, HE-AAC или другие системы.
FFmpeg остаётся включённым и в DefaultDecoderFactory стоит раньше внешнего
декодера. Поэтому этот патч ещё не переводит браузер на системный AAC
и не меняет выводы об условиях распространения существующей alpha.8.

Далее нужно обеспечить и доказать выбор платформенного AAC в тестовом CEF
без ослабления sandbox. Затем отдельно исследовать H.264 software fallback
и WebAudio: последний сейчас использует другой FFmpeg-путь. Только после
этого имеет смысл проверять сборку без встроенных H.264/AAC и сравнивать
поведение и расходы. Новых зависимостей, постоянных процессов и сетевых
запросов сейчас нет; расходы интеграции в браузер пока не измерены.

Предыдущий стенд и первичные ссылки Microsoft:
[MEDIA_FOUNDATION_PROBE.md](MEDIA_FOUNDATION_PROBE.md).

## Второй этап: выбор декодера и наблюдаемость

В патч добавлен `media/renderers/default_decoder_factory.cc`: Windows feature
`ChroMinimumPlatformAudioFirst` выключена по умолчанию. При её включении
внешний decoder factory вызывается перед FFmpeg, ровно один раз. FFmpeg
остаётся fallback; порядок прочих встроенных декодеров сохранён. Это влияет
на порядок попыток для аудио, а не только AAC. Новых процессов, зависимостей
и сети нет; возможна добавочная задержка неудачной платформенной инициализации.
Накладные расходы в браузере ещё не измерены.

Все три файла повторно скомпилированы с official Release флагами, включая
`/WX`, из изолированных fixtures: живые исходники не изменялись. Пять проверок
применения обновлённого патча прошли. Линковка не выполнялась. Предыдущие
двухфайловые отчёты выше относятся к первому этапу; текущие метаданные
и результаты находятся в [отчётах второго этапа](reports/platform-aac-selection-20261023/).

`diagnose-media.cjs` теперь включает CDP Media domain и сохраняет до 2000
media events в `media-events.json`. Семь lifecycle-тестов и синтаксическая
проверка Node прошли. На отдельной копии прежней official alpha.8 выполнен
контрольный запуск с новыми тестовыми данными: MP4/WebM воспроизводятся,
WebAudio AAC декодируется; exit=0 и shutdown_complete подтверждены. Media log подтверждает AAC → FFmpegAudioDecoder,
H.264 → D3D11VideoDecoder, Opus → OpusAudioDecoder. Это контроль исходного
runtime, не проверка патча.

Первый запуск из sandbox агента не открыл CDP. Следующий запуск из каталога
упаковки завершился `network_sandbox_refused`: CEF сообщил отсутствие
AppContainer RX на executable. Отдельная копия, созданная от пользователя
и получившая штатный наследуемый RX SID S-1-15-2-1 только на runtime,
прошла воспроизведение. Защита и пользовательская установка не менялись.

Следующий шаг: тестовая линковка CEF с этим патчем и включение feature только
в изолированном запуске. Критерий — `kAudioDecoderName` равен системному
MediaFoundationAudioDecoder, `kIsPlatformAudioDecoder=true`, декодирование,
штатный shutdown и проверка sandbox-токенов. Одного успешного playback мало.

## Третий этап: AAC-LC внутри CEF с sandbox

Выполнен 2026-10-23 на Windows 10 build 19045. Отдельная DLL слинкована
[скриптом](../scripts/link-platform-aac-experiment.py) из готовых official
объектов с заменой трёх проверенных объектов. Для Mojo services создана
отдельная статическая библиотека; исходные объекты и библиотека не заменялись.
Сохранены GN link flags, кроме ограничения LTO jobs до двух; вся компиляция
Chromium не повторялась. Архив: 0,5 с, DLL: 385,3 с. Наблюдалось около
6,45 ГиБ private memory линкера; это отдельный отсчёт, не замер пика.

Тестовая DLL: 309112832 байта, SHA-256
`b0ecccbf44d5009760406b5c24aea0939a46ce9d2ba73690c8649239d7bdff43`.
Прибавка к прежней DLL — 1536 байт. Память/CPU и запуск браузера в этом
эксперименте сравнительно не измерялись.

Оболочка собрана с тестовым `--test-platform-aac`, разрешённым только вместе
с smoke и CDP. Обычный запуск сохраняет прежний порядок. Диагностика включает
его через `--platform-aac`; используется установленный PowerShell 7 для
read-only снимка токенов. Системная execution policy не менялась.

В полном успешном прогоне:

- MP4 AAC-LC, 44100 Hz, stereo: `kAudioDecoderName=MediaFoundationAudioDecoder`,
  `kIsPlatformAudioDecoder=true`; H.264 остаётся на D3D11VideoDecoder.
- MP4 и VP9/Opus WebM дошли до `ended`, по 82 видеокадра; продолжительности
  2,763175 и 2,736 с. Это короткий smoke, не длительное испытание A/V sync.
- WebAudio AAC дал 123244 PCM frames, peak 0,09913. Он по-прежнему идёт
  отдельным встроенным путём: перенос WebAudio на системный AAC не выполнен.
- GPU token restricted/Low, renderer restricted/Untrusted, сеть —
  AppContainer/Low с sandbox type network. Проверка не является полным аудитом.
- `exit=0`, `shutdown_complete`; проверяющий скрипт отклонил бы отсутствие
  Media Foundation, EOF или нужных токенов.

Команды для нового отдельного каталога:

```powershell
python scripts/link-platform-aac-experiment.py --chromium-src C:/cm-media154/chromium/src --objects .local/platform-aac-selection-20261023 --output .local/platform-aac-link-new
node scripts/diagnose-media.cjs <isolated-runtime>/chrominimum.exe <new-report> docs/reports/media-fixtures-2026-10-21 --platform-aac
python scripts/check-platform-aac-report.py <new-report>
```

Для запуска runtime должен содержать новый тестовый adapter и DLL с
совместимыми ресурсами и bootstrap. Профиль располагается вне runtime;
AppContainer получает только штатный RX на его каталог. Не запускать эти
команды на пользовательской установке. Объекты первого эксперимента пока
локальные; для их восстановления нужны закреплённый GN output и компиляция
трёх patched fixtures, описанные выше.

[Компактные отчёты и все попытки](reports/platform-aac-runtime-20261023/).
Прежний CEF с новой оболочкой также прошёл playback/shutdown — контроль
отделяет оболочку от нового ядра. До успешных прогонов были timeout навигации,
одна остановка playback и ошибка вызова Windows PowerShell. CDB не разрешил
стеки за 45 с. Диагностика больше не запускает вторую начальную навигацию,
а ожидает первую до 10 с; последний полный прогон прошёл после этого изменения.
Причинная связь с тайм-аутами не доказана, повторяемость ещё не принята.

Проверки оболочки: Release build, 9 Rust-тестов, Clippy `-D warnings`, rustfmt.
Проверки диагностики: 7 Node lifecycle-тестов, Node/Python syntax, ссылки.
Три исходных Chromium-файла и исходный libcef.dll проверены по прежним хешам;
установщик, пользовательская установка и каналы обновления не менялись.

Следующие ограниченные задачи: стабилизировать начальный тестовый запуск;
затем отдельно исследовать H.264 software fallback и WebAudio. HE-AAC,
seek/reset, другие ОС и Windows N ещё не проверены. FFmpeg с встроенными
кодеками остаётся в DLL; этот опыт не решает условия её распространения.

## Повторная диагностика начальной загрузки

2026-10-23, без пересборки DLL/оболочки. В последовательной серии первый
полный прогон прошёл, второй остановился до GET к loopback: Runtime видел
`about:blank`, readyState=complete. Отдельная запись `/json/list` показала
единственный page target с ожидаемым HTTP URL, но без заголовка; запросов к
серверу всё ещё не было. Это pending navigation, а не доказательство потери
аргумента URL. Причина незавершённого перехода не установлена.

Проверена гипотеза раннего CDP: диагностика теперь сначала ждёт собственный
HTTP GET `/` и native `main_frame_loaded; status=200`, только затем подключает
агенты. Граница ожидания — 15 с после появления DevToolsActivePort; состояние
пишется в `initial-load.json`. Отказ воспроизвёлся и до подключения CDP
(15105 мс, 0 запросов). Поэтому раннее подключение CDP не объясняет сбой.
Увеличивать тайм-аут как исправление оснований нет.

В отдельном таком отказе сняты browser/GPU стеки. Быстрый CDB с отключённым
поиском PDB отсоединился штатно. Затем адреса возврата CEF разрешены локальным
llvm-symbolizer с точным PDB тестовой DLL. Browser main находился в
SequenceManager/MessagePump, GPU main — в ожидании события; AAC/MFT в
разрешённых стеках нет. Это одиночные снимки, не доказательство причины или
отсутствия гонки. Вмешательство debugger исключает такой запуск из приёмки.

[Доказательства, отрицательные попытки и разрешённые стеки](reports/platform-aac-startup-20261023/).
Проверяющий скрипт теперь выдаёт structured failure при неполном отчёте
вместо traceback. Контроль: полный прогон принят, отсутствующие токены/медиа
отклонены. Семь lifecycle-тестов и Node/Python syntax прошли.

Запуск остаётся нестабильным. Следующий шаг — локализовать ожидание первой
навигации в browser/renderer/network и сравнить тот же сценарий на исходном
ядре без AAC-патча. Новые полные сборки, изменения sandbox и публикации
в этом этапе не выполнялись.

## Сравнение исходного ядра и AAC-кандидата

2026-10-23: по три запуска исходного official media CEF (до патча 0004) и
кандидата. Это не сравнение со стандартной поставкой CEF без кодеков.
Ресурсы, bootstrap, новая тестовая оболочка и остальные файлы совпали по
SHA-256; различается только libcef.dll. Хеши всех runtime-файлов после серии
не изменились. Профиль каждого запуска новый, реальные профили не использованы.

| Проверка | Исходный CEF | AAC-кандидат |
|---|---:|---:|
| Первая HTTP-страница загрузилась | 2/3 | 2/3 |
| Оба клипа до EOF, ожидаемый декодер, sandbox, штатное закрытие | 2/3 | 1/3 |
| Штатное закрытие | 2/3 | 2/3 |

Оба ядра по одному разу остановились до первого HTTP GET и не завершились
по native smoke timer. Поэтому этот стартовый сбой не уникален для AAC-патча.
У кандидата дополнительно одна остановка MP4 на 1,270185 с / 41 кадре
при выбранном MediaFoundationAudioDecoder. Следующий WebM получил AbortError; его причина отдельно не установлена.
Это не отдельное доказательство ошибки Opus.
Третий запуск кандидата полностью прошёл.

Обеим копиям передавался одинаковый тестовый флаг. В исходной DLL feature
отсутствует, поэтому ожидаемый backend — FFmpegAudioDecoder. Диагностический
runner завершает такой успешный контроль кодом 1 только из-за отсутствия MF;
сравнение явно отделяет этот ожидаемый результат от ошибок старта/playback.
Токены и EOF проверяются в обоих случаях.

Порядок: reference → candidate, candidate → reference, reference → candidate.
После отсутствия clean shutdown серия останавливалась; перед продолжением
в отдельной сессии проверялось отсутствие прежних тестовых процессов.
Перекрывающихся принятых запусков нет. Новых сборок и изменений защиты нет.

[Скрипт сравнения](../scripts/compare-cef-startup.py),
[все результаты, логи и хеши](reports/cef-startup-comparison-20261023/summary.json).
Это малая диагностическая серия, не оценка частоты отказов и не бенчмарк.
Вывод: сначала отдельно локализовать общий startup-сбой и остановку MP4
на MF-пути; оснований объявлять кандидата стабильным или убирать FFmpeg нет.

## Уточнение остановки на 1,27 секунды: паузы плеера

2026-10-23, повторный разбор сохранённого media log. У неуспешного MP4
после kPlaying и BUFFERING_HAVE_ENOUGH для audio/video идут kPause,
повторный kPlay и ещё kPause. Первые паузы произошли до вызова cleanup
диагностическим скриптом; decoder errors и BUFFERING_HAVE_NOTHING в этом
логе не зафиксированы. Само значение currentTime=1,270185 не доказывает
остановку AAC-декодера. Прежняя формулировка о его зависании была слишком
категоричной. Это не отменяет отказа полного сценария в таблице выше,
но меняет его интерпретацию: причина пауз неизвестна.

В диагностический скрипт добавлены bounded (128 записей на клип) события
play/playing/pause/waiting/stalled/ended, paused, видимость и фокус. Записываются
только media-control key codes и факт pointerdown на тестовом видео, без
произвольного текста ввода. Обработчики снимаются до cleanup. Пауза до EOF
при истечении времени получает status=paused, а не общий timeout.
Это только тестовый код; расходы обычного приложения не меняются.

Новый обычный прогон на неизменённой DLL прошёл EOF обоих клипов, по 82 кадра,
MF selection, sandbox и shutdown. Промежуточных пауз не было. Отрицательный
контроль `--platform-aac --pause-control` намеренно вызвал pause через 800 мс
от создания MP4 (после стартовой буферизации currentTime=0,530632). Получены
test-pause-request → pause, paused=true, status=paused. Checker отклонил
этот прогон. Trusted=true у pause event встречается и при вызове pause()
скриптом: оно не доказывает ручной ввод пользователя. Следующий WebM в этом
контроле также получил AbortError; причинность старого WebM-отказа не доказана.

Первый запуск отрицательного контроля отказал ещё на initial load и сохранён
отдельно. Повтор выполнялся после проверки отсутствия прежних тестовых
процессов. Пересборок ядра/оболочки нет, 7 Node lifecycle-тестов и syntax прошли.

[Исходная временная шкала и оба контроля](reports/aac-pause-diagnosis-20261023/).
Следующий диагностический критерий: при новом отказе различать paused,
background/focus transitions и stalled при paused=false; лишь для последнего
проверять backpressure/PCM/timestamps в декодере. Источник прежних пауз ещё
не установлен. Стабильность запуска и пригодность системного пути к релизу
по-прежнему не подтверждены.

## Видимый повтор — 2026-10-25

На прежней DLL SHA b0ecccbf… выполнен `diagnose-media.cjs --platform-aac
--ssd-profile --visible`, новый TEMP-профиль. Checker passed=true, exit=0,
shutdown_complete. MP4 H.264/AAC и WebM VP9/Opus дошли до EOF по 82 кадра.
MP4 выбрал D3D11VideoDecoder и MediaFoundationAudioDecoder, оба platform=true.
Оба видео visible; sandbox-токены приняты штатным checker. Хеш DLL до/после
совпал. Пересборок и изменений обычного приложения нет.

[Компактный результат](reports/platform-aac-visible-20261025/summary.json).
Полный локальный отчёт: `.local/platform-aac-visible-20261025`.
Это подтверждение существующего системного пути, не проверка сайта и не
поставка без встроенных кодеков: FFmpeg fallback и WebAudio AAC ещё остаются.
Следующий ограниченный этап — убрать встроенные H.264/AAC из отдельного
рецепта, сохранив регистрацию форматов и системный путь; сначала проверить
GN/FFmpeg конфигурацию и границы WebAudio/H.264 fallback. Просто отключать
USE_PROPRIETARY_CODECS нельзя: этим отключается и нужная регистрация форматов.
Сравнительные расходы этого пути ещё не измерены.

## Ручной комплект hdrezka — 2026-10-25

Подготовлен `dist/ChroMinimum-system-codecs-test-20261025/`, 26 runtime-файлов,
401502521 байт. CEF не пересобирался: прежняя b0ecccbf… DLL. Из frozen
`chrominimum-alpha8-source-snapshot-v2.zip` в отдельном `.local` checkout
собрана только Rust DLL (4,97 с по Cargo). Изменение: явный локальный флаг
`--test-system-codecs` включает ChroMinimumPlatformAudioFirst вне smoke/CDP.
Рабочие исходники приложения не менялись. Это адаптер alpha.8, не точный
повтор alpha.7; подмена версии не выполнялась. Манифест SHA находится в комплекте.

Перед ручным запуском отдельная копия диагностического runner передала именно
новый флаг: оба клипа EOF/82 кадра, MF AAC + D3D11 H.264, checker passed=true,
sandbox принят, exit=0/shutdown_complete. Отчёт:
`.local/platform-hdrezka-gate-check-20261025/`. Сохраняется ограничение FFmpeg
fallback/WebAudio. AppContainer получил только inherited RX на новый runtime.

Открыт обычный ручной режим hdrezka с новым TEMP-профилем; без CDP/NetLog,
без smoke-таймера. README комплекта описывает проверку звука, seek/fullscreen
и обязательный просмотр decoder names: один playback не исключает FFmpeg fallback.
Работа сайта и выбор декодеров на сайте пока НЕ подтверждены.

### Блокер ручной проверки: сеть — 2026-10-25

На присланных снимках сайта decoder names отсутствуют. Read-only проверка
процессов подтвердила нужный runtime и ChroMinimumPlatformAudioFirst в GPU
и renderer. Предоставленная Console содержит ERR_TIMED_OUT при запросах
HLS manifest и прямых MP4 на voidslam.org и stream.voidboost.one, включая
повтор с другим качеством. Messages выбранного плеера пустая; Events показывает
load и уничтожение примерно через 30 с. Это не свидетельство отказа MFT.

Независимый curl HEAD к корням обоих HTTPS-доменов с этого ПК также завершился
connection timeout за 5 с. Cookies/подписанные URL не использовались. Проверка
корня не повторяет точный запрос браузера, но подтверждает сетевую проблему
вне CEF на момент проверки. Её причина (маршрут/VPN/провайдер/CDN) не установлена.
Следующий контроль: тот же фильм/озвучка в UC или Chrome при том же подключении;
затем повтор system-codecs теста после восстановления доступа к видеосерверу.
Сайт пока не проверен на системных декодерах; пересборка CEF не требуется.

### Ручное воспроизведение после отключения VPN — 2026-10-25

Владелец сообщил, что после полного закрытия VPN и повторного запуска
`dist/ChroMinimum-system-codecs-test-20261025/Run-Hdrezka.cmd` видео заработало.
Приложенный снимок показывает кадр воспроизводимого видео в тестовом CM;
отдельный снимок UC также показывает playback. Это ручное подтверждение
воспроизведения сайта в экспериментальном комплекте, не парный benchmark.
Изменение состояния VPN согласуется с прежними сетевыми тайм-аутами, но
контролируемая причинная проверка VPN не выполнялась. Утверждать общую
недоступность hdrezka или отказ системных декодеров по прежним ошибкам нельзя.

В присланном снимке CM открыта Console, не Media Properties. Поэтому выбор
MediaFoundationAudioDecoder на сайте ещё не подтверждён: FFmpeg fallback
остаётся в DLL. Следующий минимальный контроль — decoder names активного
играющего плеера; затем звук, seek и fullscreen при необходимости.

### Уточнение выбора декодера и повторный запуск Chromium

На снимке владельца играющее hdrezka использует D3D11VideoDecoder и
FFmpegAudioDecoder: системный AAC на сайте в этом запуске НЕ подтверждён.
Владелец сообщил различие обычного и административного запуска. Read-only
снимок текущего дерева показал browser Medium (8192), GPU Low restricted,
renderer Untrusted restricted, сеть Low AppContainer. Browser argv содержит
ChroMinimumPlatformAudioFirst и --do-not-de-elevate, дочерние argv feature
не содержат; исходного --test-system-codecs в browser argv уже нет.
Это согласуется с потерей диагностического режима при relaunch/de-elevation,
но само по себе не устанавливает причину сетевых отказов обычного запуска.

В отдельной frozen оболочке добавлен наследуемый локальный env-переключатель
CHROMINIMUM_TEST_SYSTEM_CODECS=1. Создан v2 комплект строго по 26 именам
runtime-manifest; профили не включены. CEF не менялся; Rust build 2,86 с.
Нужен контроль MF selection, sandbox и ручной сайт без повышения прав.

Первые два v2 visible smoke отказали до playback: `Visible media probe remained
hidden`. Доказательством работы исправления они не являются. Отрицательные
отчёты сохранены в `.local/platform-hdrezka-env-check[-2]-20261025` (вторая
папка: platform-hdrezka-env-check2-20261025). Запущен отдельный контроль выбора
декодера без требования видимости; его нельзя считать проверкой foreground UX.

Третий v2 контроль подтвердил `platform-selection.selected=true` (MF AAC),
но оба клипа не дошли до EOF: MP4 paused=true, visibility=hidden, focused=false.
Полный checker passed=false, clean exit=0. Следовательно, подтверждён только
выбор системного AAC в этом локальном запуске, не полная приёмка v2.
Ручной повтор предлагается обычным запуском v2 CMD с окном на переднем плане.

### Парный ручной контроль A/B — подготовлен 2026-10-25

В том же v2 runtime добавлены A-Run-FFmpeg.cmd (env=0, без test-system флага)
и B-Run-System-AAC.cmd (env=1). Оба открывают одну страницу «Глубина»
92793-glubina-2026.html на разных новых TEMP-профилях. Все 26 runtime SHA
совпали с ведомостью, пересборок нет. Нужны одинаковые серия/озвучка/качество,
последовательные запуски, окно на переднем плане, без запуска от администратора.
A использует штатный порядок decoder factory; ожидаемый FFmpeg нужно сверить
по Media Properties, а не заключать из названия CMD.

Агент открыл A; read-only проверка browser PID 26240 показала Medium=8192,
TokenError=0, системного feature в browser argv нет. Результат playback A/B
пока не получен. Пользовательские скриншоты до этого показывают разные
сериалы: MF выбран в зависшем обычном запуске, FFmpeg в играющем запуске,
названном владельцем административным; это не контролируемая пара.

### Результат ручной пары A/B — 2026-10-25

Владелец подтвердил: A, открытый агентом без повышения прав, воспроизводит
видео и звук; B, запущенный владельцем без администратора, не воспроизводит.
На обоих снимках одна страница «Глубина» и 640x291, видео D3D11VideoDecoder.
A: Audio Decoder FFmpegAudioDecoder, виден кадр и позиция 00:02:01.
B: Audio Decoder MediaFoundationAudioDecoder, чёрный экран со spinner.
Комплект и runtime одни и те же, меняется системный AAC feature; профили
раздельные. Точные байты потока/CDN и выбранная озвучка независимо не сверены.

Этот контроль локализует отказ воспроизведения на MF AAC пути в выбранном
сценарии. Запуск с административными правами не является необходимым для
успешного FFmpeg playback и не принимается как исправление. Предыдущие
локальные короткие MP4 smoke не подтверждают HLS/MSE-путь реального сайта.

Следующий ограниченный шаг: получить Media Events/Messages зависшего B
(буферизация audio/video, pipeline state, ошибки, pause/play), затем
воспроизвести проблему на локальном HLS/MSE с теми же свойствами AAC.
До этого не удалять FFmpeg и не начинать новую полную сборку CEF.

### Events/Messages зависшего B — 2026-10-25

Скриншоты владельца: pipeline kStarting → kPlaying; seek_target=0.1 с,
kSeeking → kPlaying; video BUFFERING_HAVE_ENOUGH. На снимке нет audio
HAVE_ENOUGH, kPause или явного decoder error; это ограниченный видимый лог,
не доказательство полного отсутствия этих событий. MF AAC выбран с 48000 Hz,
stereo, codec_delay=0, discard decoder delay=false. D3D11 H.264 main выбран.
Отклонения Symphony/IAMF/Opus перед успешным MF selection — перебор кандидатов,
не доказательство причины зависания. Truncating audio buffer на -1 us
описывает обрезку начальной границы append window, не самостоятельный root cause.

Прочитан pinned media_foundation_audio_decoder.cc: Decode/ProcessInput,
PumpOutput и ResetTimestampState. MF использует AudioDiscardHelper с
 delayed_discard=true и config.codec_delay(); FFmpeg отдельно учитывает
should_discard_decoder_delay и использует delayed_discard=false. Это различие
для проверки, не установленная ошибка. Проверить поток AAC 48 kHz через MSE,
начальные timestamps/append-window и seek 0.1 с; сравнить выдачу PCM до/после
Reset. Исходники и CEF не изменялись, сборка не выполнялась.

### Локальный MSE + AAC 48 kHz + seek — 2026-10-25

Без пересборки CEF выполнена последовательная пара на неизменном v2 runtime,
с новыми SSD TEMP-профилями. Из pinned bear H.264 и синтетического sine
FFmpeg создал короткий fragmented MP4: видео скопировано, AAC stereo 48000 Hz.
Тест добавляет файл через MediaSource/SourceBuffer и по loadedmetadata
вызывает currentTime=0.1. В режиме A выбрался FFmpegAudioDecoder, B —
MediaFoundationAudioDecoder. В обоих AudioConfig: 48000 Hz, stereo,
codec_delay=0, discard_decoder_delay=false. Оба дошли до EOF: 6.139466 с,
181 кадр, visible/focused, media error отсутствует, muted=true. Это не
проверка физического звука. Оба runner exit=0/shutdown_complete.

[Компактные данные](reports/mse-aac-20261025/summary.json).
Локальные скрипты и полные логи: `.local/mse-aac-20261025/`.
Проверены Node syntax, EOF/frames, событие test-seek-request, видимость и
точные имена decoder. Кандидат также записал platform selection=true.
Это исследовательский runner на базе diagnose-media, не новый production API.

Следовательно, 48 kHz, MSE, discard_decoder_delay=false и начальный seek
сами по себе недостаточны для воспроизведения зависания сайта. Исправление
в Reset/AudioDiscardHelper без дальнейших доказательств не обосновано.

Дополнительный контроль: один старый TS-сегмент из уже предоставленного HAR
(AAC-LC 48000 stereo, H.264 Main) перепакован в fMP4 с aac_adtstoasc без
перекодирования. Он относится к другому фильму. MSE отверг его на стадии
append parsing в обоих режимах, до выбора декодеров; это непригодный пока
fixture для проверки MF, не новый отказ MF. Первые ошибки перепаковки и
попытка с неподходящим MIME сохранены отдельно; исправление MIME по avcC
не устранило append failure. На основании этого контроля вывод о работе
декодера не делается.

Следующий шаг — сохранить точные init/media fMP4 buffers, которые формирует
PlayerJS/HLS для зависшего потока, и воспроизвести их порядок append/seek
локально. Альтернатива — дополнить loopback fixture тем же HLS transmuxer.
Пакеты PCM, timestamps и buffering проверять на этом воспроизводимом входе;
новая полная сборка CEF не запускалась.

### HLS transmuxer контроль — 2026-10-25

В локальный стенд загружен hls.js 1.6.13 из npm registry, SHA-512 tarball
сверен с dist.integrity. Зависимость только в ignored `.local`, приложение
не менялось. Один сохранённый TS-сегмент старого фильма подан как loopback
HLS VOD с startPosition=0.1; hls.js сам выполняет TS→MSE перепаковку.
Это не установленная версия HLS внутри PlayerJS и не точный зависший поток.

Последовательная пара A/B: FFmpegAudioDecoder и MediaFoundationAudioDecoder
оба EOF 6.021333 с / 144 кадра, visible/focused, media error отсутствует,
muted=true; физический звук не проверялся. Оба exit=0/shutdown_complete,
MF selection=true, 26 runtime SHA не изменились. Таким образом, общий
HLS→MSE с этим сегментом тоже не воспроизводит отказ сайта.
[Компактные доказательства](reports/hls-aac-20261025/summary.json).
Полные скрипты/данные: `.local/hls-aac-20261025/`.

Подготовлен bounded capture точного MSE-входа PlayerJS:
[scripts/capture-mse-input.js](../scripts/capture-mse-input.js),
[инструкция](MSE_CAPTURE.md). Node syntax и проверки копии/view offsets,
return/throw, лимитов и восстановления методов прошли. В рабочий код браузера
перехват не добавлен. Нужен ручной запуск сборщика на зависшем B и файл
`.local/hdrezka-mse-capture.json`; без него точный вход ещё не получен.

### Точный вход PlayerJS: локальный отказ MF воспроизведён — 2026-10-25

Владелец дописал capture после прежнего объекта в ignored
`.local/platform-hdrezka-ab-reference-launch-20261025.json`. Исходный файл
не менялся; JSONDecoder извлёк capture в отдельный normalized файл.
Захват: 12477371 байт, 21 операция, dropped=2 из-за лимита. Есть оба init
и первые media buffers. Начальные abort/endOfStream принадлежат прежним
SourceBuffer без MIME и исключены из воспроизведения новой инициализации.

В локальном replay использованы операции 3–10: два SourceBuffer с исходными
MIME, оба init и по два media append. Сохранены mode, appendWindowStart/End,
timestampOffset=-95443.8806888889 и seek=0.1. Относительные wall-clock задержки
не воспроизведены: append выполняются последовательно с ожиданием updateend.
EndOfStream не добавлялся; это начальный playback-тест, не EOF полного фильма.

| Условие | FFmpeg | Media Foundation |
|---|---|---|
| currentTime в конце наблюдения | 1.09748 с (продвижение подтверждено) | 0.1 с (15 с timeout) |
| readyState | 4 | 1 |
| paused | false | false |
| visibility/focus | visible/true | visible/true |
| декодированные видеокадры | см. summary | 5 |
| явная media/play ошибка | нет | нет |
| decoder | FFmpegAudioDecoder | MediaFoundationAudioDecoder |

MF selection=true. Оба процесса штатно закрылись, exit=0/shutdown_complete;
это не означает успешный playback кандидата. Все 26 runtime SHA неизменны.
Внешние сайты/сеть в replay не использовались. Проверки критериев различия
прогонов и decoder names прошли. Видео muted: физический звук не проверялся.
[Компактные данные и SHA буферов](reports/mse-exact-20261025/summary.json).
Полный локальный стенд: `.local/mse-exact-20261025/`.

Таким образом, получен воспроизводимый на конкретном входе отказ MF без
VPN/внешнего CDN и без фоновой паузы. Первопричина ещё не установлена.
Следующий ограниченный контроль — тот же вход без seek, затем отдельная
нормализация временных меток с согласованным изменением tfdt/timestampOffset;
не считать само большое отрицательное смещение ошибкой без контроля.
Новые сборки CEF/оболочки не выполнялись.

### Контроли seek/timestamps и standalone MFT — 2026-10-25

На точном входе выполнены ограниченные контроли без пересборок:

- MF без explicit seek: visible/focused, paused=false, currentTime=0,
  readyState=1, timeout. Следовательно, начальная перемотка не необходима
  для воспроизведения этого отказа. Первый hidden/paused запуск исключён.
- Согласованная нормализация: из tfdt обоих потоков вычтены 95443 секунды
  в собственных timescale (audio48000/video90000), timestampOffset увеличен
  на 95443. Структуры боксов/сэмплы не менялись, равенство итоговой временной
  шкалы проверено с допуском 1e-8 с. MF снова visible/paused=false,
  currentTime=0.1, readyState=1; FFmpeg с теми же изменениями продвинулся
  до1.084369с, readyState4. Сам масштаб исходных tfdt/offset не объясняет сбой.
- Из captured audio init + первых двух media fragments без перекодирования
  сформирован ADTS fixture. Готовый raw.exe снял ADTS и передал 560 исходных
  raw AAC пакетов с ASC1190 системному MSAudDecMFT.dll: 573440 PCM frames,
  999424 ненулевых значений, peak0.73939675, stereo48000, drain выполнен.
  Это standalone вне Chromium sandbox, с заново заданными timestamps;
  он подтверждает поддержку пакетов системой, но не идентичность окружений.

MF selection и clean exit подтверждены во всех принятых MF-контролях.
FFmpeg-нормализованный контроль также clean exit. Проверки критериев состояний
и временной шкалы прошли. [Данные](reports/mse-controls-20261025/summary.json).
Локальные положительные и отрицательные отчёты сохранены в
`.local/mse-exact-20261025/`.

Следующая точка поиска — адаптер MF внутри Chromium: входные/выходные сэмплы,
AudioDiscardHelper и доставка PCM в renderer, с сохранением sandbox. Seek
и большое абсолютное смещение не подтверждены как причины. Причина ещё не
установлена; инструментирование адаптера должно быть отдельным ограниченным
этапом, полная новая сборка Chromium не запускалась.

### Несоответствие ADTS / RAW на входе MFT подтверждено — 2026-10-25

Без пересборки CEF использован точный PDB b0ecccbf… DLL. RVA Decode и
AudioDiscardHelper получены из PDB publics с проверкой PE .text RVA.
CDB подключался только к новым одноразовым GPU-процессам локального replay,
без SeDebugPrivilege/изменения токенов/ослабления sandbox. Первые 16 вызовов:
ProcessInput=S_OK, ProcessOutput=0xc00d6d72 (NEED_MORE_INPUT), в вызовах
AudioDiscardHelper decoded_buffer=null. Это диагностическая трасса,
не приёмка playback: debugger влияет на тайминг, были hidden/paused состояния.
Отрицательные попытки с ошибкой CDB quoting, initial load timeout и hidden
precheck сохранены, не засчитаны успешными.

В следующей трассе прочитаны первые три DecoderBuffer. AAC payload содержит
ADTS: первый пакет 30 байт начинается ff f1 4c 80 03 df fc de 02 00 …,
следующие 13-байтовые начинаются ff f1 4c 80 01 bf fc 21 … . В captured mdat
первый raw пакет начинается de0200… . Пинованный MP4StreamParser::PrepareAACBuffer
в media/formats/mp4/mp4_stream_parser.cc добавляет ADTS, если fits_in_adts().
При этом GetAacAudioType в media/base/win/mf_helpers.cc выставляет wPayloadType=0
(RAW AAC). Модифицированный MF adapter ADTS не снимает.

Проверены альтернативные различия standalone: input bits16/32 и наличие/
отсутствие MFT_MESSAGE_NOTIFY_START_OF_STREAM. Все четыре сочетания дают
559 выходных сэмплов до drain, итог573440 PCM frames. Эти параметры сами по
себе отказ не воспроизводят. Собран только маленький standalone C++ стенд,
не Chromium и не CEF.

Решающая пара standalone на тех же560 пакетах, bits16, без START_OF_STREAM:
после снятия ADTS — 559 output samples до drain и ненулевой PCM; с сохранёнными
ADTS при RAW-настройке — 0 output samples, после drain silent_or_empty_output.
Это воспроизводит несоответствие форматов на входе MFT и объясняет наблюдаемое
NEED_MORE_INPUT в Chromium. [Компактные данные](reports/mf-adapter-diagnosis-20261025/summary.json).
Полные скрипты/трассы/попытки: `.local/mf-adapter-diagnosis-20261025/`.
Все26 runtime SHA совпали, пользовательская установка не менялась.

Следующий ограниченный этап — корректно согласовать ADTS/RAW в Windows AAC
adapter: учесть raw-вход обычного MP4 и ADTS-вход MSE, не ломая остальные
аудиокодеки/метаданные. Патч/его browser runtime ещё НЕ проверены; одного
standalone доказательства недостаточно для заявления об исправленном сайте.
Полную сборку CEF не запускать. При разрешении следующего бинарного эксперимента
достаточны компиляция изменённого объекта и изолированная линковка из готовых
объектов, но они также требуют времени/памяти и в этом этапе не выполнялись.

### Патч ADTS/RAW подготовлен — 2026-10-26

Добавлен отдельный 0005-windows-aac-adts-input.patch поверх точного 0004.
Меняется только media_foundation_audio_decoder.cc: для AAC распознаётся один
полный ADTS frame, перед MFT используется payload без7/9-байтового заголовка.
RAW AAC передаётся без изменения; исходные timestamps/duration сохраняются.
Обрезанные/несогласованные ADTS, неверный layer/frequency и несколько raw data
blocks отклоняются, несколько ADTS frames в одном DecoderBuffer не поддержаны.
CRC не проверяется этим framing helper. Иные аудиокодеки не нормализуются.
Новых зависимостей/процессов/сети у runtime не добавлено; постоянная прибавка
кода и расходы ещё не измерены. Helper использует span без дополнительной
копии payload; прежняя копия в IMFSample остаётся.

Защищённое применение: scripts/apply-platform-aac-adts.py проверяет SHA
исходника и результата, default check-only, --apply пишет один файл.
Проверены check-only без записи, применение, повтор, отказ на upstream change;
нативные тесты RAW, ADTS7/9, обрезки, неверных размеров/layer/frequency/blocks
прошли. Скрипт tests: scripts/test-platform-aac-adts.py; MSVC /W4 /WX /O2.
Тот же helper в standalone исправил ранее отказавший ADTS-as-RAW сценарий:
560 input packets,559 output samples доdrain,573440 PCM frames послеdrain.

Один patched C++ файл скомпилирован реальными official Release флагами
Chromium, включая /WX, в отдельный объект; живые Chromium sources/objects не
изменялись. Compile SHA: f255d7878aeb339d596e4c917e52cdbdc38bf7cb7073d90f83da4cca8b8c9139.
Изготовление DLL запущено только как изолированная линковка готовых объектов
с заменой этого одного объекта; полная сборка Ninja/Chromium не запускалась.
Предыдущие DLL и установка не заменяются. Результат browser replay ещё ожидается.

### Исправленный runtime проверен локально — 2026-10-26

Изготовлена отдельная DLL SHA5866f7cc0ff9e2f047e7e383735dc7026add6b0f7aa96956d6a9efd6b22bef5d,
309112832 байта (тот же размер файла, что у кандидата0004; это не замер CPU/RAM).
Компилировался один C++ объект; изолированная линковка готовых объектов заняла
326.88с, archive0.51с. Один снимок private memory линкера6556MiB, не peak.
Исходный official libcef.dll SHAef8d… сохранился. Полная Ninja/Chromium сборка
не запускалась, обычная установка/обновления не менялись.

На точных init/media буферах PlayerJS исправленный MF прошёл порог продвижения:
currentTime1.003668с, readyState4, paused=false, visible/focused, без media/play
ошибки, MediaFoundationAudioDecoder selected=true. До исправления тот же вход
стоял на0.1/readyState1. Это короткий forward-progress тест, не EOF фильма.

Регрессия RAW AAC/MP4 и VP9/Opus WebM: оба EOF по82кадра. WebAudio AAC дал
ненулевой PCM старым FFmpeg-путём. Стандартный check-platform-aac-report
passed=true, sandbox-токены приняты. Оба прогона exit0/shutdown_complete.
[Компактный отчёт](reports/platform-aac-adts-20261026/summary.json).
Полные логи: `.local/platform-aac-adts-20261026/`.

Подготовлен отдельный ручной комплект
`dist/ChroMinimum-system-codecs-test-20261026/`,26 runtime файлов,
401502521 байт. После запуска всеSHA по манифесту совпали. Run-Hdrezka.cmd
включает системный AAC, A-Run-FFmpeg.cmd даёт контроль того же ядра. Новый
TEMP-профиль, обычный запуск, без CDP/NetLog/smoke-таймера. Агент открыл
исправленный комплект на странице «Глубина»; ручные звук/seek/fullscreen и
MF selection сайта ещё ожидаются. FFmpeg fallback/WebAudio остаются внутри:
это не сборка без встроенных H.264/AAC и не публичный релиз.

### Ручная проверка hdrezka принята — 2026-10-26

Владелец подтвердил в комплекте ChroMinimum-system-codecs-test-20261026:
видео и физический звук воспроизводятся без запуска от администратора,
полный экран работает. На приложенном снимке Media Properties выбран
MediaFoundationAudioDecoder (audio) и D3D11VideoDecoder (video), страница
«Глубина»,640x291. Таким образом, на этом сайте подтверждён именно системный
AAC-путь после исправления0005, а не FFmpeg fallback.

Это ручная проверка конкретного контента/ПК. Перемотка отдельно в последнем
ответе владельца не подтверждена; длительная стабильность, другие AAC-профили,
Windows N/другие системы и сравнительные расходы остаются непроверенными.
Сохранённое ядро всё ещё включает FFmpeg fallback и WebAudio AAC; поставка
без встроенных H.264/AAC пока не создана. Следующий отдельный этап — проверить
seek/длительное воспроизведение, затем определить рецепт исключения встроенных
декодеров с сохранением регистрации форматов и протестировать его отдельно.

### Подготовка варианта без встроенных декодеров — 2026-10-26

По запросу владельца подготовлен [отдельный протокол](PLATFORM_CODECS_ONLY_CHECK.md)
и pinned рецепт. Это следующий эксперимент, не изменение принятого runtime.
GN выявил запрет сочетания registration=true/FFmpeg Chromium; guarded patch0006
проверен в изолированном GN-проекте, но к живому checkout не применён.
Новая компиляция не началась. Подробности аудита, WebAudio/WebRTC ограничений
и следующей проверки полного графа находятся в протоколе.
