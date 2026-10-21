use super::*;
use axum::http::HeaderMap;
use base64::Engine;

fn headers(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("authorization", format!("Bearer {token}").parse().unwrap());
    h
}
#[tokio::test]
async fn postgres_archives_isolation_conflicts_restart_and_concurrent_file_quota() {
    let Ok(url) = std::env::var("LIAPER_TEST_DATABASE_URL") else {
        eprintln!("LIAPER_TEST_DATABASE_URL missing: PostgreSQL integration not run");
        return;
    };
    let root = std::env::temp_dir().join(format!("liaper-pg-test-{}", Uuid::new_v4()));
    let state = ControlState::new(root.join("users.json"));
    state.init_postgres(&url).await.unwrap();
    let db = state.pg_client.read().await.clone().unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for id in [a, b] {
        let user = StoredUser {
            id,
            username: format!("test_{}", id.simple()),
            display_name: "Test".into(),
            password_hash: "hash".into(),
            salt_b64: "salt".into(),
            role: liaper_common::UserRole::Student,
            e2ee_public_key: "public".into(),
            key_fingerprint: "fingerprint".into(),
        };
        state.persist_user(&user).await.unwrap();
        state.users_by_id.insert(id, user);
    }
    state.tokens.insert("a".into(), a);
    state.tokens.insert("b".into(), b);
    let archive_id = Uuid::new_v4();
    let write = |revision| archives::ArchiveWrite {
        version: 1,
        ciphertext_b64: base64::engine::general_purpose::STANDARD.encode([7; 32]),
        iv_b64: base64::engine::general_purpose::STANDARD.encode([1; 12]),
        expected_revision: revision,
    };
    assert_eq!(
        archives::put(
            State(state.clone()),
            headers("a"),
            Path(archive_id),
            Json(write(0))
        )
        .await
        .unwrap()
        .0
        .revision,
        1
    );
    assert_eq!(
        archives::put(
            State(state.clone()),
            headers("a"),
            Path(archive_id),
            Json(write(0))
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::CONFLICT
    );
    assert!(archives::list(State(state.clone()), headers("b"))
        .await
        .unwrap()
        .0
        .is_empty());
    assert_eq!(
        archives::put(
            State(state.clone()),
            headers("a"),
            Path(archive_id),
            Json(write(1))
        )
        .await
        .unwrap()
        .0
        .revision,
        2
    );
    let restarted = ControlState::new(root.join("users.json"));
    restarted.init_postgres(&url).await.unwrap();
    restarted.tokens.insert("a".into(), a);
    assert_eq!(
        archives::list(State(restarted), headers("a"))
            .await
            .unwrap()
            .0
            .iter()
            .find(|v| v.archive_id == archive_id)
            .unwrap()
            .revision,
        2
    );
    // Fill all but one 128 MiB slot without writing real disk data.
    let room = Uuid::new_v4();
    let size = 128i64 * 1024 * 1024;
    let sha = "a".repeat(64);
    let until = chrono::Utc::now() + chrono::Duration::minutes(15);
    for _ in 0..39 {
        let accepted: bool = db
            .query_one(
                "SELECT reserve_file_attachment($1,$2,$3,$4,$5,$6,$7,$8)",
                &[
                    &Uuid::new_v4(),
                    &a,
                    &room,
                    &"test-node",
                    &size,
                    &sha,
                    &until,
                    &vec![a],
                ],
            )
            .await
            .unwrap()
            .get(0);
        assert!(accepted);
    }
    let (other, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        connection.await.unwrap();
    });
    let id1 = Uuid::new_v4();
    let id2 = Uuid::new_v4();
    let readers = vec![a];
    let args: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        vec![&id1, &a, &room, &"test-node", &size, &sha, &until, &readers];
    let args2: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        vec![&id2, &a, &room, &"test-node", &size, &sha, &until, &readers];
    let sql = "SELECT reserve_file_attachment($1,$2,$3,$4,$5,$6,$7,$8)";
    let (r1, r2) = tokio::join!(db.query_one(sql, &args), other.query_one(sql, &args2));
    assert_ne!(r1.unwrap().get::<_, bool>(0), r2.unwrap().get::<_, bool>(0));
    let usage = attachments::usage(State(state.clone()), headers("a"))
        .await
        .unwrap()
        .0;
    assert_eq!(
        usage["reserved_bytes"].as_i64().unwrap(),
        attachments::USER_QUOTA_BYTES
    );
    assert_eq!(
        attachments::usage(State(state.clone()), headers("b"))
            .await
            .unwrap()
            .0["reserved_bytes"],
        0
    );
    let expired_id: Uuid = db
        .query_one(
            "SELECT id FROM file_attachments WHERE owner_id=$1 LIMIT 1",
            &[&a],
        )
        .await
        .unwrap()
        .get(0);
    db.execute("UPDATE file_attachments SET state='ready',expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",&[&expired_id]).await.unwrap();
    assert_eq!(
        attachments::download(State(state.clone()), headers("a"), Path(expired_id))
            .await
            .unwrap_err()
            .0,
        StatusCode::GONE
    );
    assert_eq!(
        attachments::download(State(state.clone()), headers("b"), Path(expired_id))
            .await
            .unwrap_err()
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        attachments::usage(State(state.clone()), headers("a"))
            .await
            .unwrap()
            .0["reserved_bytes"]
            .as_i64()
            .unwrap(),
        attachments::USER_QUOTA_BYTES - size
    );
    // Two independent PostgreSQL connections accepting the last student slot.
    let tutor = Uuid::new_v4();
    let students: Vec<_> = (0..11).map(|_| Uuid::new_v4()).collect();
    for id in std::iter::once(&tutor).chain(students.iter()) {
        db.execute("INSERT INTO users(id,username,display_name,role,password_hash,password_salt,e2ee_public_key,key_fingerprint) VALUES($1,$2,'Test',$3,'hash','salt','key','fingerprint')",
            &[id,&format!("test_{}",id.simple()),&if *id==tutor {"tutor"} else {"student"}]).await.unwrap();
    }
    let requests: Vec<_> = students.iter().map(|_| Uuid::new_v4()).collect();
    for (id, student) in requests.iter().zip(&students) {
        db.execute(
            "INSERT INTO contact_requests(id,from_user_id,to_user_id) VALUES($1,$2,$3)",
            &[id, &tutor, student],
        )
        .await
        .unwrap();
    }
    for i in 0..9 {
        assert_eq!(
            db.query_one(
                "SELECT accept_tutor_student($1,$2)",
                &[&requests[i], &students[i]]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
            "accepted"
        );
    }
    let last_args: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        vec![&requests[9], &students[9]];
    let other_args: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        vec![&requests[10], &students[10]];
    let (r1, r2) = tokio::join!(
        db.query_one("SELECT accept_tutor_student($1,$2)", &last_args),
        other.query_one("SELECT accept_tutor_student($1,$2)", &other_args)
    );
    let mut outcomes = vec![
        r1.unwrap().get::<_, String>(0),
        r2.unwrap().get::<_, String>(0),
    ];
    outcomes.sort();
    assert_eq!(outcomes, vec!["accepted", "limit"]);
    let mut cleanup_ids = vec![a, b, tutor];
    cleanup_ids.extend(students);
    db.execute("DELETE FROM users WHERE id=ANY($1)", &[&cleanup_ids])
        .await
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
