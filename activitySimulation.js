const KNOWN_PATTERNS = {
  status: { label: "Village overview", needsVillage: true, refreshesLocal: true },
  builder: { label: "Village map", needsVillage: true, refreshesLocal: false },
  troops: { label: "Barracks", needsVillage: true, refreshesLocal: false },
  stable: { label: "Stable", needsVillage: true, refreshesLocal: false },
  reports: { label: "Reports", needsVillage: false, refreshesLocal: false },
  statistics: { label: "Statistics", needsVillage: false, refreshesLocal: false }
};

const DEFAULT_PATTERNS = ["status", "builder", "troops", "stable", "reports"];

function withVillageId(url, villageId) {
  if (!villageId) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("vid", String(villageId));
    return parsed.toString();
  } catch (_error) {
    return url;
  }
}

function gameOrigin(settings) {
  try {
    return new URL(settings.villageStatusUrl || settings.farmlistUrl || "https://example.com").origin;
  } catch (_error) {
    return "https://example.com";
  }
}

function parsePatterns(raw) {
  const tokens = String(raw || "")
    .split(/[,;\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const valid = tokens.filter((token) => KNOWN_PATTERNS[token]);
  return valid.length ? valid : DEFAULT_PATTERNS.slice();
}

function serializePatterns(list) {
  const parsed = Array.isArray(list) ? list : parsePatterns(list);
  return parsed.filter((token) => KNOWN_PATTERNS[token]).join(",");
}

function listAvailablePatterns() {
  return Object.entries(KNOWN_PATTERNS).map(([id, meta]) => ({
    id,
    label: meta.label,
    needsVillage: meta.needsVillage
  }));
}

function buildPatternUrl(pattern, settings, villageId) {
  const origin = gameOrigin(settings);
  switch (pattern) {
    case "status":
      return withVillageId(settings.villageStatusUrl, villageId);
    case "builder":
      return withVillageId(settings.villageBuilderUrl, villageId);
    case "troops":
      return withVillageId(settings.troopTrainerUrl, villageId);
    case "stable":
      return withVillageId(settings.troopStableTrainerUrl, villageId);
    case "reports":
      return `${origin}/report`;
    case "statistics":
      return `${origin}/statistics`;
    default:
      return withVillageId(settings.villageStatusUrl, villageId);
  }
}

function randomIntBetween(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  return items[randomIntBetween(0, items.length - 1)];
}

async function scrapePageHints(page) {
  return page
    .evaluate(() => {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.replace(/\u00a0/g, " ").trim() : null;
      };
      return {
        wood: pick("#l4"),
        clay: pick("#l3"),
        iron: pick("#l2"),
        crop: pick("#l1"),
        troopRows: document.querySelectorAll("#troops tbody tr, #troops .unit").length,
        movementRows: document.querySelectorAll("#movements tbody tr").length,
        title: document.title || null
      };
    })
    .catch(() => null);
}

async function runActivityBrowsingStep(getPage, settings, options = {}) {
  const villages = Array.isArray(options.villages) ? options.villages : [];
  const patterns = parsePatterns(settings.activitySimulationPatterns);
  const pattern = pickRandomItem(patterns) || "status";
  const meta = KNOWN_PATTERNS[pattern] || KNOWN_PATTERNS.status;
  const village = meta.needsVillage ? pickRandomItem(villages) : null;
  const villageId = village && village.id != null ? village.id : null;
  const url = buildPatternUrl(pattern, settings, villageId);
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const dwellMinMs = Number.isFinite(Number(settings.activitySimulationDwellMinMs))
    ? Number(settings.activitySimulationDwellMinMs)
    : Number(settings.randomDelayMinMs) || 1500;
  const dwellMaxMs = Number.isFinite(Number(settings.activitySimulationDwellMaxMs))
    ? Number(settings.activitySimulationDwellMaxMs)
    : Number(settings.randomDelayMaxMs) || 5000;
  const dwellMs = randomIntBetween(dwellMinMs, Math.max(dwellMinMs, dwellMaxMs));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(dwellMs);

  const hints = await scrapePageHints(page);

  return {
    pattern,
    patternLabel: meta.label,
    villageId,
    villageName: village ? village.name : null,
    url,
    dwellMs,
    hints,
    shouldRefreshVillages: Boolean(meta.refreshesLocal && villages.length)
  };
}

module.exports = {
  KNOWN_PATTERNS,
  DEFAULT_PATTERNS,
  parsePatterns,
  serializePatterns,
  listAvailablePatterns,
  buildPatternUrl,
  runActivityBrowsingStep
};
