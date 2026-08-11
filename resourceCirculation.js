const villageBuilder = require("./villageBuilder");
const {
  isResourceExhaustionError,
  safeGotoWithRetry: sharedSafeGotoWithRetry
} = require("./browserNavigation");

const DEFAULT_WAIT_MINUTES = 5;
const MARKETPLACE_EXCLUSIVE_RETRY_MS = 2500;
const PER_RESOURCE_RESERVE = 500;
const MAX_DONORS_DEFAULT = 3;
const SEND_MULTIPLE = 500;
const MIN_CHUNK = SEND_MULTIPLE;
const MEANINGFUL_CHUNKS = [500, 1000, 1500, 2000, 2500, 3000];
const RES_KEYS = ["wood", "clay", "iron", "crop"];

let marketplaceExclusiveDepth = 0;

function beginMarketplaceExclusiveSession() {
  marketplaceExclusiveDepth += 1;
}

function endMarketplaceExclusiveSession() {
  marketplaceExclusiveDepth = Math.max(0, marketplaceExclusiveDepth - 1);
}

function isMarketplaceBusy() {
  return marketplaceExclusiveDepth > 0;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function floorToMultiple(amount, multiple) {
  const m = Math.max(1, Math.floor(multiple));
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  return Math.floor(a / m) * m;
}

function ceilToMultiple(amount, multiple) {
  const m = Math.max(1, Math.floor(multiple));
  const a = Math.max(0, Math.ceil(Number(amount) || 0));
  return Math.ceil(a / m) * m;
}

function withVillageId(url, villageId) {
  if (!villageId) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("vid", String(villageId));
    return parsed.toString();
  } catch (_error) {
    return `${url}${url.includes("?") ? "&" : "?"}vid=${encodeURIComponent(String(villageId))}`;
  }
}

async function safeGotoWithRetry(page, url, options = {}, retries = 3) {
  return sharedSafeGotoWithRetry(page, url, options, retries);
}

async function safePageWait(page, ms) {
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }
  await page.waitForTimeout(ms);
}

/** Template progress heuristic: farther in active plan = larger score (preferred donors). */
function advancementScore(village, planMode) {
  try {
    const mode = planMode === "resource" ? "resource" : "village";
    const p = villageBuilder.previewPlan(village, { planMode: mode });
    if (!p || p.status === "error") {
      return 0;
    }
    if (p.status === "all_complete") {
      return 500000 + (safeNumber(p.totalStages, 1) || 1) * 1000;
    }
    if (p.status === "template_complete") {
      return 350000 + safeNumber(p.currentStageIndex, 0) * 500;
    }
    if (p.status === "pending" && p.next) {
      const si = safeNumber(p.next.stageIndex ?? p.currentStageIndex, 0);
      const sti = safeNumber(p.next.stepIndex, 0);
      return si * 10000 + sti * 50 + safeNumber(p.totalStages, 0);
    }
  } catch (_e) {
    return 0;
  }
  return 0;
}

function computeDistance(a, b) {
  const x1 = safeNumber(a && a.x, NaN);
  const y1 = safeNumber(a && a.y, NaN);
  const x2 = safeNumber(b && b.x, NaN);
  const y2 = safeNumber(b && b.y, NaN);
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(x1 - x2, y1 - y2);
}

function normalizePlanMode(planModeRaw) {
  return String(planModeRaw || "").toLowerCase() === "resource" ? "resource" : "village";
}

/**
 * Allowed receive headroom so target stays at or below receiverStorageMaxFillRatio of caps.
 */
function normalizeTargetRoom(options = {}) {
  const stock = options.targetStock || {};
  const wh = safeNumber(options.targetWarehouseCap, null);
  const gr = safeNumber(options.targetGranaryCap, null);
  let ratioRaw = safeNumber(options.receiverStorageMaxFillRatio, 0.8);
  ratioRaw = Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : 0.8;
  const ratio = Math.min(1, Math.max(0.05, ratioRaw));

  const room = (cap, cur) => {
    if (!Number.isFinite(cap) || cap <= 0) {
      return Number.MAX_SAFE_INTEGER;
    }
    const desired = Math.floor(cap * ratio);
    return Math.max(0, desired - Math.floor(safeNumber(cur, 0)));
  };

  return {
    wood: room(wh, stock.wood),
    clay: room(wh, stock.clay),
    iron: room(wh, stock.iron),
    crop: room(gr, stock.crop)
  };
}

function normalizeDeficit(deficit) {
  const out = { wood: 0, clay: 0, iron: 0, crop: 0 };
  ["wood", "clay", "iron", "crop"].forEach((k) => {
    out[k] = Math.max(0, Math.ceil(safeNumber(deficit[k], 0)));
  });
  return out;
}

function hasPositiveRoom(room) {
  return ["wood", "clay", "iron", "crop"].some((k) => safeNumber(room[k], 0) > 0);
}

function sumFlooredWarehouseHeadroom(room) {
  let s = 0;
  ["wood", "clay", "iron", "crop"].forEach((k) => {
    const v = safeNumber(room[k], 0);
    if (v > 0) {
      s += floorToMultiple(v, SEND_MULTIPLE);
    }
  });
  return s;
}

function subtractFromPools(deficitRemain, roomRemain, send) {
  ["wood", "clay", "iron", "crop"].forEach((k) => {
    deficitRemain[k] = Math.max(0, deficitRemain[k] - safeNumber(send[k], 0));
    roomRemain[k] = Math.max(0, safeNumber(roomRemain[k], 0) - safeNumber(send[k], 0));
  });
}

function cloneRes(o) {
  return {
    wood: safeNumber(o.wood, 0),
    clay: safeNumber(o.clay, 0),
    iron: safeNumber(o.iron, 0),
    crop: safeNumber(o.crop, 0)
  };
}

async function readVillageStockFromHeader(page) {
  return page.evaluate(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) {
        return 0;
      }
      const dataValue = Number(el.getAttribute("data-v"));
      if (Number.isFinite(dataValue) && dataValue >= 0) {
        return Math.floor(dataValue);
      }
      const rawText = String(el.textContent || "").trim();
      const slashIdx = rawText.indexOf("/");
      const currentSlice = slashIdx >= 0 ? rawText.slice(0, slashIdx) : rawText;
      const parsedText = Number(String(currentSlice).replace(/[^\d]/g, ""));
      return Number.isFinite(parsedText) ? parsedText : 0;
    };
    return { wood: read("#l4"), clay: read("#l3"), iron: read("#l2"), crop: read("#l1") };
  });
}

/** Stock + warehouse/granary caps from resource header (`data-v` / `data-m`). */
async function readVillageStockAndCapsFromHeader(page) {
  return page.evaluate(() => {
    const readPair = (selector) => {
      const el = document.querySelector(selector);
      if (!el) {
        return { cur: 0, max: 0 };
      }
      let cur = Number(el.getAttribute("data-v"));
      let max = Number(el.getAttribute("data-m"));
      const rawText = String(el.textContent || "").trim();
      const slashIdx = rawText.indexOf("/");
      if (!(Number.isFinite(cur) && cur >= 0)) {
        const currentSlice = slashIdx >= 0 ? rawText.slice(0, slashIdx) : rawText;
        cur = Number(String(currentSlice).replace(/[^\d]/g, ""));
      }
      if (!(Number.isFinite(max) && max > 0) && slashIdx >= 0) {
        max = Number(String(rawText.slice(slashIdx + 1)).replace(/[^\d]/g, ""));
      }
      return {
        cur: Number.isFinite(cur) && cur >= 0 ? Math.floor(cur) : 0,
        max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
      };
    };
    const wood = readPair("#l4");
    const clay = readPair("#l3");
    const iron = readPair("#l2");
    const crop = readPair("#l1");
    return {
      stock: { wood: wood.cur, clay: clay.cur, iron: iron.cur, crop: crop.cur },
      warehouseCap: Math.max(wood.max, clay.max, iron.max),
      granaryCap: crop.max
    };
  });
}

function normalizeRatio(raw, fallback) {
  let n = Number(raw);
  if (!Number.isFinite(n)) {
    n = fallback;
  }
  if (n > 1 && n <= 100) {
    n = n / 100;
  }
  if (!(n > 0 && n <= 1)) {
    n = fallback;
  }
  return Math.min(1, Math.max(0.05, n));
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

/**
 * Pivot for overflow / evacuation: configured IDs → capital → first other village.
 */
function resolvePivotVillage(villages, settings = {}, sourceVillageId = null) {
  const list = (Array.isArray(villages) ? villages : []).filter(
    (v) => Number.isFinite(Number(v && v.id)) && Number(v.id) > 0
  );
  const sourceId = Number.isFinite(Number(sourceVillageId)) ? Number(sourceVillageId) : null;
  const notSource = (v) => sourceId == null || Number(v.id) !== sourceId;

  const configured = parseVillageIdSet(
    (settings && (settings.resourceOverflowPivotVillageIds || settings.raidEvacuationPivotVillageIds)) || ""
  );
  if (configured.size > 0) {
    const hit = list.find((v) => configured.has(Number(v.id)) && notSource(v));
    if (hit) {
      return hit;
    }
  }

  const capital = list.find((v) => v.isCapital && notSource(v));
  if (capital) {
    return capital;
  }

  return list.find((v) => notSource(v)) || null;
}

function fillRatiosForStock(stock, warehouseCap, granaryCap) {
  const wh = Math.max(0, Math.floor(safeNumber(warehouseCap, 0)));
  const gr = Math.max(0, Math.floor(safeNumber(granaryCap, 0)));
  const ratio = (cur, cap) => (cap > 0 ? cur / cap : 0);
  return {
    wood: ratio(safeNumber(stock.wood, 0), wh),
    clay: ratio(safeNumber(stock.clay, 0), wh),
    iron: ratio(safeNumber(stock.iron, 0), wh),
    crop: ratio(safeNumber(stock.crop, 0), gr),
    warehouseCap: wh,
    granaryCap: gr,
    maxRatio: Math.max(
      ratio(safeNumber(stock.wood, 0), wh),
      ratio(safeNumber(stock.clay, 0), wh),
      ratio(safeNumber(stock.iron, 0), wh),
      ratio(safeNumber(stock.crop, 0), gr)
    )
  };
}

async function readHeaderStockMinOfPair(page) {
  const s0 = await readVillageStockFromHeader(page);
  await safePageWait(page, 500);
  const s1 = await readVillageStockFromHeader(page);
  return {
    wood: Math.min(s0.wood, s1.wood),
    clay: Math.min(s0.clay, s1.clay),
    iron: Math.min(s0.iron, s1.iron),
    crop: Math.min(s0.crop, s1.crop)
  };
}

async function readStableHeaderStockMin(page) {
  let prev = await readHeaderStockMinOfPair(page);
  const maxPasses = 8;
  for (let round = 0; round < maxPasses; round += 1) {
    await safePageWait(page, 400);
    const next = await readHeaderStockMinOfPair(page);
    const slack = 72;
    if (
      Math.abs(prev.wood - next.wood) <= slack &&
      Math.abs(prev.clay - next.clay) <= slack &&
      Math.abs(prev.iron - next.iron) <= slack &&
      Math.abs(prev.crop - next.crop) <= slack
    ) {
      return next;
    }
    prev = next;
  }
  return prev;
}

async function bumpTravianHeaderStockRefresh(page) {
  await page.evaluate(() => {
    for (let idx = 1; idx <= 4; idx += 1) {
      try {
        if (typeof window.upd_res === "function") {
          window.upd_res(idx);
        }
      } catch (_e) {}
    }
  });
}

async function readDonorBaselineAtVillageCenter(page, settings, donorVillageId) {
  const base = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  await safeGotoWithRetry(page, withVillageId(base, donorVillageId), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }, 2);
  await safePageWait(page, 520);
  return readHeaderStockMinOfPair(page);
}

async function readDonorStockAfterReturnToVillage(page, settings, donorVillageId) {
  const base = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  await safeGotoWithRetry(page, withVillageId(base, donorVillageId), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }, 2);
  await safePageWait(page, 780);
  await bumpTravianHeaderStockRefresh(page);
  await safePageWait(page, 420);
  return readStableHeaderStockMin(page);
}

function buildMarketSendUrl(settings, donorVillageId, targetVillageId) {
  if (!donorVillageId || !targetVillageId) {
    return null;
  }
  const base = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  try {
    const parsed = new URL(base);
    parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, "/build.php");
    parsed.searchParams.set("bid", "17");
    parsed.searchParams.set("vid", String(donorVillageId));
    parsed.searchParams.set("vid2", String(targetVillageId));
    return parsed.toString();
  } catch (_e) {
    return null;
  }
}

function buildMarketSendUrlCandidates(marketUrl, donorVillageId) {
  const candidates = [];
  const pushUnique = (u) => {
    if (u && !candidates.includes(u)) {
      candidates.push(u);
    }
  };
  pushUnique(marketUrl);
  try {
    const parsed = new URL(marketUrl);
    parsed.searchParams.set("bid", "17");
    pushUnique(parsed.toString());
    if (donorVillageId) {
      parsed.searchParams.set("vid", String(donorVillageId));
      pushUnique(parsed.toString());
    }
  } catch (_e) {}
  pushUnique(`${marketUrl}${marketUrl.includes("?") ? "&" : "?"}t=5`);
  return candidates;
}

async function openMarketSendTab(page, marketUrl, donorVillageId) {
  const urls = buildMarketSendUrlCandidates(marketUrl, donorVillageId);
  for (const url of urls) {
    try {
      await safeGotoWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: 60000 }, 4);
    } catch (error) {
      if (isResourceExhaustionError(error)) {
        throw error;
      }
      continue;
    }
    const ok = await page.evaluate(() => {
      return Array.from(document.forms || []).some((form) => {
        const hasR = Boolean(
          form.querySelector("input[name='r1'], input[name='r2'], input[name='r3'], input[name='r4']")
        );
        const hasXY = Boolean(
          form.querySelector(
            "input[name='x'], input[name='y'], input[name='xCoord'], input[name='yCoord'], #xCoordInputMap, #yCoordInputMap"
          )
        );
        const hasVid = Boolean(form.querySelector("input[name='vid2'], input[name='id']"));
        return hasR && (hasXY || hasVid);
      });
    });
    if (ok) {
      return true;
    }
  }
  return false;
}

/** Parse available merchant count from page text (Nexian / Travian markup varies widely). */
function parseMerchantAvailFromNormalizedText(norm) {
  const text = String(norm || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ");

  const patterns = [
    /(\d+)\s*\/\s*(\d+)\s+merchants?\b/,
    /(\d+)\s*\/\s*(\d+)\s+traders?\b/,
    /(\d+)\s*\/\s*(\d+)\s+h[aä]ndlers?\b/i,
    /merchants?\b[^/\d]{0,55}(\d+)\s*\/\s*(\d+)/,
    /h[aä]ndlers?\b[^/\d]{0,55}(\d+)\s*\/\s*(\d+)/i,
    /\bmark(?:tplatz|et)\b[^/\d]{0,70}(\d+)\s*\/\s*(\d+)/,
    /(\d+)\s*\/\s*(\d+)\s+bots?\b/,
    /(\d+)\s*\/\s*(\d+)(?:\([^)]*\))?\s*:\s*für\s*händler/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && Number.isFinite(Number(m[1]))) {
      return Number(m[1]);
    }
  }

  const legacy = text.match(/merchant[^0-9]{0,35}(\d+)\s*\/\s*(\d+)/);
  if (legacy && Number.isFinite(Number(legacy[1]))) {
    return Number(legacy[1]);
  }

  const bare = text.match(/\b(\d+)\s*\/\s*(\d+)\b(?=\s*(?:merchant|trade|transport|handler|markt))/i);
  if (bare && Number.isFinite(Number(bare[1]))) {
    return Number(bare[1]);
  }

  return null;
}

function parseMerchantFleet(bodyTextLower) {
  const text = bodyTextLower;
  let availM = parseMerchantAvailFromNormalizedText(text);

  let perM = 0;
  for (const mx of [...MEANINGFUL_CHUNKS].sort((a, b) => b - a)) {
    const re = new RegExp(`\\(${mx}\\)`, "g");
    if (re.test(text)) {
      perM = mx;
      break;
    }
  }
  if (!(perM > 0)) {
    const mBig = bodyTextLower.match(/\((\d{3,5})\)/g);
    if (mBig) {
      for (const blob of mBig) {
        const n = Number(blob.replace(/\D/g, ""));
        if (n >= SEND_MULTIPLE) {
          perM = Math.max(perM, n);
        }
      }
      perM = floorToMultiple(perM, SEND_MULTIPLE);
    }
  }
  if (!(perM > 0)) {
    perM = 3000;
  }

  return { availM: Number.isFinite(availM) ? availM : null, perM };
}

async function readMerchantFleetFromPage(page) {
  const bodyTextLower = await page.evaluate(() =>
    String(document.body && document.body.textContent ? document.body.textContent : "")
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
  );
  return parseMerchantFleet(bodyTextLower);
}

async function readMarketSendOutcomeSignals(page) {
  const ev = await page.evaluate(() => {
    const classifyMovementRowDirection = (row) => {
      const tbody = row.closest("tbody");
      const tbClass = tbody ? String(tbody.className || "").toLowerCase() : "";
      if (/\bincomings?\b/.test(tbClass)) {
        return "in";
      }
      if (/\boutgoings?\b/.test(tbClass) || /\bcommands\b/.test(tbClass)) {
        return "out";
      }
      const typ = row.querySelector("td.typ");
      if (typ) {
        const gc = `${typ.className || ""}`.toLowerCase();
        if (/\bd2\b|^d2 /.test(gc) || /dir_?out|movement_?out/.test(gc)) return "out";
        if (/\bd1\b|^d1 /.test(gc) || /dir_?in|movement_?in/.test(gc)) return "in";
      }
      return "unknown";
    };

    let outgoingRowsDirected = 0;
    const rows = document.querySelectorAll(
      "#movements tbody tr, " +
        "table#movements tbody tr, " +
        "#outgoing tbody tr, " +
        ".outgoing tbody tr, " +
        "#statistics150 tbody tr"
    );
    Array.from(rows).forEach((row) => {
      if (classifyMovementRowDirection(row) !== "out") {
        return;
      }
      const t = String(row.textContent || "").toLowerCase();
      const merchantLex =
        /merchant|händler|handler|marketplace|marktplatz|transport|trade|delivery|\bres\b/.test(t) ||
        (t.includes("resource") && /send|trade|merchant/i.test(t));
      if (!merchantLex) return;
      const hasEta = /\d+\s*:\s*\d/.test(t) || /\b\d{1,2}:\d{2}:\d{2}\b/.test(t);
      const resourceish =
        /\b(wood|clay|iron|crop|lumber)\b[^a-z]{0,12}\d{2,}/.test(t) ||
        /\d{3,}\s*[\s,.·]+\s*\d{3,}\s*[\s,.·]+\s*\d{3,}/.test(t);
      if (hasEta || resourceish) {
        outgoingRowsDirected += 1;
      }
    });

    const bodyNorm = String(document.body && document.body.textContent ? document.body.textContent : "")
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ");

    return { outgoingRowsDirected, outgoingRowsLegacy: outgoingRowsDirected, bodyNorm };
  });

  return {
    availableMerchants: parseMerchantAvailFromNormalizedText(ev.bodyNorm),
    outgoingRowsDirected: ev.outgoingRowsDirected,
    outgoingRowsLegacy: ev.outgoingRowsLegacy
  };
}

function marketSendHeuristicSuccess(okText, merchantsDropped, outgoingInc) {
  if (okText && okText.ok === true) {
    return true;
  }
  return Boolean(merchantsDropped || outgoingInc);
}

function dispatchSignalsStrong(okText, merchantsDropped, outgoingInc) {
  if (okText && okText.ok === true) {
    return true;
  }
  if (merchantsDropped) {
    return true;
  }
  if (outgoingInc) {
    return true;
  }
  return false;
}

function verifyDonorStockReflectsSend(pre, post, sent, elapsedMs = 0) {
  const keys = ["wood", "clay", "iron", "crop"];
  const elapsed = safeNumber(elapsedMs, 0);
  for (const key of keys) {
    const planned = floorToMultiple(sent[key], SEND_MULTIPLE);
    if (!(planned >= MIN_CHUNK)) {
      continue;
    }
    const p0 = Math.floor(safeNumber(pre[key], 0));
    const p1 = Math.floor(safeNumber(post[key], 0));
    const delta = p0 - p1;
    const slack = Math.max(520, Math.ceil(planned * 0.22));
    let prod = 0;
    if (elapsed > 0) {
      prod += Math.min(Math.ceil(planned * 0.48), Math.ceil((elapsed / 1000) * 30));
    }
    const need = planned - slack - prod;
    const floorPct = Math.max(50, Math.floor(planned * 0.035));
    const minDelta = Math.min(Math.ceil(planned * 0.88), Math.max(floorPct, need));
    if (delta < minDelta) {
      return {
        ok: false,
        detail: `${key}: planned≈${planned}, drop=${delta} (pre=${p0} post=${p1}) min≈${minDelta}`
      };
    }
  }
  return { ok: true };
}

async function nexianSecondMarketOkClick(page) {
  const pulse = async () =>
    page.evaluate(() => {
      const clickHuman = (el) => {
        if (!el) return false;
        try {
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          if (typeof el.click === "function") el.click();
          return true;
        } catch (_e) {
          return false;
        }
      };
      const sendForm = document.querySelector("#send_select")?.closest("form");
      const btn =
        (sendForm &&
          (sendForm.querySelector("input#btn_ok[name='s1']:not([disabled])") ||
            sendForm.querySelector("#btn_ok:not([disabled])"))) ||
        document.querySelector("input#btn_ok[name='s1']:not([disabled])") ||
        document.querySelector("#btn_ok:not([disabled])");
      if (!btn) {
        return { clicked: false };
      }
      return { clicked: clickHuman(btn) };
    });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await safePageWait(page, attempt === 0 ? 850 : 450);
    const r = await pulse();
    if (r.clicked) {
      return { clicked: true, method: `second_ok_${attempt}` };
    }
  }
  return { clicked: false, method: "second_ok_miss" };
}

async function submitResourceSend(page, targetVillage, sendAmounts) {
  const send = {
    wood: floorToMultiple(sendAmounts.wood || 0, SEND_MULTIPLE),
    clay: floorToMultiple(sendAmounts.clay || 0, SEND_MULTIPLE),
    iron: floorToMultiple(sendAmounts.iron || 0, SEND_MULTIPLE),
    crop: floorToMultiple(sendAmounts.crop || 0, SEND_MULTIPLE)
  };
  const total = send.wood + send.clay + send.iron + send.crop;
  if (!(total >= MIN_CHUNK)) {
    return { ok: false, reason: "no_payload", submitted: send };
  }

  const tid = safeNumber(targetVillage && targetVillage.id, null);
  const tx = safeNumber(targetVillage && targetVillage.x, NaN);
  const ty = safeNumber(targetVillage && targetVillage.y, NaN);
  const preSignals = await readMarketSendOutcomeSignals(page);

  const attempted = await page.evaluate(({ sendVals, tid: targetId, tx: destX, ty: destY }) => {
    const clickHuman = (el) => {
      if (!el) return false;
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        if (typeof el.click === "function") el.click();
        return true;
      } catch (_e) {
        return false;
      }
    };

    const sendSelectForm =
      document.querySelector("#send_select") && document.querySelector("#send_select").closest("form");
    let chosenForm =
      sendSelectForm ||
      Array.from(document.forms || []).find((f) => {
        const hasR = f.querySelector("input[name='r1'], input[name='r2'], input[name='r3'], input[name='r4']");
        const hasXY =
          f.querySelector(
            "input[name='x'], input[name='y'], input[name='xCoord'], input[name='yCoord'], #xCoordInputMap, #yCoordInputMap"
          );
        const hasVid = f.querySelector("input[name='vid2'], input[name='id']");
        return Boolean(hasR && (hasXY || hasVid));
      });

    if (!chosenForm) {
      return { clicked: false };
    }

    const hasCoord = Boolean(
      chosenForm.querySelector(
        "input[name='x'], input[name='y'], input[name='xCoord'], input[name='yCoord'], #xCoordInputMap, #yCoordInputMap"
      )
    );

    /** Travian/Nexian often honors x/y over vid2 — always sync both to intended receiver */
    const targetIdNum =
      Number.isFinite(Number(targetId)) && Number(targetId) > 0 ? Math.floor(Number(targetId)) : 0;
    if (targetIdNum > 0) {
      let hid = chosenForm.querySelector("input[name='vid2']");
      if (!hid) {
        hid = document.createElement("input");
        hid.type = "hidden";
        hid.name = "vid2";
        chosenForm.appendChild(hid);
      }
      hid.value = String(targetIdNum);
    }

    const coordsOk = Number.isFinite(destX) && Number.isFinite(destY);
    if (coordsOk && hasCoord) {
      const xi = Math.trunc(destX);
      const yi = Math.trunc(destY);
      const touch = (el) => {
        if (!el) {
          return;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
      };
      [["x", xi], ["y", yi], ["xCoord", xi], ["yCoord", yi]].forEach(([nm, val]) => {
        const el = chosenForm.querySelector(`input[name='${nm}']`);
        if (el) {
          el.value = String(val);
          touch(el);
        }
      });
      const mx =
        chosenForm.querySelector("#xCoordInputMap") || document.querySelector("#xCoordInputMap");
      const my =
        chosenForm.querySelector("#yCoordInputMap") || document.querySelector("#yCoordInputMap");
      if (mx) {
        mx.value = String(xi);
        touch(mx);
      }
      if (my) {
        my.value = String(yi);
        touch(my);
      }
    }

    const setInput = (name, val) => {
      const el = chosenForm.querySelector(`input[name='${name}']`);
      if (!el) {
        return false;
      }
      el.value = String(Math.max(0, Math.floor(Number(val) || 0)));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
      return true;
    };

    setInput("r1", sendVals.wood);
    setInput("r2", sendVals.clay);
    setInput("r3", sendVals.iron);
    setInput("r4", sendVals.crop);

    [1, 2, 3, 4].forEach((i) => {
      const inp = chosenForm.querySelector(`input[name='r${i}']`);
      if (inp && typeof window.upd_res === "function") {
        try {
          window.upd_res(i, 1);
        } catch (_e) {}
        try {
          window.upd_res(i);
        } catch (_e2) {}
      }
    });

    const btn =
      chosenForm.querySelector("input#btn_ok[name='s1']:not([disabled])") ||
      chosenForm.querySelector("#btn_ok:not([disabled])") ||
      chosenForm.querySelector("input[type='submit']:not([disabled])");

    if (!btn || !clickHuman(btn)) {
      return { clicked: false };
    }
    return { clicked: true };
  }, {
    sendVals: send,
    tid,
    tx,
    ty
  });

  if (!attempted || !attempted.clicked) {
    return { ok: false, reason: "submit_click_failed", submitted: send };
  }

  await safePageWait(page, 900);
  if (typeof page.waitForLoadState === "function") {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => null);
  }
  const confirmMeta = await nexianSecondMarketOkClick(page);
  await safePageWait(page, 2800);

  const sniffOutcome = async () =>
    page.evaluate(() => {
      const text = String(document.body ? document.body.textContent : "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ");

      const failureNeedles = [
        "no merchants available",
        "no merchant available",
        "not enough merchants",
        "not enough trader",
        "insufficient merchants",
        "invalid target",
        "could not send",
        "you cannot send",
        "merchant could not",
        "resources could not be sent",
        "cannot send to this village",
        "no traders available",
        "not enough merchants available"
      ];
      if (failureNeedles.some((f) => text.includes(f))) {
        return { ok: false };
      }

      const okPhrase =
        /\b(sent successfully|successfully\s+sent|have\s+been\s+sent|was\s+sent|were\s+sent)\b/i.test(text) ||
        /\bmerchant(s)?\s+(has|have)\s+(been\s+sent|left|started|departed)\b/i.test(text) ||
        /\b(traders?\s+have\s+left|transports?\s+have\s+dispatch|distribution\s+(is\s+)?complete)\b/i.test(text) ||
        /\b(unterwegs|verschickt|gesendet|abgeschickt|versand(t| erfolg)?| erfolgreich(\s|$)|delivery\s+(was\s+)?(scheduled|successful))\b/i.test(text) ||
        /\b(dispatch(ed)?|on\s+(their\s+)?way|marketplace\s+confirmation)\b/.test(text) ||
        (text.includes("underway") && (text.includes("merchant") || text.includes("trade")));

      if (okPhrase) return { ok: true };

      if (
        /\b(unterwegs|underway|verschickt|gesendet|abgeschickt|dispatched|sent)\b/i.test(text) &&
        /\b(resource|merchant|trade|delivery|transport|markt)\b/i.test(text)
      ) {
        return { ok: true };
      }

      return { ok: null };
    });

  let resultCheck = await sniffOutcome();
  if (resultCheck.ok !== true && resultCheck.ok !== false) {
    await safePageWait(page, 1500);
    resultCheck = await sniffOutcome();
  }

  const postSignals = await readMarketSendOutcomeSignals(page);

  const merchDrop =
    Number.isFinite(preSignals.availableMerchants) &&
    Number.isFinite(postSignals.availableMerchants) &&
    postSignals.availableMerchants < preSignals.availableMerchants;

  const outgoingInc =
    safeNumber(postSignals.outgoingRowsDirected, 0) > safeNumber(preSignals.outgoingRowsDirected, 0);

  if (resultCheck.ok === false) {
    return {
      ok: false,
      reason: "market_error_page",
      submitted: send,
      detail: confirmMeta.method
    };
  }

  const okHeur = marketSendHeuristicSuccess(resultCheck, merchDrop, outgoingInc);
  const nexianDoubleConfirmed = /^second_ok_\d+$/.test(confirmMeta.method);
  if (!okHeur && resultCheck.ok !== true) {
    if (nexianDoubleConfirmed && resultCheck.ok !== false) {
      return {
        ok: true,
        submitted: send,
        verificationHints: {
          strong: Boolean(merchDrop || outgoingInc),
          tentativeAfterNexianDoubleOk: true
        }
      };
    }
    return {
      ok: false,
      reason: "inconclusive_send",
      submitted: send,
      detail: `${confirmMeta.method}; merch=${preSignals.availableMerchants}->${postSignals.availableMerchants}`
    };
  }

  return {
    ok: true,
    submitted: send,
    verificationHints: {
      strong: dispatchSignalsStrong(resultCheck, merchDrop, outgoingInc)
    }
  };
}

/**
 * Cover deficits first (500 multiples), then grow toward merchant pack ceiling
 * using meaningful chunks (500…3000) while respecting donor surplus and receiver headroom.
 */
function planSendPayload({
  deficitRemain,
  roomRemain,
  donorStock,
  reserve,
  merchantPerTrip,
  maxTrips
}) {
  const RES = RES_KEYS;
  const send = { wood: 0, clay: 0, iron: 0, crop: 0 };

  RES.forEach((k) => {
    const need = safeNumber(deficitRemain[k], 0);
    if (need <= 0) {
      return;
    }
    const deficitChunk = ceilToMultiple(need, SEND_MULTIPLE);
    const maxDonor = Math.max(0, floorToMultiple(donorStock[k] - reserve, SEND_MULTIPLE));
    const maxRoom = Math.max(0, floorToMultiple(roomRemain[k], SEND_MULTIPLE));
    send[k] = Math.min(deficitChunk, maxDonor, maxRoom);
  });

  let total = send.wood + send.clay + send.iron + send.crop;
  const perM = Math.max(SEND_MULTIPLE, Math.floor(safeNumber(merchantPerTrip, SEND_MULTIPLE)));
  const mt = Math.max(1, Math.floor(safeNumber(maxTrips, 1)));
  const packCeiling = Math.min(perM * mt, 999999999);

  const chunksDesc = [...MEANINGFUL_CHUNKS].sort((a, b) => b - a);

  const greedyGrowOnce = () => {
    for (const chunk of chunksDesc) {
      if (chunk < SEND_MULTIPLE) {
        continue;
      }
      for (const k of RES) {
        if (total + chunk > packCeiling) {
          continue;
        }
        const maxDonorK = Math.max(0, floorToMultiple(donorStock[k] - reserve, SEND_MULTIPLE));
        const maxRoomK = Math.max(0, floorToMultiple(roomRemain[k], SEND_MULTIPLE));
        const donorLeft = maxDonorK - send[k];
        const roomLeft = maxRoomK - send[k];
        if (donorLeft >= chunk && roomLeft >= chunk) {
          send[k] += chunk;
          total += chunk;
          return true;
        }
      }
    }
    const slack = packCeiling - total;
    if (slack < SEND_MULTIPLE) {
      return false;
    }
    for (const k of RES) {
      const maxDonorK = Math.max(0, floorToMultiple(donorStock[k] - reserve, SEND_MULTIPLE));
      const maxRoomK = Math.max(0, floorToMultiple(roomRemain[k], SEND_MULTIPLE));
      const donorLeft = maxDonorK - send[k];
      const roomLeft = maxRoomK - send[k];
      const add = SEND_MULTIPLE * Math.floor(Math.min(donorLeft, roomLeft, slack) / SEND_MULTIPLE);
      if (add >= SEND_MULTIPLE) {
        send[k] += add;
        total += add;
        return true;
      }
    }
    return false;
  };

  while (total < packCeiling && greedyGrowOnce()) {}

  RES.forEach((k) => {
    const maxAmt = Math.max(
      0,
      Math.min(
        floorToMultiple(donorStock[k] - reserve, SEND_MULTIPLE),
        floorToMultiple(roomRemain[k], SEND_MULTIPLE)
      )
    );
    send[k] = Math.min(send[k], maxAmt);
    send[k] = floorToMultiple(send[k], SEND_MULTIPLE);
  });

  total = send.wood + send.clay + send.iron + send.crop;
  while (total > packCeiling) {
    let progressed = false;
    for (const k of [...RES].sort((a, b) => send[b] - send[a])) {
      if (send[k] >= SEND_MULTIPLE && total > packCeiling) {
        send[k] -= SEND_MULTIPLE;
        total -= SEND_MULTIPLE;
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      break;
    }
  }

  total = send.wood + send.clay + send.iron + send.crop;
  return { send, total };
}

function estimateEtaMinutes(distanceFinite) {
  if (!Number.isFinite(distanceFinite) || distanceFinite === Infinity) {
    return DEFAULT_WAIT_MINUTES;
  }
  return Math.max(2, Math.min(45, Math.ceil(distanceFinite * 1.5)));
}

function formatResourceShort(res) {
  const r = res || {};
  return (
    `W:${safeNumber(r.wood, 0)} C:${safeNumber(r.clay, 0)} I:${safeNumber(r.iron, 0)} Cr:${safeNumber(r.crop, 0)}`
  );
}

function sumShipmentsResources(shipments) {
  const s = { wood: 0, clay: 0, iron: 0, crop: 0 };
  (Array.isArray(shipments) ? shipments : []).forEach((row) => {
    const payload = row && row.sent ? row.sent : null;
    if (!payload) {
      return;
    }
    RES_KEYS.forEach((k) => {
      s[k] += safeNumber(payload[k], 0);
    });
  });
  return s;
}

async function circulateResourcesForBuild(getPage, settings, options = {}) {
  beginMarketplaceExclusiveSession();
  try {
    const page = getPage && getPage();
    if (!page || page.isClosed()) {
      return { status: "circulation_skipped", message: "Session page unavailable." };
    }

    const target = options.targetVillage;
    const allVillages = Array.isArray(options.villages) ? options.villages : [];
    const deficit = normalizeDeficit(options.deficit || {});
    if (!target || !(deficit.wood || deficit.clay || deficit.iron || deficit.crop)) {
      return { status: "circulation_skipped", message: "No target village or empty deficit." };
    }

    const fillRatioMerged = Number.isFinite(Number(options.receiverStorageMaxFillRatio))
      ? Number(options.receiverStorageMaxFillRatio)
      : safeNumber(settings.resourceCirculationReceiverMaxFillRatio, 0.8);
    const normalizedFillRatio = Math.min(1, Math.max(0.05, fillRatioMerged || 0.8));

    const targetRoomRaw = normalizeTargetRoom({
      targetStock: options.targetStock,
      targetWarehouseCap: options.targetWarehouseCap,
      targetGranaryCap: options.targetGranaryCap,
      receiverStorageMaxFillRatio: normalizedFillRatio
    });

    let roomRemain = cloneRes(targetRoomRaw);
    let deficitRemain = cloneRes(deficit);
    let floorHeadSum = sumFlooredWarehouseHeadroom(roomRemain);

    if (!hasPositiveRoom(roomRemain)) {
      return {
        status: "circulation_skipped",
        message:
          `No receiver headroom under ${Math.round(normalizedFillRatio * 100)}% cap (` +
          `W/C/I/Cr room ${roomRemain.wood}/${roomRemain.clay}/${roomRemain.iron}/${roomRemain.crop}).`
      };
    }

    if (floorHeadSum > 0 && floorHeadSum < MIN_CHUNK && Object.values(deficitRemain).every((v) => v < MIN_CHUNK)) {
      /* allow small deficits e.g. 1 res */
    }

    const plog = typeof options.progressLog === "function" ? options.progressLog : null;

    const planMode = normalizePlanMode(options.planMode);
    const donorPool = allVillages.filter(
      (v) =>
        Number(v.id) !== Number(target.id) && !v.underAttack && Number.isFinite(Number(v.id))
    );

    if (!donorPool.length) {
      return { status: "circulation_skipped", message: "No donor villages available (excluding target & villages under attack)." };
    }

    if (!Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) {
      plog?.(
        `Destination "${target.name || target.id}" has no coordinates in the village snapshot; ` +
          "form will use vid2 only. Open menu V to refresh villages if resources keep going to the wrong place."
      );
    }

        const targetScore = advancementScore(target, planMode);
    const overflowMaxDist = Math.max(
      1,
      Math.floor(safeNumber(settings.resourceOverflowMaxDistance, 10))
    );
    const overflowGuardOn =
      String(settings.resourceOverflowGuardEnabled || "").toLowerCase() === "true" ||
      settings.resourceOverflowGuardEnabled === true;
    const scored = donorPool
      .map((v) => ({
        donor: v,
        score: advancementScore(v, planMode),
        dist: computeDistance(v, target),
        isCapital: Boolean(v.isCapital)
      }))
      .sort((a, b) => {
        const preferNearest =
          options.preferNearest === true ||
          String(settings.resourceCirculationPreferNearest || "").toLowerCase() === "true" ||
          (options.preferNearest !== false && !options.settlementPrep);

        if (preferNearest) {
          // Prefer donors that are at least as developed as the receiver so a brand-new
          // off-village is not emptied to feed the capital next door.
          const aReady = a.score >= targetScore ? 1 : 0;
          const bReady = b.score >= targetScore ? 1 : 0;
          if (aReady !== bReady) {
            return bReady - aReady;
          }
          // When overflow guard is on, soft-prefer donors inside the same distance budget
          // used for overflow→pivot (keeps local surplus recycling with smart pulls).
          if (overflowGuardOn) {
            const da = Number.isFinite(a.dist) ? a.dist : Number.POSITIVE_INFINITY;
            const db = Number.isFinite(b.dist) ? b.dist : Number.POSITIVE_INFINITY;
            const aNear = da <= overflowMaxDist ? 1 : 0;
            const bNear = db <= overflowMaxDist ? 1 : 0;
            if (aNear !== bNear) {
              return bNear - aNear;
            }
          }
          const da = Number.isFinite(a.dist) ? a.dist : Number.POSITIVE_INFINITY;
          const db = Number.isFinite(b.dist) ? b.dist : Number.POSITIVE_INFINITY;
          if (da !== db) {
            return da - db;
          }
          if (a.isCapital !== b.isCapital) {
            return a.isCapital ? -1 : 1;
          }
          return b.score - a.score;
        }
        if (b.score !== a.score) return b.score - a.score;
        if (a.isCapital !== b.isCapital) {
          return a.isCapital ? -1 : 1;
        }
        return a.dist - b.dist;
      })
      .map((x) => x.donor);

    const maxDonorsGlob = Math.max(1, Math.floor(safeNumber(settings.resourceCirculationMaxDonors, MAX_DONORS_DEFAULT)));
    const maxDonorsB = Math.max(1, Math.floor(safeNumber(settings.resourceCirculationBuilderMaxDonors, 1)));

    let tripBudgetOpt = Number(options.warehouseTopMerchantTrips);
    if (!Number.isFinite(tripBudgetOpt)) {
      tripBudgetOpt = Math.floor(safeNumber(settings.resourceCirculationBuilderMerchantLoads, 4));
    }
    tripBudgetOpt = Math.min(99, Math.max(0, tripBudgetOpt));

    const maxDonors = tripBudgetOpt > 0 ? Math.min(maxDonorsGlob, maxDonorsB) : maxDonorsGlob;

    plog?.(
      `Receiver headroom (≤${Math.round(normalizedFillRatio * 100)}% caps): ${formatResourceShort(roomRemain)}. ` +
        `Floored movable≈${floorHeadSum} @ ${MIN_CHUNK}+ steps. Plan mode '${planMode}'.`
    );

    const reservePer = Math.max(0, Math.floor(safeNumber(settings.resourceCirculationReservePerResource, PER_RESOURCE_RESERVE)));

    let longestEta = 0;
    const shipments = [];

    donorLoop:
    for (const donor of scored) {
      if (shipments.length >= maxDonors) break;
      if (!(deficitRemain.wood || deficitRemain.clay || deficitRemain.iron || deficitRemain.crop)) break;

      let donorBaseline;
      try {
        donorBaseline = await readDonorBaselineAtVillageCenter(page, settings, donor.id);
      } catch (_e) {
        continue;
      }

      const verifyBaselineAt = Date.now();
      const marketUrl = buildMarketSendUrl(settings, donor.id, target.id);
      if (!(marketUrl && (await openMarketSendTab(page, marketUrl, donor.id)))) {
        plog?.(`Skipping ${donor.name || donor.id}: could not open market send.`);
        continue;
      }

      const fleet = await readMerchantFleetFromPage(page);
      const availM =
        fleet.availM != null && fleet.availM > 0
          ? fleet.availM
          : 12;
      const perM =
        fleet.perM && fleet.perM >= SEND_MULTIPLE
          ? fleet.perM
          : 3000;
      let maxTrips = Math.max(
        1,
        Math.min(tripBudgetOpt > 0 ? tripBudgetOpt : availM, availM || 99)
      );
      if (!(tripBudgetOpt > 0)) {
        maxTrips = Math.max(1, Math.min(availM, 99));
      }

      const donorStockFloor = cloneRes(donorBaseline);

      const { send: plannedSend } = planSendPayload({
        deficitRemain,
        roomRemain,
        donorStock: donorStockFloor,
        reserve: reservePer,
        merchantPerTrip: perM,
        maxTrips
      });

      const payloadTotal =
        plannedSend.wood +
        plannedSend.clay +
        plannedSend.iron +
        plannedSend.crop;

      if (!(payloadTotal >= MIN_CHUNK)) {
        plog?.(`Skipping ${donor.name || donor.id}: not enough surplus for a ${MIN_CHUNK}+ payload.`);
        continue;
      }

      plog?.(
        `${donor.name || donor.id}: sending ~${payloadTotal} (W:${plannedSend.wood} C:${plannedSend.clay} ` +
          `I:${plannedSend.iron} Cr:${plannedSend.crop}) up to ~${maxTrips} merchant trip equivalent.`
      );

      plog?.(
        `Market send destination: ${target.name || target.id} (vid ${target.id}` +
          (Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y))
            ? ` @ ${target.x}|${target.y}`
            : "") +
          ")."
      );

      const submitted = await submitResourceSend(page, target, plannedSend);
      if (!submitted.ok) {
        plog?.(`Skip ${donor.name || donor.id}: ${submitted.reason || "send_failed"} (${submitted.detail || ""}).`);
        continue;
      }

      let postStock;
      try {
        postStock = await readDonorStockAfterReturnToVillage(page, settings, donor.id);
      } catch (_e) {
        continue;
      }

      const verify = verifyDonorStockReflectsSend(
        donorBaseline,
        postStock,
        submitted.submitted,
        Date.now() - verifyBaselineAt
      );

      let okVer = verify.ok;
      if (!okVer) {
        await safePageWait(page, 1200);
        await bumpTravianHeaderStockRefresh(page);
        const late = await readStableHeaderStockMin(page);
        const v2 = verifyDonorStockReflectsSend(donorBaseline, late, submitted.submitted, Date.now() - verifyBaselineAt);
        okVer = v2.ok;
        if (v2.ok) {
          Object.assign(postStock, late);
        }
      }

      const strong = Boolean(submitted.verificationHints && submitted.verificationHints.strong);

      const donorVerified = Boolean(okVer);
      if (!(okVer || strong)) {
        plog?.(`Skip ${donor.name || donor.id}: send_not_confirmed ${verify.detail || ""}`);
        continue;
      }

      const sent = cloneRes(submitted.submitted);
      subtractFromPools(deficitRemain, roomRemain, sent);

      shipments.push({
        donorVillageId: donor.id,
        donorVillageName: donor.name || `Village ${donor.id}`,
        donorCoords: donor.coordsText || "(?|?)",
        distance:
          Number.isFinite(computeDistance(donor, target)) && computeDistance(donor, target) !== Infinity
            ? Number(computeDistance(donor, target).toFixed(2))
            : null,
        etaMinutes: estimateEtaMinutes(computeDistance(donor, target)),
        sent,
        donorStockVerified: donorVerified
      });

      longestEta = Math.max(longestEta, estimateEtaMinutes(computeDistance(donor, target)));

      if (!(deficitRemain.wood || deficitRemain.clay || deficitRemain.iron || deficitRemain.crop)) {
        break donorLoop;
      }
    }

    if (!shipments.length) {
      return {
        status: "circulation_skipped",
        message: "No donor could commit a verified marketplace send."
      };
    }

    const stillMissing =
      deficitRemain.wood > 0 ||
      deficitRemain.clay > 0 ||
      deficitRemain.iron > 0 ||
      deficitRemain.crop > 0;

    const receiverSummary =
      `${target.name || "receiver"} vid=${target.id}` +
      (Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y))
        ? ` (${target.x}|${target.y})`
        : "");

    return {
      status: "transfer_sent",
      donorStockVerified: shipments.every((s) => s.donorStockVerified),
      etaMinutes: Math.max(longestEta, DEFAULT_WAIT_MINUTES),
      shipments,
      remainingDeficit: deficitRemain,
      recipientVillageId: target.id,
      recipientVillageName: target.name || null,
      message: `transfer_sent → ${receiverSummary} ← ${shipments
        .map((s) => `${s.donorVillageName} (${formatResourceShort(s.sent)})`)
        .join("; ")}${stillMissing ? ` | still short: ${formatResourceShort(deficitRemain)}` : ""}`
    };
  } finally {
    endMarketplaceExclusiveSession();
  }
}

async function evacuateResourcesFromVillage() {
  const args = arguments[0] || {};
  const getPage = args.getPage;
  const settings = args.settings || {};
  const sourceVillage = args.sourceVillage || null;
  const pivotVillage = args.pivotVillage || null;
  const log = typeof args.log === "function" ? args.log : null;
  const keepRatioRaw = Number(args.crannyKeepRatio);
  const keepRatio = Number.isFinite(keepRatioRaw) ? Math.min(1, Math.max(0, keepRatioRaw)) : 0.8;
  const reservePerResource = Math.max(
    0,
    Math.floor(safeNumber(args.reservePerResource, settings.raidEvacuationReservePerResource || 0))
  );
  const nowTs = Number.isFinite(Number(args.nowTs)) ? Number(args.nowTs) : Date.now();
  const triggerEtaMinutes = Number.isFinite(Number(args.triggerEtaMinutes))
    ? Math.max(0, Number(args.triggerEtaMinutes))
    : null;
  const attackAlerts = Array.isArray(args.attackAlerts) ? args.attackAlerts : [];

  if (!(getPage && sourceVillage && Number.isFinite(Number(sourceVillage.id)))) {
    return { status: "evacuation_skipped", message: "Missing source village/page context." };
  }
  if (!(pivotVillage && Number.isFinite(Number(pivotVillage.id)))) {
    return { status: "evacuation_skipped", message: "No pivot village available for evacuation." };
  }
  if (Number(sourceVillage.id) === Number(pivotVillage.id)) {
    return { status: "evacuation_skipped", message: "Source village equals pivot village; evacuation skipped." };
  }

  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const crannyCapacityByLevel = {
    0: 0, 1: 200, 2: 300, 3: 400, 4: 500, 5: 600, 6: 800, 7: 1000, 8: 1300, 9: 1700, 10: 2200,
    11: 2900, 12: 3800, 13: 5000, 14: 6500, 15: 8500, 16: 11100, 17: 14500, 18: 18900, 19: 24700, 20: 32200
  };
  const crannyAtLevel = (lvl) => {
    const n = Math.max(0, Math.min(20, Math.floor(Number(lvl) || 0)));
    return Number(crannyCapacityByLevel[n] || 0);
  };

  const baseUrl = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  const sourceId = Number(sourceVillage.id);
  const pivotId = Number(pivotVillage.id);

  const slotIds = [];
  for (let sid = 19; sid <= 40; sid += 1) {
    slotIds.push(sid);
  }

  let totalCrannyProtected = 0;
  let crannyCount = 0;
  for (const slotId of slotIds) {
    let slotInfo = null;
    try {
      slotInfo = await villageBuilder.readSlotPage(page, baseUrl, slotId, sourceId);
    } catch (_error) {
      continue;
    }
    const name = String((slotInfo && slotInfo.buildingName) || "").toLowerCase();
    if (!/\bcranny\b/.test(name)) {
      continue;
    }
    const lvl = Number((slotInfo && slotInfo.currentLevel) || 0);
    totalCrannyProtected += crannyAtLevel(lvl);
    crannyCount += 1;
  }

  const protectedKeepPerResource = Math.floor(totalCrannyProtected * keepRatio);
  log?.(
    `[Raid Evacuation] ${sourceVillage.name || sourceId}: cranny=${totalCrannyProtected}/res ` +
      `(${crannyCount} building(s)), keep=${protectedKeepPerResource}/res @ ${(keepRatio * 100).toFixed(0)}%.`
  );

  const donorStock = await readDonorBaselineAtVillageCenter(page, settings, sourceId);
  const sendPlan = {
    wood: floorToMultiple(Math.max(0, donorStock.wood - protectedKeepPerResource - reservePerResource), SEND_MULTIPLE),
    clay: floorToMultiple(Math.max(0, donorStock.clay - protectedKeepPerResource - reservePerResource), SEND_MULTIPLE),
    iron: floorToMultiple(Math.max(0, donorStock.iron - protectedKeepPerResource - reservePerResource), SEND_MULTIPLE),
    crop: floorToMultiple(Math.max(0, donorStock.crop - protectedKeepPerResource - reservePerResource), SEND_MULTIPLE)
  };
  const totalPlanned = sendPlan.wood + sendPlan.clay + sendPlan.iron + sendPlan.crop;
  if (totalPlanned < SEND_MULTIPLE) {
    return {
      status: "evacuation_skipped",
      message:
        `No resources above ${(keepRatio * 100).toFixed(0)}% cranny keep + reserve (${reservePerResource}/res).`,
      crannyProtectedPerResource: totalCrannyProtected,
      keepPerResource: protectedKeepPerResource,
      plannedSend: sendPlan
    };
  }

  const marketUrl = buildMarketSendUrl(settings, sourceId, pivotId);
  if (!(marketUrl && (await openMarketSendTab(page, marketUrl, sourceId)))) {
    return { status: "evacuation_skipped", message: "Could not open market send tab for evacuation." };
  }

  const fleet = await readMerchantFleetFromPage(page);
  const perM = fleet.perM && fleet.perM >= SEND_MULTIPLE
    ? fleet.perM
    : Math.max(1000, Math.floor(safeNumber(settings.raidEvacuationMerchantCapacityFallback, 1000)));
  const availM = fleet.availM != null && fleet.availM > 0 ? fleet.availM : 0;
  if (availM <= 0) {
    return {
      status: "evacuation_skipped",
      message: "No available merchants for evacuation.",
      plannedSend: sendPlan
    };
  }

  const maxPayload = Math.max(0, Math.floor(availM * perM));
  const trimToCapacity = (value) => floorToMultiple(Math.max(0, value), SEND_MULTIPLE);
  let capped = {
    wood: trimToCapacity(sendPlan.wood),
    clay: trimToCapacity(sendPlan.clay),
    iron: trimToCapacity(sendPlan.iron),
    crop: trimToCapacity(sendPlan.crop)
  };
  let cappedTotal = capped.wood + capped.clay + capped.iron + capped.crop;
  if (cappedTotal > maxPayload) {
    const order = ["wood", "clay", "iron", "crop"].sort((a, b) => capped[b] - capped[a]);
    while (cappedTotal > maxPayload) {
      let changed = false;
      for (const key of order) {
        if (capped[key] >= SEND_MULTIPLE && cappedTotal > maxPayload) {
          capped[key] -= SEND_MULTIPLE;
          cappedTotal -= SEND_MULTIPLE;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
  }
  if (cappedTotal < SEND_MULTIPLE) {
    return {
      status: "evacuation_skipped",
      message: "Evacuation payload is below one merchant chunk after merchant-cap limits.",
      plannedSend: sendPlan,
      cappedSend: capped
    };
  }

  log?.(
    `[Raid Evacuation] ${sourceVillage.name || sourceId} -> ${pivotVillage.name || pivotId}: ` +
      `send ${formatResourceShort(capped)} (available merchants: ${availM} x ${perM}).`
  );

  const submitted = await submitResourceSend(page, pivotVillage, capped);
  if (!submitted.ok) {
    return {
      status: "evacuation_failed",
      message: `Marketplace send failed: ${submitted.reason || "send_failed"} ${submitted.detail || ""}`.trim(),
      plannedSend: sendPlan,
      cappedSend: capped
    };
  }

  const postStock = await readDonorStockAfterReturnToVillage(page, settings, sourceId);
  const verify = verifyDonorStockReflectsSend(donorStock, postStock, submitted.submitted, Date.now() - nowTs);
  const strong = Boolean(submitted.verificationHints && submitted.verificationHints.strong);
  if (!(verify.ok || strong)) {
    return {
      status: "evacuation_failed",
      message: `Evacuation send not confirmed (${verify.detail || "unknown"}).`,
      plannedSend: sendPlan,
      cappedSend: capped,
      verification: verify
    };
  }

  const dist = computeDistance(sourceVillage, pivotVillage);
  const eta = estimateEtaMinutes(dist);
  return {
    status: "evacuation_sent",
    message:
      `Evacuated ${formatResourceShort(submitted.submitted)} to ${pivotVillage.name || pivotId}` +
      `${Number.isFinite(dist) ? ` (ETA ~${eta}m)` : ""}.`,
    sourceVillageId: sourceId,
    sourceVillageName: sourceVillage.name || null,
    pivotVillageId: pivotId,
    pivotVillageName: pivotVillage.name || null,
    triggerEtaMinutes,
    crannyProtectedPerResource: totalCrannyProtected,
    keepPerResource: protectedKeepPerResource,
    reservePerResource,
    sent: cloneRes(submitted.submitted),
    etaMinutes: eta,
    donorStockVerified: Boolean(verify.ok)
  };
}

/**
 * Overflow guard: when warehouse/granary fill exceeds trigger ratio, send surplus to pivot
 * (default capital) — but only if map distance ≤ maxDistance squares. Far villages never
 * send, even when overflowing. Complements deficit-driven circulateResourcesForBuild.
 */
async function guardOverflowResourcesFromVillage(args = {}) {
  const getPage = args.getPage;
  const settings = args.settings || {};
  const sourceVillage = args.sourceVillage || null;
  const villages = Array.isArray(args.villages) ? args.villages : [];
  const log = typeof args.log === "function" ? args.log : null;
  const nowTs = Number.isFinite(Number(args.nowTs)) ? Number(args.nowTs) : Date.now();

  const triggerRatio = normalizeRatio(
    args.triggerRatio ?? settings.resourceOverflowTriggerRatio,
    0.9
  );
  const targetRatio = normalizeRatio(
    args.targetRatio ?? settings.resourceOverflowTargetRatio,
    0.75
  );
  const maxDistance = Math.max(
    1,
    Math.floor(safeNumber(args.maxDistance ?? settings.resourceOverflowMaxDistance, 10))
  );
  const reservePerResource = Math.max(
    0,
    Math.floor(
      safeNumber(
        args.reservePerResource ?? settings.resourceCirculationReservePerResource,
        PER_RESOURCE_RESERVE
      )
    )
  );
  const receiverFillRatio = normalizeRatio(
    args.receiverStorageMaxFillRatio ?? settings.resourceCirculationReceiverMaxFillRatio,
    0.8
  );

  if (!(getPage && sourceVillage && Number.isFinite(Number(sourceVillage.id)))) {
    return { status: "overflow_skipped", message: "Missing source village/page context." };
  }

  const pivotVillage =
    args.pivotVillage ||
    resolvePivotVillage(villages, settings, sourceVillage.id);
  if (!(pivotVillage && Number.isFinite(Number(pivotVillage.id)))) {
    return { status: "overflow_skipped", message: "No pivot village (capital) available." };
  }
  if (Number(sourceVillage.id) === Number(pivotVillage.id)) {
    return { status: "overflow_skipped", message: "Source is the pivot village; nothing to send." };
  }

  const distance = computeDistance(sourceVillage, pivotVillage);
  if (!(Number.isFinite(distance) && distance <= maxDistance)) {
    return {
      status: "overflow_too_far",
      message:
        `Overflow blocked: ${sourceVillage.name || sourceVillage.id} → ` +
        `${pivotVillage.name || pivotVillage.id} is ${
          Number.isFinite(distance) ? distance.toFixed(1) : "?"
        } squares (max ${maxDistance}). Far sends are never allowed.`,
      distance: Number.isFinite(distance) ? distance : null,
      maxDistance,
      sourceVillageId: Number(sourceVillage.id),
      pivotVillageId: Number(pivotVillage.id)
    };
  }

  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const sourceId = Number(sourceVillage.id);
  const pivotId = Number(pivotVillage.id);

  const base = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  await safeGotoWithRetry(page, withVillageId(base, sourceId), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }, 2);
  await safePageWait(page, 520);
  const capsSnap = await readVillageStockAndCapsFromHeader(page);
  const stock = capsSnap.stock || cloneRes({});
  const fills = fillRatiosForStock(stock, capsSnap.warehouseCap, capsSnap.granaryCap);

  if (!(fills.warehouseCap > 0 || fills.granaryCap > 0)) {
    return {
      status: "overflow_skipped",
      message: "Could not read warehouse/granary capacities.",
      stock,
      fills
    };
  }

  if (!(fills.maxRatio + 1e-9 >= triggerRatio)) {
    return {
      status: "overflow_ok",
      message:
        `Below overflow trigger (${Math.round(fills.maxRatio * 100)}% < ${Math.round(triggerRatio * 100)}%).`,
      stock,
      fills,
      triggerRatio,
      distance
    };
  }

  // Drain each overflowing resource down toward targetRatio * cap, keep a small reserve.
  const keepWood = Math.max(
    reservePerResource,
    Math.floor(fills.warehouseCap * Math.min(targetRatio, triggerRatio))
  );
  const keepClay = keepWood;
  const keepIron = keepWood;
  const keepCrop = Math.max(
    reservePerResource,
    Math.floor(fills.granaryCap * Math.min(targetRatio, triggerRatio))
  );

  const sendPlan = {
    wood: floorToMultiple(Math.max(0, stock.wood - keepWood), SEND_MULTIPLE),
    clay: floorToMultiple(Math.max(0, stock.clay - keepClay), SEND_MULTIPLE),
    iron: floorToMultiple(Math.max(0, stock.iron - keepIron), SEND_MULTIPLE),
    crop: floorToMultiple(Math.max(0, stock.crop - keepCrop), SEND_MULTIPLE)
  };

  // Only ship resources that were actually over the trigger (avoid draining healthy sides).
  if (fills.wood < triggerRatio) sendPlan.wood = 0;
  if (fills.clay < triggerRatio) sendPlan.clay = 0;
  if (fills.iron < triggerRatio) sendPlan.iron = 0;
  if (fills.crop < triggerRatio) sendPlan.crop = 0;

  let plannedTotal = sendPlan.wood + sendPlan.clay + sendPlan.iron + sendPlan.crop;
  if (plannedTotal < SEND_MULTIPLE) {
    return {
      status: "overflow_skipped",
      message: "Overflow detected but surplus below one merchant chunk after keep/target ratios.",
      stock,
      fills,
      plannedSend: sendPlan,
      distance
    };
  }

  // Cap by pivot headroom (same fill-ratio rules as smart circulation).
  let pivotStock = { wood: 0, clay: 0, iron: 0, crop: 0 };
  let pivotWh = fills.warehouseCap;
  let pivotGr = fills.granaryCap;
  try {
    await safeGotoWithRetry(page, withVillageId(base, pivotId), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }, 2);
    await safePageWait(page, 400);
    const pivotSnap = await readVillageStockAndCapsFromHeader(page);
    pivotStock = pivotSnap.stock || pivotStock;
    pivotWh = pivotSnap.warehouseCap || pivotWh;
    pivotGr = pivotSnap.granaryCap || pivotGr;
  } catch (_e) {
    // fall through with conservative room estimate
  }

  const room = normalizeTargetRoom({
    targetStock: pivotStock,
    targetWarehouseCap: pivotWh,
    targetGranaryCap: pivotGr,
    receiverStorageMaxFillRatio: receiverFillRatio
  });
  sendPlan.wood = floorToMultiple(Math.min(sendPlan.wood, room.wood), SEND_MULTIPLE);
  sendPlan.clay = floorToMultiple(Math.min(sendPlan.clay, room.clay), SEND_MULTIPLE);
  sendPlan.iron = floorToMultiple(Math.min(sendPlan.iron, room.iron), SEND_MULTIPLE);
  sendPlan.crop = floorToMultiple(Math.min(sendPlan.crop, room.crop), SEND_MULTIPLE);
  plannedTotal = sendPlan.wood + sendPlan.clay + sendPlan.iron + sendPlan.crop;
  if (plannedTotal < SEND_MULTIPLE) {
    return {
      status: "overflow_skipped",
      message: `Pivot ${pivotVillage.name || pivotId} has no headroom ≤${Math.round(receiverFillRatio * 100)}% caps.`,
      stock,
      fills,
      plannedSend: sendPlan,
      distance,
      pivotRoom: room
    };
  }

  log?.(
    `[Overflow Guard] ${sourceVillage.name || sourceId} fill max ${Math.round(fills.maxRatio * 100)}% → ` +
      `${pivotVillage.name || pivotId} (${distance.toFixed(1)}≤${maxDistance} sq): plan ${formatResourceShort(sendPlan)}.`
  );

  const marketUrl = buildMarketSendUrl(settings, sourceId, pivotId);
  if (!(marketUrl && (await openMarketSendTab(page, marketUrl, sourceId)))) {
    return { status: "overflow_skipped", message: "Could not open market send tab for overflow guard." };
  }

  const fleet = await readMerchantFleetFromPage(page);
  const perM =
    fleet.perM && fleet.perM >= SEND_MULTIPLE
      ? fleet.perM
      : Math.max(
          1000,
          Math.floor(safeNumber(settings.raidEvacuationMerchantCapacityFallback, 1000))
        );
  const availM = fleet.availM != null && fleet.availM > 0 ? fleet.availM : 0;
  if (availM <= 0) {
    return {
      status: "overflow_skipped",
      message: "No available merchants for overflow send.",
      plannedSend: sendPlan
    };
  }

  const maxPayload = Math.max(0, Math.floor(availM * perM));
  const trimToCapacity = (value) => floorToMultiple(Math.max(0, value), SEND_MULTIPLE);
  let capped = {
    wood: trimToCapacity(sendPlan.wood),
    clay: trimToCapacity(sendPlan.clay),
    iron: trimToCapacity(sendPlan.iron),
    crop: trimToCapacity(sendPlan.crop)
  };
  let cappedTotal = capped.wood + capped.clay + capped.iron + capped.crop;
  if (cappedTotal > maxPayload) {
    const order = ["wood", "clay", "iron", "crop"].sort((a, b) => capped[b] - capped[a]);
    while (cappedTotal > maxPayload) {
      let changed = false;
      for (const key of order) {
        if (capped[key] >= SEND_MULTIPLE && cappedTotal > maxPayload) {
          capped[key] -= SEND_MULTIPLE;
          cappedTotal -= SEND_MULTIPLE;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
  }
  if (cappedTotal < SEND_MULTIPLE) {
    return {
      status: "overflow_skipped",
      message: "Overflow payload below one merchant chunk after merchant-cap limits.",
      plannedSend: sendPlan,
      cappedSend: capped
    };
  }

  const submitted = await submitResourceSend(page, pivotVillage, capped);
  if (!submitted.ok) {
    return {
      status: "overflow_failed",
      message: `Marketplace send failed: ${submitted.reason || "send_failed"} ${submitted.detail || ""}`.trim(),
      plannedSend: sendPlan,
      cappedSend: capped
    };
  }

  const postStock = await readDonorStockAfterReturnToVillage(page, settings, sourceId);
  const verify = verifyDonorStockReflectsSend(stock, postStock, submitted.submitted, Date.now() - nowTs);
  const strong = Boolean(submitted.verificationHints && submitted.verificationHints.strong);
  if (!(verify.ok || strong)) {
    return {
      status: "overflow_failed",
      message: `Overflow send not confirmed (${verify.detail || "unknown"}).`,
      plannedSend: sendPlan,
      cappedSend: capped,
      verification: verify
    };
  }

  const eta = estimateEtaMinutes(distance);
  return {
    status: "overflow_sent",
    message:
      `Overflow sent ${formatResourceShort(submitted.submitted)} → ${pivotVillage.name || pivotId}` +
      ` (${distance.toFixed(1)} sq, ETA ~${eta}m).`,
    sourceVillageId: sourceId,
    sourceVillageName: sourceVillage.name || null,
    pivotVillageId: pivotId,
    pivotVillageName: pivotVillage.name || null,
    distance,
    maxDistance,
    triggerRatio,
    targetRatio,
    fills,
    sent: cloneRes(submitted.submitted),
    etaMinutes: eta,
    donorStockVerified: Boolean(verify.ok)
  };
}

/**
 * Round-robin overflow check: one non-pivot village per tick.
 */
async function runOverflowGuardRoundRobin(getPage, settings, villages, state = {}) {
  const pivot = resolvePivotVillage(villages, settings, null);
  const candidates = (Array.isArray(villages) ? villages : []).filter((v) => {
    if (!(Number.isFinite(Number(v && v.id)) && Number(v.id) > 0)) {
      return false;
    }
    if (v.underAttack) {
      return false;
    }
    if (pivot && Number(v.id) === Number(pivot.id)) {
      return false;
    }
    return true;
  });

  if (!candidates.length) {
    return {
      status: "overflow_no_candidates",
      message: "No villages available for overflow guard RR."
    };
  }

  let index = Number(state.roundRobinIndex) || 0;
  if (!Number.isFinite(index) || index < 0) {
    index = 0;
  }
  index = ((index % candidates.length) + candidates.length) % candidates.length;
  const village = candidates[index];
  const nextIndex = (index + 1) % candidates.length;

  const result = await guardOverflowResourcesFromVillage({
    getPage,
    settings,
    sourceVillage: village,
    villages,
    pivotVillage: pivot,
    log: typeof state.log === "function" ? state.log : null
  });

  return {
    ...result,
    roundRobinIndex: nextIndex,
    candidateCount: candidates.length,
    checkedVillageId: village.id,
    checkedVillageName: village.name || null,
    pivotVillageId: pivot ? pivot.id : null,
    pivotVillageName: pivot ? pivot.name || null : null
  };
}

module.exports = {
  circulateResourcesForBuild,
  evacuateResourcesFromVillage,
  guardOverflowResourcesFromVillage,
  runOverflowGuardRoundRobin,
  resolvePivotVillage,
  computeDistance,
  formatResourceShort,
  sumShipmentsResources,
  MARKETPLACE_EXCLUSIVE_RETRY_MS,
  isMarketplaceBusy,
  beginMarketplaceExclusiveSession,
  endMarketplaceExclusiveSession
};
