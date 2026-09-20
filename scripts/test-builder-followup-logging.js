#!/usr/bin/env node
// Isolated verification for the follow-up-loop logging mute in both
// terminalMenu.js's auto-loop and manual [2]/[3] handler follow-up
// while-loops. Reimplements the exact shipped per-iteration
// mute/log/count decision (verbatim), since the real logic lives inside
// closures that can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of the shipped per-iteration decision: which statuses log
// immediately vs. get silently counted, from both follow-up loops.
function decideFollowupLogging(status) {
  if (status === "realigned_template" || status === "storage_relief" || status === "prerequisite_relief") {
    return { logs: true };
  }
  return { logs: false };
}

// 1. The four pure catch-up statuses are muted (no per-iteration log).
{
  const muted = ["already_satisfied", "skipped_wrong_building_type", "skipped_village_full", "template_complete"];
  for (const status of muted) {
    const decision = decideFollowupLogging(status);
    assert.strictEqual(decision.logs, false, `${status} should be muted`);
  }
}
console.log("PASS: already_satisfied/skipped_*/template_complete are muted per-iteration");

// 2. realigned_template / storage_relief / prerequisite_relief still log
// per-iteration -- these represent a real, alternate build click landing.
{
  const stillLogged = ["realigned_template", "storage_relief", "prerequisite_relief"];
  for (const status of stillLogged) {
    const decision = decideFollowupLogging(status);
    assert.strictEqual(decision.logs, true, `${status} should still log per-iteration`);
  }
}
console.log("PASS: realigned_template/storage_relief/prerequisite_relief still log per-iteration");

// 3. Simulate a full follow-up loop run: a summary line is emitted exactly
// once when muted steps occurred, with the correct count.
function simulateFollowupLoop(statuses) {
  let silentCatchUpCount = 0;
  const loggedLines = [];
  for (const status of statuses) {
    const decision = decideFollowupLogging(status);
    if (decision.logs) {
      loggedLines.push(`per-step:${status}`);
    } else {
      silentCatchUpCount += 1;
    }
  }
  if (silentCatchUpCount > 0) {
    loggedLines.push(`summary:${silentCatchUpCount}`);
  }
  return loggedLines;
}

{
  const statuses = [
    "already_satisfied",
    "already_satisfied",
    "skipped_wrong_building_type",
    "template_complete",
    "already_satisfied"
  ];
  const lines = simulateFollowupLoop(statuses);
  assert.deepStrictEqual(lines, ["summary:5"]);
}
console.log("PASS: a run of only muted statuses produces exactly one summary line with the right count");

// 4. No summary line when zero muted steps occurred.
{
  const lines = simulateFollowupLoop(["realigned_template"]);
  assert.deepStrictEqual(lines, ["per-step:realigned_template"]);
}
console.log("PASS: no summary line is emitted when zero muted steps occurred");

// 5. A mixed run logs each real step inline and appends one summary for the
// muted steps, regardless of where they fall in the sequence.
{
  const statuses = ["already_satisfied", "storage_relief", "already_satisfied", "prerequisite_relief"];
  const lines = simulateFollowupLoop(statuses);
  assert.deepStrictEqual(lines, ["per-step:storage_relief", "per-step:prerequisite_relief", "summary:2"]);
}
console.log("PASS: mixed runs log real steps inline and append one trailing summary for muted steps");

console.log("\nAll Builder follow-up logging mute tests passed.");
