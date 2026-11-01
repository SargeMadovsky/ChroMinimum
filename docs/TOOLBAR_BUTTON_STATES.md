# Состояния кнопок панели — 2026-11-01

Ограниченный UX-проход согласован владельцем: различить enabled/disabled,
hover/pressed и keyboard focus; остальные UX-вопросы отложены.

`src/toolbar_style.rs` использует текущие CEF theme colors: primary foreground,
disabled foreground и contrast-guaranteed accent. Четыре изображения каждой
кнопки строятся из альфа-маски прежней иконки; hover/pressed имеют разные
прозрачности округлённого фона, focus — контур. Системная ink-drop и Tab-focus
включены. Theme/focus/blur callbacks обновляют иконки по событию. Disabled
Назад/Вперёд сохраняют прежний native set_enabled; Reload/Stop меняет всю группу
состояний. IDs и размеры кнопки загрузок не меняются, кольцо0014 сохраняется.

Новых зависимостей браузера, процессов, таймеров, сети и IPC нет. Маски3456байт
получены из существующих PNG; `scripts/generate-toolbar-masks.py` воспроизводит
их с Pillow (только developer command). Маски включены в source package allowlist.
По несколько bitmap на кнопку в UI создаются при конфигурации/смене темы/фокуса,
без работы на mousemove: состояние выбирает CEF. Отдельные CPU/RAM/startup замеры
не выполнялись; потенциальные временные allocations при focus/theme учитываются.

Release и Clippy -D warnings прошли. DLL836096байт против831488 ранее (+4608),
CEFfe11104e… не пересобирался. Навигационный smoke подтвердил все4 state images
пяти кнопок, Enter/back/forward/reload, resize/maximize/minimize и shutdown.
Hover/pressed/focus визуально и live theme switch ещё не приняты владельцем.

Кандидат: `dist/ChroMinimum-toolbar-states-test-20261101`.
SHA adapter: aa214fc3de2d02d7650b308fbf1f280ce20c45348fa2031184b3e859f5a8997f.
Стенды: `.local/toolbar-states-20261101`. Рабочая установка не меняется.

Финальный вариант учитывает ARGB alpha самих theme colors: disabled foreground
может отличаться только прозрачностью. Final navigation smoke и повтор complete
ring/download/dropdown/Ctrl+J/resize прошли. Первый final download-прогон дал
две page targets chrome://downloads/; логи сохранены, точная причина неизвестна,
повтор прошёл. Этот сбой не объявляется устранённым.

Оба финальных setup собраны из final-payload с новым trusted adapter seed.
Повторная установка EN/RU не выполнялась, основная установка не менялась.
Прямой Launch.cmd использует отдельный TestProfile, без smoke/CDP/codec env.
[Отчёт и SHA256](reports/toolbar-states-20261101/summary.json).

## Исправления по снимкам владельца

Собственный прямоугольный focus outline и фон внутри24px bitmap удалены:
остаётся только glyph tint и штатные CEF ink-drop/focus. Перед навигационным
нажатием фокус возвращается странице (до открытия bubble, не после него).
Tab-focus остаётся доступным. Других UX-перестроений нет.

Владелец предпочёл скрывать glyph во время кольца. Обычная иконка с полкой
сохранена; DownloadAppearance использует публичный OnDownloadUpdated UI-thread
callback, хранит только ID активных загрузок и меняет glyph на прозрачный при
переходе0→1, восстанавливает при1→0. Theme/focus callbacks сохраняют этот выбор.
CanDownload явно совпадает с CEF default=true; OnBeforeDownload=false оставляет
штатную Chrome обработку/диалог. Callback отмены/паузы/пути не выполняется.
Не добавлены опрос, таймер, процесс, сеть или новая зависимость.

Release/Clippy прошли. Новый shell cb0558b0…849920байт; CEF покаfe11104e…
не менялся. Native ring/progress и hidden/restored callback события подтверждены;
общий тест остановлен на второй chrome://downloads/ странице. Отдельный empty
history тест воспроизводит вторую страницу детерминированно. Это больше не
трактуется лишь как нестабильность счётчика: владелец увидел обычное окно Chromium
во время нашего fixture-прогона. Новый кандидат не опубликован.
