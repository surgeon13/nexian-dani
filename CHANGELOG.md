# Changelog

All notable changes to this project are documented in this file.

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
