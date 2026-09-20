#!/usr/bin/env node
// Isolated verification that Town Hall is treated as a flexible-slot
// building (live-map discovery instead of trusting the template's guessed
// slot 30), fixing a real "blocked_mismatch" stuck 8+ ticks on
// "Slot 30 contains 'Sawmill', expected 'Town Hall'." Town Hall isn't part
// of a village's earliest, always-in-the-same-order build stage, so by the
// time it's built, an earlier flexible bonus building can already occupy
// slot 30 -- the same reason Residence/Palace/Sawmill/etc. already needed
// this treatment.
//
// Reimplements villageBuilder.js's exact shipped normalizeBuildingName /
// compactBuildingName / isFlexibleMapBonusBuilding verbatim, since none of
// the three are exported from that module.
//
// If you change this logic in villageBuilder.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of villageBuilder.js's normalizeBuildingName().
function normalizeBuildingName(name) {
  const normalized = String(name || "")
    .toLowerCase()
    .replace(/ /g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (normalized.replace(/\s+/g, "") === "blacksmith") {
    return "smithy";
  }

  return normalized;
}

// Verbatim copy of villageBuilder.js's compactBuildingName().
function compactBuildingName(name) {
  return normalizeBuildingName(name).replace(/\s+/g, "");
}

// Verbatim copy of villageBuilder.js's isFlexibleMapBonusBuilding().
function isFlexibleMapBonusBuilding(name) {
  const c = compactBuildingName(name);
  return (
    c === "sawmill" ||
    c === "brickyard" ||
    c === "ironfoundry" ||
    c === "grainmill" ||
    c === "bakery" ||
    c === "residence" ||
    c === "palace" ||
    c === "townhall"
  );
}

// 1. Town Hall (and case/spacing variants) is now flexible.
{
  assert.strictEqual(isFlexibleMapBonusBuilding("Town Hall"), true);
  assert.strictEqual(isFlexibleMapBonusBuilding("town hall"), true);
  assert.strictEqual(isFlexibleMapBonusBuilding("TOWNHALL"), true);
  assert.strictEqual(isFlexibleMapBonusBuilding("Town  Hall"), true);
}
console.log("PASS: Town Hall is treated as a flexible-slot building, in any case/spacing form");

// 2. The pre-existing flexible buildings are unaffected (no regression).
{
  const preExisting = ["Sawmill", "Brickyard", "Iron Foundry", "Grain Mill", "Bakery", "Residence", "Palace"];
  for (const name of preExisting) {
    assert.strictEqual(isFlexibleMapBonusBuilding(name), true, `${name} should still be flexible`);
  }
}
console.log("PASS: pre-existing flexible buildings (Sawmill/Brickyard/.../Residence/Palace) are unaffected");

// 3. Buildings that genuinely do have a consistent, template-driven slot are
// NOT treated as flexible -- this fix should not broaden discovery beyond
// the one building with real evidence of drifting.
{
  const fixed = ["Main Building", "Warehouse", "Granary", "Marketplace", "Rally Point", "Barracks", "Academy", "Smithy", "Stable"];
  for (const name of fixed) {
    assert.strictEqual(isFlexibleMapBonusBuilding(name), false, `${name} should NOT be flexible`);
  }
}
console.log("PASS: Main Building/Warehouse/Granary/Marketplace/Rally Point/Barracks/Academy/Smithy/Stable remain fixed-slot, unaffected by this fix");

console.log("\nAll Builder Town Hall flexible-slot tests passed.");
