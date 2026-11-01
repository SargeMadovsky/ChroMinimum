# AI-манифест: отрицательный результат отключения флагом

2026-10-20. Загрузка манифеста **не устранена**. Установленный alpha.6 не менялся.

Проверена гипотеза: дополнительно к AimEnabled выключить
`OptimizationGuideModelExecution`. Release-сборка выполнена, на отдельном чистом
профиле открыты локальные HTML/форма через диагностический аудитор. Приложение
завершилось штатно. NetLog подтвердил HTTP 200 загрузки компонента
`ceofaddefefcbblgcgnibnonglccbfja` с edgedl.me.gvt1.com и обращения к component
updater. Это манифест моделей, не доказательство загрузки весов большой модели.

Неэффективный для этой задачи флаг удалён из рабочего кода. В рабочей политике
сохраняются прежние проверенные AimEnabled и disable-default-apps. Опытная сборка
`.local/no-model-execution-bundle-2026-10-20/` не предназначена для установщика.
Новые проверки PDF/TLS/sandbox для неё не выполнялись: кандидат отклонён.

## Причина по исходникам точной версии

1. [OptimizationGuideGlobalState](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/optimization_guide/model_execution/optimization_guide_global_state.cc)
создаёт ManifestBrokerState. Общее состояние используется также через model
provider; выключение выполнения AI не гарантирует отсутствия этого объекта.
2. [ManifestBrokerState](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/optimization_guide/core/model_execution/manifest_broker/manifest_broker_state.cc)
создаёт ManifestMonitor. Проверки IsOnDeviceExecutionEnabled в публичных методах
происходят после создания монитора.
3. [ManifestMonitor](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/optimization_guide/core/model_execution/manifest_broker/manifest_monitor.cc)
в конструкторе безусловно вызывает ListenForManifestReady. Наблюдение политик
в этом же классе не предотвращает саму регистрацию компонента.
4. [ManifestAssetManagerDelegateImpl](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/component_updater/optimization_guide_on_device_model_installer.cc)
при подписке вызывает MaybeRegisterManifestComponent, регистрирует installer
и запускает foreground UpdateOnDemand после регистрации.

Точечное исправление требует управления регистрацией/подпиской до этого шага
в собственной сборке CEF/Chromium. Оно должно отдельно проверить чистый профиль
и профиль с уже скачанным компонентом, сохранность остальных component updates,
PDF/TLS/sandbox. Патч движка, сборка из его исходников и эти испытания здесь
не выполнялись. Гарантия отсутствия других штатных способов отключения не
заявляется; среди исследованных путей подходящий проверенный путь не найден.

Общий запрет component updater, отключение prediction моделей, подмена update
URL и фиктивный manifest override не применялись. Собственный обновлятор
ChroMinimum не изменён. Новых зависимостей, процессов и служб нет; RAM/CPU/запуск
не измерены. Следующий независимый ограниченный пункт очереди — серверный
Autofill, затем Accounts; манифест остаётся открытым пунктом собственной сборки.

Evidence: `.local/no-model-execution-validation-2026-10-20/`.
Raw NetLog и только тестовый профиль: TEMP
`chrominimum-no-model-execution-audit-2026-10-20/local-form/`.
