//! Short-lived capability that lets one user join one room on a media node.
//! Issued by the control server only to room participants, verified by media nodes.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

pub const SFU_TICKET_TTL_SECS: i64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SfuTicket {
    pub room_id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub node_id: String,
    pub valid_until: DateTime<Utc>,
}

impl SfuTicket {
    pub fn new(room_id: Uuid, user_id: Uuid, username: String, node_id: String) -> Self {
        Self {
            room_id,
            user_id,
            username,
            node_id,
            valid_until: Utc::now() + Duration::seconds(SFU_TICKET_TTL_SECS),
        }
    }

    pub fn sign(&self, secret: &[u8]) -> String {
        let payload = B64.encode(serde_json::to_vec(self).expect("ticket serialization"));
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
        mac.update(b"liaper-sfu-v1:");
        mac.update(payload.as_bytes());
        format!("{}.{}", payload, B64.encode(mac.finalize().into_bytes()))
    }

    pub fn verify(token: &str, secret: &[u8], now: DateTime<Utc>) -> Option<Self> {
        if token.len() > 1024 {
            return None;
        }
        let (payload, signature) = token.split_once('.')?;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
        mac.update(b"liaper-sfu-v1:");
        mac.update(payload.as_bytes());
        mac.verify_slice(&B64.decode(signature).ok()?).ok()?;
        let ticket: Self = serde_json::from_slice(&B64.decode(payload).ok()?).ok()?;
        (ticket.valid_until > now).then_some(ticket)
    }
}

/// Shared secret between the control server and media nodes, if configured.
/// Without it nodes run in development mode and accept unsigned joins.
pub fn node_secret_from_env() -> Option<Vec<u8>> {
    std::env::var("LIAPER_NODE_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 32)
        .map(String::into_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_rejects_tampering_wrong_secret_and_expiry() {
        let ticket = SfuTicket::new(Uuid::new_v4(), Uuid::new_v4(), "anna".into(), "n1".into());
        let signed = ticket.sign(b"secret");
        let now = Utc::now();
        assert_eq!(SfuTicket::verify(&signed, b"secret", now), Some(ticket.clone()));
        assert!(SfuTicket::verify(&signed, b"other", now).is_none());
        assert!(SfuTicket::verify(&(signed.clone() + "x"), b"secret", now).is_none());
        assert!(SfuTicket::verify(&signed, b"secret", ticket.valid_until).is_none());
        let forged = format!(
            "{}.{}",
            B64.encode(serde_json::to_vec(&SfuTicket { user_id: Uuid::new_v4(), ..ticket }).unwrap()),
            signed.split_once('.').unwrap().1
        );
        assert!(SfuTicket::verify(&forged, b"secret", now).is_none());
    }
}
