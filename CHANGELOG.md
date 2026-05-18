# Changelog

All notable changes to this project are documented in this file.

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
4. **Documentation** — keep `README.md` feature table in sync when menu keys change; consider a generated “keys reference” from menu strings.

Ideas previously noted in `README.md` (meta defaults, raid tuning) remain optional product polish.
