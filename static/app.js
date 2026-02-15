let chartInstance = null;
let playersChartInstance = null;
let selectedJob = null;
let allJobs = [];
let allPlayersForSelectedJob = [];
let playerSort = { key: "games", dir: "desc" };

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

    if (playersChartInstance) {
        playersChartInstance.destroy();
    }

    playersChartInstance = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Players",
                data: values,
                borderColor: "#3fa2ff",
                backgroundColor: "rgba(63, 162, 255, 0.2)",
                fill: true,
                tension: 0.2,
                pointRadius: 2
            }]
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
                y: {
                    beginAtZero: true,
                    ticks: { color: "#9db0c0" },
                    grid: { color: "rgba(157, 176, 192, 0.2)" }
                }
            }
        }
    });
}

function switchTab(tabName) {
    const winratesBtn = document.getElementById("tab-winrates-btn");
    const jobsBtn = document.getElementById("tab-jobs-btn");
    const winratesTab = document.getElementById("tab-winrates");
    const jobsTab = document.getElementById("tab-jobs");

    if (tabName === "jobs") {
        jobsBtn.classList.add("active");
        winratesBtn.classList.remove("active");
        jobsTab.classList.add("active");
        winratesTab.classList.remove("active");
    } else {
        winratesBtn.classList.add("active");
        jobsBtn.classList.remove("active");
        winratesTab.classList.add("active");
        jobsTab.classList.remove("active");
    }
}

function renderJobsList(jobs) {
    const listEl = document.getElementById("jobs-list");
    listEl.innerHTML = "";
    const search = document.getElementById("job-search").value.trim().toLowerCase();
    const filteredJobs = jobs.filter((j) => j.job.toLowerCase().includes(search));

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
    const usernameSearch = document.getElementById("username-search").value.trim().toLowerCase();
    const characterSearch = document.getElementById("character-search").value.trim().toLowerCase();
    const combineByUsername = document.getElementById("combine-username").checked;
    const minGamesRaw = Number(document.getElementById("min-games").value);
    const minGames = Number.isFinite(minGamesRaw) && minGamesRaw > 0 ? minGamesRaw : 0;

    let filteredPlayers = players.filter((p) => {
        const usernameOk = !usernameSearch || p.username.toLowerCase().includes(usernameSearch);
        const characterOk = !characterSearch || (p.character_name || "").toLowerCase().includes(characterSearch);
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
document.getElementById("tab-jobs-btn").addEventListener("click", () => switchTab("jobs"));
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
updateSortHeaderLabels();
