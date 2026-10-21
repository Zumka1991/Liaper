-- =============================================================================
-- Liaper PostgreSQL Database Schema
-- Хранение регистраций/логинов, взаимных контактов, переписок (личных и уроков)
-- и реестра релизов приложений
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    display_name VARCHAR(128) NOT NULL,
    role VARCHAR(32) NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    e2ee_public_key TEXT NOT NULL,
    key_fingerprint VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS contacts (
    user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b)
);

CREATE TABLE IF NOT EXISTS contact_requests (
    id UUID PRIMARY KEY,
    from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (from_user_id, to_user_id)
);

CREATE OR REPLACE FUNCTION accept_tutor_student(p_request UUID, p_student UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE req contact_requests%ROWTYPE; count_students BIGINT;
BEGIN
    SELECT * INTO req FROM contact_requests WHERE id=p_request AND to_user_id=p_student FOR UPDATE;
    IF NOT FOUND THEN RETURN 'missing'; END IF;
    IF NOT EXISTS(SELECT 1 FROM users WHERE id=req.from_user_id AND role='tutor')
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=req.to_user_id AND role='student') THEN RETURN 'role'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(req.from_user_id::TEXT, 1));
    SELECT COUNT(*) INTO count_students FROM contacts c JOIN users u
      ON u.id=CASE WHEN c.user_a=req.from_user_id THEN c.user_b ELSE c.user_a END
      WHERE (c.user_a=req.from_user_id OR c.user_b=req.from_user_id) AND u.role='student';
    IF count_students>=10 AND NOT EXISTS(SELECT 1 FROM contacts
      WHERE user_a=LEAST(req.from_user_id,p_student) AND user_b=GREATEST(req.from_user_id,p_student)) THEN RETURN 'limit'; END IF;
    INSERT INTO contacts(user_a,user_b) VALUES(LEAST(req.from_user_id,p_student),GREATEST(req.from_user_id,p_student)) ON CONFLICT DO NOTHING;
    DELETE FROM contact_requests WHERE id=p_request;
    RETURN 'accepted';
END;
$$;

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_username VARCHAR(64) NOT NULL,
    sender_display_name VARCHAR(128) NOT NULL,
    ciphertext_b64 TEXT NOT NULL,
    iv_b64 TEXT NOT NULL,
    room_key_id VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON chat_messages (room_id, created_at);

-- Minimal routing/access metadata only. File names, types and keys stay in encrypted messages.
CREATE TABLE IF NOT EXISTS file_attachments (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id UUID NOT NULL,
    node_id TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 16 AND 134217728),
    sha256 VARCHAR(64) NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
    reservation_until TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_file_attachments_owner ON file_attachments(owner_id);
CREATE TABLE IF NOT EXISTS file_attachment_readers (
    attachment_id UUID NOT NULL REFERENCES file_attachments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(attachment_id,user_id)
);

-- The per-owner database lock also protects quotas across multiple control processes.
CREATE OR REPLACE FUNCTION reserve_file_attachment(
    p_id UUID, p_owner UUID, p_room UUID, p_node TEXT, p_size BIGINT, p_sha TEXT,
    p_until TIMESTAMPTZ, p_readers UUID[]
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE used_bytes BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_owner::TEXT, 0));
    SELECT COALESCE(SUM(size_bytes),0) INTO used_bytes FROM file_attachments
      WHERE owner_id=p_owner AND ((state='ready' AND expires_at>NOW())
        OR (state='pending' AND reservation_until>NOW()));
    IF used_bytes+p_size > 5368709120 THEN RETURN FALSE; END IF;
    INSERT INTO file_attachments(id,owner_id,room_id,node_id,size_bytes,sha256,state,reservation_until)
      VALUES(p_id,p_owner,p_room,p_node,p_size,p_sha,'pending',p_until);
    INSERT INTO file_attachment_readers(attachment_id,user_id)
      SELECT p_id, unnest(p_readers) ON CONFLICT DO NOTHING;
    RETURN TRUE;
END;
$$;

-- Titles, participants, times and transcript are inside the client-encrypted blob.
CREATE TABLE IF NOT EXISTS lesson_archives (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    archive_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version = 1),
    ciphertext_b64 TEXT NOT NULL,
    iv_b64 TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, archive_id)
);

CREATE TABLE IF NOT EXISTS app_releases (
    platform VARCHAR(64) PRIMARY KEY,
    version VARCHAR(32) NOT NULL,
    build_number INTEGER NOT NULL DEFAULT 1,
    release_notes TEXT NOT NULL,
    download_url TEXT NOT NULL,
    sha256 VARCHAR(128) NOT NULL,
    signature TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    mandatory BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
