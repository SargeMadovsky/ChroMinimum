# ChroMinimum

Минималистичный браузер на **Rust + Chromium (CEF)**: одно окно, сайты и PDF.

- Адресная строка на всю свободную ширину.
- Назад / вперёд, обновить / остановить.
- Ctrl+L, F5; изменение размера, сворачивание и разворачивание окна.
- Без вкладок и пользовательских плагинов в первом прототипе.

## Скачать

Готовые экспериментальные сборки: [Releases](https://github.com/SargeMadovsky/ChroMinimum/releases).

| Платформа | Состояние |
|---|---|
| Windows x64 | Прототип проверен локально; release-сборка и smoke-тест в CI |
| Linux x64 | Экспериментальный порт; сборка и smoke-тест в CI |
| macOS Apple Silicon | Экспериментальный порт; сборка и smoke-тест в CI |

Распакуйте архив целиком. Windows: `chrominimum.exe`. Linux: `./run.sh` (нужны системные GTK/NSS/GBM-библиотеки и доступная песочница Chromium). macOS: `chrominimum.app`; сборка пока без нотарификации Apple. Состав каждого выпущенного релиза и фактические результаты проверок указаны в его описании.

Это ранний прототип: нет автоматических обновлений, полноценного менеджера загрузок и законченной системы разрешений. Popup пока заблокированы. Наличие sandbox в сборке не заменяет независимый аудит; такой аудит ещё не проводился.

## Собрать

Требуются Rust **1.99.1**, CMake и Ninja. Chromium скачивается готовыми бинарниками, его исходники собирать не нужно.

Windows: установите MSVC и Windows SDK по [инструкции](docs/SETUP_WINDOWS.md), затем:

```powershell
.\scripts\build.ps1 -Release
```

Linux/macOS:

```sh
bash scripts/build.sh
```

Результат: `target/release-bundle/`. Зависимости и команды CI см. в [build.yml](.github/workflows/build.yml). [Подробнее о разработке](docs/DEVELOPMENT.md).

## Лицензия

Собственный код — [MIT](LICENSE). Chromium, CEF и Rust-библиотеки имеют собственные лицензии: см. [THIRD_PARTY.md](THIRD_PARTY.md), `CREDITS.html` и `LICENSES-RUST.html` в релизном архиве.
