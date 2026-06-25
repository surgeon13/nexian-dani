# Nexian Automation Helper

Menu-driven Playwright automation for Nexian: login/session reuse, farmlists, village status, template-based builders, troop training, village expansion helpers, timed loops, and append-only action logging (`log.jsonl`).

Release notes and a concise TODO list: [CHANGELOG.md](CHANGELOG.md).

---

## Features

| Area | Behavior |
|------|----------|
| **Login / session** | Saves browser storage to `storageState.json` so you can skip full login after the first run. |
| **Main menu** | Village status, farmlists, village-stage builder, resource-fields builder, troop trainer, expansion check, logs, settings, village picker. |
| **Web dashboard** | Local browser UI at `http://127.0.0.1:3847` — status, actions, live console, troop templates, activity settings. **Compact view** for small screens (e.g. Raspberry Pi 3.5″ TFT). |
| **Compact UI** | One setting (`DASHBOARD_COMPACT_VIEW` or terminal **S → D**) toggles compact **web layout** and shorter **terminal menus**. |
| **Village templates** | JSON templates under `templates/`; progress in `templates/progress.json`. |
| **Loops** | Optional timers for farmlists, builders, troop training, session play/rest windows, raid-guard heartbeat. |
| **Ctrl+C** | Soft-cancel running action and return to the menu (does not tear down the browser session alone). |

### Automation modules

- **Resource circulation** — Optional marketplace-style transfers when the builder is blocked on resources or for settlement prep. Toggle in **Settings** (`U`, `V`) or `.env` (`RESOURCE_CIRCULATION_*`). When disabled or insufficient, ship resources manually in-game.
- **Raid evacuation** — When enabled (`RAID_EVACUATION_*`, Settings → Raid), the app can send resources from a village toward a **pivot** village when an incoming attack is within the configured ETA window. Configure pivot IDs in Settings **[H]** or env. Disable if you prefer fully manual handling.

---

## Requirements

- **Node.js 18+**
- **Windows**, **macOS**, or **Linux** (launch scripts differ; see Troubleshooting.)

---

## Project structure

| File / folder | Role |
|---------------|------|
| `login.js` | Entry: env, browser lifecycle, persists selected settings keys to `.env`. |
| `terminalMenu.js` | Menus, village list, timers, raid guard hook, audit logging helpers, compact terminal UI. |
| `dashboardServer.js` / `dashboardBridge.js` | Local web dashboard (SSE, REST API). |
| `public/` | Dashboard HTML, CSS, and client JS. |
| `villageBuilder.js` | Template loading, DOM guards, upgrade / Master Builder steps. |
| `villageExpansion.js` | Expansion / settlers / settlement resource checks (no auto-transfers). |
| `templates/` | Build templates; `templates/index.json` lists available plans. |
| `templates/progress.json` | Per-village builder progress (gitignored; safe to delete to reset). |
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
```

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
| `npm run playwright:install` | Install Playwright Chromium only |
| `npm run clean:runtime` | Removes `storageState.json`, `log.jsonl`, `templates/progress.json` |

---

## Main menu (summary)

Opens after login. Typical keys include:

- **`0`** — Village status (selected village)
- **`1`** — Send farmlists (all villages)
- **`2`** — One **village stage** builder step
- **`3`** — One **resource fields** builder step
- **`4`** — Troop trainer (selected village)
- **`C`** — Cranny defense (selected village)
- **`T`** — Troop templates (preset lines, tribe, batch size)
- **`5`** — Expansion / residence check
- **`V`** — Pick active village context
- **`S`** — Settings submenu (loops, gold complete, **D = compact UI**, raid toggle, expansion options, …)
- **`L`** — Log summary (`log.jsonl`)
- **`P`** — Pause or resume automation loops (farmlist, builder, troop, cranny, raid guard). Optional auto-resume: `MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES` (Settings **3**).
- **`Q`** — Quit menu / session teardown per `login.js` flow

Exact labels are printed each run—use those as source of truth if keys change. With **compact UI** enabled, the main menu collapses to two short rows (same keys).

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

- **Loops:** `FARMLIST_LOOP_*`, `BUILDER_LOOP_*`, `SESSION_LOOP_*`, `TROOP_TRAINING_ROUND_ROBIN_ENABLED`
- **Builder:** `BUILDER_GOLD_COMPLETE_*`, `BUILDER_MASTER_BUILDER_ENABLED`, `BUILDER_ROUND_ROBIN_ENABLED`, `BUILDER_DEFAULT_PLAN_MODE` (`resource` or `village`)
- **Dashboard:** `DASHBOARD_ENABLED`, `DASHBOARD_PORT`, `DASHBOARD_COMPACT_VIEW`
- **Resource circulation:** `RESOURCE_CIRCULATION_ENABLED`, `RESOURCE_CIRCULATION_EXPANSION_ENABLED`, and related `RESOURCE_CIRCULATION_*` caps (see `.env.example`)
- **Raid evacuation:** `RAID_EVACUATION_ENABLED`, `RAID_EVACUATION_TRIGGER_MINUTES`, `RAID_EVACUATION_RESERVE_PER_RESOURCE`, `RAID_EVACUATION_PIVOT_VILLAGE_IDS`, … (see `.env.example`)

Settings changed from the **`S`** menu persist back into `.env` for the keys wired in `login.js` (`persistRuntimeSettings`).

Optional overrides: `VILLAGE_BUILDER_URL`, `FARMLIST_URL`, `NEXIAN_ACTION_LOG_FILE`, selectors for farmlists, etc.

---

## Logging

- **File:** `log.jsonl` (or `NEXIAN_ACTION_LOG_FILE`)
- **Rotation:** When the log exceeds `NEXIAN_ACTION_LOG_MAX_BYTES` (default 10MB), it is renamed into `log-archive/` and logging continues in a new empty file.
- **Format:** one JSON object per line, append-only
- **Summary menu** counts farmlists, troops, upgrades, gold autocomplete, merchant-transfer history (mostly historical), evacuation history (mostly historical).

---

## Export to another computer

```bash
npm run export
```

Produces a zip beside the project folder named like `nexian-v1.3.0-2026-05-18-14-30-00.zip` (package version + local date-time). Exclude private/runtime files manually if you assemble a zip yourself: `.env`, `.env.*` with secrets, `storageState.json`, `log.jsonl`, `node_modules/`, optionally `templates/progress.json`.

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

---

## License / game rules

Automate only accounts you control and obey Nexian’s terms of service. This tool clicks the same UI actions you could perform manually—it does not bypass authentication.
