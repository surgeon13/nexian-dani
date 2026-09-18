#!/usr/bin/env node
// Isolated verification for the Builder RR "only the capital village
// exists" fallback added to terminalMenu.js's runBuilderScheduledTick().
// Re-implements the exact decision (verbatim) since the real code is a
// closure that can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of the shipped decision.
function resolveNonCapitalVillages(villages) {
  const allNonCapitalVillages = villages.filter((village) => !village.isCapital);
  const onlyHasCapital = allNonCapitalVillages.length === 0 && villages.length > 0;
  const nonCapitalVillages = onlyHasCapital ? villages : allNonCapitalVillages;
  return { onlyHasCapital, nonCapitalVillages };
}

// 1. THE BUG: a single-village account (capital only) used to leave RR with
// zero candidates forever -- must now fall back to the capital itself.
{
  const villages = [{ id: 1, isCapital: true }];
  const { onlyHasCapital, nonCapitalVillages } = resolveNonCapitalVillages(villages);
  assert.strictEqual(onlyHasCapital, true);
  assert.deepStrictEqual(nonCapitalVillages, villages, "capital must be the RR pool when it's the only village");
}
console.log("PASS: single-village (capital-only) account falls back to building the capital via RR");

// 2. Normal multi-village account -- capital still excluded, unaffected.
{
  const villages = [
    { id: 1, isCapital: true },
    { id: 2, isCapital: false },
    { id: 3, isCapital: false }
  ];
  const { onlyHasCapital, nonCapitalVillages } = resolveNonCapitalVillages(villages);
  assert.strictEqual(onlyHasCapital, false);
  assert.deepStrictEqual(nonCapitalVillages, [villages[1], villages[2]], "capital must stay excluded when off-villages exist");
}
console.log("PASS: multi-village account keeps the original capital-excluded RR behavior");

// 3. Exactly one non-capital village plus the capital -- also unaffected
// (not a capital-only account, so no fallback).
{
  const villages = [
    { id: 1, isCapital: true },
    { id: 2, isCapital: false }
  ];
  const { onlyHasCapital, nonCapitalVillages } = resolveNonCapitalVillages(villages);
  assert.strictEqual(onlyHasCapital, false);
  assert.deepStrictEqual(nonCapitalVillages, [villages[1]]);
}
console.log("PASS: a single off-village (plus capital) is unaffected by the fallback");

// 4. No villages at all -- fallback must not fabricate a candidate out of
// nothing (the real caller never reaches this sub-logic in that case, since
// it's gated by villages.length > 0 one level up, but the helper itself
// must still degrade safely if ever called this way).
{
  const { onlyHasCapital, nonCapitalVillages } = resolveNonCapitalVillages([]);
  assert.strictEqual(onlyHasCapital, false);
  assert.deepStrictEqual(nonCapitalVillages, []);
}
console.log("PASS: an empty village list never falsely triggers the capital fallback");

console.log("\nAll Builder RR capital-fallback tests passed.");
