# Логотип страницы загрузок — 2026-11-01

Владелец принял исправления иконок и попросил заменить Chromium logo перед
сборкой релиза. Изменён только IDR_DOWNLOADS_DOWNLOADS_ROLLUP_JS18474 в resources.pak:
в downloads-toolbar template добавлен img в штатный product-logo slot cr-toolbar.
Наш SVG в data URI имеет32×32px и margin-inline-end16px. Внешних ресурсов нет,
стандартный fallback slot скрывается назначенным элементом.

Пакет GRIT прочитан/записан штатным data_pack. Все6006 IDs сохранены; содержимое
остальных6005 ресурсов побайтно неизменно. Source PAK7bed93a5…, branded PAK
e245f9f46432d2ea01eadae246065cd3ee9498691d13895afe0a64739e80c6e0, +2338байт.
DLL не менялись. В pinned downloads BUILD.gn generate_code_cache не включён
(default=false), отдельного downloads bytecode cache нет. CSP не ослаблялась.

`scripts/brand-downloads-resources.py` требует точные входные SHA PAK/resource/SVG
и единственный toolbar template match, отказывает неизвестным входам и существующему
output. `scripts/test-downloads-branding.cjs` проверяет assigned slot, точный SVG hash,
natural size,32px bounds, alt, отсутствие CSP/Log errors,1page и shutdown.
Проверено для light/dark CSS media, включая EN/RU установленный RC launcher.
Это не полная проверка переключения системной темы всех native элементов.

Первый запуск отказал по network sandbox: новому файлу PAK не был выдан штатный
AppContainer RX. Добавлен обычный read/execute ACL runtime; sandbox не отключалась,
повтор прошёл. Одна попытка запуска была остановлена лимитом automatic approval
review, без выполнения действия; после возобновления владельцем разрешённый запуск
прошёл тем же способом.

Во временной копии RC-тестов обнаружена ошибка чтения UTF-8 как CP1251: создавались
файлы с уже испорченными именами. Продуктовый установщик использовал исходный ISS
напрямую и этой перекодировки не получал. Копии ISS/Python пересозданы с explicit
UTF-8, Unicode filename fixture теперь использует escape spelling. Старые отчёты
сохранены. Повтор EN/RU подтвердил настоящий файл «Тест #100% --file.pdf», URI,
HTML/PDF/relaunch, branding, hash/migration/sandbox/uninstall и сохранение данных.
Владелец подтвердил «да, теперь ок». Основная установка/прежний Installer Test
не менялись, RC имеет отдельные AppId/ProgID/ApplicationKey.

Релизный набор собирается локально. Публикация/Authenticode и оценка условий
распространения не выполнены. Source materials не являются утверждением о полном
license compliance или bit-identical rebuild.
