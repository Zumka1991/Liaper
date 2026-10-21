use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub mod file_storage;

// ============================================================================
// 1. Пользователи, Профили и Публичные Ключи E2EE
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UserRole {
    Tutor,
    Student,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPublicProfile {
    pub id: Uuid,
    /// Уникальный ник для звонков (например: "elena_math" -> @elena_math)
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    /// Публичный ключ ECDH P-256 (в формате Base64 SPKI / JWK) для E2EE обмена ключами
    pub e2ee_public_key: String,
    /// Отпечаток публичного ключа для визуальной сверки безопасности
    pub key_fingerprint: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub role: UserRole,
    pub e2ee_public_key: String,
    pub key_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    /// Возможность обновить публичный ключ устройства при входе
    pub e2ee_public_key: Option<String>,
    pub key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserPublicProfile,
}

// ============================================================================
// 2. Медиа-ноды (Data Plane / SFU) и Балансировка Нагрузки
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaNodeHeartbeat {
    pub node_id: String,
    pub name: String,
    pub region: String,
    /// Публичный WebSocket адрес ноды для подключения клиентов к SFU
    pub ws_url: String,
    /// Внутренний или внешний HTTP адрес ноды
    pub http_url: String,
    pub active_rooms: u32,
    pub active_peers: u32,
    pub max_peers: u32,
    pub cpu_usage_percent: f32,
    pub memory_usage_percent: f32,
    pub bandwidth_mbps: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaNodeInfo {
    pub node_id: String,
    pub name: String,
    pub region: String,
    pub ws_url: String,
    pub http_url: String,
    pub active_rooms: u32,
    pub active_peers: u32,
    pub max_peers: u32,
    pub cpu_usage_percent: f32,
    pub memory_usage_percent: f32,
    pub bandwidth_mbps: f32,
    pub healthy: bool,
    pub load_score: f32,
    pub last_seen: DateTime<Utc>,
}

impl MediaNodeInfo {
    /// Вычисляет интегральный индекс нагрузки от 0.0 (полностью свободна) до 100.0 (перегружена).
    /// Балансировщик направляет звонок на ноду с минимальным `load_score`.
    pub fn compute_load_score(
        active_peers: u32,
        max_peers: u32,
        cpu_usage_percent: f32,
        memory_usage_percent: f32,
    ) -> f32 {
        let capacity_ratio = if max_peers > 0 {
            (active_peers as f32 / max_peers as f32) * 100.0
        } else {
            100.0
        };
        // Взвешенная оценка: 50% заполненность слотов звонков, 35% CPU, 15% RAM
        let score = (capacity_ratio * 0.50)
            + (cpu_usage_percent.clamp(0.0, 100.0) * 0.35)
            + (memory_usage_percent.clamp(0.0, 100.0) * 0.15);
        (score * 10.0).round() / 10.0
    }
}

// ============================================================================
// 3. E2EE Конверты Ключей и Зашифрованный Чат
// ============================================================================

/// Конверт с симметричным ключом комнаты (AES-256-GCM),
/// зашифрованный через ECDH персонально для конкретного участника.
/// Центральный сервер и медиа-нода не могут его расшифровать.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct E2eeKeyEnvelope {
    pub room_id: Uuid,
    pub sender_id: Uuid,
    pub sender_username: String,
    pub sender_public_key: String,
    pub recipient_id: Uuid,
    pub recipient_username: String,
    /// Зашифрованный симметричный ключ комнаты в Base64
    pub encrypted_room_key_b64: String,
    /// Вектор инициализации AES-GCM в Base64
    pub iv_b64: String,
    /// Контрольный отпечаток ключа комнаты (первые 8 байт SHA-256)
    pub room_key_id: String,
}

/// Зашифрованное End-to-End сообщение чата (в комнате или личном вызове)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedChatMessage {
    pub id: Uuid,
    pub room_id: Uuid,
    pub sender_id: Uuid,
    pub sender_username: String,
    pub sender_display_name: String,
    /// Шифротекст сообщения (AES-256-GCM) в Base64
    pub ciphertext_b64: String,
    /// IV для AES-256-GCM в Base64
    pub iv_b64: String,
    /// Идентификатор ключа комнаты, которым зашифровано сообщение
    pub room_key_id: String,
    pub created_at: DateTime<Utc>,
}

// ============================================================================
// 4. Комнаты для Уроков / Групповых Звонков
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomParticipantState {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: UserRole,
    pub e2ee_public_key: String,
    pub key_fingerprint: String,
    pub audio_enabled: bool,
    pub video_enabled: bool,
    pub screen_share_enabled: bool,
    pub speaking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomInfo {
    pub id: Uuid,
    pub title: String,
    pub host_id: Uuid,
    pub host_username: String,
    /// Выделенная для этой комнаты наиболее свободная медиа-нода
    pub assigned_node: MediaNodeInfo,
    pub participants: Vec<RoomParticipantState>,
    pub created_at: DateTime<Utc>,
}

/// Заявка на взаимное добавление в контакты
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactRequestInfo {
    pub id: Uuid,
    pub from_user: UserPublicProfile,
    pub to_user: UserPublicProfile,
    pub created_at: DateTime<Utc>,
}

// ============================================================================
// 5. Протокол WebSocket: Клиент <-> Центральный сервер (Control Plane)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ClientToControlMsg {
    /// Отправить заявку на добавление в контакты по @нику
    SendContactRequest {
        target_username: String,
    },
    /// Принять или отклонить входящую заявку в контакты
    RespondContactRequest {
        request_id: Uuid,
        accept: bool,
    },
    /// Удалить пользователя из взаимных контактов
    RemoveContact {
        contact_user_id: Uuid,
    },
    /// Создать новую комнату для урока (только для пользователей из взаимных контактов)
    CreateRoom {
        title: String,
        invited_usernames: Vec<String>,
        preferred_region: Option<String>,
    },
    /// Позвонить напрямую по @нику (разрешено только подтверждённым контактам)
    CallByNick {
        target_username: String,
        with_video: bool,
    },
    /// Пригласить ещё одного ученика по @нику в уже идущий групповой звонок
    InviteByNick {
        room_id: Uuid,
        target_username: String,
    },
    /// Принять или присоединиться к комнате
    JoinRoom {
        room_id: Uuid,
        audio_enabled: bool,
        video_enabled: bool,
    },
    /// Отклонить входящий звонок
    DeclineCall {
        room_id: Uuid,
        reason: Option<String>,
    },
    /// Покинуть текущий звонок
    LeaveRoom {
        room_id: Uuid,
    },
    /// Обновить статус микрофона / камеры / демонстрации экрана
    UpdateMediaState {
        room_id: Uuid,
        audio_enabled: bool,
        video_enabled: bool,
        screen_share_enabled: bool,
        speaking: bool,
    },
    /// Переслать зашифрованный ключ комнаты (E2EE) участнику
    SendKeyEnvelope {
        envelope: E2eeKeyEnvelope,
    },
    /// Отправить зашифрованное (E2EE) сообщение в чат комнаты
    SendEncryptedChat {
        room_id: Uuid,
        ciphertext_b64: String,
        iv_b64: String,
        room_key_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ControlToClientMsg {
    /// Начальная синхронизация состояния при подключении
    Welcome {
        self_profile: UserPublicProfile,
        contacts: Vec<UserPublicProfile>,
        incoming_requests: Vec<ContactRequestInfo>,
        outgoing_requests: Vec<ContactRequestInfo>,
        active_rooms: Vec<RoomInfo>,
        media_nodes: Vec<MediaNodeInfo>,
    },
    /// Обновление списка взаимных контактов и заявок пользователя
    ContactsUpdated {
        contacts: Vec<UserPublicProfile>,
        incoming_requests: Vec<ContactRequestInfo>,
        outgoing_requests: Vec<ContactRequestInfo>,
    },
    /// Обновление списка пользователей и их онлайн-статуса
    DirectoryUpdated {
        users: Vec<UserPublicProfile>,
    },
    /// Обновление метрик пула медиа-нод в реальном времени
    NodesUpdated {
        nodes: Vec<MediaNodeInfo>,
    },
    /// Комната создана или обновлена (содержит адрес назначенной медиа-ноды!)
    RoomUpdated {
        room: RoomInfo,
    },
    /// Входящий звонок по @нику или приглашение на урок
    IncomingCall {
        room: RoomInfo,
        caller: UserPublicProfile,
        with_video: bool,
    },
    /// Абонент отклонил вызов
    CallDeclined {
        room_id: Uuid,
        declined_by: String,
        reason: Option<String>,
    },
    /// Доставка зашифрованного E2EE ключа комнаты от хоста/участника
    KeyEnvelopeReceived {
        envelope: E2eeKeyEnvelope,
    },
    /// Новое зашифрованное сообщение в чате комнаты
    EncryptedChatReceived {
        message: EncryptedChatMessage,
    },
    /// История зашифрованных сообщений при входе в комнату
    RoomChatHistory {
        room_id: Uuid,
        messages: Vec<EncryptedChatMessage>,
    },
    /// Ошибка операции
    Error {
        message: String,
    },
}

// ============================================================================
// 6. Протокол WebSocket: Клиент <-> Медиа-нода (Data Plane / SFU)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum ClientToNodeMsg {
    /// Подключиться к медиа-комнате на выбранной SFU-ноде
    JoinSfuRoom {
        room_id: Uuid,
        user_id: Uuid,
        username: String,
        display_name: String,
        /// Индикатор активного E2EE фреймов (WebRTC Encoded Transform / SFrame)
        e2ee_enabled: bool,
        room_key_id: String,
    },
    /// Прямая или SFU-маршрутизируемая SDP Offer
    SignalSdpOffer {
        room_id: Uuid,
        target_peer_id: Option<Uuid>,
        sdp: String,
    },
    /// SDP Answer
    SignalSdpAnswer {
        room_id: Uuid,
        target_peer_id: Option<Uuid>,
        sdp: String,
    },
    /// ICE Candidate
    SignalIceCandidate {
        room_id: Uuid,
        target_peer_id: Option<Uuid>,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    },
    /// Зашифрованный медиа-чанк (аудио/видео фрейм E2EE для гарантированной доставки через SFU)
    EncryptedMediaFrame {
        room_id: Uuid,
        kind: String, // "audio" | "video" | "screen"
        ciphertext_b64: String,
        iv_b64: String,
        room_key_id: String,
        timestamp_ms: u64,
    },
    /// Выход из SFU-ноды
    LeaveSfuRoom {
        room_id: Uuid,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum NodeToClientMsg {
    /// Подтверждение входа на медиа-ноду со списком уже подключённых пиров
    SfuRoomJoined {
        node_id: String,
        node_name: String,
        room_id: Uuid,
        existing_peers: Vec<SfuPeerSummary>,
        ice_servers: Vec<IceServerConfig>,
    },
    /// Новый участник подключился к медиа-ноде
    PeerJoinedSfu {
        room_id: Uuid,
        peer: SfuPeerSummary,
    },
    /// Участник покинул медиа-ноду
    PeerLeftSfu {
        room_id: Uuid,
        user_id: Uuid,
    },
    /// Пересылка SDP Offer от SFU или пира через медиа-ноду
    RelayedSdpOffer {
        room_id: Uuid,
        from_peer_id: Uuid,
        from_username: String,
        sdp: String,
    },
    /// Пересылка SDP Answer
    RelayedSdpAnswer {
        room_id: Uuid,
        from_peer_id: Uuid,
        sdp: String,
    },
    /// Пересылка ICE Candidate
    RelayedIceCandidate {
        room_id: Uuid,
        from_peer_id: Uuid,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
    },
    /// Пересылка зашифрованного E2EE медиа-фрейма от SFU-ноды остальным участникам комнаты
    RelayedEncryptedMediaFrame {
        room_id: Uuid,
        from_peer_id: Uuid,
        from_username: String,
        kind: String,
        ciphertext_b64: String,
        iv_b64: String,
        room_key_id: String,
        timestamp_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SfuPeerSummary {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub e2ee_enabled: bool,
    pub room_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

// ============================================================================
// 7. Реестр Приложений и Автообновление (Windows, Linux, Android)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AppPlatform {
    WindowsX86_64,
    LinuxX86_64,
    AndroidArm64,
    AndroidUniversal,
    Web,
}

impl AppPlatform {
    pub fn as_str(&self) -> &'static str {
        match self {
            AppPlatform::WindowsX86_64 => "windows-x86_64",
            AppPlatform::LinuxX86_64 => "linux-x86_64",
            AppPlatform::AndroidArm64 => "android-arm64",
            AppPlatform::AndroidUniversal => "android-universal",
            AppPlatform::Web => "web",
        }
    }
}

/// Запись о выпущенной версии клиента в реестре релизов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppReleaseManifest {
    pub platform: AppPlatform,
    /// Семантическая версия, например "0.2.0"
    pub version: String,
    /// Номер сборки (актуально для Android versionCode)
    pub build_number: u32,
    /// Описание изменений для пользователя
    pub release_notes: String,
    /// Прямая ссылка на скачивание (.msi / .exe / .AppImage / .deb / .apk)
    pub download_url: String,
    /// Контрольная сумма SHA-256 файла для проверки целостности перед установкой
    pub sha256: String,
    /// Криптографическая подпись Ed25519 (для безопасного автообновления Tauri v2 и Android)
    pub signature: String,
    /// Размер файла в байтах
    pub file_size_bytes: u64,
    /// Обязательное ли обновление (например, при смене протокола E2EE)
    pub mandatory: bool,
    pub published_at: DateTime<Utc>,
}

/// Ответ на проверку обновления (универсальный для Android/Desktop/UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResponse {
    pub update_available: bool,
    pub current_version: String,
    pub latest: Option<AppReleaseManifest>,
}

/// Специфичный формат ответа для встроенного Tauri v2 Updater
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TauriUpdaterResponse {
    pub version: String,
    pub notes: String,
    pub pub_date: DateTime<Utc>,
    pub url: String,
    pub signature: String,
}

/// Запрос на публикацию новой версии в реестр релизов
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishReleaseRequest {
    pub admin_secret: String,
    pub manifest: AppReleaseManifest,
}

/// Сравнение версий SemVer ("0.2.0" > "0.1.9")
pub fn is_version_newer(current: &str, candidate: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let cur = parse(current);
    let cand = parse(candidate);
    let max_len = cur.len().max(cand.len());
    for i in 0..max_len {
        let a = *cur.get(i).unwrap_or(&0);
        let b = *cand.get(i).unwrap_or(&0);
        if b > a {
            return true;
        }
        if b < a {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_score_calculation() {
        let free_node_score = MediaNodeInfo::compute_load_score(0, 100, 5.0, 20.0);
        let busy_node_score = MediaNodeInfo::compute_load_score(60, 100, 75.0, 60.0);

        assert!(free_node_score < busy_node_score);
        assert_eq!(free_node_score, 4.8);
    }

    #[test]
    fn test_semver_comparison() {
        assert!(is_version_newer("0.1.0", "0.1.1"));
        assert!(is_version_newer("0.1.9", "0.2.0"));
        assert!(!is_version_newer("0.2.0", "0.2.0"));
        assert!(!is_version_newer("0.3.0", "0.2.9"));
    }
}
