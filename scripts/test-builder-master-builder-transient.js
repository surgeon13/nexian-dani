#!/usr/bin/env node
// Isolated verification that 'blocked_master_builder_only' is treated as a
// TRANSIENT block (never triggers permanent Builder RR auto-exclusion),
// not a persistent one. Reimplements terminalMenu.js's exact shipped
// isPersistentBuilderBlock() verbatim, since it lives inside a closure that
// can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of the shipped isPersistentBuilderBlock().
function isPersistentBuilderBlock(status) {
  const key = String(status || "");
  const transient = new Set([
    "blocked_resources",
    "blocked_queue",
    "blocked_storage",
    "blocked_master_builder_only",
    "idle_saturated"
  ]);
  if (transient.has(key)) {
    return false;
  }
  return key.startsWith("blocked_") || key === "click_failed";
}

// 1. blocked_master_builder_only is transient -- it self-clears the moment
// the village's one free build slot frees up, same as blocked_queue /
// idle_saturated. A village that's simply busy building (the normal state
// without Gold Club's second concurrent slot) must never be permanently
// excluded from Builder RR over this.
{
  assert.strictEqual(isPersistentBuilderBlock("blocked_master_builder_only"), false);
}
console.log("PASS: blocked_master_builder_only is treated as transient, not persistent");

// 2. The pre-existing transient statuses are unaffected (no regression).
{
  const preExisting = ["blocked_resources", "blocked_queue", "blocked_storage", "idle_saturated"];
  for (const status of preExisting) {
    assert.strictEqual(isPersistentBuilderBlock(status), false, `${status} should still be transient`);
  }
}
console.log("PASS: pre-existing transient statuses (blocked_resources/blocked_queue/blocked_storage/idle_saturated) are unaffected");

// 3. Genuinely persistent statuses still trigger auto-exclusion after
// enough consecutive hits -- this fix must not blanket-mute the whole
// mechanism, only the one status that was misclassified.
{
  const stillPersistent = ["blocked_mismatch", "blocked_prerequisite_building", "blocked_target_unavailable", "click_failed"];
  for (const status of stillPersistent) {
    assert.strictEqual(isPersistentBuilderBlock(status), true, `${status} should still be persistent`);
  }
}
console.log("PASS: genuinely persistent statuses (blocked_mismatch/blocked_prerequisite_building/.../click_failed) still trigger auto-exclusion");

console.log("\nAll Builder master-builder-only transient-block tests passed.");
