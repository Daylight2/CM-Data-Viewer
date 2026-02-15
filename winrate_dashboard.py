from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
from urllib.parse import unquote

import psycopg
from flask import Flask, jsonify, render_template, request


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


def get_winrate_rows(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    character_job: str | None,
) -> tuple[list[WinrateRow], int]:
    bucket_counts = {key: 0 for key in RESULT_BUCKETS}
    total = 0
    name_pattern = f"%{character_name.strip()}%" if character_name else None
    job_pattern = f"%{character_job.strip()}%" if character_job else None
    normalized_name = normalize_character_search(character_name)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name else None

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
                  AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s
                  AND (%s::text IS NULL OR rp.job ILIKE %s)
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
                    name_pattern,
                    normalized_name_pattern,
                    job_pattern,
                    job_pattern,
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
) -> list[dict[str, int]]:
    name_pattern = f"%{character_name.strip()}%" if character_name else None
    job_pattern = f"%{character_job.strip()}%" if character_job else None
    normalized_name = normalize_character_search(character_name)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name else None
    query = """
        SELECT r.round_id, COUNT(rp.id) AS player_count
        FROM rounds r
        LEFT JOIN round_players rp ON rp.round_id = r.round_id
        WHERE r.round_id BETWEEN %s AND %s
          AND (
            %s::text IS NULL
            OR EXISTS (
                SELECT 1
                FROM round_players rp2
                WHERE rp2.round_id = r.round_id
                  AND REGEXP_REPLACE(rp2.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s
                  AND (%s::text IS NULL OR rp2.job ILIKE %s)
            )
          )
        GROUP BY r.round_id
        HAVING COUNT(rp.id) > 0
        ORDER BY r.round_id;
    """

    points: list[dict[str, int]] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query,
                (
                    start_round,
                    end_round,
                    name_pattern,
                    normalized_name_pattern,
                    job_pattern,
                    job_pattern,
                ),
            )
            for round_id, player_count in cur.fetchall():
                points.append(
                    {
                        "round_id": int(round_id),
                        "player_count": int(player_count),
                    }
                )
    return points


def get_jobs(
    db_url: str,
    start_round: int,
    end_round: int,
    character_name: str | None,
    username: str | None,
) -> list[dict[str, int]]:
    name_pattern = f"%{character_name.strip()}%" if character_name else None
    username_pattern = f"%{username.strip()}%" if username else None
    normalized_name = normalize_character_search(character_name)
    normalized_name_pattern = f"%{normalized_name}%" if normalized_name else None
    query = """
        SELECT rp.job, COUNT(DISTINCT rp.round_id) AS games
        FROM round_players rp
        JOIN rounds r ON r.round_id = rp.round_id
        WHERE r.round_id BETWEEN %s AND %s
          AND (
            %s::text IS NULL
            OR REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE %s
          )
          AND (%s::text IS NULL OR rp.username ILIKE %s)
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
                    name_pattern,
                    normalized_name_pattern,
                    username_pattern,
                    username_pattern,
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


@app.get("/")
def index():
    return render_template(
        "index.html",
        default_start_round=DEFAULT_START_ROUND,
        default_end_round=DEFAULT_END_ROUND,
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
