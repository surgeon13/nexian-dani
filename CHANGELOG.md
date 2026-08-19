# Changelog

All notable changes to this project are documented in this file.

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
