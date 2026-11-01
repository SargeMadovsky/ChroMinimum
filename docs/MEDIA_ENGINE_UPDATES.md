# Установщик alpha.8 и обновления media-ядра

Дата: 2026-10-23. Локальная подготовка, публикации нет.

После проверки первичных условий и ответа владельца публичная подпись/доставка
остаётся незавершённой: отдельных соглашений H.264/AAC нет, применимость
патентных условий и LGPL/relinking не установлена.
[Подготовленные исходники и обзор](MEDIA_DISTRIBUTION_REVIEW.md).

Stock CEF не содержит H.264/AAC. Поэтому одной подписи пакета и строки версии
недостаточно для сохранения возможностей media-установки.

## Контракт

В `installer/seed-baseline.json` закреплены точные bootstrap/libcef/chrome_elf
official Release media runtime. Старый baseline сохранён в
`seed-baseline-stock-alpha7.json`. Security sequence остаётся 1: upstream commit
тот же, номер исправления безопасности не выдумывается. Highest/min_safe не
понижаются при миграции.

В installer policy добавлено `media_codecs=true`, в state — монотонное
`media_codecs_required=true`. Отсутствие полей означает false; false-поля не
сериализуются. Прежние stock metadata/state/policy продолжают читаться. Старый
alpha.7 launcher с deny_unknown_fields откажется читать media-state.

Media seed выбирает только
`https://github.com/SargeMadovsky/ChroMinimum/releases/download/core-media-windows-x64/core-update.json`.
Stock-канал и его автоматизация не меняются. Media-канал пока не опубликован:
проверка обновлений вернёт ошибку доступности, без перехода на stock. Обычный
запуск браузера не требует сети.

Подписанный Manifest обязан содержать `media_codecs=true`. Проверка выполняется
до скачивания архива, внутри install и при выборе pending/active/fallback.
Сохраняются подпись, SHA архива, security floor, leases и точная привязка DLL
адаптера к seed. Корректная подпись stock-пакета не отменяет требование кодеков.
Capability — утверждение издателя, подписанное вместе с SHA архива: каждый
реальный пакет дополнительно обязан пройти media/security приёмку.

Полный setup проверяет сохранение требования в preflight и migrate. Требование
хранится и в state: повтор прерванной установки не зависит от наличия старой
policy после копирования нового seed. Состояние/floor ради установки не удаляются.

## Доставка и расходы

`scripts/package-core.py --media-codecs --release-tag core-media-windows-x64`
создаёт архив и **неподписанные** метаданные. Sequence должен превышать прежний
highest всех поддерживаемых установок; смена канала не обнуляет защиту от отката.
Рабочий ключ не читается. Подпись/публикация требуют отдельной приёмки и проверки
условий распространения кодеков. Облачная сборка media CEF пока не внедряется.

Новых зависимостей, служб, постоянных процессов или таймеров нет. Добавлены
поля метаданных и проверка небольшой policy в прежнем updater. Сеть идёт к media
вместо stock. Для обновления по-прежнему нужны архив и отдельная копия runtime;
независимого маленького codec plugin нет. Расходы ядра измерены в
[release-эксперименте](CEF_MEDIA_RELEASE_EXPERIMENT.md).

## Проверки

Rust-тесты: подписанный stock без поля отклоняется без записи состояния/пакета;
несовместимые pending/active receipts отклоняются; подмена capability нарушает
подпись; изменение policy блокирует выбор; downgrade запрещён, повтор совместимого
прерванного setup разрешён. Подписанный media-пакет проходит install → trial →
health → active на одноразовом тестовом ключе. Это синтетический пакет, не
сетевое обновление реального CEF.

Реальный TestInstall имеет отдельные AppId/registry/launcher. План приёмки:
EN/RU, обновление отдельной alpha.7, media через installed launcher,
HTML/PDF/relaunch, sandbox, отказ при floor=2, сохранение данных и удаление.
Основная установка, реальные профили и Windows UserChoice не изменяются.

Приёмка выполнена: EN/RU, переход отдельной alpha.7, installed media и финальные
хеши/HTML/PDF/sandbox/удаление прошли. Реальный архив sequence=3 также проверен
через install/trial/health с одноразовой подписью и сверкой engine/adapter/credits
SHA, без сети и запуска браузера. [Итог и измеренные расходы](RELEASE_ALPHA8.md).

[Alpha.8](RELEASE_ALPHA8.md), [миграция](INSTALLER_SEED_MIGRATION.md).
