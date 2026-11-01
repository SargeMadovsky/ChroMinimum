# Штатная мини-панель загрузок — 2026-11-01

**Сборка выполняется, новый runtime ещё не принят.** Два изменённых C++ файла,
UI archive и Rust-оболочка собраны; отдельный libcef перелинковывается.
Старый preview и основная установка не заменены.

## Причина и поведение

Владелец показал неверную flight animation слева и попросил компактную панель
под кнопкой, как у Chrome. В текущем Chromium карточка и анимация использовали
скрытую Chrome toolbar. Публичный CEF API не предоставляет setter этого anchor.

Используется уже существующий DownloadToolbarUIController::InvokeUI и complete
view Chrome, а не отдельное окно оболочки и не HTML-копия карточек:

- кнопка Rust вызывает IDC_SHOW_DOWNLOADS через CEF BrowserHost;
- при наличии native View ID 0x434d4401 команда открывает/закрывает штатную
  мини-панель; пустая история сохраняет стандартный fallback Chrome;
- Ctrl+J отдельно открывает chrome://downloads в текущей странице;
- bubble получает нашу кнопку как views::BubbleAnchor, а не экранную координату;
- очередь flight animation и уже отложенный запуск подавляются при наличии
  этой панели; общие анимации сайтов/Windows не отключаются;
- при скрытой кнопке (fullscreen/minimize) отсоединённый bubble не показывается;
- без специального View ID обычный Chrome fallback не меняется.

[0005 patch](../patches/chromium/0005-download-bubble-anchor.patch) меняет
DownloadToolbarUIController и BrowserCommandController. Хеши всех входных и
выходных файлов закреплены в [metadata](../patches/chromium/0005-download-bubble-anchor.json).
Публичные CEF headers/API hash и cef-rs не меняются. Это внутренний контракт
конкретных сборок ядра/оболочки; при смене Chromium нужен пересмотр патча.

## Воспроизводимость и изоляция сборки

`scripts/build-download-bubble-core.py` использует готовый GN output
E:/cm-platform154/chromium/src/out/Release_Platform_Codecs_Only_x64 и принятый
protocol core из `.local/native-external-protocol-20261030/core-redirect`.
Результат направлен в `.local/download-bubble-20261031/core`.

Два исходника патчатся **только в копии внутри нового output**; GN compile/archive
flags сохранены. Собираются два новых объекта и изолированный ui.lib, затем они
подставляются в сохранённый link response принятого ядра. Объекты protocol0012/
0013 сохраняются с проверкой SHA256. Реальный checkout, базовые объекты,
библиотеки и libcef не заменяются; их хеши повторно сверяются после прохода.
Параллелизм LTO ограничен двумя задачами, перед запуском требуется 25 ГиБ диска.

Конфигурация кодеков не меняется: сохраняется baseline последнего protocol
preview; media0011 остаётся экспериментальным и не становится принятой media
реализацией из-за этого UI исправления. Старый official media alpha.8 не заменён.

Явное применение к другому подготовленному checkout остаётся доступным через
`python scripts/apply-cef-patches.py --chromium-src <src> --download-ui`.
Команда проверяет версию/хеши всех файлов, не применяет patch с fuzz и не является
подтверждением компиляции или работы.

## Проверки

- `test-download-bubble-patch.py --chromium-src <src>`: clean apply, reapply,
  отказ partial/mutated/version-mismatched входам прошли на временной копии.
- C++ controller и command handler собраны с исходными GN flags; ui.lib собран.
- Rust Release, rustfmt, Clippy -D warnings и Node syntax прошли.
- Runtime/geometry/resize, animation suppression и регрессии пока ожидают линковку.

`test-links-downloads.cjs <exe> <new-output> <case> --native-bubble` проверяет
действительные делегаты кнопки/Ctrl+J, сохранение страницы, native geometry,
подавление flight, resize через CEF Window и существующие complete/cancel/
interrupted сценарии Chrome WebUI. Проверяются только синтетические файлы,
loopback и новые TEMP-профили. Диагностика C++ геометрии включается исключительно
при двух explicit switches smoke-test + test-chrome-downloads; приложение
возвращает их в CEF command line только в этом smoke режиме.

Computer-use запрещён владельцем и не использовался. Диагностические команды
не имитируют физические клики. Внешний вид всей native панели и DPI разных
мониторов остаются отдельной ручной приёмкой даже после программных проверок.

## Стоимость и следующий шаг

Новых зависимостей, служб, опроса в приложении или сетевых запросов оболочки нет.
Ожидаемая runtime-добавка — поиск native View по событию UI; RAM/CPU/startup
не измерены. Во время сборки читаются крупные GN inputs и повторно линкуется CEF;
числовые отсчёты находятся в `.local/download-bubble-20261031/link-resources.jsonl`.
Предыдущая protocol линковка занимала около 90 минут, но это не ETA нового прохода.

После линковки: отдельный hashed preview, downloads/anchor/resize проверки,
регрессии native external protocols, fullscreen и TLS/sandbox. Затем обновить
этот статус и TASKS по фактическим результатам. Установка/подпись/публикация в
эту задачу не входят.

## Общий кандидат 2026-11-01

Изолированная линковка завершена. Ядро257a011b… объединено с текущим адаптером
08436ad1… и системным AAC. Complete8MiB, cancel (два повтора), interrupted,
кнопка/Ctrl+J, возврат к странице и clean shutdown прошли. Anchor до resize:
[1014,36,36,34], bubble[722,66,334,169]; после resize:
[814,36,36,34], bubble[522,66,334,169]. Flight suppression подтверждён.
Первый cancel-прогон завершился assertion по двум page targets; точный источник
лишней страницы неизвестен. Тест теперь сохраняет targets и download-state
до assertion и закрывает собственную страницу при ошибке. Успешные повторы
не доказывают устранение причины. Полная повторная protocol-регрессия19/19 прошла.
См. [интеграцию](PLATFORM_CODECS_RELEASE_INTEGRATION.md).
