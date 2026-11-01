# Проверка установленной копии, 2026-10-20

После сообщения владельца об установке проверен реальный экземпляр
`%LOCALAPPDATA%\Programs\ChroMinimum`, локальная alpha.3, CEF 154.0.34,
конфигурация ru с английским fallback. Пользовательская установка не удалялась,
не переустанавливалась и не обновлялась. Тесты направлялись только в новые
временные каталоги на NVMe через CHROMINIMUM_DATA_DIR либо тестовый LOCALAPPDATA.
Реальный профиль не читался/не использовался; назначения файлов не менялись.

## Функциональные проверки

| Сценарий | Результат |
|---|---|
| Запуск через установленный format=1 launcher | Код 0, installed_locale=ru, CEF 154.0.34 |
| HTTP/JS, Enter/back/forward/reload | Все обязательные маркеры получены |
| Resize/maximize/restore/minimize | Все состояния проверены CEF API |
| Первый локальный GET | 0,613 с в одном диагностическом прогоне, не бенчмарк |
| HTML с кириллицей, пробелами, #/% | Открыт через команду реально установленного ProgID |
| PDF при уже открытом HTML | Запрос передан существующему процессу, два собственных окна/панели |
| Штатное закрытие | Код 0, shutdown_complete, оставшихся chrominimum нет |

Файловая проверка длилась около 30,5 с из-за намеренного smoke-таймера, а не
30-секундной загрузки страницы. Реестр UserChoice до/после совпал. Проверена
команда ProgID, не нажатия «Открыть с помощью» в UI Windows. PDF load не доказывает
поиск/масштаб/сохранение и визуальную корректность просмотрщика.

Все 33 установленных payload-файла сверены с payload-inspection.json инсталлятора:
несовпадений нет. core-state.json как отсутствовал, так и отсутствует; обновление
ядра не устанавливалось. Штатные runtime lease/core-health файлы могут создаваться
загрузчиком и тестовым запуском, они не относятся к профилю/поставляемому payload.

## TLS

На loopback создан временный HTTPS-сервер с самоподписанным сертификатом localhost.
Сертификат не добавлялся в системное хранилище или CEF; проверка TLS не отключалась.
Браузер сообщил ERR_CERT_AUTHORITY_INVALID, сервер не получил ни одного HTTP GET.
Рендеринг Chrome error page с status=0 не засчитывается как успешная загрузка
недоверенного сайта. После этого публичный `https://example.com/` загрузился с
HTTP 200 без main_frame_error. Эти случаи подтверждают отказ недоверенному issuer
и положительный HTTPS, но не полный набор TLS-тестов (expired/name/revocation/HSTS).
TLS-сервер остановлен, временный закрытый ключ удалён.

## Фактические Windows-токены

PowerShell/C# probe использовал OpenProcess с QUERY_LIMITED_INFORMATION,
OpenProcessToken с TOKEN_QUERY, GetTokenInformation и IsTokenRestricted.
Числа TOKEN_QUERY=8, TokenIntegrityLevel=25 и TokenIsAppContainer=29 сверены
с локальным исходником закреплённого windows-sys 0.61.2. SeDebugPrivilege,
изменение токенов/ACL/политик не использовались. Выбирались только живые потомки
PID тестового launcher; командные строки и URL целиком не сохраняются.

Первый снимок подтвердил ограничения renderer/GPU. Для одного Medium utility
назначение было неясно; отдельный второй снимок с классификацией subtype дал:

| Роль | Integrity RID | Restricted | AppContainer | Sandbox type |
|---|---:|---|---|---|
| Browser | 8192 (Medium) | Нет | Нет | Не указан |
| GPU | 4096 (Low) | Да | Нет | Не указан |
| StorageService | 0 (Untrusted) | Да | Нет | service |
| 4 renderer-процесса | 0 (Untrusted) | Да | Нет | Не указан |
| NetworkService | 8192 (Medium) | Нет | Нет | **none** |

Ошибок чтения токенов не было. Это подтверждает часть фактической sandbox,
но не является аудитом job object, mitigations, IPC, filesystem/registry access
или изоляции разных origin. Отсутствие AppContainer само по себе не означает
отсутствие restricted-token sandbox у renderer; обе характеристики отражены отдельно.

**Открытый приоритет: сетевой процесс установленной сборки не использует sandbox
режим NetworkService.** В src/ не найдено явных disable-features/NetworkServiceSandbox;
точная причина выбора upstream/default режима ещё не установлена. Не следует
объявлять весь браузер без песочницы или считать полную security-приёмку пройденной.
Следующий ограниченный этап — установить причину и проверить включение network
sandbox на изолированной сборке с HTTP/HTTPS/PDF и повторным чтением токенов.
Установленная владельцем DLL в рамках этого этапа не заменялась.

## Инструменты и воспроизведение

Добавлены только диагностические скрипты; runtime/инсталлятор не пересобирались
и не менялись. Новых продуктовых зависимостей, служб, постоянного опроса и фоновой
сети не добавлено. Probe опрашивает процессы один раз; короткий polling готовности
есть только в тестовом harness. CPU/RAM диагностики отдельно не измерены.

```powershell
python scripts/smoke-component-bundle.py --bundle <installed-root>/core/seed --installed-launcher <installed-root>/chrominimum.exe --output <new-test-dir> --case html --expected-locale ru --net-log
python scripts/test-installed-files.py --launcher <installed-root>/chrominimum.exe --output <new-test-dir>
python scripts/test-installed-security.py --launcher <installed-root>/chrominimum.exe --output <new-test-dir> --openssl <openssl.exe>
```

Для уточнения token subtype без повторения TLS служит --only-tokens. Нужен
PowerShell 7; OpenSSL нужен только для создания временного тестового сертификата.
Исходные отчёты сохранены во временных каталогах C:, компактные result/log/tokens
скопированы в `.local/installed-validation-2026-10-20`:
navigation/, files/, security/, token-roles/. Полные NetLog остаются локальными
в тестовых профилях и автоматически не публикуются.

Проверены синтаксис Python/PowerShell, git diff --check и фактическое выполнение
новых скриптов. Первую попытку уточнить subtype уже завершившегося файлового
теста probe отклонил (0 живых test launcher); данные других процессов не подставлялись.
Повторный отдельный токен-тест завершился с кодом 0 и дал таблицу выше.
Галочка полной security-приёмки в TASKS остаётся открытой.
