# ListAccounts: установленные инициаторы и исходный патч

2026-10-21. Корень наблюдаемого стартового запроса установлен. Запрет в
пользовательской сборке **ещё не поставляется**: исходный CEF не пересобран.

По решению владельца D031 собственная сборка отложена. В alpha.7 используется
стандартный CEF, стартовый ListAccounts остаётся известным ограничением.

## Два пути

С точными release symbols CEF 154.0.34+g14c5a08 снят стек текущего бинарника:

```
AccountInvestigatorFactory::BuildServiceInstanceForBrowserContext
signin::PersistentRepeatingTimer::Start
AccountInvestigator::TryPeriodicReport
signin::IdentityManager::GetAccountsInCookieJar
GaiaCookieManagerService::ListAccounts
GaiaCookieManagerService::TriggerListAccounts
```

Это запрос из периодического сбора статистики аккаунтов, а не из открытой
страницы. Для этого наблюдаемого запроса прежняя гипотеза о session duration
recorder не подтвердилась. Она не исключает его чтения аккаунтов в иных случаях.

Включение `AvoidAutoTriggerListAccountsOnStale` действительно возвращает кэш
из GetAccountsInCookieJar: в отладчике проверено значение feature-проверки
`al=1`. Но эта же feature включает другой стартовый путь:

```
ProfileManager::DoFinalInitForServices
signin::IdentityManager::OnNetworkInitialized
GaiaCookieManagerService::ListAccounts
GaiaCookieManagerService::TriggerListAccounts
ChromeSigninClient::DelayNetworkCall
```

Он восстановлен из регистров/байтов стека и x64 unwind-таблиц точной DLL;
имена кадров независимо разрешены через Microsoft DIA из совпадающего PDB.
Асинхронная отправка позже идёт через
WaitForNetworkCallbackHelperChrome::OnConnectionChanged и теряет первоначальный
синхронный стек. Это объясняет отрицательный результат прежнего флага.

[IdentityManager точной версии](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/signin/public/identity_manager/identity_manager.cc),
[AccountInvestigator](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/components/signin/core/browser/account_investigator.cc).

## Причинный опыт и патч

В отдельном тестовом процессе под отладчиком только вызов ListAccounts из
OnNetworkInitialized перенаправлен на существующий GetCachedListAccounts с тем
же ABI. Остальные вызовы не перенаправлялись. Эта временная диагностическая
интервенция не записывает изменения в DLL и не является способом доставки.

В 30-секундном about:blank NetLog стало **0 ListAccounts** вместо 1, браузер
завершился с shutdown_complete. Остались запрос времени, component update и
загрузка AI manifest; отсутствие всей телеметрии/фоновой сети не заявляется.
SHA-256 libcef.dll остался
`e3da6707a840a8f33f565e011542169fd51aaa5218603eb7a89039fb16d79ae7`.
Реальные профили/аккаунты/пароли не использовались. Песочница не отключалась.
Это причинная диагностика, не испытание собранного исходного патча.

[Патч](../patches/chromium/0001-no-startup-listaccounts.patch) удаляет только
автоматический ListAccounts в OnNetworkInitialized. Инициализация cookie listener
и account fetcher сохраняется. Патч должен использоваться **вместе с включённой
AvoidAutoTriggerListAccountsOnStale**; без неё останется первый путь.
[Метаданные](../patches/chromium/0001-no-startup-listaccounts.json) фиксируют версию
и SHA исходного/исправленного файла с LF. Git apply --check и применение к копии
исходника прошли; SHA исправленной копии совпал. Компиляции CEF не было.

Нельзя добавлять флаг обратно в обычный установщик до наличия соответствующего
патченного CEF. Для него нужны отдельная идентичность ядра/пакета и security
sequence, проверка совместимости adapter и обновлённый закреплённый baseline;
нельзя обходить существующую проверку хешей обновлятора.

## Следующий необходимый этап

Нужна сборка собственного CEF и испытания свежего/подготовленного профиля,
cookie/форм, входа на сайты, HTTPS/TLS, PDF и фактических sandbox-токенов.
Инициализация аккаунтов Chrome может вести себя иначе; аккаунт браузера и Sync
не входят в текущий прототип. Существующие данные паролей/профиля не удаляются.
Патч не удаляет сам AccountInvestigator и не доказывает отсутствия других
источников метрик или account requests после действий пользователя.

[Инструкция именно Chromium 154](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/docs/windows_build_instructions.md)
требует VS 2026 >=18 и SDK 10.0.28000.2270. Проверка vswhere -all нашла только
Build Tools 2022 17.14; установлен SDK include 10.0.26100.0. На момент диагностики установка нового
набора ещё не выполнялась; результат разрешённой установки приведён ниже. Свободно около 138 GiB на E и 384 GiB
на C; это снимок, не гарантия места на полный checkout/build. Первичный upstream
минимум — 100 GB, реальный расход именно нашей сборки пока неизвестен.
Сборка потребует крупного checkout, компиляции/линковки и заметного CPU/диска;
время и память не измерены. Автоматическое ослабление защиты/антивируса,
изменение глобального PATH и удаление существующего toolchain не предусмотрены.

## Инструменты и ограничения диагностики

Официальный архив release symbols (~859 MB) проверен по SHA1 публикации
`337fccc8148610e1be8777e6a67995d37c028bd6`, PDB 5384511488 байт извлечён локально.
Microsoft WinDbg package извлечён без установки; dbgeng имеет действительную
подпись Microsoft. Локальный клиент Debug Engine и DIA не добавлены в браузер
или зависимости проекта. Старый dbghelp разбирал часть символов тяжело/зависал;
последующие стеки сохранялись прямым чтением и разбирались офлайн.
Текущие upstream-инструкции отдельно требуют новые Debugging Tools для PDB >4GB.

Несколько диагностических попыток остановлены при тяжёлом разборе символов;
их нельзя считать успешными smoke-тестами. Пробный запуск из ограниченной
оболочки отказался от небезопасного сетевого fallback. У завершённых запусков
локальный debugger client вернул 8 после финального WaitForEvent/E_UNEXPECTED;
штатное закрытие самого браузера установлено отдельным smoke.log.
Это ограничение вспомогательного клиента, а не заявленная полная debug-приёмка.

REA doctor подтвердил отсутствие регистрации в текущем Codex; конфигурация
не менялась. Факты выше получены обычными shell/Microsoft API-инструментами,
не REA Evidence. Использован навык reverse-engineer-anything для выбора пути.

Evidence: `.local/accounts-rootcause-validation-2026-10-21/`.
Инструменты/сырые тестовые логи: `.local/account-debug-tools/`; в поставку
они не включаются. Основной установленный alpha.6 не менялся.

## Разрешённая установка инструментов — 2026-10-21

Владелец явно разрешил установку нового набора рядом с прежним. Официальные
bootstrapper Microsoft проверены Authenticode (Valid/Microsoft Corporation):
Build Tools 18.11.1, SDK bundle 10.1.28000.2270. Хеши и подписи сохранены в
`.local/account-debug-tools/installers-verified.json`.

SDK завершился с кодом 0, restart None. Установлены C++ x64/x86 и Debugging Tools;
заголовки/библиотеки находятся в Windows Kits/10/{Include,Lib}/10.0.28000.0,
версия dbghelp.dll — 10.0.28000.2270. Build Tools 2026 установлен в отдельный
каталог рядом с 2022; vswhere находит VC.Tools.x86.x64 и VC.ATLMFC.
MSVC tools 14.51.36231, библиотека MFC x64 присутствует.

Небольшая программа с windows.h, atlbase.h, CComPtr и GetCurrentProcessId
собрана /W4 /WX, слинкована и запущена (код 0) через Developer PowerShell 18.11.1
с явным SDK 10.0.28000.0. Вывод: MSVC=195136260, WIN64=64.
Исходник, команда и лог: `.local/account-debug-tools/toolchain-smoke.cpp`,
`verify-toolchain.ps1`, `toolchain-smoke.log`. Это проверка инструментов, не
сборка CEF и не испытание патча. Установленный ChroMinimum не менялся.

Следующий шаг — закреплённый checkout CEF/Chromium на NVMe, применение патча и
сборка с последующей приёмкой сети/сайтов и sandbox. Полный checkout и сборка
пока не выполнены. Новых зависимостей браузера или фоновых служб ChroMinimum
эта подготовка не добавляет.

Build Tools также завершился с кодом 0. Итоговый vswhere подтвердил оба набора
(2026 18.11.12315.225 и 2022 17.14.37806.7): isComplete=true,
isRebootRequired=false. Проверка компиляции/линковки/запуска повторена после
завершения обоих установщиков и прошла; Debugging Tools остались 28000.2270.
Рекомендованный SDK 26100 обновлён установщиком VS до servicing 26100.9457;
каталоги 26100 и 28000 существуют рядом. Во время пересечения SDK-операций
установщик VS получил MSI 1618, автоматически повторил этап и завершился с 0;
это промежуточный конфликт занятости установщика, не итоговая ошибка.
Итоговые evidence: `toolchain-installed.json`, `toolchain-smoke-final.log` в
`.local/account-debug-tools/`. Свободно C: 374,5 GiB, E: 138,0 GiB после установки;
разность снимков не является точным размером toolchain из-за фоновой нагрузки.
Перезагрузка не выполнялась, глобальный PATH вручную не менялся.
