#!/usr/bin/env node
// Isolated verification for the builder follow-up retry budget
// (maxFollowupAttempts/maxFollowupElapsedMs) in terminalMenu.js's auto
// builder loop and manual [2]/[3] handler. Re-implements the exact shipped
// loop shape (verbatim: same no-op status allow-list, same break-on-anything-else
// semantics) against a scripted sequence of fake runBuilderStep() results, since
// the real loop is embedded in a closure that can't be required directly.
//
// If you change this loop in terminalMenu.js, mirror the change here too, or
// this test silently stops verifying the real behavior.
const assert = require("assert");

const NO_OP_STATUSES = new Set([
  "already_satisfied",
  "skipped_wrong_building_type",
  "skipped_village_full",
  "template_complete",
  "realigned_template",
  "storage_relief",
  "prerequisite_relief"
]);

// Verbatim shape of the shipped follow-up loop, reduced to just the
// attempt/status bookkeeping (the resource->village continuation and
// auto-exclude branches are unrelated to this budget and unaffected by it).
function runFollowupLoop(results, { maxFollowupAttempts, maxFollowupElapsedMs = Infinity }) {
  let index = 0;
  let finalResult = results[index];
  let followupAttempt = 0;
  const stepsSeen = [finalResult];

  while (followupAttempt < maxFollowupAttempts) {
    if (!(finalResult && NO_OP_STATUSES.has(finalResult.status))) {
      break; // A real action (or a terminal status) always stops the loop immediately.
    }
    index += 1;
    if (index >= results.length) {
      // Scripted sequence exhausted -- nothing more to retry (test fixture only).
      finalResult = null;
      break;
    }
    finalResult = results[index];
    stepsSeen.push(finalResult);
    followupAttempt += 1;
  }

  return { finalResult, followupAttempt, stepsSeen };
}

function alreadySatisfiedStep(n) {
  return { status: "already_satisfied", message: `slot ${n} already at target` };
}

// 1. THE BUG: with the old budget (20), a realistic catch-up sequence of 25
// consecutive already-satisfied steps followed by one real action never
// reaches the real action -- the tick ends with nothing built.
{
  const results = [];
  for (let i = 0; i < 25; i += 1) results.push(alreadySatisfiedStep(i));
  results.push({ status: "upgraded", message: "Warehouse upgraded to level 2" });

  const { finalResult, followupAttempt } = runFollowupLoop(results, { maxFollowupAttempts: 20 });
  assert.strictEqual(followupAttempt, 20, "old budget exhausts at exactly 20 attempts");
  assert.strictEqual(finalResult.status, "already_satisfied", "old budget never reaches the real action -- reproduces the reported bug");
}
console.log("PASS: old budget (20) reproduces the reported bug -- a 25-step catch-up never reaches the real action");

// 2. THE FIX: with the new budget (200), the same 25-step catch-up sequence
// completes and reaches the real action.
{
  const results = [];
  for (let i = 0; i < 25; i += 1) results.push(alreadySatisfiedStep(i));
  results.push({ status: "upgraded", message: "Warehouse upgraded to level 2" });

  const { finalResult, followupAttempt } = runFollowupLoop(results, { maxFollowupAttempts: 200 });
  assert.strictEqual(finalResult.status, "upgraded", "new budget must reach the real action after catching up");
  assert.strictEqual(followupAttempt, 25);
}
console.log("PASS: new budget (200) catches up through the same 25 stale steps and reaches the real action");

// 3. A larger realistic worst case: a full resource template's 18 field
// slots plus 5 bonus-building slots (23 total) all already satisfied,
// stacked across up to 3 stale templates in the chain (69 steps) before the
// real action -- still completes well within the new budget.
{
  const results = [];
  for (let i = 0; i < 69; i += 1) results.push(alreadySatisfiedStep(i));
  results.push({ status: "upgraded", message: "Sawmill upgraded to level 1" });

  const { finalResult, followupAttempt } = runFollowupLoop(results, { maxFollowupAttempts: 200 });
  assert.strictEqual(finalResult.status, "upgraded");
  assert.strictEqual(followupAttempt, 69);
}
console.log("PASS: a 69-step multi-template catch-up (realistic worst case) still reaches the real action");

// 4. A genuine real action still stops the loop after exactly one
// iteration, regardless of the budget size -- raising the budget cannot
// cause extra real actions per tick.
{
  const results = [{ status: "upgraded", message: "Main Building upgraded to level 4" }];
  const { finalResult, followupAttempt } = runFollowupLoop(results, { maxFollowupAttempts: 200 });
  assert.strictEqual(finalResult.status, "upgraded");
  assert.strictEqual(followupAttempt, 0, "a real action on the very first call must not retry at all");
}
console.log("PASS: a real action always stops the loop immediately, independent of the budget");

// 5. A genuinely pathological infinite no-op sequence still terminates
// (bounded, not an infinite loop) -- the attempt cap remains a real safety
// valve, just a much higher one.
{
  const results = [];
  for (let i = 0; i < 500; i += 1) results.push(alreadySatisfiedStep(i)); // never resolves
  const { finalResult, followupAttempt } = runFollowupLoop(results, { maxFollowupAttempts: 200 });
  assert.strictEqual(followupAttempt, 200, "must stop at exactly the attempt cap, not loop forever");
  assert.strictEqual(finalResult.status, "already_satisfied");
}
console.log("PASS: a pathological unresolved no-op sequence still terminates at the attempt cap (bounded, not infinite)");

console.log("\nAll builder follow-up budget tests passed.");
