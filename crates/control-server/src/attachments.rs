use crate::{
    archives::{error, owner, ApiError},
    state::ControlState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::Utc;
use liaper_common::file_storage::{FileTicket, Operation, MAX_BLOB_BYTES};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

pub const USER_QUOTA_BYTES: i64 = 5 * 1024 * 1024 * 1024;
#[derive(Clone, Deserialize)]
struct Node {
    node_id: String,
    internal_url: String,
    public_url: String,
}
fn nodes() -> Result<Vec<Node>, ApiError> {
    if let Ok(config) = std::env::var("FILE_NODES") {
        return serde_json::from_str(&config).map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Неверная конфигурация файловых нод",
            )
        });
    }
    Ok(vec![Node {
        node_id: "storage-local-1".into(),
        internal_url: std::env::var("FILE_NODE_INTERNAL_URL")
            .unwrap_or("http://127.0.0.1:4201".into()),
        public_url: std::env::var("FILE_NODE_PUBLIC_URL").unwrap_or("http://127.0.0.1:4201".into()),
    }])
}
fn secret() -> Result<Vec<u8>, ApiError> {
    std::env::var("LIAPER_STORAGE_SECRET")
        .ok()
        .filter(|v| v.len() >= 32)
        .map(String::into_bytes)
        .ok_or_else(|| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Файловое хранилище не настроено",
            )
        })
}
async fn database(state: &ControlState) -> Result<Arc<tokio_postgres::Client>, ApiError> {
    state
        .pg_client
        .read()
        .await
        .clone()
        .filter(|c| !c.is_closed())
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "PostgreSQL недоступна"))
}
fn db_error(e: tokio_postgres::Error) -> ApiError {
    tracing::error!("Attachment DB: {e}");
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Хранилище временно недоступно",
    )
}

pub async fn usage(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = owner(&state, &headers)?;
    let db = database(&state).await?;
    let row=db.query_one("SELECT COALESCE(SUM(size_bytes) FILTER(WHERE state='ready' AND expires_at>NOW()),0)::BIGINT, COALESCE(SUM(size_bytes) FILTER(WHERE state='pending' AND reservation_until>NOW()),0)::BIGINT FROM file_attachments WHERE owner_id=$1",&[&id]).await.map_err(db_error)?;
    let used: i64 = row.get(0);
    let reserved: i64 = row.get(1);
    Ok(Json(
        serde_json::json!({"used_bytes":used,"reserved_bytes":reserved,"quota_bytes":USER_QUOTA_BYTES,
        "available_bytes":(USER_QUOTA_BYTES-used-reserved).max(0),"retention_months":1,"max_file_bytes":MAX_BLOB_BYTES}),
    ))
}
#[derive(Deserialize)]
pub struct Reservation {
    room_id: Uuid,
    size_bytes: u64,
    sha256: String,
}
pub async fn reserve(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    Json(body): Json<Reservation>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = owner(&state, &headers)?;
    if body.size_bytes < 16
        || body.size_bytes > MAX_BLOB_BYTES
        || body.sha256.len() != 64
        || !body.sha256.bytes().all(|v| v.is_ascii_hexdigit())
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Файл должен быть зашифрован; максимальный размер — 128 МиБ",
        ));
    }
    let mut readers = Vec::new();
    if let Some(room) = state.rooms.get(&body.room_id) {
        if room.participants.iter().any(|p| p.user_id == id) {
            readers = room.participants.iter().map(|p| p.user_id).collect();
        }
    }
    if readers.is_empty() {
        if let Some(contacts) = state.contacts_by_user.get(&id) {
            if let Some(other) = contacts
                .iter()
                .find(|other| ControlState::dm_room_id(&id, other) == body.room_id)
            {
                readers = vec![id, *other];
            }
        }
    }
    if readers.is_empty() {
        return Err(error(StatusCode::FORBIDDEN, "Нет доступа к этому чату"));
    }
    let key = secret()?;
    let db = database(&state).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    let mut chosen = None;
    for node in nodes()? {
        if client
            .get(format!(
                "{}/health",
                node.internal_url.trim_end_matches('/')
            ))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            chosen = Some(node);
            break;
        }
    }
    let node = chosen.ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Файловые ноды недоступны. Повторите позже",
        )
    })?;
    let blob_id = Uuid::new_v4();
    let until = Utc::now() + chrono::Duration::minutes(15);
    let size = body.size_bytes as i64;
    let digest = body.sha256.to_ascii_lowercase();
    let accepted: bool = db
        .query_one(
            "SELECT reserve_file_attachment($1,$2,$3,$4,$5,$6,$7,$8)",
            &[
                &blob_id,
                &id,
                &body.room_id,
                &node.node_id,
                &size,
                &digest,
                &until,
                &readers,
            ],
        )
        .await
        .map_err(db_error)?
        .get(0);
    if !accepted {
        return Err(error(
            StatusCode::INSUFFICIENT_STORAGE,
            "Лимит хранилища 5 ГиБ исчерпан. Дождитесь удаления старых файлов",
        ));
    }
    let ticket = FileTicket {
        blob_id,
        node_id: node.node_id,
        operation: Operation::Upload,
        size_bytes: body.size_bytes,
        sha256: digest,
        valid_until: until,
        retain_until: None,
    }
    .sign(&key);
    Ok(Json(
        serde_json::json!({"attachment_id":blob_id,"upload_url":format!("{}/blobs/{blob_id}",node.public_url.trim_end_matches('/')),
        "upload_token":ticket,"reservation_until":until,"retention_months":1}),
    ))
}
#[derive(Deserialize)]
pub struct Completion {
    receipt: String,
}
pub async fn complete(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Completion>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = owner(&state, &headers)?;
    commit(&state, id, &body.receipt, Some(user)).await
}

/// The node reports commits itself, so a disconnected client cannot hide stored files from its quota.
pub async fn node_commit(
    State(state): State<Arc<ControlState>>,
    Json(body): Json<Completion>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let proof = FileTicket::verify(&body.receipt, &secret()?, Utc::now())
        .filter(|t| t.operation == Operation::Receipt)
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "Недействительное подтверждение ноды",
            )
        })?;
    commit(&state, proof.blob_id, &body.receipt, None).await
}
async fn commit(
    state: &ControlState,
    id: Uuid,
    receipt: &str,
    user: Option<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ticket = FileTicket::verify(receipt, &secret()?, Utc::now())
        .filter(|t| t.blob_id == id && t.operation == Operation::Receipt)
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "Недействительное подтверждение загрузки",
            )
        })?;
    let expiry = ticket
        .retain_until
        .filter(|t| *t > Utc::now() && *t <= liaper_common::file_storage::retention_end(Utc::now()))
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Неверный срок хранения"))?;
    let db = database(&state).await?;
    let size = ticket.size_bytes as i64;
    let row=db.query_opt("UPDATE file_attachments SET state='ready',expires_at=$6 WHERE id=$1 AND ($2::UUID IS NULL OR owner_id=$2) AND node_id=$3 AND size_bytes=$4 AND sha256=$5 AND ((state='pending' AND reservation_until>NOW()) OR (state='ready' AND expires_at=$6)) RETURNING expires_at",
        &[&id,&user,&ticket.node_id,&size,&ticket.sha256,&expiry]).await.map_err(db_error)?;
    if row.is_none() {
        return Err(error(
            StatusCode::CONFLICT,
            "Загрузка не найдена или время загрузки истекло",
        ));
    }
    Ok(Json(
        serde_json::json!({"attachment_id":id,"expires_at":expiry}),
    ))
}
pub async fn download(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user = owner(&state, &headers)?;
    let db = database(&state).await?;
    let row=db.query_opt("SELECT node_id,size_bytes,sha256,expires_at,state FROM file_attachments f WHERE id=$1 AND EXISTS(SELECT 1 FROM file_attachment_readers r WHERE r.attachment_id=f.id AND r.user_id=$2)",&[&id,&user]).await.map_err(db_error)?
        .ok_or_else(||error(StatusCode::NOT_FOUND,"Файл не найден"))?;
    let expiry: Option<chrono::DateTime<Utc>> = row.get(3);
    if row.get::<_, String>(4) != "ready" {
        return Err(error(StatusCode::CONFLICT, "Файл ещё загружается"));
    }
    let expiry = expiry.filter(|t| *t > Utc::now()).ok_or_else(|| {
        error(
            StatusCode::GONE,
            "Срок хранения файла истёк. Вложения хранятся один месяц",
        )
    })?;
    let node_id: String = row.get(0);
    let node = nodes()?
        .into_iter()
        .find(|n| n.node_id == node_id)
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "Файловая нода недоступна"))?;
    let ticket = FileTicket {
        blob_id: id,
        node_id,
        operation: Operation::Download,
        size_bytes: row.get::<_, i64>(1) as u64,
        sha256: row.get(2),
        valid_until: (Utc::now() + chrono::Duration::minutes(10)).min(expiry),
        retain_until: Some(expiry),
    }
    .sign(&secret()?);
    Ok(Json(
        serde_json::json!({"download_url":format!("{}/blobs/{id}",node.public_url.trim_end_matches('/')),"download_token":ticket,"expires_at":expiry}),
    ))
}
