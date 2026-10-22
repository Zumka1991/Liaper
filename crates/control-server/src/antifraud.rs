use std::collections::VecDeque;

use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

/// Максимальный размер зашифрованного текста сообщения чата (64 КиБ base64)
pub const MAX_CHAT_CIPHERTEXT_B64_LEN: usize = 65_536;
/// Максимальный размер зашифрованного конверта ключа комнаты (8 КиБ)
pub const MAX_ENVELOPE_WRAPPED_KEY_LEN: usize = 8_192;
/// Максимум одновременных WebSocket-сессий на одного пользователя
pub const MAX_WS_SESSIONS_PER_USER: usize = 6;
/// Максимум одновременных незавершённых (`pending`) резерваций файлов на пользователя
pub const MAX_PENDING_UPLOADS_PER_USER: i64 = 5;
/// Максимум одновременно созданных активных комнат на одного хоста
pub const MAX_ACTIVE_ROOMS_PER_HOST: usize = 3;
/// Максимальное число хранимых инцидентов в памяти (кольцевой буфер)
pub const MAX_STORED_INCIDENTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IncidentSeverity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityIncident {
    pub id: Uuid,
    pub timestamp: DateTime<Utc>,
    pub category: String,
    pub severity: IncidentSeverity,
    pub subject: String,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub ip: Option<String>,
    pub description: String,
    pub action_taken: String,
    pub risk_delta: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubjectThreatState {
    pub subject_key: String,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub ip: Option<String>,
    pub risk_score: u32,
    pub violations_count: u64,
    pub quarantined_until: Option<DateTime<Utc>>,
    pub last_violation_at: DateTime<Utc>,
    pub last_reason: String,
}

#[derive(Debug, Clone)]
struct RateWindow {
    timestamps: VecDeque<DateTime<Utc>>,
}

impl RateWindow {
    fn new() -> Self {
        Self {
            timestamps: VecDeque::new(),
        }
    }

    fn check_and_record(&mut self, now: DateTime<Utc>, window_secs: i64, max_count: usize) -> bool {
        let cutoff = now - Duration::seconds(window_secs);
        while let Some(&front) = self.timestamps.front() {
            if front < cutoff {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.timestamps.len() >= max_count {
            return false;
        }
        self.timestamps.push_back(now);
        true
    }
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct AntiFraudCounters {
    pub total_blocked_requests: u64,
    pub auth_bruteforce_blocked: u64,
    pub register_flood_blocked: u64,
    pub ws_flood_blocked: u64,
    pub oversized_payload_blocked: u64,
    pub call_spam_blocked: u64,
    pub upload_abuse_blocked: u64,
    pub report_spam_blocked: u64,
}

pub struct AntiFraudEngine {
    rate_windows: DashMap<String, RateWindow>,
    pub subjects: DashMap<String, SubjectThreatState>,
    pub incidents: RwLock<VecDeque<SecurityIncident>>,
    pub counters: RwLock<AntiFraudCounters>,
}

impl Default for AntiFraudEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl AntiFraudEngine {
    pub fn new() -> Self {
        Self {
            rate_windows: DashMap::new(),
            subjects: DashMap::new(),
            incidents: RwLock::new(VecDeque::with_capacity(MAX_STORED_INCIDENTS)),
            counters: RwLock::new(AntiFraudCounters::default()),
        }
    }

    /// Проверяет, не находится ли субъект (`user:<uuid>` или `ip:<addr>`) в карантине.
    pub fn check_quarantine(&self, subject_key: &str) -> Result<(), String> {
        let now = Utc::now();
        if let Some(mut entry) = self.subjects.get_mut(subject_key) {
            if let Some(until) = entry.quarantined_until {
                if until > now {
                    let remaining_secs = (until - now).num_seconds().max(1);
                    return Err(format!(
                        "Сработала защита Liaper Shield: временное ограничение ({remaining_secs} сек.) из-за подозрительной активности ({})",
                        entry.last_reason
                    ));
                } else {
                    entry.quarantined_until = None;
                    entry.risk_score = entry.risk_score / 2;
                }
            }
        }
        Ok(())
    }

    /// Проверяет лимит частоты в скользящем окне.
    pub fn allow_rate(&self, bucket_key: &str, window_secs: i64, max_count: usize) -> bool {
        let now = Utc::now();
        // Окна по IP копятся бесконечно — чистим давно неактивные
        if self.rate_windows.len() > 50_000 {
            let cutoff = now - Duration::hours(2);
            self.rate_windows
                .retain(|_, w| w.timestamps.back().is_some_and(|t| *t >= cutoff));
        }
        let mut win = self
            .rate_windows
            .entry(bucket_key.to_string())
            .or_insert_with(RateWindow::new);
        win.check_and_record(now, window_secs, max_count)
    }

    /// Записывает инцидент безопасности, увеличивает Risk Score и при необходимости включает авто-карантин.
    pub async fn record_violation(
        &self,
        subject_key: &str,
        user_id: Option<Uuid>,
        username: Option<String>,
        ip: Option<String>,
        category: &str,
        severity: IncidentSeverity,
        risk_delta: u32,
        description: String,
        quarantine_secs_if_threshold: i64,
    ) -> String {
        let now = Utc::now();
        let mut action_taken = "Запрос отклонён (Rate Limit / Guard)".to_string();

        {
            let mut counters = self.counters.write().await;
            counters.total_blocked_requests += 1;
            match category {
                "auth_bruteforce" => counters.auth_bruteforce_blocked += 1,
                "register_flood" => counters.register_flood_blocked += 1,
                "ws_flood" => counters.ws_flood_blocked += 1,
                "oversized_payload" => counters.oversized_payload_blocked += 1,
                "call_spam" => counters.call_spam_blocked += 1,
                "upload_abuse" => counters.upload_abuse_blocked += 1,
                "report_spam" => counters.report_spam_blocked += 1,
                _ => {}
            }
        }

        let mut subj = self
            .subjects
            .entry(subject_key.to_string())
            .or_insert_with(|| SubjectThreatState {
                subject_key: subject_key.to_string(),
                user_id,
                username: username.clone(),
                ip: ip.clone(),
                risk_score: 0,
                violations_count: 0,
                quarantined_until: None,
                last_violation_at: now,
                last_reason: description.clone(),
            });

        if user_id.is_some() {
            subj.user_id = user_id;
        }
        if username.is_some() {
            subj.username = username.clone();
        }
        if ip.is_some() {
            subj.ip = ip.clone();
        }
        subj.violations_count += 1;
        subj.last_violation_at = now;
        subj.last_reason = description.clone();
        subj.risk_score = (subj.risk_score + risk_delta).min(500);

        if subj.risk_score >= 100 && quarantine_secs_if_threshold > 0 {
            let until = now + Duration::seconds(quarantine_secs_if_threshold);
            subj.quarantined_until = Some(until);
            action_taken = format!(
                "Авто-карантин на {} сек. (Risk Score: {})",
                quarantine_secs_if_threshold, subj.risk_score
            );
        }
        drop(subj);

        let incident = SecurityIncident {
            id: Uuid::new_v4(),
            timestamp: now,
            category: category.to_string(),
            severity,
            subject: subject_key.to_string(),
            user_id,
            username,
            ip,
            description,
            action_taken: action_taken.clone(),
            risk_delta,
        };

        let mut list = self.incidents.write().await;
        list.push_front(incident);
        while list.len() > MAX_STORED_INCIDENTS {
            list.pop_back();
        }

        action_taken
    }

    /// Ручная разблокировка / снятие карантина из Админки.
    pub fn unblock_subject(&self, subject_key: &str) -> bool {
        self.rate_windows
            .retain(|k, _| !k.contains(subject_key));
        if let Some(mut entry) = self.subjects.get_mut(subject_key) {
            entry.quarantined_until = None;
            entry.risk_score = 0;
            return true;
        }
        false
    }

    /// Ручное помещение субъекта в карантин из Админки.
    pub async fn manual_quarantine(
        &self,
        subject_key: &str,
        user_id: Option<Uuid>,
        username: Option<String>,
        duration_secs: i64,
        reason: String,
    ) {
        let now = Utc::now();
        let until = now + Duration::seconds(duration_secs.max(60));
        let mut subj = self
            .subjects
            .entry(subject_key.to_string())
            .or_insert_with(|| SubjectThreatState {
                subject_key: subject_key.to_string(),
                user_id,
                username: username.clone(),
                ip: None,
                risk_score: 100,
                violations_count: 1,
                quarantined_until: Some(until),
                last_violation_at: now,
                last_reason: reason.clone(),
            });
        subj.risk_score = subj.risk_score.max(100);
        subj.quarantined_until = Some(until);
        subj.last_reason = reason.clone();
        subj.last_violation_at = now;
        drop(subj);

        let mut list = self.incidents.write().await;
        list.push_front(SecurityIncident {
            id: Uuid::new_v4(),
            timestamp: now,
            category: "manual_admin_block".to_string(),
            severity: IncidentSeverity::High,
            subject: subject_key.to_string(),
            user_id,
            username,
            ip: None,
            description: reason,
            action_taken: format!("Карантин из Админки на {} мин.", duration_secs / 60),
            risk_delta: 100,
        });
        while list.len() > MAX_STORED_INCIDENTS {
            list.pop_back();
        }
    }

    /// Формирует сводку антифрод-системы для `GET /api/admin/overview`.
    pub async fn snapshot_for_admin(&self) -> serde_json::Value {
        let now = Utc::now();
        let counters = self.counters.read().await.clone();
        let incidents: Vec<SecurityIncident> =
            self.incidents.read().await.iter().take(60).cloned().collect();

        let mut subjects: Vec<SubjectThreatState> = self
            .subjects
            .iter()
            .map(|e| e.value().clone())
            .collect();
        subjects.sort_by(|a, b| {
            b.risk_score
                .cmp(&a.risk_score)
                .then_with(|| b.last_violation_at.cmp(&a.last_violation_at))
        });

        let active_quarantines = subjects
            .iter()
            .filter(|s| s.quarantined_until.is_some_and(|u| u > now))
            .count();

        serde_json::json!({
            "status": "active",
            "active_quarantines": active_quarantines,
            "tracked_subjects": subjects.len(),
            "counters": counters,
            "policies": [
                {
                    "code": "auth_bruteforce_guard",
                    "title": "Защита от брутфорса паролей и архивов",
                    "limit": "Макс. 8 неудачных попыток за 5 мин. → Карантин 5 мин."
                },
                {
                    "code": "sybil_register_guard",
                    "title": "Анти-бот регистрация (Sybil Guard)",
                    "limit": "Макс. 5 регистраций за 10 мин. с одного источника"
                },
                {
                    "code": "ws_session_cap",
                    "title": "Защита от шторма WebSocket-соединений",
                    "limit": format!("Макс. {} одновременных сессий на аккаунт", MAX_WS_SESSIONS_PER_USER)
                },
                {
                    "code": "payload_memory_bomb_guard",
                    "title": "Защита ОЗУ от Memory Bomb в E2EE чате и конвертах",
                    "limit": format!("Ciphertext ≤ {} КиБ, Key Envelope ≤ {} КиБ", MAX_CHAT_CIPHERTEXT_B64_LEN / 1024, MAX_ENVELOPE_WRAPPED_KEY_LEN / 1024)
                },
                {
                    "code": "call_bombing_guard",
                    "title": "Защита от Call Bombing и спама комнатами",
                    "limit": format!("Макс. 6 вызовов/мин. и не более {} активных комнат на хоста", MAX_ACTIVE_ROOMS_PER_HOST)
                },
                {
                    "code": "pending_upload_exhaustion_guard",
                    "title": "Защита файловой ноды от Pending Quota Exhaustion",
                    "limit": format!("Не более {} незавершённых резерваций и 20 загрузок/мин.", MAX_PENDING_UPLOADS_PER_USER)
                }
            ],
            "subjects": subjects,
            "incidents": incidents,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rate_window_blocks_after_limit_and_triggers_quarantine() {
        let engine = AntiFraudEngine::new();
        for _ in 0..3 {
            assert!(engine.allow_rate("login:test", 60, 3));
        }
        assert!(!engine.allow_rate("login:test", 60, 3));

        engine
            .record_violation(
                "user:attacker",
                None,
                Some("attacker".into()),
                Some("127.0.0.1".into()),
                "auth_bruteforce",
                IncidentSeverity::High,
                100,
                "Перебор пароля".into(),
                300,
            )
            .await;

        assert!(engine.check_quarantine("user:attacker").is_err());
        assert!(engine.unblock_subject("user:attacker"));
        assert!(engine.check_quarantine("user:attacker").is_ok());
    }
}
