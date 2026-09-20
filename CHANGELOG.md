# Changelog

All notable changes to this project are documented in this file.

## [1.8.122] — 2026-09-20

### Fixed

- **`resource_fields_03`/`resource_fields_04` permanently stalled at placing Sawmill/Brickyard/Iron Foundry, so fields never progressed past roughly level 8-10 and villages never completed.** Direct report, with a screenshot of a village's resource-field ring stuck at 8/8/9/10 across the board: *"fields arent get upgraded beyond that level, recheck please"*, followed by *"we think resource_fields_03 never goes beyond that level and therefore villages arent being completed."* Confirmed with a real log for `vid=279`: `Iron Foundry is locked until Main Building reaches level 5 (currently 0). No template step manages Main Building, and no affordable live upgrade is available for it right now. Switching to village stage plan...` — followed immediately by `Caught up 59 already-satisfied step(s)` and a real click on `Marketplace slot 33 upgraded toward level 8`, proving the village's *actual* village-stage progress was already dozens of steps past Main Building's own construction stages. Main Building was never really at level 0.

  `resource_fields_03` is `sequence_mode: "strict"`: place Sawmill → Brickyard → Iron Foundry (each needs Main Building ≥ 5) → upgrade all three to level 3 → Grain Mill to 5. Since it's strict, a block on any of those halts the whole template — and `resource_fields_04`, the template that upgrades the *other* 14 fields to level 10, can never start either. The block here was a false alarm: `readPrerequisiteBuildingLevel()` (used whenever a resource-plan step needs a building's live level that the resource template itself doesn't manage — here, Main Building) resolved that building's slot via `discoverInnerBuildingSlotFromMap()`, which relied solely on the village-map survey. That survey's markup isn't reliable on every server/tribe — the exact same weakness the v1.8.119 Town Hall fix already worked around, just hitting a different building through a different code path this time. When the survey failed to find Main Building, the level was silently reported as `0`, permanently blocking every subsequent placement attempt regardless of Main Building's true level.

  `discoverInnerBuildingSlotFromMap()` now falls back to `probeInnerSlotsForBuilding()` — reading every inner slot (19-40) directly — when the survey comes up empty, mirroring the fallback flexible bonus buildings (`discoverBonusBuildingSlotFromMap()`) already had. The result is cached (reusing the same `flexibleBuildingSlotCache`/30-minute miss TTL infrastructure) so a village that genuinely doesn't have the building yet doesn't pay for a fresh ~22-page probe on every single tick. This also strengthens `attemptPrerequisiteBuildingRelief()` (same underlying discovery call) and `villageExpansion.js`'s Palace/Residence lookup, which both depend on the same function.

### Added

- **`scripts/test-inner-building-slot-discovery-fallback.js`** (wired into `npm test`): reimplements the exact shipped cache/survey/probe control flow with injectable stand-ins for the page-driving dependencies, verifying a successful survey skips probing, a failed survey falls back to the direct inner-slot probe, a discovered slot is cached and cheaply re-confirmed (not re-discovered) on reuse, a cached slot that no longer matches is dropped and rediscovered rather than trusted forever, a genuine miss is cached so it isn't re-probed within the TTL, and an expired miss is retried. 6/6 passed.

### Verification

6/6 new test cases passed. `node --check` passes on `villageBuilder.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end (all 15 test scripts).

## [1.8.121] — 2026-09-20

### Fixed

- **`blocked_master_builder_only` was misclassified as a persistent (genuinely-stuck) block, so a village that was simply busy building — the normal state for any account without Gold Club's second concurrent build slot — could accumulate enough consecutive hits to trip `BUILDER_RR_AUTO_EXCLUDE_BLOCKED_STREAK` (default 12) and get silently, permanently excluded from Builder RR.** Direct report: *"templates still getting stuck in some of the later stages, it doesnt finisy resource bonus buildings and doesnt keep pushing ineer buildings. please improve our algorithmics again."* — with live evidence: `[Builder Loop] repeated_blocked (4): 20-01 (130|-102) (vid=39199) in resource plan keeps hitting 'blocked_master_builder_only' ... Slot 20 has only a Master Builder upgrade button. Enable Master Builder in settings or upgrade manually.`

  `blocked_master_builder_only` means the village's one free build queue slot is currently occupied by another build already in progress — structurally identical to `blocked_queue`/`idle_saturated` (confirmed by reading where `villageBuilder.js` returns it: only when the regular upgrade button is absent/disabled and a gold-completion rescue attempt, if any, didn't free it up). It self-clears the instant that in-progress build finishes, exactly like the other three transient statuses already in `isPersistentBuilderBlock()`'s exclusion list — but it wasn't in that list, so `terminalMenu.js` counted it toward permanent auto-exclusion anyway. Since RR excludes a village wholesale (`BUILDER_RR_EXCLUDED_VILLAGE_IDS`), one wrongly-tripped exclusion silently stopped *both* that village's resource-field/bonus-building progress and its village-stage/inner-building progress at once — exactly matching the report.

  Added `blocked_master_builder_only` to `isPersistentBuilderBlock()`'s transient set in `terminalMenu.js`. It still waits out its existing 5-minute cooldown before the loop retries that village (unchanged), but can no longer trigger `BUILDER_RR_AUTO_EXCLUDE_BLOCKED_STREAK` on its own. Genuinely persistent statuses (`blocked_mismatch`, `blocked_prerequisite_building`, `click_failed`, etc.) are untouched — this narrows the fix to the one status that was wrongly classified, not a blanket change to the auto-exclude mechanism.

  **Villages already excluded for this reason before upgrading are not reverted automatically** — check terminal menu → Settings → `[X]` Builder RR Exclusion and remove them manually; the original exclusion reason (`Stuck on 'blocked_master_builder_only' for N consecutive ticks`) is preserved in the log history for identifying which ones.

### Added

- **`scripts/test-builder-master-builder-transient.js`** (wired into `npm test`): verifies `blocked_master_builder_only` is now transient, the four pre-existing transient statuses are unaffected, and genuinely persistent statuses (`blocked_mismatch`, `blocked_prerequisite_building`, `blocked_target_unavailable`, `click_failed`) still trigger auto-exclusion as before. 3/3 passed.

### Verification

3/3 new test cases passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end (all 14 test scripts).

## [1.8.120] — 2026-09-20

### Fixed

- **`Slot 30 contains 'Sawmill', expected 'Town Hall'` still blocking after v1.8.119, on multiple real villages on the same account.** Direct report, immediately after v1.8.119 shipped: *"this is a mistake which does problems, our town hall slot is set to 23, sawmill is on 30 in our jsons. please fix this issue!"* — with fresh live logs from two separate villages (`vid=29798` and `vid=280`) both hitting the identical `blocked_mismatch` on the identical slot pair.

  v1.8.119's live-map discovery fix is correct and still in place (confirmed: `isFlexibleMapBonusBuilding()` in `villageBuilder.js` treats Town Hall as flexible, and nothing else in the codebase hardcodes a separate slot check for it — `collectChainFieldRequirements()`'s end-state verification only ever looks at resource-field slots 1-18, never inner buildings). But `templates/village_stage_01.json` and `village_stage_02.json`'s Town Hall step still guessed the wrong starting slot (30), which is really where `templates/resource_fields_03.json`/`resource_fields_04.json` place Sawmill (`"slot": 30, "building": "Sawmill"` — confirmed by inspection, and matching the user's own report). Every affected village had already built Sawmill via the resource chain before the village-stage chain ever got around to Town Hall, so Town Hall consistently landed on the next available slot instead — slot 23, confirmed identically across both reported villages.

  Corrected the Town Hall step's slot from `30` to `23` in both templates' step definitions and `end_state.slots` entries (no other template claims slot 23, so this doesn't reintroduce the same kind of collision elsewhere). This makes the very first slot read match Town Hall directly, without depending on the v1.8.119 discovery round-trip succeeding on every server/account. v1.8.119's discovery treatment is left in place as a fallback for any account whose actual layout still differs from 23.

  **A live 24/7 bot process needs a restart to pick up either fix** — the v1.8.119 code change and this v1.8.120 template correction both require pulling the update and restarting the running process (`npm run cursor:ensure` / `npm run start:24-7`, or the PC equivalent); a long-running process doesn't hot-reload template/module files.

### Added

- **`scripts/test-town-hall-template-slot.js`** (wired into `npm test`): verifies both `village_stage_01.json` and `village_stage_02.json` use slot 23 for Town Hall in both their step definitions and `end_state.slots`, and that no template step claims slot 23 for anything other than Town Hall (guarding against reintroducing the same kind of collision this fix removes). 2/2 passed.

### Verification

2/2 new test cases passed (plus the existing 3/3 `test-builder-townhall-flexible-slot.js` re-verified unaffected). `node --check` passes on `villageBuilder.js`. Both templates validated as well-formed JSON. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end (all 13 test scripts).

## [1.8.119] — 2026-09-20

### Fixed

- **`blocked_mismatch` stuck for many consecutive ticks on `[Builder Loop] repeated_blocked (8): 10-07 (99|97) (vid=29798) in village plan keeps hitting 'blocked_mismatch' ... Slot 30 contains 'Sawmill', expected 'Town Hall'. Will not click upgrade on a mismatched building.`** Reported live — 8 consecutive ticks, no upgrades landing.

  `village_stage_01.json`/`village_stage_02.json` hardcode slot 30 for Town Hall, and `villageBuilder.js`'s builder-step check trusted that guess outright — unlike Sawmill, Brickyard, Iron Foundry, Grain Mill, Bakery, Residence, and Palace, which already get live-map slot discovery via `isFlexibleMapBonusBuilding()` because their inner-slot position varies by village/tribe/build order. Town Hall was missing from that list, but it has the exact same problem: Main Building/Warehouse/Granary/Marketplace are built first, in a fixed order, so their guessed slots are reliable — but Town Hall is built much later, by which point one of those already-flexible bonus buildings can have claimed slot 30 first. `celebrations.js` already reaches Town Hall the reliable way, by building type (`build.php?gid=24`), never by a guessed slot — this was the one place still assuming a fixed slot for it.

  Added `townhall` to `isFlexibleMapBonusBuilding()`'s list in `villageBuilder.js`. When the guessed slot 30 doesn't hold Town Hall, `runBuilderStep()` now falls through to the same live-map survey + full inner-slot probe already used for the other flexible buildings, finds wherever Town Hall actually is, and upgrades it there — instead of blocking forever on a slot that happens to hold something else. Scoped to Town Hall only; Main Building/Warehouse/Granary/Marketplace/Rally Point/Barracks/Academy/Smithy/Stable keep trusting their template slot exactly as before, since there's no evidence (yet) that any of those drift the same way.

### Added

- **`scripts/test-builder-townhall-flexible-slot.js`** (wired into `npm test`): verifies Town Hall (in any case/spacing form) is now flexible, the seven pre-existing flexible buildings are unaffected, and the nine buildings with a genuinely fixed template slot (Main Building, Warehouse, Granary, Marketplace, Rally Point, Barracks, Academy, Smithy, Stable) are correctly left alone by this fix. 3/3 passed.

### Verification

3/3 new test cases passed. `node --check` passes on `villageBuilder.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end (all 12 test scripts).

## [1.8.118] — 2026-09-20

### Changed

- **Muted the per-step `[Builder Loop]`/`[Builder Manual]` catch-up log spam introduced by the v1.8.115 budget raise.** Reported live: a `[Builder Manual]` run showed ~10 consecutive `already_satisfied: ... Advancing. Retrying next step...` lines (Clay Pit, Iron Mine ×4, Cropland ×5, all "already at level 10 (target: 5)"). Direct request: *"we dont want to see all of that in our terminal output, the already satisfied is a background check and we can mute it for now. show the steps once they are implemented in village builds."*

  Raising the follow-up retry budget from 20/120s to 200/240s (v1.8.115) fixed villages exhausting their catch-up budget before reaching real work, but it also meant a single tick could legitimately walk through far more no-op catch-up steps than before — and every one of them was logged individually, drowning out the terminal in lines representing zero real build activity.

  Both follow-up while-loops (the auto RR loop and the manual `[2]`/`[3]` handler) now distinguish "pure background housekeeping, nothing clicked" from "a real, alternate build click landed": `already_satisfied`, `skipped_wrong_building_type`, `skipped_village_full`, and `template_complete` are counted instead of logged per-step, then summarized once the loop ends with a single `Caught up N already-satisfied step(s) for <village> (no build needed).` line — only printed when N > 0, so a fully quiet catch-up (nothing to skip) prints nothing at all. `realigned_template`, `storage_relief`, and `prerequisite_relief` still log every step, since each represents a genuine alternate build click actually landing, matching the user's own distinction ("show the steps once they are implemented"). A real `success` build step already logs on its own via `logSuccess`, unaffected by this change — that's the "steps ... implemented in village builds" line the user asked to keep seeing.

### Added

- **`scripts/test-builder-followup-logging.js`** (wired into `npm test`): verifies the four background statuses are muted per-iteration, the three real-click statuses still log per-iteration, a run of only muted statuses produces exactly one summary line with the correct count, a run with zero muted statuses prints no summary line at all, and a mixed run logs real steps inline while still appending exactly one trailing summary for the muted ones. 5/5 passed.

### Verification

5/5 new test cases passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end (all 11 test scripts).

## [1.8.117] — 2026-09-20

### Added

- **`[E]` Exclude all in the Builder RR Exclusion menu** (terminal menu Settings → `[X]`), alongside the existing `[A]` Clear all exclusions. Direct request: "we should also have an option to exclude all!" Sets every currently-listed village as excluded from Builder Round Robin in one action instead of toggling each one individually — useful before a manual building pass, then `[A]` to resume all of them together afterward.

### Verification

New `scripts/test-builder-rr-exclude-all.js` (wired into `npm test`): a normal village list ends up fully excluded, an empty village list produces an empty set without crashing, and a village with a non-numeric or missing id is skipped rather than corrupting the persisted exclusion list with a `NaN` entry. 3/3 passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.116] — 2026-09-20

### Fixed

- **`blocked_prerequisite_building` (e.g. "Iron Foundry is locked until Main Building reaches level 5... No template step manages Main Building...") now switches to village mode for the same village immediately, instead of moving to a different village and waiting for RR to eventually cycle back.** Reported live: multiple villages in a row hitting the identical block message one after another (`10-04`, `10-05`, `10-06`, `10-07`, ...), each "Switching villages (RR) due to temporary block" without ever building anything.

  v1.8.114 fixed a real bug in the interleave alternation counter, but this fresh evidence showed the deeper structural issue it was masking: a resource-plan bonus building (Iron Foundry, Sawmill, Brickyard) requiring Main Building ≥ 5 is something *only the village plan* can build — no resource template step manages Main Building at all. A village's very first resource-mode turn can hit this immediately (a brand-new village starts with Main Building at 0), and the existing response — "temporarily blocked, switch to a different village" — meant fixing it depended on RR eventually cycling back around to that same village's *next* turn, which with several new villages all hitting the identical wall could take a long time, each one burning its own "guaranteed blocked" first turn before any of them made real progress.

  The auto builder loop's follow-up handling now recognizes this exact status and, when the combined resource+village pipeline is active and the village plan still has pending work, switches `loopPlan` to `"village"` and retries `runBuilderStep` for the *same* village on the *same* tick — mirroring the existing "resource complete → continue into village" pattern already used elsewhere in this same loop. Main Building gets its next real upgrade click right then, not on some future RR turn. Falls through to the original behavior (switch to a different village) when the combined pipeline isn't active, or when the village plan is already fully complete for that village.

### Added

- **`scripts/test-builder-prerequisite-village-switch.js`** (wired into `npm test`): verifies the switch fires correctly for `blocked_prerequisite_building` under the combined pipeline, that it does *not* fire when the pipeline is inactive (original behavior preserved) or the village plan is already complete, and that an unrelated block status (`blocked_resources`) never triggers it. 4/4 passed.

### Verification

4/4 new test cases passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.115] — 2026-09-20

### Fixed

- **Builder follow-up retry budget (20 steps / 2 minutes per tick) was too low to catch up through a whole stale template, leaving ticks that built nothing.** Reported live from real terminal output: a long stream of `[Builder Loop] progress_advanced: ... already at level 10 (target: 8). Advancing. Retrying next step...` for slot after slot, then the RR loop moving on to a different village — "we get those messages but in the end nothing is built... we want to build!!!"

  Every status this follow-up loop retries on (`already_satisfied`, `realigned_template`, `skipped_wrong_building_type`, `skipped_village_full`, `template_complete`, `storage_relief`, `prerequisite_relief`) is a no-op catch-up step — it fast-forwards the tracked progress past a step whose target the live game already meets, without clicking anything. This happens whenever a village's actual state has outrun its tracked template — most commonly `BUILDER_SPEED_BUILD_ENABLED`'s one-click upgrades (which deliberately race ahead of `templates/progress.json` by design), or after a template edit. A genuine build action always exits the loop after exactly one iteration (its status isn't in the retry list), so the 20-attempt/120-second budget was *only ever* being spent on housekeeping, never on real actions — but a village needing to catch up through an entire resource template's 18 field slots (sometimes stacked across more than one stale template in the chain) could exhaust that budget purely catching up, before ever reaching a real, buildable step. The tick would then end having built nothing at all, repeating every future tick until the catch-up finally finished on its own.

  Raised to 200 steps / 4 minutes in both the auto builder loop and the manual `[2]`/`[3]` follow-up loop. Safe by construction: since a real action always stops the loop immediately, raising this budget can only let it catch up further through no-ops — it cannot cause extra real build actions to happen in one tick.

### Added

- **`scripts/test-builder-followup-budget.js`** (wired into `npm test`): reproduces the exact reported bug against the old budget (a 25-step catch-up sequence never reaches the real action with `maxFollowupAttempts=20`), confirms the new budget (200) resolves it, verifies a realistic 69-step multi-template worst case still completes, confirms a real action always stops the loop after exactly one iteration regardless of budget size, and confirms a genuinely pathological unresolved sequence still terminates (bounded, not infinite) at the new cap. 5/5 passed.

### Verification

5/5 new test cases passed, including one that reproduces the reported bug against the old value before confirming the fix. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.114] — 2026-09-20

### Fixed

- **`BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE`'s turn alternation was silently decoupled from real turns, letting brand-new villages get permanently stuck.** Reported live from real terminal output: `[Builder Loop] Iron Foundry is locked until Main Building reaches level 5 (currently 0). No template step manages Main Building, and no affordable live upgrade is available for it right now.` followed by `Switching villages (RR) due to temporary block`, repeating indefinitely across multiple brand-new villages, none of them ever reaching Main Building level 5 or any later village-stage building.

  Root cause: `resolveBuilderPlanModeForVillage()`'s interleave branch advanced `builderInterleaveLastModeByVillage` (the per-village "which mode ran last" counter) as a side effect of being *called*, not of a real turn being *taken*. But it's called from `villageHasPendingBuilderWork()`, which runs for every non-excluded non-capital village on every tick — twice over (once in the catch-up-exclude loop, once building the RR candidate list) — purely to check "does this village have pending work," regardless of whether that village is the one actually picked this tick. That flipped the alternation dozens of times per tick for villages nowhere near their real turn, turning it into noise with no real relationship to completed builds. A brand-new village's resource plan needs Main Building ≥ 5 for its Iron Foundry bonus building, but no resource-plan template step can build Main Building — only the village plan can. If the noisy counter happened to land on "resource" again and again whenever this village's *actual* turn came up, it would hit the identical immediate block every time, while "village" mode — the only thing that could fix it — never got picked for a real turn.

  Split the responsibility: new `peekBuilderInterleaveMode()` is a pure read (used everywhere a village is merely being checked — filtering, exclusion, hop-on-block), and new `commitBuilderInterleaveMode()` is the only thing allowed to advance the counter, called exactly once, at the single point the auto builder loop actually commits to and executes a build step for the chosen village this tick. Alternation now cleanly flips resource/village turn by turn, tied to real completed turns only.

### Verification

Rewrote `scripts/test-builder-interleave-resource-village.js` around the peek/commit split (7/7 passed): repeated peeks with no commit never drift (the exact bug); only `commit()` advances the state, taking effect on the next peek; the reported real-world pattern (many non-committing filter-pass peeks between real turns) still alternates cleanly turn by turn; per-village independence; and the two default-value assertions carried over from v1.8.113. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.113] — 2026-09-19

### Changed

- **`BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE` now defaults to `true`** (was opt-in `false` in v1.8.111). Explicitly confirmed: "first stage must be what we wrote. then resources and village stages should continue. we want to be able to let it work and refine villages automatically with the templates." With `BUILDER_ROUND_ROBIN_ENABLED` + `BUILDER_RR_RESOURCE_THEN_VILLAGE` both on (both already required for the combined pipeline to run at all, and both already in use for this account), Builder RR now alternates resource-field and village-stage turns by default instead of requiring an opt-in setting — matching v1.8.112's reordered `village_stage_00` (first stage exactly as requested) plus continued resource + village progression, working together automatically with no settings.json edit required on a fresh install. Set it to `false` to restore the original v1.8.110-and-earlier strict "finish resource entirely, then village" sequencing.

  **Upgrading note:** a code-level default only takes effect for a `templates/settings.json` that doesn't already have the key. Anyone who already has this file from v1.8.111/1.8.112 with the key explicitly written as `false` keeps that value until it's edited — documented in README's Troubleshooting.

### Verification

Added two more assertions to `scripts/test-builder-interleave-resource-village.js` (8/8 now): the login.js default-resolution expression resolves to `true` when unset, and `templates/settings.example.json` ships the matching default. `node --check` passes on `login.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.112] — 2026-09-19

### Changed

- **`templates/village_stage_00.json` (the default first village-stage template every new village starts on) reordered per explicit request**: "every basic village should start with main building to level 3, warehouse and granary to level 1, marketplace level 1, main building level 5, warehouse and granary to level 2." The template's early stages are now, in order: Main Building → 3, Warehouse → 1, Granary → 1, **Marketplace → 1** (new — Marketplace previously wasn't touched until `village_stage_01`), Main Building → 5, Warehouse → 2, Granary → 2. The template's original higher checkpoints (Main Building → 10 → 15 → 20, Warehouse → 3, Granary → 3) are preserved afterward, unchanged — this reorders/adds early checkpoints, it does not cap or regress the template's eventual targets. Chain integrity unchanged: `village_stage_00` still hands off to `village_stage_01` (whose own first stage, Marketplace → 1, is now a harmless no-op the first time it runs, since stage_00 already got there).

  **Only affects new/fresh villages automatically.** A village already partway through the *old* `village_stage_00` has its position stored as a numeric `stage_index`/`step_index` in `templates/progress.json`, which isn't re-derived from live building levels when a template's content changes — only when the index is out of range entirely. Re-assign such a village to `village_stage_00` via terminal menu **`[B]` Builder Templates** to reset its progress pointer and pick up the new order cleanly (safe mid-progress: every step is `build_or_upgrade` to a target level, so an already-met target is a no-op).

### Added

- **`scripts/test-village-stage-00-template.js`** (wired into `npm test`): loads the real `templates/village_stage_00.json` through the actual `villageBuilder` module (not a re-implementation) and verifies the full step order matches the requested sequence with the original higher targets preserved, every step uses the correct building slot (26/19/24/33), chain integrity (`default_template`/`next_template`) is unchanged, and `previewPlan()` confirms Main Building → 3 as the first step for a completely fresh village.

### Verification

4/4 new test assertions passed against the real `villageBuilder` module (not a mock). `node --check` unaffected (JSON-only change plus a new test script). Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.111] — 2026-09-19

### Added

- **New opt-in `BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE` setting: alternate resource-field and village-stage builder turns instead of finishing resource entirely first.** Reported: "We do have templates for basic village stages but once we run the bot automatically it doesn't go through them. It only upgrades basic resources... is there a way to enhance our building algorithm so templates of buildings and resources will go together when villages are built?"

  The default `BUILDER_RR_RESOURCE_THEN_VILLAGE` pipeline is strictly sequential: a village's resource-fields plan (all 18 basic fields + bonus buildings) has to reach 100% complete before a single village-stage step (Warehouse, Granary, Main Building, ...) ever runs — which can be a long stretch with no capacity/build-speed support from those buildings along the way. Turning on `BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE` (off by default; every existing install is unaffected unless this is set) makes each Builder RR turn alternate between one resource step and one village step instead, for any village where both plans still have pending work — so both templates progress together per village, the "go together" the report asked for, rather than one strictly gating the other. Once either plan finishes, the other runs every turn as normal (no pointless alternating against a plan with nothing left to do). Manual `[2]`/`[3]` keys are completely unaffected either way — they already run whichever mode is pressed (v1.8.109).

- **`scripts/test-builder-interleave-resource-village.js`** (wired into `npm test`): verifies the alternation decision — off keeps the original resource-first-always behavior, on alternates turn by turn, either plan finishing stops the alternation and runs the other every turn, both complete reports nothing to do regardless of the setting, and alternation state is tracked independently per village (one village's turn count can't affect another's). 6/6 passed.

### Verification

6/6 new test cases passed. `node --check` passes on `login.js` and `terminalMenu.js`. Cross-checked `BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE` is both read via `process.env.X` in `login.js` and present in `templates/settings.example.json` (98 keys total now). Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.110] — 2026-09-18

### Fixed

- **Builder Round Robin never built anything for single-village accounts, logging `[Builder Loop] No non-capital villages available for template auto-build. Skipping.` forever.** Reported: "resources arent built for some reason." Root cause: Builder RR deliberately excludes the capital from its candidate pool — it's meant for round-robining newer off-villages while the capital is developed manually (`[2]`/`[3]`) or via the separate non-RR builder loop. That's a reasonable design for an account with multiple villages, but it left any account with **only its capital** (the normal state right after a fresh server start, before the first settlement) with zero RR candidates ever, tick after tick, with nothing ever getting built despite `BUILDER_LOOP_ENABLED`/`BUILDER_ROUND_ROBIN_ENABLED` both being on.

  RR now falls back to including the capital in its own candidate pool, but *only* when it's genuinely the sole village on the account — any account with at least one real off-village keeps the original capital-excluded behavior completely unchanged. Logs once when the fallback kicks in (`Only the capital village exists — Round Robin will build it directly...`) so it's visible rather than a silent behavior change. Also removed the now-unreachable "no non-capital villages" branch this fallback made dead code (the warning could only ever fire when the account had zero villages at all, a different, already-logged-elsewhere condition).

### Added

- **`scripts/test-builder-rr-capital-fallback.js`** (wired into `npm test`): verifies the fallback decision against synthetic village lists — a capital-only account falls back correctly, a multi-village account is unaffected, a single off-village (plus capital) doesn't trigger the fallback, and an empty village list never falsely triggers it. 4/4 passed.

### Verification

4/4 new test cases passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep — still 0 candidates. `npm test` passes end-to-end.

## [1.8.109] — 2026-09-17

### Fixed

- **Manual `[2]` Village Stage Builder silently ran resource-field steps instead, on any village whose resource plan wasn't fully complete yet.** Reported: "One village stage builder step — it didn't work so well, only resource field templates were upgrading." Root cause: the fix in 1.8.53 (`resolveBuilderPlanModeForVillage()`) was written to solve one specific conflict — pressing `[3]` (resource) on a village pinned to a standalone *village* template via `[B]` used to start a brand-new competing `resource_fields_01` plan alongside it. The fix that landed made manual `[2]`/`[3]` defer *entirely* to the same resolver the auto Round Robin loop uses for "resource before village" sequencing — which, under the shipped default combo (`BUILDER_DEFAULT_PLAN_MODE=resource` + `BUILDER_RR_RESOURCE_THEN_VILLAGE=true`), meant it always returned "resource" for any village not yet resource-complete, regardless of which key was actually pressed. `[2]` effectively stopped existing as a way to force a village-stage step early, for the common case of any village still mid-resource-fields.

  New `resolveBuilderPlanModeForManualKey(village, requestedPlanMode)` keeps the original conflict protection (a village pinned to a standalone template outside either default chain still wins, logged explicitly when it overrides the keypress) but otherwise honors whichever key was actually pressed for that one step — running it if there's pending work in that mode, or reporting "nothing to do" if there genuinely isn't, instead of silently substituting the other mode. Applied to both the initial manual pick and the Round-Robin "hop to next village on a temporary block" path, which had the same bug.

### Added

- **`scripts/test-builder-manual-key-resolution.js`** (wired into `npm test`): verifies the new resolver against fake builder/settings collaborators — the exact reported bug (pressing `[2]` with resource incomplete now returns "village"), `[3]` unaffected, the pinned-standalone-template protection still overriding the keypress, a completed pinned template and a completed requested mode both reporting "nothing to do" rather than substituting, and the no-village-selected fallback. 6/6 passed.

### Verification

6/6 new test cases passed. `node --check` passes on `terminalMenu.js`. Re-ran the whole-repo dead-code sweep (see 1.8.108) after this change — still 0 candidates. `npm test` passes end-to-end.

## [1.8.108] — 2026-09-17

### Fixed

- **Raid Evacuation (and anything else gated on `village.underAttack`) could miss a real incoming attack entirely, depending on how the village list marks it.** Following a live incident where a village's entire defending garrison was wiped in a battle report with zero `[Raid Evacuation]` activity around it, found a real gap: the `#vlist` under-attack detection only checked for an `under-attack` row class, an `.attack-glow` element, or an `img.att1` icon — a fourth, real signal some themes/markup use instead (`title="Under Attack!"` on the row's link) was never checked, even though a dead, never-wired-in helper function (`readUnderAttackVillageIds()`, removed in this same change) already implemented exactly that check independently. Merged the missing `a[title*='Under Attack']` signal into the actual detection used by `refreshVillageState()` — purely additive (one more `||` condition), so it can only catch more real attacks than before, never fewer.

### Removed

- **Dead code cleanup**, found via a whole-repo cross-reference sweep (every top-level function/const-arrow checked for zero real uses anywhere in the codebase) rather than guesswork: 12 unused functions removed across `terminalMenu.js`, `villageBuilder.js`, `villageExpansion.js`, and `public/app.js` — abandoned/superseded helpers (an old manual settlement-target prompt, a whole unused manual rally-point settlement-dispatch flow, thin wrappers left behind by earlier refactors, etc.). No behavior change for anything still in use; re-ran the same sweep after removal and confirmed no new dead code was exposed by the cuts.

### Added

- **`scripts/test-under-attack-detection.js`** (wired into `npm test`): verifies the exact under-attack boolean expression now shipped in `terminalMenu.js` against a real page via Playwright — all four individual signals (row class, `.attack-glow`, `img.att1`, the new `a[title*='Under Attack']`), a row with no signal at all, and a row with an unrelated `title` attribute that must not false-positive. Skips cleanly (not a failure) if Chromium isn't installed yet, since this needs a real browser the same way the bot itself does.

### Verification

6/6 cases passed for the under-attack detection fix (see the new test above). Re-ran the dead-code sweep after every removal — 0 candidates left, and no new ones appeared as a result of the cuts (no cascading dead helpers). `node --check` passes on every `.js` file in the repo. `npm test` passes end-to-end.

## [1.8.107] — 2026-09-17

### Added

- **`scripts/termux-fetch-debug.sh` (`npm run termux:fetch-debug`): pulls the newest login-failure screenshot + diagnostics log out of the Termux `proot-distro` chroot automatically.** `debug/` already lives exactly where it should — inside the project, next to `login.js` — but because the bot runs inside a proot chroot at `/root/nexian-dani`, Android's own file tools (Files app, Gallery, share sheets) can't see into that folder at all; a plain Termux-side `find` can't locate it either, since proot intercepts filesystem syscalls to present that chroot view rather than exposing it as an ordinary subdirectory. Getting a single file out previously took several hand-typed multi-line commands (list the chroot's debug folder, base64-encode the target file through `proot-distro login`, decode it back into a real file in shared storage) — easy to get wrong mid-troubleshooting, which is exactly what happened over several rounds of a live investigation this session.

  The new script does the whole round trip in one command: finds the newest `login-failure-*.png`/`.log` pair inside the chroot, pipes both out through a running `proot-distro login` process's own stdout (sidestepping the chroot visibility problem entirely, with no need to know proot-distro's exact on-disk mount layout, which can vary by device/version), and writes them to `~/storage/downloads/nexian-debug/` — a normal Android folder any file manager or share sheet can reach.

- **Documented `xvfb-run` as an alternative to `termux-x11` for `--headed` on Termux.** A live investigation found headed logins working reliably across every environment tried (Windows, Termux/proot) while headless logins hit the same failure every time — `xvfb-run` gives Chromium a virtual display with no real screen or `termux-x11` setup needed, letting `--headed` run invisibly/unattended the same way headless normally would.

### Verification

Verified the stamp-extraction and empty/missing-file guard logic from `termux-fetch-debug.sh` in isolation against simulated `ls -t` output (multi-line real match, and empty-input cases) — both passed. `bash -n` passes on the script.

## [1.8.106] — 2026-09-17

### Added

- **Login failure diagnostics now include console errors, failed requests, and bad HTTP responses — not just a screenshot.** Chasing a headless-only login timeout (`waiting for locator('input[placeholder="Enter your username"]') to be visible`, landing on `https://nexian.world/?journey=true`) across two completely unrelated environments (Windows headless, Termux/proot-distro on Android) turned up a real screenshot: the page rendering with none of its CSS/layout applied at all — content collapsed into a narrow unstyled column against a mostly-empty canvas, exactly what a modern page looks like when its stylesheet or a runtime styling script fails. Disabling `BLOCK_MEDIA` (the prime suspect, since it withholds font/image downloads) made no difference, ruling that out — but a screenshot alone can't say *why* a page rendered broken, only *that* it did.

  `login.js` now records every `console` message, uncaught `pageerror`, `requestfailed` event, and non-OK (4xx/5xx) `response` for the page's whole lifetime (capped at 200 entries each), and dumps them to a new `debug/login-failure-<timestamp>.log` alongside the existing `.png` screenshot on any login failure. This should make the *next* occurrence of this bug (or any future one) diagnosable from one pair of files instead of another multi-day back-and-forth over screenshots and DOM snippets.

### Verification

Verified end-to-end against a real Playwright browser (not a re-implementation): launched real headless Chromium against a local HTTP fixture serving an intentional uncaught JS error, a missing stylesheet (404), and a missing script (404), using the exact `attachPageDiagnosticsRecorder()` logic now shipped in `login.js`. Confirmed all four categories were captured correctly: the console error and page error messages, both 404s as non-OK responses, and both as failed/aborted requests. `node --check` passes on `login.js`.

## [1.8.105] — 2026-09-12

### Fixed

- **The stale `NEXIAN_URL` problem from v1.8.104 is now fixed automatically instead of just logged.** A second live report hit the exact same login timeout (`https://nexian.world/?journey=true`, waiting on `input[placeholder="Enter your username"]`) even after v1.8.104 shipped its diagnostic log line — the underlying leftover `NEXIAN_URL=https://nexian.world/` line in `.env` was still there; a log line alone still depends on someone reading it, finding the right `.env` file (this session's recurring problem), and editing it correctly.

  `login.js` now recognizes this one specific value — the exact literal bare-portal URL the since-fixed v1.8.101 bug used to silently inject, with or without a trailing slash, case-insensitively — and ignores it outright, falling back to the `GAME_HOST`-based smart login URL on its own. There is no real scenario where a user genuinely wants exactly this value on purpose: it is strictly worse than the smart URL it would otherwise replace (it skips straight to the fragile "Play Now" + realm-card click-through instead of opening the login modal pre-targeted at the right realm). The fix now takes effect on the very next run with zero `.env` editing required. A startup log still explains what happened: `Ignoring NEXIAN_URL=... in .env — this is the exact bare-portal value a since-fixed auto-repair bug (v1.8.101) used to silently inject...`. A genuinely custom `NEXIAN_URL` (anything other than this exact bare value) is completely unaffected and still overrides `GAME_HOST` exactly as before.

### Verification

Verified the URL-selection logic in isolation (6/6 cases): bare value with/without trailing slash and mixed case all fall through to the `GAME_HOST`-based smart URL; a genuinely custom `NEXIAN_URL` (e.g. `.../?login=1&world=s5`) is preserved untouched; no override falls through to the smart URL or the bare `?setlang=en` fallback exactly as before. `node --check` passes on `login.js`.

## [1.8.104] — 2026-09-12

### Added

- **Startup now calls out an active `NEXIAN_URL` override by name.** A user hit a login timeout (`locator.waitFor: Timeout 30000ms exceeded` waiting for `input[placeholder="Enter your username"]`, failure URL `https://nexian.world/?journey=true`) that traced back to the startup log printing `Opening https://nexian.world/ ...` — the bare portal URL, with none of the `?login=1&world=<realm>&setlang=en` query params `LOGIN_URL` normally builds from `GAME_HOST`. The only way to get that exact bare URL is an active `NEXIAN_URL=https://nexian.world/` line in `.env`, silently outranking `GAME_HOST` (as documented, but easy to forget is even present) — almost certainly a leftover from the `upsertEnvKeys()` bug fixed in v1.8.101, which is not auto-removed by anything (deliberately: `NEXIAN_URL` remains a valid, intentional override for anyone who explicitly wants it, per v1.8.103). Without the smart URL's params, login depends entirely on `openNexianPortalLoginForm()`'s "Play Now" + realm-card fallback chain succeeding against the portal's current front-end, which is more fragile and was exactly what timed out here.

  Added a one-line startup log — `Using NEXIAN_URL override: <value> (ignoring the GAME_HOST-based smart login URL). If that's not intentional, remove the NEXIAN_URL line from .env.` — printed whenever `NEXIAN_URL` is set at all, so this no longer requires opening `.env` blind or asking for a diagnostic dump to notice. No behavior change — `NEXIAN_URL` still overrides `GAME_HOST` exactly as before when genuinely intended.

### Verification

`node --check` passes on `login.js`. Confirmed by inspection that the new log line fires only when `process.env.NEXIAN_URL` is truthy (matching `LOGIN_URL`'s own existing precedence check) and does not otherwise change `LOGIN_URL`'s value or control flow.

## [1.8.103] — 2026-09-12

### Changed

- **`.env` now holds ONLY `NEXIAN_USERNAME`, `NEXIAN_PASSWORD`, and `GAME_HOST` — every other setting moved to `templates/settings.json`.** Context: this session's `.env`-related bugs (v1.8.99–v1.8.102) were all real and all fixed, yet a user still couldn't get a stable login — the actual root cause turned out to be multiple `.env` files / project folders on their machine, with edits repeatedly landing in a copy that wasn't the one `npm run login` actually reads. A ~90-line file makes that kind of mistake very easy to miss; a 3-line file makes it obvious at a glance. Explicit ask: *"split most of the settings from this place and leave only username password and server address."*

  - `.env.example` trimmed from ~90 lines to just the three identity/realm keys plus a commented, opt-in `NEXIAN_URL` (unchanged advanced override — still off by default).
  - New `templates/settings.example.json` (tracked) ships every other setting's default value as flat JSON (loops, thresholds, proxy, dashboard, builder, trainer, cranny, celebrations, raid evacuation, resource circulation/overflow, NPC crop convert, top10 tracking, activity simulation, logging — 97 keys total). New `templates/settings.json` (gitignored, per-machine) is auto-created from it on first run, same pattern `.env` already used for `.env.example`.
  - `login.js` loads `.env` first (as before, `override: true`), then merges `templates/settings.json` into `process.env` for any key `.env` didn't already set — so every existing `process.env.KEY` / `numberEnv("KEY", ...)` read elsewhere keeps working completely unchanged, regardless of which of the two files a value actually came from.
  - The terminal Settings menu and web dashboard now persist changes to `templates/settings.json` (`persistJsonSettings()`) instead of rewriting `.env` (`persistEnvValues()`, removed). `.env` is never written to except for its three identity/realm keys.
  - If `templates/settings.json` is missing or contains invalid JSON, the bot logs a warning, falls back to built-in defaults for every setting, and **still logs in** — a broken settings file can no longer block login the way a broken `.env` used to.
  - `export.js` excludes `templates/settings.json` from exported zips (same treatment as `templates/progress.json` / `troop_plans.json` / `proxy_list.json`), and `.gitignore` updated to match.
  - **Not automatically migrated:** if you had custom values in an older `.env`, copy them into `templates/settings.json` by hand (as JSON: `"BUILDER_LOOP_ENABLED": true`, not `BUILDER_LOOP_ENABLED=true`) or re-set them via the terminal Settings menu — see README's Troubleshooting section.
  - `NEXIAN_URL` remains intentionally outside both auto-managed scaffolds (it was the biggest single source of "GAME_HOST change had no effect" reports in v1.8.101) — it still works as a manual, undocumented-by-default override in `.env` for anyone who explicitly adds it back.

### Verification

Cross-checked every `process.env.X` / `numberEnv("X", ...)` read site in `login.js` (extracted via script) against `templates/settings.example.json`'s 97 keys: no setting that's supposed to have a shipped default is missing from the template; the handful of keys read but intentionally left out (`FARMLIST_VILLAGE_ID`, `TOP10_TRACKING_PLAYER_NAME`, `TROOP_STABLE_TRAINER_URL`, `VILLAGE_SWITCH_DELAY_MS`, URL/selector overrides) are the same ones that were commented-out/blank optional overrides in the old `.env.example`, not active defaults. Verified `templates/settings.example.json` parses as valid JSON. Verified `ensureSettingsJsonFile()` / `loadJsonSettingsIntoEnv()` / `persistJsonSettings()` in isolation (`scripts/test-settings-json.js`, run via `npm test`): first-run copy from the example template, missing-template fallback to `{}`, `.env`-set keys always win over JSON keys, corrupt JSON degrades to a warning + defaults instead of crashing, and `persistJsonSettings()` merges into (rather than replacing) an existing file and survives a pre-existing corrupt file. `node --check` passes on `login.js` and `export.js`.

## [1.8.102] — 2026-09-12

### Fixed

- **`.env` edits could silently have no effect at all if the same-named variable already existed in the shell/OS environment.** Follow-up on v1.8.101's `NEXIAN_URL` fix: a user fixed that issue, confirmed `GAME_HOST=https://test.nexian.world/` in `.env`, and the bot *still* targeted realm `s2` — with no `NEXIAN_URL` override left in the file this time. Root cause: `dotenv.config()` was called without `override: true`, which is dotenv's default, safety-first behavior — it never overwrites a `process.env` value that already exists by the time it runs. If `GAME_HOST` (or any other key) was ever set directly in that terminal session or the wider Windows environment (a leftover `set GAME_HOST=...` from earlier testing, System/User environment variables, etc.), that value would silently and permanently out-rank `.env` — no error, no warning, `.env` just appears to do nothing for that one key, however many times it's edited.

  Added `override: true` to the `dotenv.config()` call. `.env` is meant to be the single source of truth for this tool (the terminal menu itself writes settings back into it), so it should always win. Verified directly against the real `dotenv` package: a `GAME_HOST` pre-set in `process.env` (simulating the stray-shell-variable scenario) is now correctly overridden by `.env`'s value.

  **If you're still seeing a stale value after pulling this**, one more thing to rule out: close every open terminal window running this project and open a fresh one — a `set VAR=...` from an earlier session only lives for that one window, and won't go away until the window itself is closed.

## [1.8.101] — 2026-09-12

### Fixed

- **Found a real bug while chasing the "GAME_HOST change doesn't seem to take effect" report: `.env`'s auto-repair could silently force the bare portal URL forever.** `ensureEnvFile()` backfills a few required keys (`NEXIAN_URL`, `NEXIAN_USERNAME`, `NEXIAN_PASSWORD`) into `.env` on every run if they're missing — but its "is this key already present" check only matched an *active* `KEY=value` line, not a commented-out one. `.env.example` deliberately ships `NEXIAN_URL` commented out (so `GAME_HOST`'s smarter, realm-specific login URL gets used instead) — but that commented line was invisible to the check, so on literally the first run, an **active** `NEXIAN_URL=https://nexian.world/` got silently appended to the file. From then on, every future run used that forced bare-portal URL instead of the realm-specific one (`LOGIN_URL` prefers `NEXIAN_URL` whenever it's set at all) — so changing `GAME_HOST` afterward had no visible effect on which realm got targeted. Fixed the regex to also recognize the commented form as "already present," so it's left alone. **If your `.env` already picked up a stray active `NEXIAN_URL=https://nexian.world/` line from a prior run, comment it out or delete it** to let `GAME_HOST` drive the login URL again.

### Added

- **Hardened first run: `npm run login` now installs the Chromium browser itself if it's missing**, instead of requiring the separate `npm run setup:pc` step to have been run first (or failing with a raw Playwright "Executable doesn't exist ... npx playwright install" error). Applies to both headless and headed launches; headless additionally still tries a system Chrome install first, only auto-installing Playwright's own Chromium if that also isn't available.
- **A missing `node_modules` (never ran `npm install`) now fails with a clear, actionable message** (`Missing dependencies ... Run npm install`) instead of Node's raw "Cannot find module 'playwright'".
- `.env.termux.example` removed from the repo (was a phone-tuned template for the now-deprioritized Termux path). Termux setups (`scripts/termux-proot-setup.sh`) now fall back to the generic `.env.example` when creating `.env.termux`, matching the fallback `login.js` itself already used — no functional break, Termux users just get generic loop intervals instead of phone-tuned ones going forward.

### Verification

Re-implemented and verified both fixes against the exact shipped logic: the `upsertEnvKeys` regex against active/commented/absent/indented/false-positive cases (5/5 passed), and the headless-launch auto-install control flow against mocked launch/install functions covering the missing-binary-install-succeeds, install-fails-falls-back-to-headed, and non-missing-binary-error-skips-install-entirely cases (9/9 passed). `node --check` passes on `login.js` and `export.js`; `bash -n` passes on `scripts/termux-proot-setup.sh`.

## [1.8.100] — 2026-09-12

### Changed

- **Clarified GAME_HOST guidance after a real support case: wrong realm configured ("s2" vs. the account's actual "test" server) produced a confusing `Login did not reach the game after Enter Realm` failure.** Worth being explicit about what already exists vs. what changed here:

  - `login.js` already auto-creates `.env` if it's missing at all (`ensureEnvFile()`, runs before every login attempt) — from `.env.example` when present, or a built-in minimal fallback otherwise — and already refuses to even attempt a login with placeholder `NEXIAN_USERNAME`/`NEXIAN_PASSWORD`, exiting with a clear message instead of failing deep inside browser automation. That part was not broken.
  - What **was** missing: nothing validates or explains `GAME_HOST` the same way, and a wrong-but-syntactically-valid realm (any `s<N>` or a named realm like `test`) can't be auto-detected — only the account owner knows which realm their villages are actually on. Added a "how to find your real realm" tip to `GAME_HOST`'s comment in `.env.example`/`.env.termux.example` (log in manually once, read it off the address bar once you're actually in the game, not the portal), and added the same tip as a commented-out `GAME_HOST` line to `ensureEnvFile()`'s minimal last-resort fallback (used only when both `.env` and `.env.example` are missing) — left commented out so it doesn't override the working "unset → smart portal default" behavior for anyone who doesn't need it.

  Verified the updated minimal-fallback content still parses cleanly and `GAME_HOST` stays unset (not silently forced to an invalid placeholder) when left commented.

## [1.8.99] — 2026-09-12

### Fixed

- **`npm run export` never included `.env.example`, leaving every exported zip with no way to create a `.env` from.** Reported: a user working entirely from an exported zip (not a `git clone`) had no `.env.example` to copy at all after unzipping — first-run setup was stuck before it could even start. Root cause: `export.js`'s exclusion rule for real per-machine env files, `name.startsWith(".env.")`, also matched `.env.example` and `.env.termux.example` — the exact opposite of what should happen, since those `.example` files are the credential-free templates a fresh machine is *supposed* to copy from. They were being stripped out of every export alongside real secrets like `.env.nexian`.

  Fixed the exclusion to keep anything ending in `.example` while still excluding real overrides (`.env.nexian`, `.env.local`, etc.) and the bare `.env` (unchanged, still excluded). Verified against the exact filenames involved: `.env`/`.env.nexian`/`.env.local` still excluded, `.env.example`/`.env.termux.example` now included.

  If you're working from a zip exported before this fix and don't have `.env.example`: grab it from the repo directly (`https://github.com/surgeon13/nexian-dani/blob/main/.env.example`) or re-export with `npm run export` after pulling this update.

## [1.8.98] — 2026-09-06

### Changed

- **New Cranny placements now prefer slot 34.** Requested slot for Cranny defense builds. `runCrannyDefenseStep()` previously placed a new Cranny on whichever empty, Cranny-buildable inner slot had the lowest slot id. It now prefers slot 34 specifically when it's empty and buildable there, falling back to the previous lowest-id behavior otherwise (e.g. something else already occupies 34, or a village's layout doesn't allow a Cranny there) — never hard-fails just because the preferred slot isn't available.

  Only affects **new** Cranny placements going forward — an already-built Cranny sitting on a different slot is not relocated (the bot doesn't demolish/move existing buildings). Cranny *upgrades* (stacking existing crannies below level 10) are unaffected either way; this only changes where a brand-new one gets placed.

## [1.8.97] — 2026-09-06

### Added

- **New: Speed Build — one-click resource-field upgrades via the in-game "Upgrade mode" toggle.** Requested for x1000-speed servers: "we should be able to use a toggle in our settings to set the speed build setting. then auto-change village that is built to this mode and keep on working according to plans." Nexian's `village1.php` has an "Upgrade mode" toggle (`<a class="build-mode-toggle" href="village1.php?bmode=0">`) that, when on, turns each resource field into a one-click upgrade handled by the page's own Alpine.js + background AJAX — no navigation into `build.php`, no page reload.

  New opt-in setting `BUILDER_SPEED_BUILD_ENABLED` (default off — unverified against a live game from this dev environment, see below). When on: before the classic per-building flow runs each Builder Loop tick, a new fast-path pass (`runSpeedBuildQuickPass()`) navigates to `village1.php`, auto-enables Upgrade mode for that village if it's off, and clicks through up to 6 resource-field slots (1–18) the village's *currently active template* actually targets — skipping any already at/above target level, stopping early if the game reports an error (insufficient resources, storage full, etc.). Togglable live: terminal menu → Settings → **[SB]**.

  Deliberately **never touches `templates/progress.json` or any step/stage tracking** — it only fires real upgrade clicks (the identical action a human clicking that button performs). `runBuilderStep()` already re-reads live page state before deciding what to do next, so it simply sees the higher level on its next pass and proceeds normally, exactly as if a human had clicked ahead of it. This means the fast path can only add extra upgrades, never desync the classic flow's own tracking, because that tracking is never written here.

  **Scope for this release: resource fields only** (slots 1–18, `village1.php`'s hex-map layout). Inner buildings — Warehouse, Granary, Sawmill, Brickyard, Iron Foundry, Main Building, Barracks, etc. (slots 19–40, on `village2.php`) — are not yet covered; those still go through the classic flow unchanged. Extending this to inner buildings is planned as a follow-up once their `village2.php` markup (with Upgrade mode on) is available to verify against.

  **Verification:** this sandbox can't reach a live game (confirmed earlier this project), so `runSpeedBuildQuickPass()` was verified end-to-end against a real Chromium page via Playwright, with `village1.php` navigation intercepted and served from a fixture reproducing `window.__v1Boot.payload` (the page's own embedded state) and the `<map name="rx">` field grid — exercising the actual shipped function, not a re-implementation. Covered: auto-enabling Upgrade mode when off, clicking distinct fields up to the configured cap, skipping fields already at/above the active template's target level, doing nothing at all for a "village"-mode plan (no field steps, no navigation even attempted), and stopping cleanly (without over-counting) the moment the game reports an error after a click. All scenarios passed. This is **new, real-account-unverified territory** despite that — please report back what you see running it live, same as every other fix this project.

## [1.8.96] — 2026-09-05

### Fixed

- **Village-stage buildings (Warehouse, Granary, Main Building, ...) never got built — the resource→village pipeline was silently dead on arrival.** Reported: "why isnt our bot building villages? we want our village buildings to be built as well, warehouse, granary and all that." Root cause: two settings that both default to `true` — `BUILDER_RR_RESOURCE_THEN_VILLAGE` ("after resource fields are done, continue automatically into the village-stage plan") and `BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE` ("once a village's resource plan is done, take it out of Round Robin") — were checked in the wrong order in both places that decide a village's next plan (`resolveBuilderPlanModeForVillage` and the in-tick "resource just finished" follow-up). Auto-exclude was checked *first* and won unconditionally whenever it was on, so under the shipped default combination (both `true`), a village's resource-fields chain finishing immediately excluded it from Round Robin — the "continue to village stage" branch right below it was dead code, never reached. Warehouse, Granary, and every other village-stage building never got a chance to build, on any village, ever, under default settings.

  Swapped the priority: continuing into the village-stage plan (when the pipeline is active and village-stage isn't complete yet) now wins over auto-exclude. Auto-exclude still does its job once there's genuinely nothing left (both resource and village-stage complete), and keeps its original, narrower meaning — "resource-only, no village follow-up" — for anyone who explicitly sets `BUILDER_RR_RESOURCE_THEN_VILLAGE=false`.

  **If you were already hit by this**, any village that logged `[Builder Loop] ... Resource fields complete ... — excluded from Builder RR` before this fix is sitting in `BUILDER_RR_EXCLUDED_VILLAGE_IDS` and will stay excluded even after upgrading — this fix only prevents it from happening to villages going forward. Check terminal menu → Settings → **[X] Builder RR Exclusion** and remove any village that should still be working on its village-stage plan.

## [1.8.95] — 2026-09-05

### Changed

- **Sawmill/Brickyard/Iron Foundry now placed at slots 30/29/25 instead of 31/27/23.** Requested slot placement change for all future villages. Updated `templates/resource_fields_03.json` (initial placement + upgrade-to-3 stages) and `templates/resource_fields_04.json` (upgrade-to-5 stage), including both templates' `end_state` slot checks. `villageBuilder.js` itself never hardcodes these slot numbers — it resolves a bonus building's slot from the template JSON and by name (`findTemplateSlotForBuilding`, `isBonusBuildingName`), so no code changes were needed, only the two template files.

  Note: this only changes where **new** placements go — an already-built Sawmill/Brickyard/Iron Foundry in a village that already passed this stage on the old slots is not relocated (the bot doesn't demolish/move existing buildings). It applies to any village that reaches this stage from here on, including all future new villages.

## [1.8.94] — 2026-09-05

### Changed

- **Trainer building resolution now gives up in 20s instead of 90s.** Follow-up on v1.8.92's fix: live logs showed `[Troop Auto] Great Stable not found via map/cache — probing inner building slots...` recurring on essentially every training cycle for that branch (every 2-3 minutes, per that village's plan interval) while Builder Loop queued behind it. The 90s budget added in v1.8.92 already made this bounded and visible instead of silently indefinite, but a branch that isn't going to resolve was still holding the shared action lock for up to 90s on *every single cycle*. Per direct ask ("if not found, move on!"), lowered `TRAINER_RESOLVE_BUDGET_MS` to 20s — still enough room for the map-candidates/configured-URL/cache fallbacks plus a meaningful chunk of the up-to-22-slot probe, but gives the lock back to Builder Loop / dashboard commands much sooner on a cycle that was never going to find the building anyway. If a specific branch's building is confirmed present on the village map but this keeps recurring for it, that points at a detection bug for that building type specifically — worth reporting with the real village-map markup for that building so it can be root-caused rather than just budgeted around.

## [1.8.93] — 2026-09-05

### Changed

- **Loop intervals can now go below 6 seconds, for very fast (e.g. x1000) speed servers.** Asked: on a x1000-speed server, building/training finishes in a few seconds, and every loop (Builder, Farmlist, Troop RR, Cranny, NPC Crop Convert, Overflow Guard, Celebrations, Activity Sim) shared one hardcoded floor of `0.1` minutes (6s) — meant only as a guard against a `0`/misconfigured interval, not as a deliberate speed limit, but it left real idle time on the table on a server where 6 seconds can be most of a build.

  Lowered the shared `MIN_LOOP_MINUTES` floor to `1/60` (1 second) in both `login.js` and `terminalMenu.js` — still a real floor (a `0`/negative misconfig still gets clamped up, and every tick costs at least one real page navigation regardless), just 6x lower, so e.g. `BUILDER_LOOP_MIN_MINUTES=0.02` (~1.2s) is now honored instead of being silently raised to 6s. Also switched every affected loop's "Next run in..." log line (Builder, Farmlist, Cranny, NPC Crop Convert, Overflow Guard, Celebrations, Activity Sim) from raw `X minute(s)` text to the existing `formatDelayMs()` helper, so a sub-minute interval prints as a clean `"2s"`/`"1m 30s"` instead of a raw float like `"0.016666666666666666 minute(s)"`.

  The per-action random human-like delay (`RANDOM_DELAY_MIN_MS`/`RANDOM_DELAY_MAX_MS`) was already uncapped and configurable down to `0` — no change needed there, just worth knowing it's the other lever for a very fast server.

## [1.8.92] — 2026-09-05

### Fixed

- **Troop Auto could look permanently stuck between branches, blocking Builder Loop and dashboard commands indefinitely.** Reported live: `[Troop Auto] ... queued 20 Theutates Thunder (Stable)` succeeded, then `Delaying Auto Troop Trainer by 678ms...` for the next branch — then total silence while `[Builder Loop] Still waiting (Ns)…` and a manual dashboard command both queued behind it with no resolution, even after 30+ seconds and counting.

  Root cause: `openTrainerAndReadRows()` locates a branch's building by trying, in order, village-map candidates, a configured URL, a cached slot, and — as a last resort — probing up to 22 inner building slots directly, each a full page navigation with its own bounded retry/timeout (up to ~60s × several retries). Individually bounded, but nothing capped the *combined* time across candidates/probes, and the whole call runs inside the shared `auto-troop-trainer` action lock — so a village with a cold slot cache and several slow-but-technically-working navigations could chain into many minutes with **zero log output** in between, looking indistinguishable from a true hang and blocking every other action that needs the lock.

  Added `TRAINER_RESOLVE_BUDGET_MS` (90s): a wall-clock budget checked before every map candidate, the configured-URL fallback, the cache fallback, and each probe slot. Once exceeded, resolution stops immediately and reports `missingBuilding` — which the existing caller logic already handles correctly (still on the map → retry next cycle with no penalty; genuinely not found → the existing ~12h mute). Also added a log line (`probing inner building slots (this can take a bit)...`) when the expensive last-resort probe actually kicks in, and a warning naming how many slots it managed before the budget cut it off — so a slow cycle is now visibly working instead of silent, and can never again hold the shared lock for more than one bounded worst case instead of compounding indefinitely.

## [1.8.91] — 2026-08-26

### Fixed

- **"Stuck on exit": repeated Ctrl+C could never actually stop the process.** Reported live: three Ctrl+C presses back to back, then the terminal just kept printing `[Builder Loop] Still waiting (Ns)…` past 70 seconds while a later Ctrl+C press did nothing either. Root cause: when an action was in progress, `handleUserInterrupt()` only ever set `cancelRequested = true` and called `window.stop()` on the page — it never called `requestQuit()`, so `done` never became `true`. A background loop tick (Builder Loop here, but Troop Auto and others share the same `waitForActionIdle()` helper) only checks `cancelRequested`/`done` between discrete steps, not mid network-call, so whatever was holding the action lock could keep it well past any reasonable wait — and there was no escalation path at all: pressing Ctrl+C any number of times just re-logged "Cancel requested" forever.

  `handleUserInterrupt()` now counts consecutive Ctrl+C presses that land on "an action is still running." The first press behaves as before (cancel + `window.stop()`) and now says so — `(press Ctrl+C again to force quit)`. A second such press calls `requestQuit()` and, since the first press already proved cancellation alone isn't enough, backs it with a hard `process.exit(0)` ~1.2s later so the process actually terminates regardless of what's stuck. The counter only advances while actions stay stuck — an action clearing normally, or Ctrl+C used for its existing jobs (leaving a submenu, returning to the main menu, dashboard-mode quit), still behaves exactly as before. Also made `waitForActionIdle()` bail out immediately once a quit is in flight (`done`) instead of polling out its full wait budget first, so the "Still waiting" spam stops as soon as a shutdown is actually requested.

## [1.8.90] — 2026-08-26

### Added

- **New: troop training queue cap, to spread training evenly across branches.** Reported: "Sometimes we see only one queue creates since not enough resources left for other troops in plan" — a village with, say, Barracks + Stable both configured could end up with one branch's queue growing for hours while the other stayed empty, because whichever branch trained first each tick simply took whatever resources existed, leaving nothing for the rest of the plan.

  `trainPlanBranch()` now reads the trainer's own existing queue before training into it (`readTrainerQueueTotalMs()`, added to `openTrainerAndReadRows()`), using the real `#troopQueueContainer` markup: the `tr.total` summary row's `data-t-ms` when 2+ batches are queued, or the single row's own `data-t-ms` when exactly 1 batch is queued (the game only adds a `tr.total` row once a second batch exists). When the new setting is ON and a branch's queue already runs at or beyond the configured hour cap, that branch is skipped for the tick (logged as `queue_cap_reached`) instead of training into it — letting round-robin move on to branches that still have room, which is what produces the even distribution across 6/12/18/24h-style thresholds.

  New setting, off by default so existing installs are unaffected until opted in: `TROOP_QUEUE_CAP_ENABLED` (bool) + `TROOP_QUEUE_CAP_HOURS` (numeric, default 12). Togglable live from the terminal without editing `.env`: main menu → **T** → **[QC]** (prompts Y/N/Enter-keep, then the hour threshold), mirroring the existing Builder Loop (`BL`) and Troop RR Loop (`T`) toggle pattern — persists to `.env` the same way.

## [1.8.89] — 2026-08-24

### Fixed

- **Found the real cause of a recurring "same timeout" login failure: the portal was rendering in Hebrew.** A screenshot showed the actual login modal fully rendered — in Hebrew, not English. Every English-text selector this bot uses to log in (starting with `input[placeholder="Enter your username"]`) can never match Hebrew text, so `openNexianPortalLoginForm` waits the full 30s for a field that's genuinely there, just not in the language expected, and times out every time regardless of network conditions — explaining why this kept recurring across multiple "same timeout" reports that looked network-related but weren't.

  Root cause, confirmed by direct testing against the live portal: the site's language follows the browser's `Accept-Language` request header (its own `?setlang=` URL parameter turned out unreliable in isolation — `Accept-Language` wins when they disagree). Playwright's browser context defaults to the *system's* default locale when none is set, so the rendered language silently depended on whatever locale the underlying OS/container happened to report — invisible in the terminal output, and unrelated to anything actually wrong with the bot's login logic.

  Both places a browser context gets created (fresh login, and restoring a saved session) now explicitly set `locale: "en-US"`, which Playwright documents as controlling the `Accept-Language` header on every request. The portal's login form now reliably renders in English regardless of the host machine's system locale.

## [1.8.88] — 2026-08-24

### Fixed

- **Farmlist's fallback 2 (village center → Rally Point) could get permanently stuck on the wrong host.** Reported live: `[Farmlist Loop] Auto-send failed: Could not find a farmlist send button on page: https://nexian.world/village2.php?vid=42423` — the portal host, not the realm (`s1.nexian.world`), which the README already documents as breaking farmlist/builder navigation. Root cause: fallback 2 constructed its village-center URL as `new URL("/village2.php", page.url())` — relative to whatever the *current* page happened to be, not the known-correct realm. If an earlier step in the fallback chain had already drifted onto the wrong host for any reason, this fallback perpetuated it instead of correcting it — the exact opposite of what a fallback should do.

  Anchored both branches (a discovered village-center link, and the bare `/village2.php` guess) to `farmlistTargetUrl` — the realm URL fixed at the top of `sendFarmlists()` — instead of `page.url()`. Now this fallback always lands back on the correct realm host regardless of where the page drifted to beforehand.

## [1.8.87] — 2026-08-24

### Changed

- **Skip checkbox selection entirely when the found control is `#btn_send_all`.** That specific button ("Send all lists") submits a form carrying only a hidden CSRF-style token — no per-list checkbox state is part of its payload at all, confirmed against the real markup. `ensureFarmlistSelectAllBeforeSend()` (and its retry) ran unconditionally before every send regardless of which control was found, wasting real time selecting checkboxes a `#btn_send_all` click doesn't even look at. Now skipped whenever `#btn_send_all` is the chosen control — still does one cheap `waitSendControlEnabled` check first (a real "nothing to send" case still reports idle correctly), just without the pointless selection work in between. Any other selector (e.g. a custom `FARMLIST_SEND_BUTTON_SELECTOR`) keeps the original select-first behavior unchanged.

## [1.8.86] — 2026-08-24

### Fixed

- **Farmlist sends could fail to select/send targets in collapsed lists.** Reported live: sends work reliably when every farm list is manually uncollapsed first, and fail intermittently (mostly headless) when left collapsed — confirmed by the actual markup (`<span class="flArrow" :class="{'flOpen': listOpen}">`, an Alpine.js-driven per-list collapse toggle). `ensureFarmlistSelectAllBeforeSend()` only ever touched checkboxes — it never clicked anything to open a collapsed list first, so a list's target rows could stay non-interactable exactly the way manually leaving it collapsed does.

  Added `expandAllFarmlists()`, called before any checkbox selection: clicks every `.flArrow` not already carrying `flOpen`, leaving already-open lists untouched. Logs `[Farmlist] Expanded N/M collapsed list(s) before selecting.` when it actually had to open anything, silent otherwise.

## [1.8.85] — 2026-08-24

### Fixed

- **Builder Loop catching up an already-overbuilt village did twice the navigations it needed to.** Reported live: a village where every managed building was already well above its template's current target (`Sawmill slot 30 already at level 5 (target: 1)`, then the same slot again moments later at `(target: 3)` as the plan pointer advanced one step at a time) rapid-fired through many `build.php?id=<slot>` page loads in a row — "obsessively going through those loops."

  Root cause: the follow-up retry loop's `ensureVillageBrowserContext()` call only accepted `village1.php`/`dorf1.php`/`village2.php`/`dorf2.php` as an already-usable page. After each `runBuilderStep()` leaves the browser on a specific slot's `build.php?id=X`, that doesn't count — so *every* already-satisfied step paid for two real page loads (bounce back to the village overview, then into the next slot) instead of one, even though `runBuilderStep()` navigates to its own exact target URL directly and doesn't need to start from an overview page (the existing manual "Builder Manual" run path already proved this — it never re-establishes context between follow-up steps at all).

  `ensureVillageBrowserContext()` now accepts an opt-in `allowBuildPage` option — when set, staying on `build.php` for the *same* village no longer triggers a redundant re-navigation. Only the builder loop's own follow-up retry (the two spots hammering through already-satisfied steps) opts in; every other caller (troop trainer, farmlist, cranny defense, the initial per-tick context establish) is unaffected. Roughly halves the page-load cost of catching up a village that's significantly ahead of its plan's current stage, without changing which steps are considered satisfied or how templates advance.

  This speeds up the catch-up; it doesn't eliminate the step-by-step nature of it — a village dozens of steps ahead of its stage pointer still walks through them one at a time, just faster. A deeper fix (bulk-reading all slot levels up front to skip straight to the first unsatisfied step) is a bigger, riskier change to the core plan-advancement logic and wasn't attempted here.

## [1.8.84] — 2026-08-24

### Changed

- **Farmlist sending's happy-path speed tightened toward the 10-20s it should take with no issues.** Three `waitForLoadState("networkidle", …)` calls in the send flow (after the initial page load, after selecting lists, after clicking send) were capped generously (3500/2500/4000ms). `networkidle` only resolves once there's been no network activity for 500ms — if the page has *any* background polling (ads, trackers, periodic AJAX), it never truly goes idle and each of those three waits burns its **full** timeout for nothing, up to 10 seconds combined. Each is already followed by a small fixed settle delay regardless, so the networkidle cap was pure waste on a page that was never going to idle out. Reduced to 1500/1200/1800ms (4.5s combined worst case) — doesn't slow down a page that resolves quickly (it already wasn't hitting the old caps), only stops wasting time on one that doesn't.

  Note: the deliberate ~1-2s "safety" delay before clicking send (`preSendDelayMs`, paced by the same random-delay settings used elsewhere to avoid instant load-then-click patterns) is intentional pacing, not waste, and was left as-is.

## [1.8.83] — 2026-08-24

### Fixed

- **Farmlist sending could still block every other loop for 90+ seconds despite the 1.8.75 budget ceiling.** Reported live: `[Builder Loop] Timed out after 90s — auto-send farmlists still running.` / `[Troop Auto] Timed out after 45s — auto-send farmlists still running.` — both other loops gave up waiting while farmlist's own lock was still held. Root cause: the 90-second budget (`FARMLIST_SEND_BUDGET_MS`) was only checked at the *start* of each major phase (each fallback tier, before selecting lists, etc.), not between the individual bounded steps within a phase. The post-selector "select lists and click send" segment alone chains several individually-bounded waits (`waitSendControlEnabled` up to 20s, `activateFarmlistSendControl`'s click retries up to 28s, `ensureFarmlistSelectAllBeforeSend` twice, plus delays) that could add up past the 90s ceiling with no checkpoint in between to catch it — so the budget existed but wasn't actually being enforced in that segment. Added checkpoints between each of those steps (and the two unguarded fallback-2 navigation hops), so a cumulative overrun now gets caught and aborted cleanly within roughly one step's worth of the ceiling, instead of silently running long.

### Added

- **Farmlist sending now recovers from a stuck page instead of just failing once.** When a send genuinely hits the budget ceiling (page stuck in some AJAX/half-loaded state), calling `sendFarmlists()` again on the same page isn't reliable — the page needs to actually reload first. Both call sites (the auto-loop and the manual "Send Farmlists" menu action) now go through `sendFarmlistsWithRecovery()`: on a budget-timeout failure, it reloads the page and retries, up to 3 total attempts, then gives up with one clear final failure message (`[Farmlist] Failed after 3 attempts (page refreshed between each): ...`) instead of leaving the caller to sort out an ambiguous error or retry indefinitely. Only budget-timeout failures get this treatment — idle/no-farmlists results and config errors (wrong village, no Rally Point, etc.) are unaffected, since a page reload wouldn't fix those anyway.

## [1.8.82] — 2026-08-24

### Fixed

- **The keep-alive watchdog discarded the bot's own console output entirely, hiding every crash reason.** `keep-alive.log` reported `bot process exited code=1` on a crash-loop with no way to see why — because `scripts/keep-alive.js` spawned the bot child with `stdio: "ignore"`, silently throwing away everything the bot printed, including the login-failure screenshot/URL/reason diagnostics added in 1.8.79. Under the recommended 24/7 launch path (`start-24-7.cmd` / `npm run start:24-7:pc`), every crash was completely opaque — you'd see the watchdog repeatedly restart the bot (and, as a visible side effect, reopen a fresh dashboard browser tab on every restart with no dedup) but never learn what was actually failing.

  The bot child's stdout/stderr are now captured to **`bot-output.log`**, overwritten fresh on each restart so it always reflects the most recent run. `keep-alive.log` still says *that* it crashed; `bot-output.log` now says *why*. Gitignored, same as the other runtime logs.

## [1.8.81] — 2026-08-23

### Changed

- **Login now goes straight to the login form on your realm, skipping the portal's click-through entirely.** `LOGIN_URL` used to always default to the bare portal homepage (`https://nexian.world/`), which meant every login walked through `openNexianPortalLoginForm`'s fallback chain — click "Play Now", then either match a realm card's `openLogin('s1')` handler or poke the page's Alpine.js state directly, all DOM-structure-dependent and the most plausible thing to break on any portal redesign.

  Verified against the portal's actual served HTML/JS: `https://nexian.world/?login=1&world=<id>` is a documented entry point in the page's own `landingPage()` Alpine component — those query params seed its initial state as `{ journey: true, view: 'login', serverId: <id> }` server-side, so the login form is already open and visible for that exact realm the instant the page loads. `LOGIN_URL` now defaults to this directly (`world=` set from `GAME_HOST`, e.g. `?login=1&world=s1` when `GAME_HOST=https://s1.nexian.world`) instead of the bare portal URL, when `GAME_HOST` names a specific realm. `NEXIAN_URL` still overrides both if set.

  **`.env.example` / `.env.termux.example`: `NEXIAN_URL` is now commented out by default** so this new derivation actually applies — it used to be set explicitly to the bare portal URL, which would have silently overridden the new logic for anyone using the template as-is. Existing `.env` files aren't touched by an update — if yours already has `NEXIAN_URL=https://nexian.world/` from before, comment it out (or update it) to pick up the new behavior.

## [1.8.80] — 2026-08-23

### Fixed

- **`Playwright login run failed: page.goto: net::ERR_TIMED_OUT at https://nexian.world/` failed the whole run outright on the very first navigation, with no retry.** The 1.8.79 failure-screenshot feature paid off immediately — it caught this on the first `page.goto()` of the entire process (`chrome-error://chromewebdata/`, a pure network failure, not a portal/DOM change). `login.js` never imported the shared navigation-retry helper (`browserNavigation.js`) at all — every `page.goto()` in the login flow was a bare, single-attempt call, unlike the in-game automation loops which have had retry/backoff since earlier this session. A transient network blip (DNS hiccup, brief connection timeout — exactly the class of error this session has repeatedly hit on both Termux and Windows) failed the entire login with no chance to recover.

  `login.js` now imports `safeGotoWithRetry` and uses it for the initial portal navigation (3 retries) and the saved-session restore navigation (2 retries, so a blip doesn't needlessly throw away a valid saved session and force a full re-login). Also added `ERR_TIMED_OUT` (the generic Chromium navigation timeout — distinct from `ERR_CONNECTION_TIMED_OUT`, already covered) to `browserNavigation.js`'s transient-error classification, since that's the exact error code this failure reported.

## [1.8.79] — 2026-08-23

### Added

- **Login failures now save a screenshot for diagnosis.** A reported `locator.waitFor: Timeout 30000ms exceeded` waiting for the portal's username field surfaced a real gap: on a headless/Termux setup there's no window to look at when a login step times out, so a report like this is just an error string with no way to tell whether the portal's page changed, a banner/captcha got in the way, or it was a one-off slow load. `createSession()` now catches any `loginToPage()` failure, saves a full-page screenshot plus the failing URL to `debug/login-failure-<timestamp>.png`, and rethrows the original error unchanged (the screenshot capture never masks or replaces the real failure). `debug/` is git-ignored. Documented in the README's Troubleshooting section.

## [1.8.78] — 2026-08-22

### Changed

- **Log timestamp now includes seconds:** `[HH:MM]:` → `[HH:MM:SS]:`, e.g. `[16:37:42]:[Troop Auto] queued 10 Haeduan (Stable)`. Same shared `timestampTag()` helper added in 1.8.77, just with seconds appended.

## [1.8.77] — 2026-08-22

### Added

- **Every log line now starts with a `[HH:MM]:` timestamp** (local wall-clock time, 24h, zero-padded), e.g. `[16:37]:[Troop Auto] 5-MeO-DMT (106|22) (vid=42423): queued 10 Haeduan (Stable)`. Added at the shared `logInfo`/`logSuccess`/`logWarn`/`logError`/`logDanger` helpers, so it applies uniformly to every existing log call across the whole bot (Farmlist Loop, Troop Auto, Builder Loop, Celebrations, Overflow Guard, etc.) with no per-call-site changes needed. The timestamp is colored separately (gray) from the existing `[Tag]` highlighting, so tags like `[Troop Auto]` keep their yellow highlight exactly as before.

## [1.8.76] — 2026-08-21

### Changed

- **`start.cmd` and `start-headed.cmd` are now proper one-click launchers, not bare `node` calls.** They were already double-clickable on Windows, but silently: no memory flag (so they didn't actually match `npm run login` / `npm run login:headed`, which both set `--max-old-space-size=768`), no check that Node.js is even installed, and no pause on error — a failed launch just flashed a console window shut before you could read why. Both now check for Node on PATH with a clear message if it's missing, set the same memory flag the npm scripts use, print which npm script they mirror, and pause on a non-zero exit so errors stay on screen instead of vanishing. `start.cmd` is the one-click equivalent of `npm run login`; `start-headed.cmd` of `npm run login:headed`. Documented both in the README's NPM scripts table and first-setup steps.

## [1.8.75] — 2026-08-21

### Fixed

- **Found the actual cause of "Send Farmlists" hanging silently for minutes.** A screenshot showed the manual "Send Farmlists" action pre-empting `auto-builder` almost instantly (the 1.8.74 fix working correctly) and then producing *zero* further output while the Builder Loop's own 1-minute timer skipped twice and the Farmlist auto-loop's own tick also skipped — meaning the send itself, not the pre-emption wait, was the thing sitting stuck.

  Root cause: `terminalMenu.js` has its own local `safeGotoWithRetry()` — a near-duplicate of the one in `browserNavigation.js`, kept separately because it has extra Nexian-specific redirect handling. It contained `const maxRetries = Math.max(retries, 4);`, silently flooring **every** call to at least 4 retries (5 attempts) no matter what the caller asked for. `sendFarmlists()` walks up to five sequential fallback tiers when it can't immediately find the send control (discovered-link nav, village-center → Rally Point → farm lists, legacy select-all, last-resort role/label search), and every navigation in that chain went through this floored retry count at the default 60-second-per-attempt timeout. Under a slow/degraded connection, a *single* one of those navigation calls could legitimately take 5 attempts × 60s + backoff ≈ 4+ minutes, with no log line in between — and the fallback chain could hit several such calls in one send.

  Fixes, all inside `sendFarmlists()` and its two navigation helpers:
  - `safeGotoWithRetry()` now accepts an opt-in `strictRetries` flag that honors the caller's exact retry count instead of flooring it to 4. Existing callers that don't pass it (builder loop, troop trainer, village status, etc.) are completely unaffected. Farmlist's own navigations now opt in.
  - Every navigation in the farmlist send path (primary page load and all three fallback tiers) now uses a 20s timeout instead of the 60s default, and 1-2 retries instead of the floored 4-5.
  - Added a hard 90-second ceiling on the whole `sendFarmlists()` call. If it's still hunting for a send control past that, it aborts with a clear error naming the stage it was on, instead of silently continuing through the next fallback tier — releasing the automation lock so other activities can proceed, per the intended "quick click-and-wait, then other activities continue" behavior.
  - Added `[Farmlist]` log lines at every stage (navigating, page loaded, each fallback tier, found send control) so a future slowdown is visible in the log instead of a silent multi-minute gap.
  - The fixed ~600ms wait after the page loads is now 1000ms (a clean "wait at least one second for the page to finish loading" instead of under a second), on top of the existing bounded `networkidle` wait.

## [1.8.74] — 2026-08-21

### Fixed

- **Farmlist sending could sit stuck for up to 90 seconds waiting on a loop it "pre-empted," even though it should be a quick click-and-wait.** 1.8.73 widened farmlist's pre-emption to four more background loops (`top10-tracking`, NPC Crop Convert, Overflow Guard, Celebrations RR), but pre-emption there was never real interruption — `cancelRequested` is only checked between discrete steps (start of a followup/per-village loop, or before the pre-action random delay), never mid network-call. None of those four loops — nor auto-builder's own up-to-20-step/120s follow-up retry loop — had a checkpoint to notice the request at all, so `waitForPreemptedActionRelease`'s default 90-second cap wasn't a worst case, it was close to the *typical* wait whenever farmlist's tick landed while one of them was mid-run.

  Two changes:
  - Farmlist's pre-emption wait now caps at **20 seconds** instead of 90. If whatever's running doesn't yield in time, farmlist skips that tick and falls back to the existing 2-minute short-retry cycle — a fast, visible failure instead of an up-to-90-second silent stall on every contended tick. (Cranny defense's own pre-emption of auto-builder is untouched, still 90s — no evidence that one needed changing.)
  - Auto-builder's follow-up retry loop now actually checks `cancelRequested` between steps, so a pre-emption request (from farmlist or cranny defense) can cut it short after the current step instead of running its full budget regardless.

## [1.8.73] — 2026-08-21

### Fixed

- **A DNS blip during a farmlist send was treated as a hard failure instead of being retried.** `[Farmlist Loop] Auto-send failed: page.goto: net::ERR_NAME_NOT_RESOLVED` — the navigation-retry helper (`safeGotoWithRetry`, used by every page navigation in the bot) already retries "transient" errors with backoff, but `isTransientNavigationError()`'s pattern didn't include `ERR_NAME_NOT_RESOLVED`, `ERR_INTERNET_DISCONNECTED`, `ERR_CONNECTION_TIMED_OUT`, `ERR_ADDRESS_UNREACHABLE`, or `ERR_CONNECTION_REFUSED` — all common on a mobile/Termux connection switching between wifi and cellular, or a DNS resolver hiccuping for a few seconds. Those errors now retry with the same exponential backoff (3s, 6s, 12s, capped at 30s) already used for resource-exhaustion errors, instead of aborting the send on the first blip.

### Changed

- **Farmlist sending can now pre-empt more background loops, not just four of them.** The bot already had a "farmlist priority" mechanism — `farmlistPriority: true` pauses whichever background loop currently holds the automation lock so a farmlist send can go first, then lets it resume — but the list of loops it was allowed to pause (`isPreemptibleAutoAction`) only covered `auto-builder`, `auto-troop-trainer`, `cranny-defense-rr`, and `activity-simulation`. Four other recurring background loops (`top10-tracking`, NPC Crop Convert, Overflow Guard, Celebrations RR) were missing from that list, so if one of them happened to be running when a farmlist tick fired, the send was skipped outright (no wait at all) and fell back to two 2-minute short-retries before dropping to the full loop interval — the exact "other activity delayed the high-priority farmlist send" behavior reported. Those four loops are now pre-emptible too.

  Left deliberately out: raid evacuation (`raid-evacuation-<villageId>`) and one-off manual/user-invoked actions. Evacuating resources ahead of an incoming attack is itself time-critical and defensive; pausing it so an *outgoing* farm raid can be sent first would be the wrong trade-off.

## [1.8.72] — 2026-08-20

### Fixed

- **The first troop training run was scheduled a full interval away, so a frequently-restarted session never trained anything.** `scheduleTroopVillageLoop()` always picked a fresh `30-60 min` delay (plus up to another full interval of per-village stagger) — including for the very first run after startup or after enabling the loop. Every restart reset it, so a session restarted more often than that trained **nothing, ever**. Measured on a 3-village account, first trains landed at 35 / 75 / **99** minutes.

  The first run after startup, after enabling the loop, or after assigning/re-enabling a village by hand now happens promptly (~30-90s, still staggered so villages don't all fire at once). Recurring runs afterwards are unchanged at the configured interval.

  This is what was actually behind the reported "everything is configured but no units train" — the plan, the assignment, and (after 1.8.71) the loop toggle were all correct; the first tick simply hadn't arrived yet and each restart pushed it back out again.

## [1.8.71] — 2026-08-20

### Fixed

- **A fully configured troop plan could silently never run, with zero output explaining why.** `syncAllTroopVillageLoops()` opened with `if (done || !settings.troopTrainingRoundRobinEnabled) return;` — so with the auto-train loop toggled off (which is the **default**, `TROOP_TRAINING_ROUND_ROBIN_ENABLED=false`) the entire troop system exited immediately: no timers, no logs, nothing. The existing "No villages assigned to a troop plan" notice sits *below* that return, so it couldn't fire either.

  A user lost a long time to exactly this, reporting siege units never training. Their plan was correct the whole way through — a screenshot confirmed `5 Workshop  Trebuchet x5` configured — and two earlier speculative fixes (1.8.62's trainer slot probe, 1.8.59's unset-branch flagging) addressed real robustness gaps but not this, because there was no output to diagnose from.

  The disabled state is now loud instead of silent, at all three moments where training is expected to start:
  - **Loop sync** — if the loop is off while villages are assigned to a plan, logs in red how many villages are affected and how to turn it on. Once per state change, not per sync.
  - **Creating or editing a plan** — warns that the plan won't run until the loop is enabled.
  - **Assigning a village to a plan** — the existing `(auto-train ON)` message refers only to the *per-village* toggle, which is actively misleading when the global loop is off; that case now says so explicitly.

## [1.8.70] — 2026-08-20

### Added

- **A village stuck on the same structural block is now auto-excluded from Builder RR** instead of consuming a rotation turn indefinitely. New `BUILDER_RR_AUTO_EXCLUDE_BLOCKED_STREAK` (default **12** consecutive ticks, `0` disables) — the existing `repeated_blocked` warning still appears from 4, so there's plenty of visible notice before anything is excluded. The exclusion is logged in red and names the status, the streak, and how to undo it (remove the id from `BUILDER_RR_EXCLUDED_VILLAGE_IDS`).

  **Only non-self-resolving statuses count.** `blocked_resources` (resources arrive, and it drives circulation), `blocked_queue` (queue drains), `blocked_storage` (handled by storage relief), and `idle_saturated` are all deliberately exempt — excluding on those would strand a village that was about to recover on its own. Qualifying statuses are the structural ones: `blocked_no_upgrade_button` (the reported case), `blocked_upgrade_disabled`, `blocked_mismatch`, `blocked_target_unavailable`, `blocked_target_locked`, `blocked_prerequisite_building`, `blocked_master_builder_only`, and `click_failed`. Classification verified across all eighteen statuses the builder can return.

  This exclusion deliberately **bypasses** the 1.8.68 completion re-check. That check exists to stop a village being excluded as *finished* when the game disagrees — but a village excluded for being *stuck* is incomplete by definition, so applying the veto here would have guaranteed the exact villages we most want out of the rotation could never leave it.

## [1.8.69] — 2026-08-20

### Added

- **A build step that can never be placed is now skipped so the rest of the template keeps running.** When every inner building site in a village is already occupied and the step's target isn't one of them, there is physically nowhere to put it — retrying accomplishes nothing while upgrades to buildings that *do* exist sit waiting behind it. Both blocking paths (`blocked_target_unavailable` on an empty slot, and `blocked_mismatch` on an occupied one) now check this once and advance past the step with a new `skipped_village_full` status, logged as a warning so the skip is visible rather than silent.

  Deliberately conservative — it keeps the old blocking behavior whenever the answer isn't clear-cut: the map is unreadable, the map reports no levels, any free site remains, or the target already exists somewhere (in which case the caller remaps to it instead of skipping). Verified across all those cases.

### Fixed

- **`Number.isFinite(Number(row.level))` treated a missing level as level 0** — `Number(null)` is `0`, which *is* finite. This silently inverted two checks introduced in 1.8.68/this release: a free (level-less) building site read as "occupied at level 0", and the completion verifier manufactured a failure for every slot whose level it couldn't parse — which would have blocked exclusion on an unreadable map instead of falling back to inconclusive. Both now use an explicit `hasReadableLevel()` helper that distinguishes a genuine level 0 from an absent one.

  Caught by testing the placement logic across its edge cases; the first pass of that test hid the bug by hand-copying the predicate as `Number.isFinite(row.level)` (which *is* false for `null`) rather than exercising the shipped code. Re-verified against the real exported functions.

- **The manual builder's follow-up loop had drifted from the auto loop's** — it advanced on only `already_satisfied` / `template_complete` / `realigned_template`, so a manual run stopped dead on `skipped_wrong_building_type`, `storage_relief`, and `prerequisite_relief`, all of which the auto loop walks straight through. Both sets are now identical (and include the new `skipped_village_full`).

## [1.8.68] — 2026-08-20

### Added

- **Villages are now live-verified against the game before being excluded from Builder RR.** Every "plan complete" decision rested on `previewPlan()`, which only walks `progress.json`'s stage/step pointer and **never looks at the game** — so a tracker that drifted ahead of reality read as finished. Reported directly: a village excluded as `Village stage plan complete` while its resource fields were not actually all at level 10.

  New `villageBuilder.verifyPlanChainCompleteLive()` reads the **entire village map in one page load** and checks it against what the plans actually require. Exclusion is now vetoed when the game contradicts the tracker, and progress is realigned to the earliest template with unmet requirements so the missing levels actually get built. Both exclusion paths (mid-tick and tick-start catch-up) route through the same verified helper — the catch-up previously wrote exclusions inline on unverified progress.

  Two details that make it actually catch the reported case:
  - **Requirements come from build steps, not just `end_state`.** A template's `end_state` can under-declare what it builds: `village_stage_fast_basic_15c` pushes all 18 fields to 10 across its crop/wood/clay/iron passes, yet declares **zero** field slots in `end_state`. An `end_state`-only check would have rubber-stamped exactly this village.
  - **Both plan modes are checked, not just the one that finished.** Exclusion means "no work left anywhere", and resource fields live in the resource chain — verifying only the village plan (whose templates assert no field slots at all) would have missed them again.

  Scoped to resource-field slots 1-18 and compared by **level only**: those slots have fixed positions, whereas inner buildings get remapped at runtime, so asserting a template's *guessed* inner slot number would manufacture false failures. Building names are ignored because the crop/wood/clay/iron passes deliberately target the same slots under different names via `strict_match`/`skip_if_mismatch`.

  Fails safe: only an active contradiction blocks exclusion. An unreadable or level-less village map is treated as *inconclusive* and falls back to the previous behavior, so a server whose map markup can't be parsed never strands villages in the rotation. Verified across all six outcomes — the reported case (tracker complete, 3 fields at 6/10) correctly blocks and realigns; all-at-target, above-target, empty map, level-less map, and single-field-short all behave correctly.

## [1.8.67] — 2026-08-20

### Fixed

- **A new village that simply couldn't afford its next building blocked forever instead of triggering resource circulation.** On an *empty* slot the builder returns from the new-building guard **before** the resource-sufficiency check further down ever runs, so "listed but locked because we can't afford it yet" was indistinguishable from a hard block: it reported `blocked_target_locked` and retried indefinitely, never routing to `attemptResourceCirculation()` the way `blocked_resources` does. Reported on a brand-new village — 28 consecutive blocks on `Granary` with `Buildable now: none`, which is just what an empty village with no resources looks like.

  `readSlotPage()` now captures each new-building option's cost alongside its name and buildable flag (reusing the same `img.r1..r4` + adjacent-text-node pattern this file already uses for `#contract` upgrade costs). When the target option is locked and its cost exceeds current stock, the step returns `blocked_resources` with the deficit — so circulation runs and the log names what's missing instead of repeating "not currently buildable".

  A locked option the village *can* afford still takes the existing prerequisite path unchanged, and if costs can't be parsed the behavior degrades to exactly what it was before. Verified all four cases in isolation.

## [1.8.66] — 2026-08-20

### Changed

- **A village with no builder work left is now auto-excluded from Builder RR, whichever plan finished.** Auto-exclude only ever triggered on *resource* plan completion (1.8.41), so a village logging `All village stage templates completed for this village.` — or finishing a standalone template assigned via `[B]` — stayed in the rotation indefinitely, re-resolved and re-skipped on every single tick without ever being recorded in `BUILDER_RR_EXCLUDED_VILLAGE_IDS`.

  Both the tick-start catch-up and the mid-tick handler now key off *"this village has no pending builder work"* rather than *"the resource plan is done"*, which covers all three ways a village can finish: the resource chain, the village-stage chain, and a standalone template. The exclusion message names which plan completed (`Resource fields complete` / `Village stage plan complete` / `All builder plans complete`).

  Verified against the real modules that a half-finished village is still kept: a standalone template mid-progress, a resource chain mid-progress, and a village-stage chain mid-progress with resource already done all stay in the rotation, while each genuinely-finished case is excluded.

## [1.8.65] — 2026-08-20

### Changed

- **`village_stage_fast_basic_15c`: Residence moved from slot 25 to slot 22**, in both the Stage 12 step and `end_state`. Slot 25 is the classic Roman site but is empty on this account — the Residence actually lives at `build.php?id=22`, which is what kept the builder pushing at 25.
- **Builder slot-probe now tries 22 before 25.** `probeInnerSlotsForBuilding()`'s fallback order led with the classic 25; `villageExpansion.resolveResidenceSlot()` had already learned otherwise (its probe list is commented *"Gaul often uses 22"*) and this account confirms it. Aligned the builder's order to match, so the fallback resolves in fewer page loads on this server's layout.

## [1.8.64] — 2026-08-20

### Fixed

- **The manual builder ignored the village's assigned plan and could recreate the two-plans-per-village conflict.** Keys **2** / **3** picked the plan mode straight from the keypress (`2` → village, `3` → resource) rather than resolving what the village is actually on. So pressing **3** on a village assigned a standalone *village* template via `[B]` started a brand-new `resource_fields_01` plan alongside it — exactly the conflict 1.8.53/1.8.56/1.8.57 were written to eliminate. Reported from a live log showing `[Builder Manual]` walking `resource_fields_01` → `resource_fields_02` on a village that should have been on `village_stage_fast_basic_15c`.

  The manual builder now resolves the plan through the same `resolveBuilderPlanModeForVillage()` the auto loop uses — standalone template assignments included. If the resolved plan differs from the key pressed it runs the resolved one and says so, rather than silently creating a competing plan. If the village has no pending work it reports that instead of starting one.

- **Manual RR village selection used a different filter than the auto loop** (`!isBuilderPlanFullyComplete(village, <key-derived mode>)` vs the loop's `villageHasPendingBuilderWork(village)`), so the two could disagree about which villages still had work. Both now use `villageHasPendingBuilderWork()`.

- **Manual RR "hop to the next village" reused the previous village's plan mode.** When a village came back temporarily blocked, the manual builder moved on to the next RR candidate but kept running the *first* village's plan against it — wrong whenever the two villages are on different plans. Each hop now re-resolves the plan for the village it actually lands on, and skips candidates with no pending work.

## [1.8.63] — 2026-08-20

### Fixed

- **Residence still deadlocked after 1.8.60 — the builder's building discovery had no fallback when the village-map survey came up empty.** 1.8.60 correctly made discovery *run* for an empty slot, but `discoverBonusBuildingSlotFromMap()` was still map-survey-only: it parsed `map#map2 area[...]` title/alt text and, if that found nothing, reported the building as absent. So the deadlock persisted unchanged — `'Residence' is not listed for empty slot 25` tick after tick, while the village's Residence/Palace sat on another slot the whole time. (The game omits already-built unique buildings from an empty slot's construct list entirely, which is why it appeared in neither place.)

  This is the **same map-survey weakness that hid Siege Workshop from the troop trainer in 1.8.62** — that fix added a slot probe on the trainer side but didn't generalize it to the builder. `discoverBonusBuildingSlotFromMap()` now falls back to probing inner slots directly (classic sites first, then the rest of 19-40), reading each slot page and matching its building name — the same layered map → probe strategy `villageExpansion.resolveResidenceSlot()` has used since 1.8.29.

  Results are cached per village+building: a confirmed slot is reused (re-validated on each use, and dropped if the building moved), and a **full-probe miss is also remembered** for 30 minutes — without that, a building genuinely absent from the village would re-probe all ~22 inner slots on every single builder tick. The miss TTL is deliberately short so a newly-constructed building is picked up soon after it appears.

## [1.8.62] — 2026-08-20

### Fixed

- **Siege Workshop units never trained — Workshop had no fallback when the village-map survey missed the building.** `openTrainerAndReadRows()` discovered trainer buildings only from the village-center map, and its one fallback (a configured trainer URL) was hard-limited to `barracks` and `stable`. So `workshop`, `great_barracks`, and `great_stable` depended *entirely* on that map survey; if it didn't surface them — map titles vary by tribe, UI, and server — the branch was reported `missing_building` and then **silently muted for ~12 hours**, which is exactly the reported "nothing trains, nothing shown".

  Added a probe fallback that tries inner slots directly (classic sites for each building first, then the rest of slots 19-40), reusing `loadTrainerPageWithRows()` as the predicate since it already verifies both "this page has troop rows" *and* "this page is the right building" — so a hit is confirmed, not guessed. Because probing costs one page load per slot tried, a confirmed slot is cached per village+building for the session. This is the same layered map → probe strategy `villageExpansion.resolveResidenceSlot()` has used for Residence/Palace since 1.8.29, for the same reason: village-map labels alone aren't reliable.

- **The "building not found" path was logged at info level**, burying a decision that silences a branch for ~12h. It's now a warning, and — since it follows a full slot probe — states plainly that the building wasn't found on the map *or* in any inner slot, and that finding it there anyway would indicate a detection bug.

### Notes

- If siege still doesn't train after this, the remaining failure modes are both loud: `unit "X" not in Siege Workshop. Available: …` (wrong unit name — this server uses **Ram** and **Trebuchet**, not Catapult) and `not set (won't train)` in the plan list from 1.8.59 (branch never configured).

## [1.8.61] — 2026-08-20

### Fixed

- **`[NPC Crop] Tick failed: page.goto: net::ERR_ABORTED` — one loop's cosmetic cleanup was aborting another loop's real navigation.** Every auto loop ends its tick with `restoreSelectedVillageContext()`, which puts the browser back on the menu-selected village. For the top-level loop cleanups that call runs *after* `runAction()` has already released the page lock — so a different loop can have grabbed the lock and be mid-`page.goto` when the previous loop's restore fires a competing navigation and aborts it. In the reported case the Builder Loop's post-tick restore killed the NPC Crop granary check on `village1.php?vid=42423`. All three of `safeGotoWithRetry`'s attempts (250ms/500ms apart) landed inside the same restore window, so even its `ERR_ABORTED`-aware retry logic couldn't recover.

  `restoreSelectedVillageContext()` now takes `{ skipIfBusy: true }`, which makes it a no-op when another action holds the lock — correct because the restore is purely cosmetic, whereas the navigation it was aborting is real work. Applied to the seven post-`runAction` cleanup sites (Farmlist ×3, Builder, Troop Auto, Cranny RR, Activity Sim), each individually verified to run outside the lock. Deliberately **not** applied to the four callers nested *inside* their own `runAction` (resource circulation ×3, Top 10 tracking) — those legitimately hold the lock themselves and would otherwise skip their own restore forever.

  This is the same class of bug as 1.8.43, which fixed only the Builder Loop's *skipped-tick* path; the *success* path — and every other loop — still navigated unlocked.

## [1.8.60] — 2026-08-20

### Fixed

- **Permanent `blocked_target_unavailable` deadlock on Residence (and any one-per-village flexible building) when the template's guessed slot happened to be empty** — reported with the new `repeated_blocked` warning showing **73 consecutive** blocked ticks: `Target building 'Residence' is not listed for empty slot 25`, with the options list containing no Residence at all. Root cause: the live-map slot discovery for flexible buildings (Sawmill/Brickyard/Iron Foundry/Grain Mill/Bakery/Residence) was gated behind `!slotInfo.isEmptySlot`, so it ran **only** when the guessed slot was *occupied by something else* — never when it was *empty*. Residence/Palace are one-per-village, so once one exists anywhere the game stops offering it on every other empty slot; the bot read the guessed-but-empty slot 25, didn't find Residence among the build options, and blocked forever without ever looking for where the Residence actually was. (The template's own note claimed the slot was auto-discovered "if wrong or occupied by something else" — the *occupied* half worked, the *empty* half never did.)

  Discovery now also runs for an empty slot, but only when the target isn't among that slot's offered new-building options — so the common first-time-placement case still builds directly with no extra page load. Verified across all six branches of the new condition (bug case, first placement, occupied-by-wrong-building, already-correct, Palace-satisfies-Residence, and non-flexible buildings) to confirm the fix triggers exactly where intended and leaves existing behavior untouched.
- `isFlexibleMapBonusBuilding()` now lists **Palace** alongside Residence, so a template step naming either one gets map discovery — they're already treated as the same slot's mutually exclusive alternates everywhere else.

## [1.8.59] — 2026-08-19

### Fixed

- **Troop Plans menu header omitted Workshop**, still reading "Barracks, Great Barracks, Stable, Great Stable per plan" after Workshop support was added in 1.8.49 — reasonably leading a user to conclude siege training wasn't supported at all. Now lists Workshop too.

### Added

- **Unconfigured troop-plan branches are now shown explicitly in the plan list** (`not set (won't train): …`, in yellow) — a real user reported Workshop/siege units never training with *nothing at all* appearing in the logs. Root-caused and reproduced: a branch with no unit name configured is silently dropped by `planBranches()`, so it never trains, never logs, and never errors — completely invisible. Any plan created before 1.8.49 has no `workshopUnit` at all and behaves exactly this way, looking perfectly normal in the menu while quietly never training siege. New `troopPlans.describeUnsetBranches()` surfaces this so an unset branch is obvious at a glance instead of being indistinguishable from a broken one. Verified by round-tripping a simulated pre-1.8.49 plan through the real module: it produces zero Workshop branches, and editing in a `workshopUnit` correctly persists and starts producing one.

### Notes

- Confirmed against a live in-game screenshot that this game names the building **"Siege Workshop"** (not plain "Workshop") and its units are **Ram** and **Trebuchet** (not Catapult). The existing building matcher already handles the "Siege Workshop" heading correctly (verified against the exact live strings — `\bworkshop\b` matches after level-suffix stripping), so no matcher change was needed; but a plan configured with "Catapult" will never match a unit on that page.

## [1.8.58] — 2026-08-19

### Changed

- **`village_stage_fast_basic_15c` finished: added stages 27-29 (Woodcutter/Clay Pit/Iron Mine to 10)** — the template already pushed all crop fields to 10, Bakery to 5, and Residence to 10; this adds the remaining piece so every one of the 18 resource-field slots ends the template at level 10, not just the ~15 crop ones. Same `strict_match`+`skip_if_mismatch` technique as the crop-field passes: each stage sweeps all 18 slots for one building type and only actually upgrades whichever slots are genuinely that type (a 15-crop village's exact non-crop count/positions vary per village), silently skipping the rest. Template bumped to internal `version: 4` (29 stages, 170 steps total).

## [1.8.57] — 2026-08-19

### Changed

- **`[B]` Builder Templates now clears the other plan mode on EVERY assignment, not just when the newly-picked template is standalone** — a real user hit the two-plans-active conflict again right after fixing it with 1.8.56: they'd assigned `village_stage_fast_basic_15c` (clearing `resource_fields_02` correctly), then separately picked `resource_fields_02` again from the same menu — since 1.8.56 only cleared the *other* mode when the newly-chosen template was standalone, picking a default-chain template while a standalone one was active on the other mode silently recreated the exact conflict it had just been fixed from. `[B]` is a deliberate, one-at-a-time assignment tool, so every pick now means "this village runs only this template," full stop — whichever mode/template was previously active on the other track gets cleared regardless of what's being assigned. The assign screen also now says this outright before you pick, not just in the confirmation message after. Verified both directions in isolation: standalone→default-chain and default-chain→standalone each correctly clear the other side.

## [1.8.56] — 2026-08-19

### Changed

- **`[B]` Builder Templates now clears the OTHER plan mode when assigning a standalone template, instead of leaving two plans "active" at once** — a real user's screenshot showed the assign screen listing both `resource_fields_02 [resource] (active)` and `village_stage_fast_basic_15c [village] (active)` on the same village simultaneously, and asked for exactly one to be active. 1.8.53 already made a standalone template's plan take *priority* at decision time (`resolveBuilderPlanModeForVillage`), but left the other mode's progress record sitting there untouched — still shown as "active" in this same menu, confusing regardless of which one the bot actually acted on. New `villageBuilder.clearVillagePlan()` removes a plan mode's progress entirely (not "reset to the default template" like `resetVillageProgress` — actually gone, so `getVillageProgress()` returns `null` for it). Assigning a standalone template (one not reachable from either default chain) now clears the other mode's progress if it had any, and says so in the confirmation message. Re-assigning `village_stage_fast_basic_15c` (or any other standalone template) to an already-conflicted village fixes it retroactively — no manual progress.json editing needed. Verified in isolation end-to-end against the exact reported state.

## [1.8.55] — 2026-08-19

### Changed

- **Builder Loop now waits for the page lock instead of bailing + spamming "Skipped auto-builder: another action is currently running"** — a real user asked why they kept seeing that message (plus a retry every 20s) for the whole duration of a manual Resource Fields Builder session. Previously the tick checked the lock once and gave up immediately if it was held, then retried blind every 20s, producing that same warning on a loop the entire time something else (a manual run, a farmlist send, whatever) held the page. It now calls `waitForActionIdle()` first — the same wait-for-the-lock pattern Troop Auto already uses — so it just resumes quietly the moment the other action releases the lock, instead of repeatedly bailing and re-polling. Only logs anything if the lock is actually held when the tick starts, and only warns if it's still held after 90s (falls back to the same 20s retry in that case). A manual action colliding with the auto loop still gets immediate "Skipped" feedback, unchanged — that's the right UX for a human waiting on a keypress; this fix is specifically for the background loop's side of the same collision.

## [1.8.54] — 2026-08-19

### Fixed

- **Process hung after "Session ended." instead of actually exiting, requiring a manual force-kill — most visible on Android/Termux, where that means a dead terminal with no obvious way out.** Root cause: `run()`'s clean-quit path (`login.js`) awaited every bit of cleanup — browser closed, dashboard server closed, presence recorded offline — but the code that invokes `run()` only ever attached `.catch()`, never a success handler, so nothing forced the process to actually exit afterward. It just relied on Node's event loop draining naturally, and anything still holding a handle open (a readline interface on stdin, a stray timer, a Playwright subprocess handle not fully released) kept the process alive indefinitely. Now `run().then(() => process.exit(0))` forces a clean, immediate exit once all the (already-awaited) cleanup is done — the shutdown path finishes exactly like a crash-path failure already did with `process.exit(1)`.

## [1.8.53] — 2026-08-19

### Fixed

- **A manually-assigned standalone template (e.g. `village_stage_fast_basic_15c` via `[B]`) was silently ignored while the default `resource_fields` chain kept running instead** — root-caused from a real user's pasted log/screenshot: a village had `resource_fields_02` active on the "resource" track (not yet complete) *and* `village_stage_fast_basic_15c` active on the "village" track (assigned via `[B]`) — both marked `(active)`. Because `BUILDER_RR_RESOURCE_THEN_VILLAGE` always makes the resource plan run first until it reports complete, the bot kept working `resource_fields_02` — whose fixed slot→building assumptions (e.g. "slot 10 is Iron Mine") didn't match this village's actual field layout — and never touched the template the user had explicitly assigned. Symptom: `BUILD STEP RESULT` showing `Building: Cropland (target: Iron Mine)` on slot 10 — the generic-resource-field fallback let it try to upgrade Cropland toward an Iron Mine step rather than skip it, exactly the kind of thing `village_stage_fast_basic_15c`'s `strict_match`/`skip_if_mismatch` steps exist to prevent, except that template was never actually running. Reported as "plans should exclude each other."

  Fixed: `resolveBuilderPlanModeForVillage()` now checks whether the village's "village"-plan `active_template` is reachable from the default `village_stage_00→01→02` chain (new `villageBuilder.isTemplateInDefaultChain()`). If it isn't — i.e. it's a standalone/experimental template someone explicitly assigned — that plan now runs on its own, bypassing the resource-then-village pipeline entirely for that village, instead of being silently overridden. Villages using the normal default chains are completely unaffected (verified in isolation: a fresh village, a village pinned to `village_stage_01`, and a village pinned to `village_stage_fast_basic_15c` all resolve exactly as expected).

## [1.8.52] — 2026-08-19

### Fixed

- **Sawmill/Brickyard/Iron Foundry looped forever ("realigned_template" → walk already-satisfied fields → locked again → repeat) when Main Building was below level 5** — root-caused from a real user's pasted log: `resource_fields_03.json`'s own stage notes say each bonus building "Requires [field] level 10 and Main Building level 5", but the code that checks/fixes locked-building prerequisites (`getNewBuildingGamePrerequisite`) only knew about one case ("Academy requires Barracks 3") and was hard-gated to the "village" plan only — it never ran for these "resource" plan buildings at all. Worse, even when a prerequisite realign attempt run, it can only jump to a stage *inside the current template* — and Main Building isn't managed by any resource_fields_* template, so no such stage exists there. The result: progress kept bouncing back to Stage 1 of resource_fields_03 (whose fields were already at level 10 — real user's log showed exactly this), never touching the actual blocker, forever.

  Fixed two ways: `getNewBuildingGamePrerequisite` now knows Sawmill/Brickyard/Iron Foundry require Main Building level 5 (matching the template's own documented notes), and the plan-mode restriction is gone so it runs for resource-plan buildings too. And for the deeper case — a prerequisite building genuinely not managed by the current template at all — a new `attemptPrerequisiteBuildingRelief()` discovers it directly from the live village map and clicks its next-level upgrade out-of-band if affordable (mirrors `attemptStorageReliefUpgrade` from 1.8.51: no progress-index changes, so the original blocked step is simply retried right after, one Main Building level closer to unlocked). New `prerequisite_relief` status, wired into the same same-tick follow-up retry loop and success logging as `storage_relief`.

- **A quit already in progress could crash a leftover Builder Loop tick against the closed browser, logging a scary "Auto-build failed" as literally the last line after "Session ended."** — root-caused from the same user's pasted log. A tick that was already past its `done` check (mid-flight) when quit was requested hit the closed browser on `page.goto` — already caught and logged as a transient/expected failure — but then fell through to `restoreSelectedVillageContext()`, a *second*, uncaught `page.goto()` against the same closed browser. Now: when quit is already in progress and the error is one of the known transient session-closed patterns, the tick returns immediately after the first (already-handled) error instead of attempting that second navigation, and skips the log/`recordAction` entirely — an orderly shutdown shouldn't leave a misleading failure as its last trace.

## [1.8.51] — 2026-08-19

### Added

- **Automatic storage-capacity deadlock relief in the builder** — a real gap: a step blocked because its next-level cost exceeds current Warehouse/Granary *capacity* (`blocked_storage`) previously just retried forever on a 10-minute cooldown, silently, with no escalation and no way to reach the Warehouse/Granary upgrade that would actually fix it if that step happened to be scheduled later in the same template's strict sequence — resources capping out at 100% while nothing built. `attemptStorageReliefUpgrade()` (`villageBuilder.js`) now scans the *whole* active template (not just the current position) for a Warehouse/Granary step, and if that slot has real room to grow toward what the template eventually wants and its own next-level upgrade is itself affordable right now, upgrades it out of strict order — without touching progress indices, so the originally-blocked step is simply retried right after, now hopefully unblocked. New `storage_relief` status wired into the same same-tick follow-up retry loop as `already_satisfied`/`realigned_template`, so relief can chain through several levels within one tick instead of waiting a full loop interval per level. Verified the template-wide slot/target-level scan against the real `village_stage_fast_basic_15c` template, and the affordability guards (own-capacity / own-stock checks) against synthetic slot data, in isolation.
- **`repeated_blocked` warning** — mirrors the existing `repeated_realign` streak warning, but for any `blocked_*`/`idle_saturated`/`click_failed` status: a village that keeps hitting the same blocked status tick after tick (4+ in a row) now logs a warning instead of retrying silently forever with no visible signal anything was stuck. Answers a real question asked about this: no, there was no such validation/escalation before this — now there is.

### Changed

- **Extended `village_stage_fast_basic_15c` with a third pass (stages 22-26)**: one crop field to 10 (safety check), Grain Mill to 5, Bakery to 3, all crop fields to 10 (safety net), Bakery to 5. By the time Bakery is attempted, Grain Mill 5 + Main Building 5+ + a level-10 Cropland are already in place from earlier stages, so its unlock requirements are already satisfied. `end_state` and template `version` (now 3) updated to match.

## [1.8.50] — 2026-08-19

### Changed

- **Extended `village_stage_fast_basic_15c` with a second growth pass (stages 13-21)** — after the original Residence-to-10 stage, the template now continues: crop fields to 7 (strict/skip-if-mismatch, same as before), Warehouse/Granary to 8, Main Building to 10, Rally Point to 1 (new — civic baseline gap for troop movement/scouting), Marketplace to 5, crop fields to 10 (the level the main `resource_fields_01-05` chain also targets), Warehouse/Granary to 10, Main Building to 12, Marketplace to 10. `end_state` updated to match the new final levels plus the new Rally Point requirement. Template bumped to internal `version: 2`. Still standalone (`next_template: null`) — assign via **[B]** in the terminal menu.

## [1.8.49] — 2026-08-19

### Added

- **Workshop (Ram/Catapult) support in Troop Plans** — plans can now train a Workshop unit + qty alongside Barracks/Great Barracks/Stable/Great Stable, in the terminal plan editor (**T**), the trainable-units preview, and the auto-train loop. Workshop trains last in a plan's cycle so siege never competes with cavalry/infantry for the same tick's resources. Fully wired through the existing generic building lookup tables in `terminalMenu.js` (`TRAINER_BUILDING_GID`/`TRAINER_BUILDING_LABELS`/`mapLabelMatchesTrainerKind`/`TRAINER_BUILDING_RESOLVERS`/`trainerPageMatchesBuilding`) and `troopPlans.js` (`PLAN_BRANCHES`/`BRANCH_SHORT_LABEL`) — no changes needed to the actual training/row-reading logic, which was already building-agnostic.

## [1.8.48] — 2026-08-19

### Removed

- **`scripts/set-village-template.js` and its `npm run template:assign` entry** — the terminal menu's `[B]` Builder Templates (added in 1.8.47) covers the same job interactively, so the CLI script was redundant. Assigning a template to a village is now only available via `[B]` in the terminal menu.

## [1.8.47] — 2026-08-19

### Added

- **Terminal menu `[B]` — Builder Templates (assign per-village)** — an easier way to point a village at a template than typing `--village-id=/--x=/--y=/--template=` on the command line (`scripts/set-village-template.js` still works, and this uses the exact same `setVillageProgress()` write underneath). Pick a village from the list (shows its current `village` and `resource` plan templates), then pick any enabled template from `templates/index.json` — the plan mode (village/resource) is inferred automatically from the template key's prefix, and the currently-active one is marked `(active)`.

## [1.8.46] — 2026-08-19

### Added

- **New experimental template: `village_stage_fast_basic_15c`** — a fast early-growth build order for 15-crop (crop-heavy) villages, as specified: Main Building 3 → Warehouse/Granary 2 → Marketplace 1 → all crop fields 3 → Main Building 5 → Warehouse/Granary 4 → crop fields 5 → Main Building 6 → Warehouse/Granary 6 → Grain Mill 3 → Main Building 8 → Residence 10, all on their real in-game slots. Standalone (`next_template: null`, not part of the default `village_stage_00` chain) — it only applies to a village you explicitly assign it to, via the new `scripts/set-village-template.js` (also `npm run template:assign`).
- **`strict_match` + `skip_if_mismatch` step flags** (`villageBuilder.js`) — a 15-crop village's field layout (usually 15 Cropland + 3 Woodcutter/Clay Pit/Iron Mine, at slot positions that vary per village) can't be hardcoded, so the "all crop fields" stages list all 18 resource-field slots as Cropland with these flags set. `strict_match` opts a step out of the existing "any resource-field type satisfies this step" fallback (which exists for a different purpose — tolerating template/reality naming drift — and would otherwise silently let the bot upgrade a Woodcutter/Clay Pit/Iron Mine slot it should have left alone). `skip_if_mismatch` then makes a genuine mismatch (the slot isn't actually Cropland) auto-advance to the next step instead of hard-stopping the whole builder tick with `blocked_mismatch`, mirroring the existing `already_satisfied` advance-and-continue behavior (factored both into a shared `advancePastStep()` helper). Net effect: the bot upgrades whichever ~15 of the 18 slots are genuinely Cropland and silently skips the other ~3, without needing to know in advance which is which.
- **Residence/Palace now auto-discovered from the live village map, like the other bonus buildings** — added to `isFlexibleMapBonusBuilding()` (previously only Sawmill/Brickyard/Iron Foundry/Grain Mill/Bakery), and `isSameBuildingName()` now treats "Palace" and "Residence" as equivalent (they're mutually exclusive alternates of the same slot, picked at settlement). A guessed slot number (25 in the new template) that turns out wrong, or shows a Palace instead of a Residence, no longer hard-stops the template — same live-map fallback `villageExpansion.js`'s dedicated Residence/Palace handling already relies on for the same reason (see its 1.8.29 note: "Gaul (and some layouts) place Residence off the classic Roman slot 25.").
- **`scripts/set-village-template.js`** — assigns a template (experimental or otherwise) to one specific village's `templates/progress.json` record by village id + coordinates, resetting its stage/step to 0/0. Validates the template key exists and its prefix matches `--plan=` before writing, so a typo fails immediately instead of surfacing later inside the builder loop. `--reset` re-zeroes progress for a village's current template without switching it. Exposed as `npm run template:assign`.

## [1.8.45] — 2026-08-19

### Changed

- **Reverted 1.8.44's "fields only" Builder RR auto-exclude shortcut** — the user confirmed bonus buildings (Sawmill/Brickyard/Iron Foundry/Grain Mill/Bakery) must still be built, not skipped. The live-DOM pre-check that excluded a village from Builder RR as soon as its 18 basic resource fields (Woodcutter/Clay Pit/Iron Mine/Cropland) hit level 10 has been removed from the builder-loop tick. Turns out that shortcut wasn't even semantically clean: inspecting the templates showed `resource_fields_02`'s own end-state already requires Grain Mill level 3 at fields level 8 (before all fields reach 10), and "all 18 fields at 10" itself lands mid-way through `resource_fields_03`'s stages, not on a template boundary — so a level-based shortcut could never map cleanly onto "which templates are actually done" anyway. Auto-exclude (`BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE`) once again only fires once the **entire** resource template chain (`resource_fields_01` → `05`, fields AND bonus buildings) reports `all_complete` via `previewPlan` — exactly like before 1.8.44.
- The original problem 1.8.44 was trying to solve — a village whose fields were already high level before the bot took it over, so `progress.json` never recorded those steps — is still handled correctly by the pre-existing `already_satisfied` step-advance path in `runBuilderStep()`: each already-done step gets detected against the live slot read and the tracker advances past it (up to 20 steps per tick, within a 120s budget) without ever attempting to build something that's already finished. No new work was needed there.
- `villageBuilder.readResourceFieldLevelsFromMap()` / `areAllResourceFieldsAtLevel()` are kept (unused for now) as a general live-DOM diagnostic utility rather than removed outright, since verifying against the live game state directly is still a good building block for future template/verification enhancements — it's just not the right tool for deciding RR exclusion.
- Updated `.env.example` / `.env.termux.example` comments for `BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE` to describe the (correct, restored) full-chain semantics.

## [1.8.44] — 2026-08-18

### Changed

- **Builder RR auto-exclude now triggers on the 18 basic resource fields alone, not the full template chain** — confirmed with the user: "resource fields complete" for `BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE` purposes now means Woodcutter/Clay Pit/Iron Mine/Cropland (slots 1-18) all at level 10, verified directly against the live village map — **not** also Sawmill/Brickyard/Iron Foundry (level 3), Grain Mill (level 5), and Bakery (level 5), which the full `resource_fields_01`-`05` template chain also required before. A village will now stop being auto-built and get excluded from RR as soon as its 18 fields hit 10, even if those bonus buildings were never placed. This was also the fix for a real bug: template-progress tracking (`previewPlan`/`progress.json`) can lag behind reality for a village whose fields were already high level before this bot took it over (never went through the bot's own sequential template execution) — such a village kept getting worked on indefinitely because the tracker didn't know the fields were already done. The new live-DOM check (`villageBuilder.readResourceFieldLevelsFromMap` + `areAllResourceFieldsAtLevel`, one page load, reusing the exact selector already proven for `surveyInnerSlotsFromVillageMap`) catches this directly instead of trusting the tracker.

Verified: `node -c` on both touched files; `areAllResourceFieldsAtLevel` tested in isolation across 6 scenarios (complete, missing a slot, one slot below target, all above target, empty input, non-array input); the village-center URL construction (the actual bug caught during self-review — the live-check call site initially passed the whole `settings` object where a URL string was expected, silently working for the wrong reason since `readResourceFieldLevelsFromMap`'s signature was changed to accept `settings` directly instead, matching the rest of this file's convention) tested against real `settings`-shaped input, default fallback, and null input.

## [1.8.43] — 2026-08-18

### Fixed

- **Builder Loop's skipped-tick cleanup destroyed a concurrently-running manual builder run** — when the auto builder loop's tick was cleanly skipped because another action (e.g. a manual "2"/"3" template run from the terminal menu) already held the page, the tick still unconditionally advanced the round-robin index and called `restoreSelectedVillageContext()` — which does a real `page.goto()` — afterward. That navigation happened while the concurrent manual run's `page.evaluate()` was still in flight, destroying its execution context (`Execution context was destroyed, most likely because of a navigation`) and failing the manual run outright. A real user hit this: a manual resource-builder run on an already-complete village (burning through many `already_satisfied` steps to re-sync stale progress tracking) got killed mid-run by the auto loop's own cleanup.

  Fixed precisely: a genuinely skipped tick (no page navigation, no RR-index advance) now just retries in 20s without touching the page. A real error from the build step itself still behaves exactly as before (RR advances, context restore still runs, normal reschedule) — only the clean-skip path changed. Verified via an isolated simulation of all three code paths (success / skip / error) confirming each does exactly what it should.

## [1.8.42] — 2026-08-18

### Fixed

- **Overflow Guard's round-robin was too slow to actually prevent overflow on accounts with several villages** — one village was checked per tick, so with N non-pivot villages, any single village was only actually checked once every `N × loop interval` — easily an hour or more, plenty of time for a warehouse/granary to fill to 100% between checks. Reported by a real user: surpluses filling "to the end" despite Overflow Guard being on. New `runOverflowGuardAllVillages()` checks every non-pivot village every tick by default (`RESOURCE_OVERFLOW_CHECK_ALL_EACH_TICK`, default `true`) — sequential (shares one browser page), with one village's transient failure no longer aborting the rest of the batch. Set `false` to restore the old one-per-tick behavior.
- **"Blocked by distance" was logged as routine info, easy to miss** — the exact situation causing unrelieved overflow (a village too far from its pivot — "Far sends are never allowed") was logged via `logInfo` (plain cyan), indistinguishable from routine "nothing to do" messages. Now logged via a new `logDanger()` (red+bold body), same for any other overflow failure — worth noticing, not scrolling past.

### Added

- **Yellow `[Tag]` / red-body log distinction extended** — `logDanger()` joins the existing `logInfo`/`logSuccess`/`logWarn`/`logError` set: same yellow `[Bracketed Tag]` prefix convention, red+bold message body, for urgent-but-not-crashed situations (currently: Overflow Guard blocked/failed). Goes to stdout like `logInfo`/`logSuccess`/`logWarn` (not stderr like `logError`), since it's a status to notice, not a hard failure.

## [1.8.41] — 2026-08-18

### Fixed

- **Builder RR auto-exclude never caught villages that finished resource fields before the setting took effect** — `resolveBuilderPlanModeForVillage()` (used for RR candidate selection) only checked whether the resource plan was complete, then fell through to the village-stage plan — it had no awareness of `BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE` at all. The actual exclusion logic only ran mid-tick, at the exact moment a village's resource plan transitioned from incomplete to complete; a village that was *already* resource-complete going into a tick (e.g. it finished before this setting was enabled) would skip straight to "village" mode and keep building village-stage templates indefinitely, never triggering the exclude. A real user hit exactly this: "counts through all templates instead of finishing and excluding." `resolveBuilderPlanModeForVillage()` now returns no pending work as soon as resource is complete when auto-exclude is on, regardless of village-stage status.
- Added a catch-up step at the start of each builder-loop tick: any non-excluded village whose resource plan is *already* complete now gets properly added to `BUILDER_RR_EXCLUDED_VILLAGE_IDS` (persisted, logged) immediately — previously such a village would just be silently skipped by the candidate filter without ever actually being recorded as excluded.

### Added

- **Yellow `[Tag]` prefixes in terminal log output** — `logInfo`/`logSuccess`/`logWarn`/`logError` now color a leading `[Bracketed Tag]` (e.g. `[Builder Loop]`, `[Capital Granary]`, `[NPC Crop]`) yellow, distinct from the rest of the line's normal log-level color, so the source tag is easy to spot when scanning a busy terminal. Applies uniformly across all logged tags, not just Builder Loop. Messages without a leading bracket tag are unaffected.

## [1.8.40] — 2026-08-18

### Fixed

- **Termux/proot-distro: git sync silently failed whenever `package-lock.json` had local changes** — both `termux-proot-setup.sh`'s branch checkout and the auto-sync added to `termux-proot-run.sh` in 1.8.39 used plain `git checkout`/`git pull`, which abort with "local changes would be overwritten" the moment `npm install` (which runs during setup, and can leave `package-lock.json` modified) has touched a tracked file — exactly the conflict a real user hit manually days earlier, now happening silently inside the *automatic* sync instead, defeating its whole purpose. Both now `git reset --hard` (discarding tracked-file changes — safe, this chroot copy is a deployment target, not a workspace with precious local edits; `.env`/`.env.termux` are gitignored and untouched) before `git checkout -B <branch> origin/<branch>`, which cannot be blocked by local modifications.

  Verified by reproducing the exact failure first (dirty `package-lock.json` + stale commit, real local git repos — old command: aborts, exit 1, confirmed identical to the reported symptom) and then confirming the hardened command succeeds against the identical dirty state (exit 0, correctly resets and fast-forwards to the latest remote commit).

## [1.8.39] — 2026-08-18

### Fixed

- **Termux/proot-distro: the chroot's checkout silently drifted from the Termux-side one, again** — `termux-proot-run.sh` runs from Termux, but the actual `login.js` it launches lives in a completely separate git checkout inside the chroot (`/root/nexian-dani`). Pulling updates on the Termux side (to pick up this very script's fixes) did nothing to the chroot's copy, so a real user's chroot kept running a stale pre-`--nexian-env-file=` `login.js` — reproducing the "Missing credentials... in .env" symptom a third time even after both the underlying flag-collision bug and the branch-detection fix (1.8.36/1.8.38) had already landed, purely because the chroot itself was never told to update.

  `termux-proot-run.sh` now syncs the chroot's checkout to the same branch as the Termux-side one (fetch/checkout/pull, same branch-detection as `termux-proot-setup.sh`) before every launch, by default. Sync failure (offline, no matching remote) is non-fatal — logs a warning and continues with whatever's checked out, same as `termux-proot-setup.sh`'s existing behavior. Pass `--no-sync` to skip it (faster restarts once both sides are known to match).

  Verified via real execution (PATH-mocked `proot-distro`, not sourced) confirming the generated inner script for both the default and `--no-sync` paths, plus standalone functional tests of the actual git fetch/checkout/pull chain against real local repos — both the success path (branch switch across a working remote) and the failure path (no matching remote — falls through to the non-fatal warning, does not crash).

## [1.8.38] — 2026-08-18

### Fixed

- **`--env-file=` collided with Node's own native flag, silently bypassing auto-creation** — Node.js (≥20.6) has a built-in native `--env-file=<path>` CLI flag that intercepts that exact argument *before* `login.js` ever runs, and exits immediately with `node: <path>: not found` if the target doesn't exist yet — completely bypassing `ensureEnvFile()`'s auto-creation from the 1.8.37 fix. This is a pre-existing latent bug across the whole project (`login:nexian`/`dashboard:nexian*` npm scripts, `dashboard-dev.sh`/`.ps1`/`.cmd`, the Termux scripts), not something introduced by the Termux work — it just never surfaced before because nobody had pointed `--env-file=` at a file that didn't already exist. A real user hit it running the Termux path for the first time.

  Renamed this project's own flag to **`--nexian-env-file=`** everywhere (`login.js`, all `package.json` scripts, `dashboard-dev.*` launchers, `scripts/termux-proot-*.sh`, `.env.termux.example`, README) to avoid the collision entirely. Launcher scripts that exposed their own `--env-file`/`-EnvFile` option for user convenience (`dashboard-dev.sh`, `dashboard-dev.ps1`) keep that external name — only what they forward to `node` changed.

  Verified against real Node.js: `node script.js --env-file=missing.env` (flag *after* the script name, matching this project's actual invocation pattern) reproduces the exact reported error and the script never runs; `node script.js --nexian-env-file=missing.env` runs normally with the argument available in `process.argv`. Full end-to-end confirmation with the real `login.js`: a missing `.env.termux` is now correctly created from `.env.termux.example` and the placeholder-credential guard fires cleanly, no crash.

## [1.8.37] — 2026-08-18

### Added

- **Flavor-aware `--env-file=` auto-creation** — `login.js`'s existing "auto-create a missing env file" behavior (previously always sourced from the generic `.env.example`) now prefers a same-named template when one exists: a missing `--env-file=.env.termux` is created from `.env.termux.example` (phone-tuned defaults) instead of the generic template, falling back unchanged when no flavor-specific template exists (e.g. `.env.nexian`, which has none today). Combined with `login.js`'s existing placeholder-credential guard (refuses to run and tells you which file to edit), this means: on any fresh machine, running the bot once creates a fully working config with sensible defaults, and the user only ever needs to edit real credentials (`NEXIAN_USERNAME` / `NEXIAN_PASSWORD` / `GAME_HOST`) to get going — no dependency on a setup script separately pre-copying the right template.
- `scripts/termux-proot-run.sh` simplified accordingly: always passes `--env-file=.env.termux` (unless the caller passed their own `--env-file=`) and relies on `login.js` to create it correctly, instead of the script's own file-existence-check-and-placeholder-resolution logic from 1.8.33.

## [1.8.36] — 2026-08-18

### Fixed

- **Termux/proot-distro: chroot's git clone silently diverged from the Termux-side branch** — `termux-proot-setup.sh` cloned the repo inside the chroot with no branch specified, so it always got GitHub's default branch regardless of what branch the user actually had checked out in Termux. In practice this meant `.env.termux` was never created (the chroot's `main` checkout doesn't have `.env.termux.example`, which only exists on an unmerged feature branch), with no error — the script just silently skipped that step. Now: the script detects the current branch of the Termux-side checkout it's running from (`git rev-parse --abbrev-ref HEAD`, override with `NEXIAN_REPO_BRANCH=`) and clones/checks out the same branch inside the chroot, keeping both copies in sync. Falls back to GitHub's default branch, unchanged, if detection isn't possible (detached HEAD, not a git repo).

## [1.8.35] — 2026-08-18

### Fixed

- **Termux/proot-distro: re-running setup on an existing Ubuntu install failed hard** — `termux-proot-setup.sh` checked `proot-distro list --installed` to decide whether to install, but that output format isn't reliable across `proot-distro` versions (confirmed in practice: it didn't detect an existing install), so the script tried to install again and hit `Error: container 'ubuntu' already exists.` and aborted. Now the script just runs `proot-distro install` unconditionally and treats an "already exists" failure as the expected, non-fatal outcome of a second run — any other failure still aborts with the real error shown.

## [1.8.34] — 2026-08-18

### Fixed

- **Termux/proot-distro: leaked Android node silently skipped the real Node install** — `termux-proot-setup.sh`'s "is Node already present?" check only compared version numbers, so when Termux's own Bionic/Android node was reachable on `$PATH` inside the `proot-distro login` shell (proot does not always fully reset `PATH`), a high version number (e.g. v26) satisfied `>= 20` and the script skipped installing a real glibc Node — silently running `npm install` / `npx playwright install chromium` against the wrong Node and reproducing the exact `Unsupported platform: android` error the chroot exists to avoid. Now: `PATH` is forced to a chroot-only value at the top of the provisioning and run scripts, the presence check verifies `process.platform === 'linux'` (not just version), a failed post-install check hard-fails with the resolved node path/version/platform printed instead of continuing, and `node_modules`/`package-lock.json` are wiped before `npm install` to clear any previously-poisoned install. `termux-proot-run.sh` got the same `PATH`-forcing and a pre-flight platform check before launching `node login.js`.

## [1.8.33] — 2026-08-18

### Added

- **`.env.termux.example`** — phone-friendly config profile for the Android (Termux) path: same as `.env.example` but with several loop intervals relaxed 2-4x (builder loop, celebrations, NPC crop convert, overflow guard, Top 10 tracking, session rest) to reduce how often Chromium does real work through `proot`'s syscall-translation overhead, plus `DASHBOARD_OPEN_BROWSER=false` (nothing to auto-open in a headless chroot).
- `scripts/termux-proot-setup.sh` now creates `.env.termux` from that template automatically and prints a copy-paste command to merge real credentials in from the Termux-side `.env` without overwriting the relaxed intervals.
- `scripts/termux-proot-run.sh` now uses `.env.termux` automatically when present in the chroot (falls back to plain `.env`; an explicit `--env-file=` argument still wins).

## [1.8.32] — 2026-08-18

### Added

- **Android (Termux) support, experimental** — `scripts/termux-proot-setup.sh` (`npm run termux:setup`) provisions a real glibc Linux userland on-device via `proot-distro` (Ubuntu chroot inside Termux, no root), since Termux's own Bionic-libc environment cannot run Playwright at all (`Unsupported platform: android`, and even bypassing that check, a glibc Chromium binary won't load under Bionic). Installs Node.js + the repo + Playwright/Chromium inside the chroot. `scripts/termux-proot-run.sh` (`npm run termux:run`) launches it with a `termux-wake-lock` to reduce (not eliminate) Android backgrounding kills. Documented in README with explicit limitations — this is not a substitute for running on a PC/VPS, which remains the recommended 24/7 path.

## [1.8.31] — 2026-08-17

### Added

- **Capital granary watcher** — new `CAPITAL_GRANARY_WATCHER_ENABLED` (default `true`) checks the capital village's granary on every NPC Crop Convert tick, independent of the other villages' round-robin turn, and NPC-trades crop → wood/clay/iron once it crosses the threshold. Optional `CAPITAL_GRANARY_WATCHER_RATIO` overrides the trigger threshold for the capital only (falls back to `NPC_CROP_CONVERT_GRANARY_RATIO`). Capital is excluded from the shared round-robin while the watcher is on, to avoid double-checking it. Still requires `NPC_CROP_CONVERT_ENABLED=true` — it shares that loop's schedule rather than running on its own timer.

## [1.8.30] — 2026-08-17

### Added

- **Builder RR auto-exclude on resource-fields completion** — new `BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE` (default `true`). Once a village's resource-fields plan is fully complete (all fields at their template's max level, e.g. 10), the builder loop stops upgrading that village's fields and auto-adds it to `BUILDER_RR_EXCLUDED_VILLAGE_IDS` (persisted to `.env`) instead of falling through to the village-stage plan. Set to `false` to keep the previous resource→village continuation behavior (`BUILDER_RR_RESOURCE_THEN_VILLAGE`).

### Changed

- **Builder loop interval** — default `BUILDER_LOOP_MIN_MINUTES`/`BUILDER_LOOP_MAX_MINUTES` lowered from `5`–`10` to `0.5`–`1`. Loop-interval settings now accept fractional minutes (e.g. `0.5` = 30s); a 0.1-minute floor guards against a runaway tight loop from misconfiguration.
- **Celebrations RR interval** — default `CELEBRATIONS_LOOP_MIN_MINUTES`/`CELEBRATIONS_LOOP_MAX_MINUTES` lowered from `60`–`120` to `30`–`60`.

## [1.8.29] — 2026-08-15

### Fixed

- **Expansion Residence/Palace slot discovery** — finds Residence/Palace from the village map (loose label match), village overview build queue (`slot N | Residence`), or a short probe of common inner slots — not only hardcoded slot 25. Gaul layouts often place Residence elsewhere (e.g. slot 22 on **8β**). Waiting for an in-progress upgrade to level 10 reports `residence_upgrading` instead of a hard mismatch.

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
