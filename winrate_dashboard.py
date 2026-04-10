from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
from urllib.parse import unquote

import psycopg
from flask import Flask, jsonify, render_template, request
from scrape_replay_to_postgres import (
    DEFAULT_URL_TEMPLATE,
    ensure_schema as scraper_ensure_schema,
    get_next_round_id,
    parse_round_data,
    upsert_round,
)


SECRETS_FILE = "local_secrets.json"
DEFAULT_START_ROUND = 10300
DEFAULT_END_ROUND = 10400

RESULT_BUCKETS = [
    "marine major",
    "marine minor",
    "xeno minor",
    "xeno major",
    "draw",
]


@dataclass
class WinrateRow:
    result_key: str
    count: int
    percentage: float


app = Flask(__name__)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    if request.path.startswith("/api/"):
        return jsonify({"error": str(exc)}), 500
    raise exc


def load_db_url() -> str:
    if os.path.exists(SECRETS_FILE):
        with open(SECRETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        db_url = data.get("database_url")
        if db_url:
            return db_url
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return db_url
    raise RuntimeError(
        "Missing database_url. Put it in local_secrets.json or set DATABASE_URL."
    )


DEFAULT_DB_URL = load_db_url()


def normalize_character_search(text: str | None) -> str | None:
    if not text:
        return None
    # Remove numbers inside (...) and [...] so variants like (CHS-32)/(CHS-41) match together.
    normalized = re.sub(
        r"(\([^)]*\)|\[[^\]]*\])",
        lambda m: re.sub(r"[0-9]+", "", m.group(0)),
        text,
    )
    return normalized.strip() or None


def parse_search_query(text: str | None) -> tuple[str | None, bool]:
    if not text:
        return None, False
    value = text.strip()
    strict = len(value) >= 2 and value.startswith('"') and value.endswith('"')
    if strict:
        value = value[1:-1].strip()
    return (value or None), strict


def get_winrate_rows(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    character_job: str | None,
) -> tuple[list[WinrateRow], int]:
    bucket_counts = {key: 0 for key in RESULT_BUCKETS}
    total = 0
    character_name_value, character_name_strict = parse_search_query(character_name)
    character_job_value, character_job_strict = parse_search_query(character_job)
    normalized_name = normalize_character_search(character_name_value)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name and not character_name_strict else None
    job_pattern = f"%{character_job_value}%" if character_job_value and not character_job_strict else None

    query = """
        SELECT r.round_result_key, COUNT(*) AS cnt
        FROM rounds r
        WHERE r.round_id BETWEEN %s AND %s
          AND r.round_result_key = ANY(%s)
          AND (
            %s::text IS NULL
            OR EXISTS (
                SELECT 1
                FROM round_players rp
                WHERE rp.round_id = r.round_id
                  AND (
                    %s::text IS NULL
                    OR (
                        (%s = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s)
                        OR (%s = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER(%s))
                    )
                  )
                  AND (
                    %s::text IS NULL
                    OR (
                        (%s = false AND rp.job ILIKE %s)
                        OR (%s = true AND LOWER(rp.job) = LOWER(%s))
                    )
                  )
            )
          )
        GROUP BY r.round_result_key;
    """

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    RESULT_BUCKETS,
                    character_name_value,
                    character_name_strict,
                    normalized_name_pattern,
                    character_name_strict,
                    normalized_name,
                    character_job_value,
                    character_job_strict,
                    job_pattern,
                    character_job_strict,
                    character_job_value,
                ),
            )
            for result_key, count in cur.fetchall():
                bucket_counts[result_key] = int(count)
                total += int(count)

    rows: list[WinrateRow] = []
    for key in RESULT_BUCKETS:
        count = bucket_counts[key]
        percentage = (count / total * 100.0) if total > 0 else 0.0
        rows.append(WinrateRow(result_key=key, count=count, percentage=round(percentage, 2)))

    return rows, total


def get_player_counts(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    character_job: str | None,
) -> list[dict[str, int | float | None]]:
    character_name_value, character_name_strict = parse_search_query(character_name)
    character_job_value, character_job_strict = parse_search_query(character_job)
    normalized_name = normalize_character_search(character_name_value)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name and not character_name_strict else None
    job_pattern = f"%{character_job_value}%" if character_job_value and not character_job_strict else None
    query = """
        WITH filtered_rounds AS (
            SELECT r.round_id, r.round_result_key
            FROM rounds r
            WHERE r.round_id BETWEEN %s AND %s
              AND (
                %s::text IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM round_players rp2
                    WHERE rp2.round_id = r.round_id
                      AND (
                        %s::text IS NULL
                        OR (
                            (%s = false AND REGEXP_REPLACE(rp2.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s)
                            OR (%s = true AND LOWER(REGEXP_REPLACE(rp2.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER(%s))
                        )
                      )
                      AND (
                        %s::text IS NULL
                        OR (
                            (%s = false AND rp2.job ILIKE %s)
                            OR (%s = true AND LOWER(rp2.job) = LOWER(%s))
                        )
                      )
                )
              )
        ),
        player_counts AS (
            SELECT
                fr.round_id,
                COUNT(
                    DISTINCT COALESCE(
                        NULLIF(LOWER(BTRIM(rp.username)), ''),
                        CASE
                            WHEN rp.player_guid IS NOT NULL THEN 'guid:' || LOWER(rp.player_guid::text)
                            ELSE NULL
                        END,
                        'row:' || rp.id::text
                    )
                )::int AS player_count
            FROM filtered_rounds fr
            LEFT JOIN round_players rp ON rp.round_id = fr.round_id
            GROUP BY fr.round_id
            HAVING COUNT(
                DISTINCT COALESCE(
                    NULLIF(LOWER(BTRIM(rp.username)), ''),
                    CASE
                        WHEN rp.player_guid IS NOT NULL THEN 'guid:' || LOWER(rp.player_guid::text)
                        ELSE NULL
                    END,
                    'row:' || rp.id::text
                )
            ) > 0
        ),
        decisive AS (
            SELECT
                fr.round_id,
                CASE
                    WHEN fr.round_result_key IN ('marine major', 'marine minor') THEN 1
                    WHEN fr.round_result_key IN ('xeno major', 'xeno minor') THEN 0
                    ELSE NULL
                END AS marine_win_flag
            FROM filtered_rounds fr
            WHERE fr.round_result_key IN ('marine major', 'marine minor', 'xeno major', 'xeno minor')
        ),
        decisive_rolling AS (
            SELECT
                d.round_id,
                AVG(d.marine_win_flag::float) OVER (
                    ORDER BY d.round_id
                    ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
                ) * 100.0 AS marine_wr_rolling_20_pct
            FROM decisive d
        )
        SELECT
            pc.round_id,
            pc.player_count,
            dr.marine_wr_rolling_20_pct
        FROM player_counts pc
        LEFT JOIN decisive_rolling dr ON dr.round_id = pc.round_id
        ORDER BY pc.round_id;
    """

    points: list[dict[str, int | float | None]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    character_name_value,
                    character_name_strict,
                    normalized_name_pattern,
                    character_name_strict,
                    normalized_name,
                    character_job_value,
                    character_job_strict,
                    job_pattern,
                    character_job_strict,
                    character_job_value,
                ),
            )
            for round_id, player_count, marine_wr_rolling_20_pct in cur.fetchall():
                points.append(
                    {
                        "round_id": int(round_id),
                        "player_count": int(player_count),
                        "marine_wr_rolling_20_pct": (
                            round(float(marine_wr_rolling_20_pct), 2)
                            if marine_wr_rolling_20_pct is not None
                            else None
                        ),
                    }
                )
    return points


def get_latest_round_id(db_url: str) -> int | None:
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT MAX(round_id) FROM rounds;")
            row = cur.fetchone()
    if not row or row[0] is None:
        return None
    return int(row[0])


def get_jobs(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    username: str | None,
) -> list[dict[str, int]]:
    character_name_value, character_name_strict = parse_search_query(character_name)
    username_value, username_strict = parse_search_query(username)
    normalized_name = normalize_character_search(character_name_value)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name and not character_name_strict else None
    username_pattern = f"%{username_value}%" if username_value and not username_strict else None
    query = """
        SELECT rp.job, COUNT(DISTINCT rp.round_id) AS games
        FROM round_players rp
        JOIN rounds r ON r.round_id = rp.round_id
        WHERE r.round_id BETWEEN %s AND %s
          AND (
            %s::text IS NULL
            OR (
                (%s = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s)
                OR (%s = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER(%s))
            )
          )
          AND (
            %s::text IS NULL
            OR (
                (%s = false AND rp.username ILIKE %s)
                OR (%s = true AND LOWER(rp.username) = LOWER(%s))
            )
          )
        GROUP BY rp.job
        ORDER BY games DESC, rp.job ASC;
    """

    rows: list[dict[str, int]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    character_name_value,
                    character_name_strict,
                    normalized_name_pattern,
                    character_name_strict,
                    normalized_name,
                    username_value,
                    username_strict,
                    username_pattern,
                    username_strict,
                    username_value,
                ),
            )
            for job, games in cur.fetchall():
                rows.append({"job": str(job), "games": int(games)})
    return rows


def get_players_for_job(
    db_url: str, start_round: int, end_round: int, job: str
) -> list[dict[str, str | int | float | None]]:
    query = """
        SELECT
            rp.username,
            rp.player_guid::text AS player_guid,
            REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g') AS character_name,
            COUNT(DISTINCT r.round_id)::int AS games,
            COUNT(DISTINCT CASE WHEN r.round_result_key IN ('marine major', 'marine minor') THEN r.round_id END)::int AS marine_wins,
            COUNT(DISTINCT CASE WHEN r.round_result_key IN ('xeno major', 'xeno minor') THEN r.round_id END)::int AS xeno_wins
        FROM round_players rp
        JOIN rounds r ON r.round_id = rp.round_id
        WHERE r.round_id BETWEEN %s AND %s
          AND rp.job = %s
        GROUP BY rp.username, rp.player_guid, REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g')
        ORDER BY games DESC, rp.username ASC, character_name ASC;
    """

    players: list[dict[str, str | int | float | None]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(query, (start_round, end_round, job))
            for username, player_guid, character_name, games, marine_wins, xeno_wins in cur.fetchall():
                decisive = int(marine_wins) + int(xeno_wins)
                marine_winrate = round((int(marine_wins) * 100.0 / decisive), 2) if decisive > 0 else None
                players.append(
                    {
                        "username": str(username),
                        "player_guid": player_guid,
                        "character_name": str(character_name),
                        "games": int(games),
                        "marine_wins": int(marine_wins),
                        "xeno_wins": int(xeno_wins),
                        "marine_winrate_pct": marine_winrate,
                    }
                )
    return players


def get_map_winrates(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    character_job: str | None,
) -> list[dict[str, str | int | float]]:
    character_name_value, character_name_strict = parse_search_query(character_name)
    character_job_value, character_job_strict = parse_search_query(character_job)
    normalized_name = normalize_character_search(character_name_value)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name and not character_name_strict else None
    job_pattern = f"%{character_job_value}%" if character_job_value and not character_job_strict else None

    query = """
        SELECT
            r.map_name,
            COUNT(*)::int AS total_rounds,
            COUNT(CASE WHEN r.round_result_key = 'marine major' THEN 1 END)::int AS marine_major,
            COUNT(CASE WHEN r.round_result_key = 'marine minor' THEN 1 END)::int AS marine_minor,
            COUNT(CASE WHEN r.round_result_key = 'xeno minor' THEN 1 END)::int AS xeno_minor,
            COUNT(CASE WHEN r.round_result_key = 'xeno major' THEN 1 END)::int AS xeno_major,
            COUNT(CASE WHEN r.round_result_key = 'draw' THEN 1 END)::int AS draw_count,
            AVG(EXTRACT(EPOCH FROM r.duration_text::interval))::float AS avg_match_length_seconds
        FROM rounds r
        WHERE r.round_id BETWEEN %s AND %s
          AND (
            %s::text IS NULL
            OR EXISTS (
                SELECT 1
                FROM round_players rp
                WHERE rp.round_id = r.round_id
                  AND (
                    %s::text IS NULL
                    OR (
                        (%s = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s)
                        OR (%s = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER(%s))
                    )
                  )
                  AND (
                    %s::text IS NULL
                    OR (
                        (%s = false AND rp.job ILIKE %s)
                        OR (%s = true AND LOWER(rp.job) = LOWER(%s))
                    )
                  )
            )
          )
          AND r.round_result_key = ANY(%s)
        GROUP BY r.map_name
        ORDER BY total_rounds DESC, r.map_name ASC;
    """

    rows: list[dict[str, str | int | float]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    character_name_value,
                    character_name_strict,
                    normalized_name_pattern,
                    character_name_strict,
                    normalized_name,
                    character_job_value,
                    character_job_strict,
                    job_pattern,
                    character_job_strict,
                    character_job_value,
                    RESULT_BUCKETS,
                ),
            )
            for (
                map_name,
                total_rounds,
                marine_major,
                marine_minor,
                xeno_minor,
                xeno_major,
                draw_count,
                avg_match_length_seconds,
            ) in cur.fetchall():
                marine_total = int(marine_major) + int(marine_minor)
                xeno_total = int(xeno_major) + int(xeno_minor)
                decisive_total = marine_total + xeno_total
                marine_wr = round(marine_total * 100.0 / decisive_total, 2) if decisive_total > 0 else 0.0
                avg_len_seconds = float(avg_match_length_seconds or 0.0)
                hours = int(avg_len_seconds // 3600)
                minutes = int((avg_len_seconds % 3600) // 60)
                seconds = int(avg_len_seconds % 60)
                avg_len_text = f"{hours:02d}:{minutes:02d}:{seconds:02d}"

                rows.append(
                    {
                        "map_name": str(map_name),
                        "total_rounds": int(total_rounds),
                        "marine_major": int(marine_major),
                        "marine_minor": int(marine_minor),
                        "xeno_minor": int(xeno_minor),
                        "xeno_major": int(xeno_major),
                        "draw": int(draw_count),
                        "marine_winrate_pct": marine_wr,
                        "avg_match_length": avg_len_text,
                        "avg_match_length_seconds": round(avg_len_seconds, 2),
                    }
                )

    return rows


def get_my_games(
    db_url: str, start_round: int, end_round: int, query_text: str
) -> list[dict[str, str | int]]:
    raw, strict = parse_search_query(query_text)
    if not raw:
        return []

    like_pattern = f"%{raw}%"
    normalized = normalize_character_search(raw) or raw
    normalized_like = f"%{normalized}%"

    query = """
        SELECT
            r.round_id,
            r.round_date::text AS round_date,
            r.map_name,
            r.duration_text,
            r.round_result_key,
            r.download_link,
            STRING_AGG(
                DISTINCT (
                    REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g') || ' [' || rp.job || ']'
                ),
                ', '
            ) AS your_characters_jobs
        FROM rounds r
        JOIN round_players rp ON rp.round_id = r.round_id
        WHERE r.round_id BETWEEN %s AND %s
          AND (
              (%s = false AND (
                  rp.username ILIKE %s
                  OR REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s
              ))
              OR (%s = true AND (
                  LOWER(rp.username) = LOWER(%s)
                  OR LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER(%s)
              ))
          )
        GROUP BY
            r.round_id,
            r.round_date,
            r.map_name,
            r.duration_text,
            r.round_result_key,
            r.download_link
        ORDER BY r.round_id DESC;
    """

    rows: list[dict[str, str | int]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    strict,
                    like_pattern,
                    normalized_like,
                    strict,
                    raw,
                    normalized,
                ),
            )
            for (
                round_id,
                round_date,
                map_name,
                duration_text,
                round_result_key,
                download_link,
                your_characters_jobs,
            ) in cur.fetchall():
                rows.append(
                    {
                        "round_id": int(round_id),
                        "round_date": str(round_date),
                        "map_name": str(map_name),
                        "duration_text": str(duration_text),
                        "round_result_key": str(round_result_key),
                        "download_link": str(download_link),
                        "your_characters_jobs": str(your_characters_jobs or ""),
                    }
                )
    return rows


@app.get("/")
def index():
    latest_round_id = get_latest_round_id(DEFAULT_DB_URL)
    if latest_round_id is None:
        default_end_round = DEFAULT_END_ROUND
    else:
        default_end_round = latest_round_id
    default_start_round = max(1, default_end_round - 100)
    return render_template(
        "index.html",
        default_start_round=default_start_round,
        default_end_round=default_end_round,
    )


@app.get("/api/winrates")
def api_winrates():
    start_raw = request.args.get("start_round", str(DEFAULT_START_ROUND))
    end_raw = request.args.get("end_round", str(DEFAULT_END_ROUND))
    character_name = request.args.get("character_name", "").strip() or None
    character_job = request.args.get("character_job", "").strip() or None

    try:
        start_round = int(start_raw)
        end_round = int(end_raw)
    except ValueError:
        return jsonify({"error": "start_round and end_round must be integers."}), 400

    if start_round > end_round:
        return jsonify({"error": "start_round must be less than or equal to end_round."}), 400

    rows, total = get_winrate_rows(
        DEFAULT_DB_URL, start_round, end_round, character_name, character_job
    )
    player_counts = get_player_counts(
        DEFAULT_DB_URL, start_round, end_round, character_name, character_job
    )
    return jsonify(
        {
            "start_round": start_round,
            "end_round": end_round,
            "character_name": character_name,
            "character_job": character_job,
            "total_rounds": total,
            "results": [
                {
                    "result_key": r.result_key,
                    "count": r.count,
                    "percentage": r.percentage,
                }
                for r in rows
            ],
            "player_counts": player_counts,
        }
    )


@app.get("/api/jobs")
def api_jobs():
    start_raw = request.args.get("start_round", str(DEFAULT_START_ROUND))
    end_raw = request.args.get("end_round", str(DEFAULT_END_ROUND))
    character_name = request.args.get("character_name", "").strip() or None
    username = request.args.get("username", "").strip() or None

    try:
        start_round = int(start_raw)
        end_round = int(end_raw)
    except ValueError:
        return jsonify({"error": "start_round and end_round must be integers."}), 400

    if start_round > end_round:
        return jsonify({"error": "start_round must be less than or equal to end_round."}), 400

    jobs = get_jobs(DEFAULT_DB_URL, start_round, end_round, character_name, username)
    return jsonify(
        {
            "start_round": start_round,
            "end_round": end_round,
            "character_name": character_name,
            "username": username,
            "jobs": jobs,
        }
    )


@app.get("/api/jobs/<path:job_name>/players")
def api_job_players(job_name: str):
    start_raw = request.args.get("start_round", str(DEFAULT_START_ROUND))
    end_raw = request.args.get("end_round", str(DEFAULT_END_ROUND))

    try:
        start_round = int(start_raw)
        end_round = int(end_raw)
    except ValueError:
        return jsonify({"error": "start_round and end_round must be integers."}), 400

    if start_round > end_round:
        return jsonify({"error": "start_round must be less than or equal to end_round."}), 400

    decoded_job = unquote(job_name)
    players = get_players_for_job(DEFAULT_DB_URL, start_round, end_round, decoded_job)
    return jsonify(
        {
            "start_round": start_round,
            "end_round": end_round,
            "job": decoded_job,
            "players": players,
        }
    )


@app.get("/api/map-winrates")
def api_map_winrates():
    start_raw = request.args.get("start_round", str(DEFAULT_START_ROUND))
    end_raw = request.args.get("end_round", str(DEFAULT_END_ROUND))
    character_name = request.args.get("character_name", "").strip() or None
    character_job = request.args.get("character_job", "").strip() or None

    try:
        start_round = int(start_raw)
        end_round = int(end_raw)
    except ValueError:
        return jsonify({"error": "start_round and end_round must be integers."}), 400

    if start_round > end_round:
        return jsonify({"error": "start_round must be less than or equal to end_round."}), 400

    rows = get_map_winrates(
        DEFAULT_DB_URL, start_round, end_round, character_name, character_job
    )
    return jsonify(
        {
            "start_round": start_round,
            "end_round": end_round,
            "character_name": character_name,
            "character_job": character_job,
            "maps": rows,
        }
    )


@app.get("/api/my-games")
def api_my_games():
    start_raw = request.args.get("start_round", str(DEFAULT_START_ROUND))
    end_raw = request.args.get("end_round", str(DEFAULT_END_ROUND))
    query_text = request.args.get("q", "").strip()

    try:
        start_round = int(start_raw)
        end_round = int(end_raw)
    except ValueError:
        return jsonify({"error": "start_round and end_round must be integers."}), 400

    if start_round > end_round:
        return jsonify({"error": "start_round must be less than or equal to end_round."}), 400
    if not query_text:
        return jsonify({"error": "Please enter a character name or username."}), 400

    games = get_my_games(DEFAULT_DB_URL, start_round, end_round, query_text)
    return jsonify(
        {
            "start_round": start_round,
            "end_round": end_round,
            "query": query_text,
            "games": games,
        }
    )


@app.get("/api/latest-round")
def api_latest_round():
    latest_round_id = get_latest_round_id(DEFAULT_DB_URL)
    return jsonify({"latest_round_id": latest_round_id})


@app.post("/api/manual-scrape-next")
def api_manual_scrape_next():
    try:
        with psycopg.connect(DEFAULT_DB_URL) as conn:
            with conn.transaction():
                scraper_ensure_schema(conn)
            next_round_id = get_next_round_id(conn)
            url = DEFAULT_URL_TEMPLATE.format(round_id=next_round_id)
            round_data = parse_round_data(url)
            with conn.transaction():
                upsert_round(conn, round_data)
        return jsonify(
            {
                "ok": True,
                "next_round_id": next_round_id,
                "round_id": round_data.round_id,
                "inserted_players": len(round_data.players),
                "message": f"Inserted round {round_data.round_id}.",
            }
        )
    except Exception as exc:
        return jsonify({"ok": False, "message": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
