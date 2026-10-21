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
