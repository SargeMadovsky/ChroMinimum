# WebAudio AAC через системный декодер: границы следующего эксперимента

2026-10-28. Прочитаны локальные исходники Chromium
`b859317bf11f6be47f9b7799ec690a0a42a1fb33`; прототип не реализован,
новая сборка не запускалась. Рабочий ADTS/M4A/hdrezka кандидат сохранён.

## Подтверждённый путь и препятствие

- `third_party/blink/renderer/modules/webaudio/base_audio_context.cc`:
  `DecodeOnBackgroundThread` вызывает синхронный
  `AudioBus::CreateBusFromInMemoryAudioFile` из worker pool.
- `content/renderer/renderer_blink_platform_impl.cc`, `DecodeAudioFileData`:
  переходит в `content/renderer/media/audio_decoder.cc`. Там AudioFileReader
  разбирает память и выдаёт PCM; проверяются каналы/частота, затем выделяется
  WebAudioBus и копируются каналы.
- `media/filters/audio_file_reader.cc`: OpenDecoder, DecodePacket и EOS flush
  рассчитывают на callback до возврата вызова. Подстановка MojoAudioDecoder
  приведёт к чтению незаполненного optional либо CHECK при flush.
- `third_party/blink/renderer/platform/audio/audio_bus.cc`: ресемплинг к частоте
  AudioContext выполняется после декодирования. Его нужно сохранить.
- В фактическом `gen/media/mojo/buildflags.h`
  `ENABLE_MOJO_AUDIO_DECODER=1`. `media/mojo/services/gpu_mojo_media_client_win.cc`
  создаёт MediaFoundationAudioDecoder. Новый декодерный сервис не требуется
  как исходная гипотеза, но доступ из WebAudio ещё не реализован.
- `content/renderer/media/media_interface_factory.cc` уже перенаправляет
  CreateAudioDecoder на owning task runner через WeakPtr. Фабрика привязана
  к frame broker; перенос голого указателя в worker недопустим.
- `media/mojo/clients/mojo_audio_decoder.{h,cc}`: PendingRemote допускает
  передачу между потоками; bind происходит при Initialize. Далее действует
  sequence checker. Disconnect возвращает ошибку через callback.

## Предпочтительный эксперимент

Сначала отдельная тестовая цепочка: frame-scoped выдача PendingRemote через
существующую MediaInterfaceFactory, затем последовательное async-декодирование
пакетов через MojoAudioDecoder на task runner с обработкой IPC. Системный
декодер остаётся в штатном GPU sandbox; renderer получает PCM. Не загружать
Media Foundation напрямую в renderer и не переносить decoder в browser.

До подключения к JS нужно выбрать точку передачи frame capability: нынешний
глобальный синхронный Platform::DecodeAudioFileData не передаёт frame/context.
Нельзя получать frame через случайный глобальный renderer или сохранять
непроверенный указатель. Проверить frame destruction, navigation, context close
и disconnect. Получение endpoint не должно блокировать renderer main thread.

AudioFileReader содержит нужные timestamp/discard-padding и AAC final trimming.
Следует переиспользовать эти правила либо явно сверить новую реализацию;
простое склеивание MF output не доказывает корректность длительности.
Не делать глобальный перевод всех форматов на новый decoder factory.
Не добавлять ожидания с RunLoop/WaitableEvent в существующий reader без
разбора sequence ownership, завершения и обработки отмены.

## Ожидаемые расходы, не замеры

При первом AAC decodeAudioData возможен ленивый запуск уже существующего
GPU/media пути. Дополнительные расходы: IPC на пакет, encoded data pipe,
передача PCM и состояние незавершённого запроса. Постоянный процесс/служба,
новая сеть или пакет кодеков не планируются. Нулевые расходы запуска не
доказаны; размер DLL и CPU/память нужно сравнить после реализации.

PCM float stereo 48kHz занимает 384000 байт/сек: около 22 MiB на минуту
до учёта копий и ресемплинга. Это размер результата, а не измеренная добавка
нового пути. Нужно учитывать peak памяти при одновременных decodeAudioData,
проверять арифметику frames×channels и ограничивать накопление IPC-буферов.
Численные лимиты ресурса ещё не выбраны: не менять совместимость молча.

## Приёмка до очередной линковки

Тест async-цепочки: AAC-LC ADTS/M4A → ненулевой PCM, EOS/disconnect/error,
отмена при уничтожении frame/context, параллельные запросы, смена конфигурации,
обрезанные данные, invalid config, проверка суммарного размера PCM.
Тестируемые callback должны завершаться ровно один раз, без обращений к
освобождённой памяти и без зависших задач.

После сборки: прежние четыре AAC WebAudio случая (real/offline, ADTS/M4A),
WAV-контроли, длительность/число frames/каналы/частота/peak относительно старой
FFmpeg-сборки; сравнение PCM с учётом допустимых различий декодеров.
MP4/WebM/ADTS media element, точный MSE replay, hdrezka и sandbox/shutdown
остаются регрессиями. Проверить ordinary Medium browser и отсутствие
FFmpeg AAC fallback. HE-AAC, многоканальный AAC и другие ОС отдельно.

Следующее действие — прототип endpoint/lifetime и async decode в тестовом
стенде. Только после его проверки решать точную интеграцию в WebAudio.

## Выполненный стенд 2026-10-28

Без пересборки CEF проверен существующий WebCodecs AudioDecoderBroker.
Один и два параллельных запроса RAW AAC-LC (131 пакет из ADTS, ASC1190)
дали по134144 PCM frames, stereo48kHz, peak0.1024593, без ошибок.
Media log подтвердил MediaFoundationAudioDecoder. Reset/close прервали
pending flush через AbortError ровно один раз. Удаление iframe закрыло
его decoder, outputs=0. Browser Medium, restricted GPU/renderer,
network Low AppContainer; shutdown_complete, exit0.

Уточнение исходного предположения: WebCodecs MediaAudioTaskWrapper получает
InterfaceFactory через Platform::Current()->GetBrowserInterfaceBroker(),
а не через MediaFactory конкретного frame. При этом broker создаётся с
ExecutionContext, и уничтожение контекста проверено отдельно. Поэтому
требование ручного внедрения frame factory — ещё не выбранная реализация:
предпочтительно переиспользовать существующую context-aware цепочку.

Это тест реального существующего Mojo/MF пути через WebCodecs, а не новый
native reader и не исправление decodeAudioData. Принудительный IPC disconnect,
GPU crash, испорченные пакеты и изменение config ещё не испытаны.
Число PCM frames нельзя прямо сравнивать с прежними123244 при44100Hz:
здесь48000Hz и нет WebAudio trimming/resampling.

[Машиночитаемый результат](reports/webaudio-platform-aac-probe-20261028/summary.json).
Страница стенда: scripts/probe-webcodecs-aac-page.js. Raw-журналы и два
неудачных запуска сохранены в .local/adts-demux-20261027/.

## Отрицательные проверки 2026-10-29

Пакет RAW AAC из четырёх0xFF байтов: EncodingError, один error callback,
один rejected flush, outputs=0. Конфигурация sampleRate=0: синхронный
TypeError до decode, outputs=0. Следующий новый decoder снова выдал134144
frames/48kHz/stereo, peak0.1024593. MF selection, sandbox tokens и штатный
exit0 сохранены. Принудительный IPC disconnect и midstream config change
не проверены; close/reset не являются их эквивалентом.

[Результат](reports/webaudio-platform-aac-negative-20261029/summary.json).

### Уточнённая граница реализации

Синхронный Platform::DecodeAudioFileData сохранить для существующих callers
(в том числе AudioBus::GetDataResource); не делать его неявно асинхронным и
не блокировать его ожиданием IPC. decodeAudioData получает отдельный async
путь, возвращающий результат на context task runner. Windows AAC fallback
должен включаться после определения AAC-конфигурации, сохраняя старый путь
для остальных форматов.

Media demux/packet extraction и timestamp/discard-padding/final trimming
переиспользовать из AudioFileReader с ограниченной очередью, вместо разбора
M4A вручную в Blink. Decoder endpoint создать на разрешённой main sequence,
передать PendingRemote на media sequence; MojoAudioDecoder остаётся там до
уничтожения. Удерживать входной ArrayBuffer на срок demux, а не сырой span.
PCM ресемплировать штатным AudioBus кодом после финального trimming, затем
вернуть в существующий NotifyDecodingComplete/HandleDecodeAudioData.

Важная зависимость: AudioDecoderBroker относится к Blink modules и требует
main-thread API. Его нельзя включить из media/filters (обратная зависимость).
Переиспользовать схему Mojo-клиента, не вводить media→Blink modules ссылку.
Отмена должна завершать своё состояние на owning sequence и закрывать Mojo;
возвращаемый callback не должен оживлять уничтоженный context. Точная форма
нового async интерфейса и forced-disconnect стенд ещё требуют реализации.

## Реальный разрыв GPU IPC 2026-10-29

Штатная DevTools Browser.crashGpuProcess применена только к отдельному
тестовому браузеру с одноразовым профилем. Cef.log подтвердил crash и restart
его GPU. Изначальная проверка немедленной JS-ошибки у idle decoder не прошла:
после завершённого flush объект сохранял configured, errors=[] (это не зависший
запрос). Неверное ожидание теста не исправлялось изменением браузера.

Следующий decode/flush на потерявшем связь объекте вернул EncodingError,
закрыл decoder и вызвал error callback один раз; outputs не увеличился.
Новый decoder после восстановления GPU снова дал134144 frames,48kHz/stereo,
peak0.1024593. Medium browser, restricted GPU/renderer, Low AppContainer network
и штатный exit0 подтверждены. Потеря IPC именно во время pending decode
не проверена этим сценарием. Midstream config change также остаётся отдельно.

Результат согласуется с MojoAudioDecoder::OnConnectionError: он завершает
существующие init/decode/reset callbacks, но не создаёт callback для idle
объекта. Следующий Decode видит отсутствие remote connection и возвращает
kDisconnected. Новая интеграция не должна ждать отдельной idle-ошибки.

[Отчёт](reports/webaudio-platform-aac-disconnect-20261029/summary.json).
Рабочая DLL не изменена, production патч WebAudio ещё не создан.

## Реализация async reader начата 2026-10-29

Подготовлен и применён только к экспериментальному E: checkout
patch0010-async-audio-file-reader-prototype (три файла). AudioFileReader
получил OpenAsync с внедряемым AudioDecoder и ReadAsync: один пакет в работе,
продолжение через owning SequencedTaskRunner, EOS ждёт decoder callback.
MakeDecoderBuffer и ReadConfig выделены из старого пути; timestamps,
discard-padding, OnOutput и финальная AAC trimming логика общие.
Close инвалидирует weak callbacks, закрывает decoder и откладывает один
отрицательный ответ незавершённому open/read. Синхронные Open/Read сохранены.

Добавлены три Chromium lifecycle unit tests (delayed callbacks/EOS,
kDisconnected, destruction during open) и отдельный native probe на четыре
сценария (дополнительно destruction during read). Fake decoder не выдаёт PCM:
они проверяют автомат состояния и callbacks, а не качество AAC-декодирования.
На момент записи тесты не исполнены. Запущена компиляция только reader.obj
и unittest.obj; журнал .local/webaudio-async-reader-20261029/build.log.
Полная CEF линковка не запущена. К JS/Platform API новый reader ещё не подключён.

Исходные три файла в C:/cm-media154 сверены с preimage и не изменены.
Рабочая DLL915d85bd… и принятая поставка сохранены. Изменение размеров/CPU/
памяти браузера этим этапом не измерено: новый код ещё не входит в DLL.
Дальше: завершить compile и выполнить native lifecycle probe, затем добавить
владельца async job с удержанием входного буфера и подключением Mojo endpoint.

Compile-результат patch0010: reader.obj и unittest.obj собраны с exit0 (два CXX действия; около10мин с чтением графа). Unit tests пока только скомпилированы. Для выполнения четырёх lifecycle cases добавлен отдельный test-only GN target chrominimum_async_reader_probe с deps base/media; он не является зависимостью libcef/bootstrap. Сборка native target запущена отдельно.

Одноразовый run-after-build.ps1 ждёт завершения native-build worker и затем запускает четыре lifecycle cases с тайм-аутом30с. Результат: .local/webaudio-async-reader-20261029/native-run-status.json. Это не периодическая автоматизация. Пока результата passed нет, тесты не считаются выполненными.

Native результат patch0010: отдельный executable собран, четыре lifecycle cases прошли с exit0. SHA и исходники закреплены в [отчёте](reports/webaudio-async-reader-20261029/summary.json). Это настоящий C++ reader с delayed fake decoder; PCM этой проверкой не доказан. Chromium unit tests только скомпилированы.

## Patch0011: интеграция подготовлена и применена к E: checkout

Windows AAC fallback реализован в существующем Blink platform/media,
async_audio_file_decoder.{h,cc}; общий Platform virtual API не менялся.
Первый staged вариант через Platform API оставлен только как журнал исследования.
В действующем варианте изменены десять файлов, C++ staged-объекты reader,
media request, WebAudio callback и unit callers скомпилированы. DEPS checks
media/webaudio прошли под владельцем checkout; sandbox-вызов git ранее выдал
недостоверный SUCCESS из-за ownership и не считается проверкой.

Core reader лениво создаёт decoder только после AAC config; callbacks
переносятся на owning sequence даже для синхронно отвечающего decoder.
Новый owner удерживает encoded bytes и reader, использует process-scoped
ThreadSafeBrowserInterfaceBrokerProxy и штатный MojoAudioDecoder. Cancellation
thread-safe, событийная: teardown resolver посылает Close в decoder sequence.
Карта отмен удаляется при completion/teardown. Состояние AudioContext.close()
само по себе не переопределено; используется прежний момент отклонения pending
resolvers. Таймер30с прерывает ожидание, но не является CPU-квотой для
синхронного demux. Это ограничение прототипа, не выпускная политика.

Fallback добавляет одну копию encoded input после отказа старого пути.
PCM chunks переносятся с исключительным владением, суммируются с checked
арифметикой и копируются в Blink AudioBus, затем ресемплируются старым кодом.
WebAudioBus не передаётся между потоками. Никакой новой службы или сети нет.
Начатая реализация пока не перелинкована в CEF и не подтверждает decodeAudioData.
Перед браузерным запуском требуется native MF PCM ADTS/M4A и runtime матрица.


### Уточнения проверки0011 — 2026-10-29

GN visibility уточнена только для существующего target
`//third_party/blink/renderer/platform/media:media_final` в media/mojo/clients.
Первый отказ GN сохранён отдельно; после исправления регенерация прошла,
reader и standalone probe скомпилированы. Native MF PCM run ещё ожидается.

На прежней reference DLL проверены два случая decodeAudioData после закрытия:
AudioContext.close() и завершённый OfflineAudioContext. Оба вернули123244
кадра,44100Гц,2канала; [отчёт](reports/webaudio-closed-context-reference-20261029/summary.json).
Поэтому новый cancellation gate проверяет наличие pending resolver, а не
признак is_cleared_: закрытый, но живой context сохраняет возможность decode.
На новой DLL эти случаи ещё предстоит повторить. Предыдущие неудачные попытки
старта reference не дали WebAudio результата и не считаются отказами кодека.

Unit callers ограничены Windows/proprietary build guards. Последние изменения
base_audio_context и unit callers отдельно скомпилированы в staged objects;
это не заменяет компиляцию/линковку настоящего libcef target.


Для приёмки PCM подготовлен scripts/check-webaudio-aac-matrix.py: восемь
фиксированных fixtures, media-element EOF, четыре AAC decodeAudioData по123244
кадра/44100Гц/стерео с ненулевым PCM, два WAV-контроля по22050кадров/моно.
Сохранённый reference-retry принят; старый platform-final закономерно отвергнут.
Проверка проверяет только содержимое PCM/EOF: sandbox, выбранный backend,
завершение процессов и provenance новой DLL проверяются отдельно.

Одноразовый worker build-after-preflight.ps1 ожидает завершения текущего
preflight process через WaitForExit. Он не запускает libcef при провале native
PCM, неожиданном сухом графе (>1000 CXX/>1500 действий), нехватке30GiB на E:,
изменении SHA исходников0011 или другом Ninja для того же output. Это не
периодическая автоматизация; принятая поставка не заменяется. Результаты:
.local/webaudio-integration-narrow-20261029/cef-build-status.json и cef-build.log.


Native0011 завершён: build/test exit0, шесть cases passed. ADTS и M4A каждый
выдали134144кадра/48000Гц/2канала, peak0.102459319 через настоящий MF decoder.
Четыре lifecycle cases используют fake decoder. [Отчёт и SHA](reports/webaudio-native-mf-20261029/summary.json).
Это не браузерный sandbox/Mojo результат; CEF dry-run выполняется перед
настоящей сборкой. Browser decodeAudioData ещё не принят.


Добавлен scripts/probe-webaudio-lifecycle-page.js для parallel decode,
malformed/recovery и восстановления после удаления iframe. Две попытки на
прежней reference DLL остановились на CDP Media.enable/Runtime.evaluate до
получения результатов сценария; это не WebAudio failure и не подтверждение
этого теста. Журналы сохранены в lifecycle-reference и lifecycle-reference-retry
в .local/webaudio-integration-narrow-20261029. Повтор отложен до завершения
сборочной нагрузки. Удаление iframe в этом сценарии не доказывает отсутствие
утечки памяти или обязательный settlement promise уничтоженного realm.


CEF dry-run завершён18:12UTC29октября, exit0:209действий/145CXX.
После успешных preflight/SHA/место/дубликат проверок worker начал настоящий
libcef build, -j6, E:TEMP. Это инкрементальная сборка; DLL и браузерный
результат пока не получены. Прежний принятый runtime сохранён.


После build подготовлена одноразовая test-after-build.ps1 цепочка (ожидание
через process WaitForExit, не расписание). Только при успешном DLL build/SHA
создаётся новый ChroMinimum-platform-webaudio-test-20261029 с сохранённым
frozen adapter из принятой0009 поставки. Дальше: AAC/WAV matrix, PCM и sandbox
проверки, closed contexts, lifecycle. Каждый этап пишет отдельный log;
первый отказ останавливает цепочку. Состояние runtime-chain-status.json в
.local/webaudio-integration-narrow-20261029. Даже completed означает ожидание
ревью и обычных MP4/WebM/MSE regressions, не выпуск или автоматическую приёмку.
Validation helpers проверены на сохранённых closed-context и token отчётах;
lifecycle сценарий по-прежнему не имеет успешного reference прогона.


## Проверка результата — 2026-10-30

CEF0011 build exit0 завершён29октября20:25UTC (30октября01:25 местного времени).
DLL307116544байта, SHA f41f1d3149f53bb54b53a5b16cfa1f1bba42751f82544fb2fa2eae7d13d5a30b.
Восемь AAC/WAV случаев прошли, включая четыре браузерных WebAudio AAC decode
по123244кадра/44100Гц/стерео с ненулевым PCM. Sandbox tokens и clean shutdown
matrix прошли. Оба closed-context случая прошли. [Отчёт](reports/webaudio-platform-aac-runtime-20261030/summary.json).
Lifecycle прогон остановился с Diagnostic socket closed без результата сценария;
в smoke.log есть browser_closed, но причины закрытия ещё не установлены.
Нельзя считать lifecycle принятым или доказанным падением decoder. Требуется
разбор/повтор, затем обычные MP4/WebM/MSE regressions. Релиз не принят.


### Lifecycle повтор — 2026-10-30

Trace без fixtures локализовал8с decode timeout на parallel, до malformed/iframe.
Обнаружен недостаток стенда: без fixture-dir отсутствовал барьер начальной
загрузки; smoke adapter имеет30с auto-close. В dedicated trace runner теперь
обязателен fixture-dir, HTTP GET и main_frame_loaded status200 до CDP, сохранены
метки этапов. Неизменная DLL0011 прошла два новых clean-profile прогона:
parallel offline/realtime, EncodingError malformed, recovery, recovery после
удаления iframe; PCM123244/44100/2, sandbox tokens, shutdown_complete и exit0.
[Отчёт](reports/webaudio-lifecycle-20261030/summary.json).
Это устраняет текущий lifecycle блокер без пересборки CEF, но не доказывает
точную первопричину старого about:blank timeout или отсутствие утечки iframe.
Reference retry завершился до старта сценария и не принимается как сравнение.
Обычные MP4/WebM/MSE regressions остаются следующим этапом.


## Media regressions завершены — 2026-10-31

На той же DLL f41f1d31… прошли MP4 H264/AAC и WebM VP9/Opus EOF по82кадра,
WebAudio AAC PCM123244/44100/2, системный AAC selection, sandbox и exit0.
Точный локальный MSE replay hdrezka прошёл:1.176552с/31кадр, D3D11VideoDecoder
и MediaFoundationAudioDecoder, sandbox и shutdown_complete/exit0.
[Отчёт](reports/webaudio-media-regression-20261031/summary.json).
DLL выросла на22016байт относительно0009; это размер файла, не замер RAM/CPU.

Сохранены отказы стенда: старый15с readiness, два MSE запуска с23–25с старта
при30с smoke watchdog. Direct-CDP без smoke не поднял порт; тест не выполнен,
оставшихся candidate процессов не найдено. Успешный MSE стартовал за11.6с.
Стабильность самого startup стенда требует отдельного разбора: тайм-ауты
нельзя записывать в playback success или считать доказанным decoder crash.

Ограничения: MSE muted и локальный, не живой сайт/длительный просмотр; физический
звук отдельно не проверен. Полный binary audit/условия распространения,
GPU crash во время pending decode, освобождение памяти iframe и расходы
RAM/CPU/startup не закрыты. Проверенные browser cases0011 приняты как
экспериментальный результат, не как разрешение публичного релиза.


### Ручной живой hdrezka — подтверждение владельца

Владелец сообщил «работает» после запуска нового Run-Hdrezka.cmd и запроса
проверить звук/перемотку/fullscreen. На предоставленном снимке живой hdrezka,
позиция04:25/47:35, D3D11VideoDecoder и MediaFoundationAudioDecoder; оба
обозначены как platform/hardware. Это подтверждение владельца и снимок backend,
не отдельное инструментальное доказательство fullscreen/seek/длительности
просмотра или измерение качества звука. Версия DLL соотнесена с предложенным
комплектом; хэш запущенного процесса по снимку не устанавливается.


## Аудит inputs и replay рецепта

Следующий этап выполнен без новой компиляции: [отдельный рецепт](PLATFORM_CODECS_BUILD_RECIPE.md)
и [отчёт](reports/platform-codec-input-audit-20261031/summary.json). Проверены
230 FFmpeg thin members, generated flags/registry/link edge, DLL/PDB identity
и public symbols. Sparse replay27файлов/11патчей и переносимый helper прошли;
выявлен и закреплён обязательный штатный CEF ANGLE preparation patch.
Не закрыты полная binary absence, свежий полный build, production feature default
и интеграция с подписанным обновлением; текущий runtime использует frozen adapter
и тестовый feature toggle. Общая текущая ветка требует также0012/0013,
совместная сборка с ними здесь не проверялась.
