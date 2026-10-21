mod state;
mod ws;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    http::StatusCode,
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

use crate::state::{ControlState, StoredUser};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    let app = Router::new()
        .route("/api/health", get(health_handler))
        // Авторизация и каталог @ников
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
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
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Liaper Control Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "liaper-control-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

// ============================================================================
// Авторизация и Пользователи
// ============================================================================

async fn register_handler(
    State(state): State<Arc<ControlState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<serde_json::Value>)> {
    let username = ControlState::normalize_username(&req.username);
    if username.len() < 3 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Ник должен содержать минимум 3 символа (латиница, цифры, _)" })),
        ));
    }
    if req.password.len() < 4 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Пароль должен содержать минимум 4 символа" })),
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

    state.user_id_by_username.insert(username, user_id);
    state.users_by_id.insert(user_id, stored.clone());
    state.save_users_to_disk();

    let token = ControlState::generate_token();
    state.tokens.insert(token.clone(), user_id);

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
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<serde_json::Value>)> {
    let username = ControlState::normalize_username(&req.username);
    let user_id = match state.user_id_by_username.get(&username) {
        Some(id) => *id,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Пользователь с таким @ником не найден" })),
            ))
        }
    };

    let mut user = match state.users_by_id.get_mut(&user_id) {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Профиль не найден" })),
            ))
        }
    };

    let computed_hash = ControlState::hash_password(&req.password, &user.salt_b64);
    if computed_hash != user.password_hash {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Неверный пароль" })),
        ));
    }

    if let Some(pub_key) = req.e2ee_public_key {
        if !pub_key.is_empty() {
            user.e2ee_public_key = pub_key;
        }
    }
    if let Some(fp) = req.key_fingerprint {
        if !fp.is_empty() {
            user.key_fingerprint = fp;
        }
    }

    let public_profile = user.to_public(true);
    drop(user);
    state.save_users_to_disk();

    let token = ControlState::generate_token();
    state.tokens.insert(token.clone(), user_id);

    Ok(Json(AuthResponse {
        token,
        user: public_profile,
    }))
}

async fn list_users_handler(
    State(state): State<Arc<ControlState>>,
) -> Json<Vec<UserPublicProfile>> {
    Json(state.all_public_users())
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

async fn search_users_handler(
    State(state): State<Arc<ControlState>>,
    Query(query): Query<SearchQuery>,
) -> Json<Vec<UserPublicProfile>> {
    let q = query
        .q
        .unwrap_or_default()
        .trim()
        .trim_start_matches('@')
        .to_lowercase();
    let all = state.all_public_users();
    if q.is_empty() {
        return Json(all);
    }
    let filtered = all
        .into_iter()
        .filter(|u| {
            u.username.to_lowercase().contains(&q) || u.display_name.to_lowercase().contains(&q)
        })
        .collect();
    Json(filtered)
}

// ============================================================================
// Пул Медиа-нод и Балансировка Нагрузки
// ============================================================================

async fn list_nodes_handler(State(state): State<Arc<ControlState>>) -> Json<Vec<MediaNodeInfo>> {
    Json(state.list_nodes_sorted())
}

async fn node_heartbeat_handler(
    State(state): State<Arc<ControlState>>,
    Json(hb): Json<MediaNodeHeartbeat>,
) -> Json<MediaNodeInfo> {
    let updated = state.upsert_node_heartbeat(hb);
    state.broadcast_all(&ControlToClientMsg::NodesUpdated {
        nodes: state.list_nodes_sorted(),
    });
    Json(updated)
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
    match raw.trim().to_lowercase().as_str() {
        "windows" | "windows-x86_64" | "win64" => AppPlatform::WindowsX86_64,
        "linux" | "linux-x86_64" => AppPlatform::LinuxX86_64,
        "android" | "android-arm64" | "android-aarch64" => AppPlatform::AndroidArm64,
        "android-universal" => AppPlatform::AndroidUniversal,
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
    if req.admin_secret != state.admin_secret {
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

    ws.on_upgrade(move |socket| ws::handle_client_socket(socket, state, user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

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
