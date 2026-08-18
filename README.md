# Nexian Automation Helper

Menu-driven Playwright automation for Nexian: login/session reuse, farmlists, village status, template-based builders, **troop plans** (Barracks / Great Barracks / Stable / Great Stable), village expansion helpers, optional **proxy pool**, timed loops, and append-only action logging (`log.jsonl`).

**Current version: 1.8.34** — see [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## Features

| Area | Behavior |
|------|----------|
| **Login / session** | Saves browser storage to `storageState.json` so you can skip full login after the first run. |
| **Main menu** | Village status, farmlists, village-stage builder, resource-fields builder, troop trainer, expansion check, logs, settings, village picker, **proxy menu (`y`)**. |
| **Web dashboard** | Local browser UI at `http://127.0.0.1:3847` — status, actions, live console, loop settings, **proxy pool**, **session presence** (online windows + egress IP), **Top 10** standings/Δ/`/h`, activity simulation. **Compact view** for small screens (e.g. Raspberry Pi 3.5″ TFT). |
| **Compact UI** | One setting (`DASHBOARD_COMPACT_VIEW` or terminal **S → D**) toggles compact **web layout** and shorter **terminal menus**. |
| **Village templates** | JSON templates under `templates/`; progress in `templates/progress.json`. |
| **Loops** | Optional timers for farmlists, builders, troop training, Top 10 statistics, session play/rest windows, raid-guard heartbeat, NPC crop convert, celebrations RR. |
| **24/7 keep-alive** | PC: `npm run start:24-7:pc` / `start-24-7.cmd`; Cursor/tmux: `npm run start:24-7`. Heartbeats in `keep-alive.log`. |
| **Ctrl+C** | Soft-cancel running action and return to the menu (does not tear down the browser session alone). |

### Automation modules

- **Resource circulation** — Optional marketplace-style transfers when the builder is blocked on resources or for settlement prep. Toggle in **Settings** (`R`, `V`) or `.env` (`RESOURCE_CIRCULATION_*`). When disabled or insufficient, ship resources manually in-game.
- **Overflow guard** — Complements circulation: near-full warehouse/granary surplus goes to the capital/pivot **only within** max map distance (default 10 squares). Far overflows never send. Settings **OG** / `RESOURCE_OVERFLOW_*`.
- **Troop plans** — Named plans with unit + qty per building (Barracks, Great Barracks, Stable, Great Stable). Assign villages in terminal **T**; auto-train loop runs per village on its plan timer. Stored in `templates/troop_plans.json`.
- **Proxy pool** — Route Playwright through HTTP/SOCKS proxies. Paste a list in terminal **y** / Settings **Y** or dashboard **Settings → Proxy pool**. Rotate live via **Next** / `POST /api/proxy-settings` `{"action":"next"}`. Optional rotation on session-loop re-login (`PROXY_ROTATE_ON_SESSION_REST`).
- **Raid evacuation** — When enabled (`RAID_EVACUATION_*`, Settings → Raid), send surplus resources toward a **pivot** village when an incoming attack is within the configured ETA window.
- **NPC crop convert** — When granary fills to the threshold (default 95%), NPC-trade so crop becomes **0%** and wood/clay/iron share the rest. Round-robin one village per poll (`NPC_CROP_CONVERT_*`, Settings **N**). Costs gold in-game; off by default. **Capital granary watcher** (`CAPITAL_GRANARY_WATCHER_*`, on by default) checks the capital every tick instead of waiting for its round-robin turn.
- **Top 10 tracking** — Scheduled or manual Robbers-focused snapshots (plus other rankings) in `top10.log`. Dashboard **Top 10** tab highlights **your raid income /h** (active vs wall-clock), with farmlist/Top10 settings context. Settings **[O]** or **Snapshot now**.
- **24/7 keep-alive** — `scripts/keep-alive.sh` polls every **15s** and restarts the bot if the process dies, the dashboard stops answering, or action logs go stale while loops should be running. On Cursor Cloud, `.cursor/environment.json` auto-starts the stack; elsewhere use `npm run start:24-7`.

### What's new in 1.8.x (summary)

- **1.8.29:** Expansion finds Residence/Palace via village map (not hardcoded slot 25).
- **1.8.28:** Farmlist send uses Nexian `farmlist_selectfull_*`; idle when nothing ready (no more false failures).
- **1.8.27:** Village Status includes Account Overview troop table (`overview.php?t=4`) + account totals.
- **1.8.26:** Fix Overflow/Celebrations/NPC 15s timer collapse; harden market confirm + exclusive lock.
- **1.8.25:** Overflow guard (distance-limited send to capital) + capital detection via `__vgConfig.capitalId`.
- **1.8.22:** Resource circulation prefers nearest donors (capital → adjacent off-village).
- **1.8.21:** Planned settlement targets can set `villageName`; bot renames the new village once founded.
- **1.8.20:** Portal login opens the `GAME_HOST` realm (Prime/`s1`) instead of the first Speed/`s2` Login button.
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
- **Android**, experimental, via Termux + `proot-distro` only — see [Android (Termux)](#android-termux--experimental).

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
| `sessionPresence.js` | Online-window history: start/end times, egress IP, proxy (`session-presence.json`). |
| `top10Dashboard.js` | Builds `/api/top10` payload: standings, history, Δ, and `/h` rates from the poll log. |
| `dashboardServer.js` / `dashboardBridge.js` | Local web dashboard (SSE, REST API). |
| `public/` | Dashboard HTML, CSS, and client JS (includes Top 10 tab). |
| `scripts/keep-alive.sh` | 24/7 watchdog (bash/tmux): restart dead/stale bot; heartbeats → `keep-alive.log`. |
| `scripts/keep-alive.js` | Cross-platform Node keep-alive for PCs (no tmux). |
| `scripts/start-24-7.sh` | tmux: bot + network sampler + keep-alive. |
| `scripts/start-24-7.js` / `start-24-7.cmd` | PC starter (Node / Windows). |
| `setup-pc.cmd` | Windows: npm install + Playwright Chromium. |
| `.cursor/environment.json` | Cursor Cloud: install deps + auto-start 24/7 stack on agent boot. |
| `scripts/cursor-cloud-*.sh` | Cloud install / start / ensure helpers (`npm run cursor:*`). |
| `scripts/termux-proot-*.sh` | Android (Termux) experimental setup / run helpers via `proot-distro` (`npm run termux:*`). |
| `AGENTS.md` | Cloud Agent keep-alive + PC host + Automation instructions. |
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
| `npm run start:24-7` | Linux/macOS/Cursor: start bot + keep-alive in tmux |
| `npm run start:24-7:pc` | **PC (Windows/macOS/Linux):** Node keep-alive, no tmux — preferred for always-on hosts |
| `npm run keep-alive` | Run the keep-alive watchdog only (expects bot already running) |
| `npm run keep-alive:pc` | Node keep-alive only (cross-platform) |
| `npm run setup:pc` / `setup-pc.cmd` | Install deps + Playwright Chromium on a PC |
| `npm run cursor:ensure` | Cursor Cloud health check / restart (`cursor-cloud-ensure.sh`) |
| `npm run cursor:start` | Materialize secrets + start 24/7 stack |
| `npm run termux:setup` | **Android (Termux), experimental:** one-time `proot-distro` Ubuntu + Node + Playwright setup |
| `npm run termux:run` | **Android (Termux), experimental:** launch inside the `proot-distro` chroot |
| `npm run playwright:install` | Install Playwright Chromium only |
| `npm run clean:runtime` | Removes `storageState.json`, `log.jsonl`, `top10.log`, `session-presence.json`, `templates/progress.json` |

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

### Session presence (online windows + IP)

Each time the bot is online (after login / wake / relogin), a period is recorded with start time, end time, egress IP, and proxy label. History lives in `session-presence.json`.

- Dashboard: **Session presence** panel on the main tab (login / logout / rest timeline)
- API: `GET /api/session-presence?limit=100` → `timelineLines` like `10:00 login with 1.2.3.4`, `10:49 logout`, `10:49 rest time (10m)`
- Optional env: `SESSION_PRESENCE_LOG_FILE`, `SESSION_PRESENCE_MAX_PERIODS` (default 500)

Egress IP is measured through the Playwright browser context when possible (so a proxy’s exit IP is recorded), with a direct ipify fallback.

Manual snapshot: menu **`O`**, dashboard **Snapshot now**, or `POST /api/action` with `{ "action": "top10" }`.

### Proxy pool (rotate + check egress IP)

Manage the pool from dashboard **Settings → Proxy**, terminal **`y`**, or the HTTP API while the dashboard is running.

| Action | How |
|--------|-----|
| **Next proxy + relogin** | Dashboard **Next**, menu **`y` → [N]**, or `POST /api/proxy-settings` with `{"action":"next"}` |
| **Apply current + relogin** | Dashboard **Apply**, menu **`y` → [A]**, or `{"action":"apply"}` |
| **Disable (direct) + relogin** | Dashboard **Disable**, menu **`y` → [D]**, or `{"action":"disable"}` |
| **Save list only** | `{"action":"save","proxyText":"…"}` (no relogin) |

```bash
# Rotate to the next pool entry and relogin (blocks until apply finishes)
curl -sS -X POST http://127.0.0.1:3847/api/proxy-settings \
  -H 'Content-Type: application/json' \
  -d '{"action":"next"}'

# Current proxy + egress IP (wait until automation.reason is online)
curl -sS http://127.0.0.1:3847/api/status | python3 -c '
import json,sys
s=json.load(sys.stdin)["status"]
print("online:", s["automation"])
print("proxy:", (s.get("proxy") or {}).get("activeDisplay"))
print("IP:", (s.get("account") or {}).get("publicAddress"))
'
```

`GET /api/status` → `proxy.activeDisplay` / `proxy.active.server` and `account.publicAddress`. Session presence records the change as `relogin_proxy_next` (or apply/disable) with the new IP.

With `PROXY_ROTATE_ON_SESSION_REST=true` (default when a pool exists), the session loop advances to the **next** proxy on each rest→wake cycle (once per rest — wake retries keep the same entry so the full pool is visited in order). With `N` proxies, one full cycle ≈ `N × (avg play + avg rest)`.

```bash
# Live session loop + rotate-on-rest (no restart)
curl -sS -X POST http://127.0.0.1:3847/api/session-loop \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"playMinMinutes":40,"playMaxMinutes":55,"restMinMinutes":10,"restMaxMinutes":20,"proxyRotateOnSessionRest":true}'

curl -sS http://127.0.0.1:3847/api/session-loop
```

---

## Run 24/7 on your PC (recommended)

Cursor Cloud agents are **ephemeral** — when the agent run ends, the VM dies and the bot stops. For consistent uptime, run the stack on your **always-on PC** (or a VPS / Pi).

### Windows (quick start)

1. Install [Node.js LTS](https://nodejs.org/).
2. Clone or unzip this repo, then either:
   - Double-click **`setup-pc.cmd`**, or run `npm run setup:pc`
3. Copy `.env.example` → `.env` (if setup did not) and set `NEXIAN_USERNAME`, `NEXIAN_PASSWORD`, `GAME_HOST`, loops, etc.  
   Or copy your working `.env` / `templates/proxy_list.json` / `templates/troop_plans.json` from the cloud VM.
4. Start:
   - Double-click **`start-24-7.cmd`**, or `npm run start:24-7:pc`
5. Open **http://127.0.0.1:3847**

Leave that window open. Optional — start at Windows logon:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\scripts\register-pc-task.ps1
```

### macOS / Linux PC

```bash
git pull
npm run setup:pc
# edit .env
npm run start:24-7:pc
```

`start:24-7:pc` uses a **Node keep-alive** (`scripts/keep-alive.js`) — no tmux required. It starts `login.js --dashboard --keep-open` and restarts it if the process dies, the dashboard is down, or `log.jsonl` is stale (≥20m) while loops are enabled.

Linux servers that already have tmux can keep using `npm run start:24-7` (bash + tmux).

### After the PC is the host

Use Cursor agents for code/docs and one-off API actions when you want; the PC process is the source of truth for farmlist/builder/proxy.

---

## 24/7 keep-alive (crash recovery)

```bash
npm run start:24-7:pc   # PC / Windows / no-tmux (recommended)
# or
npm run start:24-7      # Linux/macOS/Cursor with tmux
```

**PC path** runs `scripts/keep-alive.js` (Node). **tmux path** (`scripts/start-24-7.sh`) starts three sessions by default:

| Session | Role |
|---------|------|
| `nexian-dani` | Bot + dashboard (`npm run dashboard`) |
| `nexian-keep` | `scripts/keep-alive.sh` watchdog |
| `net-usage` | Optional network sampler |

**Keep-alive checks every 15s** (`CHECK_SECONDS`):

1. Is `login.js` running? → else restart  
2. Does `http://127.0.0.1:3847/api/status` answer? → else restart  
3. Is `log.jsonl` older than **20 minutes** (`STALE_MINUTES`) while loops are expected? → restart (skipped if automation is paused / session rest)

Heartbeats and restart reasons are appended to **`keep-alive.log`**.

### Cursor Cloud (run inside Cursor)

Cloud Agent VMs die when the agent run ends. To stay online **inside Cursor**:

1. **Environment** — `.cursor/environment.json` installs deps on Build and runs `scripts/cursor-cloud-start.sh` on every agent boot (materializes `.env` + `start:24-7`).
2. **Secrets** — In [Cloud Agents → Secrets](https://cursor.com/dashboard/cloud-agents), add **`NEXIAN_DOTENV`** = full contents of your local `.env` (preferred). Optional: `NEXIAN_TROOP_PLANS_JSON`, `NEXIAN_PROXY_LIST_JSON`.
3. **Keep a run open** — Leave a Cloud Agent / Automation session running while you want the bot up (see `AGENTS.md`).
4. **Hourly Automation** — At [cursor.com/automations](https://cursor.com/automations), schedule something like: *Ensure `bash ./scripts/cursor-cloud-ensure.sh` is healthy; stay alive and monitor `keep-alive.log`; do not end the session.* Point it at this repo so a fresh VM restarts the stack if the previous run died.

```bash
npm run cursor:ensure   # health check / restart
npm run cursor:start    # materialize secrets + start:24-7
```

On a VPS / Pi / always-on PC, prefer **`npm run start:24-7:pc`** (or `start-24-7.cmd` on Windows). Pair with Task Scheduler / systemd / launchd so it survives reboot.

### Is the bot down?

| Check | Healthy signal |
|-------|----------------|
| `curl -sS http://127.0.0.1:3847/api/status` | HTTP 200; fresh `status.updatedAt` |
| `pgrep -af 'login.js\|keep-alive'` | Both bot and keep-alive processes |
| `tail -20 keep-alive.log` | `heartbeat bot=up dash=up` about every 15s |
| `bash ./scripts/cursor-cloud-ensure.sh` | Prints `ok — keep-alive + dashboard healthy` |
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

## Android (Termux) — experimental

**Termux by itself cannot run this.** Playwright's browser downloader explicitly refuses Android (`Unsupported platform: android` from `playwright-core`), and even bypassing that, Termux's Bionic libc cannot execute Playwright's glibc-built Chromium binary. This is not a bug in this repo — it's Playwright and Termux never having been designed to work together for a real browser instance.

The only working path is a real glibc Linux userland on-device via [`proot-distro`](https://github.com/termux/proot-distro) (installs an Ubuntu rootfs inside Termux, no root required). Node/Playwright/Chromium run *inside that chroot*, not in Termux directly.

```bash
pkg install git -y   # if you haven't already cloned this repo under Termux
bash scripts/termux-proot-setup.sh   # one-time: installs proot-distro + Ubuntu,
                                      # Node.js, clones/updates the repo inside
                                      # the chroot, npm install, Playwright + deps
```

Setup also creates `.env.termux` from **`.env.termux.example`** — same as `.env.example` but with several loop intervals relaxed (mostly 2-4x longer: builder loop, celebrations, NPC crop convert, overflow guard, Top 10 tracking, session rest) to cut how often Chromium wakes up and does real work through `proot`'s overhead. Fill in real credentials there (the setup script prints a copy-paste command that merges them in from your Termux-side `.env` without clobbering the relaxed intervals — the chroot copy of the repo is a separate filesystem), then run it:

```bash
bash scripts/termux-proot-run.sh             # node login.js — uses .env.termux automatically when present
bash scripts/termux-proot-run.sh --dashboard # node login.js --dashboard --keep-open
```

(`npm run termux:setup` / `npm run termux:run` are the same two scripts.)

**Read this before relying on it:**
- Chromium runs through `proot`'s syscall-translation layer — slower and occasionally flakier than a native Linux host.
- Android will still try to kill backgrounded apps to reclaim memory. `termux-wake-lock` (used automatically by `termux-proot-run.sh`) plus setting Termux's battery mode to **Unrestricted** (Settings → Apps → Termux → Battery) reduces but does not eliminate this.
- `--headed` has nowhere to render unless you separately set up [termux-x11](https://github.com/termux/termux-x11).
- This whole combination is unofficial — neither Playwright nor `proot-distro` claims to support it. Treat it as experimental, not a replacement for the PC/VPS path above, which remains the recommended way to run this 24/7.

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
- **Overflow guard:** `RESOURCE_OVERFLOW_GUARD_ENABLED`, `RESOURCE_OVERFLOW_TRIGGER_RATIO`, `RESOURCE_OVERFLOW_TARGET_RATIO`, `RESOURCE_OVERFLOW_MAX_DISTANCE`, `RESOURCE_OVERFLOW_LOOP_MIN_MINUTES`, `RESOURCE_OVERFLOW_LOOP_MAX_MINUTES`, `RESOURCE_OVERFLOW_PIVOT_VILLAGE_IDS`
- **NPC crop convert:** `NPC_CROP_CONVERT_ENABLED`, `NPC_CROP_CONVERT_MIN_MINUTES`, `NPC_CROP_CONVERT_MAX_MINUTES`, `NPC_CROP_CONVERT_GRANARY_RATIO`, `NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID`, `NPC_CROP_CONVERT_EXCLUDED_VILLAGE_IDS`, `CAPITAL_GRANARY_WATCHER_ENABLED`, `CAPITAL_GRANARY_WATCHER_RATIO`
- **Celebrations RR:** `CELEBRATIONS_ROUND_ROBIN_ENABLED`, `CELEBRATIONS_LOOP_MIN_MINUTES`, `CELEBRATIONS_LOOP_MAX_MINUTES`, `CELEBRATIONS_TYPE`, `CELEBRATIONS_QUEUE_DEPTH` (1 or 2, default 1), `CELEBRATIONS_INCLUDED_VILLAGE_IDS`, `CELEBRATIONS_EXCLUDED_VILLAGE_IDS`
- **Raid evacuation:** `RAID_EVACUATION_ENABLED`, `RAID_EVACUATION_TRIGGER_MINUTES`, `RAID_EVACUATION_RESERVE_PER_RESOURCE`, `RAID_EVACUATION_PIVOT_VILLAGE_IDS`, … (see `.env.example`)

Settings changed from the **`S`** menu persist back into `.env` for the keys wired in `login.js` (`persistRuntimeSettings`).

Optional overrides: `VILLAGE_BUILDER_URL`, `FARMLIST_URL`, `NEXIAN_ACTION_LOG_FILE`, selectors for farmlists, etc.

---

## Logging

- **Action log:** `log.jsonl` (or `NEXIAN_ACTION_LOG_FILE`) — bot actions (farmlists, troops, builder, …)
- **Top 10 log:** `top10.log` (or `TOP10_TRACKING_LOG_FILE`) — one JSON object per line per ranking category per snapshot (`ts`, `epochMs`, `top10`, `self`). The dashboard aggregates these lines for Δ and `/h`.
- **Session presence:** `session-presence.json` (or `SESSION_PRESENCE_LOG_FILE`) — online periods with start/end, egress IP, and proxy. API `GET /api/session-presence`.
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
- **Bot crashed / dashboard dead:** run `npm run cursor:ensure` (or `npm run start:24-7`). Check `keep-alive.log` for `restarting bot (...)`.
- **Wrong egress IP / stuck on old proxy:** `POST /api/proxy-settings` with `{"action":"next"}` (or **Apply**). Confirm `account.publicAddress` matches the new proxy host after `automation.reason` is `online`.
- **Top 10 empty / no Δ:** need at least two successful snapshots in `top10.log`; confirm `TOP10_TRACKING_ENABLED` and that `/api/top10` returns `ok: true` categories.

---

## License / game rules

Automate only accounts you control and obey Nexian’s terms of service. This tool clicks the same UI actions you could perform manually—it does not bypass authentication.
