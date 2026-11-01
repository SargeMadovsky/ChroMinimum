# Карта знаний CEF
2026-10-26: [ADTS/RAW исправление системного AAC](WINDOWS_PLATFORM_AAC_PATCH.md#ручная-проверка-hdrezka-принята--2026-10-26)
подтверждено на hdrezka без администратора (MF audio/D3D11 video, звук/fullscreen).
[Проверка поставки без встроенных H.264/AAC](PLATFORM_CODECS_ONLY_CHECK.md)
подготовлена отдельно: GN-исключение0006, source/config audit, ограничения
WebAudio/WebRTC и критерии доказательства отсутствия decoder code. Новый
platform-only runtime ещё не собран; текущий рабочий эксперимент содержит FFmpeg.

Windows MF 2026-10-23: [отдельный стенд и карта интеграции](MEDIA_FOUNDATION_PROBE.md).
H.264/AAC-LC реально декодированы системными MFT на Win10; отдельно учтены
ограничения Chromium platform AAC, software H.264 fallback и WebAudio/FFmpeg.

Упаковка 2026-10-23: брать CREDITS из
`out/Release_Media_Official_x64/gen/components/resources/about_credits.html`
(8891390 байт), а не из non-official preview: там оказался sample на 401 байт.
Official генерирует полный документ через generate_about_credits; пересборка
libcef ради замены внешнего CREDITS не нужна. Упаковщик установщика/обновления
отклоняет sample. Старые preview ZIP сохранены неизменными как исторические
эксперименты; публичной поставкой они не являются.

Дополнение 2026-10-23: [official Release media experiment](CEF_MEDIA_RELEASE_EXPERIMENT.md)
собран; media/fullscreen/security прошли, большой рост private bytes/CPU не
повторился в трёх парных прогонах. Там закреплены рецепт, отчёты и ограничения.

Обновлено: 2026-10-22. Это индекс проверенных исследований, а не декомпиляция
всего движка. Для текущего CEF доступны исходники и локальные PDB: они дают
более точные имена и стеки, чем повторный разбор бинарника.

## Версия и рабочие копии

- CEF commit `14c5a089e8452874cb1a556dc3fde26ed2d87723`.
- Chromium `154.0.8037.98`, commit `b859317bf11f6be47f9b7799ec690a0a42a1fb33`.
- Закреплённый рецепт: [source-build.json](../patches/chromium/source-build.json).
- Локальные исходники: `C:\cm-media154\chromium\src`; CEF: подкаталог `cef`.
- Выход сборки: `out\Release_GN_x64`, включая `libcef.dll.pdb`.
- Фактические параметры: `out\Release_GN_x64\args.gn`; локальный рецепт:
  `C:\cm-media154\build-recipe.json`. Коммит и GN flags важнее одного номера версии.
- Stock CEF: `154.0.34+g14c5a08`; собственный shallow checkout сообщает
  `154.0.0-HEAD.1+g14c5a08`. Не исправлять эту строку подменой метаданных.

## Где искать

Пути исходников ниже относительны корню Chromium; собственные файлы — репозиторию.

| Вопрос | Точка входа | Подтверждения и ограничения |
|---|---|---|
| H.264/AAC, media runner | `media/media_options.gni`, `third_party/ffmpeg`, `cef/tools/gn_args.py` | [Диагностика видео](MEDIA_DIAGNOSIS.md) |
| Состав поставки, локали, монолитность | `cef/tools/make_distrib.py`, `scripts/package-components.py` | [Модульность](CEF_MODULARITY.md) |
| Загрузка DLL, API/sandbox identity | `cef/libcef_dll/wrapper/cef_scoped_library_loader_win.cc`, `cef/libcef_dll/bootstrap`, `src/engine_loader_win.cc` | [Привязка адаптера](UPDATER_ADAPTER_BINDING.md) |
| NetworkService sandbox | `sandbox/policy/features.cc`, `src/network_sandbox.rs` | [Песочница сети](NETWORK_SANDBOX.md) |
| Google ListAccounts | Исходные пути и цепочка вызовов сохранены в отчёте | [Корневая причина](ACCOUNTS_ROOT_CAUSE.md), [сеть аккаунтов](ACCOUNTS_NETWORK.md) |
| AI eligibility и Autofill | Исследования feature flags, настройки в `src/lib.rs` | [AI](AI_ELIGIBILITY.md), [Autofill](AUTOFILL_SERVER.md) |
| Внешние расширения | Политики и источники предустановки | [Исследование](EXTERNAL_EXTENSIONS.md); поддержка WebExtensions не доказана |
| Фоновая сеть | `scripts/audit-background-network.cjs` | [Методика](BACKGROUND_NETWORK_AUDIT.md); отсутствие всей сети не заявляется |
| Первый GET не отправлен, ERR_ABORTED на watchdog | Cookie store и I/O нового тестового профиля, сначала сравнить SSD/HDD | [Подтверждённая диагностика](HTTP_STARTUP_DIAGNOSIS.md); не ослаблять sandbox/шифрование |
| MIDL на ru-RU | `build/toolchain/win/midl.py`, наш патч 0002 | [Сборка](CUSTOM_CEF_BUILD.md), [диагностика](MEDIA_DIAGNOSIS.md); эталоны не подменяются |
| About и состояние окна | `src/lib.rs`, `src/window_state.rs` | [UI](UI_INTEGRATION.md) |
| Верхняя панель остаётся в fullscreen | `AppWindow::on_window_fullscreen_transition`, native View ID; образец `cef/tests/cefclient/browser/views_window.cc` | [Регрессионная проверка](UI_INTEGRATION.md#панель-навигации-в-fullscreen--2026-10-22); ядро не пересобирать |

## Startup-сбой собственного CEF

2026-10-22: компиляция завершилась, но первый кандидат с готовой About DLL не
открыл страницу. Локальный CDB с `-y C:\cm-media154\chromium\src\out\Release_GN_x64`
разрешил стек через PDB; без PDB экспортные имена в стеке вводили в заблуждение.
Стек: LockMetricsRecorder → raw_ptr InstanceTracer → выделение памяти →
PartitionAlloc lock timing → MetricsSubSampler → RAND_bytes/BoringSSL →
повторное выделение → ScopedDisallowAllocations trap.

`cef/tools/gn_args.py` включает `enable_backup_ref_ptr_instance_tracer=true`
для соответствующих non-official конфигураций. В `base/synchronization/lock_metrics_recorder.cc`
метрики включаются feature `RecordLockAcquisitionTime` (объявлена в `base/features.cc`).
В оболочке подготовлено отключение этой метрики без отключения защит аллокатора.
После отключения метрики запуск дошёл до renderer. Ошибка DLL initialization
1114 устранена отложенной загрузкой USER32/SHELL32 в `build.rs`; эти API нужны
браузерному UI, но не должны инициализироваться при загрузке DLL renderer.
На alpha.8 затем прошли MP4 (15 кадров в предварительной пробе), WebM и AAC в PCM,
с отдельным штатным shutdown. Финальные отчёты: `docs/reports/alpha8-media-20261022/`.

TLS-приёмка выявила отдельный deadlock: `InstanceTracer::UntraceImpl` удаляет
узел `std::map` под собственным mutex; free hook GWP-ASan может уничтожить raw_ptr,
повторно вызывая Untrace. Стек: `.local/media-build-2026-10-21/security-stall.log`.
Патч [0003](../patches/chromium/0003-instance-tracer-untrace-reentrancy.patch)
извлекает узел под mutex, а уничтожает после снятия блокировки. BRP, instance
tracing и GWP-ASan не отключены. После инкрементальной сборки повторные
media/TLS/PDF/sandbox-пробы прошли; область проверок — [alpha.8](RELEASE_ALPHA8.md).
Стеки: `.local/media-build-2026-10-21/candidate-debug2.log` (локально, не в Git).

## Как не повторять исследование

2026-10-23: для CDB, зависающего при автоматической загрузке большого PDB,
проверен двухэтапный разбор собственного тестового процесса: `cdb -pd -p PID
-sflags 0x220080 -y <empty-local-symbol-dir> -c "~* k;qd"`, затем локальный
`llvm-symbolizer --obj=<exact-libcef.dll> --pdb=<matching-libcef.dll.pdb>
--relative-address --output-style=JSON`. RVA = адрес минус module base из
ModLoad. Адреса возврата и текущие IP нельзя путать; экспортные имена CDB без
PDB не являются надёжными именами Chromium-функций. Флаги запрещают поиск по
CodeView/image directory; symbol server не задаётся. `-pd` оставляет detach
при аварийном выходе debugger. Пример, снимки и ограничения:
[диагностика начальной загрузки](WINDOWS_PLATFORM_AAC_PATCH.md#повторная-диагностика-начальной-загрузки).

Платформенный AAC M154: [патч, формат raw AAC, объектная компиляция и ограничения](WINDOWS_PLATFORM_AAC_PATCH.md).

1. Найти тему в этой таблице, прочитать результат и его ограничения.
2. Проверить commit и конфигурацию исследуемого runtime. Не переносить вывод
   на новую версию автоматически.
3. Искать `rg` по закреплённым исходникам; для сбоя сначала использовать PDB.
4. Сохранить минимальное воспроизведение, команду, хеши и результат. Различать:
   исходник прочитан, сборка выполнена, приложение запущено, поведение проверено.
5. Добавить ссылку сюда; архитектурные изменения записать в DECISIONS.

Не хранить в базе профили, cookies, пароли и NetLog с пользовательскими данными.
Большие исходники, бинарники и PDB остаются локальными; Git хранит рецепт,
патчи и краткие результаты. Удаление локальной копии потребует восстановления
из закреплённого рецепта, но не повторного поиска причин с нуля.

ADTS demux-only: [patch0009, извлечение AAC-LC ASC без decoder](ADTS_DEMUX_20261027.md); 13 native cases прошли, CEF runtime ожидается.
