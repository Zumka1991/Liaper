//! Signed capabilities authorize opaque ciphertext operations; never include encryption keys.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chrono::{DateTime, Months, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

pub const MAX_BLOB_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Upload,
    Download,
    Receipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTicket {
    pub blob_id: Uuid,
    pub node_id: String,
    pub operation: Operation,
    pub size_bytes: u64,
    pub sha256: String,
    pub valid_until: DateTime<Utc>,
    pub retain_until: Option<DateTime<Utc>>,
}

impl FileTicket {
    pub fn sign(&self, secret: &[u8]) -> String {
        let payload = B64.encode(serde_json::to_vec(self).expect("ticket serialization"));
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC key");
        mac.update(payload.as_bytes());
        format!("{}.{}", payload, B64.encode(mac.finalize().into_bytes()))
    }
    pub fn verify(token: &str, secret: &[u8], now: DateTime<Utc>) -> Option<Self> {
        if token.len() > 2048 {
            return None;
        }
        let (payload, signature) = token.split_once('.')?;
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&B64.decode(signature).ok()?).ok()?;
        let ticket: Self = serde_json::from_slice(&B64.decode(payload).ok()?).ok()?;
        (ticket.valid_until > now
            && ticket.size_bytes >= 16
            && ticket.size_bytes <= MAX_BLOB_BYTES
            && ticket.sha256.len() == 64
            && ticket.sha256.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(ticket)
    }
}

/// A calendar month, including end-of-month clamping (Jan 31 -> Feb 28/29).
pub fn retention_end(uploaded_at: DateTime<Utc>) -> DateTime<Utc> {
    uploaded_at
        .checked_add_months(Months::new(1))
        .expect("supported retention date")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_month_clamps_and_preserves_time() {
        for (from, to) in [
            ("2024-01-31T12:34:56Z", "2024-02-29T12:34:56Z"),
            ("2025-01-31T12:34:56Z", "2025-02-28T12:34:56Z"),
            ("2026-10-22T12:34:56Z", "2026-11-22T12:34:56Z"),
        ] {
            assert_eq!(
                retention_end(from.parse().unwrap()),
                to.parse::<DateTime<Utc>>().unwrap()
            );
        }
    }
    #[test]
    fn rejects_tampering_wrong_secret_and_expiration() {
        let now = Utc::now();
        let ticket = FileTicket {
            blob_id: Uuid::new_v4(),
            node_id: "one".into(),
            operation: Operation::Upload,
            size_bytes: 32,
            sha256: "a".repeat(64),
            valid_until: now + chrono::Duration::minutes(1),
            retain_until: None,
        };
        let signed = ticket.sign(b"secret");
        assert!(FileTicket::verify(&signed, b"secret", now).is_some());
        assert!(FileTicket::verify(&signed, b"wrong", now).is_none());
        assert!(FileTicket::verify(&(signed.clone() + "x"), b"secret", now).is_none());
        assert!(FileTicket::verify(&signed, b"secret", ticket.valid_until).is_none());
    }
}
