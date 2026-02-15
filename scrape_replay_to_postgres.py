import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.parse import urljoin

import psycopg
import requests
from bs4 import BeautifulSoup


RESULT_TEXT_TO_BUCKET = [
    (
        "The last of the xenonids were purged. It's safe to breathe again... for now.",
        "marine major",
    ),
    (
        "With the queen eliminated, the xenonid hive collapses. For now, the area is safe.",
        "marine major",
    ),
    (
        "The queen has been eliminated, and with her, the hive's coordination falters. The few remaining xenonids pose little threat, but the war is not over.",
        "marine minor",
    ),
    (
        "With no prey left to hunt, the xenonids roam freely. The intruders are gone. They have scattered, been slain, or have fled, leaving the hive unchallenged.",
        "xeno major",
    ),
    (
        "The xenonids hijacked the metal bird, forcing their way into the metal hive to seek the rest of the hosts. However, the marines fought back, eliminating the threat in orbit. Though the ship is safe and evacuated, the surface remains overrun, and the xenonids endure.",
        "xeno minor",
    ),
    (
        "The xenonids hijacked the metal bird and entered the metal hive, igniting a brutal battle in the sky. In the chaos, the vessel lost control and crashed into the surface before everyone could evacuate. All hands were lost. Yet, the surface remains overrun, and the xenonids endure.",
        "xeno minor",
    ),
    (
        "Neither marines nor xenonids survived the carnage. The battlefield lies silent, a graveyard for both.",
        "draw",
    ),
    (
        "ARES 3.2 Log Error: Operation records are missing or corrupted. Please contact support with error code 404 for further assistance.",
        "error",
    ),
]

SECRETS_FILE = "local_secrets.json"
DEFAULT_URL_TEMPLATE = "https://replays.iterator.systems/replay/rmc14/alamo/{round_id}"
DEFAULT_START_ROUND = 10380
DEFAULT_END_ROUND = 10429


@dataclass
class PlayerRecord:
    player_guid: str | None
    username: str
    character_name: str
    job: str
    is_antag: bool


@dataclass
class RoundRecord:
    round_id: int
    map_name: str
    duration_text: str
    round_date: date
    round_end_text: str
    round_result_key: str | None
    download_link: str
    source_url: str
    players: list[PlayerRecord]


def normalize_text(text: str) -> str:
    cleaned = text.replace("\u2019", "'").replace("\u00b4", "'").replace("`", "'")
    cleaned = re.sub(r"\[/?(?:color|bold)[^\]]*\]", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    return cleaned


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
    raise SystemExit(
        "Missing database_url. Put it in local_secrets.json or set DATABASE_URL."
    )


def classify_result(round_end_text: str) -> str | None:
    normalized_end = normalize_text(round_end_text)
    for message, bucket in RESULT_TEXT_TO_BUCKET:
        if normalize_text(message) in normalized_end:
            return bucket
    return None


def extract_label_value_pairs(main_soup: BeautifulSoup) -> dict[str, str]:
    values: dict[str, str] = {}
    for p in main_soup.select("main p"):
        text = p.get_text(" ", strip=True)
        if ":" not in text:
            continue
        label, value = text.split(":", 1)
        values[label.strip()] = value.strip()
    return values


def extract_download_link(main_soup: BeautifulSoup) -> str:
    for a in main_soup.select("main a[href]"):
        if a.get_text(strip=True).lower() == "download":
            return a["href"].strip()
    raise ValueError("Download link not found")


def extract_replay_id(main_soup: BeautifulSoup) -> int:
    for elem in main_soup.select("[id]"):
        elem_id = elem.get("id", "")
        match = re.match(r"buttonPlayers-(\d+)$", elem_id)
        if match:
            return int(match.group(1))
    raise ValueError("Replay ID not found in page markup")


def parse_api_players(api_data: dict[str, Any]) -> list[PlayerRecord]:
    players: list[PlayerRecord] = []
    participants = api_data.get("roundParticipants") or []
    for participant in participants:
        player_guid = participant.get("playerGuid")
        username = participant.get("username") or "Unknown"
        for pl in participant.get("players") or []:
            job_prototypes = pl.get("jobPrototypes") or []
            antag_prototypes = pl.get("antagPrototypes") or []
            players.append(
                PlayerRecord(
                    player_guid=player_guid,
                    username=username,
                    character_name=(pl.get("playerIcName") or "Unknown").strip(),
                    job=(job_prototypes[0] if job_prototypes else "Unknown").strip(),
                    is_antag=len(antag_prototypes) > 0,
                )
            )
    return players


def parse_round_data(url: str, timeout: int = 30) -> RoundRecord:
    session = requests.Session()
    response = session.get(url, timeout=timeout)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    values = extract_label_value_pairs(soup)

    map_name = values.get("Maps")
    duration_text = values.get("Duration")
    date_text = values.get("Date")
    round_id_text = values.get("Round ID")

    missing = [
        k for k, v in {
            "Maps": map_name,
            "Duration": duration_text,
            "Date": date_text,
            "Round ID": round_id_text,
        }.items() if not v
    ]
    if missing:
        raise ValueError(f"Missing required fields in HTML: {', '.join(missing)}")

    replay_id = extract_replay_id(soup)
    api_url = urljoin(url, f"/api/Replay/{replay_id}")
    api_response = session.get(api_url, timeout=timeout)
    api_response.raise_for_status()
    api_data = api_response.json()

    round_end_text = (api_data.get("roundEndText") or "").strip()
    if not round_end_text:
        round_end_text = "No round end text available."

    download_link = extract_download_link(soup)
    players = parse_api_players(api_data)

    return RoundRecord(
        round_id=int(round_id_text),
        map_name=map_name,
        duration_text=duration_text,
        round_date=date.fromisoformat(date_text),
        round_end_text=round_end_text,
        round_result_key=classify_result(round_end_text),
        download_link=download_link,
        source_url=url,
        players=players,
    )


def ensure_schema(conn: psycopg.Connection) -> None:
    conn.execute(
        """
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
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS round_players (
            id BIGSERIAL PRIMARY KEY,
            round_id BIGINT NOT NULL REFERENCES rounds(round_id) ON DELETE CASCADE,
            player_guid UUID,
            username TEXT NOT NULL,
            character_name TEXT NOT NULL,
            job TEXT NOT NULL,
            is_antag BOOLEAN NOT NULL DEFAULT FALSE
        );
        """
    )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_round_players_round_id
            ON round_players(round_id);
        """
    )


def upsert_round(conn: psycopg.Connection, round_data: RoundRecord) -> None:
    conn.execute(
        """
        INSERT INTO rounds (
            round_id, map_name, duration_text, round_date, round_end_text,
            round_result_key, download_link, source_url
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (round_id)
        DO UPDATE SET
            map_name = EXCLUDED.map_name,
            duration_text = EXCLUDED.duration_text,
            round_date = EXCLUDED.round_date,
            round_end_text = EXCLUDED.round_end_text,
            round_result_key = EXCLUDED.round_result_key,
            download_link = EXCLUDED.download_link,
            source_url = EXCLUDED.source_url,
            scraped_at = NOW();
        """,
        (
            round_data.round_id,
            round_data.map_name,
            round_data.duration_text,
            round_data.round_date,
            round_data.round_end_text,
            round_data.round_result_key,
            round_data.download_link,
            round_data.source_url,
        ),
    )

    conn.execute("DELETE FROM round_players WHERE round_id = %s", (round_data.round_id,))

    if round_data.players:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO round_players (
                    round_id, player_guid, username, character_name, job, is_antag
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        round_data.round_id,
                        p.player_guid,
                        p.username,
                        p.character_name,
                        p.job,
                        p.is_antag,
                    )
                    for p in round_data.players
                ],
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape replay pages and store round + player data in PostgreSQL."
    )
    parser.add_argument(
        "--url-template",
        default=DEFAULT_URL_TEMPLATE,
        help="Replay URL template. Must contain {round_id}.",
    )
    parser.add_argument(
        "--start-round",
        type=int,
        default=DEFAULT_START_ROUND,
        help="Start round ID (inclusive).",
    )
    parser.add_argument(
        "--end-round",
        type=int,
        default=DEFAULT_END_ROUND,
        help="End round ID (inclusive).",
    )
    parser.add_argument(
        "--db-url",
        default=load_db_url(),
        help="PostgreSQL DSN. Defaults to local_secrets.json database_url.",
    )
    parser.add_argument(
        "--print-json",
        action="store_true",
        help="Print scraped payload as JSON after writing to DB.",
    )
    args = parser.parse_args()

    if "{round_id}" not in args.url_template:
        raise SystemExit("url-template must contain {round_id}.")
    if args.start_round > args.end_round:
        raise SystemExit("start-round must be <= end-round.")

    scraped = 0
    failed: list[int] = []
    with psycopg.connect(args.db_url) as conn:
        with conn.transaction():
            ensure_schema(conn)

        for round_id in range(args.start_round, args.end_round + 1):
            url = args.url_template.format(round_id=round_id)
            try:
                round_data = parse_round_data(url)
            except Exception as exc:
                failed.append(round_id)
                print(f"Failed round {round_id}: {exc}")
                continue

            with conn.transaction():
                upsert_round(conn, round_data)

            scraped += 1
            print(
                f"Upserted round {round_data.round_id} with {len(round_data.players)} players. "
                f"result={round_data.round_result_key or 'unknown'}"
            )

            if args.print_json:
                print(
                    json.dumps(
                        {
                            "round_id": round_data.round_id,
                            "map": round_data.map_name,
                            "duration": round_data.duration_text,
                            "date": round_data.round_date.isoformat(),
                            "round_result_key": round_data.round_result_key,
                            "round_end_text": round_data.round_end_text,
                            "download_link": round_data.download_link,
                            "source_url": round_data.source_url,
                            "players": [
                                {
                                    "player_guid": p.player_guid,
                                    "username": p.username,
                                    "character_name": p.character_name,
                                    "job": p.job,
                                    "is_antag": p.is_antag,
                                }
                                for p in round_data.players
                            ],
                        },
                        indent=2,
                    )
                )

    print(
        f"Completed range {args.start_round}-{args.end_round}: "
        f"scraped={scraped}, failed={len(failed)}"
    )


if __name__ == "__main__":
    main()
