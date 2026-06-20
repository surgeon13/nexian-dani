const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.resolve(__dirname, "templates");
const PREFERENCES_FILE = path.resolve(TEMPLATES_DIR, "troop_village_preferences.json");

function villageKey(village) {
  const vid = village.id != null ? village.id : village.vid != null ? village.vid : "unknown";
  const x = Number.isFinite(Number(village.x)) ? Number(village.x) : "?";
  const y = Number.isFinite(Number(village.y)) ? Number(village.y) : "?";
  return `${vid}_${x}_${y}`;
}

function loadPreferences() {
  if (!fs.existsSync(PREFERENCES_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(PREFERENCES_FILE, "utf8"));
  } catch (_error) {
    return {};
  }
}

function savePreferences(prefs) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
  fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2), "utf8");
}

function getVillagePreference(village) {
  const prefs = loadPreferences();
  return prefs[villageKey(village)] || null;
}

function clearVillagePreference(village) {
  const prefs = loadPreferences();
  const key = villageKey(village);
  if (!prefs[key]) {
    return false;
  }
  delete prefs[key];
  savePreferences(prefs);
  return true;
}

function normalizePatch(patch) {
  const out = {};
  if (patch.mode !== undefined) {
    out.mode = String(patch.mode).toLowerCase() === "defensive" ? "defensive" : "offensive";
  }
  if (patch.tribe !== undefined) {
    out.tribe = String(patch.tribe || "auto").trim().toLowerCase();
  }
  if (patch.batchSize !== undefined) {
    const n = Math.floor(Number(patch.batchSize));
    if (Number.isFinite(n)) {
      out.batchSize = Math.max(1, Math.min(n, 999999));
    }
  }
  if (patch.roundRobinEnabled !== undefined) {
    out.roundRobinEnabled = Boolean(patch.roundRobinEnabled);
  }
  if (patch.loopMinMinutes !== undefined) {
    const n = Math.floor(Number(patch.loopMinMinutes));
    if (Number.isFinite(n)) {
      out.loopMinMinutes = Math.max(1, Math.min(n, 9999));
    }
  }
  if (patch.loopMaxMinutes !== undefined) {
    const n = Math.floor(Number(patch.loopMaxMinutes));
    if (Number.isFinite(n)) {
      out.loopMaxMinutes = Math.max(1, Math.min(n, 9999));
    }
  }
  const listKeys = [
    "infantryOffensive",
    "infantryDefensive",
    "cavalryOffensive",
    "cavalryDefensive"
  ];
  const lists = {};
  let hasList = false;
  for (const key of listKeys) {
    if (patch[key] !== undefined) {
      lists[key] = String(patch[key] || "").trim();
      hasList = true;
    }
  }
  if (hasList) {
    out.lists = lists;
  }
  return out;
}

function setVillagePreference(village, patch) {
  const prefs = loadPreferences();
  const key = villageKey(village);
  const current = prefs[key] || {};
  const normalized = normalizePatch(patch);
  const lists = {
    ...(current.lists || {}),
    ...(normalized.lists || {})
  };
  const next = {
    ...current,
    vid: village.id != null ? village.id : village.vid,
    coords: {
      x: Number.isFinite(Number(village.x)) ? Number(village.x) : null,
      y: Number.isFinite(Number(village.y)) ? Number(village.y) : null
    },
    villageName: village.name || current.villageName || null,
    updated_at: new Date().toISOString()
  };
  if (normalized.mode !== undefined) {
    next.mode = normalized.mode;
  }
  if (normalized.tribe !== undefined) {
    next.tribe = normalized.tribe;
  }
  if (normalized.batchSize !== undefined) {
    next.batchSize = normalized.batchSize;
  }
  if (normalized.roundRobinEnabled !== undefined) {
    next.roundRobinEnabled = normalized.roundRobinEnabled;
  }
  if (normalized.loopMinMinutes !== undefined) {
    next.loopMinMinutes = normalized.loopMinMinutes;
  }
  if (normalized.loopMaxMinutes !== undefined) {
    next.loopMaxMinutes = normalized.loopMaxMinutes;
  }
  if (Object.keys(lists).length) {
    next.lists = lists;
  }
  prefs[key] = next;
  savePreferences(prefs);
  return next;
}

function resolveSettings(globalSettings, village) {
  const pref = getVillagePreference(village);
  if (!pref) {
    return globalSettings;
  }
  const merged = { ...globalSettings };
  if (pref.mode) {
    merged.troopTemplateMode = pref.mode;
  }
  if (pref.tribe) {
    merged.troopTribe = pref.tribe;
  }
  if (pref.batchSize != null) {
    merged.troopTrainingBatchSize = pref.batchSize;
  }
  const lists = pref.lists || {};
  if (lists.infantryOffensive !== undefined) {
    merged.troopTemplateInfantryOffensive = lists.infantryOffensive;
  }
  if (lists.infantryDefensive !== undefined) {
    merged.troopTemplateInfantryDefensive = lists.infantryDefensive;
  }
  if (lists.cavalryOffensive !== undefined) {
    merged.troopTemplateCavalryOffensive = lists.cavalryOffensive;
  }
  if (lists.cavalryDefensive !== undefined) {
    merged.troopTemplateCavalryDefensive = lists.cavalryDefensive;
  }
  return merged;
}

function hasCustomTroopSettings(village) {
  const pref = getVillagePreference(village);
  if (!pref) {
    return false;
  }
  return Boolean(
    pref.mode ||
      pref.tribe ||
      pref.batchSize != null ||
      (pref.lists && Object.keys(pref.lists).length)
  );
}

function normalizeLoopInterval(minValue, maxValue, fallbackMin, fallbackMax) {
  let min = Number.isFinite(Number(minValue)) ? Math.floor(Number(minValue)) : fallbackMin;
  let max = Number.isFinite(Number(maxValue)) ? Math.floor(Number(maxValue)) : fallbackMax;
  min = Math.max(1, min);
  max = Math.max(1, max);
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return { min, max };
}

function resolveLoopInterval(village, globalSettings) {
  const pref = getVillagePreference(village);
  const fallbackMin = Number(globalSettings?.troopTrainingLoopMinMinutes) || 5;
  const fallbackMax = Number(globalSettings?.troopTrainingLoopMaxMinutes) || 10;
  const hasCustomMin = pref && pref.loopMinMinutes != null;
  const hasCustomMax = pref && pref.loopMaxMinutes != null;
  const minSource = hasCustomMin ? pref.loopMinMinutes : fallbackMin;
  const maxSource = hasCustomMax ? pref.loopMaxMinutes : fallbackMax;
  const normalized = normalizeLoopInterval(minSource, maxSource, fallbackMin, fallbackMax);
  return {
    ...normalized,
    usesGlobalDefault: !hasCustomMin && !hasCustomMax
  };
}

function resolveRoundRobinEnabled(village, defaultEnabled = false) {
  const pref = getVillagePreference(village);
  if (!pref || pref.roundRobinEnabled === undefined) {
    return defaultEnabled;
  }
  return Boolean(pref.roundRobinEnabled);
}

function filterRoundRobinVillages(villages, defaultEnabled = false) {
  return (Array.isArray(villages) ? villages : []).filter((v) =>
    resolveRoundRobinEnabled(v, defaultEnabled)
  );
}

module.exports = {
  PREFERENCES_FILE,
  villageKey,
  loadPreferences,
  savePreferences,
  getVillagePreference,
  setVillagePreference,
  clearVillagePreference,
  resolveSettings,
  hasCustomTroopSettings,
  resolveLoopInterval,
  resolveRoundRobinEnabled,
  filterRoundRobinVillages
};
