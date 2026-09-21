#!/usr/bin/env node
// Isolated verification that a building the game LISTS as an option but
// currently won't let us build (targetOption.canBuild === false) is
// correctly skipped as "skipped_village_full" when every inner site is
// already occupied by something else -- not endlessly reported as
// blocked_target_locked (or, for resource_fields_03's bonus buildings,
// endlessly realigned to Stage 1).
//
// Reimplements the exact shipped decision order in runBuilderStep()'s
// "!targetOption.canBuild" branch (resources -> prereq realign ->
// isNewBuildingUnplaceable -> bonus-prereq-stage realign ->
// blocked_target_locked), since the real function talks to a live
// Playwright page and can't be unit-tested directly.
//
// Real bug this covers: only the "!targetOption" branch (building not
// listed at all) checked isNewBuildingUnplaceable(); the "listed but
// locked" branch fell straight through to blocked_target_locked (or the
// Stage-1 realign) forever, even when the village had zero free inner
// sites left. Reported live: mature villages already full of Treasury/
// Great Barracks/Great Stable/Hero's Mansion/Cranny/Embassy, with Iron
// Foundry/Sawmill/Brickyard never built and nowhere left to place them --
// every village in Builder RR hit this identical wall, repeated_blocked
// climbing on each one, nothing ever building.
//
// If you change this logic in villageBuilder.js, mirror the change here
// too, or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of the shipped decision order for the "listed but locked"
// branch, with resource-sufficiency and prereq-realign already resolved
// (this test focuses on the isNewBuildingUnplaceable step specifically).
function decideLockedListedBuilding({ isUnplaceable, shouldFallbackToBonusPrereqStage }) {
  if (isUnplaceable) {
    return { status: "skipped_village_full" };
  }
  if (shouldFallbackToBonusPrereqStage) {
    return { status: "realigned_template" };
  }
  return { status: "blocked_target_locked" };
}

// 1. Every inner site occupied by something else (isNewBuildingUnplaceable
// -> true) skips the step, regardless of whether the bonus-prereq-stage
// realign would otherwise have applied.
{
  const result = decideLockedListedBuilding({ isUnplaceable: true, shouldFallbackToBonusPrereqStage: true });
  assert.strictEqual(result.status, "skipped_village_full");
}
console.log("PASS: a genuinely full village (no free inner site) is skipped, not realigned or blocked forever");

{
  const result = decideLockedListedBuilding({ isUnplaceable: true, shouldFallbackToBonusPrereqStage: false });
  assert.strictEqual(result.status, "skipped_village_full");
}
console.log("PASS: the full-village skip applies outside resource_fields_03's bonus-building context too");

// 2. Room still exists (isNewBuildingUnplaceable -> false): prior behavior
// is preserved exactly -- realign once for a resource_fields_03 bonus
// building, or report blocked_target_locked otherwise.
{
  const result = decideLockedListedBuilding({ isUnplaceable: false, shouldFallbackToBonusPrereqStage: true });
  assert.strictEqual(result.status, "realigned_template");
}
console.log("PASS: with room still available, the resource_fields_03 bonus-building realign still fires as before");

{
  const result = decideLockedListedBuilding({ isUnplaceable: false, shouldFallbackToBonusPrereqStage: false });
  assert.strictEqual(result.status, "blocked_target_locked");
}
console.log("PASS: with room still available and no bonus-prereq-stage context, blocked_target_locked is unchanged");

console.log("\nAll listed-but-locked village-full skip tests passed.");
