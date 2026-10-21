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

    pub fn merge_public_key(&mut self, pub_key: &str, fp: &str) {
        let is_x25519 = |k: &str| -> bool {
            BASE64.decode(k.trim()).map(|b| b.len() == 32).unwrap_or(false)
        };
        let incoming_x25519: Vec<String> = pub_key
            .split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty() && is_x25519(k))
            .map(ToOwned::to_owned)
            .collect();

        if !incoming_x25519.is_empty() {
            let mut merged = Vec::new();
            for k in incoming_x25519 {
                if !merged.contains(&k) {
                    merged.push(k);
                }
            }
            for existing in self.e2ee_public_key.split(',').map(str::trim) {
                if is_x25519(existing) && !merged.iter().any(|k| k == existing) && merged.len() < 8 {
                    merged.push(existing.to_string());
                }
            }
            self.e2ee_public_key = merged.join(",");
        } else if !pub_key.trim().is_empty() {
            let has_existing_x25519 = self.e2ee_public_key.split(',').any(is_x25519);
            if !has_existing_x25519 {
                self.e2ee_public_key = pub_key.trim().to_string();
            }
        }
        if !fp.trim().is_empty() {
            self.key_fingerprint = fp.trim().to_string();
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisclosedRoomKey {
    pub room_key_id: String,
    pub secret_key_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAbuseReport {
    pub id: Uuid,
    pub room_id: Uuid,
    pub room_title: String,
    pub reporter_id: Uuid,
    pub reporter_username: String,
    pub reporter_display_name: String,
    pub reason: String,
    pub disclosed_keys: Vec<DisclosedRoomKey>,
    pub messages_snapshot: Vec<EncryptedChatMessage>,
    pub status: String, // "open" | "resolved"
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminMasterCredentials {
    pub password_hash: String,
    pub salt_b64: String,
    pub updated_at: DateTime<Utc>,
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
    pub room_invitations: DashMap<Uuid, HashSet<Uuid>>,
    pub room_key_envelopes: DashMap<(Uuid, Uuid), Vec<E2eeKeyEnvelope>>,
    pub room_chats: DashMap<Uuid, Vec<EncryptedChatMessage>>,
    pub reports: DashMap<Uuid, ChatAbuseReport>,
    pub releases: DashMap<AppPlatform, AppReleaseManifest>,
    pub storage_path: PathBuf,
    pub contacts_path: PathBuf,
    pub chats_path: PathBuf,
    pub envelopes_path: PathBuf,
    pub sessions_path: PathBuf,
    pub reports_path: PathBuf,
    pub releases_path: PathBuf,
    pub admin_auth_path: PathBuf,
    pub admin_master_creds: std::sync::RwLock<Option<AdminMasterCredentials>>,
    pub admin_usernames: HashSet<String>,
    pub admin_secret: Option<String>,
    pub antifraud: crate::antifraud::AntiFraudEngine,
    pub pg_client: tokio::sync::RwLock<Option<Arc<tokio_postgres::Client>>>,
    pub contact_mutations: tokio::sync::Mutex<()>,
}

impl ControlState {
    pub fn new(storage_path: PathBuf) -> Arc<Self> {
        let base_dir = storage_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("data"));
        let contacts_path = base_dir.join("contacts.json");
        let chats_path = base_dir.join("chats.json");
        let envelopes_path = base_dir.join("envelopes.json");
        let sessions_path = base_dir.join("sessions.json");
        let reports_path = base_dir.join("reports.json");
        let releases_path = base_dir.join("releases.json");
        let admin_auth_path = base_dir.join("admin_auth.json");
        let admin_secret = std::env::var("LIAPER_ADMIN_SECRET")
            .ok()
            .filter(|secret| !secret.trim().is_empty());
        let raw_admins = std::env::var("LIAPER_ADMIN_USERNAMES")
            .unwrap_or_else(|_| "napsy,admin".to_string());
        let admin_usernames: HashSet<String> = raw_admins
            .split(',')
            .map(Self::normalize_username)
            .filter(|s| !s.is_empty())
            .collect();

        let state = Arc::new(Self {
            users_by_id: DashMap::new(),
            user_id_by_username: DashMap::new(),
            tokens: DashMap::new(),
            sessions: DashMap::new(),
            contacts_by_user: DashMap::new(),
            contact_requests: DashMap::new(),
            media_nodes: DashMap::new(),
            rooms: DashMap::new(),
            room_invitations: DashMap::new(),
            room_key_envelopes: DashMap::new(),
            room_chats: DashMap::new(),
            reports: DashMap::new(),
            releases: DashMap::new(),
            storage_path,
            contacts_path,
            chats_path,
            envelopes_path,
            sessions_path,
            reports_path,
            releases_path,
            admin_auth_path,
            admin_master_creds: std::sync::RwLock::new(None),
            admin_usernames,
            admin_secret,
            antifraud: crate::antifraud::AntiFraudEngine::new(),
            pg_client: tokio::sync::RwLock::new(None),
            contact_mutations: tokio::sync::Mutex::new(()),
        });
        state.load_users_from_disk();
        state.load_contacts_from_disk();
        state.load_chats_from_disk();
        state.load_envelopes_from_disk();
        state.load_sessions_from_disk();
        state.load_reports_from_disk();
        state.load_admin_auth_from_disk();
        state.load_or_seed_releases();
        state
    }

    /// Import existing local records once, then load PostgreSQL as the source of truth.
    pub async fn init_postgres(&self, database_url: &str) -> anyhow::Result<()> {
        let (client, connection) =
            tokio_postgres::connect(database_url, tokio_postgres::NoTls).await?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::error!("PostgreSQL connection lost: {}", e);
            }
        });
        client
            .batch_execute(include_str!("../../../docker/init.sql"))
            .await?;
        let client = Arc::new(client);
        // Import legacy JSON once for this database, not on every restart.
        let migration_path = self.storage_path.with_extension("postgres-imported");
        let migration_id = format!("{:x}", Sha256::digest(database_url.as_bytes()));
        let needs_import =
            std::fs::read_to_string(&migration_path).ok().as_deref() != Some(migration_id.as_str());
        if needs_import {
            for entry in self.users_by_id.iter() {
                let user = entry.value().clone();
                self.write_user(&client, &user).await?;
            }
            for entry in self.contacts_by_user.iter() {
                let a = *entry.key();
                for b in entry.value().iter() {
                    if a < *b {
                        client.execute("INSERT INTO contacts (user_a,user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING", &[&a,b]).await?;
                    }
                }
            }
            for entry in self.contact_requests.iter() {
                let req = entry.value().clone();
                client.execute("INSERT INTO contact_requests (id,from_user_id,to_user_id,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&req.id,&req.from_user_id,&req.to_user_id,&req.created_at]).await?;
            }
            for entry in self.room_chats.iter() {
                let messages = entry.value().clone();
                for msg in messages {
                    Self::write_chat(&client, &msg).await?;
                }
            }
        }
        // Clear local copies before loading; otherwise JSON + PG duplicated every message.
        self.users_by_id.clear();
        self.user_id_by_username.clear();
        for row in client.query("SELECT id,username,display_name,role,password_hash,password_salt,e2ee_public_key,key_fingerprint FROM users", &[]).await? {
            let user = StoredUser {
                id: row.get(0), username: row.get(1), display_name: row.get(2),
                role: if row.get::<_,String>(3) == "tutor" { UserRole::Tutor } else { UserRole::Student },
                password_hash: row.get(4), salt_b64: row.get(5), e2ee_public_key: row.get(6), key_fingerprint: row.get(7),
            };
            self.user_id_by_username.insert(user.username.clone(),user.id);
            self.users_by_id.insert(user.id,user);
        }
        self.contacts_by_user.clear();
        for row in client
            .query("SELECT user_a,user_b FROM contacts", &[])
            .await?
        {
            let a: Uuid = row.get(0);
            let b: Uuid = row.get(1);
            self.contacts_by_user.entry(a).or_default().insert(b);
            self.contacts_by_user.entry(b).or_default().insert(a);
        }
        self.contact_requests.clear();
        for row in client
            .query(
                "SELECT id,from_user_id,to_user_id,created_at FROM contact_requests",
                &[],
            )
            .await?
        {
            let req = StoredContactRequest {
                id: row.get(0),
                from_user_id: row.get(1),
                to_user_id: row.get(2),
                created_at: row.get(3),
            };
            self.contact_requests.insert(req.id, req);
        }
        self.room_chats.clear();
        let _ = client
            .execute(
                "ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ",
                &[],
            )
            .await;
        for row in client.query("SELECT id,room_id,sender_id,sender_username,sender_display_name,ciphertext_b64,iv_b64,room_key_id,created_at,edited_at FROM chat_messages ORDER BY created_at ASC", &[]).await? {
            let msg=EncryptedChatMessage{id:row.get(0),room_id:row.get(1),sender_id:row.get(2),sender_username:row.get(3),sender_display_name:row.get(4),ciphertext_b64:row.get(5),iv_b64:row.get(6),room_key_id:row.get(7),created_at:row.get(8),edited_at:row.get(9)};
            self.room_chats.entry(msg.room_id).or_default().push(msg);
        }
        for entry in self.room_key_envelopes.iter() {
            for env in entry.value().iter() {
                if self.users_by_id.contains_key(&env.sender_id)
                    && self.users_by_id.contains_key(&env.recipient_id)
                {
                    let _ = Self::write_key_envelope(&client, env).await;
                }
            }
        }
        self.room_key_envelopes.clear();
        for row in client.query("SELECT room_id,sender_id,sender_username,sender_public_key,recipient_id,recipient_username,encrypted_room_key_b64,iv_b64,room_key_id FROM e2ee_key_envelopes ORDER BY created_at ASC", &[]).await? {
            let env = E2eeKeyEnvelope {
                room_id: row.get(0),
                sender_id: row.get(1),
                sender_username: row.get(2),
                sender_public_key: row.get(3),
                recipient_id: row.get(4),
                recipient_username: row.get(5),
                encrypted_room_key_b64: row.get(6),
                iv_b64: row.get(7),
                room_key_id: row.get(8),
            };
            self.upsert_key_envelope_in_memory(env);
        }
        for entry in self.tokens.iter() {
            let token = entry.key().clone();
            let uid = *entry.value();
            if self.users_by_id.contains_key(&uid) {
                let _ = client
                    .execute(
                        "INSERT INTO user_sessions (token,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
                        &[&token, &uid],
                    )
                    .await;
            }
        }
        for row in client
            .query("SELECT token,user_id FROM user_sessions", &[])
            .await?
        {
            let token: String = row.get(0);
            let uid: Uuid = row.get(1);
            self.tokens.insert(token, uid);
        }
        if let Some(parent) = migration_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&migration_path, migration_id)?;
        *self.pg_client.write().await = Some(client);
        tracing::info!("PostgreSQL ready: users, contacts, encrypted messages and lesson archives");
        Ok(())
    }

    async fn write_key_envelope(
        client: &tokio_postgres::Client,
        e: &E2eeKeyEnvelope,
    ) -> Result<(), tokio_postgres::Error> {
        client
            .execute(
                "INSERT INTO e2ee_key_envelopes (room_id,sender_id,sender_username,sender_public_key,recipient_id,recipient_username,encrypted_room_key_b64,iv_b64,room_key_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
                &[
                    &e.room_id,
                    &e.sender_id,
                    &e.sender_username,
                    &e.sender_public_key,
                    &e.recipient_id,
                    &e.recipient_username,
                    &e.encrypted_room_key_b64,
                    &e.iv_b64,
                    &e.room_key_id,
                ],
            )
            .await?;
        Ok(())
    }

    pub fn upsert_key_envelope_in_memory(&self, env: E2eeKeyEnvelope) -> bool {
        let mut list = self
            .room_key_envelopes
            .entry((env.room_id, env.recipient_id))
            .or_default();
        let exists = list.iter().any(|existing| {
            existing.room_key_id == env.room_key_id
                && existing.sender_public_key == env.sender_public_key
                && existing.encrypted_room_key_b64 == env.encrypted_room_key_b64
        });
        if !exists {
            list.push(env);
            true
        } else {
            false
        }
    }

    pub async fn persist_key_envelope(&self, env: &E2eeKeyEnvelope) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            Self::write_key_envelope(&client, env).await?;
        }
        Ok(())
    }

    pub fn envelopes_for_recipient(&self, recipient_id: &Uuid) -> Vec<E2eeKeyEnvelope> {
        let mut out = Vec::new();
        for entry in self.room_key_envelopes.iter() {
            if entry.key().1 == *recipient_id {
                out.extend(entry.value().iter().cloned());
            }
        }
        out
    }

    pub fn load_envelopes_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.envelopes_path) {
            if let Ok(envelopes) = serde_json::from_str::<Vec<E2eeKeyEnvelope>>(&content) {
                for env in envelopes {
                    self.upsert_key_envelope_in_memory(env);
                }
            }
        }
    }

    pub fn save_envelopes_to_disk(&self) {
        if let Some(parent) = self.envelopes_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut all = Vec::new();
        for entry in self.room_key_envelopes.iter() {
            all.extend(entry.value().iter().cloned());
        }
        if let Ok(json) = serde_json::to_string_pretty(&all) {
            let _ = std::fs::write(&self.envelopes_path, json);
        }
    }

    pub fn load_sessions_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.sessions_path) {
            if let Ok(pairs) = serde_json::from_str::<Vec<(String, Uuid)>>(&content) {
                for (token, uid) in pairs {
                    self.tokens.insert(token, uid);
                }
            }
        }
    }

    pub fn save_sessions_to_disk(&self) {
        if let Some(parent) = self.sessions_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let pairs: Vec<(String, Uuid)> = self
            .tokens
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&pairs) {
            let _ = std::fs::write(&self.sessions_path, json);
        }
    }

    pub async fn persist_session(&self, token: &str, user_id: Uuid) {
        self.tokens.insert(token.to_string(), user_id);
        self.save_sessions_to_disk();
        if let Some(client) = self.pg_client.read().await.clone() {
            let _ = client
                .execute(
                    "INSERT INTO user_sessions (token,user_id) VALUES ($1,$2) ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id",
                    &[&token, &user_id],
                )
                .await;
        }
    }

    async fn write_user(
        &self,
        client: &tokio_postgres::Client,
        u: &StoredUser,
    ) -> Result<(), tokio_postgres::Error> {
        let role = if u.role == UserRole::Tutor {
            "tutor"
        } else {
            "student"
        };
        client.execute("INSERT INTO users (id,username,display_name,role,password_hash,password_salt,e2ee_public_key,key_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,e2ee_public_key=EXCLUDED.e2ee_public_key,key_fingerprint=EXCLUDED.key_fingerprint", &[&u.id,&u.username,&u.display_name,&role,&u.password_hash,&u.salt_b64,&u.e2ee_public_key,&u.key_fingerprint]).await?;
        Ok(())
    }

    pub async fn persist_user(&self, user: &StoredUser) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            self.write_user(&client, user).await?;
        }
        Ok(())
    }

    async fn write_chat(
        client: &tokio_postgres::Client,
        m: &EncryptedChatMessage,
    ) -> Result<(), tokio_postgres::Error> {
        client
            .execute(
                "INSERT INTO chat_messages (id,room_id,sender_id,sender_username,sender_display_name,ciphertext_b64,iv_b64,room_key_id,created_at,edited_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET ciphertext_b64=EXCLUDED.ciphertext_b64, iv_b64=EXCLUDED.iv_b64, room_key_id=EXCLUDED.room_key_id, edited_at=EXCLUDED.edited_at",
                &[
                    &m.id,
                    &m.room_id,
                    &m.sender_id,
                    &m.sender_username,
                    &m.sender_display_name,
                    &m.ciphertext_b64,
                    &m.iv_b64,
                    &m.room_key_id,
                    &m.created_at,
                    &m.edited_at,
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn persist_chat(&self, msg: &EncryptedChatMessage) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            Self::write_chat(&client, msg).await?;
        }
        Ok(())
    }

    pub async fn delete_chat_from_pg(
        &self,
        message_id: &Uuid,
        room_id: &Uuid,
        sender_id: &Uuid,
    ) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            client
                .execute(
                    "DELETE FROM chat_messages WHERE id=$1 AND room_id=$2 AND sender_id=$3",
                    &[message_id, room_id, sender_id],
                )
                .await?;
        }
        Ok(())
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

    pub fn is_admin_username(&self, username: &str) -> bool {
        self.admin_usernames
            .contains(&Self::normalize_username(username))
    }

    pub fn is_admin_password_configured(&self) -> bool {
        if self
            .admin_master_creds
            .read()
            .ok()
            .and_then(|g| g.clone())
            .is_some()
        {
            return true;
        }
        std::env::var("LIAPER_ADMIN_PASSWORD")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .is_some()
    }

    pub fn verify_admin_password(&self, password: &str) -> bool {
        if let Some(creds) = self.admin_master_creds.read().ok().and_then(|g| g.clone()) {
            return Self::hash_password(password, &creds.salt_b64) == creds.password_hash;
        }
        if let Ok(env_pass) = std::env::var("LIAPER_ADMIN_PASSWORD") {
            let trimmed = env_pass.trim();
            if !trimmed.is_empty() {
                return password == trimmed;
            }
        }
        false
    }

    pub fn set_admin_password(&self, new_password: &str) {
        let salt_b64 = Self::generate_salt();
        let password_hash = Self::hash_password(new_password, &salt_b64);
        let creds = AdminMasterCredentials {
            password_hash,
            salt_b64,
            updated_at: Utc::now(),
        };
        if let Ok(mut guard) = self.admin_master_creds.write() {
            *guard = Some(creds.clone());
        }
        if let Some(parent) = self.admin_auth_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&creds) {
            let _ = std::fs::write(&self.admin_auth_path, json);
        }
    }

    pub fn load_admin_auth_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.admin_auth_path) {
            if let Ok(creds) = serde_json::from_str::<AdminMasterCredentials>(&content) {
                if let Ok(mut guard) = self.admin_master_creds.write() {
                    *guard = Some(creds);
                }
            }
        }
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
            confirmed_pairs: pairs.clone(),
            pending_requests,
        };
        if let Ok(json) = serde_json::to_string_pretty(&snap) {
            let _ = std::fs::write(&self.contacts_path, json);
        }
    }

    pub async fn persist_contact_request(&self, req: &StoredContactRequest) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            client.execute("INSERT INTO contact_requests (id,from_user_id,to_user_id,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", &[&req.id,&req.from_user_id,&req.to_user_id,&req.created_at]).await?;
        }
        Ok(())
    }

    pub async fn persist_contact_decision(
        &self,
        a: Uuid,
        b: Uuid,
        request_id: Uuid,
        accept: bool,
    ) -> anyhow::Result<()> {
        if accept {
            self.validate_student_addition(a, b)?;
        }
        if let Some(client) = self.pg_client.read().await.clone() {
            if accept {
                let result: String = client
                    .query_one("SELECT accept_tutor_student($1,$2)", &[&request_id, &b])
                    .await?
                    .get(0);
                anyhow::ensure!(
                    result == "accepted",
                    match result.as_str() {
                        "limit" =>
                            "У преподавателя уже 10 учеников. Сначала удалите одного из списка",
                        "role" =>
                            "Добавлять в контакты может только преподаватель и только учеников",
                        _ => "Заявка больше не доступна",
                    }
                );
            } else {
                client
                    .execute("DELETE FROM contact_requests WHERE id=$1", &[&request_id])
                    .await?;
            }
        }
        Ok(())
    }

    pub fn student_count(&self, tutor: Uuid) -> usize {
        self.contacts_by_user
            .get(&tutor)
            .map(|contacts| {
                contacts
                    .iter()
                    .filter(|id| {
                        self.users_by_id
                            .get(id)
                            .is_some_and(|u| u.role == UserRole::Student)
                    })
                    .count()
            })
            .unwrap_or(0)
    }
    pub fn validate_student_addition(&self, tutor: Uuid, student: Uuid) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.users_by_id
                .get(&tutor)
                .is_some_and(|u| u.role == UserRole::Tutor)
                && self
                    .users_by_id
                    .get(&student)
                    .is_some_and(|u| u.role == UserRole::Student),
            "Добавлять в контакты может только преподаватель и только учеников"
        );
        anyhow::ensure!(
            self.are_contacts(&tutor, &student) || self.student_count(tutor) < 10,
            "У преподавателя уже 10 учеников. Сначала удалите одного из списка"
        );
        Ok(())
    }

    pub async fn persist_contact_removal(&self, a: Uuid, b: Uuid) -> anyhow::Result<()> {
        if let Some(client) = self.pg_client.read().await.clone() {
            client.execute("DELETE FROM contacts WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)", &[&a,&b]).await?;
        }
        Ok(())
    }

    pub fn load_chats_from_disk(&self) {
        if let Ok(content) = std::fs::read_to_string(&self.chats_path) {
            if let Ok(messages) = serde_json::from_str::<Vec<EncryptedChatMessage>>(&content) {
                for msg in messages {
                    self.room_chats.entry(msg.room_id).or_default().push(msg);
                }
            }
        }
    }

    pub fn save_chats_to_disk(&self) {
        if let Some(parent) = self.chats_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut all_msgs = Vec::new();
        for entry in self.room_chats.iter() {
            all_msgs.extend(entry.value().iter().cloned());
        }
        if let Ok(json) = serde_json::to_string_pretty(&all_msgs) {
            let _ = std::fs::write(&self.chats_path, json);
        }
    }

    pub fn are_contacts(&self, user_a: &Uuid, user_b: &Uuid) -> bool {
        self.contacts_by_user
            .get(user_a)
            .map(|set| set.contains(user_b))
            .unwrap_or(false)
    }

    /// Вычисляет детерминированный UUID личного диалога между двумя контактами
    pub fn dm_room_id(u1: &Uuid, u2: &Uuid) -> Uuid {
        let s1 = u1.to_string().to_lowercase();
        let s2 = u2.to_string().to_lowercase();
        let (first, second) = if s1 <= s2 { (s1, s2) } else { (s2, s1) };
        let combined = format!("{}{}", &first[0..18], &second[18..36]);
        Uuid::parse_str(&combined).unwrap_or(*u1)
    }

    pub fn add_mutual_contact(&self, user_a: Uuid, user_b: Uuid) {
        self.contacts_by_user
            .entry(user_a)
            .or_default()
            .insert(user_b);
        self.contacts_by_user
            .entry(user_b)
            .or_default()
            .insert(user_a);
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
                download_url: "http://127.0.0.1:4000/releases/liaper_0.1.0_x64-setup.exe"
                    .to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    .to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ=="
                    .to_string(),
                file_size_bytes: 8_420_000,
                mandatory: false,
                published_at: now,
            },
            AppReleaseManifest {
                platform: AppPlatform::LinuxX86_64,
                version: "0.1.0".to_string(),
                build_number: 1,
                release_notes: "Базовый выпуск Liaper Desktop для Linux.".to_string(),
                download_url: "http://127.0.0.1:4000/releases/liaper_0.1.0_amd64.AppImage"
                    .to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    .to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ=="
                    .to_string(),
                file_size_bytes: 11_200_000,
                mandatory: false,
                published_at: now,
            },
            AppReleaseManifest {
                platform: AppPlatform::AndroidArm64,
                version: "0.1.0".to_string(),
                build_number: 1,
                release_notes: "Базовый выпуск Liaper Mobile для Android.".to_string(),
                download_url: "http://127.0.0.1:4000/releases/liaper-android-arm64-v0.1.0.apk"
                    .to_string(),
                sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    .to_string(),
                signature: "dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12MQ=="
                    .to_string(),
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
        let all: Vec<AppReleaseManifest> =
            self.releases.iter().map(|e| e.value().clone()).collect();
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

    pub fn load_reports_from_disk(&self) {
        if let Ok(raw) = std::fs::read_to_string(&self.reports_path) {
            if let Ok(list) = serde_json::from_str::<Vec<ChatAbuseReport>>(&raw) {
                for rep in list {
                    self.reports.insert(rep.id, rep);
                }
            }
        }
    }

    pub fn save_reports_to_disk(&self) {
        let mut list: Vec<ChatAbuseReport> =
            self.reports.iter().map(|e| e.value().clone()).collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if let Some(parent) = self.reports_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(&self.reports_path, json);
        }
    }
}
