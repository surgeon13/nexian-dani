const { buildSlotUrl } = require("./villageBuilder");

const RESIDENCE_SLOT = 25;
const SETTLERS_NEEDED = 3;
const AUTO_SETTLE_SEARCH_RADIUS = 3;
const SETTLEMENT_RESOURCE_REQUIREMENT = {
  wood: 750,
  clay: 750,
  iron: 750,
  crop: 750
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .trim();
}

function resolveExpansionBaseUrl(settings) {
  const fromBuilder = settings && String(settings.villageBuilderUrl || "").trim();
  if (fromBuilder) {
    return fromBuilder;
  }
  const statusUrl = settings && String(settings.villageStatusUrl || "").trim();
  if (statusUrl) {
    try {
      const parsed = new URL(statusUrl);
      return `${parsed.origin}/village2.php`;
    } catch (_error) {
      // fall through
    }
  }
  return "https://nexian.world/village2.php";
}

function compactBuildingKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function isSettlerBuildingName(value) {
  const key = compactBuildingKey(value);
  return key.includes("residence") || key.includes("palace");
}

function isBlankBuildingName(value) {
  return !normalizeText(value);
}

function describeSettlerBuilding(slotInfo) {
  const name = String((slotInfo && slotInfo.buildingName) || "").trim();
  if (compactBuildingKey(name).includes("palace")) {
    return "Palace";
  }
  if (compactBuildingKey(name).includes("residence")) {
    return "Residence";
  }
  return name || "Residence/Palace";
}

async function readResidencePage(page, baseUrl, villageId) {
  const url = buildSlotUrl(baseUrl, RESIDENCE_SLOT, villageId);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  return page.evaluate(() => {
    const titleEl = document.querySelector("#build h1, #content h1, #build .build_title h1");
    const titleText = titleEl ? titleEl.textContent.replace(/\u00a0/g, " ").trim() : "";
    const levelMatch = titleText.match(/^(.+?)\s+level\s+(\d+)/i);
    const buildingName = levelMatch ? levelMatch[1].trim() : titleText;
    const currentLevel = levelMatch ? Number(levelMatch[2]) : 0;

    const trainRows = Array.from(
      document.querySelectorAll("form[name='snd'] table.build_details tbody tr, table.build_details tbody tr")
    );
    const isEmptySlot = Boolean(
      document.querySelector("#build .buildingList, #contract_building, .buildingList, table.new_building")
    ) || /construction of a new building|empty building site/i.test(titleText);

    const canClick = (element) => Boolean(
      element &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );

    const costs = {};
    const contractEls = document.querySelectorAll("#contract");
    const costContainer = contractEls.length > 1 ? contractEls[1] : contractEls[0];
    if (costContainer) {
      const costImgs = costContainer.querySelectorAll("img.r1, img.r2, img.r3, img.r4");
      costImgs.forEach((img) => {
        const rawText = img.nextSibling ? (img.nextSibling.textContent || "") : "";
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

    const upgradeCandidates = Array.from(document.querySelectorAll(
      "#build a.build, a.build, #build button.green.build, button.green.build, #contract a.build, #contract button.green"
    ));
    const regularUpgradeButton = upgradeCandidates.find((el) => canClick(el) && !isMasterBuilderElement(el)) || null;
    const masterBuilderUpgradeButton = upgradeCandidates.find((el) => canClick(el) && isMasterBuilderElement(el)) || null;

    const newBuildingLinks = [];
    if (isEmptySlot) {
      const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").trim();
      const tableItems = document.querySelectorAll("table.new_building, #contract_building table.new_building");
      tableItems.forEach((table) => {
        const img = table.querySelector("td.bimg img.building, td.bimg img[title], td.bimg img[alt]");
        const bName = img ? normalize(img.getAttribute("title") || img.getAttribute("alt") || "") : "";
        const buildLink = table.querySelector("td.link a.build, a.build[href*='?b='], a.build[href*='&b=']");
        const canBuild = canClick(buildLink);
        if (bName) {
          newBuildingLinks.push({ name: bName, canBuild });
        }
      });
    }

    const unitOptions = trainRows
      .map((row) => {
        const nameEl = row.querySelector("td.desc .tit a, td.desc a, td.desc");
        const inputEl = row.querySelector("td.val input.text, input[type='text']");
        const maxLink = row.querySelector("td.max a");

        const unitName = nameEl ? nameEl.textContent.trim() : "";
        const inputName = inputEl ? inputEl.getAttribute("name") : "";

        const maxText = maxLink ? maxLink.textContent : "";
        const maxMatch = String(maxText).match(/(\d+)/);
        const maxTrainable = maxMatch ? Number(maxMatch[1]) : 0;
        const costs = {};
        row.querySelectorAll("img.r1, img.r2, img.r3, img.r4").forEach((img) => {
          const rawText = img.nextSibling ? (img.nextSibling.textContent || "") : "";
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

        return { unitName, inputName, maxTrainable, costs };
      })
      .filter((u) => u.unitName && u.inputName);

    const troopCounts = {};
    const addTroopCount = (name, count) => {
      const key = String(name || "").trim();
      if (!key) {
        return;
      }
      const numericCount = Number(count) || 0;
      troopCounts[key] = (troopCounts[key] || 0) + numericCount;
    };

    // Prefer explicit #troops table parsing (stable across classic templates).
    document.querySelectorAll("#troops tbody tr").forEach((row) => {
      const nameEl = row.querySelector("td.un, .unit");
      const iconEl = row.querySelector("td.ico img[alt], td.ico img[title], img.unit");
      const countEl = row.querySelector("td.num, .count");
      const name = nameEl
        ? String(nameEl.textContent || "").trim()
        : String(
          (iconEl && (iconEl.getAttribute("alt") || iconEl.getAttribute("title"))) || ""
        ).trim();
      const count = countEl
        ? Number(String(countEl.textContent || "").replace(/[^\d]/g, "")) || 0
        : 0;
      addTroopCount(name, count);
    });

    // Fallback for other troop tables/layouts.
    document.querySelectorAll(".units tbody tr").forEach((row) => {
      const nameEl = row.querySelector("td.un, .unit");
      const countEl = row.querySelector("td.num, .count");
      if (nameEl && countEl) {
        const name = String(nameEl.textContent || "").trim();
        const count = Number(String(countEl.textContent || "").replace(/[^\d]/g, "")) || 0;
        addTroopCount(name, count);
      }
    });

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

    const whMax = Math.max(woodRes.max, clayRes.max, ironRes.max);
    const granaryCap = cropRes.max > 0 ? cropRes.max : 0;
    const warehouseCap = whMax > 0 ? whMax : 0;

    return {
      buildingName,
      currentLevel,
      unitOptions,
      troopCounts,
      isEmptySlot,
      costs,
      hasUpgradeButton: Boolean(regularUpgradeButton),
      hasRegularUpgradeButton: Boolean(regularUpgradeButton),
      hasMasterBuilderUpgradeButton: Boolean(masterBuilderUpgradeButton),
      newBuildingLinks,
      stock: {
        wood: woodRes.current,
        clay: clayRes.current,
        iron: ironRes.current,
        crop: cropRes.current
      },
      warehouseCap,
      granaryCap,
      pageUrl: window.location.href
    };
  });
}

async function getSettlerCountFromRallyPoint(page, village, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const rallyPointUrl = buildSlotUrl(baseUrl, 39, village.id);
  const parsed = new URL(rallyPointUrl);
  parsed.searchParams.set("tt", "2");
  await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });

  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .trim();

    let count = 0;
    document.querySelectorAll("#troops tbody tr").forEach((row) => {
      const nameEl = row.querySelector("td.un");
      const iconEl = row.querySelector("td.ico img[alt], td.ico img[title]");
      const numEl = row.querySelector("td.num");
      const name = nameEl
        ? String(nameEl.textContent || "").trim()
        : String(
          (iconEl && (iconEl.getAttribute("alt") || iconEl.getAttribute("title"))) || ""
        ).trim();
      if (normalize(name).includes("settler")) {
        const rowCount = numEl
          ? Number(String(numEl.textContent || "").replace(/[^\d]/g, "")) || 0
          : 0;
        count += rowCount;
      }
    });
    return count;
  });
}

function buildVillageOverviewUrl(baseUrl, villageId) {
  try {
    const parsed = new URL(baseUrl);
    const overviewUrl = new URL(`${parsed.origin}/village1.php`);
    if (villageId) {
      overviewUrl.searchParams.set("vid", String(villageId));
    }
    return overviewUrl.toString();
  } catch (_error) {
    const base = String(baseUrl || "").replace(/\/[^/]*$/, "");
    let url = `${base}/village1.php`;
    if (villageId) {
      url += `?vid=${villageId}`;
    }
    return url;
  }
}

async function readVillageOverviewDetails(page, village, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const overviewUrl = buildVillageOverviewUrl(baseUrl, village.id);
  await page.goto(overviewUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .trim();
    const parseIntText = (value) => Number(String(value || "").replace(/[^\d]/g, "")) || 0;

    // Explicitly parse settlers from village1 map details troops table.
    let settlerCount = 0;
    document.querySelectorAll("#map_details #troops tbody tr, #troops tbody tr").forEach((row) => {
      const nameEl = row.querySelector("td.un");
      const iconEl = row.querySelector("td.ico img[alt], td.ico img[title]");
      const numEl = row.querySelector("td.num");
      const unitName = nameEl
        ? String(nameEl.textContent || "").trim()
        : String(
          (iconEl && (iconEl.getAttribute("alt") || iconEl.getAttribute("title"))) || ""
        ).trim();
      if (normalize(unitName).includes("settler")) {
        settlerCount += parseIntText(numEl ? numEl.textContent : "");
      }
    });

    // Resource header values (current stock) are still the source for settlement requirement checks.
    const parseResCell = (id) => {
      const el = document.querySelector(id);
      if (!el) return { current: 0, max: 0 };
      return {
        current: Number(el.getAttribute("data-v")) || 0,
        max: Number(el.getAttribute("data-m")) || 0
      };
    };

    const woodRes = parseResCell("#l4");
    const clayRes = parseResCell("#l3");
    const ironRes = parseResCell("#l2");
    const cropRes = parseResCell("#l1");

    return {
      settlerCount,
      stock: {
        wood: woodRes.current,
        clay: clayRes.current,
        iron: ironRes.current,
        crop: cropRes.current
      }
    };
  });
}

function checkSettlementResources(stock) {
  const safeStock = stock || {};
  const deficit = {};
  let sufficient = true;

  Object.entries(SETTLEMENT_RESOURCE_REQUIREMENT).forEach(([res, need]) => {
    const have = Number(safeStock[res]) || 0;
    if (have < need) {
      sufficient = false;
      deficit[res] = need - have;
    }
  });

  return { sufficient, deficit, required: SETTLEMENT_RESOURCE_REQUIREMENT };
}

async function clickSettlerBuildingConstruction(page, preferredNames = ["palace", "residence"]) {
  const preferred = (Array.isArray(preferredNames) ? preferredNames : [preferredNames])
    .map((name) => compactBuildingKey(name))
    .filter(Boolean);
  return page.evaluate((preferredKeys) => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
    const compact = (value) => normalize(value).replace(/\s+/g, "");
    const matchesPreferred = (name) => {
      const key = compact(name);
      return preferredKeys.some((wanted) => key.includes(wanted));
    };

    const canClick = (element) => Boolean(
      element &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    );

    const tryClickFromTables = () => {
      const tableItems = document.querySelectorAll("table.new_building, #contract_building table.new_building");
      for (const table of tableItems) {
        const img = table.querySelector("td.bimg img.building, td.bimg img[title], td.bimg img[alt]");
        const name = img ? (img.getAttribute("title") || img.getAttribute("alt") || "") : "";
        if (matchesPreferred(name)) {
          const link = table.querySelector("td.link a.build, a.build[href*='?b='], a.build[href*='&b=']");
          if (canClick(link)) {
            link.click();
            return true;
          }
        }
      }
      return false;
    };

    const tryClickFromCards = () => {
      const cards = document.querySelectorAll(".buildingList .building, #contract_building .building, .buildingList .innerBox");
      for (const card of cards) {
        const nameEl = card.querySelector("h2, .name, .tit a, .tit");
        const imgEl = card.querySelector("img.building, img[title], img[alt]");
        const name = nameEl
          ? nameEl.textContent
          : (imgEl ? (imgEl.getAttribute("title") || imgEl.getAttribute("alt") || "") : "");
        if (matchesPreferred(name)) {
          const btn = card.querySelector("button.green, .contractLink button.green, a.build");
          if (canClick(btn)) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    };

    // Prefer earlier preferredKeys by scanning one key at a time.
    for (const wanted of preferredKeys) {
      const matched = (() => {
        const tableItems = document.querySelectorAll("table.new_building, #contract_building table.new_building");
        for (const table of tableItems) {
          const img = table.querySelector("td.bimg img.building, td.bimg img[title], td.bimg img[alt]");
          const name = img ? (img.getAttribute("title") || img.getAttribute("alt") || "") : "";
          if (compact(name).includes(wanted)) {
            const link = table.querySelector("td.link a.build, a.build[href*='?b='], a.build[href*='&b=']");
            if (canClick(link)) {
              link.click();
              return true;
            }
          }
        }
        const cards = document.querySelectorAll(".buildingList .building, #contract_building .building, .buildingList .innerBox");
        for (const card of cards) {
          const nameEl = card.querySelector("h2, .name, .tit a, .tit");
          const imgEl = card.querySelector("img.building, img[title], img[alt]");
          const name = nameEl
            ? nameEl.textContent
            : (imgEl ? (imgEl.getAttribute("title") || imgEl.getAttribute("alt") || "") : "");
          if (compact(name).includes(wanted)) {
            const btn = card.querySelector("button.green, .contractLink button.green, a.build");
            if (canClick(btn)) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      })();
      if (matched) {
        return true;
      }
    }

    return tryClickFromTables() || tryClickFromCards();
  }, preferred);
}

async function clickResidenceConstruction(page) {
  return clickSettlerBuildingConstruction(page, ["palace", "residence"]);
}

async function clickResidenceUpgrade(page) {
  return page.evaluate(() => {
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

    const candidates = Array.from(document.querySelectorAll(
      "#build a.build, a.build, #build button.green.build, button.green.build, #contract a.build, #contract button.green"
    ));
    const btn = candidates.find((el) => canClick(el) && !isMasterBuilderElement(el)) || null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
}

function calculateResourceDeficit(stock, costs) {
  const deficit = {};
  const resources = ["wood", "clay", "iron", "crop"];
  resources.forEach((res) => {
    const need = Number(costs && costs[res]) || 0;
    const have = Number(stock && stock[res]) || 0;
    if (need > have) {
      deficit[res] = need - have;
    }
  });
  return deficit;
}

async function ensureResidenceLevel10(page, village, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const slotInfo = await readResidencePage(page, baseUrl, village.id);
  const buildingLabel = describeSettlerBuilding(slotInfo);
  const isSettlerBuilding = isSettlerBuildingName(slotInfo.buildingName);
  const treatAsEmpty =
    Boolean(slotInfo.isEmptySlot) || isBlankBuildingName(slotInfo.buildingName);

  if (isSettlerBuilding && slotInfo.currentLevel >= 10) {
    return {
      status: "residence_ready",
      phase: "residence",
      residenceLevel: slotInfo.currentLevel,
      buildingName: buildingLabel,
      message: `${buildingLabel} level ${slotInfo.currentLevel} is ready.`
    };
  }

  if (!isSettlerBuilding && !treatAsEmpty) {
    return {
      status: "residence_slot_mismatch",
      phase: "residence",
      message: `Slot ${RESIDENCE_SLOT} is '${slotInfo.buildingName}', not an empty slot/Residence/Palace.`
    };
  }

  if (treatAsEmpty) {
    const links = slotInfo.newBuildingLinks || [];
    const hasPalaceOption = links.some((opt) => compactBuildingKey(opt.name).includes("palace"));
    const hasResidenceOption = links.some((opt) => compactBuildingKey(opt.name).includes("residence"));
    // Prefer Palace when the slot is blank/empty (empire expansion capital path).
    const preferredNames = hasPalaceOption
      ? ["palace"]
      : hasResidenceOption
        ? ["residence"]
        : [];
    if (!preferredNames.length) {
      return {
        status: "residence_unavailable",
        phase: "residence",
        message: "Palace/Residence is not currently available in this slot."
      };
    }

    const built = await clickSettlerBuildingConstruction(page, preferredNames);
    if (!built) {
      return {
        status: "residence_build_click_failed",
        phase: "residence",
        message: `Could not click ${preferredNames[0]} construction button.`
      };
    }
    await page.waitForTimeout(1500);
    const startedLabel = preferredNames[0] === "palace" ? "Palace" : "Residence";
    return {
      status: "residence_started",
      phase: "residence",
      buildingName: startedLabel,
      message: `Started ${startedLabel} construction at slot 25.`
    };
  }

  const upgraded = await clickResidenceUpgrade(page);
  if (!upgraded) {
    const deficit = calculateResourceDeficit(slotInfo.stock, slotInfo.costs);
    const deficitEntries = Object.entries(deficit);
    if (slotInfo.hasMasterBuilderUpgradeButton && !slotInfo.hasRegularUpgradeButton) {
      return {
        status: "need_residence_resources",
        phase: "residence_resources",
        residenceLevel: slotInfo.currentLevel,
        buildingName: buildingLabel,
        stock: slotInfo.stock,
        warehouseCap: slotInfo.warehouseCap,
        granaryCap: slotInfo.granaryCap,
        required: slotInfo.costs || {},
        deficit,
        message: deficitEntries.length
          ? `${buildingLabel} upgrade requires more resources before regular queue is available. Deficit: ${deficitEntries.map(([res, amount]) => `${res}: -${amount}`).join(", ")}.`
          : `${buildingLabel} upgrade is currently only available via Master Builder. Waiting for resources to use normal build queue.`
      };
    }
    return {
      status: "residence_upgrade_blocked",
      phase: "residence",
      residenceLevel: slotInfo.currentLevel,
      buildingName: buildingLabel,
      message: `${buildingLabel} is level ${slotInfo.currentLevel}, but upgrade button is unavailable or disabled.`
    };
  }
  await page.waitForTimeout(1500);
  return {
    status: "residence_upgrading",
    phase: "residence",
    residenceLevel: slotInfo.currentLevel,
    buildingName: buildingLabel,
    message: `Queued ${buildingLabel} upgrade from level ${slotInfo.currentLevel}.`
  };
}

async function trainSettlers(page, village, needed = SETTLERS_NEEDED, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const slotInfo = await readResidencePage(page, baseUrl, village.id);
  const buildingLabel = describeSettlerBuilding(slotInfo);

  if (!isSettlerBuildingName(slotInfo.buildingName)) {
    return {
      status: "no_residence",
      message: `Slot ${RESIDENCE_SLOT} is '${slotInfo.buildingName}', not Residence/Palace.`
    };
  }

  if (slotInfo.currentLevel < 10) {
    return {
      status: "residence_too_low",
      currentLevel: slotInfo.currentLevel,
      message: `${buildingLabel} level ${slotInfo.currentLevel} < 10.`
    };
  }

  const settlerEntry = Object.entries(slotInfo.troopCounts).find(([name]) =>
    normalizeText(name).includes("settler")
  );
  const currentSettlers = settlerEntry ? settlerEntry[1] : 0;

  if (currentSettlers >= needed) {
    return {
      status: "settlers_ready",
      count: currentSettlers,
      message: `${currentSettlers} settlers ready.`
    };
  }

  const settlerOption = slotInfo.unitOptions.find((opt) =>
    normalizeText(opt.unitName).includes("settler")
  );

  if (!settlerOption) {
    return {
      status: "settlers_unavailable",
      message: "Settler training option not found."
    };
  }

  const toTrain = Math.min(needed - currentSettlers, settlerOption.maxTrainable);
  if (toTrain <= 0) {
    const perUnitCosts = settlerOption.costs || {};
    const required = {
      wood: Math.max(0, (Number(perUnitCosts.wood) || 0) * Math.max(1, needed - currentSettlers)),
      clay: Math.max(0, (Number(perUnitCosts.clay) || 0) * Math.max(1, needed - currentSettlers)),
      iron: Math.max(0, (Number(perUnitCosts.iron) || 0) * Math.max(1, needed - currentSettlers)),
      crop: Math.max(0, (Number(perUnitCosts.crop) || 0) * Math.max(1, needed - currentSettlers))
    };
    const deficit = calculateResourceDeficit(slotInfo.stock, required);
    const hasResourceDeficit = Object.keys(deficit).length > 0;
    if (hasResourceDeficit) {
      const deficitText = Object.entries(deficit)
        .map(([res, amount]) => `${res}: -${amount}`)
        .join(", ");
      return {
        status: "need_settler_training_resources",
        phase: "train_resources",
        required,
        deficit,
        stock: slotInfo.stock,
        warehouseCap: slotInfo.warehouseCap,
        granaryCap: slotInfo.granaryCap,
        message: `Not enough resources to train settlers. Deficit: ${deficitText}.`
      };
    }
    return {
      status: "cannot_train",
      message: "Cannot train settlers now (check resources or queue)."
    };
  }

  await page.locator(`input[name='${settlerOption.inputName}']`).first().fill(String(toTrain));
  await page.waitForTimeout(400);

  const clicked = await page.evaluate(() => {
    const btn =
      document.querySelector("#btn_train") ||
      document.querySelector("button.green.train") ||
      document.querySelector("input.green.train");
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    return {
      status: "train_click_failed",
      message: "Could not click the train button."
    };
  }

  await page.waitForTimeout(2000);
  return {
    status: "settlers_queued",
    queued: toTrain,
    message: `Queued ${toTrain} settler(s) for training.`
  };
}

async function getResidenceStatus(page, village, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const slotInfo = await readResidencePage(page, baseUrl, village.id);

  const isSettlerBuilding = isSettlerBuildingName(slotInfo.buildingName);
  const settlerEntry = Object.entries(slotInfo.troopCounts).find(([name]) =>
    normalizeText(name).includes("settler")
  );
  let settlerCount = settlerEntry ? settlerEntry[1] : 0;
  let stock = slotInfo.stock;

  if (isSettlerBuilding && slotInfo.currentLevel >= 10) {
    const overview = await readVillageOverviewDetails(page, village, settings);
    settlerCount = Math.max(settlerCount, Number(overview.settlerCount) || 0);
    if (overview.stock) {
      stock = overview.stock;
    }

    // Keep rally point as a final fallback if overview still reports low settlers.
    if (settlerCount < SETTLERS_NEEDED) {
      const rallyPointSettlers = await getSettlerCountFromRallyPoint(page, village, settings);
      settlerCount = Math.max(settlerCount, Number(rallyPointSettlers) || 0);
    }
  }

  return {
    isResidence: isSettlerBuilding,
    buildingName: describeSettlerBuilding(slotInfo),
    residenceLevel: slotInfo.currentLevel,
    settlerCount,
    canTrainSettlers: isSettlerBuilding && slotInfo.currentLevel >= 10,
    unitOptions: slotInfo.unitOptions,
    stock,
    warehouseCap: slotInfo.warehouseCap > 0 ? slotInfo.warehouseCap : null,
    granaryCap: slotInfo.granaryCap > 0 ? slotInfo.granaryCap : null
  };
}

async function openSettlementPage(page, baseUrl, villageId) {
  const rallyPointUrl = buildSlotUrl(baseUrl, 39, villageId);
  const parsed = new URL(rallyPointUrl);
  parsed.searchParams.set("tt", "2");
  await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
}

async function readSettlementForm(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").trim().toLowerCase();
    const missionTexts = [];
    const missionValues = new Set();

    const missionInputs = Array.from(document.querySelectorAll("input[name='c'], input[type='radio'][name='c']"));
    missionInputs.forEach((input) => {
      const value = String(input.value || "");
      missionValues.add(value);
      const rowText = input.closest("tr") ? input.closest("tr").textContent : "";
      missionTexts.push(normalize(rowText));
    });

    const missionSelect = document.querySelector("select[name='c']");
    if (missionSelect) {
      Array.from(missionSelect.options || []).forEach((opt) => {
        missionValues.add(String(opt.value || ""));
        missionTexts.push(normalize(opt.textContent));
      });
    }

    const troopRows = Array.from(
      document.querySelectorAll("form[name='snd'] table tbody tr, table.troop_details tbody tr, table#troops tbody tr")
    );
    const troopInputs = troopRows
      .map((row) => {
        const input = row.querySelector("input[type='text'][name], input[name^='t'][type='text']");
        const nameEl = row.querySelector("td.desc .tit a, td.desc a, td.un, td.desc");
        if (!input || !nameEl) {
          return null;
        }
        return {
          unitName: String(nameEl.textContent || "").replace(/\u00a0/g, " ").trim(),
          inputName: String(input.getAttribute("name") || "")
        };
      })
      .filter(Boolean);

    const hasCoordinateInputs = Boolean(
      document.querySelector(
        "input[name='x'], input[name='y'], input[name='dname'], " +
        "input[id*='x'], input[id*='y'], input[id*='coord'], " +
        ".coordinates input, .coordinate input"
      )
    );

    return {
      missionValues: Array.from(missionValues),
      missionTexts,
      troopInputs,
      hasCoordinateInputs
    };
  });
}

async function fillSettlementCoordinates(page, targetX, targetY) {
  return page.evaluate(({ x, y }) => {
    const normalized = (value) => String(value || "").toLowerCase().trim();
    const toText = (value) => String(value);

    const isTextLikeInput = (el) => {
      if (!el || String(el.tagName || "").toLowerCase() !== "input") {
        return false;
      }
      const type = normalized(el.getAttribute("type") || "text");
      return type === "text" || type === "search" || type === "number" || type === "";
    };

    const fillInput = (el, value) => {
      if (!el) {
        return false;
      }
      el.focus();
      el.value = "";
      el.value = toText(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };

    const allInputs = Array.from(document.querySelectorAll("form[name='snd'] input, #content input, #build input"))
      .filter((el) => isTextLikeInput(el));

    // 1) Common direct selectors by name/id.
    const xDirect = document.querySelector(
      "input[name='x'], input[id='x'], input[id*='coord_x'], input[name*='coord_x'], input[id*='targetX']"
    );
    const yDirect = document.querySelector(
      "input[name='y'], input[id='y'], input[id*='coord_y'], input[name*='coord_y'], input[id*='targetY']"
    );
    if (xDirect && yDirect) {
      fillInput(xDirect, x);
      fillInput(yDirect, y);
      return true;
    }

    // 2) Inputs near coordinate labels.
    const xLabel = Array.from(document.querySelectorAll("label, td, th, span, div"))
      .find((el) => /\bX\b\s*:?/i.test(String(el.textContent || "")) && el.querySelector("input"));
    const yLabel = Array.from(document.querySelectorAll("label, td, th, span, div"))
      .find((el) => /\bY\b\s*:?/i.test(String(el.textContent || "")) && el.querySelector("input"));
    if (xLabel && yLabel) {
      const xInput = xLabel.querySelector("input");
      const yInput = yLabel.querySelector("input");
      if (xInput && yInput) {
        fillInput(xInput, x);
        fillInput(yInput, y);
        return true;
      }
    }

    // 3) Fallback: pick first two short numeric-looking inputs in send form.
    const coordCandidates = allInputs.filter((el) => {
      const maxLength = Number(el.getAttribute("maxlength")) || 0;
      const name = normalized(el.getAttribute("name") || "");
      const id = normalized(el.getAttribute("id") || "");
      return (
        maxLength > 0 && maxLength <= 5 &&
        !name.startsWith("t") &&
        !id.startsWith("t")
      );
    });
    if (coordCandidates.length >= 2) {
      fillInput(coordCandidates[0], x);
      fillInput(coordCandidates[1], y);
      return true;
    }

    return false;
  }, { x: targetX, y: targetY });
}

async function setSettlementMission(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").trim().toLowerCase();

    const radioInputs = Array.from(document.querySelectorAll("input[name='c'], input[type='radio'][name='c']"));
    const preferredRadio = radioInputs.find((input) => String(input.value || "") === "4");
    if (preferredRadio) {
      preferredRadio.checked = true;
      preferredRadio.click();
      return true;
    }

    const semanticRadio = radioInputs.find((input) => {
      const rowText = input.closest("tr") ? input.closest("tr").textContent : "";
      const t = normalize(rowText);
      return t.includes("new village") || t.includes("settle") || t.includes("found");
    });
    if (semanticRadio) {
      semanticRadio.checked = true;
      semanticRadio.click();
      return true;
    }

    const select = document.querySelector("select[name='c']");
    if (select) {
      const exact = Array.from(select.options || []).find((opt) => String(opt.value || "") === "4");
      const semantic = Array.from(select.options || []).find((opt) => {
        const t = normalize(opt.textContent);
        return t.includes("new village") || t.includes("settle") || t.includes("found");
      });
      const selected = exact || semantic;
      if (selected) {
        select.value = String(selected.value || "");
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    return false;
  });
}

async function clickTroopSendButton(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      "form[name='snd'] #btn_ok, " +
      "form[name='snd'] button[type='submit'], " +
      "form[name='snd'] input[type='submit'], " +
      "form[name='snd'] button.green, " +
      "form[name='snd'] input.green"
    ));
    const btn = candidates.find((element) =>
      Boolean(element) &&
      !element.disabled &&
      !element.classList.contains("disabled") &&
      element.getAttribute("aria-disabled") !== "true"
    ) || null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (clicked) {
    await page.waitForTimeout(1500);
  }
  return clicked;
}

async function isSettlementPageContext(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const path = (() => {
      try {
        return new URL(window.location.href).pathname.toLowerCase();
      } catch (_error) {
        return String(window.location.pathname || "").toLowerCase();
      }
    })();
    const isV2VPath = path.endsWith("/v2v.php") || path === "v2v.php";
    const text = normalize(document.body ? document.body.textContent : "");
    const hasFoundVillageText = text.includes("found new village");
    const hasSettlerInput = Boolean(
      document.querySelector(
        "form[name='snd'] input[name='t20'], " +
        "form[name='snd'] input[name*='settler'], " +
        "form[name='snd'] img.unit.u20, " +
        "form[name='snd'] img[alt*='ettler' i], " +
        "form[name='snd'] img[title*='ettler' i]"
      )
    );

    return {
      isSettlementContext: (isV2VPath || hasFoundVillageText) && hasSettlerInput,
      isV2VPath,
      hasFoundVillageText,
      hasSettlerInput
    };
  });
}

async function isSettlementConfirmationContext(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const text = normalize(document.body ? document.body.textContent : "");
    const href = normalize(window.location.href || "");

    const form = document.querySelector("form[name='snd'], form[action*='v2v.php'], form[action*='newdid=']");
    const formAction = form ? normalize(form.getAttribute("action") || "") : "";

    const hasSettlerSignal = Boolean(
      document.querySelector(
        "img.unit.u20, img[alt*='ettler' i], img[title*='ettler' i], " +
        "input[name='t20'], input[name*='settler'], input[id*='t20']"
      )
    );

    const hasCoordSignal = Boolean(
      document.querySelector(
        "input[name='x'], input[name='y'], input[id*='coord_x'], input[id*='coord_y'], " +
        "input[name*='coord_x'], input[name*='coord_y']"
      )
    ) || /\(\s*-?\d+\s*\|\s*-?\d+\s*\)/.test(text);

    const hasV2vHiddenSignal = Boolean(
      document.querySelector(
        "input[name='id'], input[name='newdid'], input[name='village'], " +
        "input[value*='v2v.php']"
      )
    );

    const hasSettlementText =
      text.includes("found new village") ||
      text.includes("new village") ||
      text.includes("settle");

    const hasSettlementRoute =
      href.includes("v2v.php") ||
      formAction.includes("v2v.php") ||
      formAction.includes("newdid=");

    // Confirmation pages can drop troop inputs, so accept route-level v2v signals.
    return (
      hasSettlementRoute ||
      hasV2vHiddenSignal ||
      (hasSettlementText && (hasSettlerSignal || hasCoordSignal))
    );
  });
}

async function openMapTile(page, x, y, settingsOrBaseUrl = {}, options = {}) {
  const baseUrl = typeof settingsOrBaseUrl === "string"
    ? settingsOrBaseUrl
    : resolveExpansionBaseUrl(settingsOrBaseUrl);
  const byIdUrl = resolvePlannedMapTileUrl(baseUrl, options);
  const tileUrl = byIdUrl || buildMapTileUrl(baseUrl, x, y);
  await page.goto(tileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  return tileUrl;
}

async function openMapSettlementPage(page, targetX, targetY, settingsOrBaseUrl = {}, options = {}) {
  const baseUrl = typeof settingsOrBaseUrl === "string"
    ? settingsOrBaseUrl
    : resolveExpansionBaseUrl(settingsOrBaseUrl);
  const resolveFoundVillageHref = async () => page.evaluate(({ x, y }) => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const coordMatch = String(
      (document.querySelector("#content h1, h1") || {}).textContent || ""
    ).match(/\((-?\d+)\|(-?\d+)\)/);

    // Prefer matching tile page coordinates when available.
    const titleMatchesTarget = Boolean(
      coordMatch &&
      Number(coordMatch[1]) === Number(x) &&
      Number(coordMatch[2]) === Number(y)
    );

    const optionsRoot = document.querySelector("#content #options") || document.querySelector("#options");
    const direct = optionsRoot ? optionsRoot.querySelector("a[href*='v2v.php']") : null;
    if (direct && (titleMatchesTarget || optionsRoot)) {
      return direct.getAttribute("href");
    }

    const byText = Array.from((optionsRoot || document).querySelectorAll("a[href]"))
      .find((a) => normalize(a.textContent).includes("found new village"));
    if (byText && (titleMatchesTarget || optionsRoot)) {
      return byText.getAttribute("href");
    }

    return null;
  }, { x: targetX, y: targetY });

  // 1) If we're already on the right tile detail page, use it directly.
  let href = await resolveFoundVillageHref();

  // 2) Prefer direct village3.php?id=… when provided (more reliable than map coords).
  if (!href) {
    const directTileUrl = resolvePlannedMapTileUrl(baseUrl, options);
    if (directTileUrl) {
      await page.goto(directTileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(200);
      href = await resolveFoundVillageHref();
    }
  }

  // 3) Otherwise open the map and try opening target tile details.
  if (!href) {
    await openMapTile(page, targetX, targetY, baseUrl);
    await page.waitForTimeout(200);

    const openedByLeftClick = await page.evaluate(({ x, y }) => {
      const tile = document.querySelector(
        `#enhanced-map #emap-tiles .emap-tile[data-tx="${x}"][data-ty="${y}"]`
      );
      if (!tile) {
        return false;
      }
      const rect = tile.getBoundingClientRect();
      const clientX = Math.floor(rect.left + (rect.width / 2));
      const clientY = Math.floor(rect.top + (rect.height / 2));
      tile.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0
      }));
      return true;
    }, { x: targetX, y: targetY });

    for (let i = 0; i < 6 && !href; i += 1) {
      await page.waitForTimeout(250);
      href = await resolveFoundVillageHref();
    }

    // 4) Fallback: context menu -> View Tile (server variant often binds this reliably).
    if (!href && openedByLeftClick) {
      const openedByContextMenu = await page.evaluate(({ x, y }) => {
        const tile = document.querySelector(
          `#enhanced-map #emap-tiles .emap-tile[data-tx="${x}"][data-ty="${y}"]`
        );
        const ctx = document.querySelector("#emap-ctx");
        if (!tile || !ctx) {
          return false;
        }

        const rect = tile.getBoundingClientRect();
        const clientX = Math.floor(rect.left + (rect.width / 2));
        const clientY = Math.floor(rect.top + (rect.height / 2));
        tile.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          button: 2
        }));

        const viewItem = ctx.querySelector(".emap-ctx-item[data-action='view']");
        if (!viewItem) {
          return false;
        }
        viewItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      }, { x: targetX, y: targetY });

      if (openedByContextMenu) {
        for (let i = 0; i < 6 && !href; i += 1) {
          await page.waitForTimeout(250);
          href = await resolveFoundVillageHref();
        }
      }
    }

    // 4) Last retry after brief settle.
    if (!href) {
      for (let i = 0; i < 4 && !href; i += 1) {
        await page.waitForTimeout(250);
        href = await resolveFoundVillageHref();
      }
    }
  }

  if (!href) {
    return false;
  }

  const url = new URL(href, page.url()).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  return true;
}

async function fillSettlersOnCurrentSendPage(page, amount = SETTLERS_NEEDED) {
  const filled = await page.evaluate((desiredAmount) => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .trim();
    const troopRows = Array.from(document.querySelectorAll(
      "form[name='snd'] tr, form[name='snd'] tbody tr, #troops tbody tr, table tbody tr"
    ));

    let input = null;

    // 0) Explicit known patterns first (common for settler slot/unit id variants).
    const directCandidates = [
      "form[name='snd'] input[name='t20']",
      "form[name='snd'] input[name*='20']",
      "form[name='snd'] input[name*='settler']",
      "form[name='snd'] input[id*='t20']",
      "form[name='snd'] input[id*='settler']"
    ];
    for (const selector of directCandidates) {
      const found = document.querySelector(selector);
      if (found) {
        input = found;
        break;
      }
    }

    // 1) Row-based lookup by textual unit name/icon label.
    for (const row of troopRows) {
      if (input) {
        break;
      }
      const unitNameEl = row.querySelector("td.un, td.desc .tit a, td.desc a, td.desc");
      const iconEl = row.querySelector("td.ico img[alt], td.ico img[title], img.unit");
      const unitName = unitNameEl
        ? String(unitNameEl.textContent || "").trim()
        : String((iconEl && (iconEl.getAttribute("alt") || iconEl.getAttribute("title"))) || "").trim();
      if (!normalize(unitName).includes("settler")) {
        continue;
      }
      input = row.querySelector("input[type='text'][name], input[name^='t'][type='text']");
      if (input) {
        break;
      }
    }

    // 2) Column-based lookup from Settler icon (u20 or alt/title).
    if (!input) {
      const settlerIcon = document.querySelector(
        "form[name='snd'] img.unit.u20, form[name='snd'] img[alt*='ettler' i], form[name='snd'] img[title*='ettler' i]"
      );
      if (settlerIcon) {
        const iconCell = settlerIcon.closest("td");
        const iconRow = settlerIcon.closest("tr");
        const troopTable = settlerIcon.closest("table");
        if (iconCell && iconRow && troopTable) {
          const iconCells = Array.from(iconRow.children || []);
          const columnIndex = iconCells.indexOf(iconCell);
          if (columnIndex >= 0) {
            const bodyRows = Array.from(troopTable.querySelectorAll("tr"));
            for (const row of bodyRows) {
              const cells = Array.from(row.children || []);
              if (cells[columnIndex]) {
                const colInput = cells[columnIndex].querySelector("input[type='text'][name], input[name^='t'], input[type='number'][name]");
                if (colInput) {
                  input = colInput;
                  break;
                }
              }
            }
          }
        }
      }
    }

    // 3) Fallback: locate any troop-like input in send form.
    if (!input) {
      const candidates = Array.from(document.querySelectorAll(
        "form[name='snd'] input[type='text'][name], form[name='snd'] input[type='number'][name]"
      ));
      input = candidates.find((el) => /^t\d+$/i.test(String(el.getAttribute("name") || ""))) || null;
    }
    if (!input) {
      return false;
    }

    input.focus();
    input.value = "";
    input.value = String(desiredAmount);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, amount);

  return Boolean(filled);
}

function buildMapTileUrl(baseUrl, x, y) {
  try {
    const parsed = new URL(baseUrl);
    const mapUrl = new URL(`${parsed.origin}/map.php`);
    mapUrl.searchParams.set("x", String(x));
    mapUrl.searchParams.set("y", String(y));
    return mapUrl.toString();
  } catch (_error) {
    const base = String(baseUrl || "").replace(/\/[^/]*$/, "");
    return `${base}/map.php?x=${encodeURIComponent(String(x))}&y=${encodeURIComponent(String(y))}`;
  }
}

/** Direct tile detail link (e.g. https://s1.nexian.world/village3.php?id=42423). */
function buildMapTileUrlById(baseUrl, mapTileId) {
  const id = Math.floor(Number(mapTileId));
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}/village3.php?id=${id}`;
  } catch (_error) {
    const base = String(baseUrl || "").replace(/\/[^/]*$/, "");
    return `${base}/village3.php?id=${id}`;
  }
}

function resolvePlannedMapTileUrl(baseUrl, target = {}) {
  const raw = String((target && (target.mapUrl || target.url)) || "").trim();
  if (raw) {
    try {
      const absolute = new URL(raw, baseUrl);
      return absolute.toString();
    } catch (_error) {
      return raw;
    }
  }
  return buildMapTileUrlById(baseUrl, target && target.mapTileId);
}

async function readEnhancedMapSettleCandidates(page, village, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const originX = Number(village && village.x);
  const originY = Number(village && village.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    return [];
  }

  const mapUrl = buildMapTileUrl(baseUrl, originX, originY);
  await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  return page.evaluate(async ({ ox, oy }) => {
    const tiles = Array.from(document.querySelectorAll("#enhanced-map #emap-tiles .emap-tile[data-tx][data-ty]"));
    if (!tiles.length) {
      return [];
    }

    const parseIntSafe = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const hasMark = (tile, markName) => String(tile.style.backgroundImage || "").includes(`/marks/${markName}.png`);

    const ctx = document.querySelector("#emap-ctx");
    const isVisible = (el) => {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    const contextLooksFreeSlot = async (tile) => {
      if (!ctx || !tile) {
        return null;
      }

      const rect = tile.getBoundingClientRect();
      const clientX = Math.floor(rect.left + (rect.width / 2));
      const clientY = Math.floor(rect.top + (rect.height / 2));

      tile.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 2
      }));

      await new Promise((resolve) => setTimeout(resolve, 10));

      const troops = ctx.querySelector(".emap-ctx-item[data-action='troops']");
      const merchants = ctx.querySelector(".emap-ctx-item[data-action='merchants']");
      const farm = ctx.querySelector(".emap-ctx-item[data-action='farm']");
      const simulate = ctx.querySelector(".emap-ctx-item[data-action='simulate']");
      const view = ctx.querySelector(".emap-ctx-item[data-action='view']");

      const hasView = isVisible(view);
      const canTroops = isVisible(troops);
      const canMerchants = isVisible(merchants);
      const canFarm = isVisible(farm);
      const canSimulate = isVisible(simulate);

      // Matches your sample: only "View Tile"/mark/sim-distance shown, while troops/trade/farm/simulate hidden.
      const looksFree =
        hasView &&
        !canTroops &&
        !canMerchants &&
        !canFarm &&
        !canSimulate;

      return looksFree;
    };

    const candidates = [];
    for (const tile of tiles) {
      const tx = parseIntSafe(tile.getAttribute("data-tx"));
      const ty = parseIntSafe(tile.getAttribute("data-ty"));
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        continue;
      }

      // Skip villages we own / occupied markers.
      if (hasMark(tile, "own")) {
        continue;
      }

      const bg = String(tile.style.backgroundImage || "").toLowerCase();
      const hasWarMark = hasMark(tile, "war");

      // Keep grassland-like tiles and skip obvious own/active combat markers.
      const looksGrassland = bg.includes("/grassland/");
      if (!looksGrassland || hasWarMark) {
        continue;
      }

      const dx = tx - ox;
      const dy = ty - oy;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      if (distance <= 0) {
        continue;
      }

      const freeByContext = await contextLooksFreeSlot(tile);
      if (freeByContext === false) {
        continue;
      }
      candidates.push({
        x: tx,
        y: ty,
        distance,
        freeByContext: freeByContext === true
      });
    }

    candidates.sort((a, b) => {
      if (a.freeByContext !== b.freeByContext) {
        return a.freeByContext ? -1 : 1;
      }
      return a.distance - b.distance;
    });
    return candidates;
  }, { ox: originX, oy: originY });
}

function generateNearbyOffsets(radius = AUTO_SETTLE_SEARCH_RADIUS) {
  const offsets = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      offsets.push({ dx, dy, distance });
    }
  }
  offsets.sort((a, b) => a.distance - b.distance);
  return offsets;
}

function coordKey(x, y) {
  return `${Number(x)}|${Number(y)}`;
}

function isExcludedCoord(excluded, x, y) {
  const set = excluded instanceof Set ? excluded : new Set(Array.isArray(excluded) ? excluded : []);
  return set.has(coordKey(x, y));
}

async function findSettleableByDirectRingSweep(page, village, excludedCoords = [], radius = AUTO_SETTLE_SEARCH_RADIUS, settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const originX = Number(village && village.x);
  const originY = Number(village && village.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    return null;
  }

  const offsets = generateNearbyOffsets(radius);
  for (const offset of offsets) {
    const x = originX + offset.dx;
    const y = originY + offset.dy;
    if (isExcludedCoord(excludedCoords, x, y)) {
      continue;
    }
    const verdict = await inspectMapTileForSettlement(page, baseUrl, x, y);
    if (!verdict) {
      continue;
    }
    if (verdict.settleable && !verdict.looksLikeOasis && !verdict.looksOccupied) {
      return { x, y, distance: offset.distance, source: "ring_sweep" };
    }
  }

  return null;
}

async function inspectMapTileForSettlement(page, baseUrl, x, y, options = {}) {
  const directTileUrl = resolvePlannedMapTileUrl(baseUrl, options);
  const tileUrl = directTileUrl || buildMapTileUrl(baseUrl, x, y);
  await page.goto(tileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const contentRoot = document.querySelector("#content") || document.body;
    const text = normalize(contentRoot ? contentRoot.textContent : "");
    const titleText = normalize((document.querySelector("#content h1, h1") || {}).textContent || "");

    const hasSettleAction = Boolean(
      document.querySelector(
        "#options a[href*='v2v.php'], " +
        "a[href*='newdid='], " +
        "a[href*='settle'], " +
        "button[name='settle']"
      )
    );
    const hasFoundVillageText = text.includes("found new village");

    // Use title-focused oasis detection to avoid false positives from popup/sidebar text
    // (e.g. farm list names containing "oases" inside map page HTML).
    const looksLikeOasis =
      titleText.includes("oasis") ||
      titleText.includes("occupied oasis") ||
      titleText.includes("unoccupied oasis");
    const looksOccupied =
      text.includes("occupied by") ||
      text.includes("village of") ||
      (
        titleText.includes("village") &&
        !titleText.includes("abandoned valley") &&
        !titleText.includes("unoccupied valley")
      );
    const looksUnoccupiedVillageSlot =
      text.includes("unoccupied valley") ||
      text.includes("abandoned valley") ||
      text.includes("empty valley") ||
      text.includes("free village site") ||
      text.includes("unoccupied");

    const settleable =
      hasSettleAction ||
      hasFoundVillageText ||
      (looksUnoccupiedVillageSlot && !looksLikeOasis && !looksOccupied);

    return {
      settleable,
      hasSettleAction,
      hasFoundVillageText,
      looksLikeOasis,
      looksOccupied,
      looksUnoccupiedVillageSlot
    };
  });
}

async function inspectCurrentTileViewForSettlement(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const contentRoot = document.querySelector("#content") || document.body;
    const text = normalize(contentRoot ? contentRoot.textContent : "");

    const optionsLink = document.querySelector(
      "#options a[href*='v2v.php'], #options a[href*='newdid='], #options a[href*='settle']"
    );
    const hasFoundVillageText = text.includes("found new village");
    const titleText = normalize((document.querySelector("#content h1, h1") || {}).textContent || "");
    const isAbandonedValley =
      titleText.includes("abandoned valley") ||
      titleText.includes("unoccupied valley") ||
      text.includes("abandoned valley") ||
      text.includes("unoccupied valley");
    const settleable = (Boolean(optionsLink) || hasFoundVillageText) && isAbandonedValley;

    let x = null;
    let y = null;
    const h1 = document.querySelector("#content h1, h1");
    const h1Text = h1 ? String(h1.textContent || "") : "";
    const coordMatch = h1Text.match(/\((-?\d+)\|(-?\d+)\)/);
    if (coordMatch) {
      x = Number(coordMatch[1]);
      y = Number(coordMatch[2]);
    }

    return {
      settleable,
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      hasFoundVillageText,
      hasOptionsLink: Boolean(optionsLink),
      isAbandonedValley
    };
  });
}

async function findClosestFreeSettlementTileViaEnhancedMap(page, village, options = {}) {
  const baseUrl = resolveExpansionBaseUrl(options.settings || options);
  const originX = Number(village && village.x);
  const originY = Number(village && village.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    return null;
  }

  const radius = Math.max(1, Math.floor(Number(options.radius) || AUTO_SETTLE_SEARCH_RADIUS));
  const mapUrl = buildMapTileUrl(baseUrl, originX, originY);
  await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const excludedCoords = Array.isArray(options.excludedCoords) ? options.excludedCoords : [];
  const candidates = await page.evaluate(({ ox, oy, maxRadius, excluded }) => {
    const tiles = Array.from(document.querySelectorAll("#enhanced-map #emap-tiles .emap-tile[data-tx][data-ty]"));
    const parseIntSafe = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const hasMark = (tile, markName) => String(tile.style.backgroundImage || "").includes(`/marks/${markName}.png`);

    const isExcluded = (x, y) => excluded.includes(`${x}|${y}`);

    return tiles
      .map((tile) => {
        const x = parseIntSafe(tile.getAttribute("data-tx"));
        const y = parseIntSafe(tile.getAttribute("data-ty"));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        if (isExcluded(x, y)) {
          return null;
        }
        if (tile.style.display === "none") {
          return null;
        }
        if (hasMark(tile, "own") || hasMark(tile, "war")) {
          return null;
        }
        const bg = String(tile.style.backgroundImage || "").toLowerCase();
        if (!bg.includes("/grassland/")) {
          return null;
        }
        const dx = x - ox;
        const dy = y - oy;
        const distance = Math.sqrt((dx * dx) + (dy * dy));
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance <= 0 || ring > maxRadius) {
          return null;
        }
        return { x, y, dx, dy, ring, distance };
      })
      .filter(Boolean)
      // Adjacent-first ring scan: radius 1, then 2, ... up to maxRadius.
      // Inside each ring, keep nearest Euclidean distance first.
      .sort((a, b) => (a.ring - b.ring) || (a.distance - b.distance));
  }, { ox: originX, oy: originY, maxRadius: radius, excluded: excludedCoords });

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const opened = await page.evaluate(({ x, y }) => {
      const tile = document.querySelector(
        `#enhanced-map #emap-tiles .emap-tile[data-tx="${x}"][data-ty="${y}"]`
      );
      if (!tile) {
        return false;
      }

      const rect = tile.getBoundingClientRect();
      const clientX = Math.floor(rect.left + (rect.width / 2));
      const clientY = Math.floor(rect.top + (rect.height / 2));

      // Left-click tile to open tile details/view.
      tile.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0
      }));

      return true;
    }, { x: candidate.x, y: candidate.y });

    if (!opened) {
      continue;
    }

    await page.waitForTimeout(450);
    const verdict = await inspectCurrentTileViewForSettlement(page);
    if (verdict && verdict.settleable) {
      return {
        x: Number.isFinite(verdict.x) ? verdict.x : candidate.x,
        y: Number.isFinite(verdict.y) ? verdict.y : candidate.y,
        distance: candidate.distance,
        source: "enhanced_map_view"
      };
    }

    // Return to map view for next tile probe.
    await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  return null;
}

async function findClosestFreeSettlementTile(page, village, options = {}) {
  const baseUrl = resolveExpansionBaseUrl(options.settings || options);
  const originX = Number(village && village.x);
  const originY = Number(village && village.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    return null;
  }

  const viaEnhancedView = await findClosestFreeSettlementTileViaEnhancedMap(page, village, options);
  if (viaEnhancedView) {
    return viaEnhancedView;
  }

  const radius = Math.max(1, Math.floor(Number(options.radius) || AUTO_SETTLE_SEARCH_RADIUS));
  const excluded = Array.isArray(options.excludedCoords) ? options.excludedCoords : [];

  // First try the enhanced-map tile grid if present (fast local view).
  const enhancedCandidates = await readEnhancedMapSettleCandidates(
    page,
    village,
    options.settings || options
  );
  if (enhancedCandidates.length > 0) {
    // Prefer enhanced map candidates directly. We already filtered own/war/invalid tiles.
    const directCandidate = enhancedCandidates.find((candidate) => candidate.distance <= radius) || null;
    if (directCandidate) {
      return {
        x: directCandidate.x,
        y: directCandidate.y,
        distance: directCandidate.distance,
        source: "enhanced_map"
      };
    }

    // If none inside radius, still attempt verification path below.
    for (const candidate of enhancedCandidates) {
      if (isExcludedCoord(excluded, candidate.x, candidate.y)) {
        continue;
      }
      if (candidate.distance > radius) {
        continue;
      }
      const verdict = await inspectMapTileForSettlement(page, baseUrl, candidate.x, candidate.y);
      if (verdict && verdict.settleable) {
        return { x: candidate.x, y: candidate.y, distance: candidate.distance, source: "enhanced_map" };
      }
    }
  }

  const offsets = generateNearbyOffsets(radius);
  for (const offset of offsets) {
    const x = originX + offset.dx;
    const y = originY + offset.dy;
    if (isExcludedCoord(excluded, x, y)) {
      continue;
    }
    const verdict = await inspectMapTileForSettlement(page, baseUrl, x, y);
    if (verdict && verdict.settleable) {
      return { x, y, distance: offset.distance, source: "scan" };
    }
  }

  return null;
}

async function findFirstSettleablePreferredTarget(page, preferredTargets = [], excludedCoords = [], settings = {}) {
  const baseUrl = resolveExpansionBaseUrl(settings);
  const normalizedTargets = Array.isArray(preferredTargets) ? preferredTargets : [];
  const excluded = new Set(
    (Array.isArray(excludedCoords) ? excludedCoords : [])
      .map((value) => String(value))
  );
  for (let i = 0; i < normalizedTargets.length; i += 1) {
    const candidate = normalizedTargets[i] || {};
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    if (excluded.has(coordKey(x, y))) {
      continue;
    }
    const verdict = await inspectMapTileForSettlement(page, baseUrl, x, y, candidate);
    if (verdict && verdict.settleable) {
      return {
        x,
        y,
        plannedIndex: i,
        mapTileId: candidate.mapTileId || null,
        mapUrl: candidate.mapUrl || candidate.url || null
      };
    }
  }
  return null;
}

async function sendSettlersToFoundVillage(page, village, targetX, targetY, options = {}) {
  const baseUrl = resolveExpansionBaseUrl(options.settings || options);
  const radius = Math.max(1, Math.floor(Number(options.radius) || AUTO_SETTLE_SEARCH_RADIUS));
  let resolvedTargetX = Number(targetX);
  let resolvedTargetY = Number(targetY);
  let targetSource = "manual";
  let plannedTargetIndex = null;
  let selectedTargetMeta = {};
  const excludedCoords = new Set();
  const attemptedTargets = [];

  const manualTargetProvided = Number.isFinite(resolvedTargetX) && Number.isFinite(resolvedTargetY);
  if (manualTargetProvided) {
    targetSource = "manual";
    selectedTargetMeta = {
      mapTileId: options.mapTileId || null,
      mapUrl: options.mapUrl || options.url || null
    };
  } else {
    const maxAttempts = 20;
    let picked = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const excludedList = Array.from(excludedCoords.values());
      const preferred = await findFirstSettleablePreferredTarget(
        page,
        options.preferredTargets || [],
        excludedList,
        options.settings || options
      );
      if (preferred) {
        picked = {
          x: preferred.x,
          y: preferred.y,
          source: "planned",
          plannedIndex: preferred.plannedIndex,
          mapTileId: preferred.mapTileId || null,
          mapUrl: preferred.mapUrl || null
        };
      } else {
        const nearest = await findClosestFreeSettlementTile(page, village, {
          ...options,
          excludedCoords: excludedList
        });
        if (!nearest) {
          break;
        }
        picked = {
          x: nearest.x,
          y: nearest.y,
          source: "auto",
          plannedIndex: null
        };
      }

      const verdict = await inspectMapTileForSettlement(page, baseUrl, picked.x, picked.y, picked);
      attemptedTargets.push(`${picked.x}|${picked.y}`);
      if (
        verdict &&
        verdict.settleable &&
        !verdict.looksOccupied &&
        !verdict.looksLikeOasis
      ) {
        resolvedTargetX = picked.x;
        resolvedTargetY = picked.y;
        targetSource = picked.source;
        plannedTargetIndex = picked.plannedIndex;
        selectedTargetMeta = {
          mapTileId: picked.mapTileId || null,
          mapUrl: picked.mapUrl || null
        };
        break;
      }

      excludedCoords.add(coordKey(picked.x, picked.y));
      picked = null;
    }

    if (!Number.isFinite(resolvedTargetX) || !Number.isFinite(resolvedTargetY)) {
      const sweep = await findSettleableByDirectRingSweep(
        page,
        village,
        Array.from(excludedCoords.values()),
        radius,
        options.settings || options
      );
      if (sweep) {
        resolvedTargetX = sweep.x;
        resolvedTargetY = sweep.y;
        targetSource = sweep.source || "auto";
      }
    }

    if (!Number.isFinite(resolvedTargetX) || !Number.isFinite(resolvedTargetY)) {
      return {
        status: "no_settle_target_found",
        phase: "settle",
        attemptedTargets,
        message: `Could not find a free settleable map tile nearby automatically (radius ${radius}). Tried: ${attemptedTargets.slice(0, 8).join(", ") || "none"}.`
      };
    }
  }

  if (!Number.isFinite(resolvedTargetX) || !Number.isFinite(resolvedTargetY)) {
    return {
      status: "no_settle_target_found",
      phase: "settle",
      message: `Could not find a free settleable map tile nearby automatically (radius ${radius}).`
    };
  }

  // Hard safety gate: do not try settling occupied/oasis targets.
  const targetVerdict = await inspectMapTileForSettlement(
    page,
    baseUrl,
    resolvedTargetX,
    resolvedTargetY,
    selectedTargetMeta
  );
  if (
    !targetVerdict ||
    !targetVerdict.settleable ||
    targetVerdict.looksOccupied ||
    targetVerdict.looksLikeOasis
  ) {
    return {
      status: "target_not_settleable",
      phase: "settle",
      targetSource,
      target: { x: resolvedTargetX, y: resolvedTargetY },
      message: `Target (${resolvedTargetX}|${resolvedTargetY}) is already settled or not eligible for founding.`
    };
  }

  // Map-only flow: open target tile -> click Found new village (v2v) -> send settlers.
  // Prefer direct village3.php?id=… when the planned target includes it.
  const openedMapSettlePage = await openMapSettlementPage(
    page,
    resolvedTargetX,
    resolvedTargetY,
    baseUrl,
    selectedTargetMeta
  );
  if (!openedMapSettlePage) {
    return {
      status: "settle_target_unavailable",
      phase: "settle",
      targetSource,
      message: `Could not open 'Found new village' action for target (${resolvedTargetX}|${resolvedTargetY}).`
    };
  }

  const settlementPage = await isSettlementPageContext(page);
  if (!settlementPage.isSettlementContext) {
    return {
      status: "settle_context_mismatch",
      phase: "settle",
      targetSource,
      target: { x: resolvedTargetX, y: resolvedTargetY },
      message: "Aborted for safety: page is not confirmed as settlement (v2v/found new village)."
    };
  }

  const settlersFilled = await fillSettlersOnCurrentSendPage(page, SETTLERS_NEEDED);
  if (!settlersFilled) {
    return {
      status: "settlers_send_unavailable",
      phase: "settle",
      targetSource,
      target: { x: resolvedTargetX, y: resolvedTargetY },
      message: "Could not find settler input on map send page."
    };
  }

  const missionSet = await setSettlementMission(page);
  if (!missionSet) {
    return {
      status: "settle_mission_unavailable",
      phase: "settle",
      targetSource,
      target: { x: resolvedTargetX, y: resolvedTargetY },
      message: "Could not force-select 'Found new village' mission on map send page."
    };
  }

  const sentToConfirm = await clickTroopSendButton(page);
  if (!sentToConfirm) {
    return {
      status: "settle_send_click_failed",
      phase: "settle",
      targetSource,
      message: "Could not click first send/continue button on map send page."
    };
  }

  const confirmationOk = await isSettlementConfirmationContext(page);
  if (!confirmationOk) {
    return {
      status: "settle_confirmation_mismatch",
      phase: "settle",
      targetSource,
      target: { x: resolvedTargetX, y: resolvedTargetY },
      message: "Aborted for safety: confirmation page does not indicate settlement mission."
    };
  }

  const confirmed = await clickTroopSendButton(page);
  if (!confirmed) {
    return {
      status: "settle_confirm_needed",
      phase: "settle",
      message: "Reached confirmation step but could not click final confirm. Please confirm manually.",
      target: { x: resolvedTargetX, y: resolvedTargetY },
      targetSource,
      plannedTargetIndex
    };
  }

  return {
    status: "settle_dispatched",
    phase: "settle",
    target: { x: resolvedTargetX, y: resolvedTargetY },
    targetSource,
    plannedTargetIndex,
    settlers: SETTLERS_NEEDED,
    message: `Settlers dispatched to (${resolvedTargetX}|${resolvedTargetY}) to found a new village.`
  };
}

async function runExpansionStep(getPage, settings, village) {
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is unavailable.");
  }

  const residencePrep = await ensureResidenceLevel10(page, village, settings);
  if (residencePrep.status !== "residence_ready") {
    return residencePrep;
  }

  const status = await getResidenceStatus(page, village, settings);

  if (status.settlerCount < SETTLERS_NEEDED) {
    const trainResult = await trainSettlers(page, village, SETTLERS_NEEDED, settings);
    return {
      status: trainResult.status,
      phase: "train",
      ...trainResult
    };
  }

  const settlementResources = checkSettlementResources(status.stock);
  if (!settlementResources.sufficient) {
    const deficitText = Object.entries(settlementResources.deficit)
      .map(([res, amount]) => `${res}: -${amount}`)
      .join(", ");
    return {
      status: "need_settlement_resources",
      phase: "resources",
      settlers: status.settlerCount,
      residenceLevel: status.residenceLevel,
      stock: status.stock,
      warehouseCap: status.warehouseCap,
      granaryCap: status.granaryCap,
      required: settlementResources.required,
      deficit: settlementResources.deficit,
      message: `Need at least 750 of each resource before settling. Deficit: ${deficitText}.`
    };
  }

  return {
    status: "ready_to_expand",
    phase: "ready",
    settlers: status.settlerCount,
    residenceLevel: status.residenceLevel,
    stock: status.stock,
    required: SETTLEMENT_RESOURCE_REQUIREMENT,
    message: `${status.settlerCount} settlers ready and resources are sufficient (at least 750 each). You can now send them from the Rally Point to an empty map tile to found a new village.`
  };
}

module.exports = {
  runExpansionStep,
  sendSettlersToFoundVillage,
  findClosestFreeSettlementTile,
  readEnhancedMapSettleCandidates,
  findClosestFreeSettlementTileViaEnhancedMap,
  ensureResidenceLevel10,
  trainSettlers,
  getResidenceStatus,
  buildMapTileUrlById,
  resolvePlannedMapTileUrl,
  RESIDENCE_SLOT,
  SETTLERS_NEEDED,
  SETTLEMENT_RESOURCE_REQUIREMENT
};
