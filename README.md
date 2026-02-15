# Replay Scraper -> PostgreSQL

Scrapes replay metadata and players from:
- HTML page: `https://replays.iterator.systems/replay/rmc14/alamo/10403`
- Replay API endpoint discovered from page markup: `/api/Replay/{replayId}`

## Captured fields
- map
- duration
- date
- round_id (primary key)
- game result key (classified from `round_end_text`)
- full `round_end_text`
- players
- each player's job
- download link

## Files
- `scrape_replay_to_postgres.py`: scraper + DB upsert
- `schema.sql`: explicit schema (also auto-created by script)

## Install
```powershell
python -m pip install requests beautifulsoup4 psycopg[binary]
```

## Run
Set your Postgres DSN:
```powershell
$env:DATABASE_URL = "postgresql://user:password@localhost:5432/mydb"
```

Run scraper:
```powershell
python scrape_replay_to_postgres.py --url "https://replays.iterator.systems/replay/rmc14/alamo/10403" --print-json
```

Optional explicit DSN:
```powershell
python scrape_replay_to_postgres.py --db-url "postgresql://user:password@localhost:5432/mydb"
```

## Notes
- `round_id` is upserted in `rounds`.
- Existing `round_players` rows for that `round_id` are replaced on each run.
- `round_result_key` is derived by matching known canonical end-text variants.
