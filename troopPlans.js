const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.resolve(__dirname, "templates");
const PLANS_FILE = path.resolve(TEMPLATES_DIR, "troop_plans.json");

const DEFAULT_MIN_MINUTES = 30;
const DEFAULT_MAX_MINUTES = 60;
const DEFAULT_QTY = 10;
const MAX_QTY = 999999;

function villageKey(village) {
  const vid = village && (village.id != null ? village.id : village.vid);
  return String(vid != null ? vid : "unknown");
}

function emptyStore() {
  return { plans: {}, assignments: {} };
}

function loadStore() {
  if (!fs.existsSync(PLANS_FILE)) {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PLANS_FILE, "utf8"));
    return {
      plans: parsed && typeof parsed.plans === "object" && parsed.plans ? parsed.plans : {},
      assignments:
        parsed && typeof parsed.assignments === "object" && parsed.assignments
          ? parsed.assignments
          : {}
    };
  } catch (_error) {
    return emptyStore();
  }
}

function saveStore(store) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
  const safe = {
    plans: store && store.plans ? store.plans : {},
    assignments: store && store.assignments ? store.assignments : {}
  };
  fs.writeFileSync(PLANS_FILE, JSON.stringify(safe, null, 2), "utf8");
}

function normalizeQty(value, fallback = DEFAULT_QTY) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(n, MAX_QTY));
}

function normalizeMinutes(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(n, 9999));
}

function planKeyFromName(name) {
  return String(name || "").trim().toLowerCase();
}

// building -> { unitField, qtyField, label } used by plans and the trainer.
// Cavalry first so raid mounts (TT/Haeduan) are not starved by infantry batches.
// Workshop (Rams/Catapults) last — siege is the least time-sensitive branch and
// should never eat into resources cavalry/infantry need this same tick.
const PLAN_BRANCHES = [
  { building: "stable", unitField: "cavalryUnit", qtyField: "cavalryQty", label: "Stable" },
  {
    building: "great_stable",
    unitField: "greatStableUnit",
    qtyField: "greatStableQty",
    label: "Great Stable"
  },
  { building: "barracks", unitField: "infantryUnit", qtyField: "infantryQty", label: "Barracks" },
  {
    building: "great_barracks",
    unitField: "greatBarracksUnit",
    qtyField: "greatBarracksQty",
    label: "Great Barracks"
  },
  { building: "workshop", unitField: "workshopUnit", qtyField: "workshopQty", label: "Workshop" }
];

function resolveUnitField(patch, current, field) {
  return patch[field] !== undefined
    ? String(patch[field] || "").trim()
    : String(current[field] || "").trim();
}

function resolveQtyField(patch, current, field) {
  return patch[field] !== undefined
    ? normalizeQty(patch[field], current[field] || DEFAULT_QTY)
    : normalizeQty(current[field], DEFAULT_QTY);
}

function normalizePlan(name, patch = {}, current = {}) {
  const next = {
    name: String(name || current.name || "").trim(),
    minMinutes:
      patch.minMinutes !== undefined
        ? normalizeMinutes(patch.minMinutes, current.minMinutes || DEFAULT_MIN_MINUTES)
        : normalizeMinutes(current.minMinutes, DEFAULT_MIN_MINUTES),
    maxMinutes:
      patch.maxMinutes !== undefined
        ? normalizeMinutes(patch.maxMinutes, current.maxMinutes || DEFAULT_MAX_MINUTES)
        : normalizeMinutes(current.maxMinutes, DEFAULT_MAX_MINUTES),
    updatedAt: new Date().toISOString()
  };
  for (const branch of PLAN_BRANCHES) {
    next[branch.unitField] = resolveUnitField(patch, current, branch.unitField);
    next[branch.qtyField] = resolveQtyField(patch, current, branch.qtyField);
  }
  if (next.minMinutes > next.maxMinutes) {
    const t = next.minMinutes;
    next.minMinutes = next.maxMinutes;
    next.maxMinutes = t;
  }
  return next;
}

/** Ordered list of buildings a plan will train, with unit + qty for each. */
function planBranches(plan) {
  if (!plan) {
    return [];
  }
  return PLAN_BRANCHES.filter((b) => String(plan[b.unitField] || "").trim()).map((b) => ({
    building: b.building,
    label: b.label,
    unitName: String(plan[b.unitField]).trim(),
    targetQty: normalizeQty(plan[b.qtyField], DEFAULT_QTY)
  }));
}

function listPlans() {
  const store = loadStore();
  return Object.values(store.plans).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

function getPlan(name) {
  const store = loadStore();
  return store.plans[planKeyFromName(name)] || null;
}

function upsertPlan(name, patch = {}) {
  const key = planKeyFromName(name);
  if (!key) {
    return null;
  }
  const store = loadStore();
  const current = store.plans[key] || {};
  store.plans[key] = normalizePlan(name, patch, current);
  saveStore(store);
  return store.plans[key];
}

function deletePlan(name) {
  const key = planKeyFromName(name);
  const store = loadStore();
  if (!store.plans[key]) {
    return false;
  }
  delete store.plans[key];
  for (const [vk, assignment] of Object.entries(store.assignments)) {
    if (planKeyFromName(assignment.plan) === key) {
      delete store.assignments[vk];
    }
  }
  saveStore(store);
  return true;
}

function getAssignment(village) {
  const store = loadStore();
  return store.assignments[villageKey(village)] || null;
}

function setAssignment(village, patch = {}) {
  const store = loadStore();
  const key = villageKey(village);
  const current = store.assignments[key] || {};
  const next = {
    vid: village && (village.id != null ? village.id : village.vid),
    name: (village && village.name) || current.name || null,
    plan: patch.plan !== undefined ? planKeyFromName(patch.plan) || null : current.plan || null,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled !== false,
    updatedAt: new Date().toISOString()
  };
  store.assignments[key] = next;
  saveStore(store);
  return next;
}

function clearAssignment(village) {
  const store = loadStore();
  const key = villageKey(village);
  if (!store.assignments[key]) {
    return false;
  }
  delete store.assignments[key];
  saveStore(store);
  return true;
}

function resolvePlanForVillage(village) {
  const assignment = getAssignment(village);
  if (!assignment || assignment.enabled === false || !assignment.plan) {
    return null;
  }
  return getPlan(assignment.plan);
}

function isVillageEnabled(village) {
  return Boolean(resolvePlanForVillage(village));
}

function listEnabledVillages(villages) {
  return (Array.isArray(villages) ? villages : []).filter((v) => isVillageEnabled(v));
}

function resolveInterval(plan, fallbackMin = DEFAULT_MIN_MINUTES, fallbackMax = DEFAULT_MAX_MINUTES) {
  const min = normalizeMinutes(plan && plan.minMinutes, fallbackMin);
  const max = normalizeMinutes(plan && plan.maxMinutes, fallbackMax);
  if (min > max) {
    return { min: max, max: min };
  }
  return { min, max };
}

const BRANCH_SHORT_LABEL = {
  barracks: "inf",
  great_barracks: "g.inf",
  stable: "cav",
  great_stable: "g.cav",
  workshop: "siege"
};

function describePlan(plan) {
  if (!plan) {
    return "—";
  }
  const branches = planBranches(plan);
  const parts = branches.map(
    (b) => `${BRANCH_SHORT_LABEL[b.building] || b.building} ${b.unitName} x${b.targetQty}`
  );
  if (!parts.length) {
    parts.push("(no units set)");
  }
  parts.push(`every ${plan.minMinutes}-${plan.maxMinutes}m`);
  return parts.join(" · ");
}

/**
 * Labels of branches this plan has NO unit configured for, so they will be
 * silently absent from planBranches() (and therefore never trained, never
 * logged, never errored). Without surfacing this, a plan created before a
 * branch existed — e.g. any plan predating Workshop support — looks
 * completely normal while quietly never training that branch at all. A real
 * user hit exactly that with Workshop/siege: "nothing shown, nothing is
 * trained."
 */
function describeUnsetBranches(plan) {
  if (!plan) {
    return [];
  }
  return PLAN_BRANCHES.filter((b) => !String(plan[b.unitField] || "").trim()).map((b) => b.label);
}

module.exports = {
  PLANS_FILE,
  DEFAULT_MIN_MINUTES,
  DEFAULT_MAX_MINUTES,
  DEFAULT_QTY,
  villageKey,
  loadStore,
  saveStore,
  listPlans,
  getPlan,
  upsertPlan,
  deletePlan,
  getAssignment,
  setAssignment,
  clearAssignment,
  resolvePlanForVillage,
  isVillageEnabled,
  listEnabledVillages,
  resolveInterval,
  describePlan,
  describeUnsetBranches,
  planBranches,
  PLAN_BRANCHES
};
