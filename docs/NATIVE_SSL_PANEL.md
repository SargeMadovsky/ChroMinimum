# Штатная SSL-панель Windows — D043

Статус 2026-11-03: отдельное ядро собрано, программная приёмка пройдена.
Ручная визуальная/DPI приёмка и нажатие на просмотр сертификата ещё не выполнены.
Менеджер паролей, основная установка и публичный релиз не менялись.

## Результат

Используется настоящий Chromium PageInfoBubbleView, сразу его OpenSecurityPage.
Он показывает состояние подключения и штатную строку/кнопку сертификата;
для file/internal URL остаётся InternalPageInfoBubbleView. Привязка — к нашему
индикатору в адресной панели. Фокус, крестик, деактивация, смена страницы и
обновление security state обслуживаются Chromium. Самодельный Rust overlay
удалён из текущей реализации, старые preview-комплекты сохранены.

Patch0016 добавляет приватную browser-process команду0x434d5302 к pinned
BrowserCommandController. Получатель проверяет native anchor0x434d5301 в своём
окне, его видимость и наличие текущего NavigationEntry активного WebContents.
Страница не передаёт URL/текст/сертификат и не получает новый IPC API.
CEF public ABI не меняется. Старое ядро не сообщает поддержку команды.

HideExtendedSiteInfo исключает расширенные AboutThisSite/MerchantTrust секции.
TLS verifier, trust store, sandbox и кодеки не меняются. Это штатный раздел
PageInfo, не новый механизм проверки сертификатов. Возврат назад в полный
PageInfo и его help/cookies/permissions пути не считаются принятыми этой матрицей.
Адресный значок по-прежнему читает SSLStatus по событиям загрузки: отсутствие
мгновенного callback динамического mixed content для самого значка остаётся
ограничением; штатная панель имеет собственный DidChangeVisibleSecurityState.

## Изолированная сборка

База: .local/download-current-tab-20261101/core, SHA256
fd6327f87d21a6db6922e9dc8bd12e2c3717a82be6bdcecd1ef3eeaac8ebd5b2.
Сохранены0011 WebAudio,0012/0013 protocols,0014 ring и0015 download history.
scripts/build-native-security-core.py копирует только controller.cc, компилирует
его с прежними GN flags, создаёт новый UI archive и подменяет только этот archive
в прежнем explicit libcef link response. Исходный checkout, принятые объекты и
рабочие DLL не заменялись; итоговые SHA базы/объектов повторно совпали.
ThinLTO cache/TEMP оставались на E:.

Выход: .local/native-security-20261103/core-v4. Compile exit0/23.52с,
archive exit0/4.62с, link exit0/4003.39с (66мин43с). Новый libcef.dll307123200байт,
+3072байта к базовой DLL; SHA256
ffe32909759d31f096916b6ff3ecc5bc8751a699c31c6a3526089475a4709d27.
Rust adapter865792байта (baseline849920, прежний focusfix879616).
Это различия конкретных DLL, не изолированная оценка расходов одного компонента.
Startup/CPU/RAM и сжатый setup не измерялись. Сама панель — native Views;
расходы отдельного штатного просмотра сертификата пока не измерены. Новых
постоянных служб, фоновых таймеров или зависимостей не добавлено.

Core-v3 compile отказал из-за типов BrowserWindowInterface/raw_ptr; исправлены
только эти два места. Два ранних prepare-каталога остановились на Windows line
endings; нормализация выполнена в новом output, исходное дерево не затронуто.
Эти неудачные попытки сохранены. Новая major-ветка Chromium, полный clean rebuild,
побитовая воспроизводимость DLL и новый binary absence audit не заявляются.

Воспроизведение патча после0005:
`python scripts/apply-cef-patches.py --chromium-src <src> --native-security-ui`.
Проверены применение, повтор и отказ изменённому входу на fixture. Полный обычный
build workflow/публичная поставка ещё не переключались на0016 автоматически.

## Проверки

- Rust Release, Clippy -D warnings,16 Rust tests, rustfmt/diff check.
- Native SSL:8 EN +8 RU случаев — HTTP, HTTPS, file, HTTP→HTTPS redirect,
  недоверенный TLS, восстановление HTTPS, HTTPS fragment и HTTPS→HTTP.
  Проверяются настоящие native labels/тип/видимость, наличие строки сертификата,
  закрытие, продолжение работы страницы,1page и exit0/shutdown_complete.
  При недоверенном сертификате сервер получил0 HTTP-запросов.
- Фактические sandbox-токены: renderer restricted, NetworkService Low/AppContainer.
- MP4/WebM EOF по82кадра, WebAudio AAC123244PCM frames, D3D11VideoDecoder и
  MediaFoundationAudioDecoder; checker passed=true, штатное завершение.
  Видео muted: физический вывод звука этим прогоном не подтверждается.
- Downloads complete/cancel/interrupted, ring/glyph, native button/Ctrl+J/back,
 1page и clean shutdown. Обычные/target blank/popup ссылки также прошли.
- Внешние протоколы19/19, каждый exit0/shutdown_complete; временная ассоциация
  тестового handler удалена. Реальные Steam/Telegram повторно не запускались.
- Fullscreen2цикла: API и CDP Escape, скрытие/восстановление toolbar, exit0.

Все GUI-прогоны выполнялись последовательно на новых синтетических профилях.
Первый EN-прогон остановился на fragment: диагностическая title-команда повторно
вызвала toggle. Добавлена проверка title_changed; полная серия повторена успешно.
Первый RU-прогон остановился на альтернативной ожидаемой формулировке: Chromium
использует «Подключение защищено», «Действительный сертификат». Исправлено только
ожидание стенда, повтор прошёл. При агрегации отчётов также потребовалось явное
UTF-8 чтение; данные приложения и UI при этом не менялись.

scripts/test-native-security-panel.cjs — текущая приёмка, прежнее имя
scripts/test-connection-security.cjs перенаправляет в неё. Только smoke +
--test-native-security-panel включает inspect-команду0x434d5303 и title hooks;
обычный запуск не пишет дерево native labels. CEF удаляет application flags,
поэтому эти два диагностических opt-in флага явно сохраняются только в smoke.

## Кандидат и ограничения

Русский запуск: .local/native-security-20261103/Launch.cmd.
Английский: .local/native-security-20261103/Launch-EN.cmd.
Оба используют отдельный TestProfile в TEMP, открывают example.com и не заменяют
основной профиль/ассоциации. Runtime manifest закрепляет26файлов; от принятого
RC изменились только libcef.dll и chrominimum.dll, PAK/локали/branding сохранены.

Нужна ручная проверка внешнего вида, DPI/live theme, физического крестика/Escape
и открытия/закрытия самого viewer сертификата. Native-тексты/видимость и команды
не заменяют такую приёмку. Отдельные PageInfo back/help/cookies/permissions
переходы также не проверены. Новый installer/seed/installed regression не сделаны;
изменённый адаптер нельзя доставить обычным core update старого seed.
Ядро остаётся на pinned Chromium154.0.8037.98. Пароли вынесены в отдельную задачу.

[Сводка и границы](reports/native-security-20261103/summary.json),
[сборка](reports/native-security-20261103/build.json),
[EN](reports/native-security-20261103/ssl-matrix-repeat/result.json),
[RU](reports/native-security-20261103/ssl-matrix-ru-repeat/result.json).

## Ручной отзыв владельца, 2026-11-03

Владелец подтвердил «Работает» и предоставил снимки SSL-панели, открытого
просмотрщика сертификата и основного PageInfo после Back. Это подтверждение
открытия viewer, а не полная проверка его полей/экспорта/закрытия/DPI.
Сообщено о субъективной задержке загрузки; время не измерялось, причина не доказана.
На снимке viewer имеет светлое содержимое внутри тёмной рамки.

Проверен pinned исходник: SSL bubble использует native Views, viewer создаётся
через ShowConstrainedWebDialog и загружает certificate_viewer.html/JS/CSS.
CSS содержит фиксированные светлые цвета (#fff/#c8c8c8), отдельная проверка
dark theme у viewer не выполнялась. Холодная и повторная загрузка WebUI —
гипотеза для измерения, не установленная причина задержки.

Back создаётся штатным PageInfoViewFactory.CreateSubpageHeader и вызывает
OpenMainPage. Там доступны cookies/site data и site settings; их функциональная
приёмка остаётся отдельной. Предложение для Windows MVP: оставить SSL/status и
сертификат, скрыть Back до приёмки полной карточки сайта. Backend cookies и
разрешений этим не отключается. В текущем коде по этому отзыву ничего не скрыто.
Скрытие native Back требует C++ правки/перелинковки; оформление WebUI следует
исследовать отдельно на уровне ресурсов до новой тяжёлой сборки.

## Проверка viewer и переходов, 2026-11-03

После уточнения владельца computer-use не использовался: инструмент не работает
в его окружении. Проверка выполнена через Windows Accessibility InvokePattern
только для PID кандидата (сверяются путь и время запуска), а WebUI — через
loopback CDP. Каждый запуск использовал новый пустой TEMP-профиль.

- Первое открытие viewer в двух процессах: navigation duration 2055,6 и2076,1мс;
  first contentful paint 2080 и2104мс от начала WebUI navigation.
- Повторное открытие во втором процессе:2109,4мс, FCP2124мс. Прогрев в этой
  малой серии заметного ускорения не дал. Это не время от физического клика
  и не доказательство зависания UI; Accessibility/CDP и нагрузка не изолированы.
- Общие поля сертификата заполнены. DOM-click штатной вкладки «Подробнее»
  переключил selected-index на1; Accessibility подтвердил цепочку из4сертификатов
  и поля. SelectionItem.Select сам вкладку не переключил — успехом не засчитан.
- Кнопка закрытия viewer проверена трижды; диалог исчезал, основное окно оставалось
  живым, повторное открытие работало. Второй процесс завершён exit0 через Page.close.
- Native Back открыл основную PageInfo; cookies открыл подстраницу, её Back вернул
  основную карточку. «Настройки сайтов» открыл отдельный target
  chrome://settings/content/siteDetails?site=https%3A%2F%2Fexample.com;
  документ загрузился и закрыт отдельно. Разрешения и настройки не менялись.
- Cookies-панель показывает «Данные сайтов на устройстве — Запрещено всем сайтам».
  Это наблюдение текста, а не проверка фактического cookie backend; нужна отдельная
  воспроизводимая проверка записи/чтения/сохранения cookies и соответствия UI.

Артефакты: .local/native-security-tests-20261103/session-1 и session-2;
стенды scripts/probe-ssl-viewer.cjs, probe-test-window-uia.ps1,
inspect-certificate-webui.cjs. Первые слишком ранние CDP snapshots попадали
до готовности DOM; успешные замеры сняты после загрузки. В snapshot-helper
добавлено ограниченное ожидание DOM (после изменения синтаксис проверен;
само ожидание новым GUI-прогоном не проверялось).

Оформление/меню приложения и ядро в этом проходе не менялись. Причина задержки,
физический ввод, DPI/live theme, экспорт и installer остаются непроверенными.

## Cookies: проверка backend и пояснение надписи

2026-11-03: scripts/test-cookie-persistence.cjs выполнен на том же кандидате,
с локальным HTTP fixture и новым TEMP-профилем. Два последовательных процесса
использовали один тестовый профиль; оба завершились exit0/shutdown_complete.
JavaScript cookie и серверная HttpOnly cookie отправляются серверу; HttpOnly
не видна через document.cookie. Постоянные cookies сохранились после перезапуска;
сессионная cookie исчезла. Path=/scoped ограничивает отправку нужным путём,
cookie с Max-Age=0 отсутствует. Проверки прошли.

Надпись объясняется исходником pinned Chromium: SetCookieInfo в
chrome/browser/ui/views/page_info/page_info_cookies_content_view.cc передаёт
cookie_info.allowed_sites_count в IDS_PAGE_INFO_COOKIES_ALLOWED_SITES_COUNT.
components/strings/components_strings_ru.xtb, translation7375532151824574023,
содержит ветку =0 «Запрещено всем сайтам». Это подпись нулевого счётчика
использующих данные сайтов, а не чтение глобальной политики блокировки.
На example.com в пустом профиле нулевой счётчик не доказывает поломку cookies.

Артефакты: .local/native-security-tests-20261103/cookies/summary.json и smoke-0/1.log.
Проверены first-party HTTP cookies; HTTPS Secure, cross-site SameSite,
third-party policy, авторизация реального сайта и соответствие счётчика PageInfo
после записи cookies этим тестом не проверены. Приложение, политики и локализация
не менялись; добавлен только воспроизводимый диагностический стенд.

### SameSite: cross-site GET/POST

Стенд дополнен localhost → 127.0.0.1 переходами: оба сервера loopback, но разные
sites. Сервер подтвердил Sec-Fetch-Site=cross-site. Реальный DOM link.click
инициировал GET, form.requestSubmit — POST. Explicit SameSite=Lax cookies
отправились при GET и отсутствовали при POST; SameSite=Strict отсутствовала
в обоих переходах, но присутствовала в same-origin запросах до и после
перезапуска. Повторены предыдущие проверки HttpOnly/Path/истечения/persistence,
оба процесса exit0/shutdown_complete.

Первая попытка остановилась из-за гонки стенда: readyState=complete у about:blank
принимался за загрузку fixture. Ожидание исправлено на readyState вместе с точным
URL; полная повторная серия прошла. Артефакты:
.local/native-security-tests-20261103/cookies-samesite-repeat/summary.json.
Приложение и настройки не менялись.

HTTPS Secure и SameSite=None/third-party iframe остаются за границами этой серии:
для локального HTTPS нужен доверенный fixture. Системные доверенные корни,
сертификатные исключения и отключение TLS-проверки не применялись.

## Диагностика двухсекундной задержки viewer

В сохранённых session-2 логах оба открытия совпадают с CEF ошибкой
`Timeout of new browser info response for frame ... (has_rfh=1)`.
Первое: invoke 04:01:02.283, timeout04:01:04.304, domInteractive04:01:04.339;
повторное: invoke04:01:42.859, timeout04:01:44.887, domInteractive04:01:44.926.
Это время логов тестовой машины UTC+5; интервалы от invoke до timeout2021/2028мс.
HTML responseEnd11,5/11,7мс, domInteractive2044/2056мс от navigation start.
В обоих snapshots Resource Timing пуст: детализацию загрузки модулей из него
вывести нельзя. Два совпадения — сильное указание на конкретный CEF timeout,
но причинность исправления ещё должна быть подтверждена A/B runtime тестом.

Pinned исходники: render_manager.cc синхронно вызывает GetNewBrowserInfo;
browser_info_manager.cc ставит таймер2000мс, когда не найден CefBrowserInfo.
IsExcludedFrameHost уже умеет немедленно исключать внутренние UI с
GetDisplayDisposition()==kUIElement, если у них нет CefBrowserHost.
CertificateViewerUI наследует ConstrainedWebDialogUI; оба не переопределяют
GetDisplayDisposition, поэтому действует kRegularPage по умолчанию.
Обработка WebUI initialize показывает общую вкладку на DOMContentLoaded;
таймер200мс относится к отложенному дереву второй вкладки, а не к этой паузе.

Подготовлен отдельный patch0017: только CertificateViewerUI возвращает
kUIElement. Manifest закрепляет SHA256 исходного/изменённого заголовка;
git apply --check на pinned дереве прошёл. Патч НЕ применён к рабочему ядру,
НЕ скомпилирован и НЕ проверен поведением. Общий таймаут, TLS и sandbox не меняются.
Ожидаемая цель — пройти существующий путь excluded UI без ожидания таймера;
ускорение и размер не измерены. Новых зависимостей, процессов, фоновой работы
и сети исправление не предполагает. Дальше — изолированная сборка и A/B viewer,
поля/Подробнее/закрытие, затем TLS/sandbox regression. Предыдущая перелинковка
ядра занимала66мин43с; точная цена следующей сборки неизвестна.

### Сборка кандидата0017 — в процессе

Изолированный core-viewer-v3: compile exit0 за82,53с; линковка запущена,
поведение нового ядра пока не проверено. При подготовке скрипта исправлены
CRLF после git apply и Ninja escape-последовательности; первые две попытки
остановились до линковки. Основные исходники/объект/DLL не менялись.

Стенд test-certificate-viewer.cjs проверен на старом ядре: три открытия
2078,1/2052,7/2061,9мс, три ожидаемых CEF timeout, Details/close и exit0.
Измерения сделаны параллельно линковке и не считаются чистым performance A/B.
В стенде устранены гонки ожидания URL, native кнопки, load и завершения
контроллера перед чтением скопированных логов. Приложение не менялось.
Артефакты: .local/native-security-tests-20261103/viewer-harness-baseline-repeat5.

Одноразовый finish-certificate-viewer-candidate.py ждёт завершения сборки,
копирует runtime отдельно, меняет только libcef.dll и запускает viewer×3
и RU SSL матрицу. Результаты — viewer-candidate-v1/result.json. Статус waiting-build
или testing не означает успешную проверку. Новый runtime не предназначен
для замены установленного браузера до разбора результатов.

### Кандидат0017 — результат проверки

Линковка завершилась exit0 за4052,32с (67мин32с); compile82,53с.
SHA256 DLL c30ea9f93a60a4506b5c9455bd5b85ab360cd4675708a7c3dc36f97730647d26,
307123200байт — размер не изменился. Исходный header/object/base DLL сохранены.

Первый автопрогон и повтор остановились до viewer: copytree не переносит
AppContainer RX ACL, поэтому NetworkService не мог читать exe. Sandbox не был
отключён. Каталогу runtime кандидата выдано штатное S-1-15-2-1:(OI)(CI)(RX),
как в существующем package-external-protocols.py; операция добавлена в finalizer.
После этого полная серия повторена на новом пустом профиле.

Viewer:91,1/76,2/69,4мс до load; FCP100/88/76мс. Прежняя серия на старом ядре:
2078,1/2052,7/2061,9мс и три CEF timeout. В новой серии timeout отсутствует.
Поля и переключение Details, три close/reopen и exit0 прошли. Это малая локальная
серия, не общий benchmark; прежняя серия выполнялась параллельно линковке.
RU SSL8cases прошли, плохой TLS дал0HTTP requests, shutdown_complete.
Токены: все3renderer restricted, NetworkService Low4096/AppContainer1, Error0.

Отдельный ручной запуск:
.local/native-security-20261103/viewer-candidate-v1/Launch.cmd.
Каждый запуск создаёт отдельный TEMP-профиль; основная установка не менялась.
Рекурсивный manifest проверен: набор runtime-файлов сохранён, изменён только
libcef.dll. Адаптер и ресурсы прежние. Меню/оформление не менялись.
Отчёт: [summary](reports/certificate-viewer-20261103/summary.json).
Артефакты: .local/native-security-tests-20261103/viewer-fixed-acl и
ssl-viewer-fixed-ru. Остаются ручные physical/DPI/live theme и installer/installed
regression; полная media/download/protocol матрица на0017 отдельно не повторялась.
