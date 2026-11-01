# Accounts/ListAccounts: исследование и отклонённые меры

Обновление 2026-10-21: [инициаторы установлены стеком, выполнен причинный опыт,
подготовлен исходный патч](ACCOUNTS_ROOT_CAUSE.md). Исторические ограничения
ниже относятся к предыдущим итерациям; пользовательский CEF ещё не пересобран.

2026-10-20. **Запрос не устранён.** Установленный alpha.6 не менялся.

Проверены две ограниченные гипотезы на отдельных профилях без аккаунтов:

| Кандидат | Runtime-проверка | Результат |
|---|---|---|
| disable-sync | Локальная форма, 30 секунд | POST ListAccounts, HTTP 200 |
| AvoidAutoTriggerListAccountsOnStale | fresh blank, форма, prepared blank; отдельно копия прежнего тестового blank-профиля | ListAccounts остался |

Оба изменения удалены из рабочего кода. Флаг AvoidAutoTriggerListAccountsOnStale
есть в бинарной libcef.dll (проверено наличие строки), однако наличие строки
само по себе не доказывает выполнение конкретной ветки.
В NetLog clientInfo также зафиксировано имя feature в command line. Это
подтверждает передачу настройки, но не стек конкретного сетевого вызова.
Сборки кандидатов
выполнены; автоматические проверки NetLog не подтвердили требуемый результат.
Сборка CEF из исходников и трассировка стека инициатора не выполнялись.

## Что установлено по исходникам Chromium 154.0.8037.98

- [SyncSessionDurationsMetricsRecorder](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/sync/service/sync_session_durations_metrics_recorder.cc)
в конструкторе вызывает GetAccountsInCookieJar и допускает null SyncService.
Поэтому выключение Sync не обязано устранять этот источник чтения.
- [DesktopProfileSessionDurationsService](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/metrics/desktop_session_duration/desktop_profile_session_durations_service.cc)
создаёт этот recorder. Его [фабрика](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/metrics/desktop_session_duration/desktop_profile_session_durations_service_factory.cc)
не содержит проверенного отдельного feature-выключателя для обычного профиля.
- [IdentityManager](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/signin/public/identity_manager/identity_manager.cc)
при включённом AvoidAutoTriggerListAccountsOnStale читает кэш. По умолчанию
[feature выключена](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/signin/public/base/signin_switches.cc).
- [GaiaCookieManagerService](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/signin/internal/identity_manager/gaia_cookie_manager_service.cc)
также имеет явные TriggerListAccounts, в том числе при событиях cookie.
Чтение кэша не запрещает эти пути. Это возможное объяснение отрицательного
результата, а не установленный runtime-стек конкретного запроса.

Сетевое наблюдение доказывает запрос, исходники показывают возможные пути.
Нельзя объявлять recorder единственным/фактическим инициатором в CEF без
трассировки. Следующее исследование — установить вызывающий путь, затем
проверить точечный запрет фоновой интеграции аккаунтов/метрик в своём CEF.
Не исключены другие штатные способы; проверенный способ пока не найден.

## Дополнительные проверки

Аудитор дополнен `CM_AUDIT_COOKIE_CHECK=1`: локальная страница устанавливает
вымышленный cookie, проверяет document.cookie и его получение loopback-сервером
через fetch. Сохраняются только два булевых результата, заголовки не пишутся.
В испытанном кандидате cookies и искусственный ввод/submit-event прошли.
Та же проверка cookies/ввода прошла на предыдущей принятой сборке после
отклонения кандидатов; сетевое поведение ListAccounts осталось прежним.
Это не реальный вход в Google и не доказательство совместимости всех OAuth/
SameSite/third-party сценариев. Реальные профили и пароли не использовались.

На кандидате с кэшированием прошли HTTPS, отказ неверному TLS до HTTP GET,
локальный PDF; токены NetworkService AppContainer/Low и renderer restricted/
Untrusted. Release/fmt/clippy/Node syntax прошли. После отклонения флагов
рабочая политика вернулась к предыдущей принятой сборке с отключёнными
AI eligibility, внешними предустановками и серверным Autofill.

Общий запрет фоновой сети, блокировка accounts.google.com, запрет cookies и
смена реального профиля не применялись. Новых зависимостей, процессов и служб
нет, производительность не измерялась. Полный установщик не собирался.

Evidence: `.local/accounts-network-validation-2026-10-20/`.
Экспериментальные runtime: `.local/no-sync-experiment-bundle-2026-10-20/`,
`.local/cached-accounts-bundle-2026-10-20/`; в setup их не включать.

## Дополнительная диагностика CEF

Следующая итерация 2026-10-20: добавлен `--test-signin-log`, действующий только
вместе с `--smoke-test`. Он включает vmodule для компонентов signin в отдельном
тестовом профиле. Обычно подробный лог не включается. Диагностический лог Gaia
может содержать заголовки/тело запросов, поэтому применять только без аккаунтов
и настоящих паролей. В установщик raw logs не включать.

На чистом about:blank лог показал:

- предупреждение AccountConsistencyModeManager: Desktop Identity Consistency
  не включается без OAuth client ID/secret;
- создание/Initialize AccountReconcilor;
- примерно через 134 мс после Initialize — GaiaAuthFetcher для ListAccounts,
  source=ChromiumBrowser, затем штатное закрытие через smoke-таймер.

Временная близость не доказывает, что запрос инициировал AccountReconcilor.
Лог не содержит C++-стека. В [GaiaAuthFetcher](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/google_apis/gaia/gaia_auth_fetcher.cc)
VLOG показывает сетевой URL, но не вызывающий стек. Это подтверждение компонента
отправки, а не единственного исходного инициатора.

Прочитаны CEF 14c5a08 chrome_runtime.patch, metrics TPM patch и
[ChromeBrowserMainExtraPartsCef](https://raw.githubusercontent.com/chromiumembedded/cef/14c5a08/libcef/browser/chrome/chrome_browser_main_extra_parts_cef.cc).
В просмотренных частях нет выключателя, доказанно решающего эту задачу.
AccountInvestigator также читает аккаунты через IdentityManager по таймеру;
это ещё один кандидат, его участие в данном запросе не установлено.

В проверенных PATH/стандартных путях Windows SDK не найден CDB/WinDbg;
подходящие символы libcef в проверенных каталогах не обнаружены. Наличие
Rust PDB не заменяет символы движка. Поэтому точная трассировка требует
получения совместимых символов/отладчика либо инструментированной сборки CEF.
Загрузка этих инструментов, патч и собственная сборка движка не выполнялись.

Release/fmt/clippy прошли, диагностический smoke завершился штатно. Отдельный
обычный smoke-запуск проверяет отсутствие VERBOSE Gaia без нового флага.
Повторная полная приёмка HTTPS/PDF/sandbox в этой диагностической итерации
не выполнялась. Параллельные изменения интерфейса сохранены, отдельная
визуальная приёмка нового окна «О программе» здесь не проводилась.

Runtime: `.local/signin-log-bundle-2026-10-20/`.
Evidence: `.local/signin-log-validation-2026-10-20/`.
Новых зависимостей/служб нет; подробный лог добавляет диагностические записи
только при двух явных флагах, его накладные расходы не измерены.
