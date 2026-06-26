CREATE TABLE IF NOT EXISTS rounds (
    round_id BIGINT PRIMARY KEY,
    map_name TEXT,
    duration_text TEXT,
    round_date DATE,
    round_end_text TEXT,
    round_result_key TEXT,
    download_link TEXT
);

CREATE TABLE IF NOT EXISTS round_players (
    id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES rounds(round_id) ON DELETE CASCADE,
    player_guid UUID,
    username TEXT,
    character_name TEXT,
    job TEXT,
    is_antag BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_round_players_round_id ON round_players(round_id);

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    page_path TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
