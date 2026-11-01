# Публикация alpha.8 — 2026-11-01

По явному разрешению владельца опубликован полный Windows x64 установщик.

- Релиз: https://github.com/SargeMadovsky/ChroMinimum/releases/tag/v0.0.1-alpha.8
- Исходники релиза: commit 4331e77 (включает сохранённый remote commit 2bbab9b).
- Установщик: ChroMinimum-0.0.1-alpha.8-setup-x64.exe, 157810270 байт.
- SHA256: `84449e82cf9e54633693c6cfc78bcaebfd5bf3d8d57abdae47bf66d176d87299`.
- GitHub API подтвердил тот же digest; опубликовано 11 файлов, включая лицензии, суммы и архивы исходных материалов.
- Сайт: https://chrominimum.download/ и /en/, repository SargeMadovsky/chrominimum-website, commit 194d8e4.
- 8 тестов выбора релизов/платформ/RU/EN/fallback прошли; JS syntax check прошёл.

Это полный установщик с новым adapter seed, не публикация подписанного пакета
обновления одного ядра. Существующий core channel не изменялся. Linux/macOS
сохраняют предыдущие доступные версии. Authenticode подписи нет.

Файлы локального release package и их manifest сохранены без изменения:
статус local/not_published в них описывает момент упаковки. Текущий факт
публикации фиксируется этим документом и публичным GitHub Release.
Проверки поведения и ограничения: [release notes](RELEASE_ALPHA8_20261101.md).
