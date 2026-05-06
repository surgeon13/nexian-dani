const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.resolve(__dirname, "templates");
const PROGRESS_FILE = path.resolve(TEMPLATES_DIR, "progress.json");

const PLAN_MODE_VILLAGE = "village";
const PLAN_MODE_RESOURCE = "resource";

const PLAN_DEFAULT_TEMPLATES = {
  [PLAN_MODE_VILLAGE]: "village_stage_00",
  [PLAN_MODE_RESOURCE]: "resource_fields_01"
};

async function safePageWait(page, ms) {
  if (!page || typeof page.waitForTimeout !== "function") {
    throw new Error("Session page is currently unavailable.");
  }
  if (typeof page.isClosed === "function" && page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }
  try {
    await page.waitForTimeout(ms);
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (/has been closed|Target page|browser has been closed|context has been closed/i.test(msg)) {
      throw new Error("Session page is currently unavailable.");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function loadIndex() {
  const indexPath = path.join(TEMPLATES_DIR, "index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Template index not found: ${indexPath}`);
  }
  return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

function loadTemplate(key) {
  const index = loadIndex();
  const entry = index.templates.find((t) => t.key === key);
  if (!entry) {
    throw new Error(`Template key '${key}' not found in index.`);
  }
  if (!entry.enabled) {
    throw new Error(`Template '${key}' is disabled.`);
  }
  const filePath = path.join(TEMPLATES_DIR, entry.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findTemplateEntry(index, key) {
  return index.templates.find((t) => t.key === key) || null;
}

function normalizePlanMode(planMode) {
  return String(planMode || PLAN_MODE_VILLAGE).toLowerCase() === PLAN_MODE_RESOURCE
    ? PLAN_MODE_RESOURCE
    : PLAN_MODE_VILLAGE;
}

function getPlanLabel(planMode) {
  return normalizePlanMode(planMode) === PLAN_MODE_RESOURCE
    ? "resource fields"
    : "village stage";
}

function templateMatchesPlan(templateKey, planMode) {
  const key = String(templateKey || "").toLowerCase();
  const mode = normalizePlanMode(planMode);

  if (mode === PLAN_MODE_RESOURCE) {
    return key.startsWith("resource_fields_");
  }

  return key.startsWith("village_stage_");
}

function isBonusBuildingName(name) {
  const normalized = String(name || "").toLowerCase().trim();
  return (
    normalized === "sawmill" ||
    normalized === "brickyard" ||
    normalized === "iron foundry" ||
    normalized === "grain mill"
  );
}

function resolveDefaultTemplateForPlan(index, planMode) {
  const mode = normalizePlanMode(planMode);
  const preferredKey = PLAN_DEFAULT_TEMPLATES[mode];

  const preferredEntry = findTemplateEntry(index, preferredKey);
  if (preferredEntry && preferredEntry.enabled) {
    return preferredKey;
  }

  if (
    mode === PLAN_MODE_VILLAGE &&
    index.default_template &&
    templateMatchesPlan(index.default_template, PLAN_MODE_VILLAGE)
  ) {
    const defaultEntry = findTemplateEntry(index, index.default_template);
    if (defaultEntry && defaultEntry.enabled) {
      return index.default_template;
    }
  }

  const fallback = index.templates.find((t) => t.enabled && templateMatchesPlan(t.key, mode));
  if (fallback) {
    return fallback.key;
  }

  return null;
}

function getTemplateChain(index, startKey) {
  const chain = [];
  const seen = new Set();
  let key = startKey || index.default_template;

  while (key && !seen.has(key)) {
    const entry = findTemplateEntry(index, key);
    if (!entry || !entry.enabled) {
      break;
    }
    chain.push(key);
    seen.add(key);
    key = entry.next_template || null;
  }

  return chain;
}

function getDefaultTemplateChain(index) {
  return getTemplateChain(index, index.default_template);
}

function listEnabledTemplates() {
  const index = loadIndex();
  return index.templates.filter((t) => t.enabled);
}

// ---------------------------------------------------------------------------
// Progress state (per-village, per-template)
// ---------------------------------------------------------------------------

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch (_error) {
    return {};
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
}

function villageProgressKey(village) {
  const vid = village.id || village.vid || "unknown";
  const x = Number.isFinite(village.x) ? village.x : "?";
  const y = Number.isFinite(village.y) ? village.y : "?";
  return `${vid}_${x}_${y}`;
}

function getVillageProgress(village, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const progress = loadProgress();
  const key = villageProgressKey(village);
  const record = progress[key] || null;

  if (!record) {
    return null;
  }

  if (record.plans && record.plans[mode]) {
    return record.plans[mode];
  }

  // Backward compatibility for legacy single-plan progress shape.
  if (mode === PLAN_MODE_VILLAGE && record.active_template) {
    return {
      active_template: record.active_template,
      stage_index: record.stage_index,
      step_index: record.step_index,
      prereq_validated_template: record.prereq_validated_template,
      completed_template: record.completed_template,
      realigned_from_template: record.realigned_from_template,
      reset_at: record.reset_at,
      updated_at: record.updated_at
    };
  }

  return null;
}

function setVillageProgress(village, data, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const progress = loadProgress();
  const key = villageProgressKey(village);
  const nowIso = new Date().toISOString();
  const current = progress[key] || {};

  const nextRecord = {
    ...current,
    vid: village.id || village.vid,
    coords: {
      x: Number.isFinite(village.x) ? village.x : null,
      y: Number.isFinite(village.y) ? village.y : null
    },
    villageName: village.name || null,
    updated_at: nowIso,
    plans: {
      ...(current.plans || {}),
      [mode]: {
        ...((current.plans && current.plans[mode]) || {}),
        ...data,
        updated_at: nowIso
      }
    }
  };

  // Backward compatibility mirror for legacy callers/data.
  if (mode === PLAN_MODE_VILLAGE) {
    const mirrorKeys = [
      "active_template",
      "stage_index",
      "step_index",
      "prereq_validated_template",
      "completed_template",
      "realigned_from_template",
      "reset_at"
    ];
    mirrorKeys.forEach((keyName) => {
      if (Object.prototype.hasOwnProperty.call(data, keyName)) {
        nextRecord[keyName] = data[keyName];
      }
    });
  }

  progress[key] = nextRecord;
  saveProgress(progress);
}

// ---------------------------------------------------------------------------
// Page reading helpers
// ---------------------------------------------------------------------------

function buildSlotUrl(baseUrl, slotId, villageId) {
  try {
    const parsed = new URL(baseUrl);
    const origin = parsed.origin;
    const slotUrl = new URL(`${origin}/build.php`);
    slotUrl.searchParams.set("id", String(slotId));
    if (villageId) {
      slotUrl.searchParams.set("vid", String(villageId));
    }
    return slotUrl.toString();
  } catch (_error) {
    const base = baseUrl.replace(/\/[^/]*$/, "");
    let url = `${base}/build.php?id=${slotId}`;
    if (villageId) {
      url += `&vid=${villageId}`;
    }
    return url;
  }
}

function buildVillageCenterUrl(baseUrl, villageId) {
  try {
    const parsed = new URL(baseUrl);
    const villageUrl = new URL(`${parsed.origin}/village2.php`);
    if (villageId) {
      villageUrl.searchParams.set("vid", String(villageId));
    }
    return villageUrl.toString();
  } catch (_error) {
    const base = baseUrl.replace(/\/[^/]*$/, "");
    let url = `${base}/village2.php`;
    if (villageId) {
      url += `${url.includes("?") ? "&" : "?"}vid=${encodeURIComponent(String(villageId))}`;
    }
    return url;
  }
}

async function safeGotoWithRetry(page, url, options = {}, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await page.goto(url, options);
      return true;
    } catch (error) {
      lastError = error;
      const msg = String(error && error.message ? error.message : error);
      const transient = /ERR_ABORTED|Execution context was destroyed|Navigation failed because page was closed/i.test(msg);
      if (!transient || attempt >= retries) {
        throw error;
      }
      await page.waitForTimeout(250 + attempt * 250).catch(() => {});
    }
  }
  if (lastError) {
    throw lastError;
  }
  return false;
}

async function readSlotPage(page, baseUrl, slotId, villageId) {
  const url = buildSlotUrl(baseUrl, slotId, villageId);
  await safeGotoWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 60000 }, 2);

  return page.evaluate(() => {
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.replace(/\u00a0/g, " ").trim() : null;
    };

    // Building name & level from the build page header (h1, not h2 which is "Demolish building:")
    const titleEl = document.querySelector("#build h1, #content h1, #build .build_title h1");
    const titleText = titleEl ? titleEl.textContent.replace(/\u00a0/g, " ").trim() : "";

    // Try to parse "Building Name level X" pattern
    const levelMatch = titleText.match(/^(.+?)\s+level\s+(\d+)/i);
    const buildingName = levelMatch ? levelMatch[1].trim() : titleText;
    const currentLevel = levelMatch ? Number(levelMatch[2]) : 0;

    const isConstructionTitle = /construction of a new building|empty building site/i.test(titleText);

    // Check if this is an empty slot (shows building list to construct)
    const isEmptySlot = Boolean(
      document.querySelector("#build .buildingList, #contract_building, .buildingList")
    ) || isConstructionTitle;

    // Upgrade costs — T3.6 format: <img class="r1">825 | <img class="r2">470 | ...
    // Costs live in a <p id="contract"> (the second #contract on the page, after the demolish div)
    const costs = {};
    const contractEls = document.querySelectorAll("#contract");
    const costContainer = contractEls.length > 1 ? contractEls[1] : contractEls[0];
    if (costContainer) {
      const costImgs = costContainer.querySelectorAll("img.r1, img.r2, img.r3, img.r4");
      costImgs.forEach((img) => {
        // The cost value is the text node immediately after the <img>
        let nextNode = img.nextSibling;
        const rawText = nextNode ? (nextNode.textContent || "") : "";
        const costValue = Number(rawText.replace(/[^\d]/g, "")) || 0;
        const className = img.className || "";
        if (/\br1\b/.test(className)) {
          costs.wood = costValue;
        } else if (/\br2\b/.test(className)) {
          costs.clay = costValue;
        } else if (/\br3\b/.test(className)) {
          costs.iron = costValue;
        } else if (/\br4\b/.test(className)) {
          costs.crop = costValue;
        }
      });
    }

    // Current resources from the header bar
    // T3.6 format: <td id="l4" data-v="1439" data-m="12400">1,455/12,400</td>
    // Text is "current/max" — parse the number before the slash
    const parseResCell = (id) => {
      const el = document.querySelector(id);
      if (!el) return { current: 0, max: 0 };
      const current = Number(el.getAttribute("data-v")) || 0;
      const max = Number(el.getAttribute("data-m")) || 0;
      return { current, max };
    };

    const woodRes = parseResCell("#l4");
    const clayRes = parseResCell("#l3");
    const ironRes = parseResCell("#l2");
    const cropRes = parseResCell("#l1");

    const stock = {
      wood: woodRes.current,
      clay: clayRes.current,
      iron: ironRes.current,
      crop: cropRes.current
    };

    // Storage capacities from data-m attributes
    // Warehouse = max of wood/clay/iron (they share the same warehouse)
    // Granary = crop max
    const warehouseCap = Math.max(woodRes.max, clayRes.max, ironRes.max);
    const granaryCap = cropRes.max;

    // Upgrade button — T3.6 uses <a class="build"> "Upgrade to level N"
    const isMasterBuilderElement = (el) => {
      if (!el) {
        return false;
      }
      if (el.closest("#building_contract_mb")) {
        return true;
      }
      const text = String(el.textContent || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();
      const href = String(
        typeof el.getAttribute === "function" ? (el.getAttribute("href") || "") : ""
      ).toLowerCase();
      return (
        text.includes("master builder") ||
        cls.includes("master-builder") ||
        href.includes("mb=1") ||
        href.includes("master")
      );
    };

    const canClick = (element) => Boolean(
      element &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );

    const upgradeCandidates = Array.from(document.querySelectorAll(
      "#build a.build, " +
      "a.build, " +
      "#build button.green.build, " +
      "button.green.build, " +
      ".upgradeButtonsContainer button.green, " +
      "#contract a.build, #contract button.green, #contract a.green, #contract button.build, " +
      "#build .contractLink a, #build .contractLink button"
    ));
    const regularButtons = upgradeCandidates.filter((el) => !isMasterBuilderElement(el));
    const masterBuilderButtons = upgradeCandidates.filter((el) => isMasterBuilderElement(el));
    const hasUpgradeButton = regularButtons.length > 0;
    const hasMasterBuilderUpgradeButton = masterBuilderButtons.length > 0;
    const regularUpgradeButtonClickable = regularButtons.find((el) => canClick(el)) || null;
    const masterBuilderUpgradeButtonClickable = masterBuilderButtons.find((el) => canClick(el)) || null;

    // Is upgrade button disabled?
    const upgradeDisabled = hasUpgradeButton ? !regularUpgradeButtonClickable : true;
    const masterBuilderUpgradeDisabled = hasMasterBuilderUpgradeButton
      ? !masterBuilderUpgradeButtonClickable
      : true;

    // Build queue info (prefer explicit building contract rows when available)
    const queueRows = Array.from(
      document.querySelectorAll(
        "#building_contract tbody tr, #building_contract tr, .under_progress tbody tr, .under_progress tr"
      )
    ).filter((row) =>
      Boolean(row.querySelector("span[id^='timer'], a[href*='build.php?id=']"))
    );
    const masterBuilderQueueRows = Array.from(
      document.querySelectorAll("#building_contract_mb tbody tr, #building_contract_mb tr")
    ).filter((row) =>
      Boolean(row.querySelector("span[id^='timer'], a[href*='build.php?id=']"))
    );
    const legacyQueueItems = document.querySelectorAll(".buildingList .buildDuration");
    const queueTimersFallback = Array.from(
      document.querySelectorAll(
        "#building_contract span[id^='timer'], " +
        "#contract span[id^='timer'], " +
        ".under_progress span[id^='timer'], " +
        "#content .build_details span[id^='timer']"
      )
    ).filter((timer) => {
      const id = String(timer.id || "").toLowerCase();
      if (!id.startsWith("timer")) {
        return false;
      }
      const text = String(timer.textContent || "").trim();
      // Typical build timer format contains colon-separated time, e.g. "00:12:34".
      return /\d+\s*:\s*\d+/.test(text);
    });
    const buildQueueCount = queueRows.length > 0
      ? queueRows.length
      : (legacyQueueItems && legacyQueueItems.length > 0
        ? legacyQueueItems.length
        : queueTimersFallback.length);
    const masterBuilderQueueCount = masterBuilderQueueRows.length;

    // Check for "currently building" based on queue entries, not just container presence.
    const currentlyBuilding = buildQueueCount > 0;

    // Regular queue gold-finish controls
    const goldCompleteButton = document.querySelector(
      "#building_contract thead a[href*='bfs'], " +
      "a[href*='bfs'], a[onclick*='bfs'], button[onclick*='bfs'], " +
      "#build .finishNow a, #build .finishNow button, " +
      ".finishNow a, .finishNow button, " +
      ".instantCompletion a, .instantCompletion button, " +
      "a.gold, button.gold, " +
      "a[onclick*='gold'], button[onclick*='gold'], " +
      "a[onclick*='finish'], button[onclick*='finish'], " +
      "a[href*='gold'], a[href*='finish']"
    );
    const hasGoldComplete = Boolean(
      goldCompleteButton &&
      !goldCompleteButton.classList.contains("disabled") &&
      goldCompleteButton.getAttribute("aria-disabled") !== "true"
    );

    const masterBuilderGoldButton = document.querySelector(
      "#building_contract_mb thead a[href*='bfs'], " +
      "#building_contract_mb a.gold, #building_contract_mb button.gold, " +
      "a.master-builder, button.master-builder"
    );
    const hasMasterBuilderGoldComplete = Boolean(
      masterBuilderGoldButton &&
      !masterBuilderGoldButton.classList.contains("disabled") &&
      masterBuilderGoldButton.getAttribute("aria-disabled") !== "true"
    );

    // Detect if this is a "new building" page with a construction list
    const newBuildingLinks = [];
    if (isEmptySlot) {
      const normalizeText = (value) => String(value || "").replace(/\u00a0/g, " ").trim();

      // T3.6 variant: each option is a <table class="new_building"> with <img title="Warehouse">
      // and <a class="build">Construct building</a>.
      const tableItems = document.querySelectorAll("table.new_building, #contract_building table.new_building");
      tableItems.forEach((table) => {
        const img = table.querySelector("td.bimg img.building, td.bimg img[title], td.bimg img[alt]");
        const bName = img
          ? normalizeText(img.getAttribute("title") || img.getAttribute("alt") || "")
          : "";
        const buildLink = table.querySelector("td.link a.build, a.build[href*='?b='], a.build[href*='&b=']");
        const canBuild = Boolean(
          buildLink &&
          !buildLink.classList.contains("disabled") &&
          buildLink.getAttribute("aria-disabled") !== "true"
        );
        if (bName) {
          newBuildingLinks.push({ name: bName, canBuild });
        }
      });

      // Older variant fallback: building cards with green button.
      if (newBuildingLinks.length === 0) {
        const buildItems = document.querySelectorAll(
          ".buildingList .building, #contract_building .building, .buildingList .innerBox"
        );
        buildItems.forEach((item) => {
          const nameEl = item.querySelector("h2, .name, .tit a, .tit");
          const imgEl = item.querySelector("img.building, img[title], img[alt]");
          const bName = nameEl
            ? normalizeText(nameEl.textContent)
            : normalizeText(imgEl ? (imgEl.getAttribute("title") || imgEl.getAttribute("alt")) : "");
          const buildBtn = item.querySelector("button.green, .contractLink button.green, a.build");
          const canBuild = Boolean(
            buildBtn &&
            !buildBtn.disabled &&
            !buildBtn.classList.contains("disabled") &&
            buildBtn.getAttribute("aria-disabled") !== "true"
          );
          if (bName) {
            newBuildingLinks.push({ name: bName, canBuild });
          }
        });
      }
    }

    return {
      buildingName,
      currentLevel,
      isEmptySlot,
      costs,
      stock,
      warehouseCap,
      granaryCap,
      hasUpgradeButton,
      upgradeDisabled,
      hasMasterBuilderUpgradeButton,
      masterBuilderUpgradeDisabled,
      buildQueueCount,
      masterBuilderQueueCount,
      currentlyBuilding,
      hasGoldComplete,
      hasMasterBuilderGoldComplete,
      newBuildingLinks,
      pageUrl: window.location.href
    };
  });
}

async function validateTemplateEndState(page, baseUrl, villageId, template, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const slots =
    template && template.end_state && Array.isArray(template.end_state.slots)
      ? template.end_state.slots
      : [];

  if (!slots.length) {
    return { ok: true, failures: [] };
  }

  const needsBonusSurvey =
    slots.some((req) => isFlexibleMapBonusBuilding(req && req.building));
  const bonusSurveyRows = needsBonusSurvey
    ? await surveyInnerSlotsFromVillageMap(page, baseUrl, villageId)
    : [];

  const failures = [];
  for (const requirement of slots) {
    let readSlotId = requirement.slot;
    let slotInfo = await readSlotPage(page, baseUrl, readSlotId, villageId);
    const expectedName = requirement.building;
    const expectedMinLevel = Number(requirement.min_level) || 0;
    const genericResourceNameMatch =
      mode === PLAN_MODE_RESOURCE &&
      isResourceFieldSlot(requirement.slot) &&
      isResourceFieldBuildingName(expectedName);
    let nameOk = genericResourceNameMatch
      ? isResourceFieldBuildingName(slotInfo.buildingName)
      : isSameBuildingName(slotInfo.buildingName, expectedName);
    let levelOk = Number(slotInfo.currentLevel) >= expectedMinLevel;

    if (!nameOk && isFlexibleMapBonusBuilding(expectedName) && bonusSurveyRows.length) {
      const mapped = resolveBonusBuildingSlotFromSurvey(bonusSurveyRows, expectedName);
      if (mapped != null && mapped !== readSlotId) {
        readSlotId = mapped;
        slotInfo = await readSlotPage(page, baseUrl, readSlotId, villageId);
        nameOk = genericResourceNameMatch
          ? isResourceFieldBuildingName(slotInfo.buildingName)
          : isSameBuildingName(slotInfo.buildingName, expectedName);
        levelOk = Number(slotInfo.currentLevel) >= expectedMinLevel;
      }
    }

    if (!nameOk || !levelOk) {
      failures.push({
        slot: requirement.slot,
        expectedBuilding: expectedName,
        expectedMinLevel,
        actualBuilding: slotInfo.buildingName || "unknown",
        actualLevel: Number(slotInfo.currentLevel) || 0
      });
    }
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

/**
 * Clamp corrupt stage/step indices (NaN, negatives, past template end) using live slot reads.
 * Without this, resolveNextStep can return null on garbage like stage_index=999 → false "all_complete".
 */
async function reconcileTemplateProgressIndices(
  page,
  baseUrl,
  villageId,
  template,
  villageProgress,
  options = {}
) {
  const mode = normalizePlanMode(options.planMode);

  let stageIndex = Number(villageProgress && villageProgress.stage_index);
  let stepIndex = Number(villageProgress && villageProgress.step_index);
  if (!Number.isFinite(stageIndex) || stageIndex < 0) {
    stageIndex = 0;
  }
  if (!Number.isFinite(stepIndex) || stepIndex < 0) {
    stepIndex = 0;
  }

  let changed = false;
  const nStages = Array.isArray(template.stages) ? template.stages.length : 0;

  if (nStages === 0) {
    return { changed: false, stageIndex: 0, stepIndex: 0 };
  }

  if (stageIndex >= nStages) {
    const validation = await validateTemplateEndState(page, baseUrl, villageId, template, {
      planMode: mode
    });
    if (validation.ok) {
      // Keep indices past the end so resolveNextStep returns null and completion
      // handling can advance to template.next_template.
      stageIndex = nStages;
      stepIndex = 0;
      changed = true;
    } else {
      stageIndex = Math.max(0, nStages - 1);
      const lastStage = template.stages[stageIndex];
      const nSteps = Array.isArray(lastStage && lastStage.steps) ? lastStage.steps.length : 0;
      stepIndex = nSteps > 0 ? nSteps - 1 : 0;
      changed = true;
    }
  } else {
    const stage = template.stages[stageIndex];
    if (!stage || !Array.isArray(stage.steps) || stepIndex >= stage.steps.length) {
      stepIndex = 0;
      changed = true;
    }
  }

  return { changed, stageIndex, stepIndex };
}

async function findFirstUnmetPrerequisiteTemplate(
  page,
  baseUrl,
  villageId,
  index,
  activeTemplateKey,
  chainStartKey,
  options = {}
) {
  const mode = normalizePlanMode(options.planMode);
  const chain = getTemplateChain(index, chainStartKey || index.default_template);
  const activeIndex = chain.indexOf(activeTemplateKey);

  // If template isn't in the default chain (or is already first), do not gate here.
  if (activeIndex <= 0) {
    return null;
  }

  for (let i = 0; i < activeIndex; i++) {
    const key = chain[i];
    const template = loadTemplate(key);
    const validation = await validateTemplateEndState(page, baseUrl, villageId, template, {
      planMode: mode
    });
    if (!validation.ok) {
      return {
        templateKey: key,
        failures: validation.failures
      };
    }
  }

  return null;
}

async function syncProgressToWorldState(getPage, settings, village, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const planLabel = getPlanLabel(mode);
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const index = loadIndex();
  const defaultTemplateKey = resolveDefaultTemplateForPlan(index, mode);
  if (!defaultTemplateKey) {
    return {
      status: "error",
      message: `No enabled ${planLabel} template chain found in templates/index.json.`
    };
  }

  const baseUrl = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  const villageProgress = getVillageProgress(village, { planMode: mode });

  let activeTemplateKey;
  if (
    villageProgress &&
    villageProgress.active_template &&
    templateMatchesPlan(villageProgress.active_template, mode)
  ) {
    activeTemplateKey = villageProgress.active_template;
  } else {
    activeTemplateKey = defaultTemplateKey;
  }

  const unmet = await findFirstUnmetPrerequisiteTemplate(
    page,
    baseUrl,
    village.id,
    index,
    activeTemplateKey,
    defaultTemplateKey,
    { planMode: mode }
  );

  if (unmet) {
    setVillageProgress(village, {
      active_template: unmet.templateKey,
      stage_index: 0,
      step_index: 0,
      prereq_validated_template: null,
      realigned_from_template: activeTemplateKey
    }, {
      planMode: mode
    });

    return {
      status: "realigned",
      activeTemplate: unmet.templateKey,
      message:
        `Progress pointed to '${activeTemplateKey}' in ${planLabel} plan, but prior template requirements are not met. ` +
        `Realigned to '${unmet.templateKey}' from stage 1.`,
      unmet
    };
  }

  let template = loadTemplate(activeTemplateKey);

  const reconciled = await reconcileTemplateProgressIndices(
    page,
    baseUrl,
    village.id,
    template,
    villageProgress,
    { planMode: mode }
  );

  if (reconciled.changed) {
    setVillageProgress(village, {
      active_template: activeTemplateKey,
      stage_index: reconciled.stageIndex,
      step_index: reconciled.stepIndex,
      prereq_validated_template: activeTemplateKey
    }, {
      planMode: mode
    });
  }

  return {
    status: reconciled.changed ? "normalized" : "ok",
    activeTemplate: activeTemplateKey,
    stageIndex: reconciled.stageIndex,
    stepIndex: reconciled.stepIndex
  };
}

// ---------------------------------------------------------------------------
// Guard checks
// ---------------------------------------------------------------------------

function checkStorageCapacity(slotInfo, costs) {
  const issues = [];
  const warehouseResources = ["wood", "clay", "iron"];

  warehouseResources.forEach((res) => {
    if (costs[res] && costs[res] > slotInfo.warehouseCap) {
      issues.push(
        `${res} cost (${costs[res]}) exceeds Warehouse capacity (${slotInfo.warehouseCap})`
      );
    }
  });

  if (costs.crop && costs.crop > slotInfo.granaryCap) {
    issues.push(
      `crop cost (${costs.crop}) exceeds Granary capacity (${slotInfo.granaryCap})`
    );
  }

  return issues;
}

function checkResourceSufficiency(slotInfo, costs) {
  const deficit = {};
  let sufficient = true;

  ["wood", "clay", "iron", "crop"].forEach((res) => {
    const cost = costs[res] || 0;
    const have = slotInfo.stock[res] || 0;
    if (cost > have) {
      deficit[res] = cost - have;
      sufficient = false;
    }
  });

  return { sufficient, deficit };
}

// ---------------------------------------------------------------------------
// Step resolver — find first unfinished step in strict order
// ---------------------------------------------------------------------------

function resolveNextStep(template, villageProgress) {
  const nStages = Array.isArray(template.stages) ? template.stages.length : 0;
  if (nStages === 0) {
    return null;
  }

  let startStageIndex = Number(villageProgress && villageProgress.stage_index);
  let startStepIndex = Number(villageProgress && villageProgress.step_index);
  if (!Number.isFinite(startStageIndex) || startStageIndex < 0) {
    startStageIndex = 0;
  }
  if (!Number.isFinite(startStepIndex) || startStepIndex < 0) {
    startStepIndex = 0;
  }
  if (startStageIndex >= nStages) {
    startStageIndex = nStages - 1;
    startStepIndex = 0;
  }

  for (let si = startStageIndex; si < template.stages.length; si++) {
    const stage = template.stages[si];
    const stepStart = si === startStageIndex ? startStepIndex : 0;

    for (let sti = stepStart; sti < stage.steps.length; sti++) {
      return {
        stageIndex: si,
        stepIndex: sti,
        stageName: stage.name,
        step: stage.steps[sti],
        isLast:
          si === template.stages.length - 1 &&
          sti === stage.steps.length - 1
      };
    }
  }

  return null; // Template fully completed
}

function normalizeBuildingName(name) {
  const normalized = String(name || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  // Legacy template compatibility: some plans still use "Blacksmith" for the Smithy slot.
  if (normalized.replace(/\s+/g, "") === "blacksmith") {
    return "smithy";
  }

  return normalized;
}

function isSameBuildingName(actual, expected) {
  const a = normalizeBuildingName(actual);
  const e = normalizeBuildingName(expected);
  if (!a || !e) {
    return false;
  }

  if (a === e) {
    return true;
  }

  // Some UIs display variants like "townhall" vs "town hall".
  const compactA = a.replace(/\s+/g, "");
  const compactE = e.replace(/\s+/g, "");
  if (compactA === compactE) {
    return true;
  }

  const cropBonus = new Set(["grainmill", "bakery"]);
  if (cropBonus.has(compactA) && cropBonus.has(compactE)) {
    return true;
  }

  return false;
}

function isResourceFieldSlot(slot) {
  const id = Number(slot);
  return Number.isFinite(id) && id >= 1 && id <= 18;
}

function compactBuildingName(name) {
  return normalizeBuildingName(name).replace(/\s+/g, "");
}

function isResourceFieldBuildingName(name) {
  const compact = compactBuildingName(name);
  return compact === "woodcutter" || compact === "claypit" || compact === "ironmine" || compact === "cropland";
}

function isUnknownBuildingName(name) {
  const compact = compactBuildingName(name);
  return !compact || compact === "unknown";
}

/**
 * Bonus production buildings land on tribe-dependent inner slots. Templates often use Roman slot ids;
 * discover the actual slot from the village map tooltip (same idea as barracks discovery in terminalMenu).
 */
function isFlexibleMapBonusBuilding(name) {
  const c = compactBuildingName(name);
  return (
    c === "sawmill" ||
    c === "brickyard" ||
    c === "ironfoundry" ||
    c === "grainmill" ||
    c === "bakery"
  );
}

async function surveyInnerSlotsFromVillageMap(page, baseUrl, villageId) {
  if (!villageId) {
    return [];
  }
  const centerUrl = buildVillageCenterUrl(baseUrl, villageId);
  await safeGotoWithRetry(page, centerUrl, { waitUntil: "domcontentloaded", timeout: 60000 }, 2);

  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "").replace(/\u00a0/g, " ").trim();
    const areas = Array.from(
      document.querySelectorAll("map#map2 area[href*='build.php?id='], area[href*='build.php?id=']")
    );
    const out = [];
    for (const area of areas) {
      const href = area.getAttribute("href") || "";
      const match = href.match(/[?&]id=(\d+)/i);
      const slotId = match ? Number(match[1]) : null;
      if (!Number.isFinite(slotId)) {
        continue;
      }
      // Resource fields 1–18 are never home to these bonuses; skips map noise there.
      if (slotId < 19) {
        continue;
      }
      const title = normalize(area.getAttribute("title") || "");
      const alt = normalize(area.getAttribute("alt") || "");
      const label = `${title} ${alt}`
        .replace(/\blevel\s+\d+\b/gi, " ")
        .replace(/\blvl\.?\s*\d+\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      out.push({ slotId, label });
    }
    return out;
  });
}

function resolveBonusBuildingSlotFromSurvey(rows, buildingName) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const match = rows.find((row) => isSameBuildingName(row.label, buildingName));
  return match ? match.slotId : null;
}

async function discoverBonusBuildingSlotFromMap(page, baseUrl, villageId, buildingName) {
  if (!buildingName || !isFlexibleMapBonusBuilding(buildingName)) {
    return null;
  }
  const survey = await surveyInnerSlotsFromVillageMap(page, baseUrl, villageId);
  return resolveBonusBuildingSlotFromSurvey(survey, buildingName);
}

/**
 * Discover inner-village slot id for a fixed building (Barracks, Academy, …) from the village map.
 */
async function discoverInnerBuildingSlotFromMap(page, baseUrl, villageId, buildingName) {
  if (!buildingName || !villageId) {
    return null;
  }
  const survey = await surveyInnerSlotsFromVillageMap(page, baseUrl, villageId);
  const match = survey.find((row) => isSameBuildingName(row.label, buildingName));
  return match ? match.slotId : null;
}

function findTemplateSlotForBuilding(template, buildingName) {
  if (!template || !Array.isArray(template.stages)) {
    return null;
  }
  for (const stage of template.stages) {
    if (!stage || !Array.isArray(stage.steps)) {
      continue;
    }
    for (const s of stage.steps) {
      if (isSameBuildingName(s.building, buildingName)) {
        const id = Number(s.slot);
        return Number.isFinite(id) ? id : null;
      }
    }
  }
  return null;
}

function findFirstStageStepForBuildingTarget(template, buildingName, targetLevel) {
  const tl = Number(targetLevel);
  if (!Number.isFinite(tl) || !template || !Array.isArray(template.stages)) {
    return null;
  }
  for (let si = 0; si < template.stages.length; si++) {
    const stage = template.stages[si];
    if (!stage || !Array.isArray(stage.steps)) {
      continue;
    }
    for (let sti = 0; sti < stage.steps.length; sti++) {
      const s = stage.steps[sti];
      if (isSameBuildingName(s.building, buildingName) && Number(s.target_level) === tl) {
        return { stageIndex: si, stepIndex: sti };
      }
    }
  }
  return null;
}

/**
 * Nexian / Travian-style locks on empty slots: e.g. Academy requires Barracks level 3 before it becomes buildable.
 * When progress points at Academy but the UI leaves it locked for that reason, realign to the template step that satisfies the prereq.
 */
function getNewBuildingGamePrerequisite(buildingName) {
  if (isSameBuildingName(buildingName, "Academy")) {
    return {
      requiresBuilding: "Barracks",
      minLevel: 3,
      templateTargetLevel: 3
    };
  }
  return null;
}

async function readPrerequisiteBuildingLevel(page, baseUrl, villageId, template, requiresBuilding) {
  const fromMap = await discoverInnerBuildingSlotFromMap(page, baseUrl, villageId, requiresBuilding);
  const fromTemplate = findTemplateSlotForBuilding(template, requiresBuilding);
  const tried = new Set();
  for (const slotId of [fromMap, fromTemplate]) {
    if (!Number.isFinite(Number(slotId)) || tried.has(Number(slotId))) {
      continue;
    }
    tried.add(Number(slotId));
    const info = await readSlotPage(page, baseUrl, Number(slotId), villageId);
    if (info.isEmptySlot) {
      return 0;
    }
    if (isSameBuildingName(info.buildingName, requiresBuilding)) {
      return Number(info.currentLevel) || 0;
    }
  }
  return 0;
}

async function tryRealignForLockedNewBuildingPrerequisite(
  page,
  baseUrl,
  village,
  template,
  activeTemplateKey,
  step,
  report,
  planMode
) {
  const mode = normalizePlanMode(planMode);
  if (mode !== PLAN_MODE_VILLAGE) {
    return null;
  }

  const prereq = getNewBuildingGamePrerequisite(step.building);
  if (!prereq) {
    return null;
  }

  const currentLevel = await readPrerequisiteBuildingLevel(
    page,
    baseUrl,
    village.id,
    template,
    prereq.requiresBuilding
  );

  if (currentLevel >= prereq.minLevel) {
    return null;
  }

  const jump = findFirstStageStepForBuildingTarget(
    template,
    prereq.requiresBuilding,
    prereq.templateTargetLevel
  );

  if (!jump) {
    return null;
  }

  setVillageProgress(
    village,
    {
      active_template: activeTemplateKey,
      stage_index: jump.stageIndex,
      step_index: jump.stepIndex,
      prereq_validated_template: null,
      realigned_from_template: activeTemplateKey
    },
    { planMode: mode }
  );

  return {
    status: "realigned_template",
    report,
    message:
      `Target building '${step.building}' is locked until ${prereq.requiresBuilding} reaches level ${prereq.minLevel} ` +
      `(currently ${currentLevel}). Realigning to Stage ${jump.stageIndex + 1} (${prereq.requiresBuilding} → ${prereq.templateTargetLevel}).`
  };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function executeUpgradeClick(page, options = {}) {
  const { allowMasterBuilder = false } = options;

  const clicked = await page.evaluate((allowMb) => {
    const isMasterBuilderElement = (el) => {
      if (!el) {
        return false;
      }
      if (el.closest("#building_contract_mb")) {
        return true;
      }
      const text = String(el.textContent || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();
      const href = String(
        typeof el.getAttribute === "function" ? (el.getAttribute("href") || "") : ""
      ).toLowerCase();
      return (
        text.includes("master builder") ||
        cls.includes("master-builder") ||
        href.includes("mb=1") ||
        href.includes("master")
      );
    };

    const canClick = (element) => Boolean(
      element &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );

    const candidates = Array.from(document.querySelectorAll(
      "#build a.build, " +
      "a.build, " +
      "#build button.green.build, " +
      "button.green.build, " +
      ".upgradeButtonsContainer button.green, " +
      "#contract a.build, #contract button.green, #contract a.green, #contract button.build, " +
      "#build .contractLink a, #build .contractLink button"
    ));
    const btn = candidates.find((el) => {
      if (!canClick(el)) {
        return false;
      }
      if (!allowMb && isMasterBuilderElement(el)) {
        return false;
      }
      return true;
    }) || null;

    // T3.6: upgrade link is <a class="build"> "Upgrade to level N"
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, allowMasterBuilder);

  if (clicked) {
    await safePageWait(page, 2000);
  }

  return clicked;
}

async function executeNewBuildingClick(page, buildingName, options = {}) {
  const { allowMasterBuilder = false } = options;

  const clicked = await page.evaluate(({ targetName, allowMb }) => {
    const normalize = (value) => {
      const normalized = String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");

      if (normalized.replace(/\s+/g, "") === "blacksmith") {
        return "smithy";
      }

      return normalized;
    };

    const targetNormalized = normalize(targetName);
    const targetCompact = targetNormalized.replace(/\s+/g, "");

    const isTarget = (name) => {
      const normalizedName = normalize(name);
      const compactName = normalizedName.replace(/\s+/g, "");
      return normalizedName === targetNormalized || compactName === targetCompact;
    };

    const canClick = (element) => Boolean(
      element &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );

    const isMasterBuilderElement = (el) => {
      if (!el) {
        return false;
      }
      if (el.closest("#building_contract_mb")) {
        return true;
      }
      const text = String(el.textContent || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();
      const href = String(
        typeof el.getAttribute === "function" ? (el.getAttribute("href") || "") : ""
      ).toLowerCase();
      return (
        text.includes("master builder") ||
        cls.includes("master-builder") ||
        href.includes("mb=1") ||
        href.includes("master")
      );
    };

    // T3.6 variant: options rendered as <table class="new_building">.
    const tableItems = document.querySelectorAll("table.new_building, #contract_building table.new_building");
    for (const table of tableItems) {
      const img = table.querySelector("td.bimg img.building, td.bimg img[title], td.bimg img[alt]");
      const name = img
        ? (img.getAttribute("title") || img.getAttribute("alt") || "")
        : "";

      if (isTarget(name)) {
        const buildCandidates = Array.from(
          table.querySelectorAll("td.link a.build, a.build[href*='?b='], a.build[href*='&b=']")
        );
        const buildLink = buildCandidates.find((el) => allowMb || !isMasterBuilderElement(el)) || null;
        if (canClick(buildLink)) {
          buildLink.click();
          return true;
        }
      }
    }

    const items = document.querySelectorAll(
      ".buildingList .building, #contract_building .building, .buildingList .innerBox"
    );

    for (const item of items) {
      const nameEl = item.querySelector("h2, .name, .tit a, .tit");
      const name = nameEl
        ? nameEl.textContent.replace(/\u00a0/g, " ").trim().toLowerCase()
        : "";

      const isMatch = isTarget(name);

      if (isMatch) {
        const candidates = Array.from(
          item.querySelectorAll("button.green, .contractLink button.green, a.build")
        );
        const btn = candidates.find((el) => allowMb || !isMasterBuilderElement(el)) || null;
        if (canClick(btn)) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  }, { targetName: buildingName, allowMb: allowMasterBuilder });

  if (clicked) {
    await safePageWait(page, 2000);
  }

  return clicked;
}

async function executeGoldComplete(page, options = {}) {
  const { allowMasterBuilder = false } = options;

  const action = await page.evaluate((allowMb) => {
    const canClick = (el) => Boolean(
      el &&
      !el.disabled &&
      !el.classList.contains("disabled") &&
      el.getAttribute("aria-disabled") !== "true"
    );

    const isMasterBuilderElement = (el) => {
      if (!el) {
        return false;
      }
      if (el.closest("#building_contract_mb")) {
        return true;
      }
      const cls = String(el.className || "").toLowerCase();
      const href = String(
        typeof el.getAttribute === "function" ? (el.getAttribute("href") || "") : ""
      ).toLowerCase();
      return cls.includes("master-builder") || href.includes("master");
    };

    const pickCandidate = (selector) => {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const el of elements) {
        if (!canClick(el)) {
          continue;
        }
        if (!allowMb && isMasterBuilderElement(el)) {
          continue;
        }
        return el;
      }
      return null;
    };
    const parseGoldCost = (el) => {
      if (!el) {
        return null;
      }
      const text = [
        el.getAttribute && (el.getAttribute("title") || ""),
        el.getAttribute && (el.getAttribute("alt") || ""),
        el.textContent || ""
      ].join(" ");
      const m = String(text).match(/cost\s*(\d+)\s*gold/i);
      if (m) {
        const amount = Number(m[1]);
        return Number.isFinite(amount) ? amount : null;
      }
      return null;
    };

    const bfsLink = pickCandidate("#building_contract thead a[href*='bfs']");
    if (canClick(bfsLink)) {
      const bfsHref = bfsLink.getAttribute("href") || null;
      const isJavascriptHref = typeof bfsHref === "string" && bfsHref.trim().toLowerCase().startsWith("javascript:");
      if (isJavascriptHref) {
        bfsLink.click();
        return { mode: "click", goldCost: parseGoldCost(bfsLink) };
      }
      return {
        mode: "href",
        href: bfsHref,
        goldCost: parseGoldCost(bfsLink)
      };
    }

    if (allowMb) {
      const mbBfsLink = pickCandidate("#building_contract_mb thead a[href*='bfs']");
      if (canClick(mbBfsLink)) {
        const mbHref = mbBfsLink.getAttribute("href") || null;
        const isJavascriptHref = typeof mbHref === "string" && mbHref.trim().toLowerCase().startsWith("javascript:");
        if (isJavascriptHref) {
          mbBfsLink.click();
          return { mode: "click", goldCost: parseGoldCost(mbBfsLink) };
        }
        return {
          mode: "href",
          href: mbHref,
          goldCost: parseGoldCost(mbBfsLink)
        };
      }
    }

    const btn = pickCandidate(
      "a[href*='bfs'], a[onclick*='bfs'], button[onclick*='bfs'], " +
      "#build .finishNow a, #build .finishNow button, " +
      ".finishNow a, .finishNow button, " +
      ".instantCompletion a, .instantCompletion button, " +
      "a.gold, button.gold, a.master-builder, button.master-builder, " +
      "a[onclick*='gold'], button[onclick*='gold'], " +
      "a[onclick*='finish'], button[onclick*='finish'], " +
      "a[href*='gold'], a[href*='finish']"
    );
    if (!canClick(btn)) {
      return null;
    }

    const href = typeof btn.getAttribute === "function"
      ? btn.getAttribute("href")
      : null;
    const isJavascriptHref = typeof href === "string" && href.trim().toLowerCase().startsWith("javascript:");
    if (href && !isJavascriptHref) {
      return {
        mode: "href",
        href,
        goldCost: parseGoldCost(btn)
      };
    }

    btn.click();
    return {
      mode: "click",
      goldCost: parseGoldCost(btn)
    };
  }, allowMasterBuilder);

  if (!action) {
    // Fallback: some templates expose village-wide BFS only on village1.php,
    // while build.php pages may not show a clickable control.
    try {
      const current = new URL(page.url());
      const fallbackUrl = new URL(`${current.origin}/village1.php`);
      const currentVid = current.searchParams.get("vid");
      if (currentVid) {
        fallbackUrl.searchParams.set("vid", currentVid);
      }
      await page.goto(fallbackUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      const fallbackAction = await page.evaluate((allowMb) => {
        const canClick = (el) => Boolean(
          el &&
          !el.disabled &&
          !el.classList.contains("disabled") &&
          el.getAttribute("aria-disabled") !== "true"
        );
        const isMasterBuilderElement = (el) => {
          if (!el) {
            return false;
          }
          if (el.closest("#building_contract_mb")) {
            return true;
          }
          const cls = String(el.className || "").toLowerCase();
          const href = String(
            typeof el.getAttribute === "function" ? (el.getAttribute("href") || "") : ""
          ).toLowerCase();
          return cls.includes("master-builder") || href.includes("master");
        };
        const parseGoldCost = (el) => {
          if (!el) {
            return null;
          }
          const text = [
            el.getAttribute && (el.getAttribute("title") || ""),
            el.getAttribute && (el.getAttribute("alt") || ""),
            el.textContent || ""
          ].join(" ");
          const m = String(text).match(/cost\s*(\d+)\s*gold/i);
          if (m) {
            const amount = Number(m[1]);
            return Number.isFinite(amount) ? amount : null;
          }
          return null;
        };
        const candidates = Array.from(document.querySelectorAll(
          "a[href*='bfs'], a[onclick*='bfs'], button[onclick*='bfs'], " +
          "a[href*='gold'], a[href*='finish'], a.gold, button.gold"
        ));
        const btn = candidates.find((el) => canClick(el) && (allowMb || !isMasterBuilderElement(el))) || null;
        if (!btn) {
          return null;
        }
        const href = typeof btn.getAttribute === "function" ? btn.getAttribute("href") : null;
        const isJavascriptHref = typeof href === "string" && href.trim().toLowerCase().startsWith("javascript:");
        if (href && !isJavascriptHref) {
          return { mode: "href", href, goldCost: parseGoldCost(btn) };
        }
        btn.click();
        return { mode: "click", goldCost: parseGoldCost(btn) };
      }, allowMasterBuilder);

      if (!fallbackAction) {
        return { clicked: false, goldCost: 0 };
      }
      if (fallbackAction.mode === "href" && fallbackAction.href) {
        const targetUrl = new URL(fallbackAction.href, page.url()).toString();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      } else {
        await safePageWait(page, 1500);
      }
      await safePageWait(page, 2000);
      const fallbackSpent = Number.isFinite(Number(fallbackAction.goldCost)) ? Number(fallbackAction.goldCost) : 0;
      return { clicked: true, goldCost: fallbackSpent };
    } catch (_error) {
      return { clicked: false, goldCost: 0 };
    }
  }

  if (action.mode === "href" && action.href) {
    const targetUrl = new URL(action.href, page.url()).toString();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  } else {
    await safePageWait(page, 1500);
  }

  // Try to confirm the gold dialog if one appears.
  await page.evaluate(() => {
    const confirmCandidates = Array.from(document.querySelectorAll(
      ".dialogButtonOk, .modalContent button.green, .modalContent a.green, " +
      "button.gold.ok, a.gold.ok, #dialogContent button.green, #dialogContent a.green, " +
      "#dialogContent .dialogButtons a, #dialogContent .dialogButtons button, " +
      ".dialogButtons button, .dialogButtons a"
    ));
    const confirmBtn = confirmCandidates.find((el) =>
      el &&
      !el.disabled &&
      !el.classList.contains("disabled") &&
      el.getAttribute("aria-disabled") !== "true"
    );
    if (confirmBtn && typeof confirmBtn.click === "function") {
      confirmBtn.click();
    }
  }).catch(() => {});

  await safePageWait(page, 2000);

  const spent = Number.isFinite(Number(action.goldCost)) ? Number(action.goldCost) : 0;
  return { clicked: true, goldCost: spent };
}

// ---------------------------------------------------------------------------
// Main builder orchestration
// ---------------------------------------------------------------------------

async function runBuilderStep(getPage, settings, village, options = {}) {
  const {
    goldCompleteEnabled = false,
    goldCompleteMax = 3,
    masterBuilderEnabled = false,
    dryRun = false,
    planMode = PLAN_MODE_VILLAGE
  } = options;
  const mode = normalizePlanMode(planMode);
  const planLabel = getPlanLabel(mode);
  // Keep MB queueing strictly controlled by explicit MB setting.
  // Gold-complete may still use MB finish controls when enabled.
  const allowMasterBuilderBuildActions = Boolean(masterBuilderEnabled);
  const allowMasterBuilderGoldActions = Boolean(masterBuilderEnabled || goldCompleteEnabled);

  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  // Load progress for this village
  let villageProgress = getVillageProgress(village, { planMode: mode });
  const index = loadIndex();
  const defaultTemplateKey = resolveDefaultTemplateForPlan(index, mode);

  if (!defaultTemplateKey) {
    return {
      status: "error",
      message: `No enabled ${planLabel} template chain found in templates/index.json.`
    };
  }

  // Determine active template
  let activeTemplateKey;
  if (
    villageProgress &&
    villageProgress.active_template &&
    templateMatchesPlan(villageProgress.active_template, mode)
  ) {
    activeTemplateKey = villageProgress.active_template;
  } else {
    activeTemplateKey = defaultTemplateKey;
  }

  const baseUrl = settings.villageBuilderUrl || "https://nexian.world/village2.php";

  // Stage gate: if progress points to a later template, verify all previous template
  // end-states are actually complete for this village. If not, realign progress.
  if (
    !villageProgress ||
    villageProgress.prereq_validated_template !== activeTemplateKey
  ) {
    const unmet = await findFirstUnmetPrerequisiteTemplate(
      page,
      baseUrl,
      village.id,
      index,
      activeTemplateKey,
      defaultTemplateKey,
      { planMode: mode }
    );

    if (unmet) {
      setVillageProgress(village, {
        active_template: unmet.templateKey,
        stage_index: 0,
        step_index: 0,
        prereq_validated_template: null,
        realigned_from_template: activeTemplateKey
      }, {
        planMode: mode
      });

      return {
        status: "realigned_template",
        message:
          `Progress pointed to '${activeTemplateKey}' in ${planLabel} plan, but prior template requirements are not met. ` +
          `Realigned to '${unmet.templateKey}' from stage 1.`,
        unmet
      };
    }

    setVillageProgress(village, {
      active_template: activeTemplateKey,
      stage_index: (villageProgress && villageProgress.stage_index) || 0,
      step_index: (villageProgress && villageProgress.step_index) || 0,
      prereq_validated_template: activeTemplateKey
    }, {
      planMode: mode
    });

    villageProgress = getVillageProgress(village, { planMode: mode });
  }

  let template;
  try {
    template = loadTemplate(activeTemplateKey);
  } catch (error) {
    return {
      status: "error",
      message: `Failed to load template '${activeTemplateKey}': ${error.message}`
    };
  }

  const reconciled = await reconcileTemplateProgressIndices(
    page,
    baseUrl,
    village.id,
    template,
    villageProgress,
    { planMode: mode }
  );
  if (reconciled.changed) {
    setVillageProgress(
      village,
      {
        active_template: activeTemplateKey,
        stage_index: reconciled.stageIndex,
        step_index: reconciled.stepIndex,
        prereq_validated_template:
          (villageProgress && villageProgress.prereq_validated_template) || activeTemplateKey
      },
      { planMode: mode }
    );
    villageProgress = getVillageProgress(village, { planMode: mode });
  }

  // Resolve next step
  const next = resolveNextStep(template, villageProgress);

  if (!next) {
    // Current template complete — check for next_template
    if (template.next_template) {
      setVillageProgress(village, {
        active_template: template.next_template,
        stage_index: 0,
        step_index: 0,
        completed_template: activeTemplateKey
      }, {
        planMode: mode
      });
      return {
        status: "template_complete",
        planMode: mode,
        completedTemplate: activeTemplateKey,
        nextTemplate: template.next_template,
        message: `${planLabel} template '${activeTemplateKey}' completed. Advanced to '${template.next_template}'.`
      };
    }
    return {
      status: "all_complete",
      planMode: mode,
      message: `All ${planLabel} templates completed for this village.`
    };
  }

  const { stageIndex, stepIndex, stageName, step, isLast } = next;

  let resolvedSlot = Number(step.slot);
  let slotInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);

  const allowGenericResourceFieldStep =
    mode === PLAN_MODE_RESOURCE &&
    isResourceFieldSlot(step.slot) &&
    isResourceFieldBuildingName(step.building) &&
    (
      isResourceFieldBuildingName(slotInfo.buildingName) ||
      (
        isUnknownBuildingName(slotInfo.buildingName) &&
        !slotInfo.isEmptySlot
      )
    );

  let bonusBuildingRemappedFromTemplateSlot = null;
  if (
    !slotInfo.isEmptySlot &&
    !isSameBuildingName(slotInfo.buildingName, step.building) &&
    !allowGenericResourceFieldStep &&
    isFlexibleMapBonusBuilding(step.building)
  ) {
    const mapSlot = await discoverBonusBuildingSlotFromMap(page, baseUrl, village.id, step.building);
    if (mapSlot != null && Number(mapSlot) !== Number(resolvedSlot)) {
      bonusBuildingRemappedFromTemplateSlot = resolvedSlot;
      resolvedSlot = Number(mapSlot);
      slotInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
    }
  }

  // Build the report
  const report = {
    planMode: mode,
    template: activeTemplateKey,
    stage: stageName,
    stageIndex,
    stepIndex,
    slot: resolvedSlot,
    ...(bonusBuildingRemappedFromTemplateSlot !== null
      ? { bonusBuildingRemappedFromTemplateSlot }
      : {}),
    targetBuilding: step.building,
    targetLevel: step.target_level,
    currentBuilding: slotInfo.buildingName,
    currentLevel: slotInfo.currentLevel,
    isEmptySlot: slotInfo.isEmptySlot,
    costs: slotInfo.costs,
    stock: slotInfo.stock,
    warehouseCap: slotInfo.warehouseCap,
    granaryCap: slotInfo.granaryCap,
    buildQueueCount: slotInfo.buildQueueCount,
    masterBuilderQueueCount: slotInfo.masterBuilderQueueCount,
    hasUpgradeButton: slotInfo.hasUpgradeButton,
    upgradeDisabled: slotInfo.upgradeDisabled,
    hasMasterBuilderUpgradeButton: slotInfo.hasMasterBuilderUpgradeButton,
    masterBuilderUpgradeDisabled: slotInfo.masterBuilderUpgradeDisabled,
    currentlyBuilding: slotInfo.currentlyBuilding,
    hasGoldComplete: slotInfo.hasGoldComplete,
    hasMasterBuilderGoldComplete: slotInfo.hasMasterBuilderGoldComplete,
    goldCompletions: 0,
    goldSpent: 0,
    availableNewBuildingOptions: Array.isArray(slotInfo.newBuildingLinks)
      ? slotInfo.newBuildingLinks.map((item) => ({
        name: item && item.name ? item.name : "",
        canBuild: Boolean(item && item.canBuild)
      }))
      : [],
    pageUrl: slotInfo.pageUrl
  };

  // Hard stop on slot/building mismatch to avoid upgrading the wrong building.
  if (
    !slotInfo.isEmptySlot &&
    !isSameBuildingName(slotInfo.buildingName, step.building) &&
    !allowGenericResourceFieldStep
  ) {
    const tribeLayoutHint =
      isFlexibleMapBonusBuilding(step.building)
        ? ` No matching '${step.building}' on inner village map; build it on the correct site for your tribe or adjust the template.`
        : "";
    return {
      status: "blocked_mismatch",
      report,
      message:
        `Slot ${resolvedSlot} contains '${slotInfo.buildingName || "unknown"}', expected '${step.building}'.` +
        (Number(step.slot) !== Number(resolvedSlot) ? ` Template listed slot ${step.slot}.` : "") +
        tribeLayoutHint +
        " Will not click upgrade on a mismatched building."
    };
  }

  const queueCountForPolicy = (info) => {
    if (!info) {
      return 0;
    }
    const regular = Number(info.buildQueueCount) || 0;
    const mb = allowMasterBuilderBuildActions ? (Number(info.masterBuilderQueueCount) || 0) : 0;
    return regular + mb;
  };

  const isQueueOccupied = (info) => queueCountForPolicy(info) > 0;
  const isQueueFull = (info) => queueCountForPolicy(info) >= 2;

  // Handle occupied queue before empty-slot buildability checks:
  // locked/disabled build options can simply mean queue is full.
  if (isQueueFull(slotInfo) && !goldCompleteEnabled) {
    return {
      status: "blocked_queue",
      report,
      message: `Build queue is occupied (${queueCountForPolicy(slotInfo) || 1} item(s)). Enable gold complete or wait.`
    };
  }

  // Gold complete if queue busy and enabled.
  let goldCompletions = 0;
  let goldSpent = 0;
  if (isQueueFull(slotInfo) && goldCompleteEnabled && goldCompleteMax > 0) {
    if (dryRun) {
      return {
        status: "dry_run",
        report,
        message: `[DRY RUN] Would gold-complete current build, then upgrade ${step.building} slot ${resolvedSlot} to level ${step.target_level}.`
      };
    }

    const maxCompletions = Math.max(1, Math.floor(Number(goldCompleteMax) || 1));

    while (isQueueFull(slotInfo) && goldCompletions < maxCompletions) {
      const goldResult = await executeGoldComplete(page, {
        allowMasterBuilder: allowMasterBuilderGoldActions
      });
      if (!goldResult || !goldResult.clicked) {
        break;
      }

      goldCompletions++;
      goldSpent += Number.isFinite(Number(goldResult.goldCost)) ? Number(goldResult.goldCost) : 0;
      report.goldCompletions = goldCompletions;
      report.goldSpent = goldSpent;

      // Re-read the page after each gold completion.
      const refreshedInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
      Object.assign(slotInfo, refreshedInfo);
      report.goldCompleted = true;
    }

    if (isQueueFull(slotInfo)) {
      return {
        status: "blocked_queue",
        report,
        message:
          `Build queue still occupied (${queueCountForPolicy(slotInfo) || 1} item(s)) after ` +
          `${goldCompletions}/${maxCompletions} gold completion attempt(s). ` +
          "Gold finish button may be unavailable, disabled, or blocked by dialog/state."
      };
    }
  }

    // Empty slot guard: ensure the target building is present and buildable before clicking.
    if (slotInfo.isEmptySlot) {
      const options = Array.isArray(slotInfo.newBuildingLinks)
        ? slotInfo.newBuildingLinks
        : [];
      const targetOption = options.find((opt) => isSameBuildingName(opt.name, step.building));

      const shouldFallbackToBonusPrereqStage =
        mode === PLAN_MODE_RESOURCE &&
        activeTemplateKey === "resource_fields_03" &&
        stageIndex > 0 &&
        isBonusBuildingName(step.building);

      if (!targetOption) {
        const availableText = options.length > 0
          ? options
            .map((opt) => `${opt.name || "?"}${opt.canBuild ? "" : " (locked)"}`)
            .join(", ")
          : "none detected";

        if (shouldFallbackToBonusPrereqStage) {
          setVillageProgress(village, {
            active_template: activeTemplateKey,
            stage_index: 0,
            step_index: 0,
            prereq_validated_template: null,
            realigned_from_template: activeTemplateKey
          }, {
            planMode: mode
          });
          return {
            status: "realigned_template",
            report,
            message:
              `Target bonus building '${step.building}' is not available on slot ${resolvedSlot}. ` +
              "Realigning to Stage 1 prerequisite resource fields to continue progressing."
          };
        }

        return {
          status: "blocked_target_unavailable",
          report,
          message:
            `Target building '${step.building}' is not listed for empty slot ${resolvedSlot}. ` +
            `Available options: ${availableText}.`
        };
      }

      if (!targetOption.canBuild) {
        const buildableText = options
          .filter((opt) => opt.canBuild)
          .map((opt) => opt.name || "?")
          .join(", ") || "none";

        const prereqRealign = await tryRealignForLockedNewBuildingPrerequisite(
          page,
          baseUrl,
          village,
          template,
          activeTemplateKey,
          step,
          report,
          mode
        );
        if (prereqRealign) {
          return prereqRealign;
        }

        if (shouldFallbackToBonusPrereqStage) {
          setVillageProgress(village, {
            active_template: activeTemplateKey,
            stage_index: 0,
            step_index: 0,
            prereq_validated_template: null,
            realigned_from_template: activeTemplateKey
          }, {
            planMode: mode
          });
          return {
            status: "realigned_template",
            report,
            message:
              `Target bonus building '${step.building}' is locked on slot ${resolvedSlot}. ` +
              "Realigning to Stage 1 prerequisite resource fields to continue progressing."
          };
        }

        return {
          status: "blocked_target_locked",
          report,
          message:
            `Target building '${step.building}' is listed but not currently buildable for slot ${resolvedSlot}. ` +
            `Buildable now: ${buildableText}.`
        };
      }
    }

  // Check if step is already satisfied (building at or above target level)
  if (
    !slotInfo.isEmptySlot &&
    slotInfo.currentLevel >= step.target_level &&
    (
      isSameBuildingName(slotInfo.buildingName, step.building) ||
      allowGenericResourceFieldStep
    )
  ) {
    // Step already done — advance progress
    const nextStepIndex = stepIndex + 1;
    const currentStage = template.stages[stageIndex];
    let newStageIndex = stageIndex;
    let newStepIndex = nextStepIndex;

    if (nextStepIndex >= currentStage.steps.length) {
      newStageIndex = stageIndex + 1;
      newStepIndex = 0;
    }

    setVillageProgress(village, {
      active_template: activeTemplateKey,
      stage_index: newStageIndex,
      step_index: newStepIndex
    }, {
      planMode: mode
    });

    return {
      status: "already_satisfied",
      report,
      message: `${step.building} slot ${resolvedSlot} already at level ${slotInfo.currentLevel} (target: ${step.target_level}). Advancing.`
    };
  }

  // Guard 2: Storage capacity
  if (Object.keys(slotInfo.costs).length > 0) {
    const storageIssues = checkStorageCapacity(slotInfo, slotInfo.costs);
    if (storageIssues.length > 0) {
      return {
        status: "blocked_storage",
        report,
        issues: storageIssues,
        message: `Storage too small: ${storageIssues.join("; ")}`
      };
    }
  }

  // Guard 3: Resource sufficiency
  //
  // Regular upgrades require the full cost in situ. Nexian commonly hides/disables those when
  // stock is low and only exposes Master Builder queueing ("regular: none | MB"). In that case
  // we must reach executeUpgradeClick — MB can enqueue while the warehouse is understocked.
  if (Object.keys(slotInfo.costs).length > 0) {
    const { sufficient, deficit } = checkResourceSufficiency(slotInfo, slotInfo.costs);
    if (!sufficient) {
      const regularEnabled =
        Boolean(slotInfo.hasUpgradeButton) && !slotInfo.upgradeDisabled;
      const mbQueuedUpgradeAllowed =
        allowMasterBuilderBuildActions &&
        Boolean(slotInfo.hasMasterBuilderUpgradeButton) &&
        !slotInfo.masterBuilderUpgradeDisabled;

      const skipStrictResourceGate =
        !slotInfo.isEmptySlot && !regularEnabled && mbQueuedUpgradeAllowed;

      if (!skipStrictResourceGate) {
        const deficitText = Object.entries(deficit)
          .map(([res, amount]) => `${res}: need ~${Math.max(1, Math.ceil(Number(amount) || 0))}`)
          .join(", ");
        return {
          status: "blocked_resources",
          report,
          deficit,
          message: `Insufficient resources. Deficit: ${deficitText}`
        };
      }
    }
  }

  // Guard 4: Upgrade control presence/enabled state (avoid "click_failed" when UI has no actionable button)
  if (!slotInfo.isEmptySlot) {
    const hasRegular = Boolean(slotInfo.hasUpgradeButton);
    const regularEnabled = hasRegular && !slotInfo.upgradeDisabled;
    const hasMb = Boolean(slotInfo.hasMasterBuilderUpgradeButton);
    const mbEnabled = allowMasterBuilderBuildActions && hasMb && !slotInfo.masterBuilderUpgradeDisabled;

    if (!regularEnabled && !mbEnabled) {
      if (!hasRegular && hasMb && !allowMasterBuilderBuildActions) {
        if (goldCompleteEnabled && goldCompleteMax > 0) {
          const maxCompletions = Math.max(1, Math.floor(Number(goldCompleteMax) || 1));
          let rescueAttempts = 0;
          while (rescueAttempts < maxCompletions) {
            const goldClicked = await executeGoldComplete(page, {
              allowMasterBuilder: allowMasterBuilderGoldActions
            });
            if (!goldClicked || !goldClicked.clicked) {
              break;
            }
            rescueAttempts++;
            goldCompletions++;
            goldSpent += Number.isFinite(Number(goldClicked.goldCost)) ? Number(goldClicked.goldCost) : 0;
            report.goldCompletions = goldCompletions;
            report.goldSpent = goldSpent;
            const refreshedInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
            Object.assign(slotInfo, refreshedInfo);
            report.goldCompleted = true;

            const refreshedHasRegular = Boolean(slotInfo.hasUpgradeButton);
            const refreshedRegularEnabled = refreshedHasRegular && !slotInfo.upgradeDisabled;
            if (refreshedRegularEnabled) {
              break;
            }
          }

          const recoveredHasRegular = Boolean(slotInfo.hasUpgradeButton);
          const recoveredRegularEnabled = recoveredHasRegular && !slotInfo.upgradeDisabled;
          if (recoveredRegularEnabled) {
            // Continue normal flow below: regular upgrade button became available.
          } else {
            return {
              status: "blocked_master_builder_only",
              report,
              message:
                `Slot ${resolvedSlot} has only a Master Builder upgrade button after ` +
                `${rescueAttempts}/${maxCompletions} gold completion attempt(s). ` +
                `Enable Master Builder in settings or upgrade manually. (${slotInfo.pageUrl || "unknown page"})`
            };
          }
        } else {
          return {
            status: "blocked_master_builder_only",
            report,
            message:
              `Slot ${resolvedSlot} has only a Master Builder upgrade button. Enable Master Builder in settings ` +
              `or upgrade manually. (${slotInfo.pageUrl || "unknown page"})`
          };
        }
      }

      // Re-evaluate controls after possible MB-only rescue attempt.
      const postHasRegular = Boolean(slotInfo.hasUpgradeButton);
      const postRegularEnabled = postHasRegular && !slotInfo.upgradeDisabled;
      const postHasMb = Boolean(slotInfo.hasMasterBuilderUpgradeButton);
      const postMbEnabled = allowMasterBuilderBuildActions && postHasMb && !slotInfo.masterBuilderUpgradeDisabled;

      if (!postRegularEnabled && !postMbEnabled) {
        if (!postHasRegular && postHasMb && !allowMasterBuilderBuildActions) {
          return {
            status: "blocked_master_builder_only",
            report,
            message:
              `Slot ${resolvedSlot} has only a Master Builder upgrade button. Enable Master Builder in settings ` +
              `or upgrade manually. (${slotInfo.pageUrl || "unknown page"})`
          };
        }

        if (!postHasRegular && !postHasMb) {
          return {
            status: "blocked_no_upgrade_button",
            report,
            message:
              `No upgrade button detected for slot ${resolvedSlot} (${slotInfo.buildingName || step.building} level ${slotInfo.currentLevel}). ` +
              `(${slotInfo.pageUrl || "unknown page"})`
          };
        }

        return {
          status: "blocked_upgrade_disabled",
          report,
          message:
            `Upgrade button is present but disabled for slot ${resolvedSlot} (${slotInfo.buildingName || step.building} level ${slotInfo.currentLevel}). ` +
            `(${slotInfo.pageUrl || "unknown page"})`
        };
      }
    }
  }

  if (dryRun) {
    const action = slotInfo.isEmptySlot ? "construct" : "upgrade";
    return {
      status: "dry_run",
      report,
      message: `[DRY RUN] Would ${action} ${step.building} at slot ${resolvedSlot} to level ${step.target_level}.`
    };
  }

  // Execute the build action
  let actionResult;
  if (slotInfo.isEmptySlot) {
    actionResult = await executeNewBuildingClick(page, step.building, {
      allowMasterBuilder: allowMasterBuilderBuildActions
    });
  } else {
    actionResult = await executeUpgradeClick(page, {
      allowMasterBuilder: allowMasterBuilderBuildActions
    });
  }

  if (!actionResult) {
    return {
      status: "click_failed",
      report,
      message: `Failed to click build/upgrade for ${step.building} at slot ${resolvedSlot}. Button may be missing or disabled.`
    };
  }

  // For empty slots, verify we started the intended building before progressing.
  if (slotInfo.isEmptySlot) {
    const refreshedInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
    if (!isSameBuildingName(refreshedInfo.buildingName, step.building)) {
      return {
        status: "mismatch_after_click",
        report,
        message:
          `Clicked a new-building action but slot ${resolvedSlot} is now '${refreshedInfo.buildingName || "unknown"}' ` +
          `instead of '${step.building}'. Progress was not advanced.`
      };
    }
  }

  // Advance progress
  const nextStepIndex = stepIndex + 1;
  const currentStage = template.stages[stageIndex];
  let newStageIndex = stageIndex;
  let newStepIndex = nextStepIndex;

  if (nextStepIndex >= currentStage.steps.length) {
    newStageIndex = stageIndex + 1;
    newStepIndex = 0;
  }

  setVillageProgress(village, {
    active_template: activeTemplateKey,
    stage_index: newStageIndex,
    step_index: newStepIndex
  }, {
    planMode: mode
  });

  const action = slotInfo.isEmptySlot ? "constructed" : "upgraded";
  const templateDone = isLast;

  return {
    status: "success",
    report,
    goldCompletions,
    goldSpent,
    templateDone,
    message: `${step.building} slot ${resolvedSlot} ${action} toward level ${step.target_level}.`
  };
}

const CRANNY_DEFENSE_TARGET_LEVEL = 10;
const CRANNY_DEFENSE_BUILDING = "Cranny";

function isConstructionPlaceholderBuildingName(name) {
  return /construction of a new building|empty building site|being demolished/i.test(
    String(name || "")
  );
}

async function collectInnerSlotIdsForCrannyScan(page, baseUrl, villageId) {
  const rows = await surveyInnerSlotsFromVillageMap(page, baseUrl, villageId);
  return [...new Set(rows.map((r) => r.slotId).filter((n) => Number.isFinite(n)))].sort(
    (a, b) => a - b
  );
}

/**
 * Defensive cranny stacking: upgrade any Cranny below L10 first; otherwise place a new Cranny on a free inner slot.
 * One queue action per call (upgrade or foundation).
 */
async function runCrannyDefenseStep(getPage, settings, village, options = {}) {
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const goldCompleteEnabled = Boolean(options.goldCompleteEnabled);
  const goldCompleteMax = Number(options.goldCompleteMax);
  const masterBuilderEnabled = Boolean(options.masterBuilderEnabled);
  const dryRun = Boolean(options.dryRun);

  const allowMasterBuilderBuildActions = masterBuilderEnabled;
  const allowMasterBuilderGoldActions = Boolean(masterBuilderEnabled || goldCompleteEnabled);

  const baseUrl = settings.villageBuilderUrl || "https://nexian.world/village2.php";

  const slotIds = await collectInnerSlotIdsForCrannyScan(page, baseUrl, village.id);
  if (!slotIds.length) {
    return {
      status: "error",
      message: "No inner village slots found on the map survey (expected build.php?id= areas)."
    };
  }

  const snapshots = [];
  for (const slotId of slotIds) {
    const info = await readSlotPage(page, baseUrl, slotId, village.id);
    snapshots.push({ slotId, info });
  }

  const crannyBelowMax = [];
  const emptyForNewCranny = [];

  for (const { slotId, info } of snapshots) {
    if (isConstructionPlaceholderBuildingName(info.buildingName)) {
      continue;
    }

    if (isSameBuildingName(info.buildingName, CRANNY_DEFENSE_BUILDING)) {
      const lvl = Number(info.currentLevel) || 0;
      if (lvl > 0 && lvl < CRANNY_DEFENSE_TARGET_LEVEL) {
        crannyBelowMax.push({ slotId, info, level: lvl });
      }
      continue;
    }

    if (info.isEmptySlot) {
      const opts = Array.isArray(info.newBuildingLinks) ? info.newBuildingLinks : [];
      const crannyOpt = opts.find((opt) => isSameBuildingName(opt.name, CRANNY_DEFENSE_BUILDING));
      if (crannyOpt && crannyOpt.canBuild) {
        emptyForNewCranny.push({ slotId, info });
      }
    }
  }

  crannyBelowMax.sort((a, b) => a.level - b.level || a.slotId - b.slotId);
  emptyForNewCranny.sort((a, b) => a.slotId - b.slotId);

  let chosen = null;
  if (crannyBelowMax.length) {
    chosen = { kind: "upgrade", slotId: crannyBelowMax[0].slotId };
  } else if (emptyForNewCranny.length) {
    chosen = { kind: "new", slotId: emptyForNewCranny[0].slotId };
  } else {
    return {
      status: "idle_saturated",
      message:
        "Cranny defense: no Cranny below level 10 to upgrade and no empty slot with buildable Cranny " +
        `(surveyed ${slotIds.length} inner slot(s)).`
    };
  }

  let resolvedSlot = Number(chosen.slotId);
  let slotInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);

  const report = {
    mode: "cranny_defense",
    slot: resolvedSlot,
    action: chosen.kind,
    targetBuilding: CRANNY_DEFENSE_BUILDING,
    targetLevel: CRANNY_DEFENSE_TARGET_LEVEL,
    currentBuilding: slotInfo.buildingName,
    currentLevel: slotInfo.currentLevel,
    isEmptySlot: slotInfo.isEmptySlot,
    costs: slotInfo.costs,
    stock: slotInfo.stock,
    warehouseCap: slotInfo.warehouseCap,
    granaryCap: slotInfo.granaryCap,
    buildQueueCount: slotInfo.buildQueueCount,
    masterBuilderQueueCount: slotInfo.masterBuilderQueueCount,
    hasUpgradeButton: slotInfo.hasUpgradeButton,
    upgradeDisabled: slotInfo.upgradeDisabled,
    hasMasterBuilderUpgradeButton: slotInfo.hasMasterBuilderUpgradeButton,
    masterBuilderUpgradeDisabled: slotInfo.masterBuilderUpgradeDisabled,
    currentlyBuilding: slotInfo.currentlyBuilding,
    hasGoldComplete: slotInfo.hasGoldComplete,
    hasMasterBuilderGoldComplete: slotInfo.hasMasterBuilderGoldComplete,
    availableNewBuildingOptions: Array.isArray(slotInfo.newBuildingLinks)
      ? slotInfo.newBuildingLinks.map((item) => ({
        name: item && item.name ? item.name : "",
        canBuild: Boolean(item && item.canBuild)
      }))
      : [],
    pageUrl: slotInfo.pageUrl,
    goldCompletions: 0,
    goldSpent: 0
  };

  const queueCountForPolicy = (info) => {
    if (!info) {
      return 0;
    }
    const regular = Number(info.buildQueueCount) || 0;
    const mb = allowMasterBuilderBuildActions ? Number(info.masterBuilderQueueCount) || 0 : 0;
    return regular + mb;
  };

  const isQueueFull = (info) => queueCountForPolicy(info) >= 2;

  if (isQueueFull(slotInfo) && !goldCompleteEnabled) {
    return {
      status: "blocked_queue",
      report,
      message: `Build queue is occupied (${queueCountForPolicy(slotInfo) || 1} item(s)). Enable gold complete or wait.`
    };
  }

  let goldCompletions = 0;
  let goldSpent = 0;
  if (isQueueFull(slotInfo) && goldCompleteEnabled && goldCompleteMax > 0) {
    const maxCompletions = Math.max(1, Math.floor(Number(goldCompleteMax) || 1));

    while (isQueueFull(slotInfo) && goldCompletions < maxCompletions) {
      const goldResult = await executeGoldComplete(page, {
        allowMasterBuilder: allowMasterBuilderGoldActions
      });
      if (!goldResult || !goldResult.clicked) {
        break;
      }

      goldCompletions++;
      goldSpent += Number.isFinite(Number(goldResult.goldCost)) ? Number(goldResult.goldCost) : 0;
      report.goldCompletions = goldCompletions;
      report.goldSpent = goldSpent;

      const refreshedInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
      Object.assign(slotInfo, refreshedInfo);
      report.goldCompleted = true;
    }

    if (isQueueFull(slotInfo)) {
      return {
        status: "blocked_queue",
        report,
        message:
          `Build queue still occupied (${queueCountForPolicy(slotInfo) || 1} item(s)) after ` +
          `${goldCompletions}/${maxCompletions} gold completion attempt(s).`
      };
    }
  }

  if (chosen.kind === "upgrade") {
    if (
      !isSameBuildingName(slotInfo.buildingName, CRANNY_DEFENSE_BUILDING) ||
      Number(slotInfo.currentLevel) >= CRANNY_DEFENSE_TARGET_LEVEL
    ) {
      return {
        status: "stale_scan",
        report,
        message:
          `Cranny slot ${resolvedSlot} changed before action (${slotInfo.buildingName || "?"} L${slotInfo.currentLevel}). Retry on next tick.`
      };
    }

    if (Object.keys(slotInfo.costs).length > 0) {
      const storageIssues = checkStorageCapacity(slotInfo, slotInfo.costs);
      if (storageIssues.length > 0) {
        return {
          status: "blocked_storage",
          report,
          issues: storageIssues,
          message: `Storage too small: ${storageIssues.join("; ")}`
        };
      }
    }

    if (Object.keys(slotInfo.costs).length > 0) {
      const { sufficient, deficit } = checkResourceSufficiency(slotInfo, slotInfo.costs);
      if (!sufficient) {
        const regularEnabled = Boolean(slotInfo.hasUpgradeButton) && !slotInfo.upgradeDisabled;
        const mbQueuedUpgradeAllowed =
          allowMasterBuilderBuildActions &&
          Boolean(slotInfo.hasMasterBuilderUpgradeButton) &&
          !slotInfo.masterBuilderUpgradeDisabled;
        const skipStrictResourceGate =
          !slotInfo.isEmptySlot && !regularEnabled && mbQueuedUpgradeAllowed;

        if (!skipStrictResourceGate) {
          const deficitText = Object.entries(deficit)
            .map(([res, amount]) => `${res}: need ~${Math.max(1, Math.ceil(Number(amount) || 0))}`)
            .join(", ");
          return {
            status: "blocked_resources",
            report,
            deficit,
            message: `Insufficient resources. Deficit: ${deficitText}`
          };
        }
      }
    }

    const hasRegular = Boolean(slotInfo.hasUpgradeButton);
    const regularEnabled = hasRegular && !slotInfo.upgradeDisabled;
    const hasMb = Boolean(slotInfo.hasMasterBuilderUpgradeButton);
    const mbEnabled =
      allowMasterBuilderBuildActions && hasMb && !slotInfo.masterBuilderUpgradeDisabled;

    if (!regularEnabled && !mbEnabled) {
      return {
        status: "blocked_upgrade_disabled",
        report,
        message:
          `No enabled upgrade control for Cranny at slot ${resolvedSlot} (level ${slotInfo.currentLevel}).`
      };
    }
  } else {
    if (!slotInfo.isEmptySlot) {
      return {
        status: "stale_scan",
        report,
        message: `Slot ${resolvedSlot} is no longer empty. Retry on next tick.`
      };
    }

    const optionsList = Array.isArray(slotInfo.newBuildingLinks) ? slotInfo.newBuildingLinks : [];
    const targetOption = optionsList.find((opt) =>
      isSameBuildingName(opt.name, CRANNY_DEFENSE_BUILDING)
    );

    if (!targetOption) {
      return {
        status: "blocked_target_unavailable",
        report,
        message: `Cranny is not listed as a build option for empty slot ${resolvedSlot}.`
      };
    }

    if (!targetOption.canBuild) {
      const buildableText =
        optionsList
          .filter((opt) => opt.canBuild)
          .map((opt) => opt.name || "?")
          .join(", ") || "none";
      return {
        status: "blocked_target_locked",
        report,
        message:
          `Cranny is listed but not buildable on slot ${resolvedSlot}. Buildable now: ${buildableText}.`
      };
    }

    if (Object.keys(slotInfo.costs).length > 0) {
      const storageIssues = checkStorageCapacity(slotInfo, slotInfo.costs);
      if (storageIssues.length > 0) {
        return {
          status: "blocked_storage",
          report,
          issues: storageIssues,
          message: `Storage too small: ${storageIssues.join("; ")}`
        };
      }
    }

    if (Object.keys(slotInfo.costs).length > 0) {
      const { sufficient, deficit } = checkResourceSufficiency(slotInfo, slotInfo.costs);
      if (!sufficient) {
        const deficitText = Object.entries(deficit)
          .map(([res, amount]) => `${res}: need ~${Math.max(1, Math.ceil(Number(amount) || 0))}`)
          .join(", ");
        return {
          status: "blocked_resources",
          report,
          deficit,
          message: `Insufficient resources. Deficit: ${deficitText}`
        };
      }
    }
  }

  if (dryRun) {
    return {
      status: "dry_run",
      report,
      message: `[DRY RUN] Would ${chosen.kind === "new" ? "construct" : "upgrade"} ${CRANNY_DEFENSE_BUILDING} at slot ${resolvedSlot}.`
    };
  }

  let actionResult;
  if (chosen.kind === "new") {
    actionResult = await executeNewBuildingClick(page, CRANNY_DEFENSE_BUILDING, {
      allowMasterBuilder: allowMasterBuilderBuildActions
    });
  } else {
    actionResult = await executeUpgradeClick(page, {
      allowMasterBuilder: allowMasterBuilderBuildActions
    });
  }

  if (!actionResult) {
    return {
      status: "click_failed",
      report,
      message: `Failed to click build/upgrade for ${CRANNY_DEFENSE_BUILDING} at slot ${resolvedSlot}.`
    };
  }

  if (chosen.kind === "new") {
    const refreshedInfo = await readSlotPage(page, baseUrl, resolvedSlot, village.id);
    if (!isSameBuildingName(refreshedInfo.buildingName, CRANNY_DEFENSE_BUILDING)) {
      return {
        status: "mismatch_after_click",
        report,
        message:
          `Clicked construct but slot ${resolvedSlot} shows '${refreshedInfo.buildingName || "unknown"}' instead of Cranny.`
      };
    }
  }

  const verb = chosen.kind === "new" ? "Started Cranny" : "Upgraded Cranny";
  const lvlNote =
    chosen.kind === "new"
      ? "(construction)"
      : `(toward level ${CRANNY_DEFENSE_TARGET_LEVEL})`;

  return {
    status: "success",
    report,
    goldCompletions,
    goldSpent,
    message: `${verb} at slot ${resolvedSlot} ${lvlNote}.`
  };
}

// ---------------------------------------------------------------------------
// Preview — show plan without executing
// ---------------------------------------------------------------------------

function previewPlan(village, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const planLabel = getPlanLabel(mode);
  const villageProgress = getVillageProgress(village, { planMode: mode });
  const index = loadIndex();
  const defaultTemplateKey = resolveDefaultTemplateForPlan(index, mode);

  if (!defaultTemplateKey) {
    return {
      status: "error",
      planMode: mode,
      message: `No enabled ${planLabel} template chain found in templates/index.json.`
    };
  }

  let activeTemplateKey;
  if (
    villageProgress &&
    villageProgress.active_template &&
    templateMatchesPlan(villageProgress.active_template, mode)
  ) {
    activeTemplateKey = villageProgress.active_template;
  } else {
    activeTemplateKey = defaultTemplateKey;
  }

  let template;
  try {
    template = loadTemplate(activeTemplateKey);
  } catch (error) {
    return {
      status: "error",
      planMode: mode,
      message: `Failed to load template '${activeTemplateKey}': ${error.message}`
    };
  }

  const next = resolveNextStep(template, villageProgress);

  if (!next) {
    if (template.next_template) {
      return {
        status: "template_complete",
        planMode: mode,
        activeTemplate: activeTemplateKey,
        nextTemplate: template.next_template,
        upcoming: [],
        message: `${planLabel} template '${activeTemplateKey}' completed. Next: '${template.next_template}'.`
      };
    }
    return {
      status: "all_complete",
      planMode: mode,
      activeTemplate: activeTemplateKey,
      upcoming: [],
      message: `All ${planLabel} templates completed for this village.`
    };
  }

  // Gather upcoming steps (next 5)
  const upcoming = [];
  let count = 0;
  const maxPreview = 5;

  for (let si = next.stageIndex; si < template.stages.length && count < maxPreview; si++) {
    const stage = template.stages[si];
    const stepStart = si === next.stageIndex ? next.stepIndex : 0;

    for (let sti = stepStart; sti < stage.steps.length && count < maxPreview; sti++) {
      const step = stage.steps[sti];
      upcoming.push({
        stageIndex: si,
        stepIndex: sti,
        stageName: stage.name,
        slot: step.slot,
        building: step.building,
        targetLevel: step.target_level,
        isCurrent: si === next.stageIndex && sti === next.stepIndex
      });
      count++;
    }
  }

  return {
    status: "pending",
    planMode: mode,
    activeTemplate: activeTemplateKey,
    templateName: template.name,
    next: next,
    upcoming,
    totalStages: template.stages.length,
    currentStageIndex: next.stageIndex,
    message: `Next: ${next.step.building} slot ${next.step.slot} → level ${next.step.target_level} (${next.stageName})`
  };
}

// ---------------------------------------------------------------------------
// Reset progress for a village
// ---------------------------------------------------------------------------

function resetVillageProgress(village, templateKey, options = {}) {
  const mode = normalizePlanMode(options.planMode);
  const index = loadIndex();
  const key = templateKey || resolveDefaultTemplateForPlan(index, mode) || index.default_template;
  setVillageProgress(village, {
    active_template: key,
    stage_index: 0,
    step_index: 0,
    reset_at: new Date().toISOString()
  }, {
    planMode: mode
  });
}

module.exports = {
  loadIndex,
  loadTemplate,
  listEnabledTemplates,
  loadProgress,
  villageProgressKey,
  getVillageProgress,
  setVillageProgress,
  readSlotPage,
  checkStorageCapacity,
  checkResourceSufficiency,
  resolveNextStep,
  runBuilderStep,
  runCrannyDefenseStep,
  previewPlan,
  resetVillageProgress,
  syncProgressToWorldState,
  buildSlotUrl
};
