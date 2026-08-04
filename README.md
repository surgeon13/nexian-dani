# Nexian Automation Helper

Menu-driven Playwright automation for Nexian: login/session reuse, farmlists, village status, template-based builders, **troop plans** (Barracks / Great Barracks / Stable / Great Stable), village expansion helpers, optional **proxy pool**, timed loops, and append-only action logging (`log.jsonl`).

**Current version: 1.8.11** — see [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## Features

| Area | Behavior |
|------|----------|
| **Login / session** | Saves browser storage to `storageState.json` so you can skip full login after the first run. |
| **Main menu** | Village status, farmlists, village-stage builder, resource-fields builder, troop trainer, expansion check, logs, settings, village picker, **proxy menu (`y`)**. |
| **Web dashboard** | Local browser UI at `http://127.0.0.1:3847` — status, actions, live console, loop settings, **proxy pool**, **Top 10** standings/Δ/`/h`, activity simulation. **Compact view** for small screens (e.g. Raspberry Pi 3.5″ TFT). |
| **Compact UI** | One setting (`DASHBOARD_COMPACT_VIEW` or terminal **S → D**) toggles compact **web layout** and shorter **terminal menus**. |
| **Village templates** | JSON templates under `templates/`; progress in `templates/progress.json`. |
| **Loops** | Optional timers for farmlists, builders, troop training, Top 10 statistics, session play/rest windows, raid-guard heartbeat. |
| **24/7 keep-alive** | External watchdog (`npm run start:24-7`) restarts a dead or stalled bot; heartbeats in `keep-alive.log`. |
| **Ctrl+C** | Soft-cancel running action and return to the menu (does not tear down the browser session alone). |

### Automation modules

- **Resource circulation** — Optional marketplace-style transfers when the builder is blocked on resources or for settlement prep. Toggle in **Settings** (`U`, `V`) or `.env` (`RESOURCE_CIRCULATION_*`). When disabled or insufficient, ship resources manually in-game.
- **Troop plans** — Named plans with unit + qty per building (Barracks, Great Barracks, Stable, Great Stable). Assign villages in terminal **T**; auto-train loop runs per village on its plan timer. Stored in `templates/troop_plans.json`.
- **Proxy pool** — Route Playwright through HTTP/SOCKS proxies. Paste a list in terminal **y** / Settings **Y** or dashboard **Settings → Proxy pool**. Optional rotation on session-loop re-login (`PROXY_ROTATE_ON_SESSION_REST`).
- **Raid evacuation** — When enabled (`RAID_EVACUATION_*`, Settings → Raid), send surplus resources toward a **pivot** village when an incoming attack is within the configured ETA window.
- **Top 10 tracking** — Scheduled or manual Robbers-focused snapshots (plus other rankings) in `top10.log`. Dashboard **Top 10** tab highlights **your raid income /h** (active vs wall-clock), with farmlist/Top10 settings context. Settings **[O]** or **Snapshot now**.
- **24/7 keep-alive** — `scripts/keep-alive.sh` polls every minute and restarts the bot if the process dies, the dashboard stops answering, or action logs go stale while loops should be running. Prefer `npm run start:24-7` on a long-lived host.

### What's new in 1.8.x (summary)

- **1.8.11:** Your pace cards for attack / defense / climbers / alliance / etc. (active vs wall `/h`).
- **1.8.10:** Raid income hero — your Robbers loot normalized to active vs wall-clock `/h`, with settings context.
- **1.8.9:** Top 10 dashboard + Δ/`/h` from all polls; 24/7 keep-alive; session wake recovery; proxy rotate-on-rest visibility; farmlist village pin; Palace expansion on realm host.
- **Top 10 statistics tracking** — seven ranking categories logged to `top10.log` (JSONL lines with `ts` + `epochMs`).
- **Farmlist auto-send pre-empts** builder, troop, cranny, and activity auto loops when due.
- **Troop plans** replace the old per-village troop-template toggles (four building branches, per-plan timers).
- **Proxy pool** with dashboard + terminal management; rotate proxy after session-loop rest.
- **Reliability:** farmlist send uses `#btn_send_all` (not troop `#btn_train`), troop auto queue (10s max idle wait), Stable map discovery, `GAME_HOST`, `FARMLIST_VILLAGE_ID`.

See [CHANGELOG.md](CHANGELOG.md) (**1.6.0**–**1.8.9**) for full release notes.

## Requirements

- **Node.js 18+**
- **Windows**, **macOS**, or **Linux** (launch scripts differ; see Troubleshooting.)

---

## Project structure

| File / folder | Role |
|---------------|------|
| `login.js` | Entry: env, browser lifecycle, proxy, persists selected settings keys to `.env`. |
| `terminalMenu.js` | Menus, village list, timers, raid guard hook, audit logging helpers, compact terminal UI. |
| `troopPlans.js` | Troop plan + village assignment store (`templates/troop_plans.json`). |
| `proxyPool.js` / `proxyConfig.js` | Proxy list parsing, pool file, dashboard/settings sync. |
| `browserNavigation.js` | Shared transient navigation error detection and retry delays. |
| `top10Tracking.js` | Server Top 10 / statistics scraping and timestamped `top10.log` output. |
| `top10Dashboard.js` | Builds `/api/top10` payload: standings, history, Δ, and `/h` rates from the poll log. |
| `dashboardServer.js` / `dashboardBridge.js` | Local web dashboard (SSE, REST API). |
| `public/` | Dashboard HTML, CSS, and client JS (includes Top 10 tab). |
| `scripts/keep-alive.sh` | 24/7 watchdog: restart dead/stale bot (with post-restart grace); heartbeats → `keep-alive.log`. |
| `scripts/start-24-7.sh` | Starts bot + network sampler + keep-alive in tmux sessions. |
| `villageBuilder.js` | Template loading, DOM guards, upgrade / Master Builder steps. |
| `villageExpansion.js` | Expansion / settlers / settlement resource checks (no auto-transfers); Palace on realm host. |
| `templates/` | Build templates; `templates/index.json` lists available plans. |
| `templates/progress.json` | Per-village builder progress (gitignored; safe to delete to reset). |
| `templates/troop_plans.json` | Troop plans and village assignments (gitignored; created at runtime). |
| `templates/proxy_list.json` | Saved proxy pool (gitignored). |
| `templates/settlement_targets.json` | Planned expansion coordinates (JSON array of `{ "x", "y" }`; start with `[]` and add your own). |
| `.env.example` | Commented baseline for copying to `.env`. |
| `setup.js`, `*.cmd` | Install deps/browser and quick Windows launchers. |
| `export.js` | Zips project for copying to another machine (excludes `.env`, `node_modules`). |

---

## First setup

1. **Dependencies and Playwright Chromium**

```bash
node setup.js
```

(On Windows you can double-click `setup.cmd`.)

2. **Credentials** — Copy `.env.example` to `.env` (or let `setup` create `.env`), then set:

```env
NEXIAN_USERNAME=your_username_here
NEXIAN_PASSWORD=your_password_here
GAME_HOST=https://s1.nexian.world
```

`GAME_HOST` must point at your **realm** (e.g. `s1.nexian.world`), not the `nexian.world` portal — otherwise farmlists, builder, and trainers navigate to the wrong host.

3. **First browser run** (recommended headed):

```bash
node login.js --headed --keep-open
```

(or `npm run login:headed`, or `start-headed.cmd` on Windows.)

If `.env` is missing, `login.js` creates it from `.env.example` when present, or writes a minimal `.env` with placeholder credentials only.

---

## NPM scripts

| Script | Meaning |
|--------|---------|
| `npm run login` | Default headless/normal launch |
| `npm run login:headed` | Visible browser + keep-open defaults |
| `npm run login:nexian` | Uses `.env.nexian` (path via `NEXIAN_ENV_FILE` or package script convention) |
| `npm run login:nexian:headed` / `:headless` | Variants for `.env.nexian` profiles |
| `npm run dashboard` | Headless login + dashboard at `http://127.0.0.1:3847` |
| `npm run dashboard:nexian:headless` | Same with `.env.nexian` (Playwright headless + web UI) |
| `npm run dashboard:nexian:headed` | Visible browser + dashboard |
| `npm run dashboard:headed` | Dashboard with headed browser (default `.env`) |
| `npm run start:24-7` | Start bot dashboard + network sampler + keep-alive watchdog (tmux) |
| `npm run keep-alive` | Run the keep-alive watchdog only (expects bot already running) |
| `npm run playwright:install` | Install Playwright Chromium only |
| `npm run clean:runtime` | Removes `storageState.json`, `log.jsonl`, `top10.log`, `templates/progress.json` |

---

## Main menu (summary)

Opens after login. Typical keys include:

- **`0`** — Village status (selected village)
- **`1`** — Send farmlists (all villages)
- **`2`** — One **village stage** builder step
- **`3`** — One **resource fields** builder step
- **`4`** — Troop trainer (selected village; uses assigned **troop plan**)
- **`C`** — Cranny defense (selected village)
- **`T`** — **Troop plans** — create/edit plans, assign villages, per-plan intervals
- **`y`** — Proxy menu (paste pool, apply, rotate, disable)
- **`5`** — Expansion / residence check
- **`V`** — Pick active village context
- **`S`** — Settings submenu (loops, gold complete, **D = compact UI**, raid toggle, expansion options, …)
- **`L`** — Log summary (`log.jsonl`)
- **`O`** — Top 10 snapshot now (writes `top10.log`; also available on the dashboard Top 10 tab)
- **`P`** — Pause or resume automation loops (farmlist, builder, troop, cranny, raid guard). Optional auto-resume: `MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES` (Settings **3**).
- **`Q`** — Quit menu / session teardown per `login.js` flow

Exact labels are printed each run—use those as source of truth if keys change. With **compact UI** enabled, the main menu collapses to two short rows (same keys).

---

## Top 10 tracking and dashboard

**Main goal:** measure **your** scores from Top 10 polls and normalize them to **per-hour pace**, especially raid loot, so you can judge farmlist / combat settings.

Enable `TOP10_TRACKING_ENABLED=true` and set the interval (`TOP10_TRACKING_LOOP_MIN/MAX_MINUTES`). Snapshots scrape Nexian `statistics.php` and append one JSONL line per category to `top10.log`.

**Dashboard → Top 10 tab**

| Panel | Meaning |
|-------|---------|
| **Raid income** (hero) | Your Robbers total, **active /h** (stalls excluded), wall-clock /h, last interval /h |
| **Your other pace** | Attack points, defense points, climbers, alliance points, … — each with active /h, wall /h, Δ |
| Settings strip | Top 10 + farmlist intervals |
| Leaderboard / trend | Boards default to Robbers; poll intervals tag long gaps as downtime |

**How /h is calculated** (same for every category with your score)

- **Wall /h** = `(value_now − value_first) / wall_hours` across all polls  
- **Active /h** = same math but **only intervals shorter than ~3× your Top 10 poll interval** (min 1.5h)  
- **Last /h** = newest poll interval only  

API: `GET /api/top10` → `raidIncome` (Robbers) + `selfPace[]` (all categories with your row).

Manual snapshot: menu **`O`**, dashboard **Snapshot now**, or `POST /api/action` with `{ "action": "top10" }`.

---

## 24/7 keep-alive (crash recovery)

The Cursor/cloud agent is **not** a 24/7 process supervisor. Use the keep-alive watchdog on a long-lived host (VPS, Pi, always-on PC).

```bash
npm run start:24-7
```

This starts three tmux sessions by default:

| Session | Role |
|---------|------|
| `nexian-dani` | Bot + dashboard (`npm run dashboard`) |
| `nexian-keep` | `scripts/keep-alive.sh` watchdog |
| `net-usage` | Optional network sampler |

**Keep-alive checks every 60s** (`CHECK_SECONDS`):

1. Is `login.js` running? → else restart  
2. Does `http://127.0.0.1:3847/api/status` answer? → else restart  
3. Is `log.jsonl` older than **20 minutes** (`STALE_MINUTES`) while loops are expected? → restart (skipped if automation is paused / session rest)

Heartbeats and restart reasons are appended to **`keep-alive.log`**.

If keep-alive itself dies, nothing restarts the bot until you run `npm run start:24-7` (or `npm run keep-alive`) again. Pair with systemd/cron on production hosts if you need the watchdog supervised too.

### Is the bot down?

| Check | Healthy signal |
|-------|----------------|
| `curl -sS http://127.0.0.1:3847/api/status` | HTTP 200; fresh `status.updatedAt` |
| `pgrep -af 'login.js\|keep-alive'` | Both bot and keep-alive processes |
| `tail -20 keep-alive.log` | `heartbeat bot=up dash=up` about every minute |
| `log.jsonl` / `top10.log` mtime | Updating within your loop intervals |
| `status.top10Tracking.lastAction.at` | Within ~`TOP10_TRACKING_*` minutes when enabled |

Stale `log_age` ≥ 20m in keep-alive while online → watchdog should restart. Missing heartbeats for many minutes → keep-alive itself is stuck/down.

---

## Raspberry Pi (3.5″ display)

Typical Waveshare / GPIO TFT panels are **480×320** landscape. The dashboard **compact view** is tuned for this size.

### Recommended `.env` on the Pi

```env
DASHBOARD_ENABLED=true
DASHBOARD_COMPACT_VIEW=true
DASHBOARD_OPEN_BROWSER=true
BUILDER_DEFAULT_PLAN_MODE=resource
```

### Run

```bash
git pull
npm install
npm run dashboard:nexian:headless
```

Open **`http://127.0.0.1:3847`** on the Pi (or tunnel from another machine). Enable compact view via **Settings → Display** if it is not already on.

### What compact view does

| Surface | Behavior |
|---------|----------|
| **Web dashboard** | Single-column layout: status → action grid → live console → recent log. Smaller fonts, collapsed village list, short action labels. |
| **Terminal (SSH/CMD)** | Shorter menus and one-line loop status (**S → D** toggles both). |

### Optional: fullscreen browser (kiosk)

After the bot is running:

```bash
chromium-browser --kiosk --app=http://127.0.0.1:3847
```

Use **Ctrl+F5** once after updates to refresh cached CSS/JS.

### Low memory / long-running dashboard

Dashboard OOM crashes were a **software bug** (fixed in v1.5.5+), not limited to Raspberry Pi — they could happen on a strong PC after the bot ran for hours. Causes included loading entire `log.jsonl` files into RAM, sending full troop payloads over SSE every few seconds, and rebuilding status snapshots on every loop tick.

After `git pull`, restart the dashboard. Log rotation (v1.5.7+) keeps `log.jsonl` small automatically; older logs live in `log-archive/`. You can still run `npm run clean:runtime` to wipe the active session files. Prefer one dashboard browser tab.

---

## Builder and resources

The builder evaluates costs against current warehouse/granary stock. If Nexian hides the normal upgrade button and only offers Master Builder (`regular: none | MB`), automation can **queue MB** builds when Master Builder usage is enabled in settings.

When stock is insufficient and there is **no usable regular upgrade**:

- Automation logs **blocked_resources** / insufficient resources.
- If **resource circulation** is enabled and another village can supply, the builder loop may trigger transfers and wait for travel; otherwise ship resources manually, then rerun the builder step.

Expansion **need_settlement_resources** behaves similarly: circulation may help when enabled; otherwise ship manually.

---

## Configuration (`/.env`)

`.env.example` lists every knob with safe defaults.

**High-signal variables**

- **Loops:** `FARMLIST_LOOP_*`, `BUILDER_LOOP_*`, `SESSION_LOOP_*`, `TROOP_TRAINING_ROUND_ROBIN_ENABLED`, `TOP10_TRACKING_*`
- **Realm / farmlist:** `GAME_HOST`, `FARMLIST_VILLAGE_ID` (pin rally-point village for auto-send)
- **Proxy:** `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`, `PROXY_ROTATE_ON_SESSION_REST`
- **24/7 keep-alive:** shell env `CHECK_SECONDS`, `STALE_MINUTES`, `DASH_URL` (see `.env.example` comments; not stored as bot `.env` keys)
- **Builder:** `BUILDER_GOLD_COMPLETE_*`, `BUILDER_MASTER_BUILDER_ENABLED`, `BUILDER_ROUND_ROBIN_ENABLED`, `BUILDER_DEFAULT_PLAN_MODE` (`resource` or `village`)
- **Dashboard:** `DASHBOARD_ENABLED`, `DASHBOARD_PORT`, `DASHBOARD_COMPACT_VIEW`
- **Resource circulation:** `RESOURCE_CIRCULATION_ENABLED`, `RESOURCE_CIRCULATION_EXPANSION_ENABLED`, and related `RESOURCE_CIRCULATION_*` caps (see `.env.example`)
- **Raid evacuation:** `RAID_EVACUATION_ENABLED`, `RAID_EVACUATION_TRIGGER_MINUTES`, `RAID_EVACUATION_RESERVE_PER_RESOURCE`, `RAID_EVACUATION_PIVOT_VILLAGE_IDS`, … (see `.env.example`)

Settings changed from the **`S`** menu persist back into `.env` for the keys wired in `login.js` (`persistRuntimeSettings`).

Optional overrides: `VILLAGE_BUILDER_URL`, `FARMLIST_URL`, `NEXIAN_ACTION_LOG_FILE`, selectors for farmlists, etc.

---

## Logging

- **Action log:** `log.jsonl` (or `NEXIAN_ACTION_LOG_FILE`) — bot actions (farmlists, troops, builder, …)
- **Top 10 log:** `top10.log` (or `TOP10_TRACKING_LOG_FILE`) — one JSON object per line per ranking category per snapshot (`ts`, `epochMs`, `top10`, `self`). The dashboard aggregates these lines for Δ and `/h`.
- **Keep-alive log:** `keep-alive.log` — watchdog heartbeats and restart reasons (gitignored)
- **Rotation:** When `log.jsonl` exceeds `NEXIAN_ACTION_LOG_MAX_BYTES` (default 10MB), it is renamed into `log-archive/` and logging continues in a new empty file.
- **Format:** append-only JSONL (action + Top 10); keep-alive is plain text timestamps
- **Summary menu** counts farmlists, troops, upgrades, gold autocomplete, merchant-transfer history (mostly historical), evacuation history (mostly historical).

---

## Export to another computer

```bash
npm run export
```

Produces a zip beside the project folder named like `nexian-v1.8.9-2026-08-03-14-30-00.zip` (package version + local date-time). Exclude private/runtime files manually if you assemble a zip yourself: `.env`, `.env.*` with secrets, `storageState.json`, `log.jsonl`, `top10.log`, `keep-alive.log`, `node_modules/`, optionally `templates/progress.json`.

On the new machine: extract → `node setup.js` → fill `.env` → `node login.js --headed --keep-open`.

Recommended zip contents align with whatever `export.js` includes (`villageExpansion.js`, `templates/`, `.env.example`, `README.md`, etc.)—see `export.js` `exclude` list.

---

## Roadmap (ideas)

- Tune defaults for loops and raid triggers per meta.
- Optional tests around parsing and template validation.

---

## Troubleshooting

- **PowerShell blocks `npm`:** use `npm.cmd`, or adjust execution policy (`RemoteSigned` for CurrentUser), or run `node login.js` directly.
- **Headless Chromium errors:** launch headed once (`--headed`), or run `npm run playwright:install`.
- **`Ctrl+C` during an action:** action is interrupted; browser may stay open per `KEEP_OPEN`/menu flow.
- **Builder stuck on resources:** enable **Settings [R]** or set `RESOURCE_CIRCULATION_ENABLED=true` so other villages (not under attack) can send toward the builder target, up to the configured share of warehouse/granary capacity; the builder loop waits for the estimated travel time before retrying.
- **Farmlist send fails / wrong village:** set `GAME_HOST` to your realm and `FARMLIST_VILLAGE_ID` to a village that has a Rally Point with farm lists.
- **Troop auto “no Stable” on a village that has one:** upgrade to **v1.8.5+** and restart; Stable is resolved from the village map. If a branch truly does not exist yet, v1.8.4+ skips it until built.
- **Bot crashed / dashboard dead:** run `npm run start:24-7` (or ensure `npm run keep-alive` is running). Check `keep-alive.log` for `restarting bot (...)`.
- **Top 10 empty / no Δ:** need at least two successful snapshots in `top10.log`; confirm `TOP10_TRACKING_ENABLED` and that `/api/top10` returns `ok: true` categories.

---

## License / game rules

Automate only accounts you control and obey Nexian’s terms of service. This tool clicks the same UI actions you could perform manually—it does not bypass authentication.
