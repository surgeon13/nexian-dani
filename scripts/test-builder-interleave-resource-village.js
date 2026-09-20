#!/usr/bin/env node
// Isolated verification for the BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE
// peek/commit split in terminalMenu.js (peekBuilderInterleaveMode /
// commitBuilderInterleaveMode / resolveBuilderPlanModeForVillage's
// interleave branch). Re-implements the exact shipped logic (verbatim)
// against fake per-village completion state, since the real functions are
// closures that can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");
const path = require("path");

function makeInterleaveState() {
  const lastModeByVillage = new Map();

  // Verbatim copies of the shipped peek/commit functions.
  const peek = (villageId) => {
    const lastMode = lastModeByVillage.get(villageId);
    return lastMode === "resource" ? "village" : "resource";
  };
  const commit = (villageId, mode) => {
    if (mode === "resource" || mode === "village") {
      lastModeByVillage.set(villageId, mode);
    }
  };

  return { peek, commit };
}

// Verbatim copy of resolveBuilderPlanModeForVillage's decision, reduced to
// just the "both plans pending" interleave branch (the resourceDone/
// villageDone early returns and the pinned-standalone-template check are
// unchanged by this fix and already covered by
// scripts/test-builder-manual-key-resolution.js's sibling logic).
function resolveInterleaveMode(state, interleave, villageId, resourceDone, villageDone) {
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
  return state.peek(villageId); // READ ONLY -- no commit here, matching the fix.
}

// 1. Interleaving OFF (default off path): unaffected, always resource first
// while both are pending -- matches pre-existing behavior exactly.
{
  const state = makeInterleaveState();
  assert.strictEqual(resolveInterleaveMode(state, false, 1, false, false), "resource");
  assert.strictEqual(resolveInterleaveMode(state, false, 1, false, false), "resource");
}
console.log("PASS: interleaving off keeps the original resource-first-always behavior");

// 2. THE BUG (v1.8.114): peeking repeatedly (simulating villageHasPendingBuilderWork
// being called many times per tick across candidate filtering, catch-up
// exclusion, etc.) must NOT change what the next peek returns -- only an
// explicit commit may advance the alternation. Before this fix, every peek
// silently mutated the state, so a village's actual mode when it finally got
// a real turn was essentially random noise instead of a clean alternation.
{
  const state = makeInterleaveState();
  const first = state.peek(1);
  // Peek the same village many more times, exactly like multiple filtering
  // passes over the RR candidate list would within a single tick.
  for (let i = 0; i < 20; i += 1) {
    assert.strictEqual(state.peek(1), first, "repeated peeks without a commit must all return the same mode");
  }
}
console.log("PASS: repeated peeks (no commit) never drift -- this is the exact bug that got fixed");

// 3. Only commit() advances the alternation, and it takes effect on the
// NEXT peek, not the current one.
{
  const state = makeInterleaveState();
  const t1 = state.peek(1);
  assert.strictEqual(t1, "resource", "a village with no prior committed turn starts on resource");
  state.commit(1, t1);
  const t2 = state.peek(1);
  assert.strictEqual(t2, "village", "the turn after a committed resource turn must be village");
  state.commit(1, t2);
  const t3 = state.peek(1);
  assert.strictEqual(t3, "resource");
}
console.log("PASS: alternation only advances on commit, flips resource/village turn by turn");

// 4. The reported real-world scenario: a brand-new village whose resource
// plan hits an unbuildable cross-plan dependency (Iron Foundry needs Main
// Building >= 5, which only the village plan manages) must still get real,
// alternating turns at "village" mode over time -- filtering passes alone
// (peeks with no commit) must never substitute for an actual completed
// turn, or the village could get stuck offering "resource" every real turn
// by coincidence, exactly as was observed live.
{
  const state = makeInterleaveState();
  const villageId = 42;
  const turns = [];
  for (let realTurn = 0; realTurn < 4; realTurn += 1) {
    // Simulate several filtering-pass peeks happening before this tick's
    // real turn is decided (candidate list check, catch-up exclude check,
    // etc.) -- none of these may affect the outcome.
    for (let filterPass = 0; filterPass < 5; filterPass += 1) {
      state.peek(villageId);
    }
    const decided = state.peek(villageId);
    turns.push(decided);
    state.commit(villageId, decided); // the one real commit for this tick
  }
  assert.deepStrictEqual(turns, ["resource", "village", "resource", "village"]);
}
console.log("PASS: interleaved turns alternate cleanly even with many non-committing peeks in between");

// 5. Alternation is tracked per village independently.
{
  const state = makeInterleaveState();
  const a = state.peek(1);
  state.commit(1, a);
  const b = state.peek(2);
  state.commit(2, b);
  assert.strictEqual(a, "resource");
  assert.strictEqual(b, "resource", "village 2's first turn must not be affected by village 1's commit");
}
console.log("PASS: alternation state is tracked independently per village");

// 6. Default resolution (verbatim copy of login.js's settings-load
// expression): with no env var and no settings.json override, interleaving
// must default to ON as of v1.8.113.
{
  delete process.env.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE;
  const resolved = String(process.env.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE || "true").toLowerCase() === "true";
  assert.strictEqual(resolved, true, "interleaving must default to on when unset");
}
console.log("PASS: interleaving defaults to on when BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE is unset");

// 7. The shipped example template must match that default.
{
  const example = require(path.join(__dirname, "..", "templates", "settings.example.json"));
  assert.strictEqual(example.BUILDER_RR_INTERLEAVE_RESOURCE_VILLAGE, true);
}
console.log("PASS: templates/settings.example.json ships the same default (true)");

console.log("\nAll builder interleave (resource+village) tests passed.");
