# История загрузок в текущем окне — 2026-11-01

При fixture-прогоне владелец увидел стандартное окно Chromium. Сохранены две
page targets chrome://downloads/. На чистом профиле нажатие кнопки при пустой
истории воспроизводит второй page target без скачивания.

Прочитан DownloadToolbarUIController::InvokeUI: отсутствие GetMainView моделей
(в том числе ранний клик до их заполнения) вызывает chrome::ShowDownloads,
который идёт через ShowSingletonTabOverwritingNTP. Для CEF Views custom anchor
это выходит в стандартный browser UI. Полного стека исходного download сбоя
нет; отдельный empty-history reproducer связывает поведение с этим fallback.

0015 после0014 меняет только fallback custom anchor: HideDetails и LoadURL
chrome://downloads/ в текущем WebContents. Штатный непустой complete bubble и
обычные Chrome окна сохраняются. Публичные CEF API, безопасность и кодеки не
меняются. Патч guarded version/hash; подготовлен в отдельной копии.

Изолированная сборка/линковка запущена в
`.local/download-current-tab-20261101/core`; объект/controller и archive затем
link с LTOjobs2, TEMP/cache на E:. Ранее такой link занимал около50мин, это не
обещание времени нового прохода. Исходный checkout и принятые DLL не заменяются.
Сборка/runtime ещё не приняты. После: empty history, complete/cancel/interrupt,
glyph hide/restore, repeated open/close, media/fullscreen/sandbox regressions.

## Результат проверки

Link завершён exit0 за3319с, DLL307120128байт:
fd6327f87d21a6db6922e9dc8bd12e2c3717a82be6bdcecd1ef3eeaac8ebd5b2.
Checkout/базовые DLL/объекты не менялись. Новый shell cb0558b0…849920байт.

Чистая empty history, complete/cancel/interrupt прошли с одной page target,
native ring paint, glyph hidden→restored, dropdown/button/Ctrl+J/resize/back
и clean shutdown. Получен runtime marker current-tab fallback. В старом ядре
тот же empty reproducer давал2 page targets; в новом —1.

MP4/WebM EOF82кадра, AAC PCM123244/44100/stereo, MF/sandbox и shutdown прошли.
Первый media запуск остановился до playback на visibility hidden; повтор visible
прошёл, владелец подтвердил самостоятельный выход окон вперёд и видео со звуком.
Fullscreen2цикла (API/Escape), toolbar hide/restore и viewport возврат прошли.
Оба setup собраны; установленный EN/RU маршрут новой DLL ещё не повторён.
Визуальная приёмка новых glyph/рамок и logo branding остаются отдельно.

Кандидат: `dist/ChroMinimum-download-fixed-test-20261101/Launch.cmd`, отдельный
TestProfile. Основная установка не менялась, публикации нет.
[Сводный отчёт и хеши setup](reports/download-current-tab-20261101/summary.json).
