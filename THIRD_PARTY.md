# Сторонний код

Начальная интеграция CEF основана на примере cefsimple из [cef-rs](https://github.com/tauri-apps/cef-rs/tree/163744c8286d5f593d89202c7807751a7898db28/examples/cefsimple), распространяемого по Apache-2.0 OR MIT.

Copyright (c) 2023 Wu Yuwei (уведомление MIT upstream).

Собственный код ChroMinimum — MIT (LICENSE). Точные тексты лицензий cef-rs хранятся в third_party/cef-rs, BSD-лицензия CEF — в third_party/cef/LICENSE. Сборка macOS также использует адаптированный NSApplication из cef-rs cefsimple.

В каждом релизном архиве CREDITS.html из бинарного дистрибутива CEF содержит уведомления Chromium и его сторонних компонентов, включая PDF. LICENSES-RUST.html формируется cargo-about по Cargo.lock и содержит лицензии Rust-зависимостей. Эти условия сохраняются независимо от MIT-лицензии оболочки. Профили пользователей, кеши и диагностические логи не являются частью поставки.

В Windows отдельный Rust-обновлятор использует ring (Ed25519/SHA-256), ureq/rustls (HTTPS), serde/serde_json, tar и flate2. Его зависимости закреплены в updater/Cargo.lock, лицензии отдельно включаются в LICENSES-UPDATER.html. Эти библиотеки не добавлены в процесс браузера. Нативный загрузчик адаптирован по cefclient_win.cc закреплённого CEF, с сохранением BSD-уведомления.
