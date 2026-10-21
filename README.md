# Liaper — Защищённая платформа групповых звонков для репетиторства (E2EE)

Корпоративная система для индивидуальных и групповых уроков: звонки по `@нику`, пул выделенных медиа-нод с автоматической балансировкой нагрузки, опциональное видео, демонстрация экрана, сквозное шифрование (**End-to-End Encryption**) и встроенный реестр автообновлений для **Windows, Linux и Android**.

---

## Состав проекта

* **`crates/common`** — общие структуры протокола сигналинга, расчёт индекса нагрузки медиа-нод, E2EE-конверты ключей и реестр релизов (`SemVer`).
* **`crates/control-server` (`liaper-control`)** — центральный сервер на **Rust (`Axum` + `Tokio`)**:
  * Регистрация и авторизация пользователей по `@нику`.
  * Каталог публичных ключей `ECDH P-256` для сквозного шифрования.
  * **Балансировщик медиа-нод**: принимает Heartbeat от всех запущенных `liaper-node` и направляет каждый новый звонок на самую свободную ноду.
  * **Реестр релизов и сервер автообновления**:
    * Нативный эндпоинт для **Tauri v2 Updater** (Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`) с проверкой подписи `Ed25519`: `GET /api/releases/tauri/:target/:arch/:current_version`.
    * Эндпоинт проверки обновлений для **Android (Flutter APK)** с проверкой контрольной суммы `SHA-256`: `GET /api/releases/check?platform=android-arm64&version=0.1.0`.
    * Публикация новых сборок: `POST /api/releases/publish` и раздача пакетов из папки `./releases/`.
* **`crates/media-node` (`liaper-node`)** — отдельный бинарник SFU-медиа-ноды на **Rust**:
  * Маршрутизирует WebRTC-звонки и зашифрованные `AES-256-GCM` медиа-фреймы между участниками комнаты без доступа к ключам расшифровки.
  * Каждые 2 секунды отправляет метрики нагрузки (`CPU`, `RAM`, число пиров, битрейт) на `liaper-control`.
* **`clients/web-desktop`** — единый клиент для **Браузера, Windows и Linux** (`React 19` + `TypeScript` + `Tailwind CSS` + `Tauri v2`).
* **`clients/android`** — мобильный клиент для **Android** (`Flutter`) со сквозным шифрованием и модулем безопасного автообновления APK.

---

## Быстрый старт

### Вариант 1: Запуск всего кластера одной командой (Windows)
```powershell
.\start-cluster.bat
```
*(либо через PowerShell с обходом политики скриптов: `powershell -ExecutionPolicy Bypass -File .\start-cluster.ps1`)*

### Вариант 2: Ручной запуск по компонентам

1. **Центральный сервер (`http://127.0.0.1:4000`)**:
   ```powershell
   cargo run -p liaper-control-server
   ```
2. **Медиа-нода #1 (`ws://127.0.0.1:4101/ws/sfu`)**:
   ```powershell
   cargo run -p liaper-media-node
   ```
3. **Медиа-нода #2 (для проверки балансировки нагрузки на порту `4102`)**:
   ```powershell
   $env:NODE_PORT="4102"; $env:NODE_ID="node-ru-2"; $env:NODE_NAME="SFU Node #2"; cargo run -p liaper-media-node
   ```
4. **Веб / Десктоп клиент (`http://localhost:5173`)**:
   ```powershell
   cd clients\web-desktop
   npm.cmd run dev
   ```
