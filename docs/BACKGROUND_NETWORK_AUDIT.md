# Белый фон и первый аудит фоновой сети, 2026-10-20

## Фон HTML

Исправление находится в PageDelegate::on_theme_changed: слой BrowserView под
прозрачным документом остаётся белым независимо от тёмной темы Windows.
Settings/BrowserSettings также явно задают opaque white. Панель, рамка окна,
prefers-color-scheme и авторские CSS не меняются. Скрипты или стили в страницы
не внедряются. [CEF BrowserView SetBackgroundColor/SetDefaults](https://raw.githubusercontent.com/chromiumembedded/cef/14c5a08/libcef/browser/views/browser_view_impl.cc).

Штатных Settings оказалось недостаточно: после привязки темы Views слой снова
был тёмным. Прозрачный снимок поверхности сначала ошибочно интерпретировался
как чёрный: RGBA=(0,0,0,0). Внутренняя проба Emulation также не исправила
композицию и полностью удалена из итогового кода. Снимок композиции
Page.captureScreenshot с fromSurface=false показал реальный fallback (31,31,31)
до исправления и (255,255,255) после него. Явный CSS-фон body остался (12,34,56),
градиент html остался цветным, контрольная точка (0,119,50).

Захват через Windows Computer Use дважды завершился ошибками FrameArrived/window
capture timeout; успешного WGC-снимка не заявляется. Окончательная проверка
выполнена снимком view, а не прозрачной renderer surface. Ручная проверка
реального файла владельцем после установки пока не выполнена.

Для контролируемых снимков добавлен только явный диагностический режим
`--smoke-test --test-cdp`: ephemeral loopback DevTools endpoint в отдельном
profile-smoke. Без обоих параметров endpoint не включается. TestInstall
дополнительно проверяет отсутствие DevToolsActivePort в обычном smoke-запуске.
Выполнение внутреннего Emulation/DevTools-команд для установки цвета в обычном
режиме не оставлено: исправление использует CEF Views API.

## Методика сети

CEF 154.0.34 / Chromium 154.0.8037.98, отдельная runtime-копия на E:, новые
профили во временном каталоге C:. Три запуска примерно по 30 секунд:
about:blank; локальная HTTP-форма и страницы цвета; about:blank с копией
профиля первого теста. Реальные профили, аккаунты, пароли и содержимое
пользовательских документов не использовались. Поля формы не заполнялись,
форма не отправлялась. Авторский HTML не обращался к внешним хостам.

`scripts/audit-background-network.cjs` запускает browser с явным smoke NetLog,
затем разбирает URL_REQUEST_START_JOB/response/DNS events. Перенаправления
сохраняются отдельными событиями; summary не содержит query, cookie или headers.
Исходный журнал первого запуска повторно разобран окончательным анализатором.
CDP использовался только для локальных страниц цвета, не для blank-прогонов.

| Сценарий | Начатые внешние HTTP(S)-запросы | Внешних хостов |
|---|---:|---:|
| Новый профиль, about:blank | 9 | 7 |
| Локальная форма + страницы цвета | 14 | 8 |
| Подготовленный тестовый профиль, about:blank | 4 | 3 |

Во втором случае дополнительно 9 loopback-запросов, всего 23. Это числа
логических запросов, а не TCP-соединений/уникальных служб/объёмов трафика.
Окно наблюдения короткое: поздние таймеры, реальные сайты, DNS/прокси вне NetLog,
другие машины и работа с сохранёнными данными отдельно не исследованы.
Собственная автоматическая проверка ядра ChroMinimum в smoke отключена;
GitHub-updater из этих наблюдений исключён. Отсутствие фоновой сети не заявляется.

## Что наблюдалось

| Запрос | Доказанный результат / назначение |
|---|---|
| clients2.google.com/time/1/current | HTTP GET, 200; сетевое время |
| accounts.google.com/ListAccounts | POST, 200, даже на пустой странице без входа; точный вызывающий сервис ещё не установлен |
| www.google.com/async/folae | GET, 200; AI Mode eligibility |
| update.googleapis.com/service/update2/json | POST, 200; компонентный updater Chromium |
| edgedl.me.gvt1.com/.../ceofaddefefcbblgcgnibnonglccbfja/... | HTTP GET, 200; Optimization Guide Models Manifest |
| clients2.google.com/service/update2/crx | GET, 200; проверка внешнего расширения |
| clients2.googleusercontent.com/.../EFAIDNBMNNNIBPCAJPCGLCLEFINDMKAJ_26_10_1_0.crx | GET, 200; загрузка Adobe Acrobat CRX |
| chromewebstore.googleapis.com/.../efaidnbmnnnibpcajpcglclefindmkaj:fetchItemSnippet | POST, 200; сведения о том же расширении |
| content-autofill.googleapis.com/v1/pages/... | 4 GET с ответом 400 при посещениях пустой формы; серверные запросы происходят, успешное автозаполнение этим не доказано |

NetLog содержит 14332 filtered body bytes для manifest-компонента и 6259109
для CRX Adobe в первом blank-запуске. Это прочитанные байты тела, не полный
размер сетевого обмена. Скачивание многогигабайтной AI-модели не наблюдалось.
Запросы ListAccounts/AI/component update сохранились и на повторном blank-запуске.
DNS-события также содержат wpad:80; соответствующий HTTP-запрос не найден,
проверять системное автоопределение прокси следует отдельно.

Причины сверены с исходниками именно Chromium 154:

- [NetworkTimeTracker](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/network_time/network_time_tracker.cc).
- [AimEligibilityService](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/omnibox/browser/aim_eligibility_service.cc): annotation описывает startup/periodic запросы; простая политика запрета использования AI-результата не означает запрета запроса.
- [Optimization Guide installer](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/component_updater/optimization_guide_on_device_model_installer.cc) связывает ceof... с manifest-компонентом.
- [Autofill crowdsourcing](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/autofill/core/browser/crowdsourcing/autofill_crowdsourcing_manager.cc).

Для Adobe обнаружена существующая запись
HKLM/Software/WOW6432Node/Google/Chrome/Extensions/efaidnbmnnnibpcajpcglclefindmkaj
с update_url на clients2.google.com. Реестр только прочитан. Этот ID соответствует
[Adobe Acrobat](https://helpx.adobe.com/acrobat/web/use-acrobat-extensions/turn-off-the-acrobat-welcome-pdf.html).
[ExternalRegistryLoader Chromium 154](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/extensions/external_registry_loader_win.cc)
читает именно Chrome Extensions из 32-bit HKLM/HKCU. Источник согласуется с
наблюдаемым ID/URL, но сам момент чтения не трассировался. CRX скачан;
установка, включение и исполнение расширения не доказаны. Это также не доказывает
работоспособность пользовательских расширений или uBlock Origin в ChroMinimum.

## Следующий этап

В этой задаче сервисы не отключались; менеджер паролей и существующие данные
не менялись. Первый приоритет — запрет автоматического подхватывания внешних
расширений из чужой регистрации Chrome без изменения настроек самого Chrome.
Затем отдельно отключить AI/Optimization Guide и серверные запросы Autofill,
разобраться с ListAccounts; каждую меру проверять тем же NetLog на новых и
подготовленных профилях. Выбор пользователем будущего собственного расширения
должен сохраняться по EXTENSIONS_POLICY.

Не применять слепой общий запрет component updates/служебной сети: безопасность
сертификатов, Safe Browsing и обновления собственных ядер требуют отдельной
классификации и проверки. Sandbox, проверка TLS и изоляция сайтов не отключались.
Наблюдаемые ненужные фоновые соединения пока являются открытым нарушением целей
P06/политики отсутствия скрытой сети; основной публичный канал не публиковался.

## Проверки и локальная сборка

Release, clippy all-targets с -D warnings, rustfmt; проверка белого/тёмного/
градиентного фона; HTTP/JS/навигация/изменение размеров прошли. Новых зависимостей
нет. Подложка обновляется событием темы, не опросом. Размер DLL текущего checkout
738304 → 750080 байт; это не чистая парная сборка: параллельно присутствует
доработка сохранения размера окна, она здесь не изменялась. RAM/CPU/стоимость
фоновых служб не измерены; повторные диагностические запуски сами создавали
описанный трафик, их нельзя считать production-запусками без накладных расходов.

Evidence: `.local/background-network-validation-2026-10-20/`. Raw NetLog относится
только к тестовым профилям и хранится локально; в установщик он не включается.
Основной alpha.6 setup меняет фон, но **не устраняет найденную фоновую сеть**.
Его установка владельцем и ручная проверка подложки ещё не выполнялись.

TestInstall EN/RU подтвердил миграцию с сохранением floor, отказ более высокому
floor до копирования, HTML/PDF/relaunch, AppContainer/Low NetworkService,
удаление с сохранением тестовых данных и неизменность UserChoice/основной
регистрации. Обычные тестовые запуски не создали DevToolsActivePort. Прежние
31 Rust-тест обновлятора повторно не запускались: его код здесь не менялся.

Основной `dist/ChroMinimum-0.0.1-alpha.6-local-setup-x64.exe`: 157940546 байт,
SHA-256 `82714bf66dda6be8ab8917e8763ba47390bbb74bfde37c42084a1830fd14bf8c`.
TestInstall: 157940608 байт,
SHA-256 `66837f3f31973b0bd10360c67ba05d6a0252ffbb62d64337f4b0ff4fe4058bfc`.
Payload `.local/background-payload-2026-10-20/` содержит 34 проверенных файла;
runtime-профили, NetLog и скачанные компоненты тестов в него не копировались.
