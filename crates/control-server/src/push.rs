//! Push о входящих звонках через Firebase Cloud Messaging (HTTP v1).
//!
//! Шлём только data-сообщения: уведомление со звонком собирает само приложение, поэтому
//! оно звонит и тогда, когда процесс был выгружен. В payload нет содержимого переписки —
//! только кто звонит и id комнаты.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tracing::{info, warn};
use uuid::Uuid;

use crate::state::ControlState;

const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Звонок дольше не ждут: устаревший push не должен звонить
const CALL_TTL: &str = "45s";

#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
}

pub struct FcmClient {
    project_id: String,
    client_email: String,
    key: jsonwebtoken::EncodingKey,
    http: reqwest::Client,
    access_token: tokio::sync::Mutex<Option<(String, Instant)>>,
}

pub enum SendError {
    /// Токен больше не действителен (приложение удалено, данные сброшены) — забываем его
    InvalidToken,
    Other(String),
}

impl FcmClient {
    /// `FCM_SERVICE_ACCOUNT_FILE` или `secrets/fcm-service-account.json`; без файла push выключен.
    pub fn from_env() -> Option<Arc<Self>> {
        let path = std::env::var("FCM_SERVICE_ACCOUNT_FILE")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("secrets/fcm-service-account.json"));
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => {
                info!("FCM push disabled: no service account at {}", path.display());
                return None;
            }
        };
        let account: ServiceAccount = match serde_json::from_str(&raw) {
            Ok(a) => a,
            Err(e) => {
                warn!("FCM push disabled: invalid service account JSON: {}", e);
                return None;
            }
        };
        let key = match jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes()) {
            Ok(k) => k,
            Err(e) => {
                warn!("FCM push disabled: invalid private key: {}", e);
                return None;
            }
        };
        info!("FCM push enabled for project {}", account.project_id);
        Some(Arc::new(Self {
            project_id: account.project_id,
            client_email: account.client_email,
            key,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            access_token: tokio::sync::Mutex::new(None),
        }))
    }

    async fn access_token(&self) -> Result<String, String> {
        let mut cached = self.access_token.lock().await;
        if let Some((token, expires)) = cached.as_ref() {
            if Instant::now() + Duration::from_secs(60) < *expires {
                return Ok(token.clone());
            }
        }
        let now = chrono::Utc::now().timestamp();
        let claims = serde_json::json!({
            "iss": self.client_email,
            "scope": SCOPE,
            "aud": TOKEN_URI,
            "iat": now,
            "exp": now + 3600,
        });
        let assertion = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &claims,
            &self.key,
        )
        .map_err(|e| e.to_string())?;

        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
            expires_in: u64,
        }
        let res = self
            .http
            .post(TOKEN_URI)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let status = res.status();
            return Err(format!("OAuth {}: {}", status, res.text().await.unwrap_or_default()));
        }
        let body: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
        *cached = Some((
            body.access_token.clone(),
            Instant::now() + Duration::from_secs(body.expires_in),
        ));
        Ok(body.access_token)
    }

    pub async fn send_data(
        &self,
        device_token: &str,
        data: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), SendError> {
        let access = self.access_token().await.map_err(SendError::Other)?;
        let body = serde_json::json!({
            "message": {
                "token": device_token,
                "data": data,
                "android": { "priority": "HIGH", "ttl": CALL_TTL },
            }
        });
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.project_id
        );
        let res = self
            .http
            .post(url)
            .bearer_auth(access)
            .json(&body)
            .send()
            .await
            .map_err(|e| SendError::Other(e.to_string()))?;
        if res.status().is_success() {
            return Ok(());
        }
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        // 404 UNREGISTERED — токен отозван; 400 с INVALID_ARGUMENT про токен — мусорный токен
        if status == reqwest::StatusCode::NOT_FOUND
            || text.contains("UNREGISTERED")
            || (status == reqwest::StatusCode::BAD_REQUEST && text.contains("registration token"))
        {
            return Err(SendError::InvalidToken);
        }
        Err(SendError::Other(format!("FCM {}: {}", status, text)))
    }
}

#[cfg(test)]
mod tests {
    /// Проверка ключа и прав сервисного аккаунта без реальной отправки:
    /// `FCM_SERVICE_ACCOUNT_FILE=... cargo test -p liaper-control-server fcm_credentials -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn fcm_credentials_are_valid() {
        let fcm = super::FcmClient::from_env().expect("service account not loaded");
        let access = fcm.access_token().await.expect("OAuth token");
        let res = fcm
            .http
            .post(format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                fcm.project_id
            ))
            .bearer_auth(access)
            .json(&serde_json::json!({
                "validate_only": true,
                "message": { "topic": "liaper-credentials-check", "data": { "type": "ping" } }
            }))
            .send()
            .await
            .unwrap();
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        assert!(status.is_success(), "FCM {}: {}", status, body);
    }
}

fn send_to_user(state: &Arc<ControlState>, user_id: Uuid, data: serde_json::Map<String, serde_json::Value>) {
    let Some(fcm) = state.fcm.clone() else { return };
    let tokens: Vec<String> = state
        .push_tokens
        .get(&user_id)
        .map(|t| t.iter().cloned().collect())
        .unwrap_or_default();
    for token in tokens {
        let state = state.clone();
        let fcm = fcm.clone();
        let data = data.clone();
        tokio::spawn(async move {
            match fcm.send_data(&token, &data).await {
                Ok(()) => {}
                Err(SendError::InvalidToken) => state.remove_push_token(&token).await,
                Err(SendError::Other(e)) => warn!("FCM push to {} failed: {}", user_id, e),
            }
        });
    }
}

/// Разбудить устройства адресата входящим звонком
pub fn notify_incoming_call(
    state: &Arc<ControlState>,
    user_id: Uuid,
    room_id: Uuid,
    room_title: &str,
    caller_name: &str,
    with_video: bool,
) {
    let mut data = serde_json::Map::new();
    data.insert("type".into(), "incoming_call".into());
    data.insert("room_id".into(), room_id.to_string().into());
    data.insert("room_title".into(), room_title.into());
    data.insert("caller_name".into(), caller_name.into());
    data.insert("with_video".into(), with_video.to_string().into());
    data.insert("sent_at".into(), chrono::Utc::now().timestamp_millis().to_string().into());
    send_to_user(state, user_id, data);
}

/// Звонок больше не актуален (принят/отклонён на другом устройстве, звонящий сбросил)
pub fn notify_call_cancelled(state: &Arc<ControlState>, user_id: Uuid, room_id: Uuid) {
    let mut data = serde_json::Map::new();
    data.insert("type".into(), "call_cancel".into());
    data.insert("room_id".into(), room_id.to_string().into());
    send_to_user(state, user_id, data);
}
