# Автоматические внешние расширения

2026-10-20. Локальная проверенная сборка; установленный alpha.6 не заменён.

В browser command line принудительно добавлен `disable-default-apps`.
В Chromium 154.0.8037.98 `ExternalProviderImpl::CreateExternalProviders`
возвращается до создания Windows ExternalRegistryLoader, провайдеров
предустановленных расширений и ExternalComponentLoader. Это шире одного
запрета реестра: автоматические расширения из этих провайдеров не добавляются.
Принудительные/рекомендованные enterprise providers создаются раньше и этим
флагом не блокируются. Глобальный `disable-extensions` не применяется.

[Исходник точной версии](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/extensions/external_provider_impl.cc).
Отдельный component updater Chromium не выключен; его HTTP-запросы и загрузка
Optimization Guide manifest остаются. Записи реестра Chrome не изменялись.

На трёх отдельных тестовых профилях по 30 секунд отсутствовали запросы
`service/update2/crx`, загрузки Adobe CRX и Chrome Web Store. Во внешней
регистрации машины Adobe оставался. В fresh blank осталось 6 внешних запросов
вместо 9 исходного аудита; local-form — 11, prepared blank — 3. Числа зависят
от расписания серверов и не являются оценкой ускорения. Accounts, AI,
серверный Autofill пока остаются отдельными открытыми задачами.

Release, rustfmt, clippy all-targets с -D warnings прошли. HTTPS загружен,
неверный TLS-сертификат отклонён без HTTP GET, локальный PDF загружен.
NetworkService: AppContainer/Low; renderer: restricted/Untrusted.
DLL 750080 байт, как в предыдущей сборке; RAM/CPU/запуск не измерены.
Новых зависимостей, служб и фоновых процессов не добавлено.

Runtime: `.local/no-external-bundle-2026-10-20/`.
Evidence: `.local/no-external-validation-2026-10-20/`.
Raw NetLog/профили: TEMP `chrominimum-no-external-audit-2026-10-20-b`.
Первый запуск аудитора до окончания упаковки получил ENOENT; результаты выше
относятся к повторному успешному запуску после завершения сборки.

Не проверены: миграция профиля с уже установленным внешним расширением,
enterprise policy, совместимость пользовательских MV2/MV3/uBlock Origin.
Удаление ранее установленных расширений не реализовано. Полный setup этой
итерации не собирался; установленный alpha.6 пока сохраняет прежнее поведение.
