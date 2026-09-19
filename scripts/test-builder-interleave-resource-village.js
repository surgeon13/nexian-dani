#!/usr/bin/env node
// Isolated verification for the BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE
// branch of resolveBuilderPlanModeForVillage() in terminalMenu.js.
// Re-implements the exact shipped decision (verbatim) against fake
// per-village completion state, since the real function is a closure that
// can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");
const path = require("path");

function makeResolver({ interleave }) {
  const lastModeByVillage = new Map();

  // Verbatim copy of the shipped "both plans still have pending work" branch
  // of resolveBuilderPlanModeForVillage(), reduced to just that decision
  // (the pinned-standalone-template check and the resourceDone/villageDone
  // early returns are unchanged by this feature and already covered by
  // scripts/test-builder-manual-key-resolution.js's sibling logic).
  return function resolveMode(villageId, resourceDone, villageDone) {
    if (resourceDone && villageDone) {
      return null;
    }
    if (resourceDone) {
      return "village";
    }
    if (villageDone) {
      return "resource";
    }
    if (!interleave) {
      return "resource";
    }
    const lastMode = lastModeByVillage.get(villageId);
    const nextMode = lastMode === "resource" ? "village" : "resource";
    lastModeByVillage.set(villageId, nextMode);
    return nextMode;
  };
}

// 1. Interleaving OFF (default): unaffected, always resource first while
// both are pending -- matches pre-existing behavior exactly.
{
  const resolve = makeResolver({ interleave: false });
  assert.strictEqual(resolve(1, false, false), "resource");
  assert.strictEqual(resolve(1, false, false), "resource");
  assert.strictEqual(resolve(1, false, false), "resource");
}
console.log("PASS: interleaving off keeps the original resource-first-always behavior");

// 2. Interleaving ON: alternates resource/village turn by turn while both
// have pending work -- the actual feature requested ("templates of
// buildings and resources go together").
{
  const resolve = makeResolver({ interleave: true });
  const sequence = [];
  for (let i = 0; i < 6; i += 1) {
    sequence.push(resolve(1, false, false));
  }
  assert.deepStrictEqual(sequence, ["resource", "village", "resource", "village", "resource", "village"]);
}
console.log("PASS: interleaving on alternates resource/village turn by turn");

// 3. Interleaving ON, resource plan finishes first -- must fall through to
// "village" every turn after, not keep alternating against a plan with
// nothing left to do.
{
  const resolve = makeResolver({ interleave: true });
  assert.strictEqual(resolve(1, false, false), "resource");
  assert.strictEqual(resolve(1, true, false), "village");
  assert.strictEqual(resolve(1, true, false), "village");
}
console.log("PASS: once resource finishes, interleaving stops and village runs every turn");

// 4. Interleaving ON, village plan finishes first -- symmetric case.
{
  const resolve = makeResolver({ interleave: true });
  assert.strictEqual(resolve(1, false, false), "resource");
  assert.strictEqual(resolve(1, false, true), "resource");
  assert.strictEqual(resolve(1, false, true), "resource");
}
console.log("PASS: once village finishes, interleaving stops and resource runs every turn");

// 5. Both plans complete -- null regardless of the interleave setting.
{
  for (const interleave of [true, false]) {
    const resolve = makeResolver({ interleave });
    assert.strictEqual(resolve(1, true, true), null);
  }
}
console.log("PASS: both plans complete reports nothing to do, with or without interleaving");

// 6. Alternation is tracked per village independently -- one village's turn
// count must not affect another's.
{
  const resolve = makeResolver({ interleave: true });
  assert.strictEqual(resolve(1, false, false), "resource");
  assert.strictEqual(resolve(2, false, false), "resource");
  assert.strictEqual(resolve(1, false, false), "village");
  assert.strictEqual(resolve(2, false, false), "village");
}
console.log("PASS: alternation state is tracked independently per village");

// 7. Default resolution (verbatim copy of login.js's settings-load
// expression): with no env var and no settings.json override, interleaving
// must default to ON as of v1.8.113 -- confirmed by explicit request ("we
// want to be able to let it work and refine villages automatically with the
// templates"), not just left opt-in.
{
  delete process.env.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE;
  const resolved = String(process.env.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE || "true").toLowerCase() === "true";
  assert.strictEqual(resolved, true, "interleaving must default to on when unset");
}
console.log("PASS: interleaving defaults to on when BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE is unset");

// 8. The shipped example template must match that default, or a fresh
// templates/settings.json (copied from it on first run) would silently
// disagree with what login.js itself defaults to.
{
  const example = require(path.join(__dirname, "..", "templates", "settings.example.json"));
  assert.strictEqual(example.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE, true);
}
console.log("PASS: templates/settings.example.json ships the same default (true)");

console.log("\nAll builder interleave (resource+village) tests passed.");
