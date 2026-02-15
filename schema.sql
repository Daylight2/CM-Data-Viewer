CREATE TABLE IF NOT EXISTS rounds (
    round_id BIGINT PRIMARY KEY,
    map_name TEXT NOT NULL,
    duration_text TEXT NOT NULL,
    round_date DATE NOT NULL,
    round_end_text TEXT NOT NULL,
    round_result_key TEXT,
    download_link TEXT NOT NULL,
    source_url TEXT NOT NULL,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS round_players (
    id BIGSERIAL PRIMARY KEY,
    round_id BIGINT NOT NULL REFERENCES rounds(round_id) ON DELETE CASCADE,
    player_guid UUID,
    username TEXT NOT NULL,
    character_name TEXT NOT NULL,
    job TEXT NOT NULL,
    is_antag BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_round_players_round_id ON round_players(round_id);
