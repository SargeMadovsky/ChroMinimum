# Отключение серверного Autofill

2026-10-20. Локальная Release-сборка; установленный alpha.6 не заменён.

В `disable-features` добавлен `AutofillServerCommunication`, сохраняя прежние
настройки AI eligibility и обязательного network sandbox. Блокировки доменов,
подмены серверов и отключения проверок сертификатов нет.

В точной версии Chromium AutofillCrowdsourcingManager проверяет IsEnabled
до StartQueryRequest и StartUploadRequest. Отключение касается получения
серверных предсказаний типов полей и отправки crowdsourcing votes, включая
votes от password manager через этот менеджер. Это не общий запрет сети
всего Autofill/Wallet/AI и не удаление локального хранилища паролей.
Без серверных предсказаний распознавание сложных форм может стать хуже;
совместимость всех сайтов не проверена.

Первичные источники:

- [Определение feature](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/autofill/core/common/autofill_debug_features.cc).
- [Проверки query/upload](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/autofill/core/browser/crowdsourcing/autofill_crowdsourcing_manager.cc).

Аудитор дополнен опциональным `CM_AUDIT_FORM_INPUT=1`: через диагностический
CDP вводятся только вымышленные значения в локальную форму. Проверяются
содержимое полей и событие submit; обработчик предотвращает сетевую отправку.
В отчёт записываются только четыре булевых результата, без значений полей.
Реальные аккаунты, пароли и профиль владельца не использовались.

Release, rustfmt, clippy all-targets с -D warnings, Node syntax check прошли.
NetLog fresh blank, локальной формы и prepared blank не содержит запросов
Autofill, AI eligibility и внешних Chrome-расширений. В сценарии формы также
отсутствует DNS-запись Autofill; четыре проверки ввода/submit истинны.
Каждый сценарий наблюдался около 30 секунд, длительная работа не проверена.
Сетевая отправка формы не выполнялась, поэтому отсутствие upload подтверждено
условием в исходнике, а не отдельным runtime-сценарием отправки.
HTTPS и локальный PDF загрузились, недоверенный TLS отклонён без HTTP GET.
NetworkService подтвердил AppContainer/Low, renderer — restricted/Untrusted.
Сохранение и автоподстановка паролей после изменения отдельно не проверялись.
DLL осталась 752128 байт; это не уменьшение кода внутри libcef.dll. Новых
зависимостей, служб и фоновых процессов нет. RAM/CPU/запуск не измерены.

Runtime: `.local/no-autofill-server-bundle-2026-10-20/`.
Evidence: `.local/no-autofill-server-validation-2026-10-20/`.
Полный установщик пока не собирался. Accounts/ListAccounts и AI manifest
остаются открытыми пунктами; для manifest испытанный флаг выполнения AI
не помог, см. [AI_MODEL_MANIFEST.md](AI_MODEL_MANIFEST.md).
