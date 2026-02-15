let chartInstance = null;
let playersChartInstance = null;
let selectedJob = null;
let allJobs = [];
let allPlayersForSelectedJob = [];
let playerSort = { key: "games", dir: "desc" };
let mapSort = { key: "total_rounds", dir: "desc" };

function parseSearchInput(value) {
    const raw = (value || "").trim();
    const strict = raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"");
    const query = strict ? raw.slice(1, -1).trim() : raw;
    return { query: query.toLowerCase(), strict };
}

function matchesSearch(text, searchValue) {
    const { query, strict } = parseSearchInput(searchValue);
    if (!query) {
        return true;
    }
    const hay = String(text || "").toLowerCase();
    return strict ? hay === query : hay.includes(query);
}

function renderTable(results) {
    const tbody = document.getElementById("results-body");
    tbody.innerHTML = "";

    for (const row of results) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${row.result_key}</td>
            <td>${row.count}</td>
            <td>${row.percentage.toFixed(2)}%</td>
        `;
        tbody.appendChild(tr);
    }
}

function renderChart(results) {
    const ctx = document.getElementById("winrate-chart").getContext("2d");
    const labels = results.map((r) => r.result_key);
    const percentages = results.map((r) => r.percentage);

    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: "pie",
        data: {
            labels,
            datasets: [{
                data: percentages,
                backgroundColor: [
                    "#2b8a3e",
                    "#40c057",
                    "#be4bdb",
                    "#9c36b5",
                    "#f59f00"
                ]
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: "top",
                    labels: {
                        color: "#e6edf3",
                        boxWidth: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label(context) {
                            return `${context.label}: ${context.parsed.toFixed(2)}%`;
                        }
                    }
                }
            }
        }
    });
}

function renderPlayersChart(points) {
    const ctx = document.getElementById("players-chart").getContext("2d");
    const labels = points.map((p) => p.round_id);
    const values = points.map((p) => p.player_count);
    const rollingWr = points.map((p) => p.marine_wr_rolling_20_pct);

    if (playersChartInstance) {
        playersChartInstance.destroy();
    }

    playersChartInstance = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Players",
                    data: values,
                    borderColor: "#3fa2ff",
                    backgroundColor: "rgba(63, 162, 255, 0.2)",
                    fill: true,
                    tension: 0.2,
                    pointRadius: 2,
                    yAxisID: "yPlayers"
                },
                {
                    label: "Marine WR% (Rolling 20)",
                    data: rollingWr,
                    borderColor: "#40c057",
                    backgroundColor: "rgba(64, 192, 87, 0.15)",
                    fill: false,
                    tension: 0.2,
                    spanGaps: true,
                    pointRadius: 2,
                    yAxisID: "yWr"
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    labels: { color: "#e6edf3" }
                }
            },
            scales: {
                x: {
                    ticks: { color: "#9db0c0" },
                    grid: { color: "rgba(157, 176, 192, 0.2)" }
                },
                yPlayers: {
                    type: "linear",
                    position: "left",
                    beginAtZero: true,
                    ticks: { color: "#9db0c0" },
                    grid: { color: "rgba(157, 176, 192, 0.2)" }
                },
                yWr: {
                    type: "linear",
                    position: "right",
                    beginAtZero: true,
                    min: 0,
                    max: 100,
                    ticks: {
                        color: "#9db0c0",
                        callback(value) {
                            return `${value}%`;
                        }
                    },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            }
        }
    });
}

function switchTab(tabName) {
    const winratesBtn = document.getElementById("tab-winrates-btn");
    const mapWinratesBtn = document.getElementById("tab-map-winrates-btn");
    const jobsBtn = document.getElementById("tab-jobs-btn");
    const myGamesBtn = document.getElementById("tab-my-games-btn");
    const winratesTab = document.getElementById("tab-winrates");
    const mapWinratesTab = document.getElementById("tab-map-winrates");
    const jobsTab = document.getElementById("tab-jobs");
    const myGamesTab = document.getElementById("tab-my-games");

    if (tabName === "jobs") {
        jobsBtn.classList.add("active");
        winratesBtn.classList.remove("active");
        mapWinratesBtn.classList.remove("active");
        myGamesBtn.classList.remove("active");
        jobsTab.classList.add("active");
        winratesTab.classList.remove("active");
        mapWinratesTab.classList.remove("active");
        myGamesTab.classList.remove("active");
    } else if (tabName === "map-winrates") {
        mapWinratesBtn.classList.add("active");
        winratesBtn.classList.remove("active");
        jobsBtn.classList.remove("active");
        myGamesBtn.classList.remove("active");
        mapWinratesTab.classList.add("active");
        winratesTab.classList.remove("active");
        jobsTab.classList.remove("active");
        myGamesTab.classList.remove("active");
    } else if (tabName === "my-games") {
        myGamesBtn.classList.add("active");
        winratesBtn.classList.remove("active");
        mapWinratesBtn.classList.remove("active");
        jobsBtn.classList.remove("active");
        myGamesTab.classList.add("active");
        winratesTab.classList.remove("active");
        mapWinratesTab.classList.remove("active");
        jobsTab.classList.remove("active");
    } else {
        winratesBtn.classList.add("active");
        mapWinratesBtn.classList.remove("active");
        jobsBtn.classList.remove("active");
        myGamesBtn.classList.remove("active");
        winratesTab.classList.add("active");
        mapWinratesTab.classList.remove("active");
        jobsTab.classList.remove("active");
        myGamesTab.classList.remove("active");
    }
}

function renderMapWinrates(rows) {
    const sorted = [...rows].sort((a, b) => {
        const key = mapSort.key;
        const dir = mapSort.dir;
        const left = a[key];
        const right = b[key];

        if (key === "map_name") {
            const cmp = String(left).localeCompare(String(right));
            return dir === "asc" ? cmp : -cmp;
        }

        const lnum = Number(left);
        const rnum = Number(right);
        if (lnum === rnum) {
            const tie = String(a.map_name).localeCompare(String(b.map_name));
            return dir === "asc" ? tie : -tie;
        }
        return dir === "asc" ? lnum - rnum : rnum - lnum;
    });

    const tbody = document.getElementById("map-winrates-body");
    tbody.innerHTML = "";
    for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${r.map_name}</td>
            <td>${r.total_rounds}</td>
            <td>${r.marine_major}</td>
            <td>${r.marine_minor}</td>
            <td>${r.xeno_minor}</td>
            <td>${r.xeno_major}</td>
            <td>${r.draw}</td>
            <td>${r.avg_match_length}</td>
            <td>${r.marine_winrate_pct.toFixed(2)}%</td>
        `;
        tbody.appendChild(tr);
    }
    updateMapSortHeaderLabels();
}

function updateMapSortHeaderLabels() {
    const keys = [
        "map_name",
        "total_rounds",
        "marine_major",
        "marine_minor",
        "xeno_minor",
        "xeno_major",
        "draw",
        "avg_match_length_seconds",
        "marine_winrate_pct"
    ];
    const labels = {
        map_name: "Map",
        total_rounds: "Total",
        marine_major: "Marine Major",
        marine_minor: "Marine Minor",
        xeno_minor: "Xeno Minor",
        xeno_major: "Xeno Major",
        draw: "Draw",
        avg_match_length_seconds: "Avg Match Length",
        marine_winrate_pct: "Marine WR%"
    };
    for (const key of keys) {
        const th = document.getElementById(`map-sort-${key}`);
        if (!th) {
            continue;
        }
        th.textContent = labels[key];
        if (mapSort.key === key) {
            th.textContent += mapSort.dir === "asc" ? " ^" : " v";
        }
    }
}

async function fetchMapWinrates(startRound, endRound, characterName, characterJob) {
    const params = new URLSearchParams({
        start_round: String(startRound),
        end_round: String(endRound)
    });
    if (characterName && characterName.trim() !== "") {
        params.set("character_name", characterName.trim());
    }
    if (characterJob && characterJob.trim() !== "") {
        params.set("character_job", characterJob.trim());
    }

    const resp = await fetch(`/api/map-winrates?${params.toString()}`);
    const payload = await resp.json();
    if (!resp.ok) {
        throw new Error(payload.error || "Failed to load map winrates.");
    }
    return payload.maps;
}

async function fetchLatestRoundId() {
    const latestEl = document.getElementById("latest-round-id");
    if (!latestEl) {
        return;
    }
    try {
        const resp = await fetch("/api/latest-round");
        const payload = await resp.json();
        if (!resp.ok) {
            throw new Error(payload.error || "Failed to load latest round ID.");
        }
        const latest = payload.latest_round_id;
        latestEl.textContent = `Latest stored round ID: ${latest === null ? "N/A" : latest}`;
    } catch {
        latestEl.textContent = "Latest stored round ID: unavailable";
    }
}

function getSecondsUntilNextHalfHour() {
    const now = new Date();
    const next = new Date(now);
    next.setMilliseconds(0);
    next.setSeconds(0);
    if (now.getMinutes() < 30) {
        next.setMinutes(30);
    } else {
        next.setHours(next.getHours() + 1);
        next.setMinutes(0);
    }
    return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

function startNextRoundCountdown() {
    const el = document.getElementById("next-round-check-countdown");
    if (!el) {
        return;
    }
    let lastAutoUpdateBucket = null;

    const triggerAutoUpdateNow = async () => {
        try {
            await fetch("/api/auto-update-now", { method: "POST" });
            await fetchLatestRoundId();
        } catch {
            // Ignore silent auto-update trigger errors in UI.
        }
    };

    const render = () => {
        const totalSeconds = getSecondsUntilNextHalfHour();
        const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
        const ss = String(totalSeconds % 60).padStart(2, "0");
        el.textContent = `Checking for new round in ${mm}:${ss}`;

        if (totalSeconds <= 1) {
            const bucket = Math.floor(Date.now() / 1800000);
            if (bucket !== lastAutoUpdateBucket) {
                lastAutoUpdateBucket = bucket;
                triggerAutoUpdateNow();
            }
        }
    };

    render();
    setInterval(render, 1000);
}

function renderMyGames(games, query) {
    const tbody = document.getElementById("my-games-body");
    const meta = document.getElementById("my-games-meta");
    tbody.innerHTML = "";
    meta.textContent = `Search: ${query} | Matches: ${games.length}`;

    for (const g of games) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${g.round_id}</td>
            <td>${g.round_date}</td>
            <td>${g.map_name}</td>
            <td>${g.round_result_key}</td>
            <td>${g.your_characters_jobs}</td>
            <td>${g.duration_text}</td>
            <td><a href="${g.download_link}" target="_blank" rel="noopener noreferrer">Download</a></td>
        `;
        tbody.appendChild(tr);
    }
}

async function fetchAndRenderMyGames() {
    const errorEl = document.getElementById("error");
    const query = document.getElementById("my-games-query").value.trim();
    const startRound = Number(document.getElementById("start-round").value);
    const endRound = Number(document.getElementById("end-round").value);

    if (!query) {
        errorEl.textContent = "Enter a character or username for My Games search.";
        return;
    }

    const params = new URLSearchParams({
        start_round: String(startRound),
        end_round: String(endRound),
        q: query
    });
    const resp = await fetch(`/api/my-games?${params.toString()}`);
    const payload = await resp.json();
    if (!resp.ok) {
        throw new Error(payload.error || "Failed to load My Games.");
    }
    renderMyGames(payload.games, payload.query);
}

function renderJobsList(jobs) {
    const listEl = document.getElementById("jobs-list");
    listEl.innerHTML = "";
    const search = document.getElementById("job-search").value;
    const filteredJobs = jobs.filter((j) => matchesSearch(j.job, search));

    if (!filteredJobs || filteredJobs.length === 0) {
        listEl.textContent = "No jobs found in this range.";
        return;
    }

    if (!selectedJob || !filteredJobs.some((j) => j.job === selectedJob)) {
        selectedJob = filteredJobs[0].job;
    }

    for (const row of filteredJobs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `job-item${row.job === selectedJob ? " active" : ""}`;
        btn.textContent = `${row.job} (${row.games})`;
        btn.addEventListener("click", async () => {
            selectedJob = row.job;
            renderJobsList(allJobs);
            const startRound = Number(document.getElementById("start-round").value);
            const endRound = Number(document.getElementById("end-round").value);
            await fetchAndRenderJobPlayers(startRound, endRound, selectedJob);
        });
        listEl.appendChild(btn);
    }
}

function renderJobPlayersTable(job, players) {
    document.getElementById("job-title").textContent = `Players for ${job}`;
    const tbody = document.getElementById("job-players-body");
    tbody.innerHTML = "";
    const usernameSearch = document.getElementById("username-search").value;
    const characterSearch = document.getElementById("character-search").value;
    const combineByUsername = document.getElementById("combine-username").checked;
    const minGamesRaw = Number(document.getElementById("min-games").value);
    const minGames = Number.isFinite(minGamesRaw) && minGamesRaw > 0 ? minGamesRaw : 0;

    let filteredPlayers = players.filter((p) => {
        const usernameOk = matchesSearch(p.username, usernameSearch);
        const characterOk = matchesSearch((p.character_name || ""), characterSearch);
        return usernameOk && characterOk;
    });

    if (combineByUsername) {
        const combined = new Map();
        for (const p of filteredPlayers) {
            const key = p.username;
            const current = combined.get(key) || {
                username: p.username,
                characterNames: new Set(),
                games: 0,
                marine_wins: 0,
                xeno_wins: 0
            };
            if (p.character_name) {
                current.characterNames.add(p.character_name);
            }
            current.games += p.games;
            current.marine_wins += p.marine_wins;
            current.xeno_wins += p.xeno_wins;
            combined.set(key, current);
        }

        filteredPlayers = Array.from(combined.values()).map((c) => {
            const decisive = c.marine_wins + c.xeno_wins;
            return {
                username: c.username,
                character_name: Array.from(c.characterNames).join(", "),
                games: c.games,
                marine_wins: c.marine_wins,
                xeno_wins: c.xeno_wins,
                marine_winrate_pct: decisive > 0 ? (c.marine_wins * 100.0 / decisive) : null
            };
        });
    }

    filteredPlayers = filteredPlayers.filter((p) => p.games >= minGames);

    filteredPlayers.sort((a, b) => {
        let left = 0;
        let right = 0;
        if (playerSort.key === "marine_winrate_pct") {
            left = a.marine_winrate_pct === null ? -1 : a.marine_winrate_pct;
            right = b.marine_winrate_pct === null ? -1 : b.marine_winrate_pct;
        } else {
            left = a.games;
            right = b.games;
        }
        if (left === right) {
            return a.username.localeCompare(b.username);
        }
        return playerSort.dir === "asc" ? left - right : right - left;
    });

    for (const p of filteredPlayers) {
        const wr = p.marine_winrate_pct === null ? "N/A" : `${p.marine_winrate_pct.toFixed(2)}%`;
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${p.username}</td>
            <td>${p.character_name || ""}</td>
            <td>${p.games}</td>
            <td>${wr}</td>
        `;
        tbody.appendChild(tr);
    }
    updateSortHeaderLabels();
}

function updateSortHeaderLabels() {
    const gamesHeader = document.getElementById("sort-games");
    const wrHeader = document.getElementById("sort-marine-wr");
    gamesHeader.textContent = "Games";
    wrHeader.textContent = "Marine WR%";

    const arrow = playerSort.dir === "asc" ? " ^" : " v";
    if (playerSort.key === "games") {
        gamesHeader.textContent += arrow;
    } else if (playerSort.key === "marine_winrate_pct") {
        wrHeader.textContent += arrow;
    }
}

async function fetchJobs(startRound, endRound, characterName, username) {
    const params = new URLSearchParams({
        start_round: String(startRound),
        end_round: String(endRound)
    });
    if (characterName && characterName.trim() !== "") {
        params.set("character_name", characterName.trim());
    }
    if (username && username.trim() !== "") {
        params.set("username", username.trim());
    }
    const resp = await fetch(`/api/jobs?${params.toString()}`);
    const payload = await resp.json();
    if (!resp.ok) {
        throw new Error(payload.error || "Failed to load jobs.");
    }
    return payload.jobs;
}

async function fetchAndRenderJobPlayers(startRound, endRound, job) {
    const params = new URLSearchParams({
        start_round: String(startRound),
        end_round: String(endRound)
    });
    const resp = await fetch(`/api/jobs/${encodeURIComponent(job)}/players?${params.toString()}`);
    const payload = await resp.json();
    if (!resp.ok) {
        throw new Error(payload.error || "Failed to load players for job.");
    }
    allPlayersForSelectedJob = payload.players;
    renderJobPlayersTable(payload.job, allPlayersForSelectedJob);
}

async function fetchAndRender(startRound, endRound, characterName, characterJob) {
    const errorEl = document.getElementById("error");
    const metaEl = document.getElementById("meta");

    errorEl.textContent = "";
    metaEl.textContent = "Loading...";

    const params = new URLSearchParams({
        start_round: String(startRound),
        end_round: String(endRound)
    });
    if (characterName && characterName.trim() !== "") {
        params.set("character_name", characterName.trim());
    }
    if (characterJob && characterJob.trim() !== "") {
        params.set("character_job", characterJob.trim());
    }

    const resp = await fetch(`/api/winrates?${params.toString()}`);
    const raw = await resp.text();
    let payload = null;

    try {
        payload = JSON.parse(raw);
    } catch {
        if (!resp.ok) {
            throw new Error(`Server returned ${resp.status}. ${raw.slice(0, 180)}`);
        }
        throw new Error("Server returned non-JSON data.");
    }

    if (!resp.ok) {
        throw new Error(payload.error || "Request failed");
    }

    renderTable(payload.results);
    renderChart(payload.results);
    renderPlayersChart(payload.player_counts);
    const nameText = payload.character_name ? ` | Character filter: ${payload.character_name}` : "";
    const jobText = payload.character_job ? ` | Job filter: ${payload.character_job}` : "";
    metaEl.textContent = `Rounds ${payload.start_round}-${payload.end_round} | Matched rounds: ${payload.total_rounds}${nameText}${jobText}`;

    const jobsTabCharacterSearch = document.getElementById("character-search").value;
    const jobsTabUsernameSearch = document.getElementById("username-search").value;
    allJobs = await fetchJobs(startRound, endRound, jobsTabCharacterSearch, jobsTabUsernameSearch);
    renderJobsList(allJobs);
    if (selectedJob) {
        await fetchAndRenderJobPlayers(startRound, endRound, selectedJob);
    } else {
        document.getElementById("job-title").textContent = "Players";
        document.getElementById("job-players-body").innerHTML = "";
    }

    const mapWinrates = await fetchMapWinrates(startRound, endRound, characterName, characterJob);
    renderMapWinrates(mapWinrates);
    await fetchLatestRoundId();
}

document.getElementById("range-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const startRound = Number(document.getElementById("start-round").value);
    const endRound = Number(document.getElementById("end-round").value);
    const characterName = document.getElementById("character-name").value;
    const characterJob = document.getElementById("character-job").value;
    const errorEl = document.getElementById("error");

    if (!Number.isInteger(startRound) || !Number.isInteger(endRound)) {
        errorEl.textContent = "Start and end round must be integers.";
        return;
    }

    try {
        await fetchAndRender(startRound, endRound, characterName, characterJob);
    } catch (err) {
        errorEl.textContent = err.message;
    }
});

document.getElementById("tab-winrates-btn").addEventListener("click", () => switchTab("winrates"));
document.getElementById("tab-map-winrates-btn").addEventListener("click", () => switchTab("map-winrates"));
document.getElementById("tab-jobs-btn").addEventListener("click", () => switchTab("jobs"));
document.getElementById("tab-my-games-btn").addEventListener("click", () => switchTab("my-games"));
document.getElementById("my-games-search-btn").addEventListener("click", async () => {
    try {
        await fetchAndRenderMyGames();
    } catch (err) {
        document.getElementById("error").textContent = err.message;
    }
});
document.getElementById("my-games-query").addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
        return;
    }
    event.preventDefault();
    try {
        await fetchAndRenderMyGames();
    } catch (err) {
        document.getElementById("error").textContent = err.message;
    }
});
[
    "map_name",
    "total_rounds",
    "marine_major",
    "marine_minor",
    "xeno_minor",
    "xeno_major",
    "draw",
    "avg_match_length_seconds",
    "marine_winrate_pct"
].forEach((key) => {
    const th = document.getElementById(`map-sort-${key}`);
    if (!th) {
        return;
    }
    th.addEventListener("click", async () => {
        if (mapSort.key === key) {
            mapSort.dir = mapSort.dir === "asc" ? "desc" : "asc";
        } else {
            mapSort = { key, dir: key === "map_name" ? "asc" : "desc" };
        }
        const startRound = Number(document.getElementById("start-round").value);
        const endRound = Number(document.getElementById("end-round").value);
        const characterName = document.getElementById("character-name").value;
        const characterJob = document.getElementById("character-job").value;
        try {
            const mapWinrates = await fetchMapWinrates(startRound, endRound, characterName, characterJob);
            renderMapWinrates(mapWinrates);
        } catch (err) {
            document.getElementById("error").textContent = err.message;
        }
    });
});
document.getElementById("sort-games").addEventListener("click", () => {
    if (playerSort.key === "games") {
        playerSort.dir = playerSort.dir === "asc" ? "desc" : "asc";
    } else {
        playerSort = { key: "games", dir: "desc" };
    }
    if (selectedJob) {
        renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
    } else {
        updateSortHeaderLabels();
    }
});
document.getElementById("sort-marine-wr").addEventListener("click", () => {
    if (playerSort.key === "marine_winrate_pct") {
        playerSort.dir = playerSort.dir === "asc" ? "desc" : "asc";
    } else {
        playerSort = { key: "marine_winrate_pct", dir: "desc" };
    }
    if (selectedJob) {
        renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
    } else {
        updateSortHeaderLabels();
    }
});
document.getElementById("job-search").addEventListener("input", async () => {
    renderJobsList(allJobs);
    const startRound = Number(document.getElementById("start-round").value);
    const endRound = Number(document.getElementById("end-round").value);
    if (selectedJob) {
        await fetchAndRenderJobPlayers(startRound, endRound, selectedJob);
    }
});
document.getElementById("username-search").addEventListener("input", () => {
    const startRound = Number(document.getElementById("start-round").value);
    const endRound = Number(document.getElementById("end-round").value);
    const jobsTabCharacterSearch = document.getElementById("character-search").value;
    const jobsTabUsernameSearch = document.getElementById("username-search").value;

    fetchJobs(startRound, endRound, jobsTabCharacterSearch, jobsTabUsernameSearch)
        .then(async (jobs) => {
            allJobs = jobs;
            renderJobsList(allJobs);
            if (selectedJob) {
                await fetchAndRenderJobPlayers(startRound, endRound, selectedJob);
                renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
            } else {
                document.getElementById("job-title").textContent = "Players";
                document.getElementById("job-players-body").innerHTML = "";
            }
        })
        .catch((err) => {
            document.getElementById("error").textContent = err.message;
        });
});
document.getElementById("character-search").addEventListener("input", () => {
    const startRound = Number(document.getElementById("start-round").value);
    const endRound = Number(document.getElementById("end-round").value);
    const jobsTabCharacterSearch = document.getElementById("character-search").value;
    const jobsTabUsernameSearch = document.getElementById("username-search").value;

    fetchJobs(startRound, endRound, jobsTabCharacterSearch, jobsTabUsernameSearch)
        .then(async (jobs) => {
            allJobs = jobs;
            renderJobsList(allJobs);
            if (selectedJob) {
                await fetchAndRenderJobPlayers(startRound, endRound, selectedJob);
            } else {
                document.getElementById("job-title").textContent = "Players";
                document.getElementById("job-players-body").innerHTML = "";
            }
            if (selectedJob) {
                renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
            }
        })
        .catch((err) => {
            document.getElementById("error").textContent = err.message;
        });
});
document.getElementById("combine-username").addEventListener("change", () => {
    if (selectedJob) {
        renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
    }
});
document.getElementById("min-games").addEventListener("input", () => {
    if (selectedJob) {
        renderJobPlayersTable(selectedJob, allPlayersForSelectedJob);
    }
});

fetchAndRender(
    Number(document.getElementById("start-round").value),
    Number(document.getElementById("end-round").value),
    document.getElementById("character-name").value,
    document.getElementById("character-job").value
).catch((err) => {
    document.getElementById("error").textContent = err.message;
});
fetchLatestRoundId().catch(() => {});
startNextRoundCountdown();
updateSortHeaderLabels();
updateMapSortHeaderLabels();
