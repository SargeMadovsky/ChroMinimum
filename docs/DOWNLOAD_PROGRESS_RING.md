# Штатное кольцо загрузки — 2026-11-01

Владелец согласовал кольцо на кнопке и сохранение существующего dropdown
после завершения. Новые уведомления/службы/сеть не добавляются.

0014 применяется после0005 к точному postimage Chromium154.0.8037.98.
DownloadProgressRing принимает views::View, выбирает нашу кнопку по ID
0x434d4401 и использует прежние progress_info/state события Chromium.
UpdateIcon обновляет эту ветку, не скрытую Chrome toolbar. Известный размер
даёт процентное кольцо; неизвестный размер/scanning — штатную анимацию;
завершение/отмена/ошибка возвращают idle. Ветка bubble не меняется.

Один ring View/layer создаётся лениво при обновлении контроллера, живёт
с родительской кнопкой. Нет собственного таймера опроса, процесса или IPC.
Анимация неизвестного прогресса может тратить CPU только пока активна;
RAM/CPU/размер DLL после изменения ещё не измерены.

Публичные CEF API и Rust adapter не меняются. Только C++ UI и перелинковка
libcef; системные codec/media0011 и native protocols0012/13 сохраняются.
Патчи0005 и готовое ядро257a… не заменяются. Патч0014/metadata сохранены
в patches/chromium, применение проверяет version/hash и отказывает неизвестному
входу. Apply/reapply/отказ изменённому входу проверены на временной копии.
Link завершён exit0 за2972с; SHA256 DLL:
fe11104edaac36b148f96c69ea0c64c720e57f0507a1b84f93bcb3e4d4c6940f.
Размер307119616байт (+1024 к предыдущему ядру). Adapter не менялся.

Сборка: `.local/download-ring-20261101/core/result.json`, отдельные compile/link
логи там же. TEMP/TMP и ThinLTO cache на E:. Исходный checkout/готовые объекты
и текущая установка не заменяются, LTOjobs=2.

Воспроизведение подготовки/сборки:

```powershell
python scripts/build-download-bubble-core.py --chromium-src E:/cm-platform154/chromium/src --base-core .local/native-external-protocol-20261030/core-redirect --output <new-output> --progress-ring
```

После линковки: новый hashed runtime, затем test-links-downloads.cjs с
--native-bubble --progress-ring для complete/cancel/interrupt. Проверяются
настоящее OnPaint кольца, промежуточные проценты и idle после конца; mini-panel,
Ctrl+J и resize продолжают проверяться. Нужна ручная визуальная приёмка кольца
и dropdown после завершения. Затем media/sandbox/protocol regressions и новый
установщик; публикация до успешной приёмки не выполняется.

## Результаты

Complete/cancel/interrupted прошли: native OnPaint, промежуточные проценты,
idle после конца, штатная mini-panel/button/Ctrl+J/resize и shutdown.
MP4/WebM EOF82кадра, AAC PCM123244/44100/stereo, MF и sandbox прошли.
Fullscreen2цикла и protocol popup/sandbox-denied прошли. Ранние ошибки
готовности fixture в links/fullscreen сохранены; усилены только стенды.

Оба setup собраны,34 файла payload402262169байт. Installer test отказался
заменять существующую ручную TestInstall владельца до записи файлов/реестра.
Она и основная установка не менялись. Новый manual kit подготовлен отдельно;
визуальная приёмка кольца и нового setup ещё ожидается. Публикации нет.
[Сводный отчёт](reports/download-ring-20261101/summary.json).
