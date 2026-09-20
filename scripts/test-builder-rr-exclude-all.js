#!/usr/bin/env node
// Isolated verification for the [E] Exclude all action in the Builder RR
// Exclusion menu (terminalMenu.js's runBuilderRrExclusionMenu()).
// Re-implements the exact shipped set-building logic (verbatim), since the
// real handler lives inside a closure that can't be required directly.
//
// If you change this logic in terminalMenu.js, mirror the change here too,
// or this test silently stops verifying the real behavior.
const assert = require("assert");

// Verbatim copy of the shipped [E] handler's set-building line.
function excludeAll(villages) {
  return new Set(
    villages.map((village) => Number(village && village.id)).filter((vid) => Number.isFinite(vid))
  );
}

// 1. A normal village list -- every village id ends up excluded.
{
  const villages = [{ id: 1 }, { id: 2 }, { id: 925 }];
  const result = excludeAll(villages);
  assert.strictEqual(result.size, 3);
  assert.ok(result.has(1) && result.has(2) && result.has(925));
}
console.log("PASS: excludes every village in a normal list");

// 2. An empty village list produces an empty set (no crash).
{
  const result = excludeAll([]);
  assert.strictEqual(result.size, 0);
}
console.log("PASS: an empty village list produces an empty exclusion set, no crash");

// 3. A village with a non-numeric/missing id (Number() -> NaN) is skipped,
// not turned into NaN in the resulting set (which would silently corrupt
// the persisted CSV via formatPivotCsvFromSet). Matches Number()'s own
// coercion rules used consistently elsewhere in this codebase: Number(null)
// is 0 (a real, if unlikely, village id and therefore kept), Number(undefined)
// and Number("not-a-number") are NaN (filtered out).
{
  const villages = [{ id: 1 }, {}, { id: "not-a-number" }, { id: 42 }];
  const result = excludeAll(villages);
  assert.strictEqual(result.size, 2);
  assert.ok(result.has(1) && result.has(42));
  assert.ok(![...result].some((v) => Number.isNaN(v)));
}
console.log("PASS: non-numeric/missing village ids are skipped, not included as NaN");

console.log("\nAll Builder RR exclude-all tests passed.");
