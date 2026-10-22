//! Proof-of-work при регистрации: сервер выдаёт подписанную одноразовую задачу,
//! клиент подбирает число, при котором SHA-256(`задача:число`) начинается с нужного
//! количества нулевых бит. Для человека это 1–2 секунды, для массовой регистрации — дорого.

use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    sync::Mutex,
};

use axum::http::HeaderMap;
use dashmap::DashMap;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Базовая сложность: ~130 тыс. хешей, в браузере и на телефоне — меньше секунды.
pub const BASE_BITS: u32 = 17;
/// Предельная сложность при наплыве регистраций (~2 млн хешей, 5–10 секунд).
pub const MAX_BITS: u32 = 21;
/// Сколько живёт задача.
pub const CHALLENGE_TTL_SECS: i64 = 300;
/// Каждые столько регистраций за 10 минут добавляют один бит сложности.
const REGISTRATIONS_PER_EXTRA_BIT: usize = 25;
const SURGE_WINDOW_SECS: i64 = 600;

#[derive(Debug, Serialize)]
pub struct PowChallenge {
    pub challenge: String,
    pub difficulty: u32,
    pub expires_at: i64,
}

pub struct PowGuard {
    secret: [u8; 32],
    /// Решённые задачи до истечения срока: одна задача — одна регистрация
    used: DashMap<String, i64>,
    recent_registrations: Mutex<VecDeque<i64>>,
}

impl Default for PowGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl PowGuard {
    pub fn new() -> Self {
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        Self {
            secret,
            used: DashMap::new(),
            recent_registrations: Mutex::new(VecDeque::new()),
        }
    }

    fn sign(&self, payload: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC accepts any key length");
        mac.update(payload.as_bytes());
        to_hex(&mac.finalize().into_bytes())
    }

    /// Текущая сложность: растёт, если за последние 10 минут много регистраций.
    pub fn current_bits(&self, now: i64) -> u32 {
        let mut recent = self.recent_registrations.lock().unwrap_or_else(|e| e.into_inner());
        while recent.front().is_some_and(|t| *t < now - SURGE_WINDOW_SECS) {
            recent.pop_front();
        }
        let extra = (recent.len() / REGISTRATIONS_PER_EXTRA_BIT) as u32;
        (BASE_BITS + extra).min(MAX_BITS)
    }

    pub fn note_registration(&self, now: i64) {
        let mut recent = self.recent_registrations.lock().unwrap_or_else(|e| e.into_inner());
        recent.push_back(now);
        if recent.len() > 10_000 {
            recent.pop_front();
        }
    }

    pub fn issue(&self, now: i64) -> PowChallenge {
        let difficulty = self.current_bits(now);
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        let expires_at = now + CHALLENGE_TTL_SECS;
        let payload = format!("v1.{}.{}.{}", to_hex(&nonce), difficulty, expires_at);
        let sig = self.sign(&payload);
        PowChallenge {
            challenge: format!("{payload}.{sig}"),
            difficulty,
            expires_at,
        }
    }

    /// Проверяет подпись, срок, решение и одноразовость задачи.
    pub fn verify(&self, challenge: &str, solution: &str, now: i64) -> Result<(), &'static str> {
        if challenge.len() > 256 || solution.is_empty() || solution.len() > 32 {
            return Err("invalid");
        }
        let parts: Vec<&str> = challenge.split('.').collect();
        let [version, _nonce, bits, exp, sig] = parts.as_slice() else {
            return Err("invalid");
        };
        if *version != "v1" {
            return Err("invalid");
        }
        let payload = &challenge[..challenge.len() - sig.len() - 1];
        let expected = self.sign(payload);
        if !bool::from(subtle::ConstantTimeEq::ct_eq(expected.as_bytes(), sig.as_bytes())) {
            return Err("invalid");
        }
        let bits: u32 = bits.parse().map_err(|_| "invalid")?;
        let exp: i64 = exp.parse().map_err(|_| "invalid")?;
        if exp < now {
            return Err("expired");
        }
        let digest = Sha256::digest(format!("{challenge}:{solution}").as_bytes());
        if leading_zero_bits(&digest) < bits {
            return Err("unsolved");
        }
        if self.used.len() > 50_000 {
            self.used.retain(|_, e| *e >= now);
        }
        if self.used.insert(challenge.to_string(), exp).is_some() {
            return Err("reused");
        }
        Ok(())
    }
}

pub fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for byte in hash {
        if *byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// IP клиента. За прокси (`LIAPER_TRUSTED_PROXY_HOPS` = число своих прокси) берётся адрес из
/// `X-Forwarded-For`, который добавил ближайший доверенный прокси; подделать его клиент не может.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    let hops: usize = std::env::var("LIAPER_TRUSTED_PROXY_HOPS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    client_ip_with_hops(headers, peer, hops)
}

fn client_ip_with_hops(headers: &HeaderMap, peer: SocketAddr, hops: usize) -> IpAddr {
    if hops == 0 {
        return peer.ip();
    }
    let chain: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if chain.is_empty() {
        return peer.ip();
    }
    let idx = chain.len().saturating_sub(hops);
    chain[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solve(ch: &PowChallenge) -> String {
        (0u64..)
            .map(|n| n.to_string())
            .find(|n| {
                leading_zero_bits(&Sha256::digest(format!("{}:{}", ch.challenge, n).as_bytes())) >= ch.difficulty
            })
            .unwrap()
    }

    #[test]
    fn challenge_is_signed_single_use_and_expires() {
        let guard = PowGuard::new();
        let now = 1_000_000;
        let ch = guard.issue(now);
        assert_eq!(ch.difficulty, BASE_BITS);
        let solution = solve(&ch);
        assert_eq!(guard.verify(&ch.challenge, "0", now).err(), if solution == "0" { None } else { Some("unsolved") });
        assert!(guard.verify(&ch.challenge, &solution, now).is_ok());
        assert_eq!(guard.verify(&ch.challenge, &solution, now), Err("reused"));

        // Подделка сложности ломает подпись
        let ch2 = guard.issue(now);
        let forged = ch2.challenge.replacen(&format!(".{BASE_BITS}."), ".1.", 1);
        assert_eq!(guard.verify(&forged, "1", now), Err("invalid"));
        // Чужой сервер (другой секрет)
        assert_eq!(PowGuard::new().verify(&ch2.challenge, "1", now), Err("invalid"));
        // Просроченная задача
        assert_eq!(guard.verify(&ch2.challenge, "1", now + CHALLENGE_TTL_SECS + 1), Err("expired"));
    }

    #[test]
    fn difficulty_grows_with_registration_surge() {
        let guard = PowGuard::new();
        let now = 5_000;
        for _ in 0..(REGISTRATIONS_PER_EXTRA_BIT * 2) {
            guard.note_registration(now);
        }
        assert_eq!(guard.current_bits(now), BASE_BITS + 2);
        assert_eq!(guard.current_bits(now + SURGE_WINDOW_SECS + 1), BASE_BITS);
        for _ in 0..1000 {
            guard.note_registration(now);
        }
        assert_eq!(guard.current_bits(now), MAX_BITS);
    }

    #[test]
    fn client_ip_uses_trusted_proxy_hop() {
        let peer: SocketAddr = "10.0.0.5:5000".parse().unwrap();
        let mut h = HeaderMap::new();
        // Клиент подставил фальшивый адрес, Caddy и nginx дописали настоящие
        h.insert("x-forwarded-for", "6.6.6.6, 203.0.113.7, 172.18.0.3".parse().unwrap());
        assert_eq!(client_ip_with_hops(&h, peer, 0), peer.ip());
        assert_eq!(client_ip_with_hops(&h, peer, 1).to_string(), "172.18.0.3");
        assert_eq!(client_ip_with_hops(&h, peer, 2).to_string(), "203.0.113.7");
        assert_eq!(client_ip_with_hops(&HeaderMap::new(), peer, 2), peer.ip());
    }
}
