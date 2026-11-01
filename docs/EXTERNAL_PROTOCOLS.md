# Внешние протоколы — штатный Chromium

Автоматическая приёмка завершена 2026-10-31. [Отчёт](reports/native-external-protocol-20261030/summary.json).

## Текущий вариант

По запросу владельца системный MessageBox/ShellExecuteW оболочки заменён на
штатный `ExternalProtocolHandler` Chromium. CEF получает ResourceRequestHandler
только для внешних схем; `OnBeforeResourceLoad` явно возвращает CONTINUE
(default сгенерированного cef-rs здесь отменяет запрос). `OnProtocolExecution`
разрешает передачу в Chrome layer. Сам браузер Rust не запускает приложение.
Chromium выполняет экранирование, проверку регистрации, штатное подтверждение,
origin/protocol permissions и защиту от повторных запросов. Наличие регистрации
не отменяет политики Chromium; например, mailto имеет собственное upstream правило.
Неизвестный протокол без установленного обработчика не обязан показывать диалог.

Обычные ссылки и редиректы сохраняют контекст инициирующего сайта. Ссылки,
запрашивающие новое окно, направляются в исходный frame только при user gesture.
CEF LoadURL/LoadRequest не сохраняют renderer initiator. Поэтому для внешнего
popup в живом исходном документе выполняется только присваивание location.href:
каждая UTF-16 единица URL экранирована; исходный URL frame повторно сверяется
перед выполнением. Недействительный/сменивший URL frame отклоняется (hash-only смены допускаются). Это обычная
renderer navigation, а не OS launch; она сохраняет реальный origin/sandbox.
HTTP(S) путь не менялся. Незапрошенные popup остаются заблокированы. В адресной строке поддерживаются и схемы без `://`,
например mailto. Для неоднозначного `scheme:число` с допустимым TCP port
оболочка читает наличие URL Protocol в HKCR: зарегистрированная схема остаётся
URI, незарегистрированное имя становится HTTPS host:port (включая intranet имена).
Это два локальных read-only registry запроса по Enter, не разрешение запуска;
Chromium повторно проверяет handler/consent. Для обычных URL с `://` этих чтений нет.
Win32_System_Registry добавлен к уже имеющемуся windows-sys, новых crates нет.

Внутренние схемы и Windows drive paths не передаются через наш обработчик
внешних схем. Нормализация URL и экранирование перед OS launch остаются в Chromium.
Однобуквенные схемы исключены из-за неоднозначности с дисками. Сам Chromium
дополнительно применяет свой список запрещённых схем и политики.

## Узкий патч CEF

[0012](../patches/chromium/0012-cef-native-external-protocols.patch) меняет только
`cef/libcef/browser/chrome/chrome_content_browser_client_cef.cc` pinned revision
14c5a08 / Chromium 154.0.8037.98. В исходном helper отсутствие живого initiator
приводит к return, включая корректный CEF LoadURL из адресной строки. Запрос без
живого документа допускается к обычной Chrome policy/consent цепочке только при
primary main frame + TYPED + отсутствии fenced frame. TYPED здесь доверенный:
`VerifyBeginNavigationCommonParams` в `content/browser/renderer_host/ipc_utils.cc`
отвергает non-webby renderer transitions; renderer OpenURL проходит через
`Navigator::RequestOpenURL`, который задаёт LINK. Истёкший renderer LINK остаётся
отвергнут. Проверки sandbox, TLS, Chromium scheme permissions и согласия не
отключаются. Это не прямой OS launch.

Первоначальная версия дополнительно требовала отсутствия initiating origin и
изначального документа. Матрица выявила отказ адресного HTTP redirect: transition
0x02000001 (TYPED), origin opaque, native dialog отсутствовал. Ограничение заменено
на проверенный выше признак доверенной browser navigation; новый кандидат
прошёл все19 сценариев, включая этот redirect. Перенаправление может иметь opaque origin или уже исчезнувший
speculative document, что само по себе не означает renderer-запрос.

Применение с SHA-проверкой/идемпотентностью:
`python scripts/apply-native-external-protocols.py --chromium-src <src>`.
Тест изменения входа: `python scripts/test-native-external-protocol-patch.py`.
Guard fixture компилирует настоящий извлечённый guard block в тестовом окружении,
проверяя live/expired document, address bar, LINK/RELOAD, subframe/fenced и typed redirect с origin.
Это проверка логики guard, не Chromium integration или независимый аудит.

[0013](../patches/chromium/0013-cef-explicit-numeric-protocol.patch) меняет только
ChromeBrowserHostImpl::Navigate: после disambiguation в оболочке сохраняет валидный
нестандартный numeric opaque URL вместо повторного omnibox fixup. Однобуквенные,
внутренние и view-source схемы исключены из этого special case. Native consent/
blocked schemes/sandbox остаются без изменений. Причина подтверждена исходниками:
URLFixerTest преобразует host:123 в HTTP, а FillNavigateParamsFromOpenURLParams не
восстанавливает исходный URL. Baseline numeric case на готовой0012 DLL воспроизвёл HTTP rewrite; test guard
отменил его до сети. Один более ранний startup прогон под нагрузкой не дождался
CDP и не засчитывается. Окончательная DLL0012+0013 прошла numeric URI без HTTP rewrite и полный прогон19 сценариев.
Применение: тот же apply helper с `--patch 0013`. Патчи0012/0013 проверены на
применение, повторное применение и отказ без мутаций изменённому входу.

## Проверки и расходы

Штатный диалог обычной ссылки подтверждён без computer-use: CDP Tracing записал
`Widget::Show` с layer=`ExternalProtocolDialog`. На синтетическом профиле с
заранее заданным origin/protocol permission штатная цепочка действительно
запустила одноразовый handler и передала точный fixture URL. Это тест уже
сохранённого разрешения, а не нажатия «Открыть» в настоящем диалоге.
Тесты используют loopback, новые TEMP-профили и уникальные HKCU protocol keys;
ключи удаляются в finally. Handler только пишет адрес, не выполняет команды.
Реальные Steam/Telegram и пользовательские профили не использовались.

Автоматическая матрица: `scripts/test-external-protocols.cjs`; ожидает временную
регистрацию `tests/native/external_protocol_capture.rs`. JSON/trace/логи сохраняются
в `.local/native-external-protocol-20261030/`. Неудачные прогоны сохранены:
initial wrapper CANCEL, лишние popup-страницы и повторный smoke address hook.
Лишние страницы и повторный hook устранены. Origin-preserving popup путь прошёл
передачу тестовому handler; window.open показал один native dialog. Flood из
восьми ссылок показал один dialog и семь отказов Chromium. Sandbox iframe без
allow-popups не вызвал handler/dialog; allow-popups показал один native dialog.
Все эти прогоны завершились exit0/shutdown_complete. Адресный путь0012 показал native dialog, сохранил одну страницу, exit0/shutdown_complete.
Hash-after-click также реально запустил fixture handler и штатно закрылся.
Проверка generated snippet в Node vm прошла шесть случаев: identity/hash changes/
escaping и отсутствие вызовов переопределяемых String helpers. Это logic unit,
не browser sandbox. Дополнительная receiver-side сверка href закрывает смену
URL между UI task и выполнением в renderer.

Новые crate-зависимости/фоновые службы/таймеры и собственные сетевые запросы не
добавлены. Win32_UI_Shell больше не нужен оболочке. Сравнительные RAM/CPU/startup
не измерены. Стоимость пересборки заранее сообщена владельцу: прежний CEF link
занимал около80мин; это ориентир прошлого запуска, не текущий замер. Патч
компилируется флагами существующего E: output в отдельный каталог; его media0011 уже является отдельным
непринятым экспериментом, поэтому кандидат не заменяет принятую media-поставку.

Dry-run0012: один CXX и один LINK,1067сек обхода dependency graph. Staged CXX
завершён exit0 за87.6сек. Изолированный link использует те же GN inputs/flags с
заменами двух CEF object; out/DLL/PDB перенаправлены, LTO jobs=2 как в прежнем
экспериментальном linker helper. Исходные object/DLL проверяются до/после.
Команда: `scripts/build-native-external-protocol-core.py --chromium-src <src> --output <new-dir>`.

Основная установка и публичные пакеты не заменялись. Ручная проверка реальных
кнопок native dialog, визуального вида/DPI и реальных приложений остаётся отдельной.
Linux/macOS этим Windows runtime прогоном не проверены.

## История D040

Предыдущий вариант использовал принадлежащий окну MessageBox и ShellExecuteW
на UI-потоке. Release/Clippy/классификация/startup smoke прошли; нажатия и передача
приложению не были приняты. Владелец сообщил, что часть ссылок подвешивает браузер.
Причина конкретного зависания не установлена; блокирующий обход полностью удалён.
Историческая DLL808960байт/SHA7d72940e026d037f979686b5c82e6f90daf9e59633e9d576db4fc151c33109aa
не является текущим native кандидатом.

Первая DLL0012: SHA131ff854e7476eb8c3e1deabb08ad8107b408f5ef7e3d2a37b19f762698bc865,
307116544байта; link exit0,4207сек. Base DLL/object не изменены. Объект0013
первоначально отказал из-за отсутствующего GURL::path_piece; по реальному
url/gurl.h исправлен на path(), отдельный retry exit0 за19.3сек. Оба финальных
объекта с pin/hash сохранены. Этот промежуточный link завершился exit0 за3469сек.


## Окончательный проверенный комплект

DLL с исправленным redirect guard: SHA256
`5cce388edadec6c838592923be7f31caacbfbce354451c36c33020d7c563b61a`,
307116544байта; link exit0 за5447.8сек (90.8мин). Размер DLL совпадает с базовым;
это не измерение размера установочного архива. Исходная DLL и два исходных object
не изменены. Адаптер821248байт, SHA256
`1a3f88476bd6dbc8c4946294269ec83a0a405fb74e254893482af1dd0a112443`.
Все26 файлов подготовленного runtime повторно проверены по manifest.

Отдельный запуск: `.local/native-external-protocol-20261030/preview-verified/Launch.cmd`.
Он использует новый временный профиль. Основная установка и публичные пакеты
не обновлялись; базовое ядро содержит экспериментальный media0011, поэтому этот
комплект не является принятой производственной media-поставкой.

Полная матрица19/19: обычная ссылка, target blank, window.open, HTTP redirect,
hash-after-click, три prompt-варианта ссылок, адресная строка, её HTTP redirect,
numeric opaque URI, отсутствующий handler, popup без gesture, flood, два
sandbox iframe и три HTTP(S) варианта. В пяти случаях с заранее сохранённым
разрешением тестовое приложение получило точный URI, включая параметры/%20;
в восьми сценариях записан native ExternalProtocolDialog. Для остальных
проверены ожидаемый отказ или обычная HTTP навигация. Все19: одна страница,
отзывчивый CDP, exit0 и shutdown_complete. Flood: одна prompt policy decision
и семь отказов. Регистрация случайного HKCU протокола удалена и проверена.
NetworkService: AppContainer/Low; renderer: restricted/Low; token errors0.

Rust Release/Clippy -D warnings, три Rust unit, шесть generated-JS случаев,
девять извлечённых C++ guard случаев и apply/reapply/reject обоих патчей прошли.
Выполнено локальное ревью исходников/изменений; специализированный сервис и
независимый аудит не запускались. Старый общий links/downloads CDP тест не прошёл
из-за смены navigation context; его изменения откатили. Это не положительный
результат проверки загрузок; три новых изолированных HTTP link случая прошли.

Нажатия настоящих кнопок «Открыть»/«Отмена», внешний вид/DPI и реальные
Steam/Telegram остаются ручной приёмкой: computer-use запрещён владельцем.
Автотест передачи использует сохранённое разрешение только в синтетическом
профиле. Сравнительных замеров RAM/CPU/startup и Linux/macOS runtime нет.


## Интеграция в сборку, 2026-10-31

Владелец проверил ссылки Steam и ввод адреса, предоставил скриншоты native dialog
и одобрил интеграцию. Различие текста/галочки у file:// и адресного ввода штатное;
отсутствие диалога у неизвестной схемы без handler ожидаемо. Это не полная ручная
матрица всех кнопок/DPI/платформ.

Оба патча0012/0013 обязательны в `build-cef.ps1` и `build-cef-media-release.ps1`
после генерации, до компиляции. Их отказ останавливает сборку; recipe/policy
содержат имена патчей. Stock CEF из другого комплекта не приобретает эти
исправления от одной замены Rust DLL.

Локальный комплект: `dist/ChroMinimum-0.0.1-alpha.8-external-protocols-windows-x64/Launch.cmd`.
Рядом ZIP193071233байта (184.1МиБ), SHA256
`74cf7061834fde09c55ae15dd471d7388f1eabee294fbc998896a0b371c5d6cd`.
Повторная перелинковка не выполнялась: бинарники совпадают с принятой матрицей.
Профиль сохраняется отдельно в data рядом с комплектом; в архив он не включён.
Старый installer-seed.json с чужими хешами исключён из portable runtime.

После распаковки Launch.cmd однократно вызывает штатный icacls для чтения/runtime
AppContainer и записывает marker; следующие запуски пропускают подготовку.
Разрешение RX касается runtime, не профиля. Это существующая схема подготовки
bundle/installer, не отключение sandbox. Расходы первого вызова не измерялись;
постоянный процесс/служба и новые зависимости не добавлены.

Проверены25 runtime SHA256, ZIP CRC/состав без профилей, smoke прямого комплекта
и первого запуска распакованного ZIP: локальная страница200, sandbox_requested,
shutdown_complete. Отказ чужому acceptance и profile path проверен до записи
выхода. [Отчёт интеграции](reports/native-external-protocol-20261030/integration.json).
Установщик, основная установка и публичные пакеты не заменялись. Media0011
по-прежнему экспериментален; его приёмка и включение в installer не следуют
из приёмки внешних протоколов.

Воспроизведение упаковки (нужен новый output):
`python scripts/package-external-protocols.py --preview .local/native-external-protocol-20261030/preview-verified --report docs/reports/native-external-protocol-20261030/summary.json --output dist/<new-name>`.
