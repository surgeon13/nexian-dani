const {
  isResourceExhaustionError,
  safeGotoWithRetry: sharedSafeGotoWithRetry
} = require("./browserNavigation");
const resourceCirculation = require("./resourceCirculation");

const DEFAULT_GRANARY_RATIO = 0.95;
const NPC_GOLD_COST = 3;

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

/**
 * Convert all crop into wood/clay/iron (0% crop), equal split, capped by warehouse.
 * Leftover that cannot fit in the warehouse stays as crop.
 */
function computeZeroCropDistribution(stock, warehouseCap) {
  const wood = Math.max(0, Math.floor(safeNumber(stock && stock.wood)));
  const clay = Math.max(0, Math.floor(safeNumber(stock && stock.clay)));
  const iron = Math.max(0, Math.floor(safeNumber(stock && stock.iron)));
  const crop = Math.max(0, Math.floor(safeNumber(stock && stock.crop)));
  const total = wood + clay + iron + crop;
  const cap = Math.max(0, Math.floor(safeNumber(warehouseCap)));

  if (total <= 0) {
    return {
      wood: 0,
      clay: 0,
      iron: 0,
      crop: 0,
      total: 0,
      convertedCrop: 0,
      leftoverCrop: 0
    };
  }

  const capacityThree = cap > 0 ? cap * 3 : total;
  const convertible = Math.min(total, capacityThree);
  const base = Math.floor(convertible / 3);
  let rem = convertible - base * 3;
  const next = { wood: base, clay: base, iron: base, crop: 0 };
  const order = ["wood", "clay", "iron"];
  for (const key of order) {
    if (rem <= 0) {
      break;
    }
    const room = cap > 0 ? Math.max(0, cap - next[key]) : rem;
    const add = Math.min(room, rem);
    next[key] += add;
    rem -= add;
  }

  // If warehouse caps blocked some remainder, keep it as crop.
  const placed = next.wood + next.clay + next.iron;
  next.crop = Math.max(0, total - placed);

  return {
    ...next,
    total,
    convertedCrop: Math.max(0, crop - next.crop),
    leftoverCrop: next.crop
  };
}

function parseExcludedVillageIds(csv) {
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

function resolveMarketplaceBuildingId(settings) {
  const raw = Number(
    settings && settings.npcCropConvertMarketplaceBuildingId != null
      ? settings.npcCropConvertMarketplaceBuildingId
      : 33
  );
  if (Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 33;
}

/**
 * NPC Merchant tab — Nexian uses marketplace slot id (default 33) + t=3 + gid=17:
 *   /build.php?id=33&t=3&gid=17&vid=<village>
 */
function buildNpcMerchantUrl(settings, villageId) {
  const origin = resolveGameOrigin(settings);
  const buildingId = resolveMarketplaceBuildingId(settings);
  return withVillageId(`${origin}/build.php?id=${buildingId}&t=3&gid=17`, villageId);
}

function buildNpcMerchantUrlCandidates(settings, villageId) {
  const origin = resolveGameOrigin(settings);
  const buildingId = resolveMarketplaceBuildingId(settings);
  const urls = [
    `${origin}/build.php?id=${buildingId}&t=3&gid=17`,
    `${origin}/build.php?id=${buildingId}&t=3`,
    `${origin}/build.php?gid=17&t=3`,
    `${origin}/build.php?bid=17&t=3`
  ];
  return urls.map((url) => withVillageId(url, villageId));
}

async function readHeaderStockAndCaps(page) {
  return page.evaluate(() => {
    const parseResCell = (id) => {
      const el = document.querySelector(id);
      if (!el) {
        return { current: 0, max: 0 };
      }
      const current = Number(el.getAttribute("data-v")) || 0;
      const max = Number(el.getAttribute("data-m")) || 0;
      return { current, max };
    };
    const wood = parseResCell("#l4");
    const clay = parseResCell("#l3");
    const iron = parseResCell("#l2");
    const crop = parseResCell("#l1");
    return {
      stock: {
        wood: wood.current,
        clay: clay.current,
        iron: iron.current,
        crop: crop.current
      },
      warehouseCap: Math.max(wood.max, clay.max, iron.max),
      granaryCap: crop.max
    };
  });
}

function buildVillageCenterUrl(settings, villageId) {
  const origin = resolveGameOrigin(settings);
  return withVillageId(`${origin}/village2.php`, villageId);
}

async function pageLooksLikeNpcMerchant(page) {
  return page.evaluate(() => {
    const form = document.querySelector("form#_fm1, form[name='snd']");
    const m2 = document.querySelectorAll('input[name="m2[]"]');
    const bodyText = document.body ? String(document.body.innerText || "") : "";
    const hasNpcTab = /npc merchant/i.test(bodyText);
    const hasM2 = m2.length >= 4;
    return Boolean(form && hasM2 && (hasNpcTab || document.getElementById("submitButton")));
  });
}

async function pageLooksLikeMarketplace(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? String(document.body.innerText || "") : "";
    const title = document.querySelector("#build h1, #content h1, h1");
    const titleText = title ? String(title.textContent || "") : "";
    const hasMarketName = /marketplace|marktplatz/i.test(`${titleText}\n${bodyText.slice(0, 800)}`);
    const hasTabs = Array.from(document.querySelectorAll("a")).some((a) => {
      const href = String(a.getAttribute("href") || "");
      const text = String(a.textContent || "");
      return (
        /[?&]t=\d+\b/.test(href) ||
        /npc merchant|send resources|buy|offer/i.test(text)
      );
    });
    return hasMarketName || (hasTabs && /merchant|marketplace|npc/i.test(bodyText));
  });
}

async function clickNpcMerchantTab(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("a, button, input[type='button']"));
    const link = candidates.find((el) => {
      const href = String(el.getAttribute("href") || "");
      const text = String(el.textContent || el.value || "").replace(/\s+/g, " ").trim();
      return /[?&]t=3\b/.test(href) || /^npc merchant$/i.test(text) || /npc merchant/i.test(text);
    });
    if (!link) {
      return false;
    }
    link.click();
    return true;
  });
  if (!clicked) {
    return false;
  }
  await page.waitForTimeout(900).catch(() => {});
  return pageLooksLikeNpcMerchant(page);
}

/**
 * Human path: village center → Marketplace (map/link) → NPC Merchant tab.
 * Discovers the marketplace slot per village instead of assuming id=33.
 */
async function openNpcMerchantViaVillageCenter(page, settings, villageId) {
  const centerUrl = buildVillageCenterUrl(settings, villageId);
  await sharedSafeGotoWithRetry(
    page,
    centerUrl,
    { waitUntil: "domcontentloaded", timeout: 60000 },
    2
  );
  await page.waitForTimeout(500).catch(() => {});

  const marketTarget = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const isMarketplaceLabel = (text) => /marketplace|marktplatz/i.test(text);

    const areas = Array.from(
      document.querySelectorAll("map#map2 area[href*='build.php'], area[href*='build.php']")
    );
    for (const area of areas) {
      const href = area.getAttribute("href") || "";
      const title = normalize(area.getAttribute("title") || "");
      const alt = normalize(area.getAttribute("alt") || "");
      const label = `${title} ${alt}`;
      if (isMarketplaceLabel(label) || /[?&](?:gid|bid)=17\b/i.test(href)) {
        return { href, label: label || "Marketplace", via: "map" };
      }
    }

    const anchors = Array.from(document.querySelectorAll("a[href*='build.php']"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const text = normalize(a.textContent || "");
      if (isMarketplaceLabel(text) || /[?&](?:gid|bid)=17\b/i.test(href)) {
        return { href, label: text || "Marketplace", via: "link" };
      }
    }
    return null;
  });

  if (!marketTarget || !marketTarget.href) {
    return { ok: false, reason: "marketplace_not_on_map" };
  }

  try {
    await sharedSafeGotoWithRetry(
      page,
      marketTarget.href.startsWith("http")
        ? withVillageId(marketTarget.href, villageId)
        : withVillageId(new URL(marketTarget.href, page.url()).toString(), villageId),
      { waitUntil: "domcontentloaded", timeout: 60000 },
      2
    );
  } catch (error) {
    if (isResourceExhaustionError(error)) {
      throw error;
    }
    return { ok: false, reason: "marketplace_nav_failed", detail: error.message || String(error) };
  }

  await page.waitForTimeout(600).catch(() => {});

  if (await pageLooksLikeNpcMerchant(page)) {
    return { ok: true, via: "village_center", marketLabel: marketTarget.label };
  }

  if (!(await pageLooksLikeMarketplace(page))) {
    return { ok: false, reason: "not_marketplace_page", marketLabel: marketTarget.label };
  }

  if (await clickNpcMerchantTab(page)) {
    return { ok: true, via: "village_center_npc_tab", marketLabel: marketTarget.label };
  }

  return { ok: false, reason: "npc_tab_missing", marketLabel: marketTarget.label };
}

async function openNpcMerchantViaDirectUrls(page, settings, villageId) {
  const candidates = buildNpcMerchantUrlCandidates(settings, villageId);
  for (const url of candidates) {
    try {
      await sharedSafeGotoWithRetry(
        page,
        url,
        { waitUntil: "domcontentloaded", timeout: 60000 },
        2
      );
    } catch (error) {
      if (isResourceExhaustionError(error)) {
        throw error;
      }
      continue;
    }
    if (await pageLooksLikeNpcMerchant(page)) {
      return true;
    }
    if (await clickNpcMerchantTab(page)) {
      return true;
    }
  }
  return false;
}

async function openNpcMerchant(page, settings, villageId) {
  // Prefer human path: center village → Marketplace → NPC Merchant.
  try {
    const human = await openNpcMerchantViaVillageCenter(page, settings, villageId);
    if (human && human.ok) {
      return true;
    }
  } catch (error) {
    if (isResourceExhaustionError(error)) {
      throw error;
    }
  }
  // Fallback: known direct marketplace URLs (id=33&t=3&gid=17, etc.).
  return openNpcMerchantViaDirectUrls(page, settings, villageId);
}

async function runNpcZeroCropExchange(page, desired) {
  const fillResult = await page.evaluate((target) => {
    const inputs = Array.from(document.querySelectorAll('input[name="m2[]"]'));
    if (inputs.length < 4) {
      return { ok: false, reason: "m2_missing" };
    }
    const values = [target.wood, target.clay, target.iron, target.crop].map((n) =>
      String(Math.max(0, Math.floor(Number(n) || 0)))
    );
    for (let i = 0; i < 4; i += 1) {
      inputs[i].value = values[i];
      inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[i].dispatchEvent(new Event("keyup", { bubbles: true }));
    }
    if (typeof window.calculateRest === "function") {
      window.calculateRest();
    }
    return {
      ok: true,
      values,
      newSum: (document.getElementById("newsum") || {}).textContent || "",
      remain: (document.getElementById("remain") || {}).textContent || ""
    };
  }, desired);

  if (!fillResult.ok) {
    return { status: "npc_form_unavailable", message: "NPC m2[] inputs not found." };
  }

  await page.evaluate(() => {
    if (typeof window.portionOut === "function") {
      window.portionOut();
    } else {
      const link = Array.from(document.querySelectorAll("a")).find((a) =>
        /distribute resources/i.test(a.textContent || "")
      );
      if (link) {
        link.click();
      }
    }
  });

  const exchangeReady = await page
    .waitForFunction(
      () => {
        const btn = document.getElementById("submitButton");
        if (btn && btn.style && btn.style.display !== "none") {
          return true;
        }
        return Array.from(document.querySelectorAll("a")).some((a) =>
          /exchange resources/i.test(a.textContent || "")
        );
      },
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!exchangeReady) {
    return {
      status: "npc_portion_failed",
      message: "NPC Step 1 (Distribute) did not unlock Exchange.",
      fillResult
    };
  }

  const exchangeOutcome = await page.evaluate(async () => {
    return await new Promise((resolve) => {
      const resultEl = document.getElementById("npcResult");
      const finish = (payload) => resolve(payload);
      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: "timeout",
          text: resultEl ? String(resultEl.textContent || "").trim() : ""
        });
      }, 20000);

      if (typeof window.submitNpcAjax === "function") {
        const originalXhr = window.XMLHttpRequest;
        // Prefer clicking the visible exchange link which calls submitNpcAjax.
      }

      const clickExchange = () => {
        const link = Array.from(document.querySelectorAll("#submitButton a, a")).find((a) =>
          /exchange resources/i.test(a.textContent || "")
        );
        if (link) {
          link.click();
          return true;
        }
        if (typeof window.submitNpcAjax === "function") {
          window.submitNpcAjax();
          return true;
        }
        return false;
      };

      if (!clickExchange()) {
        clearTimeout(timer);
        finish({ ok: false, reason: "exchange_click_missing" });
        return;
      }

      const started = Date.now();
      const poll = () => {
        const text = resultEl ? String(resultEl.textContent || "").trim() : "";
        const lower = text.toLowerCase();
        if (
          /success|exchanged|distributed|complete|done/i.test(lower) ||
          (resultEl && /success|ok|good/i.test(String(resultEl.className || "")))
        ) {
          clearTimeout(timer);
          finish({ ok: true, text });
          return;
        }
        if (/fail|error|not enough|gold|insufficient/i.test(lower) && text.length > 0) {
          clearTimeout(timer);
          finish({ ok: false, reason: "server_message", text });
          return;
        }
        if (Date.now() - started > 18000) {
          clearTimeout(timer);
          finish({ ok: false, reason: "timeout", text });
          return;
        }
        setTimeout(poll, 250);
      };
      setTimeout(poll, 400);
    });
  });

  if (!exchangeOutcome || !exchangeOutcome.ok) {
    return {
      status: "npc_exchange_failed",
      message:
        (exchangeOutcome && exchangeOutcome.text) ||
        (exchangeOutcome && exchangeOutcome.reason) ||
        "NPC exchange failed.",
      fillResult,
      exchangeOutcome
    };
  }

  return {
    status: "npc_ok",
    message: exchangeOutcome.text || "NPC exchange completed.",
    desired,
    fillResult,
    goldCost: NPC_GOLD_COST
  };
}

async function inspectVillageGranary(page, settings, village) {
  const statusUrl = String(settings.villageStatusUrl || `${resolveGameOrigin(settings)}/village1.php`);
  await sharedSafeGotoWithRetry(
    page,
    withVillageId(statusUrl, village.id),
    { waitUntil: "domcontentloaded", timeout: 60000 },
    2
  );
  const snapshot = await readHeaderStockAndCaps(page);
  const granaryCap = Math.max(0, safeNumber(snapshot.granaryCap));
  const crop = Math.max(0, safeNumber(snapshot.stock.crop));
  const ratio = granaryCap > 0 ? crop / granaryCap : 0;
  return {
    ...snapshot,
    granaryRatio: ratio,
    granaryPercent: Math.round(ratio * 1000) / 10
  };
}

async function convertCropIfGranaryFull(page, settings, village, options = {}) {
  const threshold = Math.min(
    0.999,
    Math.max(0.5, safeNumber(options.granaryRatio ?? settings.npcCropConvertGranaryRatio, DEFAULT_GRANARY_RATIO))
  );

  if (!page || page.isClosed()) {
    return { status: "npc_unavailable", message: "Session page unavailable.", village };
  }
  if (!village || !Number.isFinite(Number(village.id))) {
    return { status: "npc_no_village", message: "Village id required." };
  }

  const inspect = await inspectVillageGranary(page, settings, village);
  if (!(inspect.granaryCap > 0)) {
    return {
      status: "npc_no_granary",
      village,
      message: `No granary capacity readable for ${village.name || village.id}.`,
      ...inspect
    };
  }

  if (inspect.granaryRatio < threshold) {
    return {
      status: "npc_below_threshold",
      village,
      message: `Granary ${inspect.granaryPercent}% < ${Math.round(threshold * 100)}% — skip.`,
      threshold,
      ...inspect
    };
  }

  const desired = computeZeroCropDistribution(inspect.stock, inspect.warehouseCap);
  if (desired.convertedCrop <= 0) {
    return {
      status: "npc_nothing_to_convert",
      village,
      message: "Granary high but no convertible crop after warehouse caps.",
      desired,
      ...inspect
    };
  }

  const busy = resourceCirculation.isMarketplaceBusy && resourceCirculation.isMarketplaceBusy();
  if (busy) {
    return {
      status: "npc_marketplace_busy",
      village,
      message: "Marketplace busy with another transfer — retry later.",
      ...inspect
    };
  }

  if (resourceCirculation.beginMarketplaceExclusiveSession) {
    resourceCirculation.beginMarketplaceExclusiveSession();
  }
  try {
    const opened = await openNpcMerchant(page, settings, village.id);
    if (!opened) {
      return {
        status: "npc_market_unavailable",
        village,
        message: "Could not open NPC Merchant tab (marketplace missing?).",
        desired,
        ...inspect
      };
    }

    // Re-read stock on NPC page (authoritative m1 values).
    const live = await page.evaluate(() => {
      const m1 = Array.from(document.querySelectorAll('input[name="m1[]"]')).map((i) =>
        Number(i.value) || 0
      );
      const max123 = Number(window.max123) || 0;
      const max4 = Number(window.max4) || 0;
      return {
        stock: {
          wood: m1[0] || 0,
          clay: m1[1] || 0,
          iron: m1[2] || 0,
          crop: m1[3] || 0
        },
        warehouseCap: max123 || 0,
        granaryCap: max4 || 0
      };
    });
    const liveDesired = computeZeroCropDistribution(
      live.stock,
      live.warehouseCap || inspect.warehouseCap
    );

    const exchange = await runNpcZeroCropExchange(page, liveDesired);
    return {
      ...exchange,
      village,
      before: live.stock,
      afterDesired: liveDesired,
      granaryPercent: inspect.granaryPercent,
      threshold
    };
  } catch (error) {
    if (isResourceExhaustionError(error)) {
      throw error;
    }
    return {
      status: "npc_error",
      village,
      message: error && error.message ? error.message : String(error),
      ...inspect
    };
  } finally {
    if (resourceCirculation.endMarketplaceExclusiveSession) {
      resourceCirculation.endMarketplaceExclusiveSession();
    }
  }
}

/**
 * Round-robin one village per tick (same spirit as builder/troop RR).
 * Returns which village was checked and the convert result.
 */
async function runNpcCropConvertRoundRobin(page, settings, villages, state = {}) {
  const list = (Array.isArray(villages) ? villages : []).filter(
    (v) => Number.isFinite(Number(v && v.id)) && Number(v.id) > 0 && !v.underAttack
  );
  const excluded = parseExcludedVillageIds(settings.npcCropConvertExcludedVillageIds);
  const candidates = list.filter((v) => !excluded.has(Number(v.id)));
  if (!candidates.length) {
    return {
      status: "npc_no_candidates",
      message: "No villages available for NPC crop convert RR."
    };
  }

  let index = Number(state.roundRobinIndex) || 0;
  if (!Number.isFinite(index) || index < 0) {
    index = 0;
  }
  index = ((index % candidates.length) + candidates.length) % candidates.length;
  const village = candidates[index];
  const nextIndex = (index + 1) % candidates.length;

  const result = await convertCropIfGranaryFull(page, settings, village, {
    granaryRatio: settings.npcCropConvertGranaryRatio
  });

  // Advance RR except when marketplace is temporarily busy (retry same village).
  const advance = result.status !== "npc_marketplace_busy";

  return {
    ...result,
    roundRobinIndex: advance ? nextIndex : index,
    candidateCount: candidates.length,
    checkedVillageId: village.id,
    checkedVillageName: village.name || null
  };
}

module.exports = {
  computeZeroCropDistribution,
  convertCropIfGranaryFull,
  runNpcCropConvertRoundRobin,
  inspectVillageGranary,
  buildNpcMerchantUrl,
  buildNpcMerchantUrlCandidates,
  resolveMarketplaceBuildingId,
  openNpcMerchantViaVillageCenter,
  DEFAULT_GRANARY_RATIO,
  NPC_GOLD_COST
};
