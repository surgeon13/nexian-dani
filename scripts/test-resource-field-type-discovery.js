#!/usr/bin/env node
// Isolated verification for discoverGenuineResourceFieldSlot() and the
// strict_match resource-field remap gate in villageBuilder.js's
// runBuilderStep(). Reimplements the exact shipped control flow (cache ->
// scan slots 1-18 for the highest-level genuine match -> cache the result)
// with injectable stand-ins for the page-driving dependency (readSlotPage),
// plus the exact remap gate condition, since the real code talks to a live
// Playwright page and can't be unit-tested directly.
//
// Real bug this covers: resource_fields_03's "one of each resource to 10"
// step for Iron Mine (slot 9) used generic field-type matching, so when
// slot 9 actually held a high-level Cropland instead (a village whose real
// field-type layout doesn't match the assumed 1-4=Woodcutter/5-8=Clay Pit/
// 9-12=Iron Mine/13-18=Cropland split -- confirmed live by the user: "it
// is on level 20" for Main Building, "building on slot 9 is a crop
// field"), the step was marked satisfied even though no genuine Iron Mine
// anywhere in the village ever reached level 10 -- permanently blocking
// Iron Foundry regardless of Main Building's level, no matter how high.
//
// If you change this logic in villageBuilder.js, mirror the change here
// too, or this test silently stops verifying the real behavior.
const assert = require("assert");
const path = require("path");

const FLEXIBLE_SLOT_MISS_TTL_MS = 30 * 60 * 1000;
const PLAN_MODE_RESOURCE = "resource";

function isResourceFieldSlot(slot) {
  const id = Number(slot);
  return Number.isFinite(id) && id >= 1 && id <= 18;
}

function isResourceFieldBuildingName(name) {
  const compact = String(name || "").toLowerCase().trim();
  return compact === "woodcutter" || compact === "clay pit" || compact === "iron mine" || compact === "cropland";
}

// Verbatim copy of the shipped discoverGenuineResourceFieldSlot() control
// flow, with an injectable readSlot(slot) in place of readSlotPage().
function makeDiscoverGenuineResourceFieldSlot(readSlot) {
  const cache = new Map();
  const cacheKey = (villageId, buildingName) => `${Number(villageId) || 0}:field:${String(buildingName || "").toLowerCase()}`;

  return async function discoverGenuineResourceFieldSlot(villageId, buildingName, now = Date.now()) {
    if (!buildingName || !villageId) {
      return null;
    }

    const key = cacheKey(villageId, buildingName);
    const cached = cache.get(key);
    if (cached && Number.isFinite(cached.slot)) {
      return cached.slot;
    } else if (cached && Number.isFinite(cached.missAt)) {
      if (now - cached.missAt < FLEXIBLE_SLOT_MISS_TTL_MS) {
        return null;
      }
      cache.delete(key);
    }

    let best = null;
    for (let slot = 1; slot <= 18; slot += 1) {
      const info = await readSlot(slot, villageId);
      if (info && !info.isEmptySlot && info.buildingName === buildingName) {
        const level = Number(info.currentLevel) || 0;
        if (!best || level > best.level) {
          best = { slot, level };
        }
      }
    }

    cache.set(key, best ? { slot: best.slot } : { missAt: now });
    return best ? best.slot : null;
  };
}

// Verbatim copy of the shipped remap gate condition.
function shouldRemapResourceField(step, mode, slotInfo) {
  return Boolean(
    step.strict_match &&
      mode === PLAN_MODE_RESOURCE &&
      isResourceFieldSlot(step.slot) &&
      isResourceFieldBuildingName(step.building) &&
      !slotInfo.isEmptySlot &&
      slotInfo.buildingName !== step.building
  );
}

(async () => {
  // 1. The exact reported scenario: slot 9 is guessed as Iron Mine but is
  // really a Cropland; the genuine Iron Mine lives elsewhere (slot 11) at
  // a high level. Discovery finds it and picks it (only match here).
  {
    const fields = { 9: { isEmptySlot: false, buildingName: "Cropland", currentLevel: 15 }, 11: { isEmptySlot: false, buildingName: "Iron Mine", currentLevel: 12 } };
    const readSlot = async (slot) => fields[slot] || { isEmptySlot: true, buildingName: "", currentLevel: 0 };
    const discover = makeDiscoverGenuineResourceFieldSlot(readSlot);
    const slot = await discover(925, "Iron Mine");
    assert.strictEqual(slot, 11);
  }
  console.log("PASS: discovers the genuine Iron Mine slot when the template's guessed slot is actually a different field type");

  // 2. When multiple genuine matches exist, the highest-level one is
  // chosen (closest to/already past the target, minimizing extra work).
  {
    const fields = {
      9: { isEmptySlot: false, buildingName: "Iron Mine", currentLevel: 3 },
      10: { isEmptySlot: false, buildingName: "Iron Mine", currentLevel: 14 },
      11: { isEmptySlot: false, buildingName: "Iron Mine", currentLevel: 8 }
    };
    const readSlot = async (slot) => fields[slot] || { isEmptySlot: true, buildingName: "", currentLevel: 0 };
    const discover = makeDiscoverGenuineResourceFieldSlot(readSlot);
    const slot = await discover(1, "Iron Mine");
    assert.strictEqual(slot, 10);
  }
  console.log("PASS: among several genuine matches, the highest-level one is chosen");

  // 3. No genuine field of that type exists anywhere: returns null and
  // caches the miss so a full 18-slot scan doesn't repeat every tick.
  {
    let scans = 0;
    const readSlot = async () => {
      scans += 1;
      return { isEmptySlot: false, buildingName: "Cropland", currentLevel: 10 };
    };
    const discover = makeDiscoverGenuineResourceFieldSlot(readSlot);
    const now = Date.now();
    const first = await discover(2, "Iron Mine", now);
    const second = await discover(2, "Iron Mine", now + 1000);
    assert.strictEqual(first, null);
    assert.strictEqual(second, null);
    assert.strictEqual(scans, 18, "a genuine miss must scan all 18 slots exactly once, then trust the cached miss");
  }
  console.log("PASS: a genuine miss (no field of that type anywhere) is cached and not re-scanned within the TTL");

  // 4. A confirmed hit is cached and reused without re-scanning.
  {
    let scans = 0;
    const fields = { 5: { isEmptySlot: false, buildingName: "Clay Pit", currentLevel: 10 } };
    const readSlot = async (slot) => {
      scans += 1;
      return fields[slot] || { isEmptySlot: true, buildingName: "", currentLevel: 0 };
    };
    const discover = makeDiscoverGenuineResourceFieldSlot(readSlot);
    const first = await discover(3, "Clay Pit");
    const scansAfterFirst = scans;
    const second = await discover(3, "Clay Pit");
    assert.strictEqual(first, 5);
    assert.strictEqual(second, 5);
    assert.strictEqual(scans, scansAfterFirst, "a cached hit must not trigger another 18-slot scan");
  }
  console.log("PASS: a confirmed hit is cached and reused without re-scanning");

  // 5. The remap gate only fires for strict_match resource-field steps with
  // a genuine type mismatch on a non-empty slot -- not for generic steps,
  // empty slots, or slots that already match.
  {
    const mismatchedSlot = { isEmptySlot: false, buildingName: "Cropland", currentLevel: 15 };
    const matchingSlot = { isEmptySlot: false, buildingName: "Iron Mine", currentLevel: 15 };
    const emptySlot = { isEmptySlot: true, buildingName: "", currentLevel: 0 };

    assert.strictEqual(
      shouldRemapResourceField({ slot: 9, building: "Iron Mine", strict_match: true }, PLAN_MODE_RESOURCE, mismatchedSlot),
      true
    );
    assert.strictEqual(
      shouldRemapResourceField({ slot: 9, building: "Iron Mine", strict_match: false }, PLAN_MODE_RESOURCE, mismatchedSlot),
      false,
      "a non-strict_match step must never trigger the remap -- it already gets generic field-type substitution instead"
    );
    assert.strictEqual(
      shouldRemapResourceField({ slot: 9, building: "Iron Mine", strict_match: true }, PLAN_MODE_RESOURCE, matchingSlot),
      false,
      "nothing to remap when the guessed slot already holds the right type"
    );
    assert.strictEqual(
      shouldRemapResourceField({ slot: 9, building: "Iron Mine", strict_match: true }, PLAN_MODE_RESOURCE, emptySlot),
      false,
      "an empty slot is a placement scenario, not a mismatch -- handled elsewhere"
    );
    assert.strictEqual(
      shouldRemapResourceField({ slot: 9, building: "Iron Mine", strict_match: true }, "village", mismatchedSlot),
      false,
      "the village plan never runs resource-field steps at all"
    );
  }
  console.log("PASS: the remap gate fires only for strict_match resource-field steps with a genuine, non-empty mismatch");

  // 6. The real template: resource_fields_03's Stage 1 ("one of each
  // resource to 10") steps must all carry strict_match: true, so they
  // actually get the discovery/remap treatment above instead of silently
  // falling back to generic field-type substitution.
  {
    const template = require(path.join(__dirname, "..", "templates", "resource_fields_03.json"));
    const stage1Steps = template.stages[0].steps;
    assert.strictEqual(stage1Steps.length, 4);
    for (const step of stage1Steps) {
      assert.strictEqual(step.strict_match, true, `${step.building} (slot ${step.slot}) must be strict_match: true`);
    }
  }
  console.log("PASS: resource_fields_03's Stage 1 steps are all strict_match: true in the real template");

  console.log("\nAll resource-field genuine-type discovery tests passed.");
})();
