# NetworkService sandbox: причина и экспериментальное исправление

Дата: 2026-10-20. Проверено на native Windows x64 10.0.19045.6466,
CEF 154.0.34 / Chromium 154.0.8037.98. Владелец продолжает пользоваться alpha.3;
её файлы/профиль/настройки в этой задаче не заменялись. Исправление проверено
на отдельных копиях и TestInstall, но **не готово к выдаче как основное обновление**:
до этого нужно исключить возврат старого адаптера через канал обновлений.

## Причина

В [исходнике именно Chromium 154.0.8037.98](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/sandbox/policy/features.cc)
NetworkServiceSandbox по умолчанию disabled. Общий Settings.no_sandbox=0 не включает
эту отдельную feature. Там же Windows-поддержка ограничена build 19041+ и исключён
ARM64, включая x64-эмуляцию. Это объясняет none/Medium в установленной alpha.3.

Явное включение выявило вторую проблему: AppContainer не мог читать executable
из приватного каталога runtime. Журнал дал `Sandbox cannot access executable`,
код 0x5, затем перезапуск службы и снова none/Medium. В
[SystemNetworkContextManager того же Chromium](https://raw.githubusercontent.com/chromium/chromium/refs/tags/154.0.8037.98/chrome/browser/net/system_network_context_manager.cc)
это предусмотренный fallback после failed launch, а не доказательство успешной
работы сетевой песочницы. Первый token-only тест проверял renderer, поэтому его
положительный результат не засчитывается как проверка NetworkService.

## Изменения

- src/network_sandbox.rs и Windows callback добавляют обязательный
  NetworkServiceSandbox, удаляя только конфликтующие записи именно этой feature;
  остальные enable/disable features сохраняются. Есть тест идемпотентности и
  записи с field-trial/параметрами. TLS и site isolation не отключались.
- Перед инициализацией проверяются build/нативная архитектура через RtlGetVersion
  и IsWow64Process2. Неподдерживаемая система получает отказ, а не тихий запуск
  сети без sandbox. Inno minimum поднят до Windows 10 build 19041, архитектура
  ограничена x64os ([смысл идентификатора Inno](https://jrsoftware.org/ishelp/topic_setup_architecturesallowed.htm)).
  Это ограничение ОС, а не запрет HDD или старого процессора с подходящей Windows.
- Инсталлятор и Windows bundle-helper выдают SID S-1-15-2-1 только RX с наследованием
  на каталог core. Используется системный icacls, без выдачи write/modify/full control.
  Профиль установленной копии вне core; portable-профиль также рядом с core,
  а не внутри него. Секреты/пользовательские данные нельзя хранить в core.
- OnBeforeChildProcessLaunch отказывает network.mojom.NetworkService с любым
  sandbox-type кроме network, до фактического запуска такого child. Собственная
  попытка Chromium fallback не обходит обязательную защиту приложения.

Отказ — аварийное завершение только собственного browser process с кодом 1.
В нём не выполняется обычный CEF shutdown; при такой ситуации во время сессии
может потеряться несохранённая работа. Безопасный останов важнее продолжения
несанкционированного сетевого процесса. Первый вариант std::process::exit запускал
CRT at-exit при незавершённом CEF и дал 0xC0000602; заменён на прямое самозавершение
WinAPI, отрицательный тест затем получил именно код 1. Эта история сохранена,
неуспешный прогон не объявляется штатным закрытием.

## Фактические проверки

| Проверка | Результат |
|---|---|
| Feature включена, runtime без нужного ACL | Увиден отказ доступа и upstream fallback; эксперимент не принят |
| ACL исправлен | NetworkService: sandbox-type=network, AppContainer=1, Integrity RID=4096 (Low) |
| Итоговые ACL только на core | На корне candidate ACE AppPackages нет; на core наследуемый RX, mask 1179817 |
| Renderer/storage | Untrusted, restricted, режим не ослаблен |
| GPU | Low, restricted |
| Недоверенный TLS | ERR_CERT_AUTHORITY_INVALID, 0 HTTP GET у сервера |
| HTTPS example.com | HTTP 200, без main_frame_error |
| PDF локального файла | Загрузка, код 0, shutdown_complete |
| PDF через loopback HTTP, окончательная DLL и ACL только core | HTTP 200, первый GET 0,282 с, код 0, shutdown_complete, без FATAL |
| Runtime без AppContainer ACL, итоговый отказ | network_sandbox_refused, код 1, 0 HTTP GET |
| TestInstall EN/RU | 4/8 pak, HTML/PDF/relaunch, NetworkService AppContainer/Low в обеих установках |
| Удаление TestInstall | Собственные регистрации удалены, UserChoice не изменён, sentinel данных сохранён |
| Windows bundle-helper | Собран и выполнен; наследуемый RX создан только на его core |

Для полного TLS/PDF-прогона candidate сначала использовался более широкий
тестовый ACL на корне. После сужения до core прогон повторён отдельно и прошёл:
core-only-regression содержит окончательный результат. Ни AppData пользователя,
ни установленный Programs/ChroMinimum этим ACL не менялись.

Windows-токен NetworkService имеет Restricted=false, но AppContainer=true/Low;
это другой механизм ограничения, не эквивалент исходному none/Medium/unrestricted.
LPAC и все mitigations/job limits отдельно не проверялись. Полная изоляция origin,
камера/микрофон/скачивание и независимый security-аудит остаются открытыми.

Проверены четыре std-only Rust-теста политики, clippy --all-targets с -D warnings,
rustfmt, Release DLL/bundle-helper, синтаксис Python и diff-check. После выделения
эквивалентной OS/arch-проверки в тестируемую функцию текущая DLL дополнительно
прошла шесть HTTP/JS/навигационных прогонов и окончательный core-only TLS/PDF
прогон. TestInstall собирался до этого эквивалентного выделения; его собственные
SHA и исходный payload сохранены отдельно, артефакт не подменяется последней DLL.

## Стоимость на NVMe

Release DLL: 715264 → 726016 байт, +10752 байт (10,5 КиБ), сравнение локальных
артефактов, не чистая парная сборка. Новых зависимостей и постоянной службы нет.
icacls вызывается при упаковке/установке, не при обычном запуске. В PDF-снимках
до/после наблюдалось по 8 процессов CEF; это не обещание неизменности количества
во всех сценариях и не замер RAM/CPU.

Три пары запусков установленных alpha.3 и candidate, новые тестовые профили на C:,
порядок A/B, B/A, A/B, cache ОС прогрет проверкой хешей:

| До первого loopback GET, с | Alpha.3 | Candidate |
|---|---:|---:|
| Прогон 1 | 0,371 | 0,336 |
| Прогон 2 | 0,314 | 0,341 |
| Прогон 3 | 0,297 | 0,297 |
| Медиана | 0,314 | 0,336 |

Все шесть прогонов прошли HTML/JS/Enter/back/forward/reload и оконные проверки.
Разница медиан 22 мс при перекрывающихся диапазонах не доказывает значимой
регрессии/её отсутствия: мало наблюдений, фоновая нагрузка не изолирована,
RAM/CPU не измерены, executable находятся в разных каталогах. HDD в этой серии
не исследовался, прежние [HDD/NVMe результаты](HTTP_STARTUP_DIAGNOSIS.md) сохранены.

## Артефакты и следующий этап

Новые инструменты: test-network-sandbox-refusal.py (новая приватная runtime-копия),
compare-network-sandbox-startup.py (пары с отдельными профилями), режим
--require-network-sandbox в test-installed-security.py. TestInstall alpha.4
проверяет реальные токены перед удалением установки. Все тесты ограничены
собственными процессами/данными, временные TLS-ключи удалены.

Компактные локальные результаты, токены и журналы сохранены в
`.local/network-sandbox-validation-2026-10-20/`; большие сетевые трассы и
временные закрытые TLS-ключи в этот набор не включены.

`dist/ChroMinimum-0.0.1-alpha.4-test-setup-x64.exe` — только TestInstall,
157920056 байт, SHA-256
`f9e6ffa7a3756829e223047f03b23adddc076c4e5e9b47158210e7d31ddd79b2`.
Обычный alpha.4 setup не выдавался/не устанавливался. После извлечения ZIP права
могут не сохраниться: Windows portable-упаковка требует подготовки RX на core;
один факт сборки/распаковки не подтверждает работоспособность на другой машине.

Блокер перед обновлением владельца: текущий подписанный format=1 аутентифицирует
пакет, но не проверяет обязательную capability/минимальный адаптер для этой защиты.
Он может установить прежнюю Rust DLL и отменить hardening при следующем старте.
Это нельзя считать решённым включением feature в новом seed. Следующая ограниченная
задача — проверяемая совместимость/защита от такого возврата в загрузчике/обновляторе,
с миграционными тестами; затем основной установщик. Подписи/публикация рабочего
канала и настоящие закрытые ключи в этой задаче не затрагивались.

Установленная alpha.3 повторно сверена: все 33 payload-хеша прежние, изменений нет.
