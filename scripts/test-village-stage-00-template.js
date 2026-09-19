#!/usr/bin/env node
// Verifies the reordered templates/village_stage_00.json (Main Building 3 ->
// Warehouse 1 -> Granary 1 -> Marketplace 1 -> Main Building 5 -> Warehouse 2
// -> Granary 2 -> ...continues to the original higher targets) against the
// REAL villageBuilder module, not a re-implementation -- this is exactly the
// module that reads and walks the template at runtime.
const assert = require("assert");
const path = require("path");
const builder = require(path.join(__dirname, "..", "villageBuilder.js"));

// A village id astronomically unlikely to collide with any real
// templates/progress.json entry, so previewPlan() (read-only) sees a
// completely fresh village with no prior progress.
const village = { id: 999999999, name: "Test Village (unused id)" };

const expectedOrder = [
  { building: "Main Building", targetLevel: 3 },
  { building: "Warehouse", targetLevel: 1 },
  { building: "Granary", targetLevel: 1 },
  { building: "Marketplace", targetLevel: 1 },
  { building: "Main Building", targetLevel: 5 },
  { building: "Warehouse", targetLevel: 2 },
  { building: "Granary", targetLevel: 2 },
  { building: "Main Building", targetLevel: 10 },
  { building: "Main Building", targetLevel: 15 },
  { building: "Warehouse", targetLevel: 3 },
  { building: "Granary", targetLevel: 3 },
  { building: "Main Building", targetLevel: 20 }
];

const preview = builder.previewPlan(village, { planMode: "village" });
assert.strictEqual(preview.status, "pending", `expected a pending plan, got status=${preview.status}`);
assert.strictEqual(preview.activeTemplate, "village_stage_00", "a fresh village must start on village_stage_00");

// previewPlan only returns the next 5 upcoming steps at a time, so walk the
// raw template directly (already loaded and validated by previewPlan above)
// to check the FULL requested order, not just the first 5.
const template = require(path.join(__dirname, "..", "templates", "village_stage_00.json"));
const flatSteps = template.stages.flatMap((stage) => stage.steps);
assert.deepStrictEqual(
  flatSteps.map((s) => ({ building: s.building, targetLevel: s.target_level })),
  expectedOrder,
  "village_stage_00's step order must match the requested sequence exactly, with the original higher targets preserved afterward"
);
console.log("PASS: village_stage_00 steps are in the exact requested order, original higher targets preserved");

// Every step must use the correct, consistent slot for its building (26 =
// Main Building, 19 = Warehouse, 24 = Granary, 33 = Marketplace -- matching
// every other template in this repo and NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID's
// default).
const expectedSlots = { "Main Building": 26, Warehouse: 19, Granary: 24, Marketplace: 33 };
for (const step of flatSteps) {
  assert.strictEqual(
    step.slot,
    expectedSlots[step.building],
    `${step.building} step must use slot ${expectedSlots[step.building]}, got ${step.slot}`
  );
}
console.log("PASS: every step uses the correct, consistent building slot");

// Chain integrity: village_stage_00 must still hand off to village_stage_01
// afterward (Marketplace/Rally Point/Barracks/... continue there), and the
// index's default chain must still start at village_stage_00.
assert.strictEqual(template.next_template, "village_stage_01");
const index = require(path.join(__dirname, "..", "templates", "index.json"));
assert.strictEqual(index.default_template, "village_stage_00");
console.log("PASS: chain integrity preserved (default_template + next_template unchanged)");

// The first pending step for a completely fresh village must be exactly
// Main Building -> 3 (the new first checkpoint), confirmed through the real
// previewPlan() output, not just the raw template.
assert.ok(preview.upcoming && preview.upcoming.length > 0);
const first = preview.upcoming[0];
assert.strictEqual(first.building, "Main Building");
assert.strictEqual(first.targetLevel, 3);
assert.strictEqual(first.isCurrent, true);
console.log("PASS: previewPlan() confirms Main Building -> 3 is the first step for a fresh village");

console.log("\nAll village_stage_00 template tests passed.");
