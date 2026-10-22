# Liaper — Защищённая платформа групповых звонков для репетиторства (E2EE)

Корпоративная система для индивидуальных и групповых уроков: звонки по `@нику`, взаимные контакты, прямые личные сообщения контактам, архив чатов уроков, пул выделенных медиа-нод с автоматической балансировкой нагрузки, HD-видео и демонстрация экрана, сквозное шифрование (**End-to-End Encryption**) и встроенный реестр автообновлений для **Windows, Linux и Android**.

---

## Состав проекта

* **`crates/common`** — общие структуры протокола сигналинга, расчёт индекса нагрузки медиа-нод, E2EE-конверты ключей и реестр релизов (`SemVer`).
* **`crates/control-server` (`liaper-control`)** — центральный сервер на **Rust (`Axum` + `Tokio` + `PostgreSQL`)**:
  * Регистрация и авторизация пользователей по `@нику` с хранением в **PostgreSQL** (и автоматическим локальным резервом в `./data/*.json` при запуске без БД).
  * Система взаимных контактов (`send_contact_request`, `respond_contact_request`, `remove_contact`).
  * Прямые чаты между контактами и чаты уроков с сохранением истории переписок в PostgreSQL.
  * Каталог публичных ключей `ECDH P-256` для сквозного шифрования.
  * **Балансировщик медиа-нод**: принимает Heartbeat от всех запущенных `liaper-node` и направляет каждый новый звонок на самую свободную ноду.
  * **Реестр релизов и сервер автообновления**:
    * Нативный эндпоинт для **Tauri v2 Updater** (Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`) с проверкой подписи `Ed25519`: `GET /api/releases/tauri/:target/:arch/:current_version`.
    * Эндпоинт проверки обновлений для **Android (Flutter APK)** с проверкой контрольной суммы `SHA-256`: `GET /api/releases/check?platform=android-arm64&version=0.1.0`.
* **`crates/media-node` (`liaper-node`)** — отдельный бинарник SFU-медиа-ноды на **Rust**:
  * Маршрутизирует WebRTC-звонки и зашифрованные `AES-256-GCM` медиа-фреймы между участниками комнаты без доступа к ключам расшифровки.
  * Каждые 2 секунды отправляет метрики нагрузки (`CPU`, `RAM`, число пиров, битрейт) на `liaper-control`.
* **`clients/web-desktop`** — единый клиент для **Браузера, Windows и Linux** (`React 19` + `TypeScript` + `Tailwind CSS` + `Tauri v2`).
* **`clients/android`** — мобильный клиент для **Android** (`Flutter` + нативный `AudioRecord`/`AudioTrack` + `Camera`).
* **`docker/init.sql` & `docker-compose.yml`** — конфигурация кластера в Docker с базой данных **PostgreSQL 16**.

---

## Продакшн

Боевой запуск с TLS (Caddy), обязательные секреты, изменения безопасности и оставшиеся задачи — в [docs/PRODUCTION.md](docs/PRODUCTION.md). Шаблон переменных — `.env.example`.

```bash
docker compose --profile tls up -d --build
```

## Развёртывание в Docker (PostgreSQL + Кластер + Web)

Весь стек (`postgres:16-alpine`, `liaper-control`, `liaper-node-1`, `liaper-node-2`, `liaper-web`) поднимается одной командой:

```bash
docker compose up -d --build
```

Перед запуском заполните `.env` по образцу `.env.example` (`POSTGRES_PASSWORD`, `LIAPER_STORAGE_SECRET`, `LIAPER_NODE_SECRET` обязательны). Порты сервисов открыты только на `127.0.0.1`.

* **Веб-интерфейс**: `http://localhost:5173`
* **Control Server API & WS**: `http://localhost:4000`
* **SFU Media Nodes**: `ws://localhost:4101/ws/sfu`, `ws://localhost:4102/ws/sfu`
* **PostgreSQL 16**: `localhost:5432` (БД `liaper`, схема автоматически инициализируется из `docker/init.sql`)

---

## Быстрый старт (Локальная разработка на Windows)

### Вариант 1: Запуск всего кластера одной командой
```powershell
.\start-cluster.bat
```
Для открытия отдельного окна десктопного клиента:
```powershell
.\start-desktop.bat
```
Или сборка нативного инсталлятора Tauri (`.msi` / `.exe`):
```powershell
cd clients\web-desktop
npm.cmd run tauri:dev
# Для релизной сборки:
npm.cmd run tauri:build
```

### Вариант 2: Ручной запуск по компонентам

1. **Центральный сервер (`http://127.0.0.1:4000`)**:
   ```powershell
   # Опционально: $env:DATABASE_URL="postgres://liaper:liaper_secret_password@localhost:5432/liaper"
   cargo run -p liaper-control-server
   ```
2. **Медиа-нода #1 (`ws://127.0.0.1:4101/ws/sfu`)**:
   ```powershell
   cargo run -p liaper-media-node
   ```
3. **Медиа-нода #2 (на порту `4102`)**:
   ```powershell
   $env:NODE_PORT="4102"; $env:NODE_ID="node-ru-2"; $env:NODE_NAME="SFU Node #2"; cargo run -p liaper-media-node
   ```
4. **Веб / Десктоп клиент (`http://localhost:5173`)**:
   ```powershell
   cd clients\web-desktop
   npm.cmd run dev
   ```


## Интерфейс и результаты аудита

Обновлены Web/Desktop и Android: адаптивная навигация, состояния подключения, формы входа, поведение чатов и управление медиа. Подробности и открытые риски — в [UX/UI-аудите](docs/UX_UI_AUDIT.md).

В Docker Web-клиент обращается к API через свой origin: nginx проксирует `/api/`, `/ws` и `/releases/` на `liaper-control`. `VITE_CONTROL_URL` можно задать при сборке для отдельного сервера. В режиме Vite используется порт 4000 текущего хоста; Desktop по умолчанию подключается к локальному серверу.

Публикация релизов по API отключена, пока на сервере не задан непустой `LIAPER_ADMIN_SECRET`. Установите собственный секрет в окружении сервера или `.env` Docker Compose; клиенту этот секрет не передаётся.

Новые локальные архивы разделены по аккаунтам. Старые общие архивы остаются в хранилище устройства; автоматического переноса без подтверждённого владельца нет.

Проверки:

```powershell
cargo test --workspace
cd clients/web-desktop
npm.cmd ci
npm.cmd run build
npm.cmd run tauri:build -- --debug --no-bundle
```

Для Android: `flutter analyze`, `flutter test`, `flutter build apk --debug` из `clients/android`.

Заявленное в первоначальном описании E2EE сейчас не обеспечено полностью: медиа передаются без сквозного шифрования, а ключи чатов выводятся из ID комнаты. Перед использованием с реальными занятиями требуется исправить протокол и контроль доступа; детали приведены в аудите.


## Хранение и правила контактов

Локальная PostgreSQL установлена в `data/postgres`; секреты подключения находятся в игнорируемой `.env`. Для повторного запуска используйте `./start-cluster.ps1`. Скрипт запускает также файловую ноду на порту 4201. Перед сборкой с `-Build` остановите запущенные бинарники.

Файловое хранилище принимает зашифрованные блобы: до 5 ГиБ на аккаунт, до 128 МиБ на файл, один календарный месяц хранения. Занятое место видно в настройках Web/Windows и профиле Android. API, конфигурация нескольких нод, проверки и границы готовности клиентов описаны в [docs/FILE_STORAGE.md](docs/FILE_STORAGE.md).

Приглашение в контакты отправляет преподаватель ученику. У преподавателя может быть до 10 подтверждённых учеников; проверка последнего места выполняется атомарно в PostgreSQL. Ученик принимает или отклоняет приглашение. Удаление контакта освобождает место; существующие контакты автоматически не удаляются.

Архивы уроков шифруются на клиентах и синхронизируются с PostgreSQL. При восстановленной сессии разблокируйте архив паролем аккаунта. Полный аудит оставшихся проблем безопасности приведён в [docs/UX_UI_AUDIT.md](docs/UX_UI_AUDIT.md).
