use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use liaper_common::file_storage::{retention_end, FileTicket, Operation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio::{io::AsyncWriteExt, sync::Mutex};
use tokio_util::io::ReaderStream;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

struct Storage {
    root: PathBuf,
    node_id: String,
    secret: Vec<u8>,
    quota: u64,
    control_url: Option<String>,
    // Serializes commits, quota checks and cleanup; streams stay bounded in memory.
    writer: Mutex<()>,
}
#[derive(Serialize, Deserialize)]
struct Metadata {
    id: Uuid,
    size_bytes: u64,
    sha256: String,
    uploaded_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    #[serde(default)]
    confirmed: bool,
}
type Error = (StatusCode, Json<serde_json::Value>);
fn error(code: StatusCode, text: &str) -> Error {
    (code, Json(serde_json::json!({"error":text})))
}
fn io_error(e: std::io::Error) -> Error {
    tracing::error!("Storage IO: {e}");
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Хранилище временно недоступно",
    )
}
impl Storage {
    fn blob(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.blob"))
    }
    fn meta(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
    fn ticket(
        &self,
        headers: &HeaderMap,
        id: Uuid,
        operation: Operation,
    ) -> Result<FileTicket, Error> {
        let ticket = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|v| FileTicket::verify(v, &self.secret, Utc::now()))
            .filter(|t| t.blob_id == id && t.node_id == self.node_id && t.operation == operation)
            .ok_or_else(|| {
                error(
                    StatusCode::UNAUTHORIZED,
                    "Ссылка недействительна или истекла",
                )
            })?;
        Ok(ticket)
    }
    async fn metadata(&self, id: Uuid) -> Result<Metadata, Error> {
        let bytes = tokio::fs::read(self.meta(id)).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                error(
                    StatusCode::NOT_FOUND,
                    "Файл не найден или удалён по сроку хранения",
                )
            } else {
                io_error(e)
            }
        })?;
        serde_json::from_slice(&bytes).map_err(|_| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Метаданные файла недоступны",
            )
        })
    }
    fn receipt(&self, m: &Metadata) -> Json<serde_json::Value> {
        Json(
            serde_json::json!({"receipt": FileTicket {blob_id:m.id,node_id:self.node_id.clone(),operation:Operation::Receipt,
            size_bytes:m.size_bytes,sha256:m.sha256.clone(),valid_until:Utc::now()+chrono::Duration::minutes(15),
            retain_until:Some(m.expires_at)}.sign(&self.secret),"expires_at":m.expires_at}),
        )
    }
    async fn confirm(&self, m: &mut Metadata) -> Result<(), Error> {
        if m.confirmed {
            return Ok(());
        }
        let Some(url) = &self.control_url else {
            return Ok(());
        };
        let response = reqwest::Client::new()
            .post(format!(
                "{}/api/storage/committed",
                url.trim_end_matches('/')
            ))
            .timeout(std::time::Duration::from_secs(10))
            .json(&self.receipt(m).0)
            .send()
            .await
            .map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Не удалось подтвердить загрузку. Повторите попытку",
                )
            })?;
        if !response.status().is_success() {
            if response.status() == StatusCode::CONFLICT
                || response.status() == StatusCode::NOT_FOUND
            {
                let _ = tokio::fs::remove_file(self.blob(m.id)).await;
                let _ = tokio::fs::remove_file(self.meta(m.id)).await;
                return Err(error(
                    StatusCode::CONFLICT,
                    "Время загрузки истекло. Отправьте файл заново",
                ));
            }
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Не удалось подтвердить загрузку. Повторите попытку",
            ));
        }
        m.confirmed = true;
        let temp = self.root.join(format!("{}.meta.part", m.id));
        tokio::fs::write(&temp, serde_json::to_vec(m).unwrap())
            .await
            .map_err(io_error)?;
        tokio::fs::rename(temp, self.meta(m.id))
            .await
            .map_err(io_error)?;
        Ok(())
    }
    async fn cleanup(&self, now: DateTime<Utc>) -> std::io::Result<()> {
        let _guard = self.writer.lock().await;
        let mut entries = tokio::fs::read_dir(&self.root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().is_some_and(|v| v == "json") {
                if let Ok(bytes) = tokio::fs::read(&path).await {
                    if let Ok(mut m) = serde_json::from_slice::<Metadata>(&bytes) {
                        if !m.confirmed && m.expires_at > now {
                            if let Err(e) = self.confirm(&mut m).await {
                                tracing::warn!("Pending upload confirmation: {}", e.0);
                            }
                        }
                        if m.expires_at <= now {
                            // Keep metadata if deletion failed, so the next pass retries.
                            match tokio::fs::remove_file(self.blob(m.id)).await {
                                Ok(()) => {}
                                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                Err(e) => {
                                    tracing::warn!("Expired blob deletion: {e}");
                                    continue;
                                }
                            }
                            tokio::fs::remove_file(&path).await?;
                        }
                    }
                }
            } else if path.extension().is_some_and(|v| v == "part" || v == "blob") {
                let orphan = path.extension().is_some_and(|v| v == "part")
                    || !path.with_extension("json").exists();
                let old = entry
                    .metadata()
                    .await?
                    .modified()?
                    .elapsed()
                    .unwrap_or_default()
                    .as_secs()
                    > 3600;
                if orphan && old {
                    tokio::fs::remove_file(&path).await?;
                }
            }
        }
        Ok(())
    }
}

async fn upload(
    State(s): State<Arc<Storage>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<serde_json::Value>, Error> {
    let ticket = s.ticket(&headers, id, Operation::Upload)?;
    let _guard = s.writer.lock().await;
    if ticket.valid_until <= Utc::now() {
        return Err(error(StatusCode::UNAUTHORIZED, "Время загрузки истекло"));
    }
    if let Ok(mut existing) = s.metadata(id).await {
        if existing.expires_at <= Utc::now() {
            return Err(error(StatusCode::GONE, "Срок хранения файла истёк"));
        }
        if existing.sha256 == ticket.sha256 && existing.size_bytes == ticket.size_bytes {
            s.confirm(&mut existing).await?;
            return Ok(s.receipt(&existing));
        }
        return Err(error(
            StatusCode::CONFLICT,
            "Файл с этим идентификатором уже существует",
        ));
    }
    let partial = s.root.join(format!("{id}.part"));
    match tokio::fs::remove_file(&partial).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_error(e)),
    }
    let mut used = 0u64;
    let mut entries = tokio::fs::read_dir(&s.root).await.map_err(io_error)?;
    while let Some(e) = entries.next_entry().await.map_err(io_error)? {
        if e.path()
            .extension()
            .is_some_and(|v| v == "blob" || v == "part")
        {
            used = used.saturating_add(e.metadata().await.map_err(io_error)?.len());
        }
    }
    if used.saturating_add(ticket.size_bytes) > s.quota {
        return Err(error(
            StatusCode::INSUFFICIENT_STORAGE,
            "На файловой ноде недостаточно места",
        ));
    }
    let mut file = tokio::fs::File::create(&partial).await.map_err(io_error)?;
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    let mut hash = Sha256::new();
    let result = async {
        let deadline = tokio::time::Instant::now()
            + (ticket.valid_until - Utc::now())
                .to_std()
                .unwrap_or_default();
        while let Some(chunk) = tokio::time::timeout_at(deadline, stream.next())
            .await
            .map_err(|_| error(StatusCode::REQUEST_TIMEOUT, "Время загрузки истекло"))?
        {
            let bytes = chunk.map_err(|_| error(StatusCode::BAD_REQUEST, "Загрузка прервана"))?;
            size += bytes.len() as u64;
            if size > ticket.size_bytes {
                return Err(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Превышен размер файла",
                ));
            }
            hash.update(&bytes);
            file.write_all(&bytes).await.map_err(io_error)?;
        }
        file.sync_all().await.map_err(io_error)?;
        if size != ticket.size_bytes || format!("{:x}", hash.finalize()) != ticket.sha256 {
            return Err(error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Размер или SHA-256 зашифрованного файла не совпадает",
            ));
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(e);
    }
    let now = Utc::now();
    let mut m = Metadata {
        id,
        size_bytes: size,
        sha256: ticket.sha256,
        uploaded_at: now,
        expires_at: retention_end(now),
        confirmed: false,
    };
    tokio::fs::rename(&partial, s.blob(id))
        .await
        .map_err(io_error)?;
    let meta_partial = s.root.join(format!("{id}.meta.part"));
    tokio::fs::write(&meta_partial, serde_json::to_vec(&m).unwrap())
        .await
        .map_err(io_error)?;
    tokio::fs::rename(meta_partial, s.meta(id))
        .await
        .map_err(io_error)?;
    s.confirm(&mut m).await?;
    Ok(s.receipt(&m))
}

async fn download(
    State(s): State<Arc<Storage>>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    let ticket = s.ticket(&headers, id, Operation::Download)?;
    // A live ticket never extends retention, even before the hourly deletion pass.
    if ticket.retain_until.is_none_or(|time| time <= Utc::now()) {
        return Err(error(StatusCode::GONE, "Срок хранения файла истёк"));
    }
    let m = s.metadata(id).await?;
    if m.expires_at <= Utc::now() {
        return Err(error(StatusCode::GONE, "Срок хранения файла истёк"));
    }
    if ticket.sha256 != m.sha256 || ticket.size_bytes != m.size_bytes {
        return Err(error(StatusCode::FORBIDDEN, "Неверный доступ к файлу"));
    }
    let file = tokio::fs::File::open(s.blob(id)).await.map_err(io_error)?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, m.size_bytes.to_string())
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from_stream(ReaderStream::new(file)))
        .unwrap())
}

fn router(s: Arc<Storage>) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/blobs/:id", put(upload).get(download))
        .layer(DefaultBodyLimit::disable())
        .layer(CorsLayer::permissive())
        .with_state(s)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().init();
    let secret = std::env::var("LIAPER_STORAGE_SECRET")?;
    anyhow::ensure!(
        secret.len() >= 32,
        "LIAPER_STORAGE_SECRET must have at least 32 characters"
    );
    let s = Arc::new(Storage {
        root: std::env::var("FILE_STORAGE_PATH")
            .unwrap_or("data/files".into())
            .into(),
        node_id: std::env::var("FILE_NODE_ID").unwrap_or("storage-local-1".into()),
        secret: secret.into_bytes(),
        control_url: Some(std::env::var("CONTROL_URL").unwrap_or("http://127.0.0.1:4000".into())),
        quota: std::env::var("FILE_NODE_QUOTA_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100 * 1024 * 1024 * 1024),
        writer: Mutex::new(()),
    });
    tokio::fs::create_dir_all(&s.root).await?;
    s.cleanup(Utc::now()).await?;
    let cleanup = s.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if let Err(e) = cleanup.cleanup(Utc::now()).await {
                tracing::error!("Storage cleanup failed: {e}");
            }
        }
    });
    let port = std::env::var("FILE_NODE_PORT")
        .unwrap_or("4201".into())
        .parse::<u16>()?;
    tracing::info!("File node listening on {port}; retention: one calendar month");
    axum::serve(
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await?,
        router(s),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;
    #[tokio::test]
    async fn upload_integrity_scope_retention_and_cleanup() {
        let root = std::env::temp_dir().join(format!("liaper-files-test-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let s = Arc::new(Storage {
            root: root.clone(),
            node_id: "test".into(),
            secret: b"test-secret".to_vec(),
            quota: 100,
            control_url: None,
            writer: Mutex::new(()),
        });
        let id = Uuid::new_v4();
        let bytes = b"opaque ciphertext with tag";
        let mut t = FileTicket {
            blob_id: id,
            node_id: "test".into(),
            operation: Operation::Upload,
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            valid_until: Utc::now() + chrono::Duration::minutes(1),
            retain_until: None,
        };
        let app = router(s.clone());
        let req = |id, t: &FileTicket, body| {
            Request::builder()
                .method("PUT")
                .uri(format!("/blobs/{id}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", t.sign(&s.secret)),
                )
                .body(body)
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(req(Uuid::new_v4(), &t, Body::from(bytes.as_slice())))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(req(id, &t, Body::from("wrong")))
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(!s.blob(id).exists());
        let orphan = s.root.join("cancelled-upload.part");
        tokio::fs::write(&orphan, vec![0u8; 100]).await.unwrap();
        assert_eq!(
            app.clone()
                .oneshot(req(id, &t, Body::from(bytes.as_slice())))
                .await
                .unwrap()
                .status(),
            StatusCode::INSUFFICIENT_STORAGE
        );
        tokio::fs::remove_file(orphan).await.unwrap();
        assert_eq!(
            app.clone()
                .oneshot(req(id, &t, Body::from(bytes.as_slice())))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let mut m = s.metadata(id).await.unwrap();
        assert_eq!(m.expires_at, retention_end(m.uploaded_at));
        t.operation = Operation::Download;
        t.retain_until = Some(m.expires_at);
        let download = |t: &FileTicket| {
            Request::builder()
                .uri(format!("/blobs/{id}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", t.sign(&s.secret)),
                )
                .body(Body::empty())
                .unwrap()
        };
        let response = app.clone().oneshot(download(&t)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1000)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        m.expires_at = Utc::now() - chrono::Duration::seconds(1);
        tokio::fs::write(s.meta(id), serde_json::to_vec(&m).unwrap())
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(download(&t)).await.unwrap().status(),
            StatusCode::GONE
        );
        s.cleanup(Utc::now()).await.unwrap();
        assert!(!s.blob(id).exists());
        assert!(!s.meta(id).exists());
        tokio::fs::remove_dir(&root).await.unwrap();
    }
}
