#!/usr/bin/env node
// Isolated verification for the auto builder loop's "blocked_prerequisite_building"
// same-tick village-mode switch (terminalMenu.js's follow-up loop). Re-implements
// the exact shipped branch (verbatim shape) against scripted runBuilderStep()
// results, since the real loop is embedded in a closure that can't be required
// directly.
//
// If you change this branch in terminalMenu.js, mirror the change here too, or
// this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim shape of the shipped branch, reduced to just this decision (the
// no-op catch-up retries around it are unrelated and already covered by
// scripts/test-builder-followup-budget.js).
function runTick({ initialResult, villageStep, interleavePipelineActive, villageAlreadyComplete }) {
  let loopPlan = { key: "resource" };
  let finalResult = initialResult;
  let switchedToVillage = false;

  if (
    finalResult &&
    finalResult.status === "blocked_prerequisite_building" &&
    loopPlan.key === "resource" &&
    interleavePipelineActive &&
    !villageAlreadyComplete
  ) {
    loopPlan = { key: "village" };
    switchedToVillage = true;
    finalResult = villageStep; // the immediate same-tick retry's result
  }

  return { finalResult, loopPlan, switchedToVillage };
}

// 1. THE FIX: a resource-plan block on a village-managed prerequisite (e.g.
// Iron Foundry needs Main Building >= 5) switches to village mode and
// retries IMMEDIATELY, same tick -- not "switch to a different village."
{
  const initialResult = {
    status: "blocked_prerequisite_building",
    message: "Iron Foundry is locked until Main Building reaches level 5 (currently 0)."
  };
  const villageStep = { status: "success", message: "Main Building upgraded to level 1" };

  const { finalResult, loopPlan, switchedToVillage } = runTick({
    initialResult,
    villageStep,
    interleavePipelineActive: true,
    villageAlreadyComplete: false
  });

  assert.strictEqual(switchedToVillage, true);
  assert.strictEqual(loopPlan.key, "village");
  assert.strictEqual(finalResult.status, "success", "must end the tick on the real village-mode action, not the block");
}
console.log("PASS: a resource-plan prerequisite block switches to village mode and retries immediately, same tick");

// 2. Without the resource->village pipeline active (e.g. plain resource-only
// mode, no combined pipeline), the switch must NOT happen -- there's
// genuinely no village plan managing this village, so the original
// blocked_/switch-villages behavior is correct and unchanged.
{
  const initialResult = {
    status: "blocked_prerequisite_building",
    message: "Iron Foundry is locked until Main Building reaches level 5 (currently 0)."
  };
  const { finalResult, switchedToVillage } = runTick({
    initialResult,
    villageStep: { status: "success", message: "should never be used" },
    interleavePipelineActive: false,
    villageAlreadyComplete: false
  });
  assert.strictEqual(switchedToVillage, false);
  assert.strictEqual(finalResult.status, "blocked_prerequisite_building", "falls through to the normal blocked_ handling");
}
console.log("PASS: no pipeline active -> no switch, original blocked_ handling applies unchanged");

// 3. If the village plan is already fully complete, switching to it would be
// pointless (nothing left to build there either) -- must not switch.
{
  const initialResult = {
    status: "blocked_prerequisite_building",
    message: "Iron Foundry is locked until Main Building reaches level 5 (currently 0)."
  };
  const { switchedToVillage } = runTick({
    initialResult,
    villageStep: { status: "success", message: "should never be used" },
    interleavePipelineActive: true,
    villageAlreadyComplete: true
  });
  assert.strictEqual(switchedToVillage, false);
}
console.log("PASS: an already-complete village plan is not switched into pointlessly");

// 4. A completely different block reason (e.g. blocked_resources) must not
// trigger this branch at all -- only blocked_prerequisite_building does.
{
  const initialResult = { status: "blocked_resources", message: "Not enough wood." };
  const { switchedToVillage, finalResult } = runTick({
    initialResult,
    villageStep: { status: "success", message: "should never be used" },
    interleavePipelineActive: true,
    villageAlreadyComplete: false
  });
  assert.strictEqual(switchedToVillage, false);
  assert.strictEqual(finalResult.status, "blocked_resources");
}
console.log("PASS: an unrelated block status (blocked_resources) is untouched by this branch");

console.log("\nAll builder prerequisite-village-switch tests passed.");
