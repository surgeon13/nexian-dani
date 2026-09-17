#!/usr/bin/env node
// Isolated verification for resolveBuilderPlanModeForManualKey() in
// terminalMenu.js (added in the same change as this test). Re-implements the
// exact shipped logic against fake builder/settings collaborators, since the
// real function is a closure inside runTerminalMenu() and can't be required
// directly.
//
// If you change resolveBuilderPlanModeForManualKey() in terminalMenu.js,
// mirror the change here too, or this test silently stops verifying the
// real behavior.
const assert = require("assert");

function makeResolver({ builder, settings }) {
  const normalizeBuilderPlanMode = (planMode) =>
    String(planMode || settings.builderDefaultPlanMode || "resource").toLowerCase() === "resource"
      ? "resource"
      : "village";

  const isBuilderPlanFullyComplete = (village, planMode) => {
    try {
      const preview = builder.previewPlan(village, { planMode: normalizeBuilderPlanMode(planMode) });
      return preview && preview.status === "all_complete";
    } catch (_error) {
      return false;
    }
  };

  // Verbatim copy of the shipped resolveBuilderPlanModeForManualKey().
  return function resolveBuilderPlanModeForManualKey(village, requestedPlanMode) {
    const requested = normalizeBuilderPlanMode(requestedPlanMode);
    if (!village) {
      return requested;
    }

    const villageModeProgress = builder.getVillageProgress(village, { planMode: "village" });
    const pinnedTemplate = villageModeProgress && villageModeProgress.active_template;
    if (pinnedTemplate && !builder.isTemplateInDefaultChain(pinnedTemplate, "village")) {
      return isBuilderPlanFullyComplete(village, "village") ? null : "village";
    }

    return isBuilderPlanFullyComplete(village, requested) ? null : requested;
  };
}

function fakeBuilder({ pinnedTemplate = null, inDefaultChain = true, completeModes = [] } = {}) {
  return {
    getVillageProgress: (_village, { planMode }) =>
      planMode === "village" && pinnedTemplate ? { active_template: pinnedTemplate } : {},
    isTemplateInDefaultChain: (_templateKey, _planMode) => inDefaultChain,
    previewPlan: (_village, { planMode }) => ({
      status: completeModes.includes(planMode) ? "all_complete" : "pending"
    })
  };
}

const settings = { builderDefaultPlanMode: "resource" };
const village = { id: 1, name: "Test Village" };

// 1. THE BUG: no pinned template, resource plan incomplete, user presses
// [2] (village) -- must return "village", not silently substitute "resource".
{
  const resolve = makeResolver({ builder: fakeBuilder({ completeModes: [] }), settings });
  const result = resolve(village, "village");
  assert.strictEqual(result, "village", "pressing [2] must run a village step even while resource is incomplete");
}
console.log("PASS: [2] Village Stage Builder runs a village step even when resource plan is incomplete");

// 2. Normal case, user presses [3] (resource) -- unaffected, still resource.
{
  const resolve = makeResolver({ builder: fakeBuilder({ completeModes: [] }), settings });
  const result = resolve(village, "resource");
  assert.strictEqual(result, "resource");
}
console.log("PASS: [3] Resource Fields Builder still runs a resource step");

// 3. Pinned standalone template (not in default chain) -- protection preserved:
// pressing [3] (resource) must still run the pinned "village" plan instead,
// exactly the conflict this whole mechanism exists to prevent.
{
  const resolve = makeResolver({
    builder: fakeBuilder({ pinnedTemplate: "village_stage_fast_basic_15c", inDefaultChain: false, completeModes: [] }),
    settings
  });
  const result = resolve(village, "resource");
  assert.strictEqual(result, "village", "a pinned standalone template must still override the keypress");
}
console.log("PASS: pinned standalone template still overrides the keypress (conflict prevention preserved)");

// 4. Pinned standalone template that's already fully complete -- nothing to do.
{
  const resolve = makeResolver({
    builder: fakeBuilder({
      pinnedTemplate: "village_stage_fast_basic_15c",
      inDefaultChain: false,
      completeModes: ["village"]
    }),
    settings
  });
  const result = resolve(village, "resource");
  assert.strictEqual(result, null);
}
console.log("PASS: a completed pinned standalone template reports nothing to do, not a fallback plan");

// 5. No pinned template, requested mode already complete -- nothing to do,
// not a silent substitution of the other mode either.
{
  const resolve = makeResolver({ builder: fakeBuilder({ completeModes: ["village"] }), settings });
  const result = resolve(village, "village");
  assert.strictEqual(result, null);
}
console.log("PASS: requesting an already-complete mode reports nothing to do");

// 6. No village selected at all -- falls back to the normalized request.
{
  const resolve = makeResolver({ builder: fakeBuilder(), settings });
  const result = resolve(null, "village");
  assert.strictEqual(result, "village");
}
console.log("PASS: no village selected falls back to the normalized requested mode");

console.log("\nAll builder manual-key resolution tests passed.");
