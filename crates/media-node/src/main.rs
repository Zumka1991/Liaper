use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use dashmap::DashMap;
use futures::{SinkExt, StreamExt};
use liaper_common::{
    sfu_access::{node_secret_from_env, SfuTicket},
    ClientToNodeMsg, IceServerConfig, MediaNodeHeartbeat, NodeToClientMsg, SfuPeerSummary,
};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};
use uuid::Uuid;

type PeerSender = mpsc::UnboundedSender<NodeToClientMsg>;

#[derive(Clone)]
struct ConnectedSfuPeer {
    /// Идентификатор WebSocket-соединения: один аккаунт может зайти с нескольких устройств
    conn_id: Uuid,
    summary: SfuPeerSummary,
    tx: PeerSender,
}

struct NodeState {
    node_id: String,
    name: String,
    region: String,
    public_ws_url: String,
    public_http_url: String,
    control_url: String,
    max_peers: u32,
    /// Общий секрет с сервером управления: подпись heartbeat и проверка допусков в комнаты
    node_secret: Option<Vec<u8>>,
    /// Комнаты на этой медиа-ноде: room_id -> список подключённых участников
    rooms: DashMap<Uuid, Vec<ConnectedSfuPeer>>,
    /// Счётчик пересланных байт за интервал для расчёта реального битрейта (Мбит/с)
    bytes_relayed_interval: AtomicU64,
}

impl NodeState {
    fn active_rooms_count(&self) -> u32 {
        self.rooms.iter().filter(|r| !r.value().is_empty()).count() as u32
    }

    fn active_peers_count(&self) -> u32 {
        self.rooms.iter().map(|r| r.value().len() as u32).sum()
    }

    fn default_ice_servers() -> Vec<IceServerConfig> {
        let mut servers = vec![
            IceServerConfig {
                urls: vec![
                    "stun:stun.l.google.com:19302".to_string(),
                    "stun:stun1.l.google.com:19302".to_string(),
                ],
                username: None,
                credential: None,
            },
        ];

        if let Ok(turn_url) = std::env::var("LIAPER_TURN_URL") {
            servers.push(IceServerConfig {
                urls: vec![turn_url],
                username: std::env::var("LIAPER_TURN_USER").ok(),
                credential: std::env::var("LIAPER_TURN_PASS").ok(),
            });
        }

        servers
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "liaper_node=info,tower_http=info".into()),
        )
        .init();

    let port: u16 = std::env::var("NODE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4101);

    let node_id = std::env::var("NODE_ID").unwrap_or_else(|_| format!("node-ru-{}", port));
    let name =
        std::env::var("NODE_NAME").unwrap_or_else(|_| format!("SFU Media Node ({})", node_id));
    let region = std::env::var("NODE_REGION").unwrap_or_else(|_| "RU-Central".to_string());
    let host = std::env::var("NODE_PUBLIC_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let public_ws_url = std::env::var("NODE_WS_URL")
        .unwrap_or_else(|_| format!("ws://{}:{}/ws/sfu", host, port));
    let public_http_url =
        std::env::var("NODE_HTTP_URL").unwrap_or_else(|_| format!("http://{}:{}", host, port));
    let control_url =
        std::env::var("CONTROL_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".to_string());
    let max_peers: u32 = std::env::var("NODE_MAX_PEERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);

    if node_secret_from_env().is_none() {
        warn!("LIAPER_NODE_SECRET не задан (>= 32 символов): нода принимает вход в комнаты без допуска. Только для разработки!");
    }

    let state = Arc::new(NodeState {
        node_id: node_id.clone(),
        name: name.clone(),
        region: region.clone(),
        public_ws_url,
        public_http_url,
        control_url,
        max_peers,
        node_secret: node_secret_from_env(),
        rooms: DashMap::new(),
        bytes_relayed_interval: AtomicU64::new(0),
    });

    // Запускаем фоновую отправку Heartbeat-метрик на центральный сервер каждые 2 секунды
    let hb_state = state.clone();
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_default();
        let endpoint = format!("{}/api/nodes/heartbeat", hb_state.control_url);

        loop {
            let active_rooms = hb_state.active_rooms_count();
            let active_peers = hb_state.active_peers_count();
            let bytes = hb_state.bytes_relayed_interval.swap(0, Ordering::Relaxed);
            // Перевод байт за 2 секунды в Мбит/с
            let bandwidth_mbps = ((bytes as f32 * 8.0) / 2_000_000.0 * 100.0).round() / 100.0;

            // Оценка CPU и памяти пропорционально числу активных потоков + базовая нагрузка ОС
            let cpu_usage_percent = (3.5 + (active_peers as f32 * 1.8)).min(98.0);
            let memory_usage_percent = (14.0 + (active_peers as f32 * 0.6)).min(95.0);

            let hb = MediaNodeHeartbeat {
                node_id: hb_state.node_id.clone(),
                name: hb_state.name.clone(),
                region: hb_state.region.clone(),
                ws_url: hb_state.public_ws_url.clone(),
                http_url: hb_state.public_http_url.clone(),
                active_rooms,
                active_peers,
                max_peers: hb_state.max_peers,
                cpu_usage_percent,
                memory_usage_percent,
                bandwidth_mbps,
            };

            let mut request = client.post(&endpoint).json(&hb);
            if let Some(secret) = &hb_state.node_secret {
                request = request.bearer_auth(String::from_utf8_lossy(secret));
            }
            if let Err(err) = request.send().await {
                warn!("Could not send heartbeat to control server ({}): {}", endpoint, err);
            }

            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler))
        .route("/ws/sfu", get(sfu_ws_upgrade))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(
        "Liaper Media Node '{}' ({}) listening on http://{}",
        name, region, addr
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health_handler(State(state): State<Arc<NodeState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "node_id": state.node_id,
        "region": state.region,
        "active_rooms": state.active_rooms_count(),
        "active_peers": state.active_peers_count(),
    }))
}

async fn metrics_handler(State(state): State<Arc<NodeState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "node_id": state.node_id,
        "name": state.name,
        "region": state.region,
        "ws_url": state.public_ws_url,
        "active_rooms": state.active_rooms_count(),
        "active_peers": state.active_peers_count(),
        "max_peers": state.max_peers,
    }))
}

async fn sfu_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<NodeState>>,
) -> Response {
    if state.active_peers_count() >= state.max_peers {
        return (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "SFU node peer capacity reached",
        )
            .into_response();
    }
    ws.max_message_size(512 * 1024)
        .on_upgrade(move |socket| handle_sfu_peer(socket, state))
}

async fn handle_sfu_peer(socket: WebSocket, state: Arc<NodeState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<NodeToClientMsg>();
    let conn_id = Uuid::new_v4();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if ws_sender.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let mut current_room_id: Option<Uuid> = None;
    let mut current_user_id: Option<Uuid> = None;
    let mut current_username = String::new();

    while let Some(Ok(frame)) = ws_receiver.next().await {
        if let Message::Text(text) = frame {
            state
                .bytes_relayed_interval
                .fetch_add(text.len() as u64, Ordering::Relaxed);

            if let Ok(cmd) = serde_json::from_str::<ClientToNodeMsg>(&text) {
                match cmd {
                    ClientToNodeMsg::JoinSfuRoom {
                        room_id,
                        user_id,
                        username,
                        display_name,
                        e2ee_enabled,
                        room_key_id,
                        ticket,
                    } => {
                        if let Some(secret) = &state.node_secret {
                            let valid = ticket
                                .as_deref()
                                .and_then(|t| SfuTicket::verify(t, secret, chrono::Utc::now()))
                                .filter(|t| {
                                    t.room_id == room_id
                                        && t.user_id == user_id
                                        && t.node_id == state.node_id
                                });
                            let Some(valid) = valid else {
                                warn!("[{}] Rejected SFU join without valid ticket", state.node_id);
                                break;
                            };
                            current_username = valid.username;
                        } else {
                            current_username = username.chars().take(64).collect();
                        }
                        // Повторный вход в другую комнату из того же сокета: выходим из прежней
                        if let (Some(prev_room), Some(prev_user)) = (current_room_id, current_user_id) {
                            if prev_room != room_id || prev_user != user_id {
                                remove_peer_from_sfu_room(&state, prev_room, prev_user, conn_id);
                            }
                        }
                        current_room_id = Some(room_id);
                        current_user_id = Some(user_id);
                        let username = current_username.clone();
                        let display_name: String = display_name.chars().take(64).collect();
                        let room_key_id: String = room_key_id.chars().take(64).collect();

                        let peer_summary = SfuPeerSummary {
                            user_id,
                            username: username.clone(),
                            display_name,
                            e2ee_enabled,
                            room_key_id,
                        };

                        let mut existing_peers = Vec::new();
                        {
                            let mut room_peers = state.rooms.entry(room_id).or_default();
                            // Тот же аккаунт с другого устройства: звонок переходит на новое соединение,
                            // старое отключается при следующем кадре
                            room_peers.retain(|p| p.summary.user_id != user_id);
                            for existing in room_peers.iter() {
                                existing_peers.push(existing.summary.clone());
                                let _ = existing.tx.send(NodeToClientMsg::PeerJoinedSfu {
                                    room_id,
                                    peer: peer_summary.clone(),
                                });
                            }
                            room_peers.push(ConnectedSfuPeer {
                                conn_id,
                                summary: peer_summary,
                                tx: tx.clone(),
                            });
                        }

                        info!(
                            "[{}] Peer @{} joined SFU room {} (E2EE: {})",
                            state.node_id, username, room_id, e2ee_enabled
                        );

                        let _ = tx.send(NodeToClientMsg::SfuRoomJoined {
                            node_id: state.node_id.clone(),
                            node_name: state.name.clone(),
                            room_id,
                            existing_peers,
                            ice_servers: NodeState::default_ice_servers(),
                        });
                    }

                    ClientToNodeMsg::SignalSdpOffer {
                        room_id,
                        target_peer_id,
                        sdp,
                    } => {
                        if let (Some(from_id), Some(joined_room)) = (current_user_id, current_room_id) {
                            if joined_room != room_id {
                                continue;
                            }
                            if !relay_to_room(
                                &state,
                                room_id,
                                conn_id,
                                from_id,
                                target_peer_id,
                                NodeToClientMsg::RelayedSdpOffer {
                                    room_id,
                                    from_peer_id: from_id,
                                    from_username: current_username.clone(),
                                    sdp,
                                },
                            ) {
                                break;
                            }
                        }
                    }

                    ClientToNodeMsg::SignalSdpAnswer {
                        room_id,
                        target_peer_id,
                        sdp,
                    } => {
                        if let (Some(from_id), Some(joined_room)) = (current_user_id, current_room_id) {
                            if joined_room != room_id {
                                continue;
                            }
                            if !relay_to_room(
                                &state,
                                room_id,
                                conn_id,
                                from_id,
                                target_peer_id,
                                NodeToClientMsg::RelayedSdpAnswer {
                                    room_id,
                                    from_peer_id: from_id,
                                    sdp,
                                },
                            ) {
                                break;
                            }
                        }
                    }

                    ClientToNodeMsg::SignalIceCandidate {
                        room_id,
                        target_peer_id,
                        candidate,
                        sdp_mid,
                        sdp_mline_index,
                    } => {
                        if let (Some(from_id), Some(joined_room)) = (current_user_id, current_room_id) {
                            if joined_room != room_id {
                                continue;
                            }
                            if !relay_to_room(
                                &state,
                                room_id,
                                conn_id,
                                from_id,
                                target_peer_id,
                                NodeToClientMsg::RelayedIceCandidate {
                                    room_id,
                                    from_peer_id: from_id,
                                    candidate,
                                    sdp_mid,
                                    sdp_mline_index,
                                },
                            ) {
                                break;
                            }
                        }
                    }

                    ClientToNodeMsg::EncryptedMediaFrame {
                        room_id,
                        kind,
                        ciphertext_b64,
                        iv_b64,
                        room_key_id,
                        timestamp_ms,
                    } => {
                        if let (Some(from_id), Some(joined_room)) = (current_user_id, current_room_id) {
                            if joined_room != room_id {
                                continue;
                            }
                            if !relay_to_room(
                                &state,
                                room_id,
                                conn_id,
                                from_id,
                                None,
                                NodeToClientMsg::RelayedEncryptedMediaFrame {
                                    room_id,
                                    from_peer_id: from_id,
                                    from_username: current_username.clone(),
                                    kind,
                                    ciphertext_b64,
                                    iv_b64,
                                    room_key_id,
                                    timestamp_ms,
                                },
                            ) {
                                break;
                            }
                        }
                    }

                    ClientToNodeMsg::LeaveSfuRoom { .. } => {
                        break;
                    }
                }
            }
        }
    }

    send_task.abort();
    if let (Some(room_id), Some(uid)) = (current_room_id, current_user_id) {
        remove_peer_from_sfu_room(&state, room_id, uid, conn_id);
    }
}

/// Пересылает сообщение участникам комнаты. Возвращает `false`, если отправитель
/// больше не в комнате (звонок перенесён на другое устройство) — соединение нужно закрыть.
fn relay_to_room(
    state: &Arc<NodeState>,
    room_id: Uuid,
    from_conn_id: Uuid,
    from_peer_id: Uuid,
    target_peer_id: Option<Uuid>,
    msg: NodeToClientMsg,
) -> bool {
    let Some(room_peers) = state.rooms.get(&room_id) else {
        return false;
    };
    if !room_peers.iter().any(|p| p.conn_id == from_conn_id) {
        return false;
    }
    {
        for peer in room_peers.iter() {
            if peer.summary.user_id == from_peer_id {
                continue;
            }
            if let Some(target) = target_peer_id {
                if peer.summary.user_id != target {
                    continue;
                }
            }
            let _ = peer.tx.send(msg.clone());
        }
    }
    true
}

/// Убирает из комнаты только это соединение: если аккаунт уже перешёл на другое устройство,
/// новое соединение остаётся в звонке.
fn remove_peer_from_sfu_room(state: &Arc<NodeState>, room_id: Uuid, user_id: Uuid, conn_id: Uuid) {
    let mut should_remove_room = false;
    if let Some(mut room_peers) = state.rooms.get_mut(&room_id) {
        let before = room_peers.len();
        room_peers.retain(|p| p.conn_id != conn_id);
        let removed = room_peers.len() != before;
        let still_present = room_peers.iter().any(|p| p.summary.user_id == user_id);
        if removed && !still_present {
            for peer in room_peers.iter() {
                let _ = peer.tx.send(NodeToClientMsg::PeerLeftSfu { room_id, user_id });
            }
        }
        if room_peers.is_empty() {
            should_remove_room = true;
        }
    }
    if should_remove_room {
        state.rooms.remove(&room_id);
    }
}
