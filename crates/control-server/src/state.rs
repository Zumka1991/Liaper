use std::{collections::HashSet, path::PathBuf, sync::Arc};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use liaper_common::{
    AppPlatform, AppReleaseManifest, ContactRequestInfo, ControlToClientMsg, E2eeKeyEnvelope,
    EncryptedChatMessage, MediaNodeHeartbeat, MediaNodeInfo, RoomInfo, UserPublicProfile, UserRole,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredUser {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub salt_b64: String,
    pub role: UserRole,
    pub e2ee_public_key: String,
    pub key_fingerprint: String,
}

impl StoredUser {
    pub fn to_public(&self, online: bool) -> UserPublicProfile {
        UserPublicProfile {
            id: self.id,
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            role: self.role.clone(),
            e2ee_public_key: self.e2ee_public_key.clone(),
            key_fingerprint: self.key_fingerprint.clone(),
            online,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredContactRequest {
    pub id: Uuid,
    pub from_user_id: Uuid,
    pub to_user_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ContactsDiskSnapshot {
    pub confirmed_pairs: Vec<(Uuid, Uuid)>,
    pub pending_requests: Vec<StoredContactRequest>,
}

pub type ClientSender = mpsc::UnboundedSender<ControlToClientMsg>;

pub struct ControlState {
    pub users_by_id: DashMap<Uuid, StoredUser>,
    pub user_id_by_username: DashMap<String, Uuid>,
    pub tokens: DashMap<String, Uuid>,
    pub sessions: DashMap<Uuid, Vec<(Uuid, ClientSender)>>,
    pub contacts_by_user: DashMap<Uuid, HashSet<Uuid>>,
    pub contact_requests: DashMap<Uuid, StoredContactRequest>,
    pub media_nodes: DashMap<String, MediaNodeInfo>,
    pub rooms: DashMap<Uuid, RoomInfo>,
    pub room_key_envelopes: DashMap<(Uuid, Uuid), Vec<E2eeKeyEnvelope>>,
    pub room_chats: DashMap<Uuid, Vec<EncryptedChatMessage>>,
    pub releases: DashMap<AppPlatform, AppReleaseManifest>,
    pub storage_path: PathBuf,
    pub contacts_path: PathBuf,
    pub releases_path: PathBuf,
    pub admin_secret: String,
}

impl ControlState {
    pub fn new(storage_path: PathBuf) -> Arc<Self> {
        let base_dir = storage_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("data"));
        let contacts_path = base_dir.join("contacts.json");
        let releases_path = base_dir.join("releases.json");
        let admin_secret = std::env::var("LIAPER_ADMIN_SECRET")
            .unwrap_or_else(|_| "liaper-release-secret-2026".to_string());

        let state = Arc::new(Self {
            users_by_id: DashMap::new(),
            user_id_by_username: DashMap::new(),
            tokens: DashMap::new(),
            sessions: DashMap::new(),
            contacts_by_user: DashMap::new(),
            contact_requests: DashMap::new(),
            media_nodes: DashMap::new(),
            rooms: DashMap::new(),
            room_key_envelopes: DashMap::new(),
            room_chats: DashMap::new(),
            releases: DashMap::new(),
            storage_path,
            contacts_path,
            releases_path,
            admin_secret,
        });
        state.load_users_from_disk();
        state.load_contacts_from_disk();
        state.load_or_seed_releases();
        state
    }

    pub fn normalize_username(raw: &str) -> String {
        raw.trim()
            .trim_start_matches('@')
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.' || *c == '-')
            .collect()
    }

    pub fn hash_password(password: &str, salt_b64: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(salt_b64.as_bytes());
        hasher.update(b":liaper-auth-v1:");
        hasher.update(password.as_bytes());
        BASE64.encode(hasher.finalize())
    }

    pub fn generate_salt() -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        BASE64.encode(bytes)
    }

    pub fn generate_token() -> String {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        format!("lpr_{}", BASE64.encode(bytes))
    }

    pub fn load_users_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.storage_path) {
            if let Ok(users) = serde_json::from_str::<Vec<StoredUser>>(&content) {
                for user in users {
                    self.user_id_by_username
                        .insert(user.username.clone(), user.id);
                    self.users_by_id.insert(user.id, user);
                }
            }
        }
    }

    pub fn save_users_to_disk(&self) {
        if let Some(parent) = self.storage_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let all_users: Vec<StoredUser> = self
            .users_by_id
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&all_users) {
            let _ = std::fs::write(&self.storage_path, json);
        }
    }

    pub fn load_contacts_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.contacts_path) {
            if let Ok(snap) = serde_json::from_str::<ContactsDiskSnapshot>(&content) {
                for (a, b) in snap.confirmed_pairs {
                    self.contacts_by_user.entry(a).or_default().insert(b);
                    self.contacts_by_user.entry(b).or_default().insert(a);
                }
                for req in snap.pending_requests {
                    self.contact_requests.insert(req.id, req);
                }
            }
        }
    }

    pub fn save_contacts_to_disk(&self) {
        if let Some(parent) = self.contacts_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut pairs = Vec::new();
        for entry in self.contacts_by_user.iter() {
            let u1 = *entry.key();
            for u2 in entry.value().iter() {
                if u1 < *u2 {
                    pairs.push((u1, *u2));
                }
            }
        }
        let pending_requests: Vec<StoredContactRequest> = self
            .contact_requests
            .iter()
            .map(|e| e.value().clone())
            .collect();
        let snap = ContactsDiskSnapshot {
            confirmed_pairs: pairs,
            pending_requests,
        };
        if let Ok(json) = serde_json::to_string_pretty(&snap) {
            let _ = std::fs::write(&self.contacts_path, json);
        }
    }

    pub fn are_contacts(&self, user_a: &Uuid, user_b: &Uuid) -> bool {
        self.contacts_by_user
            .get(user_a)
            .map(|set| set.contains(user_b))
            .unwrap_or(false)
    }

    pub fn add_mutual_contact(&self, user_a: Uuid, user_b: Uuid) {
        self.contacts_by_user.entry(user_a).or_default().insert(user_b);
        self.contacts_by_user.entry(user_b).or_default().insert(user_a);
        self.save_contacts_to_disk();
    }

    pub fn remove_mutual_contact(&self, user_a: Uuid, user_b: Uuid) {
        if let Some(mut set_a) = self.contacts_by_user.get_mut(&user_a) {
            set_a.remove(&user_b);
        }
        if let Some(mut set_b) = self.contacts_by_user.get_mut(&user_b) {
            set_b.remove(&user_a);
        }
        self.save_contacts_to_disk();
    }

    pub fn user_contacts_bundle(
        &self,
        user_id: &Uuid,
    ) -> (
        Vec<UserPublicProfile>,
        Vec<ContactRequestInfo>,
        Vec<ContactRequestInfo>,
    ) {
        let mut contacts = Vec::new();
        if let Some(contact_ids) = self.contacts_by_user.get(user_id) {
            for cid in contact_ids.iter() {
                if let Some(u) = self.users_by_id.get(cid) {
                    contacts.push(u.to_public(self.is_user_online(cid)));
                }
            }
        }
        contacts.sort_by(|a, b| b.online.cmp(&a.online).then(a.username.cmp(&b.username)));

        let mut incoming = Vec::new();
        let mut outgoing = Vec::new();
        for entry in self.contact_requests.iter() {
            let req = entry.value();
            if req.to_user_id == *user_id {
                if let (Some(from_u), Some(to_u)) = (
                    self.users_by_id.get(&req.from_user_id),
                    self.users_by_id.get(&req.to_user_id),
                ) {
                    incoming.push(ContactRequestInfo {
                        id: req.id,
                        from_user: from_u.to_public(self.is_user_online(&from_u.id)),
                        to_user: to_u.to_public(self.is_user_online(&to_u.id)),
                        created_at: req.created_at,
                    });
                }
            } else if req.from_user_id == *user_id {
                if let (Some(from_u), Some(to_u)) = (
                    self.users_by_id.get(&req.from_user_id),
                    self.users_by_id.get(&req.to_user_id),
                ) {
                    outgoing.push(ContactRequestInfo {
                        id: req.id,
                        from_user: from_u.to_public(self.is_user_online(&from_u.id)),
                        to_user: to_u.to_public(self.is_user_online(&to_u.id)),
                        created_at: req.created_at,
                    });
                }
            }
        }

        (contacts, incoming, outgoing)
    }

    pub fn push_contacts_update(&self, user_id: &Uuid) {
        let (contacts, incoming_requests, outgoing_requests) = self.user_contacts_bundle(user_id);
        self.send_to_user(
            user_id,
            &ControlToClientMsg::ContactsUpdated {
                contacts,
                incoming_requests,
                outgoing_requests,
            },
        );
    }

    pub fn notify_user_contacts_presence(&self, user_id: &Uuid) {
        if let Some(contact_ids) = self.contacts_by_user.get(user_id) {
            for cid in contact_ids.iter() {
                self.push_contacts_update(cid);
            }
        }
    }

    pub fn load_or_seed_releases(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.releases_path) {
            if let Ok(list) = serde_json::from_str::<Vec<AppReleaseManifest>>(&content) {
                for item in list {
                    self.releases.insert(item.platform.clone(), item);
                }
                if !self.releases.is_empty() {
                    return;
                }
            }
        }

        let now = Utc::now();
        let default_releases = vec![
            AppReleaseManifest {
                platform: AppPlatform::WindowsX86_64,
                version: "0.1.0".to_string(),
                build_number: 1,
                release_notes: "Базовый выпуск Liaper Desktop для Windows.".to_string(),
                download_url: "http://127.0.0.1:4000/releases/liaper_0.1.0_x64-setup.exe".to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ==".to_string(),
                file_size_bytes: 8_420_000,
                mandatory: false,
                published_at: now,
            },
            AppReleaseManifest {
                platform: AppPlatform::LinuxX86_64,
                version: "0.1.0".to_string(),
                build_number: 1,
                release_notes: "Базовый выпуск Liaper Desktop для Linux.".to_string(),
                download_url: "http://127.0.0.1:4000/releases/liaper_0.1.0_amd64.AppImage".to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ==".to_string(),
                file_size_bytes: 11_200_000,
                mandatory: false,
                published_at: now,
            },
            AppReleaseManifest {
                platform: AppPlatform::AndroidArm64,
                version: "0.1.0".to_string(),
                build_number: 1,
                release_notes: "Базовый выпуск Liaper Mobile для Android.".to_string(),
                download_url: "http://127.0.0.1:4000/releases/liaper-android-arm64-v0.1.0.apk".to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ==".to_string(),
                file_size_bytes: 19_650_000,
                mandatory: false,
                published_at: now,
            },
        ];

        for item in default_releases {
            self.releases.insert(item.platform.clone(), item);
        }
        self.save_releases_to_disk();
    }

    pub fn save_releases_to_disk(&self) {
        if let Some(parent) = self.releases_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let all: Vec<AppReleaseManifest> = self
            .releases
            .iter()
            .map(|e| e.value().clone())
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&all) {
            let _ = std::fs::write(&self.releases_path, json);
        }
    }

    pub fn is_user_online(&self, user_id: &Uuid) -> bool {
        self.sessions
            .get(user_id)
            .map(|list| !list.is_empty())
            .unwrap_or(false)
    }

    pub fn all_public_users(&self) -> Vec<UserPublicProfile> {
        let mut list: Vec<UserPublicProfile> = self
            .users_by_id
            .iter()
            .map(|entry| {
                let u = entry.value();
                u.to_public(self.is_user_online(&u.id))
            })
            .collect();
        list.sort_by(|a, b| b.online.cmp(&a.online).then(a.username.cmp(&b.username)));
        list
    }

    pub fn upsert_node_heartbeat(&self, hb: MediaNodeHeartbeat) -> MediaNodeInfo {
        let score = MediaNodeInfo::compute_load_score(
            hb.active_peers,
            hb.max_peers,
            hb.cpu_usage_percent,
            hb.memory_usage_percent,
        );
        let info = MediaNodeInfo {
            node_id: hb.node_id.clone(),
            name: hb.name,
            region: hb.region,
            ws_url: hb.ws_url,
            http_url: hb.http_url,
            active_rooms: hb.active_rooms,
            active_peers: hb.active_peers,
            max_peers: hb.max_peers,
            cpu_usage_percent: hb.cpu_usage_percent,
            memory_usage_percent: hb.memory_usage_percent,
            bandwidth_mbps: hb.bandwidth_mbps,
            healthy: true,
            load_score: score,
            last_seen: Utc::now(),
        };
        self.media_nodes.insert(hb.node_id, info.clone());
        info
    }

    pub fn list_nodes_sorted(&self) -> Vec<MediaNodeInfo> {
        let now = Utc::now();
        let mut nodes: Vec<MediaNodeInfo> = self
            .media_nodes
            .iter()
            .map(|entry| {
                let mut n = entry.value().clone();
                let elapsed_secs = (now - n.last_seen).num_seconds();
                if elapsed_secs > 10 {
                    n.healthy = false;
                }
                n
            })
            .collect();

        if nodes.is_empty() {
            nodes.push(MediaNodeInfo {
                node_id: "node-eu-1".to_string(),
                name: "Primary Media Node #1".to_string(),
                region: "RU-Central".to_string(),
                ws_url: "ws://127.0.0.1:4101/ws/sfu".to_string(),
                http_url: "http://127.0.0.1:4101".to_string(),
                active_rooms: 0,
                active_peers: 0,
                max_peers: 200,
                cpu_usage_percent: 4.5,
                memory_usage_percent: 18.0,
                bandwidth_mbps: 1.2,
                healthy: true,
                load_score: 4.3,
                last_seen: now,
            });
        }

        nodes.sort_by(|a, b| {
            b.healthy.cmp(&a.healthy).then_with(|| {
                a.load_score
                    .partial_cmp(&b.load_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        nodes
    }

    pub fn select_least_loaded_node(&self, preferred_region: Option<&str>) -> MediaNodeInfo {
        let nodes = self.list_nodes_sorted();
        if let Some(region) = preferred_region {
            if let Some(regional) = nodes
                .iter()
                .find(|n| n.healthy && n.region.eq_ignore_ascii_case(region))
            {
                return regional.clone();
            }
        }
        nodes
            .into_iter()
            .find(|n| n.healthy)
            .unwrap_or_else(|| MediaNodeInfo {
                node_id: "node-fallback-1".to_string(),
                name: "Fallback Media Node".to_string(),
                region: "RU-Central".to_string(),
                ws_url: "ws://127.0.0.1:4101/ws/sfu".to_string(),
                http_url: "http://127.0.0.1:4101".to_string(),
                active_rooms: 0,
                active_peers: 0,
                max_peers: 200,
                cpu_usage_percent: 5.0,
                memory_usage_percent: 15.0,
                bandwidth_mbps: 0.0,
                healthy: true,
                load_score: 4.0,
                last_seen: Utc::now(),
            })
    }

    pub fn send_to_user(&self, user_id: &Uuid, msg: &ControlToClientMsg) {
        if let Some(conns) = self.sessions.get(user_id) {
            for (_conn_id, tx) in conns.iter() {
                let _ = tx.send(msg.clone());
            }
        }
    }

    pub fn broadcast_all(&self, msg: &ControlToClientMsg) {
        for entry in self.sessions.iter() {
            for (_conn_id, tx) in entry.value().iter() {
                let _ = tx.send(msg.clone());
            }
        }
    }

    pub fn broadcast_to_room(&self, room_id: &Uuid, msg: &ControlToClientMsg) {
        if let Some(room) = self.rooms.get(room_id) {
            for p in &room.participants {
                self.send_to_user(&p.user_id, msg);
            }
        }
    }
}
