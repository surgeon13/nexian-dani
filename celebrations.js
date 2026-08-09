const {
  isResourceExhaustionError,
  safeGotoWithRetry: sharedSafeGotoWithRetry
} = require("./browserNavigation");

const TOWN_HALL_GID = 24;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function withVillageId(url, villageId) {
  if (!villageId) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("vid", String(villageId));
    return parsed.toString();
  } catch (_error) {
    return `${url}${url.includes("?") ? "&" : "?"}vid=${encodeURIComponent(String(villageId))}`;
  }
}

function resolveGameOrigin(settings) {
  const candidates = [
    settings && settings.villageStatusUrl,
    settings && settings.villageBuilderUrl,
    settings && settings.logoutUrl
  ];
  for (const candidate of candidates) {
    try {
      return new URL(String(candidate || "").trim()).origin;
    } catch (_error) {
      // try next
    }
  }
  return "https://s1.nexian.world";
}

function parseVillageIdSet(csv) {
  const set = new Set();
  String(csv || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const n = Number(part);
      if (Number.isFinite(n) && n > 0) {
        set.add(Math.trunc(n));
      }
    });
  return set;
}

function normalizeCelebrationType(raw) {
  const value = String(raw || "auto")
    .trim()
    .toLowerCase();
  if (value === "small" || value === "large" || value === "great") {
    return value === "great" ? "large" : value;
  }
  return "auto";
}

function buildTownHallUrl(settings, villageId) {
  const origin = resolveGameOrigin(settings);
  return withVillageId(`${origin}/build.php?gid=${TOWN_HALL_GID}`, villageId);
}

function filterCelebrationVillages(villages, settings) {
  const list = (Array.isArray(villages) ? villages : []).filter(
    (v) => Number.isFinite(Number(v && v.id)) && Number(v.id) > 0 && !v.underAttack
  );
  const included = parseVillageIdSet(settings && settings.celebrationsIncludedVillageIds);
  const excluded = parseVillageIdSet(settings && settings.celebrationsExcludedVillageIds);
  return list.filter((v) => {
    const id = Number(v.id);
    if (excluded.has(id)) {
      return false;
    }
    if (included.size > 0 && !included.has(id)) {
      return false;
    }
    return true;
  });
}

async function inspectTownHallCelebrations(page, settings, village) {
  const url = buildTownHallUrl(settings, village.id);
  await sharedSafeGotoWithRetry(
    page,
    url,
    { waitUntil: "domcontentloaded", timeout: 60000 },
    2
  );

  return page.evaluate(() => {
    const title = ((document.querySelector("#build h1, #content h1, h1") || {}).textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const bodyText = document.body ? String(document.body.innerText || "") : "";
    const isTownHall = /town\s*hall|city\s*hall/i.test(title) || /town\s*hall|city\s*hall/i.test(bodyText.slice(0, 400));

    const anchors = Array.from(document.querySelectorAll("a")).map((a) => {
      const text = String(a.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const href = String(a.getAttribute("href") || "");
      const parentText = String((a.closest("tr, td, li, div") || a).innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      return { text, href, parentText, className: String(a.className || "") };
    });

    const holdLinks = anchors.filter((a) => /^hold celebration$/i.test(a.text) && a.href && a.href !== "#");
    const classifyHold = (link) => {
      const blob = `${link.parentText} ${link.text}`.toLowerCase();
      if (/large|great/.test(blob)) {
        return "large";
      }
      if (/small/.test(blob)) {
        return "small";
      }
      // Nexian often places costs/label in the row above; inspect nearby table text.
      return /large|great/.test(bodyText) && holdLinks.length > 1 ? "unknown" : "small";
    };

    const holds = holdLinks.map((link) => ({
      href: link.href,
      type: classifyHold(link),
      parentText: link.parentText
    }));

    // Prefer classifying by nearest celebration label rows.
    const smallHold = holds.find((h) => h.type === "small") || null;
    const largeHold =
      holds.find((h) => h.type === "large") ||
      (holds.length > 1 ? holds[holds.length - 1] : null);

    const busy =
      /celebrating/i.test(bodyText) &&
      /duration/i.test(bodyText) &&
      holds.length === 0 &&
      !/not enough resources/i.test(bodyText);

    const noResources = /not enough resources|enough resources in/i.test(bodyText) && holds.length === 0;

    const cultureMatch = bodyText.match(/small celebration\s*\((\d+)\s*culture points?\)/i);
    const largeCultureMatch = bodyText.match(/(?:large|great)\s+celebration\s*\((\d+)\s*culture points?\)/i);

    return {
      ok: isTownHall,
      title,
      busy: Boolean(busy),
      noResources: Boolean(noResources),
      holds,
      smallHold,
      largeHold: largeHold && largeHold !== smallHold ? largeHold : holds.find((h) => h.type === "large") || null,
      canHoldSmall: Boolean(smallHold || (holds.length === 1 && holds[0])),
      canHoldLarge: Boolean(holds.find((h) => h.type === "large") || (holds.length > 1 && holds[1])),
      smallCulturePoints: cultureMatch ? Number(cultureMatch[1]) : null,
      largeCulturePoints: largeCultureMatch ? Number(largeCultureMatch[1]) : null,
      href: location.href
    };
  });
}

function pickHoldTarget(inspect, preferredType) {
  const type = normalizeCelebrationType(preferredType);
  const small = inspect.smallHold || (inspect.holds && inspect.holds[0]) || null;
  const large =
    inspect.largeHold ||
    (inspect.holds || []).find((h) => h.type === "large") ||
    (inspect.holds && inspect.holds.length > 1 ? inspect.holds[1] : null);

  if (type === "large") {
    return large ? { hold: large, type: "large" } : null;
  }
  if (type === "small") {
    return small ? { hold: small, type: "small" } : null;
  }
  // auto: large if available, else small
  if (large) {
    return { hold: large, type: "large" };
  }
  if (small) {
    return { hold: small, type: "small" };
  }
  return null;
}

async function holdCelebrationInVillage(page, settings, village, options = {}) {
  if (!page || page.isClosed()) {
    return { status: "celebration_unavailable", message: "Session page unavailable.", village };
  }
  if (!village || !Number.isFinite(Number(village.id))) {
    return { status: "celebration_no_village", message: "Village id required." };
  }

  const preferredType = normalizeCelebrationType(
    options.type ?? settings.celebrationsType ?? "auto"
  );

  let inspect;
  try {
    inspect = await inspectTownHallCelebrations(page, settings, village);
  } catch (error) {
    if (isResourceExhaustionError(error)) {
      throw error;
    }
    return {
      status: "celebration_error",
      village,
      message: error && error.message ? error.message : String(error)
    };
  }

  if (!inspect.ok) {
    return {
      status: "celebration_no_town_hall",
      village,
      message: `No Town Hall found for ${village.name || village.id}.`,
      title: inspect.title
    };
  }

  if (inspect.busy) {
    return {
      status: "celebration_busy",
      village,
      message: "Celebration already running / cooling down.",
      ...inspect
    };
  }

  const picked = pickHoldTarget(inspect, preferredType);
  if (!picked) {
    if (inspect.noResources) {
      return {
        status: "celebration_no_resources",
        village,
        message: `Not enough resources for ${preferredType} celebration.`,
        preferredType,
        ...inspect
      };
    }
    return {
      status: "celebration_unavailable",
      village,
      message:
        preferredType === "auto"
          ? "No Hold celebration action available."
          : `No ${preferredType} celebration available.`,
      preferredType,
      ...inspect
    };
  }

  const holdUrl = (() => {
    try {
      return withVillageId(new URL(picked.hold.href, page.url()).toString(), village.id);
    } catch (_error) {
      return withVillageId(picked.hold.href, village.id);
    }
  })();

  try {
    await sharedSafeGotoWithRetry(
      page,
      holdUrl,
      { waitUntil: "domcontentloaded", timeout: 60000 },
      2
    );
  } catch (error) {
    if (isResourceExhaustionError(error)) {
      throw error;
    }
    return {
      status: "celebration_error",
      village,
      message: error && error.message ? error.message : String(error),
      preferredType,
      attemptedType: picked.type
    };
  }

  await page.waitForTimeout(700).catch(() => {});

  const after = await page.evaluate(() => {
    const bodyText = document.body ? String(document.body.innerText || "") : "";
    const holdsLeft = Array.from(document.querySelectorAll("a")).some((a) =>
      /^hold celebration$/i.test(String(a.textContent || "").trim())
    );
    const celebrating = /celebrating/i.test(bodyText) && /duration|complete/i.test(bodyText);
    const failed = /not enough resources|cannot|error|failed/i.test(bodyText) && !celebrating;
    return { holdsLeft, celebrating, failed, href: location.href };
  });

  if (after.celebrating || (!after.holdsLeft && !after.failed)) {
    return {
      status: "celebration_ok",
      village,
      message: `Held ${picked.type} celebration.`,
      celebrationType: picked.type,
      culturePoints:
        picked.type === "large" ? inspect.largeCulturePoints : inspect.smallCulturePoints,
      before: inspect,
      after
    };
  }

  if (after.failed || inspect.noResources) {
    return {
      status: "celebration_no_resources",
      village,
      message: `Could not hold ${picked.type} celebration (resources?).`,
      celebrationType: picked.type,
      before: inspect,
      after
    };
  }

  return {
    status: "celebration_failed",
    village,
    message: `Hold ${picked.type} celebration did not confirm.`,
    celebrationType: picked.type,
    before: inspect,
    after
  };
}

/**
 * Round-robin one village per tick. Advances index every check.
 */
async function runCelebrationsRoundRobin(page, settings, villages, state = {}) {
  const candidates = filterCelebrationVillages(villages, settings);
  if (!candidates.length) {
    return {
      status: "celebration_no_candidates",
      message: "No villages available for celebrations RR (check include/exclude filters)."
    };
  }

  let index = Number(state.roundRobinIndex) || 0;
  if (!Number.isFinite(index) || index < 0) {
    index = 0;
  }
  index = ((index % candidates.length) + candidates.length) % candidates.length;
  const village = candidates[index];
  const nextIndex = (index + 1) % candidates.length;

  const result = await holdCelebrationInVillage(page, settings, village, {
    type: settings.celebrationsType
  });

  return {
    ...result,
    roundRobinIndex: nextIndex,
    candidateCount: candidates.length,
    checkedVillageId: village.id,
    checkedVillageName: village.name || null
  };
}

module.exports = {
  TOWN_HALL_GID,
  buildTownHallUrl,
  filterCelebrationVillages,
  inspectTownHallCelebrations,
  holdCelebrationInVillage,
  runCelebrationsRoundRobin,
  normalizeCelebrationType,
  parseVillageIdSet
};
