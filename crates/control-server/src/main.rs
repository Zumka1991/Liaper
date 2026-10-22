mod antifraud;
mod archives;
mod attachments;
#[cfg(test)]
mod persistence_tests;
mod pow;
mod push;
mod state;
mod ws;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use liaper_common::{
    is_version_newer, AppPlatform, AppReleaseManifest, AuthResponse, ControlToClientMsg,
    LoginRequest, MediaNodeHeartbeat, MediaNodeInfo, PublishReleaseRequest, RegisterRequest,
    TauriUpdaterResponse, UpdateCheckResponse, UserPublicProfile,
};
use serde::Deserialize;
use tower_http::{cors::CorsLayer, services::ServeDir};
use tracing::info;
use uuid::Uuid;

use crate::state::{ChatAbuseReport, ControlState, DisclosedRoomKey, StoredUser};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "liaper_control=info,tower_http=info".into()),
        )
        .init();

    let port: u16 = std::env::var("CONTROL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4000);

    let storage_path = PathBuf::from("data/users.json");
    let _ = std::fs::create_dir_all("releases");
    let state = ControlState::new(storage_path);
    if let Ok(db_url) = std::env::var("DATABASE_URL") {
        state.init_postgres(&db_url).await?;
    }

    let app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/admin/auth-status", get(admin_auth_status_handler))
        .route(
            "/api/admin/setup-password",
            post(admin_setup_password_handler),
        )
        .route("/api/admin/overview", get(admin_overview_handler))
        .route(
            "/api/admin/antifraud/unblock",
            post(admin_unblock_subject_handler),
        )
        .route(
            "/api/admin/antifraud/quarantine",
            post(admin_manual_quarantine_handler),
        )
        .route("/api/reports", post(submit_report_handler))
        .route("/api/admin/reports/:id/resolve", post(resolve_report_handler))
        .route("/api/storage/usage", get(attachments::usage))
        .route("/api/storage/committed", post(attachments::node_commit))
        .route("/api/attachments", post(attachments::reserve))
        .route("/api/attachments/:id/complete", post(attachments::complete))
        .route("/api/attachments/:id/download", get(attachments::download))
        .route("/api/lesson-archives", get(archives::list))
        .route("/api/lesson-archives/unlock", post(archives::unlock))
        .route(
            "/api/lesson-archives/:archive_id",
            axum::routing::put(archives::put),
        )
        // Авторизация и каталог @ников
        .route("/api/auth/challenge", get(pow_challenge_handler))
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/rooms/:id/sfu-ticket", post(sfu_ticket_handler))
        .route("/api/users", get(list_users_handler))
        .route("/api/users/search", get(search_users_handler))
        // Балансировщик и реестр медиа-нод
        .route("/api/nodes", get(list_nodes_handler))
        .route("/api/nodes/heartbeat", post(node_heartbeat_handler))
        // Реестр релизов и автообновление (Windows, Linux, Android)
        .route("/api/releases", get(list_releases_handler))
        .route("/api/releases/check", get(check_update_handler))
        .route(
            "/api/releases/tauri/:target/:arch/:current_version",
            get(tauri_updater_handler),
        )
        .route("/api/releases/publish", post(publish_release_handler))
        // Сигналинг и E2EE чат в реальном времени
        .route("/ws", get(ws_upgrade_handler))
        // Статическая раздача бинарников обновлений (.exe, .msi, .AppImage, .deb, .apk)
        .nest_service("/releases", ServeDir::new("releases"))
        .layer(cors_layer())
        .with_state(state);

    if liaper_common::sfu_access::node_secret_from_env().is_none() {
        tracing::warn!("LIAPER_NODE_SECRET не задан (>= 32 символов): heartbeat медиа-нод и вход в SFU не защищены. Только для разработки!");
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Liaper Control Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

/// `LIAPER_ALLOWED_ORIGINS=https://app.example.com,tauri://localhost` ограничивает CORS.
/// Без переменной сервер работает в режиме разработки и разрешает любой origin.
fn cors_layer() -> CorsLayer {
    use axum::http::{header, HeaderValue, Method};
    let origins: Vec<HeaderValue> = std::env::var("LIAPER_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    if origins.is_empty() {
        tracing::warn!("LIAPER_ALLOWED_ORIGINS не задан: CORS разрешён для любых источников");
        return CorsLayer::permissive();
    }
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-admin-password-b64"),
        ])
}

async fn health_handler(State(state): State<Arc<ControlState>>) -> Json<serde_json::Value> {
    let database_connected = state
        .pg_client
        .read()
        .await
        .as_ref()
        .is_some_and(|client| !client.is_closed());
    Json(serde_json::json!({
        "status": "ok",
        "service": "liaper-control-server",
        "storage": if database_connected { "postgresql" } else { "json" },
        "database_connected": database_connected,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

fn verify_admin_user(
    state: &ControlState,
    headers: &axum::http::HeaderMap,
) -> Result<StoredUser, archives::ApiError> {
    let user_id = archives::owner(state, headers)?;
    let user = state
        .users_by_id
        .get(&user_id)
        .map(|u| u.value().clone())
        .ok_or_else(|| archives::error(StatusCode::UNAUTHORIZED, "Пользователь не найден"))?;
    if !state.is_admin_username(&user.username) {
        return Err(archives::error(
            StatusCode::FORBIDDEN,
            "Доступ к админке разрешён только владельцу системы (@napsy)",
        ));
    }
    Ok(user)
}

fn extract_admin_password(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(b64_val) = headers
        .get("x-admin-password-b64")
        .and_then(|v| v.to_str().ok())
    {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        if let Ok(bytes) = BASE64.decode(b64_val.trim()) {
            if let Ok(decoded) = String::from_utf8(bytes) {
                return Some(decoded);
            }
        }
    }
    headers
        .get("x-admin-password")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

async fn require_admin_access(
    state: &ControlState,
    headers: &axum::http::HeaderMap,
) -> Result<StoredUser, archives::ApiError> {
    let user = verify_admin_user(state, headers)?;
    let subj_key = format!("user:{}", user.id);
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        return Err(archives::error(StatusCode::TOO_MANY_REQUESTS, &msg));
    }
    if !state.is_admin_password_configured() {
        return Err(archives::error(
            StatusCode::PRECONDITION_REQUIRED,
            "Сначала задайте мастер-пароль администратора",
        ));
    }
    let provided = extract_admin_password(headers).ok_or_else(|| {
        archives::error(
            StatusCode::UNAUTHORIZED,
            "Введите мастер-пароль администратора",
        )
    })?;
    if !state.verify_admin_password(&provided) {
        state
            .antifraud
            .record_violation(
                &subj_key,
                Some(user.id),
                Some(user.username.clone()),
                None,
                "auth_bruteforce",
                antifraud::IncidentSeverity::Medium,
                30,
                "Неверный мастер-пароль при входе в Админку".into(),
                300,
            )
            .await;
        return Err(archives::error(
            StatusCode::UNAUTHORIZED,
            "Неверный мастер-пароль администратора",
        ));
    }
    Ok(user)
}

async fn admin_auth_status_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let user = verify_admin_user(&state, &headers)?;
    Ok(Json(serde_json::json!({
        "is_admin": true,
        "username": user.username,
        "password_configured": state.is_admin_password_configured(),
    })))
}

#[derive(Deserialize)]
struct AdminSetupPasswordRequest {
    current_password: Option<String>,
    new_password: String,
}

async fn admin_setup_password_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<AdminSetupPasswordRequest>,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let user = verify_admin_user(&state, &headers)?;
    let subj_key = format!("user:{}", user.id);
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        return Err(archives::error(StatusCode::TOO_MANY_REQUESTS, &msg));
    }
    let clean_new = req.new_password.trim();
    if clean_new.chars().count() < 12 || clean_new.len() > 128 {
        return Err(archives::error(
            StatusCode::BAD_REQUEST,
            "Мастер-пароль должен содержать от 12 до 128 символов",
        ));
    }
    if state.is_admin_password_configured() {
        let cur = req.current_password.as_deref().unwrap_or("");
        if !state.verify_admin_password(cur) {
            state
                .antifraud
                .record_violation(
                    &subj_key,
                    Some(user.id),
                    Some(user.username.clone()),
                    None,
                    "auth_bruteforce",
                    antifraud::IncidentSeverity::Medium,
                    30,
                    "Неверный текущий мастер-пароль при попытке смены пароля Админки".into(),
                    300,
                )
                .await;
            return Err(archives::error(
                StatusCode::UNAUTHORIZED,
                "Неверный текущий мастер-пароль",
            ));
        }
    }
    state.set_admin_password(clean_new);
    Ok(Json(serde_json::json!({
        "status": "ok",
        "password_configured": true,
    })))
}

async fn admin_overview_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let _admin = require_admin_access(&state, &headers).await?;
    let pg = state.pg_client.read().await.clone().filter(|c| !c.is_closed());
    let database_connected = pg.is_some();

    let mut per_user_storage: std::collections::HashMap<Uuid, (i64, i64)> =
        std::collections::HashMap::new();
    let mut per_user_archives: std::collections::HashMap<Uuid, i64> =
        std::collections::HashMap::new();
    let mut total_attachments_ready: i64 = 0;
    let mut total_attachments_pending: i64 = 0;
    let mut total_attachments_bytes: i64 = 0;
    let mut total_lesson_archives: i64 = 0;

    if let Some(ref db) = pg {
        if let Ok(row) = db
            .query_one(
                "SELECT \
                    COALESCE(COUNT(*) FILTER (WHERE state='ready' AND expires_at > NOW()), 0)::BIGINT, \
                    COALESCE(COUNT(*) FILTER (WHERE state='pending' AND reservation_until > NOW()), 0)::BIGINT, \
                    COALESCE(SUM(size_bytes) FILTER (WHERE state='ready' AND expires_at > NOW()), 0)::BIGINT \
                 FROM file_attachments",
                &[],
            )
            .await
        {
            total_attachments_ready = row.get(0);
            total_attachments_pending = row.get(1);
            total_attachments_bytes = row.get(2);
        }

        if let Ok(rows) = db
            .query(
                "SELECT owner_id, \
                    COALESCE(SUM(size_bytes) FILTER (WHERE state='ready' AND expires_at > NOW()), 0)::BIGINT, \
                    COALESCE(COUNT(*) FILTER (WHERE state='ready' AND expires_at > NOW()), 0)::BIGINT \
                 FROM file_attachments GROUP BY owner_id",
                &[],
            )
            .await
        {
            for r in rows {
                let uid: Uuid = r.get(0);
                let bytes: i64 = r.get(1);
                let cnt: i64 = r.get(2);
                per_user_storage.insert(uid, (bytes, cnt));
            }
        }

        if let Ok(rows) = db
            .query(
                "SELECT user_id, COUNT(*)::BIGINT FROM lesson_archives GROUP BY user_id",
                &[],
            )
            .await
        {
            for r in rows {
                let uid: Uuid = r.get(0);
                let cnt: i64 = r.get(1);
                total_lesson_archives += cnt;
                per_user_archives.insert(uid, cnt);
            }
        }
    }

    let file_node_url = std::env::var("FILE_NODE_PUBLIC_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4201".to_string());
    let file_node_internal = std::env::var("FILE_NODE_INTERNAL_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4201".to_string());
    let file_node_online = reqwest::Client::new()
        .get(format!("{}/health", file_node_internal.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());

    let mut users_list = Vec::new();
    let mut online_users = 0usize;
    let mut tutors_count = 0usize;
    let mut students_count = 0usize;
    let mut active_ws_connections = 0usize;

    for entry in state.users_by_id.iter() {
        let u = entry.value();
        let ws_sessions = state
            .sessions
            .get(&u.id)
            .map(|s| s.value().len())
            .unwrap_or(0);
        let is_online = ws_sessions > 0;
        if is_online {
            online_users += 1;
        }
        active_ws_connections += ws_sessions;
        match u.role {
            liaper_common::UserRole::Tutor => tutors_count += 1,
            liaper_common::UserRole::Student => students_count += 1,
        }
        let contacts_count = state
            .contacts_by_user
            .get(&u.id)
            .map(|c| c.value().len())
            .unwrap_or(0);
        let (used_bytes, files_count) = per_user_storage.get(&u.id).copied().unwrap_or((0, 0));
        let archives_count = per_user_archives.get(&u.id).copied().unwrap_or(0);

        users_list.push(serde_json::json!({
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "role": u.role,
            "online": is_online,
            "ws_sessions": ws_sessions,
            "contacts_count": contacts_count,
            "key_fingerprint": u.key_fingerprint,
            "storage_used_bytes": used_bytes,
            "storage_quota_bytes": attachments::USER_QUOTA_BYTES,
            "attachments_count": files_count,
            "archives_count": archives_count,
        }));
    }

    users_list.sort_by(|a, b| {
        let ao = a["online"].as_bool().unwrap_or(false);
        let bo = b["online"].as_bool().unwrap_or(false);
        bo.cmp(&ao).then_with(|| {
            a["username"]
                .as_str()
                .unwrap_or("")
                .cmp(b["username"].as_str().unwrap_or(""))
        })
    });

    let mut total_contact_links = 0usize;
    for entry in state.contacts_by_user.iter() {
        total_contact_links += entry.value().len();
    }
    let confirmed_contact_pairs = total_contact_links / 2;
    let pending_contact_requests = state.contact_requests.len();

    let mut active_rooms: Vec<liaper_common::RoomInfo> =
        state.rooms.iter().map(|r| r.value().clone()).collect();
    active_rooms.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let total_chat_rooms = state.room_chats.len();
    let total_encrypted_messages: usize = state
        .room_chats
        .iter()
        .map(|entry| entry.value().len())
        .sum();
    let total_key_envelopes: usize = state
        .room_key_envelopes
        .iter()
        .map(|entry| entry.value().len())
        .sum();

    let media_nodes = state.list_nodes_sorted();
    let mut releases_list: Vec<AppReleaseManifest> =
        state.releases.iter().map(|e| e.value().clone()).collect();
    releases_list.sort_by(|a, b| a.platform.as_str().cmp(b.platform.as_str()));

    let mut reports_list: Vec<ChatAbuseReport> =
        state.reports.iter().map(|e| e.value().clone()).collect();
    reports_list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let open_reports_count = reports_list.iter().filter(|r| r.status == "open").count();
    let antifraud_snapshot = state.antifraud.snapshot_for_admin().await;

    Ok(Json(serde_json::json!({
        "status": "ok",
        "timestamp": chrono::Utc::now(),
        "version": env!("CARGO_PKG_VERSION"),
        "storage_engine": if database_connected { "postgresql" } else { "json" },
        "database_connected": database_connected,
        "summary": {
            "total_users": users_list.len(),
            "online_users": online_users,
            "tutors_count": tutors_count,
            "students_count": students_count,
            "active_ws_connections": active_ws_connections,
            "confirmed_contact_pairs": confirmed_contact_pairs,
            "pending_contact_requests": pending_contact_requests,
            "active_rooms_count": active_rooms.len(),
            "media_nodes_count": media_nodes.len(),
            "file_nodes_online": if file_node_online { 1 } else { 0 },
            "total_chat_rooms": total_chat_rooms,
            "total_encrypted_messages": total_encrypted_messages,
            "total_key_envelopes": total_key_envelopes,
            "total_attachments_ready": total_attachments_ready,
            "total_attachments_pending": total_attachments_pending,
            "total_attachments_bytes": total_attachments_bytes,
            "total_lesson_archives": total_lesson_archives,
            "user_quota_bytes": attachments::USER_QUOTA_BYTES,
            "open_reports_count": open_reports_count,
            "total_reports_count": reports_list.len(),
        },
        "file_nodes": [
            {
                "node_id": "storage-local-1",
                "public_url": file_node_url,
                "online": file_node_online,
                "stored_files": total_attachments_ready,
                "pending_uploads": total_attachments_pending,
                "stored_bytes": total_attachments_bytes,
            }
        ],
        "media_nodes": media_nodes,
        "active_rooms": active_rooms,
        "users": users_list,
        "reports": reports_list,
        "antifraud": antifraud_snapshot,
        "releases": releases_list,
    })))
}

#[derive(Deserialize)]
struct AdminUnblockRequest {
    subject_key: String,
}

async fn admin_unblock_subject_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<AdminUnblockRequest>,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let _admin = require_admin_access(&state, &headers).await?;
    let ok = state.antifraud.unblock_subject(req.subject_key.trim());
    Ok(Json(serde_json::json!({
        "status": "ok",
        "unblocked": ok,
        "subject_key": req.subject_key,
    })))
}

#[derive(Deserialize)]
struct AdminQuarantineRequest {
    subject_key: String,
    user_id: Option<Uuid>,
    username: Option<String>,
    duration_secs: Option<i64>,
    reason: Option<String>,
}

async fn admin_manual_quarantine_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<AdminQuarantineRequest>,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let _admin = require_admin_access(&state, &headers).await?;
    let duration = req.duration_secs.unwrap_or(900);
    let reason = req
        .reason
        .unwrap_or_else(|| "Ручная блокировка администратором".to_string());
    state
        .antifraud
        .manual_quarantine(
            req.subject_key.trim(),
            req.user_id,
            req.username,
            duration,
            reason,
        )
        .await;
    Ok(Json(serde_json::json!({
        "status": "ok",
        "subject_key": req.subject_key,
        "duration_secs": duration,
    })))
}

#[derive(Deserialize)]
struct SubmitReportRequest {
    room_id: Uuid,
    room_title: Option<String>,
    reason: String,
    disclosed_keys: Vec<DisclosedRoomKey>,
}

async fn submit_report_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<SubmitReportRequest>,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let reporter_id = archives::owner(&state, &headers)?;
    let reporter = state
        .users_by_id
        .get(&reporter_id)
        .map(|u| u.value().clone())
        .ok_or_else(|| archives::error(StatusCode::UNAUTHORIZED, "Пользователь не найден"))?;

    let subj_key = format!("user:{reporter_id}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        return Err(archives::error(StatusCode::TOO_MANY_REQUESTS, &msg));
    }
    if !state
        .antifraud
        .allow_rate(&format!("report:{reporter_id}"), 600, 5)
    {
        state
            .antifraud
            .record_violation(
                &subj_key,
                Some(reporter_id),
                Some(reporter.username.clone()),
                None,
                "report_spam",
                antifraud::IncidentSeverity::Medium,
                35,
                "Флуд жалобами (> 5 за 10 минут)".into(),
                300,
            )
            .await;
        return Err(archives::error(
            StatusCode::TOO_MANY_REQUESTS,
            "Слишком много жалоб за короткое время. Подождите несколько минут",
        ));
    }

    let is_member = state
        .rooms
        .get(&req.room_id)
        .is_some_and(|r| r.participants.iter().any(|p| p.user_id == reporter_id))
        || state
            .room_invitations
            .get(&req.room_id)
            .is_some_and(|ids| ids.contains(&reporter_id))
        || state.room_key_envelopes.contains_key(&(req.room_id, reporter_id))
        || state.contacts_by_user.get(&reporter_id).is_some_and(|contacts| {
            contacts
                .iter()
                .any(|cid| ControlState::dm_room_id(&reporter_id, cid) == req.room_id)
        });
    if !is_member {
        return Err(archives::error(
            StatusCode::FORBIDDEN,
            "Жалобу можно отправить только на переписку, в которой вы участвуете",
        ));
    }

    let reason = req.reason.trim();
    let clean_reason = if reason.is_empty() {
        "Жалоба на нарушение правил общения".to_string()
    } else {
        reason.chars().take(500).collect()
    };

    let room_title = req
        .room_title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Чат {}", req.room_id));

    let messages_snapshot = state
        .room_chats
        .get(&req.room_id)
        .map(|entry| entry.value().clone())
        .unwrap_or_default();

    let safe_keys: Vec<DisclosedRoomKey> = req.disclosed_keys.into_iter().take(32).collect();

    let report = ChatAbuseReport {
        id: Uuid::new_v4(),
        room_id: req.room_id,
        room_title,
        reporter_id,
        reporter_username: reporter.username,
        reporter_display_name: reporter.display_name,
        reason: clean_reason,
        disclosed_keys: safe_keys,
        messages_snapshot: messages_snapshot.clone(),
        status: "open".to_string(),
        created_at: chrono::Utc::now(),
    };

    let report_id = report.id;
    state.reports.insert(report_id, report);
    state.save_reports_to_disk();

    Ok(Json(serde_json::json!({
        "report_id": report_id,
        "messages_count": messages_snapshot.len(),
        "status": "open",
    })))
}

async fn resolve_report_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let _admin = require_admin_access(&state, &headers).await?;
    if let Some(mut rep) = state.reports.get_mut(&id) {
        rep.status = if rep.status == "open" {
            "resolved".to_string()
        } else {
            "open".to_string()
        };
        let new_status = rep.status.clone();
        drop(rep);
        state.save_reports_to_disk();
        return Ok(Json(serde_json::json!({
            "id": id,
            "status": new_status,
        })));
    }
    Err((
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "Жалоба не найдена" })),
    ))
}

// ============================================================================
// Авторизация и Пользователи
// ============================================================================

fn too_many(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "error": msg })))
}

/// Выдаёт задачу proof-of-work для регистрации.
async fn pow_challenge_handler(
    State(state): State<Arc<ControlState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<pow::PowChallenge>, (StatusCode, Json<serde_json::Value>)> {
    let ip = pow::client_ip(&headers, peer);
    if !state.antifraud.allow_rate(&format!("pow:ip:{ip}"), 600, 40) {
        return Err(too_many("Слишком много попыток регистрации с вашего адреса. Подождите 10 минут."));
    }
    Ok(Json(state.pow.issue(chrono::Utc::now().timestamp())))
}

async fn register_handler(
    State(state): State<Arc<ControlState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<serde_json::Value>)> {
    let ip = pow::client_ip(&headers, peer);
    let username = ControlState::normalize_username(&req.username);
    if username.len() < 3 || username.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({ "error": "Ник должен содержать от 3 до 32 символов (латиница, цифры, _)" }),
            ),
        ));
    }
    if req.password.chars().count() < 8 || req.password.len() > 256 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Пароль должен содержать от 8 до 256 символов" })),
        ));
    }
    if req.display_name.chars().count() > 64 || req.e2ee_public_key.len() > 2048 || req.key_fingerprint.len() > 128 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Некорректная длина параметров профиля" })),
        ));
    }
    // Лимит по IP с запасом для класса за одним роутером
    if !state.antifraud.allow_rate(&format!("register:ip:{ip}"), 3600, 20) {
        state
            .antifraud
            .record_violation(
                &format!("ip:{ip}"),
                None,
                Some(username.clone()),
                Some(ip.to_string()),
                "register_flood",
                antifraud::IncidentSeverity::Medium,
                25,
                format!("Много регистраций с одного адреса ({ip})"),
                600,
            )
            .await;
        return Err(too_many("С вашего адреса уже зарегистрировано много аккаунтов. Повторите через час."));
    }
    let now_ts = chrono::Utc::now().timestamp();
    let pow_result = match (req.pow_challenge.as_deref(), req.pow_solution.as_deref()) {
        (Some(ch), Some(sol)) => state.pow.verify(ch, sol, now_ts),
        _ => Err("missing"),
    };
    if let Err(reason) = pow_result {
        let msg = match reason {
            "missing" => "Обновите приложение: для регистрации нужна новая версия.",
            "expired" => "Проверка устарела. Нажмите «Создать аккаунт» ещё раз.",
            _ => "Не удалось пройти проверку на робота. Попробуйте ещё раз.",
        };
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg, "code": "pow_failed" }))));
    }
    if !state.antifraud.allow_rate("register:global", 600, 300) {
        state
            .antifraud
            .record_violation(
                &format!("username:{username}"),
                None,
                Some(username.clone()),
                Some(ip.to_string()),
                "register_flood",
                antifraud::IncidentSeverity::High,
                50,
                format!("Попытка массовой регистрации аккаунтов (@{username})"),
                600,
            )
            .await;
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Сработала антифрод-защита от массовой регистрации. Повторите позже." })),
        ));
    }

    if state.user_id_by_username.contains_key(&username) {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": format!("Ник @{} уже занят", username) })),
        ));
    }

    let user_id = Uuid::new_v4();
    let salt_b64 = ControlState::generate_salt();
    let password_hash = ControlState::hash_password(&req.password, &salt_b64);

    let stored = StoredUser {
        id: user_id,
        username: username.clone(),
        display_name: if req.display_name.trim().is_empty() {
            username.clone()
        } else {
            req.display_name.trim().to_string()
        },
        password_hash,
        salt_b64,
        role: req.role,
        e2ee_public_key: req.e2ee_public_key,
        key_fingerprint: req.key_fingerprint,
    };

    state.persist_user(&stored).await.map_err(|e| {
        tracing::error!("User persistence failed: {}", e);
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"Не удалось сохранить профиль в базе"})),
        )
    })?;
    state.pow.note_registration(now_ts);
    state.user_id_by_username.insert(username, user_id);
    state.users_by_id.insert(user_id, stored.clone());
    state.save_users_to_disk();

    let token = ControlState::generate_token();
    state.persist_session(&token, user_id).await;

    info!("Registered user @{} ({})", stored.username, stored.id);

    // Оповещаем подключённых клиентов о новом пользователе в каталоге
    state.broadcast_all(&ControlToClientMsg::DirectoryUpdated {
        users: state.all_public_users(),
    });

    Ok(Json(AuthResponse {
        token,
        user: stored.to_public(true),
    }))
}

async fn login_handler(
    State(state): State<Arc<ControlState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<serde_json::Value>)> {
    let ip = pow::client_ip(&headers, peer);
    // Перебор паролей по многим никам с одного адреса
    if !state.antifraud.allow_rate(&format!("login:ip:{ip}"), 600, 60) {
        return Err(too_many("Слишком много попыток входа с вашего адреса. Подождите 10 минут."));
    }
    let username = ControlState::normalize_username(&req.username);
    let subj_by_name = format!("username:{username}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_by_name) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": msg })),
        ));
    }
    if !state
        .antifraud
        .allow_rate(&format!("login:{username}"), 300, 8)
    {
        state
            .antifraud
            .record_violation(
                &subj_by_name,
                None,
                Some(username.clone()),
                None,
                "auth_bruteforce",
                antifraud::IncidentSeverity::High,
                100,
                format!("Превышен лимит попыток входа для @{username} (Brute-Force Guard)"),
                300,
            )
            .await;
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "Слишком много попыток входа. Аккаунт временно защищён антифрод-системой на 5 минут." })),
        ));
    }

    let user_id = match state.user_id_by_username.get(&username) {
        Some(id) => *id,
        None => {
            state
                .antifraud
                .record_violation(
                    &subj_by_name,
                    None,
                    Some(username.clone()),
                    None,
                    "auth_bruteforce",
                    antifraud::IncidentSeverity::Low,
                    15,
                    format!("Попытка входа в несуществующий аккаунт @{username}"),
                    300,
                )
                .await;
            // Выравниваем время ответа, чтобы по нему нельзя было перебирать существующие ники
            let _ = ControlState::verify_password(&req.password, "", DUMMY_ARGON2_HASH.as_str());
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": INVALID_CREDENTIALS })),
            ));
        }
    };

    let subj_by_id = format!("user:{user_id}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_by_id) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": msg })),
        ));
    }

    let mut user = match state.users_by_id.get_mut(&user_id) {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Профиль не найден" })),
            ))
        }
    };

    if !ControlState::verify_password(&req.password, &user.salt_b64, &user.password_hash) {
        drop(user);
        state
            .antifraud
            .record_violation(
                &subj_by_id,
                Some(user_id),
                Some(username.clone()),
                None,
                "auth_bruteforce",
                antifraud::IncidentSeverity::Medium,
                25,
                format!("Неверный пароль при входе в аккаунт @{username}"),
                300,
            )
            .await;
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": INVALID_CREDENTIALS })),
        ));
    }

    if ControlState::needs_rehash(&user.password_hash) {
        user.password_hash = ControlState::hash_password(&req.password, "");
        user.salt_b64 = String::new();
    }

    user.merge_public_key(
        req.e2ee_public_key.as_deref().unwrap_or(""),
        req.key_fingerprint.as_deref().unwrap_or(""),
    );

    let public_profile = user.to_public(true);
    let updated_user = user.clone();
    drop(user);
    state.persist_user(&updated_user).await.map_err(|e| {
        tracing::error!("User persistence failed: {}", e);
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"База данных недоступна"})),
        )
    })?;
    state.save_users_to_disk();
    state.notify_user_contacts_presence(&user_id);

    let token = ControlState::generate_token();
    state.persist_session(&token, user_id).await;

    Ok(Json(AuthResponse {
        token,
        user: public_profile,
    }))
}

const INVALID_CREDENTIALS: &str = "Неверный @ник или пароль";

static DUMMY_ARGON2_HASH: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| ControlState::hash_password("liaper-timing-equalizer", ""));

async fn logout_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
) -> StatusCode {
    if let Some(token) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        state.revoke_session(token).await;
    }
    StatusCode::NO_CONTENT
}

/// Короткоживущий допуск в медиа-комнату. Выдаётся только участникам комнаты.
async fn sfu_ticket_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Path(room_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, archives::ApiError> {
    let user_id = archives::owner(&state, &headers)?;
    let room = state
        .rooms
        .get(&room_id)
        .map(|r| r.value().clone())
        .ok_or_else(|| archives::error(StatusCode::NOT_FOUND, "Урок не найден или уже завершён"))?;
    let participant = room
        .participants
        .iter()
        .find(|p| p.user_id == user_id)
        .ok_or_else(|| archives::error(StatusCode::FORBIDDEN, "Сначала войдите в урок"))?;
    let Some(secret) = liaper_common::sfu_access::node_secret_from_env() else {
        return Ok(Json(serde_json::json!({ "ticket": null })));
    };
    let ticket = liaper_common::sfu_access::SfuTicket::new(
        room_id,
        user_id,
        participant.username.clone(),
        room.assigned_node.node_id.clone(),
    );
    Ok(Json(serde_json::json!({
        "ticket": ticket.sign(&secret),
        "valid_until": ticket.valid_until,
    })))
}

/// Каталог пользователей доступен только администратору.
async fn list_users_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<UserPublicProfile>>, archives::ApiError> {
    let _admin = require_admin_access(&state, &headers).await?;
    Ok(Json(state.all_public_users()))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

async fn search_users_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<UserPublicProfile>>, archives::ApiError> {
    archives::owner(&state, &headers)?;
    let q = query
        .q
        .unwrap_or_default()
        .trim()
        .trim_start_matches('@')
        .to_lowercase();
    // Только по началу ника и не короче 3 символов: каталог целиком не раскрывается
    if q.chars().count() < 3 {
        return Ok(Json(Vec::new()));
    }
    let filtered = state
        .all_public_users()
        .into_iter()
        .filter(|u| u.username.starts_with(&q))
        .take(10)
        .collect();
    Ok(Json(filtered))
}

// ============================================================================
// Пул Медиа-нод и Балансировка Нагрузки
// ============================================================================

async fn list_nodes_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<MediaNodeInfo>>, archives::ApiError> {
    archives::owner(&state, &headers)?;
    Ok(Json(state.list_nodes_sorted()))
}

async fn node_heartbeat_handler(
    State(state): State<Arc<ControlState>>,
    headers: axum::http::HeaderMap,
    Json(hb): Json<MediaNodeHeartbeat>,
) -> Result<Json<MediaNodeInfo>, StatusCode> {
    if let Some(secret) = liaper_common::sfu_access::node_secret_from_env() {
        use subtle::ConstantTimeEq;
        let provided = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        if !bool::from(provided.as_bytes().ct_eq(&secret)) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    if hb.node_id.len() > 64 || hb.ws_url.len() > 512 || hb.http_url.len() > 512 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let updated = state.upsert_node_heartbeat(hb);
    state.broadcast_all(&ControlToClientMsg::NodesUpdated {
        nodes: state.list_nodes_sorted(),
    });
    Ok(Json(updated))
}

// ============================================================================
// Реестр Релизов и Автообновление (Windows, Linux, Android)
// ============================================================================

async fn list_releases_handler(
    State(state): State<Arc<ControlState>>,
) -> Json<Vec<AppReleaseManifest>> {
    let mut list: Vec<AppReleaseManifest> =
        state.releases.iter().map(|e| e.value().clone()).collect();
    list.sort_by(|a, b| a.platform.as_str().cmp(b.platform.as_str()));
    Json(list)
}

#[derive(Deserialize)]
struct UpdateCheckQuery {
    platform: String,
    version: String,
}

fn parse_platform(raw: &str) -> AppPlatform {
    // Клиенты присылают и `windows_x86_64`, и `windows-x86_64`. Приводим дефисы к подчёркиваниям:
    // наоборот нельзя — подчёркивание внутри `x86_64` тоже заменилось бы
    match raw.trim().to_lowercase().replace('-', "_").as_str() {
        "windows" | "windows_x86_64" | "win64" => AppPlatform::WindowsX86_64,
        "linux" | "linux_x86_64" => AppPlatform::LinuxX86_64,
        "android" | "android_arm64" | "android_aarch64" => AppPlatform::AndroidArm64,
        "android_universal" => AppPlatform::AndroidUniversal,
        _ => AppPlatform::Web,
    }
}

async fn check_update_handler(
    State(state): State<Arc<ControlState>>,
    Query(query): Query<UpdateCheckQuery>,
) -> Json<UpdateCheckResponse> {
    let platform = parse_platform(&query.platform);
    let latest = state.releases.get(&platform).map(|r| r.value().clone());
    let update_available = latest
        .as_ref()
        .map(|rel| is_version_newer(&query.version, &rel.version))
        .unwrap_or(false);

    Json(UpdateCheckResponse {
        update_available,
        current_version: query.version,
        latest,
    })
}

/// Нативный эндпоинт для встроенного автообновления Tauri v2 (`tauri-plugin-updater`).
/// Возвращает `200 OK` с JSON-манифестом и подписью Ed25519, если есть более новая версия,
/// или `204 No Content`, если у пользователя уже установлена актуальная сборка.
async fn tauri_updater_handler(
    State(state): State<Arc<ControlState>>,
    Path((target, _arch, current_version)): Path<(String, String, String)>,
) -> Response {
    let platform = parse_platform(&target);
    if let Some(release) = state.releases.get(&platform) {
        if is_version_newer(&current_version, &release.version) {
            let body = TauriUpdaterResponse {
                version: release.version.clone(),
                notes: release.release_notes.clone(),
                pub_date: release.published_at,
                url: release.download_url.clone(),
                signature: release.signature.clone(),
            };
            return (StatusCode::OK, Json(body)).into_response();
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn publish_release_handler(
    State(state): State<Arc<ControlState>>,
    Json(req): Json<PublishReleaseRequest>,
) -> Result<Json<AppReleaseManifest>, (StatusCode, Json<serde_json::Value>)> {
    let secret_ok = state.admin_secret.as_deref().is_some_and(|s| {
        !s.is_empty() && bool::from(subtle::ConstantTimeEq::ct_eq(s.as_bytes(), req.admin_secret.as_bytes()))
    });
    if !secret_ok {
        return Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Неверный секретный ключ администратора релизов" })),
        ));
    }

    let manifest = req.manifest;
    info!(
        "Published new release in registry: {:?} v{}",
        manifest.platform, manifest.version
    );
    state
        .releases
        .insert(manifest.platform.clone(), manifest.clone());
    state.save_releases_to_disk();
    Ok(Json(manifest))
}

// ============================================================================
// WebSocket Upgrade
// ============================================================================

#[derive(Deserialize)]
struct WsAuthQuery {
    token: String,
}

async fn ws_upgrade_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ControlState>>,
    Query(query): Query<WsAuthQuery>,
) -> Response {
    let user_id = match state.tokens.get(&query.token) {
        Some(id) => *id,
        None => return (StatusCode::UNAUTHORIZED, "Invalid session token").into_response(),
    };
    let subj_key = format!("user:{user_id}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        return (StatusCode::TOO_MANY_REQUESTS, msg).into_response();
    }
    let existing_conns = state
        .sessions
        .get(&user_id)
        .map(|s| s.value().len())
        .unwrap_or(0);
    if existing_conns >= antifraud::MAX_WS_SESSIONS_PER_USER {
        let uname = state
            .users_by_id
            .get(&user_id)
            .map(|u| u.username.clone());
        state
            .antifraud
            .record_violation(
                &subj_key,
                Some(user_id),
                uname,
                None,
                "ws_flood",
                antifraud::IncidentSeverity::Medium,
                25,
                format!(
                    "Превышен лимит одновременных WebSocket-сессий ({}/{})",
                    existing_conns,
                    antifraud::MAX_WS_SESSIONS_PER_USER
                ),
                180,
            )
            .await;
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "Превышен лимит одновременных подключений",
        )
            .into_response();
    }

    ws.max_message_size(128 * 1024)
        .on_upgrade(move |socket| ws::handle_client_socket(socket, state, user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_check_understands_every_platform_spelling() {
        for raw in ["windows_x86_64", "windows-x86_64", "Windows", "win64"] {
            assert_eq!(parse_platform(raw), AppPlatform::WindowsX86_64, "{raw}");
        }
        for raw in ["linux_x86_64", "linux-x86_64", "linux"] {
            assert_eq!(parse_platform(raw), AppPlatform::LinuxX86_64, "{raw}");
        }
        for raw in ["android_arm64", "android-arm64", "android"] {
            assert_eq!(parse_platform(raw), AppPlatform::AndroidArm64, "{raw}");
        }
        assert_eq!(parse_platform("android-universal"), AppPlatform::AndroidUniversal);
        assert_eq!(parse_platform("что-то"), AppPlatform::Web);
    }

    #[tokio::test]
    async fn release_publication_requires_configured_secret() {
        let dir = std::env::temp_dir().join(format!("liaper_publish_test_{}", Uuid::new_v4()));
        let mut state = ControlState::new(dir.join("users.json"));
        Arc::get_mut(&mut state).unwrap().admin_secret = None;
        let manifest = state
            .releases
            .get(&AppPlatform::AndroidArm64)
            .unwrap()
            .clone();
        for secret in ["", "liaper-release-secret-2026"] {
            let result = publish_release_handler(
                State(state.clone()),
                Json(PublishReleaseRequest {
                    admin_secret: secret.to_string(),
                    manifest: manifest.clone(),
                }),
            )
            .await;
            assert_eq!(
                result.err().map(|(status, _)| status),
                Some(StatusCode::FORBIDDEN)
            );
        }
        Arc::get_mut(&mut state).unwrap().admin_secret = Some("test-only-secret".to_string());
        let result = publish_release_handler(
            State(state.clone()),
            Json(PublishReleaseRequest {
                admin_secret: "test-only-secret".to_string(),
                manifest,
            }),
        )
        .await;
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn passwords_use_argon2id_and_legacy_hashes_still_verify() {
        let hash = ControlState::hash_password("correct horse", "");
        assert!(hash.starts_with("$argon2id$"));
        assert!(ControlState::verify_password("correct horse", "", &hash));
        assert!(!ControlState::verify_password("wrong horse", "", &hash));
        assert!(!ControlState::needs_rehash(&hash));

        // Хеш формата v1 (соль + SHA-256) из существующих баз
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"c2FsdA==:liaper-auth-v1:old-password");
        let legacy = BASE64.encode(h.finalize());
        assert!(ControlState::verify_password("old-password", "c2FsdA==", &legacy));
        assert!(!ControlState::verify_password("other", "c2FsdA==", &legacy));
        assert!(ControlState::needs_rehash(&legacy));
    }

    #[test]
    fn test_node_load_balancer_routes_to_least_loaded() {
        let dir = std::env::temp_dir().join(format!("liaper_test_{}", Uuid::new_v4()));
        let state = ControlState::new(dir.join("users.json"));

        // Регистрируем нагруженную ноду #1
        state.upsert_node_heartbeat(MediaNodeHeartbeat {
            node_id: "node-busy".to_string(),
            name: "Busy Node".to_string(),
            region: "RU-Central".to_string(),
            ws_url: "ws://10.0.0.1:4101/ws/sfu".to_string(),
            http_url: "http://10.0.0.1:4101".to_string(),
            active_rooms: 12,
            active_peers: 85,
            max_peers: 100,
            cpu_usage_percent: 78.0,
            memory_usage_percent: 65.0,
            bandwidth_mbps: 140.0,
        });

        // Регистрируем свободную ноду #2
        state.upsert_node_heartbeat(MediaNodeHeartbeat {
            node_id: "node-free".to_string(),
            name: "Free Node".to_string(),
            region: "RU-East".to_string(),
            ws_url: "ws://10.0.0.2:4102/ws/sfu".to_string(),
            http_url: "http://10.0.0.2:4102".to_string(),
            active_rooms: 1,
            active_peers: 4,
            max_peers: 100,
            cpu_usage_percent: 8.0,
            memory_usage_percent: 20.0,
            bandwidth_mbps: 5.5,
        });

        let selected = state.select_least_loaded_node(None);
        assert_eq!(selected.node_id, "node-free");
        assert!(selected.load_score < 15.0);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_release_registry_seeded_for_all_platforms() {
        let dir = std::env::temp_dir().join(format!("liaper_rel_test_{}", Uuid::new_v4()));
        let state = ControlState::new(dir.join("users.json"));

        assert!(state.releases.contains_key(&AppPlatform::WindowsX86_64));
        assert!(state.releases.contains_key(&AppPlatform::LinuxX86_64));
        assert!(state.releases.contains_key(&AppPlatform::AndroidArm64));

        let win_rel = state.releases.get(&AppPlatform::WindowsX86_64).unwrap();
        assert_eq!(win_rel.version, "0.1.0");
        assert!(is_version_newer(&win_rel.version, "0.2.0"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
