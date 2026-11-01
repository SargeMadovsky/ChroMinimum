# Подготовка штатного системного AAC — 2026-11-01

Статус на 2026-11-01: патч применён к актуальной оболочке после завершения
соседних доработок. Собран локальный общий кандидат
`dist/ChroMinimum-0.0.1-alpha.8-integrated-test-20261101`.
Исторические этапы ниже сохранены; текущие результаты приведены в этом разделе.

- Ядро с media0011, protocol0012/0013 и download-bubble:
  `257a011b5872e19f994311fdca34c7fc9f4b8009cb687227868c6d823dbd8d8d`.
- Адаптер с `windows-platform-codecs`:
  `08436ad1506c7f763877ae682d1089e475221e7730aaddf01ad104276bc61284`.
- Release и Clippy `-D warnings` прошли. Новая компиляция Chromium не выполнялась:
  использовано готовое изолированно перелинкованное ядро загрузок.
- MP4 H.264/AAC и WebM VP9/Opus дошли до EOF (по82 кадра), WebAudio AAC
  декодирован через MF. Проверка выполнена без тестового включения кодеков,
  с видимой страницей; sandbox tokens и clean shutdown прошли.
- Загрузки complete/cancel/interrupted, Ctrl+J, кнопка, resize/anchor и подавление
  flight animation прошли. В первом cancel-прогоне было два page targets вместо
  одного; два повтора cancel прошли. Причина единичного сбоя не установлена.
- Настоящий локальный архив175433091 байт прошёл updater install/trial/health
  с одноразовым ключом и сверкой runtime hashes. Сеть и production key не
  использованы; браузер из установленного обновлятором каталога не запускался.
- Полная повторная матрица протоколов прошла19/19, все exit=0 и
  shutdown_complete; временная регистрация обработчика удалена. Первый popup
  сбой не воспроизвёлся; его причина не доказана. Добавлен assert готовности fixture.
- Четыре WebAudio декодирования ADTS/M4A × offline/realtime прошли:
  по123244 frames,44100Hz,stereo,peak0.0991329625; clean shutdown.
  Звучание этих четырёх PCM-проб отдельно не проверялось.

[Сводный отчёт](reports/platform-integrated-20261101/summary.json).

Логи и точные результаты: `.local/platform-integrated-candidate-20261101`.
Текущая установка пользователя не изменена, релиз не опубликован.
Изменившийся адаптер требует полного установщика/миграции доверенного seed;
последующие обновления ядра с тем же адаптером могут использовать media-канал.
См. [контракт адаптера](UPDATER_ADAPTER_BINDING.md).

## Ручная приёмка и следующий установщик

2026-11-01 владелец сообщил «Да вроде всё нормально» после запуска общего
кандидата. Общая ручная приёмка принята; отдельная полная DPI/сценарная матрица
не заявляется. Следующий этап — новый TestInstall с точным проверенным seed
и актуальным launcher. Существующий launcher от2026-10-23 и прежний alpha.8
setup не следует выдавать за новый кандидат. Проверка updater archive выше
не заменяет запуск браузера через установленный launcher.

## История подготовки (до объединения)

## Подготовленный патч оболочки

[Патч](../patches/windows-platform-codecs-shell-staged.patch) добавляет явный
Cargo feature windows-platform-codecs. Только этот Windows-вариант включает
ChroMinimumPlatformAudioFirst в обычном запуске и дочерних процессах; тестовый
env или аргумент не нужен. Stock/default и другие ОС не переключаются.
Это не автоматическое определение возможностей произвольной CEF DLL.

Политика очищает конфликтующее отключение именно этой feature, сохраняя
остальные настройки, включая обязательную NetworkServiceSandbox. Новых
зависимостей, служб, таймеров или сетевых запросов нет. Ожидаемая добавка —
обработка строк feature flags при старте процессов; размер/RAM/CPU/startup
полной оболочки пока не измерены.

В отдельной копии модуль скомпилирован через rustc --test. Все8 проверок прошли:
три codec-policy, четыре существующие network-policy и одна их композиция.
Полная CEF/Rust-оболочка с патчем не собрана и не запускалась. git apply --check
прошёл на снимке исходников; после завершения загрузок нужен повторный rebase
по актуальному Cargo.toml/src/lib.rs, а не слепое применение.

Метаданные и preimage SHA:
[статус](../patches/windows-platform-codecs-shell-staged.json).
Снимки/логи: .local/platform-release-integration-20261101.

## Совместимость CEF и обновлений

Патчи0012/0013 внешних протоколов повторены из pinned CEF Git-версий в
разреженной копии: postimage SHA совпали, файлового пересечения с codec-патчами
нет. Это проверка наложения, не семантики или новой совместной компиляции.
В общем checkout эти патчи уже есть; он и активные компиляторы другого чата
не изменялись.

Найден готовый external-protocols core5cce388e…, по его отчёту основанный на
media0011. Создан отдельный probe с этим core и прежним frozen adapter.
Первый запуск в окружении инструментов отказал на network_sandbox_refused;
повтор на обычном desktop не прошёл предусловие видимости окна. Playback этим
не подтверждён, codec/sandbox policy ради теста не менялась. Повтор UI-прогонов
отложен; только своё изолированное окно было закрыто штатным способом.

Обновлятор проверен на отдельном снимке16 файлов, offline/locked и с output,
TEMP/TMP на E:. Два media security tests прошли: stock не заменяет media seed,
а capability входит в подпись и не может быть подменена. Один real-archive
test намеренно ignored: окончательный пакет ещё не подготовлен. Использованы
тестовые ключи; закрытый production key не читался. Это не приёмка реального
обновления установленного браузера. Контракт остаётся из MEDIA_ENGINE_UPDATES.

## Следующий общий прогон

После завершения загрузок нужно пересмотреть staged patch, собрать оболочку с
windows-platform-codecs и совместимое ядро с окончательными патчами. Отдельный
production-media-probe.cjs подготовлен без CHROMINIMUM_TEST_SYSTEM_CODECS и
без --test-platform-aac: он должен доказать штатное включение AAC на точных
SHA итогового комплекта. Затем — новые загрузки, внешние протоколы, media,
sandbox и clean shutdown в одном кандидате.

Только после этого готовить локальный unsigned media-пакет и проверять его
install/trial/health с тестовой подписью и сохранением security floor. Подпись
capability является утверждением издателя и сама не доказывает правильный
backend. Рабочая подпись/публикация и изменение установки пользователя здесь
не выполнялись. Полный аудит состава/условия распространения не закрываются
этой подготовкой.

## Полный установщик 2026-11-01

Актуальный launcher собран offline/locked, Clippy all-targets -D warnings и33
обычных updater tests прошли;3 ignored остаются отдельными fixture-проверками.
Точный принятый runtime закреплён в
[отдельном baseline](../installer/platform-codecs-20261101-seed.json).
Stage/build scripts принимают явные baseline, launcher и output, поэтому старый
baseline и прежний alpha.8 setup не заменены. Неверный старый baseline отвергается
до создания payload. Обе новые setup сборки находятся в
`.local/platform-integrated-installer-20261101/dist`,34 файла payload402261145байт.
Новый основной setup пока не устанавливался и не публиковался.

Исторически медиа через установленный launcher не было принято: три попытки остановились до
воспроизведения на реальном visibilityState=hidden, включая native-window и
обычный CDP bringToFront. Защита/проверка видимости не отключалась. Это не
опровержение предыдущей media-приёмки portable, но отдельный installed маршрут
проверен в последующей диагностике ниже. EN/RU installation-only прогон прошёл: payload hashes, миграция seed,
HTML→PDF relaunch, PDF RU, Low/AppContainer NetworkService, отказ higher floor,
удаление и сохранение sentinel. UserChoice и регистрация основного приложения
не изменились. Проверка upgrade с настоящего alpha.7 setup не выполнялась:
использован синтетический legacy-core sentinel. TestInstall удалён.
[Отчёт установщика](reports/platform-integrated-installer-20261101/summary.json).

## Диагностика installed media, 2026-11-01

Один последующий штатный прогон имел visible=true, но readiness занял25951мс,
MP4 начал play около26538мс и дошёл до EOF; затем CDP закрылся при30с smoke
watchdog оболочки. Это отдельная подтверждённая проблема времени стенда.
Причина трёх прежних visibilityState=hidden не доказана; более поздние
изолированные installed запуски были visible сразу.

`diagnose-media.cjs --extended-smoke` использует уже существующий smoke-only
`--test-chrome-downloads` (ограниченный watchdog600с и тестовые download hooks),
сохраняя общий watchdog Node120с. Codec test activation не добавляется.
Проверка реальной видимости остаётся, ожидание увеличено до60с; сохраняются
launch-mode и visibility samples. Собственная страница закрывается через CDP
также при ошибке. Product DLL, launcher, sandbox и codec policy не изменялись.
Это не измерение обычного времени запуска и не доказательство устранения
прежнего hidden. EN полный повтор с тем же setup прошёл. RU unattended снова
остановился на hidden за60с; отдельный установленный RU принят с помощью владельца:
он вывел окно вперёд, visibility сменился на visible, MP4/WebM EOF82кадра,
AAC PCM123244/44100/stereo, MF Audio+D3D11Video, sandbox и clean shutdown прошли.
Критические seed hashes сверены; диагностический TestInstall удалён.

Это подтверждает installed media-путь без пересборки DLL. Полный unattended
EN/RU media matrix не объявляется пройденным. Физическое перекрытие окна или
доставка CEF visibility вероятны, но точная причина не измерена. В pinned
`content/browser/renderer_host/render_widget_host_view_aura.cc` WasOccluded вызывает
HideImpl/WasHidden; это прочитанный путь, не runtime-доказательство конкретной
occlusion. Автоактивация/отключение occlusion в продукт не добавлялись.
[Диагностический отчёт](reports/installed-visibility-20261101/summary.json).
