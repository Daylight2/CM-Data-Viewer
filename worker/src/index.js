import postgres from "postgres";

const RESULT_BUCKETS = [
  "marine major",
  "marine minor",
  "xeno minor",
  "xeno major",
  "draw",
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseIntParam(value, fallback) {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) ? n : null;
}

function parseSearchQuery(value) {
  if (!value) return { value: null, strict: false };
  const raw = String(value).trim();
  const strict = raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"");
  const cleaned = strict ? raw.slice(1, -1).trim() : raw;
  return { value: cleaned || null, strict };
}

function normalizeCharacterSearch(value) {
  if (!value) return null;
  return value
    .replace(/(\([^)]*\)|\[[^\]]*\])/g, (m) => m.replace(/[0-9]+/g, ""))
    .trim();
}

function getDb(env) {
  const connectionString =
    env?.HYPERDRIVE?.connectionString || env?.DATABASE_URL || null;
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL (or HYPERDRIVE binding).");
  }
  return postgres(connectionString, { prepare: false, max: 1 });
}

async function withDb(env, fn) {
  const db = getDb(env);
  try {
    return await fn(db);
  } finally {
    try {
      await db.end({ timeout: 1 });
    } catch {
      // ignore close errors
    }
  }
}

async function getWinrateRows(db, startRound, endRound, characterName, characterJob) {
  const nameQ = parseSearchQuery(characterName);
  const jobQ = parseSearchQuery(characterJob);
  const normalizedName = normalizeCharacterSearch(nameQ.value);
  const normalizedNamePattern =
    normalizedName && !nameQ.strict ? `%${normalizedName}%` : null;
  const normalizedJobPattern = jobQ.value && !jobQ.strict ? `%${jobQ.value}%` : null;

  const rows = await db.unsafe(
    `
      SELECT r.round_result_key, COUNT(*) AS cnt
      FROM public.rounds r
      WHERE r.round_id BETWEEN $1 AND $2
        AND r.round_result_key = ANY($3::text[])
        AND (
          $4::text IS NULL
          OR EXISTS (
              SELECT 1
              FROM public.round_players rp
              WHERE rp.round_id = r.round_id
                AND (
                  ($5 = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE $6)
                  OR ($5 = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER($7))
                )
                AND (
                  $8::text IS NULL
                  OR (
                    ($9 = false AND rp.job ILIKE $10)
                    OR ($9 = true AND LOWER(rp.job) = LOWER($11))
                  )
                )
          )
        )
      GROUP BY r.round_result_key;
    `,
    [
      startRound,
      endRound,
      RESULT_BUCKETS,
      nameQ.value,
      nameQ.strict,
      normalizedNamePattern,
      normalizedName,
      jobQ.value,
      jobQ.strict,
      normalizedJobPattern,
      jobQ.value,
    ]
  );

  const counts = Object.fromEntries(RESULT_BUCKETS.map((k) => [k, 0]));
  let total = 0;
  for (const row of rows) {
    const cnt = Number(row.cnt || 0);
    counts[row.round_result_key] = cnt;
    total += cnt;
  }

  return {
    total,
    results: RESULT_BUCKETS.map((k) => ({
      result_key: k,
      count: counts[k],
      percentage: total > 0 ? Number(((counts[k] * 100) / total).toFixed(2)) : 0,
    })),
  };
}

async function getPlayerCounts(db, startRound, endRound, characterName, characterJob) {
  const nameQ = parseSearchQuery(characterName);
  const jobQ = parseSearchQuery(characterJob);
  const normalizedName = normalizeCharacterSearch(nameQ.value);
  const normalizedNamePattern =
    normalizedName && !nameQ.strict ? `%${normalizedName}%` : null;
  const normalizedJobPattern = jobQ.value && !jobQ.strict ? `%${jobQ.value}%` : null;

  const rows = await db.unsafe(
    `
      WITH filtered_rounds AS (
          SELECT r.round_id, r.round_result_key
          FROM public.rounds r
          WHERE r.round_id BETWEEN $1 AND $2
            AND (
              $3::text IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM public.round_players rp2
                  WHERE rp2.round_id = r.round_id
                    AND (
                      ($4 = false AND REGEXP_REPLACE(rp2.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE $5)
                      OR ($4 = true AND LOWER(REGEXP_REPLACE(rp2.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER($6))
                    )
                    AND (
                      $7::text IS NULL
                      OR (
                        ($8 = false AND rp2.job ILIKE $9)
                        OR ($8 = true AND LOWER(rp2.job) = LOWER($10))
                      )
                    )
              )
            )
      ),
      player_counts AS (
          SELECT fr.round_id, COUNT(rp.id)::int AS player_count
          FROM filtered_rounds fr
          LEFT JOIN public.round_players rp ON rp.round_id = fr.round_id
          GROUP BY fr.round_id
          HAVING COUNT(rp.id) > 0
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
      SELECT pc.round_id, pc.player_count, dr.marine_wr_rolling_20_pct
      FROM player_counts pc
      LEFT JOIN decisive_rolling dr ON dr.round_id = pc.round_id
      ORDER BY pc.round_id;
    `,
    [
      startRound,
      endRound,
      nameQ.value,
      nameQ.strict,
      normalizedNamePattern,
      normalizedName,
      jobQ.value,
      jobQ.strict,
      normalizedJobPattern,
      jobQ.value,
    ]
  );

  return rows.map((r) => ({
    round_id: Number(r.round_id),
    player_count: Number(r.player_count),
    marine_wr_rolling_20_pct:
      r.marine_wr_rolling_20_pct == null
        ? null
        : Number(Number(r.marine_wr_rolling_20_pct).toFixed(2)),
  }));
}

async function getJobs(db, startRound, endRound, characterName, username) {
  const nameQ = parseSearchQuery(characterName);
  const userQ = parseSearchQuery(username);
  const normalizedName = normalizeCharacterSearch(nameQ.value);
  const normalizedNamePattern =
    normalizedName && !nameQ.strict ? `%${normalizedName}%` : null;
  const userPattern = userQ.value && !userQ.strict ? `%${userQ.value}%` : null;

  const rows = await db.unsafe(
    `
      SELECT rp.job, COUNT(DISTINCT rp.round_id) AS games
      FROM public.round_players rp
      JOIN public.rounds r ON r.round_id = rp.round_id
      WHERE r.round_id BETWEEN $1 AND $2
        AND (
          $3::text IS NULL
          OR (
              ($4 = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE $5)
              OR ($4 = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER($6))
          )
        )
        AND (
          $7::text IS NULL
          OR (
              ($8 = false AND rp.username ILIKE $9)
              OR ($8 = true AND LOWER(rp.username) = LOWER($10))
          )
        )
      GROUP BY rp.job
      ORDER BY games DESC, rp.job ASC;
    `,
    [
      startRound,
      endRound,
      nameQ.value,
      nameQ.strict,
      normalizedNamePattern,
      normalizedName,
      userQ.value,
      userQ.strict,
      userPattern,
      userQ.value,
    ]
  );

  return rows.map((r) => ({ job: String(r.job), games: Number(r.games) }));
}

async function getPlayersForJob(db, startRound, endRound, job) {
  const rows = await db.unsafe(
    `
      SELECT
          rp.username,
          rp.player_guid::text AS player_guid,
          REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g') AS character_name,
          COUNT(DISTINCT r.round_id)::int AS games,
          COUNT(DISTINCT CASE WHEN r.round_result_key IN ('marine major', 'marine minor') THEN r.round_id END)::int AS marine_wins,
          COUNT(DISTINCT CASE WHEN r.round_result_key IN ('xeno major', 'xeno minor') THEN r.round_id END)::int AS xeno_wins
      FROM public.round_players rp
      JOIN public.rounds r ON r.round_id = rp.round_id
      WHERE r.round_id BETWEEN $1 AND $2
        AND rp.job = $3
      GROUP BY rp.username, rp.player_guid, REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g')
      ORDER BY games DESC, rp.username ASC, character_name ASC;
    `,
    [startRound, endRound, job]
  );

  return rows.map((r) => {
    const marineWins = Number(r.marine_wins);
    const xenoWins = Number(r.xeno_wins);
    const decisive = marineWins + xenoWins;
    return {
      username: String(r.username),
      player_guid: r.player_guid,
      character_name: String(r.character_name),
      games: Number(r.games),
      marine_wins: marineWins,
      xeno_wins: xenoWins,
      marine_winrate_pct:
        decisive > 0 ? Number(((marineWins * 100) / decisive).toFixed(2)) : null,
    };
  });
}

async function getMapWinrates(db, startRound, endRound, characterName, characterJob) {
  const nameQ = parseSearchQuery(characterName);
  const jobQ = parseSearchQuery(characterJob);
  const normalizedName = normalizeCharacterSearch(nameQ.value);
  const normalizedNamePattern =
    normalizedName && !nameQ.strict ? `%${normalizedName}%` : null;
  const normalizedJobPattern = jobQ.value && !jobQ.strict ? `%${jobQ.value}%` : null;

  const rows = await db.unsafe(
    `
      SELECT
          r.map_name,
          COUNT(*)::int AS total_rounds,
          COUNT(CASE WHEN r.round_result_key = 'marine major' THEN 1 END)::int AS marine_major,
          COUNT(CASE WHEN r.round_result_key = 'marine minor' THEN 1 END)::int AS marine_minor,
          COUNT(CASE WHEN r.round_result_key = 'xeno minor' THEN 1 END)::int AS xeno_minor,
          COUNT(CASE WHEN r.round_result_key = 'xeno major' THEN 1 END)::int AS xeno_major,
          COUNT(CASE WHEN r.round_result_key = 'draw' THEN 1 END)::int AS draw_count,
          AVG(EXTRACT(EPOCH FROM r.duration_text::interval))::float AS avg_match_length_seconds
      FROM public.rounds r
      WHERE r.round_id BETWEEN $1 AND $2
        AND (
          $3::text IS NULL
          OR EXISTS (
              SELECT 1
              FROM public.round_players rp
              WHERE rp.round_id = r.round_id
                AND (
                  ($4 = false AND REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE $5)
                  OR ($4 = true AND LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER($6))
                )
                AND (
                  $7::text IS NULL
                  OR (
                    ($8 = false AND rp.job ILIKE $9)
                    OR ($8 = true AND LOWER(rp.job) = LOWER($10))
                  )
                )
          )
        )
        AND r.round_result_key = ANY($11::text[])
      GROUP BY r.map_name
      ORDER BY total_rounds DESC, r.map_name ASC;
    `,
    [
      startRound,
      endRound,
      nameQ.value,
      nameQ.strict,
      normalizedNamePattern,
      normalizedName,
      jobQ.value,
      jobQ.strict,
      normalizedJobPattern,
      jobQ.value,
      RESULT_BUCKETS,
    ]
  );

  return rows.map((r) => {
    const marineTotal = Number(r.marine_major) + Number(r.marine_minor);
    const xenoTotal = Number(r.xeno_major) + Number(r.xeno_minor);
    const decisive = marineTotal + xenoTotal;
    const avg = Number(r.avg_match_length_seconds || 0);
    const hh = String(Math.floor(avg / 3600)).padStart(2, "0");
    const mm = String(Math.floor((avg % 3600) / 60)).padStart(2, "0");
    const ss = String(Math.floor(avg % 60)).padStart(2, "0");
    return {
      map_name: String(r.map_name),
      total_rounds: Number(r.total_rounds),
      marine_major: Number(r.marine_major),
      marine_minor: Number(r.marine_minor),
      xeno_minor: Number(r.xeno_minor),
      xeno_major: Number(r.xeno_major),
      draw: Number(r.draw_count),
      avg_match_length: `${hh}:${mm}:${ss}`,
      avg_match_length_seconds: Number(avg.toFixed(2)),
      marine_winrate_pct:
        decisive > 0 ? Number(((marineTotal * 100) / decisive).toFixed(2)) : 0,
    };
  });
}

async function getNextRoundId(db) {
  const rows = await db.unsafe(
    `SELECT COALESCE(MAX(round_id), 0)::int + 1 AS next_round_id FROM public.rounds;`
  );
  return Number(rows?.[0]?.next_round_id || 1);
}

async function checkReplayPage(roundId) {
  const replayUrl = `https://replays.iterator.systems/replay/rmc14/alamo/${roundId}`;
  const resp = await fetch(replayUrl, { method: "GET" });
  if (!resp.ok) {
    return { exists: false, replayUrl };
  }
  const html = await resp.text();
  const hasNotFound = /not found|404/i.test(html);
  return { exists: !hasNotFound, replayUrl };
}

async function getMyGames(db, startRound, endRound, queryText) {
  const q = parseSearchQuery(queryText);
  if (!q.value) return [];

  const like = `%${q.value}%`;
  const normalized = normalizeCharacterSearch(q.value) || q.value;
  const normalizedLike = `%${normalized}%`;

  const rows = await db.unsafe(
    `
      SELECT
          r.round_id,
          r.round_date::text AS round_date,
          r.map_name,
          r.duration_text,
          r.round_result_key,
          r.download_link,
          STRING_AGG(
              DISTINCT (REGEXP_REPLACE(rp.character_name, '[0-9]+', '00', 'g') || ' [' || rp.job || ']'),
              ', '
          ) AS your_characters_jobs
      FROM public.rounds r
      JOIN public.round_players rp ON rp.round_id = r.round_id
      WHERE r.round_id BETWEEN $1 AND $2
        AND (
            ($3 = false AND (rp.username ILIKE $4 OR REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g') ILIKE $5))
            OR ($3 = true AND (LOWER(rp.username) = LOWER($6) OR LOWER(REGEXP_REPLACE(rp.character_name, '([\\(\\[][^\\)\\]]*)[0-9]+', '\\1', 'g')) = LOWER($7)))
        )
      GROUP BY r.round_id, r.round_date, r.map_name, r.duration_text, r.round_result_key, r.download_link
      ORDER BY r.round_id DESC;
    `,
    [startRound, endRound, q.strict, like, normalizedLike, q.value, normalized]
  );

  return rows.map((r) => ({
    round_id: Number(r.round_id),
    round_date: String(r.round_date),
    map_name: String(r.map_name),
    duration_text: String(r.duration_text),
    round_result_key: String(r.round_result_key),
    download_link: String(r.download_link),
    your_characters_jobs: String(r.your_characters_jobs || ""),
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/api/winrates") {
        const start = parseIntParam(url.searchParams.get("start_round"), 10300);
        const end = parseIntParam(url.searchParams.get("end_round"), 10400);
        if (start == null || end == null) return json({ error: "start_round and end_round must be integers." }, 400);
        if (start > end) return json({ error: "start_round must be less than or equal to end_round." }, 400);
        const characterName = url.searchParams.get("character_name") || null;
        const characterJob = url.searchParams.get("character_job") || null;
        const { wr, playerCounts } = await withDb(env, async (db) => {
          const wr = await getWinrateRows(db, start, end, characterName, characterJob);
          const playerCounts = await getPlayerCounts(db, start, end, characterName, characterJob);
          return { wr, playerCounts };
        });
        return json({
          start_round: start,
          end_round: end,
          character_name: characterName,
          character_job: characterJob,
          total_rounds: wr.total,
          results: wr.results,
          player_counts: playerCounts,
        });
      }

      if (p === "/api/jobs") {
        const start = parseIntParam(url.searchParams.get("start_round"), 10300);
        const end = parseIntParam(url.searchParams.get("end_round"), 10400);
        if (start == null || end == null) return json({ error: "start_round and end_round must be integers." }, 400);
        if (start > end) return json({ error: "start_round must be less than or equal to end_round." }, 400);
        const characterName = url.searchParams.get("character_name") || null;
        const username = url.searchParams.get("username") || null;
        const jobs = await withDb(env, (db) =>
          getJobs(db, start, end, characterName, username)
        );
        return json({ start_round: start, end_round: end, character_name: characterName, username, jobs });
      }

      if (p.startsWith("/api/jobs/") && p.endsWith("/players")) {
        const start = parseIntParam(url.searchParams.get("start_round"), 10300);
        const end = parseIntParam(url.searchParams.get("end_round"), 10400);
        if (start == null || end == null) return json({ error: "start_round and end_round must be integers." }, 400);
        if (start > end) return json({ error: "start_round must be less than or equal to end_round." }, 400);
        const jobName = decodeURIComponent(
          p.replace("/api/jobs/", "").replace("/players", "")
        );
        const players = await withDb(env, (db) =>
          getPlayersForJob(db, start, end, jobName)
        );
        return json({ start_round: start, end_round: end, job: jobName, players });
      }

      if (p === "/api/map-winrates") {
        const start = parseIntParam(url.searchParams.get("start_round"), 10300);
        const end = parseIntParam(url.searchParams.get("end_round"), 10400);
        if (start == null || end == null) return json({ error: "start_round and end_round must be integers." }, 400);
        if (start > end) return json({ error: "start_round must be less than or equal to end_round." }, 400);
        const characterName = url.searchParams.get("character_name") || null;
        const characterJob = url.searchParams.get("character_job") || null;
        const maps = await withDb(env, (db) =>
          getMapWinrates(db, start, end, characterName, characterJob)
        );
        return json({ start_round: start, end_round: end, character_name: characterName, character_job: characterJob, maps });
      }

      if (p === "/api/my-games") {
        const start = parseIntParam(url.searchParams.get("start_round"), 10300);
        const end = parseIntParam(url.searchParams.get("end_round"), 10400);
        const q = (url.searchParams.get("q") || "").trim();
        if (start == null || end == null) return json({ error: "start_round and end_round must be integers." }, 400);
        if (start > end) return json({ error: "start_round must be less than or equal to end_round." }, 400);
        if (!q) return json({ error: "Please enter a character name or username." }, 400);
        const games = await withDb(env, (db) =>
          getMyGames(db, start, end, q)
        );
        return json({ start_round: start, end_round: end, query: q, games });
      }

      if (p === "/api/manual-scrape-next" && request.method === "POST") {
        const nextRoundId = await withDb(env, (db) => getNextRoundId(db));
        const result = await checkReplayPage(nextRoundId);
        if (!result.exists) {
          return json({
            next_round_id: nextRoundId,
            replay_url: result.replayUrl,
            message: `No new round found at ${nextRoundId}.`,
          });
        }
        return json({
          next_round_id: nextRoundId,
          replay_url: result.replayUrl,
          message: `Round ${nextRoundId} appears to exist. Scraper ingestion is still run separately.`,
        });
      }

      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return env.ASSETS.fetch(request);
      }
      return new Response(
        "Worker is live, but static assets are not bound. Redeploy with wrangler.jsonc assets.directory set to worker/site.",
        {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }
      );
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
