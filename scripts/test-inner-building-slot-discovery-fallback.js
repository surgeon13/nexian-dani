#!/usr/bin/env node
// Isolated verification for discoverInnerBuildingSlotFromMap()'s new
// probe-fallback + cache behavior in villageBuilder.js. Reimplements the
// exact shipped control flow (cache lookup/verify -> survey -> probe
// fallback -> cache the result either way) with injectable stand-ins for
// the page-driving dependencies (surveyInnerSlotsFromVillageMap,
// probeInnerSlotsForBuilding, readSlotPage), since the real function talks
// to a live Playwright page and can't be unit-tested directly.
//
// Real bug this covers: readPrerequisiteBuildingLevel() (used when a
// resource-plan step like placing Iron Foundry needs Main Building's live
// level, and Main Building isn't managed by that template) relied solely
// on the village-map survey to find Main Building. The survey's markup
// isn't reliable on every server/tribe -- when it missed, the level was
// silently reported as 0 even when Main Building plainly existed at a much
// higher level, permanently blocking Iron Foundry/Sawmill/Brickyard
// placement (and, since resource_fields_03/04 is a strict-sequence chain,
// every field upgrade after it too). Reported live: "Iron Foundry is
// locked until Main Building reaches level 5 (currently 0)" for a village
// whose village-stage progress showed it was already dozens of steps past
// Main Building's own construction stages.
//
// If you change this logic in villageBuilder.js, mirror the change here
// too, or this test silently stops verifying the real behavior.
const assert = require("assert");

const FLEXIBLE_SLOT_MISS_TTL_MS = 30 * 60 * 1000;

function makeDiscoverInnerBuildingSlotFromMap({ survey, probe, readSlot }) {
  const cache = new Map();
  const cacheKey = (villageId, buildingName) => `${Number(villageId) || 0}:${String(buildingName || "").toLowerCase()}`;

  return async function discoverInnerBuildingSlotFromMap(villageId, buildingName, now = Date.now()) {
    if (!buildingName || !villageId) {
      return null;
    }

    const key = cacheKey(villageId, buildingName);
    const cached = cache.get(key);
    if (cached && Number.isFinite(cached.slot)) {
      const info = await readSlot(cached.slot, villageId).catch(() => null);
      if (info && !info.isEmptySlot && info.buildingName === buildingName) {
        return cached.slot;
      }
      cache.delete(key);
    } else if (cached && Number.isFinite(cached.missAt)) {
      if (now - cached.missAt < FLEXIBLE_SLOT_MISS_TTL_MS) {
        return null;
      }
      cache.delete(key);
    }

    const surveyRows = await survey(villageId);
    const match = surveyRows.find((row) => row.label === buildingName);
    if (match && Number.isFinite(Number(match.slotId))) {
      return Number(match.slotId);
    }

    const probed = await probe(villageId, buildingName);
    cache.set(key, probed != null ? { slot: probed } : { missAt: now });
    return probed;
  };
}

// Helper to build a fresh instance with call counters.
function buildHarness({ surveyResult, probeResult, readSlotResult }) {
  const calls = { survey: 0, probe: 0, readSlot: 0 };
  const readSlot = async (slot, villageId) => {
    calls.readSlot += 1;
    return typeof readSlotResult === "function" ? readSlotResult(slot, villageId) : readSlotResult;
  };
  const discover = makeDiscoverInnerBuildingSlotFromMap({
    survey: async () => {
      calls.survey += 1;
      return surveyResult;
    },
    probe: async () => {
      calls.probe += 1;
      return probeResult;
    },
    readSlot
  });
  return { discover, calls };
}

(async () => {
  // 1. Survey finds the building directly -- probe must never be called.
  {
    const { discover, calls } = buildHarness({
      surveyResult: [{ label: "Main Building", slotId: 26 }],
      probeResult: null
    });
    const slot = await discover(101, "Main Building");
    assert.strictEqual(slot, 26);
    assert.strictEqual(calls.survey, 1);
    assert.strictEqual(calls.probe, 0);
  }
  console.log("PASS: a successful map survey returns immediately without probing");

  // 2. Survey misses -- falls back to the direct inner-slot probe instead
  // of concluding the building doesn't exist.
  {
    const { discover, calls } = buildHarness({
      surveyResult: [],
      probeResult: 23
    });
    const slot = await discover(102, "Main Building");
    assert.strictEqual(slot, 23);
    assert.strictEqual(calls.survey, 1);
    assert.strictEqual(calls.probe, 1);
  }
  console.log("PASS: a failed map survey falls back to probing every inner slot directly");

  // 3. A found slot is cached and reused (confirmed via readSlot) without
  // re-running the survey or probe on the next call.
  {
    const { discover, calls } = buildHarness({
      surveyResult: [],
      probeResult: 23,
      readSlotResult: { isEmptySlot: false, buildingName: "Main Building" }
    });
    const first = await discover(103, "Main Building");
    const second = await discover(103, "Main Building");
    assert.strictEqual(first, 23);
    assert.strictEqual(second, 23);
    assert.strictEqual(calls.survey, 1);
    assert.strictEqual(calls.probe, 1);
    assert.strictEqual(calls.readSlot, 1, "second call should confirm via one readSlot check, not re-discover");
  }
  console.log("PASS: a discovered slot is cached and confirmed via a single readSlot check on reuse");

  // 4. A confirmed-stale cached slot (building no longer there) is dropped
  // and rediscovered, not trusted blindly forever. Built directly (not via
  // buildHarness) since this case needs the probe result to change between
  // calls, which the static-value harness above doesn't support.
  {
    const cache = new Map();
    let probeCount = 0;
    const discover = makeDiscoverInnerBuildingSlotFromMap({
      survey: async () => [],
      probe: async () => {
        probeCount += 1;
        return probeCount === 1 ? 23 : 24;
      },
      readSlot: async () => ({ isEmptySlot: false, buildingName: "Something Else" })
    });
    const first = await discover(104, "Main Building");
    const second = await discover(104, "Main Building");
    assert.strictEqual(first, 23);
    assert.strictEqual(second, 24, "a cached slot that no longer holds the target building must be rediscovered");
    assert.strictEqual(probeCount, 2);
  }
  console.log("PASS: a cached slot that no longer matches is dropped and rediscovered, not trusted forever");

  // 5. A genuine miss (probe also finds nothing) is cached too, so a
  // building that truly isn't in the village yet doesn't re-trigger a full
  // ~22-page probe on every single tick.
  {
    const { discover, calls } = buildHarness({
      surveyResult: [],
      probeResult: null
    });
    const now = Date.now();
    const first = await discover(105, "Palace", now);
    const second = await discover(105, "Palace", now + 1000);
    assert.strictEqual(first, null);
    assert.strictEqual(second, null);
    assert.strictEqual(calls.survey, 1, "a recent miss must be trusted without re-surveying");
    assert.strictEqual(calls.probe, 1, "a recent miss must be trusted without re-probing");
  }
  console.log("PASS: a genuine miss (not found anywhere) is cached and not re-probed within the TTL");

  // 6. An expired miss cache entry is retried.
  {
    const { discover, calls } = buildHarness({
      surveyResult: [],
      probeResult: null
    });
    const now = Date.now();
    await discover(106, "Palace", now);
    await discover(106, "Palace", now + FLEXIBLE_SLOT_MISS_TTL_MS + 1);
    assert.strictEqual(calls.probe, 2, "an expired miss must be re-probed, not trusted forever");
  }
  console.log("PASS: an expired miss-cache entry is retried instead of trusted forever");

  console.log("\nAll inner-building slot discovery fallback tests passed.");
})();
