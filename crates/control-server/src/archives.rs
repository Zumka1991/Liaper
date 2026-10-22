use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::ControlState;

pub type ApiError = (StatusCode, Json<serde_json::Value>);

pub(crate) fn error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(serde_json::json!({ "error": message })))
}

pub(crate) fn owner(state: &ControlState, headers: &HeaderMap) -> Result<Uuid, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Войдите в аккаунт"))?;
    state
        .tokens
        .get(token)
        .map(|id| *id)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Сессия истекла. Войдите повторно"))
}

#[derive(Deserialize)]
pub struct UnlockRequest {
    pub password: String,
}

pub async fn unlock(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    Json(body): Json<UnlockRequest>,
) -> Result<StatusCode, ApiError> {
    let id = owner(&state, &headers)?;
    let subj_key = format!("user:{id}");
    if let Err(msg) = state.antifraud.check_quarantine(&subj_key) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, &msg));
    }
    let user = state
        .users_by_id
        .get(&id)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Профиль не найден"))?;
    let uname = user.username.clone();
    if !ControlState::verify_password(&body.password, &user.salt_b64, &user.password_hash) {
        drop(user);
        state
            .antifraud
            .record_violation(
                &subj_key,
                Some(id),
                Some(uname),
                None,
                "auth_bruteforce",
                crate::antifraud::IncidentSeverity::Medium,
                25,
                "Неверный пароль при разблокировке архива уроков".into(),
                300,
            )
            .await;
        return Err(error(StatusCode::UNAUTHORIZED, "Неверный пароль"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ArchiveWrite {
    pub version: i32,
    pub ciphertext_b64: String,
    pub iv_b64: String,
    pub expected_revision: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ArchiveBlob {
    pub archive_id: Uuid,
    pub version: i32,
    pub ciphertext_b64: String,
    pub iv_b64: String,
    pub revision: i64,
    pub updated_at: DateTime<Utc>,
}

fn from_row(row: tokio_postgres::Row) -> ArchiveBlob {
    ArchiveBlob {
        archive_id: row.get(0),
        version: row.get(1),
        ciphertext_b64: row.get(2),
        iv_b64: row.get(3),
        revision: row.get(4),
        updated_at: row.get(5),
    }
}

pub async fn list(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ArchiveBlob>>, ApiError> {
    let owner_id = owner(&state, &headers)?;
    let client = state
        .pg_client
        .read()
        .await
        .clone()
        .filter(|c| !c.is_closed())
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Сервер временно недоступен. Архив сохранён на устройстве",
            )
        })?;
    let rows = client.query(
        "SELECT archive_id, version, ciphertext_b64, iv_b64, revision, updated_at FROM lesson_archives WHERE owner_id = $1 ORDER BY updated_at DESC",
        &[&owner_id],
    ).await.map_err(|e| {
        tracing::error!("Archive read failed: {}", e);
        error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось загрузить архив из PostgreSQL")
    })?;
    Ok(Json(rows.into_iter().map(from_row).collect()))
}

pub async fn put(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    Path(archive_id): Path<Uuid>,
    Json(body): Json<ArchiveWrite>,
) -> Result<Json<ArchiveBlob>, ApiError> {
    let owner_id = owner(&state, &headers)?;
    if body.version != 1
        || body.expected_revision < 0
        || body.ciphertext_b64.len() > 1_400_000
        || BASE64
            .decode(&body.iv_b64)
            .map(|v| v.len() != 12)
            .unwrap_or(true)
        || BASE64
            .decode(&body.ciphertext_b64)
            .map(|v| v.len() < 16)
            .unwrap_or(true)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Некорректный зашифрованный архив",
        ));
    }
    let client = state
        .pg_client
        .read()
        .await
        .clone()
        .filter(|c| !c.is_closed())
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Сервер временно недоступен. Повторите синхронизацию позже",
            )
        })?;
    let row = if body.expected_revision == 0 {
        client.query_opt(
            "INSERT INTO lesson_archives (owner_id, archive_id, version, ciphertext_b64, iv_b64) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING archive_id, version, ciphertext_b64, iv_b64, revision, updated_at",
            &[&owner_id, &archive_id, &body.version, &body.ciphertext_b64, &body.iv_b64],
        ).await
    } else {
        client.query_opt(
            "UPDATE lesson_archives SET version=$3, ciphertext_b64=$4, iv_b64=$5, revision=revision+1, updated_at=NOW() WHERE owner_id=$1 AND archive_id=$2 AND revision=$6 RETURNING archive_id, version, ciphertext_b64, iv_b64, revision, updated_at",
            &[&owner_id, &archive_id, &body.version, &body.ciphertext_b64, &body.iv_b64, &body.expected_revision],
        ).await
    }.map_err(|e| {
        tracing::error!("Archive write failed: {}", e);
        error(StatusCode::SERVICE_UNAVAILABLE, "Не удалось сохранить архив в PostgreSQL")
    })?;
    row.map(|r| Json(from_row(r))).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "Архив изменён на другом устройстве. Обновите данные",
        )
    })
}
