#!/usr/bin/env node
// Isolated verification for the resource_fields_03 bonus-building realign
// stall guard in villageBuilder.js's runBuilderStep(). Reimplements the
// exact shipped shouldFallbackToBonusPrereqStage condition (and what each
// branch returns), since the real logic lives deep inside a large function
// that talks to a live Playwright page and can't be unit-tested directly.
//
// Real bug this covers: placing a bonus building (Sawmill/Brickyard/Iron
// Foundry) that's locked on its slot used to unconditionally reset the
// resource_fields_03 progress pointer back to Stage 1 every single time,
// with no memory of having just done that. Since Stage 1's fields are
// already satisfied once the chain has run a while, the reset walked
// straight back to the exact same blocked step and reset again --
// forever, with zero progress. Reported live, twice, on two different
// bonus buildings: "realigned_template: Target bonus building 'Sawmill'
// is locked on slot 30. Realigning to Stage 1..." six times in a row
// ~20s apart, then the same pattern on 'Brickyard' on a different village.
//
// If you change this logic in villageBuilder.js, mirror the change here
// too, or this test silently stops verifying the real behavior.
const assert = require("assert");

const PLAN_MODE_RESOURCE = "resource";
const PLAN_MODE_VILLAGE = "village";

function isBonusBuildingName(name) {
  const normalized = String(name || "").toLowerCase().trim();
  return (
    normalized === "sawmill" ||
    normalized === "brickyard" ||
    normalized === "iron foundry" ||
    normalized === "grain mill"
  );
}

// Verbatim copy of the shipped shouldFallbackToBonusPrereqStage condition.
function shouldFallbackToBonusPrereqStage(mode, activeTemplateKey, stageIndex, buildingName, villageProgress) {
  return (
    mode === PLAN_MODE_RESOURCE &&
    activeTemplateKey === "resource_fields_03" &&
    stageIndex > 0 &&
    isBonusBuildingName(buildingName) &&
    !(villageProgress && villageProgress.stalled_bonus_building === buildingName)
  );
}

// Simulates one runBuilderStep() call reaching this branch: either realigns
// (and records stalled_bonus_building) or falls through to a genuine
// blocked status, exactly like the shipped code.
function simulateBonusBuildingLockedStep(mode, activeTemplateKey, stageIndex, buildingName, villageProgress, fallthroughStatus) {
  if (shouldFallbackToBonusPrereqStage(mode, activeTemplateKey, stageIndex, buildingName, villageProgress)) {
    return {
      status: "realigned_template",
      newProgress: {
        ...villageProgress,
        stage_index: 0,
        step_index: 0,
        stalled_bonus_building: buildingName
      }
    };
  }
  return { status: fallthroughStatus, newProgress: villageProgress };
}

// 1. First time hitting a locked bonus building: realigns to Stage 1, and
// records which building stalled.
{
  const result = simulateBonusBuildingLockedStep(
    PLAN_MODE_RESOURCE, "resource_fields_03", 1, "Sawmill", null, "blocked_target_locked"
  );
  assert.strictEqual(result.status, "realigned_template");
  assert.strictEqual(result.newProgress.stalled_bonus_building, "Sawmill");
  assert.strictEqual(result.newProgress.stage_index, 0);
}
console.log("PASS: the first block on a bonus building realigns to Stage 1 and records the stalled building");

// 2. Hitting the SAME building's lock again (progress already carries
// stalled_bonus_building for it) must NOT realign again -- this is the
// exact infinite loop that was reported live.
{
  const afterFirstRealign = { stalled_bonus_building: "Sawmill", stage_index: 1, step_index: 0 };
  const result = simulateBonusBuildingLockedStep(
    PLAN_MODE_RESOURCE, "resource_fields_03", 1, "Sawmill", afterFirstRealign, "blocked_target_locked"
  );
  assert.strictEqual(result.status, "blocked_target_locked");
  assert.notStrictEqual(result.status, "realigned_template");
}
console.log("PASS: a second block on the SAME bonus building falls through to a real blocked status instead of realigning again");

// 3. A different bonus building (e.g. progress moved on to Brickyard after
// Sawmill's block resolved some other way) still gets its own one-shot
// realign -- the guard is per-building, not a blanket lockout.
{
  const afterSawmillRealign = { stalled_bonus_building: "Sawmill", stage_index: 1, step_index: 0 };
  const result = simulateBonusBuildingLockedStep(
    PLAN_MODE_RESOURCE, "resource_fields_03", 1, "Brickyard", afterSawmillRealign, "blocked_target_locked"
  );
  assert.strictEqual(result.status, "realigned_template");
  assert.strictEqual(result.newProgress.stalled_bonus_building, "Brickyard");
}
console.log("PASS: a different bonus building than the one previously stalled still gets its own one-shot realign");

// 4. The guard only applies to resource_fields_03's own bonus-building
// stages -- a different template or plan mode is untouched.
{
  const resultVillageMode = simulateBonusBuildingLockedStep(
    PLAN_MODE_VILLAGE, "resource_fields_03", 1, "Sawmill", null, "blocked_target_locked"
  );
  assert.strictEqual(resultVillageMode.status, "blocked_target_locked");

  const resultOtherTemplate = simulateBonusBuildingLockedStep(
    PLAN_MODE_RESOURCE, "resource_fields_04", 1, "Sawmill", null, "blocked_target_locked"
  );
  assert.strictEqual(resultOtherTemplate.status, "blocked_target_locked");

  const resultStageZero = simulateBonusBuildingLockedStep(
    PLAN_MODE_RESOURCE, "resource_fields_03", 0, "Sawmill", null, "blocked_target_locked"
  );
  assert.strictEqual(resultStageZero.status, "blocked_target_locked");
}
console.log("PASS: village mode, other templates, and Stage 1 itself are all untouched by this guard");

console.log("\nAll bonus-building realign stall-guard tests passed.");
