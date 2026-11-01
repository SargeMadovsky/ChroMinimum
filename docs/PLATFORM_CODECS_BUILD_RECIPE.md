# Windows: рецепт экспериментального системного AAC/H.264

Проверка 31 октября — 1 ноября 2026 года. Это рецепт уже испытанного
эксперимента0011, а не новый публичный пакет или стандартный неизменённый CEF.

## Что закреплено

[Отдельный manifest](../patches/chromium/platform-codecs-154-win64.json)
содержит Chromium/CEF и dependency commits, порядок и SHA11 патчей,
ожидаемые SHA27 конечных исходных файлов, GN args и SHA проверенной DLL.
[GN args](../patches/chromium/platform-codecs-154-win64.args.gn) сохранены
отдельно от рецепта стандартного ядра. Общий source-build.json не менялся.

CEF предварительно применяет собственные patches/hooks. В частности,
наш0007 требует состояние ANGLE после штатного angle_commit_config.patch.
Простое наложение наших патчей сразу на Chromium/ANGLE Git HEAD неверно.

Проверенный sparse replay читает исходные Git-версии, применяет нужную часть
официального CEF-патча и наши11 патчей в новом каталоге, затем сверяет все27
файлов с manifest и текущим экспериментальным checkout. Новые исходные
деревья целиком не распаковываются; сборочный checkout не изменяется.

```powershell
python scripts/verify-platform-codec-patches.py `
  E:/cm-platform154/chromium/src `
  E:/UnityProjects/ChroMinimum/.local/platform-patch-replay-new
```

Каталог результата должен отсутствовать. Проверены и исходный исследовательский
replay, и переносимый helper с проверками commit/SHA. Это воспроизводимость
наложения патчей; новая полная сборка из чистого checkout и побитовая
воспроизводимость DLL этим не доказаны.

Для настоящей сборки нужны pinned dependency hooks/CIPD, SDK/MSVC/LLVM,
подготовка CEF, GN и Ninja. Прежние восстановления отсутствовавших инструментов
и generated headers описаны в TASKS. TEMP/TMP, output и кэши должны оставаться
на выбранном сборочном диске. Новый полный build этой проверкой не запускался.

## Аудит состава

[Отчёт](reports/platform-codec-input-audit-20261031/summary.json):

- Выбран Chromium/win/x64 FFmpeg config, известные AAC/H.264 decoder/encoder
  macros выключены, соответствующих decoder entries нет в реестре.
- Проверены230 реальных членов thin archive FFmpeg, их SHA и соответствие
  сгенерированным compile edges. Декодирующих AAC/H.264 sources среди них нет.
- В explicit link edge libcef присутствует именно проверенный FFmpeg archive;
  OpenH264 inputs там не обнаружены. Parser/demuxer AAC остаются намеренно.
- SHA DLL в output совпадает с испытанной поставкой. CodeView GUID/age DLL
  соответствует PDB: A21BB6DE-2F45-C933-4C4C-44205044422E, age1.
- LLVM просмотрел726777 public symbols. Контрольные FLAC/FFmpeg/MF symbols
  найдены, выбранные известные символы AAC/H.264 FFmpeg/OpenH264 не найдены.

FFmpegAudioDecoder как общий wrapper остаётся для поддерживаемых открытых
форматов; наличие его класса не означает наличие AAC decoder. Аналогично,
libavformat/aacdec.c — demuxer, а не реализация декодирования AAC в PCM.
proprietary_codecs=true включает распознавание форматов; состав реализаций
дополнительно ограничивается branding, macros и выбранными inputs.

Это совокупность проверенных технических свидетельств. Полный транзитивный
аудит каждого link input и скрытого/оптимизированного кода ещё не выполнен;
binary_absence_proven=false сохранён. Проверка не является заключением об
условиях распространения. REA в сессии не подключён; PDB проверен штатным
llvm-pdbutil из сборочного LLVM, а не REA provider.

## Что требуется перед обновлением пользователей

Испытан frozen adapter с SHA из manifest. Системный AAC сейчас включается
через CHROMINIMUM_TEST_SYSTEM_CODECS=1, который включает
ChroMinimumPlatformAudioFirst. Одна замена DLL без этого условия не считается
готовой интеграцией в обычный браузер.

Следующий ограниченный этап — штатное включение этого режима в выпускаемой
оболочке и проверка подписанного media-канала обновлений по
[существующему контракту](MEDIA_ENGINE_UPDATES.md). Надо повторить приёмку
установленного комплекта после обновления, включая требуемый backend и sandbox.
Стандартный канал нельзя молча подменять этим вариантом.

Текущий общий source-build.json также требует0012/0013 для внешних протоколов;
в испытанном codec manifest их нет. Совместная сборка и поведение этих изменений
должны быть проверены отдельно. Здесь не менялись их исходники, текущая Rust/UI
ветка, подпись, релизы или обновления пользователей.
