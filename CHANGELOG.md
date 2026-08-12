# Changelog

All notable changes to this project are documented in this file.

## [1.8.28] — 2026-08-12

### Fixed

- **Farmlist send on Nexian** — auto-send now clicks `farmlist_selectfull_*` (select all raid targets per list). `farmlist_selectall_*` alone left `#btn_send_all` disabled and caused repeated `farmlist.send` failures. Raid `slot[]` checkboxes are scoped via the farmlist form (not the selectall table). Cooldown / nothing-ready ticks return **idle** instead of failed.

## [1.8.27] — 2026-08-12

### Changed

- **Village Status troop report** — after the usual village page read, also scrapes **Account Overview → Troops** (`overview.php?t=4`) and prints **own troops** for the selected village (home + away) plus **account totals**. Village-page `#troops` remains labeled as at-home only.

## [1.8.26] — 2026-08-12

### Fixed

- **Overflow / Celebrations / NPC loop timers** — normal reschedules no longer collapse to **15s**. `Math.max(15000, options.retryMs||0)` treated every tick as a short retry, so Celebrations (60–120m) and Overflow (8–15m) hammered the session. Explicit `retryMs` still floors at 15s.
- **Marketplace confirm click** — second OK waits for the confirm page and no longer re-clicks the compose-form OK. Tentative success requires a real confirm-stage click.
- **Overflow / evacuation marketplace lock** — both paths take the same exclusive session as smart circulation so they cannot race the builder market tab.
- **Overflow / evacuation stock verify** — late header re-read after a failed first verify (same as circulation).

## [1.8.25] — 2026-08-11

### Added

- **Resource overflow guard** — RR watcher that sends surplus to the **capital/pivot** when warehouse or granary fill hits the trigger (default **≥90%**), draining toward a keep ratio (default **75%**). Sends only if map distance ≤ **10 squares** (configurable); far villages never send even when overflowing. Reuses marketplace send helpers and the same receiver fill-ratio caps as smart circulation. Terminal **Settings → OG**; env `RESOURCE_OVERFLOW_*` (on by default). Combined with nearest-donor circulation so local surplus prefers nearby pulls/pushes.

### Fixed

- **Capital detection** — village scrape now honors `__vgConfig.capitalId` when the capital group DOM attribute is missing (Nexian), so pivot defaults and non-capital builder RR work again.

## [1.8.24] — 2026-08-09

### Added

- **Celebrations RR** — optional round-robin Town Hall celebrations for culture points. Polls villages on a min–max interval (default **60–120m**), opens `build.php?gid=24`, and clicks **Hold celebration** when available (`auto` prefers large else small). Queue depth **1 or 2** (default **1**): with depth 1, a celebration already in progress means skip (do not queue another). Terminal **Settings → C** (enable/timing/type/queue) and **F** (include/exclude village filter sheet). Env: `CELEBRATIONS_*` (off by default).

### Fixed

- **Troop trainer “Available: 0” false empty** — Nexian’s barracks/stable `Available: N` is owned troop count, not max trainable. The trainer no longer treats owned `0` as “cannot train”, which had blocked Phalanx/Haeduan queues when those units were not already in the village.

### Changed

- **Troop plans train cavalry before infantry** — Stable / Great Stable branches run before Barracks so raid cavalry (TT, Haeduan) is not starved by infantry batches in the same tick.
- **Reserve for cavalry** — if Stable/Great Stable returns `no_resources`, Barracks is skipped that tick so infantry cannot keep resources permanently below the cavalry threshold.

### Fixed

- **Troop trainer “Available: 0” false empty** — Nexian’s barracks/stable `Available: N` is owned troop count, not max trainable. The trainer no longer treats owned `0` as “cannot train”, which had blocked Phalanx/Haeduan queues when those units were not already in the village.

### Changed

- **Troop plans train cavalry before infantry** — Stable / Great Stable branches run before Barracks so raid cavalry (TT, Haeduan) is not starved by infantry batches in the same tick.
- **Reserve for cavalry** — if Stable/Great Stable returns `no_resources`, Barracks is skipped that tick so infantry cannot keep resources permanently below the cavalry threshold.

## [1.8.23] — 2026-08-08

### Added

- **NPC crop convert watcher** — optional round-robin loop that checks village granaries on a min–max poll. When crop fills to the configured threshold (default **95%**), opens Marketplace → NPC Merchant via the **human path** (village center → Marketplace → NPC tab), with direct URL fallback `build.php?id=33&t=3&gid=17` (`NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID`). Redistributes so **crop → 0%** and wood/clay/iron share the rest (warehouse-capped). Toggle in terminal **Settings → N** or `.env` (`NPC_CROP_CONVERT_*`). Costs in-game gold per exchange; disabled by default.

## [1.8.22] — 2026-08-08

### Changed

- **Builder resource circulation prefers nearest donors** — when feeding an off-village (e.g. next to the capital), merchants prefer nearby **more-developed** donors (capital first) so a new village is not drained to feed the capital. Controlled by `RESOURCE_CIRCULATION_PREFER_NEAREST` (default true).

## [1.8.21] — 2026-08-08

### Added

- **Post-settle village naming** — planned targets may include `villageName` (e.g. `5-MeO-DMT`). After settlers are dispatched, the name is queued in `templates/pending_village_names.json` and applied via Profile → Village name once the village appears at those coordinates. Expansion checks and `@rename-pending` process the queue.

## [1.8.20] — 2026-08-08

### Fixed

- **Portal login picks GAME_HOST realm** — the marketing portal’s first Login button is Speed (`s2`). Login now opens `openLogin('s1')` (from `GAME_HOST`) and forces the form action to that realm before Enter Realm, so credentials no longer post to the wrong world and bounce back to `nexian.world`.

## [1.8.19] — 2026-08-06

### Added

- **Settlement map-tile URL fallback** — planned targets may include `mapTileId` / `mapUrl` (e.g. `https://s1.nexian.world/village3.php?id=42423`). Expansion opens that direct tile link before falling back to map coordinates, so settling next to the capital stays reliable.

## [1.8.18] — 2026-08-05

### Fixed

- **Keep-alive respects session rest** — stale `log.jsonl` during play/rest cycles no longer kills a healthy rest/relogin. Treats `paused` plus reasons `resting` / `relogin` / `reconnecting` / `logging_in` as intentional off. Default stale threshold raised to **25m** (above max rest 20m). Arms restart-grace when keep-alive starts while the bot is already up.

## [1.8.17] — 2026-08-05

### Fixed

- **Session-rest proxy: rotate once per rest** — wake login retries reuse the same pool entry instead of advancing again, so failed logins no longer skip addresses. Logs show `#N/total` and `(rotated)` / `(retry same proxy)`.

### Added

- **`GET` / `POST /api/session-loop`** — live session play/rest + `proxyRotateOnSessionRest` without restart (same pattern as proxy-settings).
- **Dashboard** — checkbox to rotate proxy on each session rest→wake; status strip shows play/rest ranges and rotate.
- **Terminal menu [5]** — prompt for rotate-on-rest; confirms full-pool cycling when the pool has 2+.

### Changed

- Session-loop status includes `proxyActiveIndex`, `proxyActiveDisplay`, and `proxyWillRotateOnRest` for ops visibility.

## [1.8.16] — 2026-08-05

### Added

- **PC 24/7 host (no tmux)** — run consistently on an always-on Windows/macOS/Linux PC:
  - `scripts/keep-alive.js` / `scripts/start-24-7.js` — cross-platform Node watchdog + starter
  - `start-24-7.cmd`, `setup-pc.cmd` — Windows double-click setup/start
  - `scripts/register-pc-task.ps1` — optional Windows Task Scheduler at logon
  - `npm run start:24-7:pc`, `keep-alive:pc`, `setup:pc`
  - README: **Run 24/7 on your PC** (recommended over Cursor Cloud for uptime)

## [1.8.15] — 2026-08-04

### Changed

- **Docs: proxy rotate + egress IP ops** — README documents `POST /api/proxy-settings` actions (`next` / `apply` / `disable` / `save`) and how to read the live proxy + public IP from `GET /api/status`. AGENTS.md adds the same curl recipes for Cloud Agents.

## [1.8.14] — 2026-08-04

### Changed

- **Keep-alive polls every 15s** (default) — faster heartbeats and quicker restart when the bot/dashboard dies. Override with `CHECK_SECONDS`. Stale-log threshold defaults to **25m** so session-rest (≤20m) is not mistaken for a hang; keep-alive skips restarts while automation is resting/relogging.

## [1.8.13] — 2026-08-04

### Added

- **Session presence report** — records each online window with start/end time, egress IP, and proxy:
  - Stored in `session-presence.json` (gitignored)
  - Dashboard **Session presence** panel on the main tab
  - API: `GET /api/session-presence?limit=100`
  - Tracks login, session-loop rest/wake, relogin, proxy changes, headless toggle, and shutdown
  - Egress IP prefers Playwright context (follows proxy); falls back to direct ipify
  - Timeline lines shaped like: `10:00 login with IP1` → `10:49 logout` → `10:49 rest time` → `10:59 login with IP2`

## [1.8.12] — 2026-08-04

### Added

- **Cursor Cloud 24/7 Environment** — `.cursor/environment.json` installs deps and auto-starts the keep-alive stack on every Cloud Agent boot:
  - `scripts/cursor-cloud-install.sh` — idempotent `npm ci` + Playwright Chromium
  - `scripts/cursor-cloud-start.sh` — materialize secrets → `.env`, then `npm run start:24-7`
  - `scripts/materialize-dotenv.sh` — prefer secret `NEXIAN_DOTENV` (full `.env` body)
  - `scripts/cursor-cloud-ensure.sh` — health check / restart for Automations
  - `AGENTS.md` — Cloud-specific keep-alive rules and Automation continuity notes

## [1.8.11] — 2026-08-04

### Added

- **Your pace for all Top 10 categories** — attack points, defense points, climbers, alliance points, population, villages (plus raid income):
  - `selfPace[]` on `/api/top10` with active /h, wall /h, Δ, totals
  - Dashboard cards under the raid-income hero
  - Same stall-excluding active-gap logic as Robbers

## [1.8.10] — 2026-08-04

### Added

- **Raid income focus for Top 10** — dashboard hero + `raidIncome` on `/api/top10` normalize **your Robbers** score to resources/hour:
  - **Active /h** excludes long downtime gaps (≈3× Top 10 poll interval)
  - **Wall /h** uses full elapsed time across all polls
  - Shows Top 10 + farmlist interval settings beside the pace
  - Defaults the leaderboard tab to **Robbers**

## [1.8.9] — 2026-08-03

### Release

**v1.8.9** — Top 10 results dashboard with poll-to-poll Δ and per-hour pace, 24/7 keep-alive watchdog, session-rest proxy visibility, farmlist village pinning, and Palace expansion on realm host.

### Added

- **Top 10 dashboard tab** (`top10Dashboard.js`, `/api/top10`): standings cards, podium, leaderboard, and trend chart for all seven ranking categories. Manual **Snapshot now** from the web UI (same as menu **[O]**).
- **Top 10 Δ and `/h` pace:** deltas are computed from **every polled log entry** in `top10.log` (first → latest), with a poll-by-poll interval table and a separate last-interval `/h`. Leaderboard rows match names across snapshots.
- **24/7 keep-alive watchdog** (`scripts/keep-alive.sh`, `npm run start:24-7` / `npm run keep-alive`):
  - Polls every **60s** (`CHECK_SECONDS`)
  - Restarts the bot if `login.js` is dead, the dashboard API is down, or `log.jsonl` is stale **≥20m** (`STALE_MINUTES`) while automation is expected
  - Skips restart when automation is paused (session rest)
  - **Post-restart grace** (`STALE_GRACE_MINUTES`, default 5): after a restart, do not immediately re-trigger on a still-old `log.jsonl` (avoids restart loops while login / first loop ticks)
  - Writes heartbeats and restart reasons to `keep-alive.log`
- **In-process overdue-loop watchdog** — reschedules farmlist / builder / activity / Top 10 when timers stall.
- **Session wake recovery** — login timeout + proxy-rotate retries when the session loop resumes from rest; clears resting state after resume.
- **Proxy rotate-on-rest status** — session/proxy status exposes whether the next rest will rotate egress; wake logs the next proxy.

### Fixed

- **Top 10 scrape URLs** — uses Nexian `statistics.php` tables (`?t=5`, population, alliances, villages) instead of SPA `/statistics/...` paths that returned empty boards.
- **Farmlist sender reporting and village pinning** — clearer send results; pin auto-send to a rally-point village via `FARMLIST_VILLAGE_ID`.
- **Palace expansion on realm host** — empty slot 25 / Palace construction works against the configured `GAME_HOST` realm.

## [1.8.8] — 2026-07-15

### Release

**v1.8.8** — Top 10 statistics tracking (`top10.log`), farmlist highest auto-loop priority (v1.8.7), and troop auto idle-wait cap (10s). Includes all **1.8.6** troop plans, proxy pool, and reliability fixes.

### Added

- **Top 10 statistics tracking** (`top10Tracking.js`): scheduled or manual snapshots of server Top 10 rankings — attackers, defenders, robbers, climbers, population, alliances, and villages — plus your own rank when found. Each category is appended as one JSONL line with ISO timestamp and `epochMs` in `top10.log` (configurable) for time-series analysis. Enable in Settings **[O]** or `.env`; run once from main menu **[O]**.

### Changed

- **Troop auto idle wait capped at 10s.** If the browser is busy (e.g. Top 10 snapshot **[O]**), troop auto logs once and skips instead of waiting minutes with repeated “Still waiting” lines; it retries that village in ~15–25s.

## [1.8.7] — 2026-07-13

### Changed

- **Farmlist send has highest auto-loop priority.** When the farmlist loop (or manual menu **1** / dashboard send) runs, it pre-empts builder, troop auto-train, cranny RR, and activity simulation instead of waiting up to 3 minutes or retrying. Raid evacuation and manual menu actions are not interrupted.

## [1.8.6] — 2026-07-12

### Release

**v1.8.6** — troop plans (four building branches), proxy pool + session-loop proxy rotation, and reliability fixes for farmlist send, troop auto scheduling, and Stable/map discovery. Requires `GAME_HOST` for realm URLs; use `FARMLIST_VILLAGE_ID` when farmlists live on a specific rally-point village.

### Fixed

- **Farmlist loop mistook `#btn_train` for send.** When the browser was still on a troop-trainer page after builder/troop loops, DOM discovery picked the Train button (id starts with `btn_`). Send controls are now validated, troop trainer buttons are excluded, the farmlist page is confirmed before send, and rally-point fallback navigation uses the pinned `FARMLIST_VILLAGE_ID`.

## [1.8.5] — 2026-07-09

### Fixed

- **False “no Stable in this village yet”.** Village-map discovery now matches “Stable” / “Stables”, uses the same broad map selectors as the builder, opens the correct slot URL, and verifies the trainer page via heading/`gid`/`#build.gid20`. If a building is on the map but the page failed to load, the bot retries next cycle instead of caching it as missing for 12 hours.

## [1.8.4] — 2026-07-09

### Fixed

- **Troop auto “no Stable in this village yet” every cycle.** When a plan includes Stable/Great Stable but the village does not have that building yet, the bot logs once, skips that branch on later runs (rechecks every ~12h), and no longer navigates to the trainer each interval. Trainer URLs are also resolved from the village map first instead of assuming `build.php?id=38`.

## [1.8.3] — 2026-07-09

### Fixed

- **Farmlist send when `#btn_send_all` stays disabled.** Selects individual farmlist checkboxes (not only select-all), fires change events for Nexian UI, and treats “all lists on cooldown / nothing ready” as a normal idle tick instead of a failed send with 2-minute retries.

## [1.8.2] — 2026-07-09

### Fixed

- **Troop auto lock contention.** Per-village troop timers no longer skip each other with `browser busy` / `another action is currently running (auto-troop-trainer)`. Runs are queued and wait for the browser; initial schedules are staggered across the interval so villages do not all fire at once.

## [1.8.1] — 2026-07-09

### Added

- **Proxy rotation on session-loop rest re-login.** When the session loop logs out, rests, and logs back in, the bot rotates to the next proxy in the pool (if you have 2+ saved), clears the saved session, and re-logins through the new proxy. Set `PROXY_ROTATE_ON_SESSION_REST=false` to keep the same proxy across rest cycles.

## [1.8.0] — 2026-07-09

### Added

- **Proxy pool with paste support.** Paste multiple proxies (one per line) in terminal **y → [2]** or dashboard **Settings → Proxy pool**. Supported formats: `host:port:user:pass`, `user:pass@host:port`, `http://user:pass@host:port`, `socks5://host:port`. Pool saved to `templates/proxy_list.json`.
- **Dashboard proxy panel:** textarea paste, active proxy picker, Save list, Apply + relogin, Next + relogin, Disable direct. Active proxy shown on the status strip.

## [1.7.0] — 2026-07-09

### Added

- **Proxy support for the game browser.** Set `PROXY_SERVER` (and optional `PROXY_USERNAME`, `PROXY_PASSWORD`, `PROXY_BYPASS`) in `.env`, or change at runtime without quitting:
  - Main menu **y** → proxy menu
  - Settings **Y** → proxy menu
  - **[1]** edit fields, **[A]** logout + relogin through proxy and continue automation, **[D]** disable proxy + relogin direct
  - Proxy is saved to `.env`; saved session cookies are cleared on proxy change so login goes through the new route.

## [1.6.8] — 2026-07-06

### Fixed

- **Troop auto `ERR_ABORTED` on barracks/stable navigation.** Trainer and village-map discovery now use `safeGotoWithRetry` (retries aborted/interrupted navigations). When training still fails with a transient nav error, the village retries in ~20–45s instead of waiting the full plan interval.

## [1.6.7] — 2026-07-05

### Changed

- **Troop auto countdown logs include seconds**, e.g. `next train in 7m 34s` (random 0–59s added to each scheduled tick for finer timing). Busy-retry lines use the same format.

## [1.6.6] — 2026-07-05

### Changed

- **Troop plan editor shows all four buildings explicitly.** Edit/New now lists Barracks, Great Barracks, Stable, and Great Stable with numbered steps `[1/4]`–`[4/4]` and current values before prompting. The plans menu header shows the engine version — if you still see "Infantry/Cavalry" prompts, restart the bot to load v1.6.4+.

## [1.6.5] — 2026-07-05

### Fixed

- **Great Stable / Great Barracks training on Nexian AJAX pages.** Training now waits for the `ajax_build.php` `train_troops` response (or cleared inputs) instead of a fixed 1.5s delay. Building discovery also matches `gid=30` / `gid=29` on map links and verifies `#build.gid30` (etc.) before training.
- **Population cap (`Available: 0`).** Units with zero available population (e.g. Haeduan when capped) are skipped instead of attempting to queue them.

## [1.6.4] — 2026-07-05

### Added

- **Great Barracks and Great Stable in troop plans.** Each plan can now set a unit + qty for Barracks, Great Barracks, Stable, and/or Great Stable. The plan editor, unit preview (T → U), auto-train loop, and manual train (menu 4) all use these branches. Villages without a great building skip that branch with a log message.

## [1.6.3] — 2026-07-05

### Fixed

- **Troop training skipped when another loop was busy.** All loops share one browser, so a troop tick that fired while farmlists/builder/cranny was running got skipped and pushed to the next full 15–25 min interval. Now, when the browser is busy, the village retries in ~1 minute instead of losing its turn for a whole cycle.

## [1.6.2] — 2026-07-05

### Performance

- **Block images/fonts/media downloads** (`BLOCK_MEDIA=true`, default on) — pages load much faster and use less RAM; selectors still work. Set `BLOCK_MEDIA=false` to load full pages.
- **Capped `networkidle` waits** in the farmlist flow (12–20s → 3.5–4s) so runs don't stall waiting for a page that never goes fully idle.
- **Leaner Chromium launch args** (disable extensions/background networking/timer throttling, mute audio).

## [1.6.1] — 2026-07-05

### Changed

- **Removed the "Live console" panel from the web dashboard.** The Recent log panel remains. Terminal output is still visible in the terminal itself.

## [1.6.0] — 2026-07-05

### Changed

- **Troop trainer rebuilt around plans (terminal-driven).** Removed the old mode/tribe/branch template engine and `troopVillagePreferences.js`. New model:
  - **Troop plans** (`templates/troop_plans.json`): each plan sets an infantry unit + qty and/or a cavalry unit + qty, plus its own train timer (min/max minutes).
  - **Assign villages to a plan** and toggle on/off. When a village's timer fires it opens the Barracks (infantry) and/or Stable (cavalry) and trains the target quantity, or the **maximum affordable** if resources are short.
  - Manage everything from the terminal: main menu **T** (or Settings **U**) → create/edit/delete plans, assign villages, preview trainable unit names, toggle the auto-train loop + default interval.
  - Main menu **4** now trains the selected village's assigned plan once.
  - The web dashboard troop tab is now read-only (plans are managed in the terminal).
- Removed env keys `TROOP_TEMPLATE_*`, `TROOP_TRIBE`, `TROOP_TRAINING_PRESET`, `TROOP_TRAINING_BATCH_SIZE`, `TROOP_TRAINING_ALTERNATE_GREAT_BARRACKS`, `TROOP_GREAT_TRAINER_URL`. `TROOP_TRAINING_LOOP_MIN/MAX_MINUTES` now act as the default timer when a plan doesn't set its own.

## [1.5.19] — 2026-06-18

### Added

- **Builder RR: resource fields → village stage** — with round-robin on and `BUILDER_DEFAULT_PLAN_MODE=resource`, each village finishes resource field templates first, then automatically continues village-stage building. Progress shows as `res X/Y · village X/Y`. Disable with `BUILDER_RR_RESOURCE_THEN_VILLAGE=false`.

---

## [1.5.18] — 2026-06-18

### Changed

- **Troop templates (terminal)** — simplified global menu (edit infantry/cavalry for the active mode only, not four separate lists). New **per-village** menu: pick a village, toggle auto-train, set off/def, edit lists, or apply tribal defaults. Reach it via main menu **T → 7**, or Settings **U**.

---

## [1.5.17] — 2026-06-18

### Fixed

- **Headed browser rapidly cycling all villages** — raid guard no longer opens every village every 5s; it refreshes the village list once and only opens villages flagged under attack. Poll interval default is now 30s (`RAID_EVACUATION_POLL_SECONDS`). Added `VILLAGE_SWITCH_DELAY_MS` (headed default 800ms) between village navigations.

---

## [1.5.16] — 2026-06-18

### Fixed

- **`ERR_INSUFFICIENT_RESOURCES` during builder circulation** — marketplace navigation now retries with exponential backoff; circulation waits 15s and retries once; triggers a browser restart if still failing; skips redundant village-page refresh when the list is fresh.

---

## [1.5.15] — 2026-06-18

### Fixed

- **Web dashboard slow to open** — HTTP server starts before Playwright login so the page loads immediately; village refresh and automation loops run in the background; UI shows LOGGING IN / LOADING until villages are ready.

---

## [1.5.14] — 2026-06-18

### Fixed

- **Slow startup / login** — reuse `storageState.json` when valid (skip portal login), navigate straight to the village after Enter Realm instead of long polling, skip redundant village-list navigation when already on the overview, and fetch public dashboard IP in the background.

---

## [1.5.13] — 2026-06-18

### Added

- **`BROWSER_REFRESH_HOURS`** — optionally restart Chromium on a timer (logout → close → fresh login) to cap long-run RAM use. Waits up to 5 minutes for the current action to finish; retries in 15 minutes if busy or failed.

---

## [1.5.12] — 2026-06-18

### Fixed

- **High RAM use (~4 GB)** — lighter SSE snapshots (no troop payloads on every tick), drop duplicated tribe defaults in troop API, cap Node heap via npm scripts, slower heartbeat, release snapshot cache when the dashboard tab closes, Chromium `--disable-dev-shm-usage`.

---

## [1.5.11] — 2026-06-18

### Fixed

- **Farmlist auto-send skipped after raid guard or errors** — raid evacuation no longer cancels the send; loop waits for idle, retries twice after 2 minutes on skip/failure, and still sends after a successful raid guard check.

---

## [1.5.10] — 2026-06-18

### Fixed

- **Slow terminal / sluggish CLI** — stop redrawing the full menu after every action (compact status line instead); skip dashboard snapshot work when no browser tab is connected; cache snapshot builds; skip console→SSE mirroring when the web UI is closed; less frequent dashboard heartbeat.

---

## [1.5.9] — 2026-06-18

### Fixed

- **Portal login timeout on “Enter Realm”** — submit via DOM click instead of Playwright navigation wait; poll for realm redirect up to 90s (portal redirects often exceed 15s or never reach `networkidle`).

---

## [1.5.8] — 2026-06-18

### Fixed

- **Web dashboard felt stuck / frozen** — throttled status DOM updates, skip rebuilding villages and action buttons when unchanged, optimistic “Queued…” feedback on click.
- **Web commands lost during automation** — dashboard waits for the current action to finish before running a queued command (same as terminal **V**).
- **Console flood in dashboard mode** — terminal menu is no longer printed every loop tick when the web UI is active.
- **Stale busy state** — snapshot is force-published when an action starts and when it finishes.

---

## [1.5.7] — 2026-06-18

### Added

- **Action log rotation** — when `log.jsonl` exceeds `NEXIAN_ACTION_LOG_MAX_BYTES` (default 10MB), the file is moved to `log-archive/` with a timestamp and a fresh log starts. Terminal log summary (**L**) shows archive folder and file count.

---

## [1.5.6] — 2026-06-18

### Fixed

- Throttled dashboard snapshots no longer rebuild full state on every loop tick (cached object returned instead).
- Removed redundant snapshot publish when scheduling each per-village troop timer.

---

## [1.5.5] — 2026-06-18

### Fixed

- **Dashboard out-of-memory crashes** — affects any hardware (including strong PCs) after long runs; caused by unbounded log reads and oversized/frequent SSE snapshots, not insufficient RAM.

### Changed

- Dashboard launcher sets `NODE_OPTIONS=--max-old-space-size=512` when unset (helps on Pi / low-RAM hosts).

---

## [1.5.4] — 2026-06-18

### Changed

- **Compact terminal menu layout** — session line first, then loops (Cranny on its own row), then two-row action keys (`0–5` / `T C V…`), then village context at the bottom.

---

## [1.5.3] — 2026-06-18

### Fixed

- **Settings [D] Compact UI** — `dashboardBridge is not defined` when toggling display; bridge variable is now in the same scope as `updateDashboardDisplayConfig`.

---

## [1.5.2] — 2026-06-18

### Fixed

- **Village selector (V)** waits up to 2 minutes for the current action to finish before opening the village list or switching villages (dashboard select too). Avoids navigation errors when builder/farmlist/etc. is still using the browser.

---

## [1.5.1] — 2026-06-18

### Fixed

- **Village selector navigation** — `village1.php` redirects to `?vid=…` no longer fail with “interrupted by another navigation”; shared `safeGotoWithRetry` handles redirect races (village menu **V**, dashboard village pick, status refresh).

---

## [1.5.0] — 2026-06-18

### Added

- **Pi 3.5″ compact dashboard** — layout and typography tuned for ~480×320 TFT (Raspberry Pi). Flex viewport fit, 4-column action grid, collapsed village picker, abbreviated loop stats, shorter console lines.
- **Compact terminal UI** — shorter main menu, one-line loop status, compact village context, and settings summary when `DASHBOARD_COMPACT_VIEW=true` or terminal **S → D**.
- **`BUILDER_DEFAULT_PLAN_MODE`** — auto builder loop defaults to **resource fields** (`resource`); set `village` for village-stage plans.

### Changed

- Compact view syncs web + terminal from one setting (`DASHBOARD_COMPACT_VIEW` / Settings **[D]**).
- Dashboard re-renders actions and status immediately when toggling compact (no stale long labels).
- Village selector on dashboard is a collapsible `<details>` block (closed in compact view).
- Cache-bust versions aligned (`v=1.5.0`).

### Fixed

- Duplicate variable declarations in `printSessionLoopStatus` (syntax error in full menu path).
- Mismatched asset cache versions between `index.html` CSS and JS.

---

## [1.4.0] — 2026-06-18

### Added

- **Web dashboard** (`dashboardServer.js`, `dashboardBridge.js`, `public/`): local UI at `http://127.0.0.1:3847` with live status, console, actions, and SSE updates. npm scripts `dashboard`, `dashboard:nexian`, etc.
- **Troop Templates tab:** per-village unit toggles and quantities, global defaults, per-village auto-repeat with independent min/max timers, saved to `templates/troop_village_preferences.json`.
- **Settings tab:** activity simulation controls (enable, interval, browse patterns).
- **Activity simulation** (`activitySimulation.js`): random page browsing on a timer to simulate account activity without sending troops or resources; session event counter in logs and dashboard.
- **Terminal settings `[N]`** for activity simulation; troop manual-focus setting removed (Train now always runs infantry + cavalry from template toggles).

### Changed

- Troop training loop uses per-village timers instead of a single round-robin tick.
- Graceful dashboard quit (SIGINT / Ctrl+C) and dev launcher scripts (`dashboard-dev*.cmd`, `.ps1`, `.sh`).
- Dependencies: `playwright` and `dotenv` updated to latest compatible versions.

---

## [1.3.0] — 2026-05-18

### Release

Stable **1.3** package: everything from **1.2.1** (automation pause, builder RR exclusions, expansion resource statuses, main menu **T** / **4** keys) plus export packaging.

### Changed

- **Export zip naming:** `nexian-v{version}-{YYYY-MM-DD-HH-mm-ss}.zip` (local time); archive root folder `nexian-v{version}` (no repo directory name in the filename).

### Export

```bash
npm run clean:runtime
npm run export
```

---

## [1.2.1] — 2026-05-12

### Fixed

- **Cranny defense RR loop:** `crannyExecuted` is now declared in the scheduled tick (it was previously assigned without `let`/`const`, which could attach to the global object in non-strict scripts).
- **Troop evacuation click helper:** removed a misleading unused inner variable in the force-click retry path.
- **Builder loop (RR):** removed a duplicate “no non-capital villages” block that was unreachable after RR candidate filtering.

### Added / changed (since prior packaged state)

- **Automation pause:** main menu **`P`** toggles pause; optional auto-resume after `MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES` (Settings **8**). Wired through `setAutomationPaused` / `getAutomationStatus`; main menu shows automation state.
- **Builder round-robin exclusions:** `BUILDER_RR_EXCLUDED_VILLAGE_IDS` in `.env`; Settings **`Y`** sheet to toggle villages; village context shows when selected/active village is excluded from builder RR.
- **Farmlist navigation:** `safeGotoFarmlist` retries on transient navigation / `ERR_ABORTED` errors.
- **Settings UX:** Troop RR (**T**) and Cranny RR (**I**) prompts combine enable/disable with interval edits; raid troop evacuation (**K**) combines troop evac toggle and recall delay; removed duplicate interval-only rows.
- **Builder loop:** RR uses only non-excluded, incomplete villages; fast ~5s retry when a village is temporarily blocked (`blocked_*` / `idle_saturated`) to rotate sooner; manual builder (**2**/**3**) aligns with RR hops and follow-up steps for template boundaries.
- **villageBuilder:** `resolveNextStep` returns `null` when progress is past the final stage (avoids post-completion loops); last-slot satisfaction advances `next_template` or reports `all_complete`.
- **villageExpansion:** residence page parses upgrade costs; distinguishes regular vs Master Builder upgrade; new statuses `need_residence_resources` and `need_settler_training_resources` for circulation / UX; expansion menu treats those like settlement resource needs.
- **Main menu mnemonics:** **T** = Troop Trainer (manual train); **4** = Troop Templates (CSV / tribe / batch). **P** = pause automation, **Q** = quit. Settings submenu **T** (Troop RR loop) is unchanged.

### Export

From the project root:

```bash
npm run clean:runtime
npm run export
```

Produces `nexian-v<version>-<YYYY-MM-DD-HH-mm-ss>.zip` (local time) in the parent directory of the repo folder (see `export.js`).

---

## TODO / roadmap

High-value follow-ups (not committed work):

1. **Automated tests** — parsing helpers, template / progress validation, and small unit tests around env normalization.
2. **Builder loop telemetry** — optional verbose timing logs per village to tune cooldowns and RR fairness.
3. **Headless stability** — broader retry wrappers for other `page.goto` hot paths (status, builder) where transient aborts still surface.
4. **Pi polish** — optional dedicated `TERMINAL_COMPACT` vs `DASHBOARD_COMPACT` if independent toggles are needed; touch-target sizing pass on Troop Templates tab at 320px height.
5. **Documentation** — generated “keys reference” from menu strings when the terminal menu changes.

Ideas previously noted in `README.md` (meta defaults, raid tuning) remain optional product polish.
