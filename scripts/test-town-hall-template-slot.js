#!/usr/bin/env node
// Verifies templates/village_stage_01.json and village_stage_02.json use
// slot 23 for Town Hall (not the old guessed slot 30), which real evidence
// showed is wrong for real accounts -- Sawmill (a flexible bonus building,
// built earlier via the resource_fields chain) lands on slot 30 instead,
// blocking Town Hall's builder step forever with
// "Slot 30 contains 'Sawmill', expected 'Town Hall'." on every village.
// Reported live across two separate villages on the same account (vid=29798
// and vid=280), both showing the identical slot 30/Sawmill collision, and
// the user confirmed the real layout directly: "our town hall slot is set
// to 23, sawmill is on 30 in our jsons."
//
// villageBuilder.js's isFlexibleMapBonusBuilding() already treats Town Hall
// as flexible (live-map discovery corrects a wrong guess at runtime), but
// this fixes the template's starting guess itself too -- so it matches on
// the very first read instead of needing a discovery round-trip every time,
// and stays correct even if discovery's map survey/probe path has trouble
// on a given server.
const assert = require("assert");
const path = require("path");

const stage01 = require(path.join(__dirname, "..", "templates", "village_stage_01.json"));
const stage02 = require(path.join(__dirname, "..", "templates", "village_stage_02.json"));

for (const [key, template] of [["village_stage_01", stage01], ["village_stage_02", stage02]]) {
  const flatSteps = template.stages.flatMap((stage) => stage.steps);
  const townHallSteps = flatSteps.filter((s) => s.building === "Town Hall");
  assert.ok(townHallSteps.length > 0, `${key} must contain a Town Hall step`);
  for (const step of townHallSteps) {
    assert.strictEqual(step.slot, 23, `${key}'s Town Hall step must use slot 23, got ${step.slot}`);
  }

  const endStateSlot = template.end_state.slots.find((s) => s.building === "Town Hall");
  assert.ok(endStateSlot, `${key}'s end_state must list Town Hall`);
  assert.strictEqual(endStateSlot.slot, 23, `${key}'s end_state Town Hall entry must use slot 23, got ${endStateSlot.slot}`);
}
console.log("PASS: village_stage_01 and village_stage_02 both use slot 23 for Town Hall (steps and end_state)");

// No template may claim slot 23 for anything other than Town Hall -- that
// would recreate the exact same collision this fix removes, just on a
// different slot number.
for (const [key, template] of [["village_stage_01", stage01], ["village_stage_02", stage02]]) {
  const flatSteps = template.stages.flatMap((stage) => stage.steps);
  for (const step of flatSteps) {
    if (step.slot === 23) {
      assert.strictEqual(step.building, "Town Hall", `${key}: slot 23 must only ever be Town Hall, found '${step.building}'`);
    }
  }
}
console.log("PASS: slot 23 is exclusively reserved for Town Hall across both templates, no new collision introduced");

console.log("\nAll Town Hall template-slot tests passed.");
