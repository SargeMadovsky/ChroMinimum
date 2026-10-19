# Подготовка Windows x64

Дата: 2026-10-19. Для первой версии: просмотр сайтов и PDF в одном окне, без вкладок и расширений.

## 1. Средства C++

Скачайте [Build Tools for Visual Studio 2022](https://aka.ms/vs/17/release/vs_BuildTools.exe) с сайта Microsoft. Если уже установлен Visual Studio с нужными компонентами, используйте его установщик → «Изменить».

Выберите «Разработка классических приложений на C++» / Desktop development with C++. В составе установки проверьте:

- MSVC v143 — VS 2022 C++ x64/x86 build tools, последняя доступная версия;
- Windows SDK, например Windows 11 SDK 10.0.26100 (название SDK не требует перехода с Windows 10 на Windows 11);
- C++ CMake tools for Windows. В комплекте Microsoft поставляется также Ninja; его наличие проверяется ниже;
- английский языковой пакет полезен для диагностики ошибок.

Установщик покажет необходимое место. Установите компоненты и перезагрузите компьютер, если предложено. Редактор Visual Studio Code сам по себе эти средства сборки не устанавливает.

## 2. Rust

Откройте [официальную страницу установки Rust](https://rust-lang.org/tools/install/) и скачайте rustup-init.exe для x64. Запустите и выберите стандартную установку: stable, host x86_64-pc-windows-msvc. Оставьте добавление Rust в PATH включённым. Cargo и rustup устанавливаются вместе с Rust.

После установки закройте и снова откройте терминал и Codex, чтобы они получили обновлённый PATH.

## 3. Проверка

Откройте через меню «Пуск» **Developer PowerShell for VS 2022**. Проверьте:

```powershell
rustc --version
cargo --version
rustup show
git --version
cmake --version
ninja --version
where.exe cl
```

В rustup show ожидается активная stable-цепочка с x86_64-pc-windows-msvc. cl, CMake и Ninja могут быть доступны только в Developer PowerShell — это нормально. Если CMake/Ninja не обнаружены и там, проверьте компонент C++ CMake tools в Visual Studio Installer.

Если Rust не обнаружен после перезапуска терминала, проверьте наличие `%USERPROFILE%\.cargo\bin` в пользовательском PATH. Не меняйте системный PATH целиком.

## Что пока не требуется

Git уже обнаружен: 2.55.0.windows.3. Не нужны Node.js, Python, Java, Docker и отдельная установка Slint. Для первого пути сборки используем MSVC, поэтому отдельный LLVM пока не устанавливаем. Готовые бинарники CEF подберёт сборка; весь Chromium из исходников пока не собираем. Скачивания зависимостей могут занимать несколько гигабайт, первая сборка — заметное время.

Точная совместимость установленного компилятора с выбранным CEF подтверждается сборкой, а не только успешным выполнением команд версий.

## Источники

- [Rust: установка](https://rust-lang.org/tools/install/).
- [Rust: требования MSVC](https://rust-lang.github.io/rustup/installation/windows-msvc.html).
- [Microsoft: компоненты Build Tools 2022](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022).
- [cef-rs: сборка](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/README.md) и [build.rs](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/sys/build.rs): CMake/Ninja, Windows SDK и wrapper C++.
