const readline = require("readline");
const fs = require("fs");
const path = require("path");
const builder = require("./villageBuilder");
const villageExpansion = require("./villageExpansion");
const resourceCirculation = require("./resourceCirculation");
const troopPlans = require("./troopPlans");
const { version: APP_VERSION } = require("./package.json");
const { formatProxyDisplay, normalizeProxyServer, buildProxySettingsPayload, proxyPool } = require("./proxyConfig");
const activitySimulation = require("./activitySimulation");
const top10Tracking = require("./top10Tracking");
const { DEFAULT_TOP10_LOG_FILE } = top10Tracking;
const { forEachLogLine } = require("./logTail");
const { appendActionLogLine, listArchivedLogs, resolveArchiveDir, maybeRotateActionLog } = require("./actionLog");
const {
  isResourceExhaustionError,
  isTransientNavigationError,
  navigationRetryDelayMs
} = require("./browserNavigation");

const USE_COLORS =
  process.env.NO_COLOR !== "1" &&
  process.env.NO_COLOR !== "true" &&
  Boolean(process.stdout && process.stdout.isTTY);

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
};

function color(text, ...codes) {
  if (!USE_COLORS) {
    return String(text);
  }
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function logInfo(message) {
  console.log(color(message, ANSI.cyan));
}

function logSuccess(message) {
  console.log(color(message, ANSI.green, ANSI.bold));
}

function logWarn(message) {
  console.log(color(message, ANSI.yellow));
}

function logError(message) {
  console.error(color(message, ANSI.red, ANSI.bold));
}

class MenuInterruptError extends Error {
  constructor(message) {
    super(message);
    this.name = "MenuInterruptError";
  }
}

function askQuestion(rl, message) {
  return new Promise((resolve) => {
    rl.question(message, (answer) => resolve(answer));
  });
}

function parseCoordinateValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseCoordinatePair(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  const parts = text.split(/[|,;\s]+/).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const x = parseCoordinateValue(parts[0]);
  const y = parseCoordinateValue(parts[1]);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function parsePlannedSettlementTargets(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[\n;]+/)
    .map((part) => parseCoordinatePair(part))
    .filter((item) => Boolean(item));
}

function formatPlannedSettlementTargets(targets, separator = "; ") {
  if (!Array.isArray(targets) || targets.length === 0) {
    return "";
  }
  return targets.map((target) => `${target.x}|${target.y}`).join(separator);
}

function resolvePlannedTargetsFilePath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) {
    return path.resolve(process.cwd(), "templates", "settlement_targets.json");
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function normalizeTargetObject(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const x = parseCoordinateValue(item.x);
  const y = parseCoordinateValue(item.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function loadPlannedSettlementTargetsFromFile(filePath) {
  const absolutePath = resolvePlannedTargetsFilePath(filePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      ok: false,
      absolutePath,
      message: `Target file not found: ${absolutePath}`,
      targets: []
    };
  }

  let content;
  try {
    content = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      absolutePath,
      message: `Could not read target file: ${error.message || error}`,
      targets: []
    };
  }

  const ext = path.extname(absolutePath).toLowerCase();
  let targets = [];
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(String(content || "").trim() || "[]");
      const rawTargets = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.targets) ? parsed.targets : []);
      targets = rawTargets
        .map((item) => normalizeTargetObject(item))
        .filter((item) => Boolean(item));
    } catch (error) {
      return {
        ok: false,
        absolutePath,
        message: `Invalid JSON in target file: ${error.message || error}`,
        targets: []
      };
    }
  } else {
    const sanitized = String(content || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => Boolean(line))
      .join("\n");
    targets = parsePlannedSettlementTargets(sanitized);
  }

  return {
    ok: true,
    absolutePath,
    targets
  };
}

function savePlannedSettlementTargetsToFile(filePath, targets) {
  const absolutePath = resolvePlannedTargetsFilePath(filePath);
  const parentDir = path.dirname(absolutePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === ".json") {
    const jsonPayload = (Array.isArray(targets) ? targets : [])
      .map((item) => normalizeTargetObject(item))
      .filter((item) => Boolean(item));
    fs.writeFileSync(absolutePath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
  } else {
    const content = formatPlannedSettlementTargets(targets, "\n");
    fs.writeFileSync(absolutePath, content ? `${content}\n` : "", "utf8");
  }
  return absolutePath;
}

function normalizeExpansionSettlementSettings(settings) {
  settings.expansionAutoDispatchEnabled = Boolean(settings.expansionAutoDispatchEnabled);
  settings.expansionUsePlannedTargets = Boolean(settings.expansionUsePlannedTargets);
  settings.expansionPlannedTargetsFile = String(settings.expansionPlannedTargetsFile || "").trim()
    || "templates/settlement_targets.json";
  settings.resourceCirculationEnabled = Boolean(settings.resourceCirculationEnabled);
  settings.resourceCirculationExpansionEnabled = Boolean(settings.resourceCirculationExpansionEnabled);
  let fill = Number(settings.resourceCirculationReceiverMaxFillRatio);
  if (!(Number.isFinite(fill) && fill > 0 && fill <= 1)) {
    fill = 0.8;
  }
  settings.resourceCirculationReceiverMaxFillRatio = fill;
}

async function askSettlementTarget(rl) {
  const pairInput = (
    await askQuestion(rl, "Target coordinates X|Y (Enter to use separate prompts, C to cancel): ")
  ).trim();
  if (pairInput.toUpperCase() === "C") {
    return null;
  }

  const pair = parseCoordinatePair(pairInput);
  if (pair) {
    return pair;
  }

  let attempts = 0;
  while (attempts < 3) {
    const targetXText = (await askQuestion(rl, "Target X coordinate (or C to cancel): ")).trim();
    if (targetXText.toUpperCase() === "C") {
      return null;
    }

    const targetYText = (await askQuestion(rl, "Target Y coordinate (or C to cancel): ")).trim();
    if (targetYText.toUpperCase() === "C") {
      return null;
    }

    const targetX = parseCoordinateValue(targetXText);
    const targetY = parseCoordinateValue(targetYText);
    if (targetX !== null && targetY !== null) {
      return { x: targetX, y: targetY };
    }

    attempts += 1;
    logWarn("Invalid coordinates. Use numbers like -18 and -26, or enter one line as -18|-26.");
  }

  return null;
}

function printDivider(title) {
  const line = "-".repeat(64);
  console.log("");
  console.log(color(line, ANSI.gray));
  console.log(color(`[ ${title} ]`, ANSI.bold, ANSI.blue));
  console.log(color(line, ANSI.gray));
}

function isCompactDisplay(settings) {
  return Boolean(settings && settings.dashboardCompactView);
}

let terminalUiSettings = null;

function printSubDivider(title) {
  console.log("");
  console.log(color(`> ${title}`, ANSI.bold, ANSI.cyan));
}

function printKeyValueRows(rows, settings = terminalUiSettings) {
  if (isCompactDisplay(settings)) {
    rows.forEach((row) => {
      const label = row.raw ? row.label : color(row.label, ANSI.gray);
      const value = row.raw ? row.value : color(row.value, ANSI.bold);
      console.log(`  ${label}: ${value}`);
    });
    return;
  }
  const labelWidth = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
  rows.forEach((row) => {
    const paddedLabel = row.label.padEnd(labelWidth, " ");
    const renderedLabel = row.raw
      ? paddedLabel
      : color(paddedLabel, ANSI.gray);
    const renderedValue = row.raw
      ? row.value
      : color(row.value, ANSI.bold);
    console.log(`  ${renderedLabel}  ${renderedValue}`);
  });
}

function resourceColorCode(resourceName) {
  switch (String(resourceName || "").toLowerCase()) {
    case "wood":
      return ANSI.green;
    case "clay":
      return ANSI.yellow;
    case "iron":
      return ANSI.blue;
    case "crop":
      return ANSI.yellow;
    default:
      return ANSI.gray;
  }
}

function movementColorCode(movement) {
  const combined = `${movement.type || ""} ${movement.text || ""}`.toLowerCase();
  if (combined.includes("reinf")) {
    return ANSI.green;
  }
  if (combined.includes("attack")) {
    return ANSI.red;
  }
  return ANSI.yellow;
}

function parseDurationToSeconds(rawValue) {
  const text = String(rawValue || "").toLowerCase();
  const match = text.match(/(\d+)\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?/);
  if (!match) {
    return null;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] != null ? Number(match[3]) : 0;
  if (!Number.isFinite(first) || !Number.isFinite(second) || !Number.isFinite(third)) {
    return null;
  }
  // If text includes "hour", treat as HH:MM:SS; otherwise MM:SS fallback.
  if (text.includes("hour") || text.includes("hr")) {
    return (first * 3600) + (second * 60) + third;
  }
  if (match[3] != null) {
    return (first * 3600) + (second * 60) + third;
  }
  return (first * 60) + second;
}

/**
 * Incoming vs outgoing troop rows often share the same icon title ("Attack").
 * RAID GUARD MUST NOT treat outbound marches / returns as hostile incoming —
 * classify direction from tbody/row/cell cues and wording.
 */
function isLikelyHostileIncomingAttackMovement(movement) {
  const combined = `${movement.type || ""} ${movement.text || ""}`.toLowerCase();
  const merchantish = /\bmerchant|merchants\b|\btransport(ing)? resources\b|\bmarketplace\b/.test(combined);
  if (merchantish) {
    return false;
  }

  const direction = movement.movementDirection;
  if (direction === "out") {
    return false;
  }

  const outboundPhrases =
    /\b(attack|raid|scout|cavalry)\s+on\b/.test(combined) ||
    /\bangriff\s+(auf|op)\b/.test(combined) ||
    /\büberfall\s+(auf|op)\b/.test(combined) ||
    /\breturn(s|ing)\b/.test(combined);
  if (outboundPhrases) {
    return false;
  }

  const hostileWord =
    /\battack\b|\bangriff\b|\braid\b|\battacker\b|\bscout\b|\büberfall\b|\büber\s*fall\b/.test(
      combined
    ) || String(movement.type || "").toLowerCase().includes("attack");
  const incomingEvidence =
    direction === "in" ||
    /\b(attack|raid|scout|cavalry)\s+from\b/i.test(combined) ||
    /\bangriff\s+(von|vom)\b|\büberfall\s+(von|vom)\b/i.test(combined) ||
    /\bincoming\b|\bbeing\s+attacked\b|\bagainst\s+your\s+village\b/i.test(combined);

  const etaSeconds = parseDurationToSeconds(movement.eta);
  if (!Number.isFinite(etaSeconds)) {
    return false;
  }
  return Boolean(hostileWord && incomingEvidence);
}

function getIncomingAttackAlerts(movements) {
  const alerts = (Array.isArray(movements) ? movements : [])
    .map((movement) => {
      if (!isLikelyHostileIncomingAttackMovement(movement)) {
        return null;
      }
      const etaSeconds = parseDurationToSeconds(movement.eta);
      return {
        ...movement,
        etaSeconds
      };
    })
    .filter((item) => Boolean(item))
    .sort((a, b) => a.etaSeconds - b.etaSeconds);

  return alerts;
}

function formatIsoClock(date) {
  return new Date(date).toLocaleTimeString("en-GB", { hour12: false });
}

/** Human-readable countdown, e.g. 7m 12s or 45s. */
function formatDelayMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDelayRange(settings) {
  if (!Number.isFinite(settings.randomDelayMinMs) || settings.randomDelayMinMs < 0) {
    settings.randomDelayMinMs = 1000;
  }
  if (!Number.isFinite(settings.randomDelayMaxMs) || settings.randomDelayMaxMs < 0) {
    settings.randomDelayMaxMs = 2000;
  }
  if (settings.randomDelayMinMs > settings.randomDelayMaxMs) {
    const temp = settings.randomDelayMinMs;
    settings.randomDelayMinMs = settings.randomDelayMaxMs;
    settings.randomDelayMaxMs = temp;
  }
}

function getRandomDelayMs(settings) {
  normalizeDelayRange(settings);
  const min = Math.floor(settings.randomDelayMinMs);
  const max = Math.floor(settings.randomDelayMaxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitWithCancellation(ms, shouldCancel) {
  const stepMs = 200;
  let remaining = Math.max(0, Math.floor(ms));

  while (remaining > 0) {
    if (shouldCancel && shouldCancel()) {
      throw new MenuInterruptError("Interrupted by user");
    }

    const currentStep = Math.min(stepMs, remaining);
    await sleep(currentStep);
    remaining -= currentStep;
  }
}

async function runWithRandomDelay(settings, label, operation, shouldCancel) {
  const delayMs = getRandomDelayMs(settings);
  logInfo(`Delaying ${label} by ${delayMs}ms...`);
  await waitWithCancellation(delayMs, shouldCancel);
  if (shouldCancel && shouldCancel()) {
    throw new MenuInterruptError("Interrupted by user");
  }
  return operation();
}

/**
 * Nexian/other servers redirect to shownew.php until the player acknowledges news.
 * That page has no farmlist controls — navigate out first, then retry farmlist URL.
 */
async function escapeShownewsContinueAction(page) {
  const dismissed = await page.evaluate(() => {
    const pathname = String(window.location.pathname || "").toLowerCase();
    const onNewsGate = /shownew|show_news/i.test(pathname);
    const labelLooksLikeContinue = (element) => {
      const bits = [];
      const v = typeof element.value === "string" ? element.value : "";
      if (element.getAttribute) {
        bits.push(element.getAttribute("value") || "", element.getAttribute("title") || "");
      }
      bits.push(typeof element.alt === "string" ? element.alt : "", element.textContent || "");
      const t = bits.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (!t.length) {
        return false;
      }
      const isSingleWordNo = /\b(no|never|later|abbrev|abbruch|cancel|schließen|close)\b/.test(t);
      if (isSingleWordNo) {
        return false;
      }
      return /\b(continue|confirm|weiter|ok|next|done|skip|nächste|zurück\s+zum\s+spiel|zurück\s*zur\s+übersicht|to\s+(the\s+)?game|play\s+now)\b/i.test(
        t
      );
    };

    /** @type {(element: HTMLElement) => boolean} */
    const canActivate = (el) => {
      if (!el || el.disabled) {
        return false;
      }
      if (el instanceof HTMLAnchorElement) {
        const href = String(el.getAttribute("href") || "");
        if (!href || href === "#" || /^javascript:\s*void/i.test(href)) {
          return false;
        }
      }
      return true;
    };

    /** @type {HTMLElement[]} */
    const clickable = [];

    Array.from(document.querySelectorAll(
      "#content a[href*='.php'][href!='#'], #contentOuter a[href*='.php'][href!='#']"
    ))
      .forEach((a) => {
        const tx = labelLooksLikeContinue(a);
        const h = String(a.getAttribute("href") || "");
        const gameHref = /village\d*\.php|dorf\d*\.php|spieler\.php|\bbuild\.php|\boverview\.php/i.test(h);
        if (tx || gameHref) {
          clickable.push(a);
        }
      });

    for (const anchor of clickable) {
      if (anchor && typeof anchor.click === "function") {
        anchor.click();
        return { clicked: true, kind: "link" };
      }
    }

    if (onNewsGate) {
      const submitters = [
        ...Array.from(document.querySelectorAll("#content input[type='submit'], #contentOuter input[type='submit']")),
        ...Array.from(
          document.querySelectorAll("#content button[type='submit'], #contentOuter button[type='submit']")
        ),
        ...Array.from(
          document.querySelectorAll("#content button:not([disabled]), #contentOuter button:not([disabled])")
        ).slice(0, 8)
      ];
      for (const el of submitters) {
        if (!labelLooksLikeContinue(el)) {
          continue;
        }
        if (!canActivate(el)) {
          continue;
        }
        if (typeof el.click === "function") {
          el.click();
          return { clicked: true, kind: "submit" };
        }
      }

      const onlyFormSubmit = Array.from(
        document.querySelectorAll("#content form:last-of-type input[type='submit'], #content form:last-of-type button")
      ).find((el) => typeof el.click === "function") || document.querySelector(
        "#content form:last-of-type input[type='submit'], #content form:last-of-type button"
      );
      if (onlyFormSubmit && typeof onlyFormSubmit.click === "function") {
        onlyFormSubmit.click();
        return { clicked: true, kind: "formFallback" };
      }
    }

    return { clicked: false, kind: null };
  }).catch(() => ({ clicked: false, kind: null }));

  if (dismissed && dismissed.clicked) {
    await page.waitForTimeout(350);
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => {});
    return true;
  }
  return false;
}

async function escapeShownewBlockingPage(page) {
  const url = String(page.url() || "");
  if (!/shownew\.php|show_news\.php/i.test(url)) {
    return false;
  }

  const nextHref = await page.evaluate(() => {
    const prefer = (selector) => {
      const el = document.querySelector(selector);
      return el && el.getAttribute("href") ? el.getAttribute("href").trim() : null;
    };
    const fromSelectors =
      prefer("a[href*='village1.php']") ||
      prefer("a[href*='dorf1.php']") ||
      prefer("a[href*='village2.php']") ||
      prefer("a[href*='spieler.php'][href*='s=']") ||
      prefer("a[href*='overview.php']");
    if (fromSelectors) {
      return fromSelectors;
    }
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const h = anchor.getAttribute("href") || "";
      if (/village\d*\.php|dorf\d*\.php|spieler\.php|overview\.php|build\.php\?id=\d+/i.test(h)) {
        const lower = h.toLowerCase();
        if (lower.includes("logout") || lower.includes("abbruch")) {
          continue;
        }
        return h.trim();
      }
    }
    return null;
  }).catch(() => null);

  if (nextHref) {
    await page.goto(new URL(nextHref, page.url()).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }).catch(() => null);
    return true;
  }

  await escapeShownewsContinueAction(page);
  let stillNews = /shownew\.php|show_news\.php/i.test(String(page.url() || ""));
  if (!stillNews) {
    return true;
  }

  try {
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/dorf1.php`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }).catch(async () => {
      await page.goto(`${origin}/village1.php`, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }).catch(() => null);
    });
    stillNews = /shownew\.php|show_news\.php/i.test(String(page.url() || ""));
    return !stillNews;
  } catch (_error) {
    return false;
  }
}

async function safeGotoFarmlist(page, farmlistUrl, retries = 2) {
  await safeGotoWithRetry(page, farmlistUrl, {}, retries);
}

async function gotoFarmlistWithNewsEscape(page, farmlistUrl) {
  await safeGotoFarmlist(page, farmlistUrl);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const escaped = await escapeShownewBlockingPage(page);
    if (!escaped) {
      break;
    }
    await safeGotoFarmlist(page, farmlistUrl).catch(() => null);
  }
}

/** Nexian / Travian farmlists usually require “select all” before Send is enabled. */
async function inspectFarmlistSendState(page, sendSelector) {
  return page
    .evaluate((sel) => {
      const isDisabled = (el) => {
        if (!el || !(el instanceof HTMLElement)) {
          return true;
        }
        if ("disabled" in el && el.disabled) {
          return true;
        }
        if (el.getAttribute("aria-disabled") === "true") {
          return true;
        }
        if (el.classList.contains("disabled") || el.classList.contains("btn_disabled")) {
          return true;
        }
        return false;
      };

      const sendBtn = sel ? document.querySelector(sel) : null;
      const sendDisabled = isDisabled(sendBtn);

      const boxes = [];
      const seen = new Set();
      const addBox = (el) => {
        if (!el || seen.has(el) || !(el instanceof HTMLInputElement)) {
          return;
        }
        if (String(el.type || "").toLowerCase() !== "checkbox") {
          return;
        }
        const id = String(el.id || "");
        const name = String(el.name || "");
        if (/selectall|markall|mark_all/i.test(id + name)) {
          return;
        }
        seen.add(el);
        boxes.push(el);
      };

      for (const el of document.querySelectorAll('input[type="checkbox"]')) {
        const id = String(el.id || "");
        const name = String(el.name || "");
        if (/farmlist|fl_|farm/i.test(`${id} ${name}`)) {
          addBox(el);
        }
      }

      for (const table of document.querySelectorAll("table")) {
        const text = String(table.textContent || "").toLowerCase();
        if (text.includes("farm") && (text.includes("list") || text.includes("raid"))) {
          for (const el of table.querySelectorAll('input[type="checkbox"]')) {
            addBox(el);
          }
        }
      }

      let enabledLists = 0;
      let checkedLists = 0;
      for (const el of boxes) {
        if (!el.disabled) {
          enabledLists += 1;
          if (el.checked) {
            checkedLists += 1;
          }
        }
      }

      const pageText = String((document.body && document.body.innerText) || "").toLowerCase();
      const hasFarmListUi = Boolean(
        sendBtn ||
          document.querySelector('[id*="farmlist"], [class*="farmlist"], [class*="farmList"]') ||
          /farm\s*list/i.test(pageText)
      );

      const nothingToSend =
        sendDisabled && hasFarmListUi && boxes.length > 0 && enabledLists === 0;
      const noListsConfigured = hasFarmListUi && boxes.length === 0 && sendDisabled;

      let message = "";
      if (nothingToSend) {
        message = `No farmlists ready to send (${boxes.length} list(s) on cooldown or inactive).`;
      } else if (noListsConfigured) {
        message = "Farmlist page loaded but no farmlists found (empty rally point or wrong village).";
      }

      return {
        sendDisabled,
        farmlistCount: boxes.length,
        enabledLists,
        checkedLists,
        hasFarmListUi,
        nothingToSend,
        noListsConfigured,
        message,
        href: window.location.href
      };
    }, sendSelector)
    .catch(() => ({
      sendDisabled: true,
      farmlistCount: 0,
      enabledLists: 0,
      checkedLists: 0,
      hasFarmListUi: false,
      nothingToSend: false,
      noListsConfigured: false,
      message: "",
      href: ""
    }));
}

async function ensureFarmlistSelectAllBeforeSend(page, settings) {
  await page
    .evaluate(() => {
      const fireChange = (el) => {
        try {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } catch (_err) {
          /* ignore */
        }
      };

      const listBoxes = [];
      const seen = new Set();
      const addListBox = (el) => {
        if (!el || seen.has(el) || !(el instanceof HTMLInputElement)) {
          return;
        }
        if (String(el.type || "").toLowerCase() !== "checkbox") {
          return;
        }
        const id = String(el.id || "");
        const name = String(el.name || "");
        if (/selectall|markall|mark_all/i.test(id + name)) {
          return;
        }
        if (!/farmlist|fl_|farm/i.test(`${id} ${name}`)) {
          const table = el.closest("table");
          const tableText = table ? String(table.textContent || "").toLowerCase() : "";
          if (!(tableText.includes("farm") && (tableText.includes("list") || tableText.includes("raid")))) {
            return;
          }
        }
        seen.add(el);
        listBoxes.push(el);
      };

      for (const el of document.querySelectorAll('input[type="checkbox"]')) {
        addListBox(el);
      }

      let checkedLists = 0;
      for (const el of listBoxes) {
        if (el.disabled) {
          continue;
        }
        if (!el.checked) {
          el.checked = true;
          fireChange(el);
          checkedLists += 1;
        }
      }

      const selectAllSelectors = [
        'input[id*="farmlist_selectall"]',
        'input[name="markAll"]',
        'input[name="mark_all"]'
      ];
      for (const sel of selectAllSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.disabled) {
            continue;
          }
          if (!el.checked) {
            el.checked = true;
            fireChange(el);
          }
        }
      }

      return { listCount: listBoxes.length, checkedLists };
    })
    .catch(() => ({ listCount: 0, checkedLists: 0 }));

  const selectors = [
    settings && settings.selectAllSelector,
    'input[id^="farmlist_selectall_"]',
    'input[id*="farmlist_selectall"]',
    'input[name="markAll"]'
  ].filter(Boolean);
  const seen = new Set();
  for (const sel of selectors) {
    if (seen.has(sel)) {
      continue;
    }
    seen.add(sel);
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const item = loc.nth(i);
      const role = await item
        .evaluate((el) => String(el.getAttribute("type") || "").toLowerCase())
        .catch(() => "");
      const checked = await item.isChecked().catch(() => false);
      if (role === "checkbox" || role === "radio") {
        if (!checked) {
          await item.check({ force: true }).catch(async () => {
            await item.click({ force: true }).catch(() => {});
          });
        }
      } else if (!checked) {
        await item.click({ force: true }).catch(() => {});
      }
    }
  }

  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(650);
}

async function isSendControlDisabled(page, selector) {
  const loc = page.locator(selector).first();
  return loc.evaluate((el) => {
    if (!el || !(el instanceof HTMLElement)) {
      return true;
    }
    if ("disabled" in el && el.disabled) {
      return true;
    }
    if (el.getAttribute("aria-disabled") === "true") {
      return true;
    }
    if (el.classList.contains("disabled") || el.classList.contains("btn_disabled")) {
      return true;
    }
    return false;
  }).catch(() => true);
}

async function waitSendControlEnabled(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!(await isSendControlDisabled(page, selector))) {
      return true;
    }
    await page.waitForTimeout(280);
  }
  return false;
}

async function activateFarmlistSendControl(page, chosenSendSelector) {
  const loc = page.locator(chosenSendSelector).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});

  try {
    await loc.click({ timeout: 12000 });
    return true;
  } catch (_e) {
    try {
      await loc.click({ force: true, timeout: 8000 });
      return true;
    } catch (_e2) {
      // DOM click / requestSubmit (covers some Travian AJAX forms)
    }
  }

  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!button) {
      return { ok: false, reason: "missing" };
    }
    if (
      button.hasAttribute("disabled") ||
      button.getAttribute("aria-disabled") === "true" ||
      (button.classList &&
        (button.classList.contains("disabled") || button.classList.contains("btn_disabled")))
    ) {
      return { ok: false, reason: "disabled" };
    }

    const fire = (target) => {
      try {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch (_err) {
        return false;
      }
      return true;
    };

    const form = button.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit(button);
        return { ok: true, reason: "requestSubmit" };
      } catch (_err) {
        /* fall through */
      }
    }

    if (typeof button.click === "function") {
      button.click();
      return { ok: true, reason: "click" };
    }

    if (form && typeof form.submit === "function") {
      form.submit();
      return { ok: true, reason: "formSubmit" };
    }

    return { ok: fire(button), reason: "dispatch" };
  }, chosenSendSelector).then((r) => Boolean(r && r.ok)).catch(() => false);
}

async function isLikelyFarmlistPage(page) {
  const url = String(page.url() || "").toLowerCase();
  if (/t=99/.test(url) && (/gid=16/.test(url) || /gid%3d16/.test(url))) {
    return true;
  }
  if (/farmlist/i.test(url)) {
    return true;
  }
  return page
    .evaluate(() =>
      Boolean(
        document.querySelector(
          '#btn_send_all, input[name="start_all_raids"], [id*="farmlist_selectall"], input[id*="farmlist"]'
        )
      )
    )
    .catch(() => false);
}

function isBlockedFarmlistSendSelector(selector) {
  const normalized = String(selector || "").toLowerCase();
  return (
    /btn_train/.test(normalized) ||
    /train_troop/.test(normalized) ||
    /#btn_train/.test(normalized)
  );
}

async function validateFarmlistSendSelector(page, selector) {
  if (!selector || isBlockedFarmlistSendSelector(selector)) {
    return false;
  }
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el || !(el instanceof HTMLElement)) {
        return false;
      }
      const id = String(el.id || "").toLowerCase();
      const name = String(el.getAttribute("name") || "").toLowerCase();
      if (id === "btn_train" || /train/.test(id) || /train/.test(name)) {
        return false;
      }
      if (
        id.includes("send") ||
        id.includes("sendall") ||
        name.includes("start_all") ||
        name.includes("raid") ||
        name.includes("send")
      ) {
        return true;
      }
      const text = String(el.textContent || el.getAttribute("value") || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return /\bsend\b/.test(text) || text.includes("start all") || text.includes("start raid");
    }, selector)
    .catch(() => false);
}

/** When CSS ids differ (e.g. Nexian), pick the best visible send / start-raids control and return a Playwright-safe selector. */
async function discoverFarmlistSendSelectorFromDom(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el || !(el instanceof Element)) {
        return false;
      }
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };

    const textOf = (el) => String(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const score = (el) => {
      const id = String(el.id || "").toLowerCase();
      const nm = String(el.getAttribute("name") || "").toLowerCase();
      const typ = String(el.getAttribute("type") || "").toLowerCase();
      const val = String(el.getAttribute("value") || "").toLowerCase();
      const tx = textOf(el);
      if (id === "btn_train" || (id.includes("train") && !id.includes("raid"))) {
        return -100;
      }
      if (nm.includes("train") && !nm.includes("raid")) {
        return -100;
      }
      let s = 0;
      if (id.includes("btn_send") || id.includes("send_all") || id.includes("sendall")) {
        s += 8;
      }
      if (nm.includes("start_all") || nm.includes("raid") || nm.includes("send")) {
        s += 6;
      }
      if (/\bsend\b/.test(tx) || tx.includes("start all") || tx.includes("start raid")) {
        s += 5;
      }
      if (/\bsend\b/.test(val) || val.includes("raid")) {
        s += 4;
      }
      if (el.tagName === "BUTTON" || typ === "submit" || typ === "button") {
        s += 1;
      }
      if (id && /^btn_(send|start)/i.test(id)) {
        s += 2;
      }
      const oc = String(el.getAttribute("onclick") || "").toLowerCase();
      if (oc.includes("send") || oc.includes("raid") || oc.includes("start")) {
        s += 5;
      }
      return s;
    };

    const nodes = Array.from(
      document.querySelectorAll(
        "button, input[type='submit'], input[type='button'], a.button, a.green, a[class*='btn'], a[href*='start']"
      )
    ).filter(visible);

    const ranked = nodes
      .map((el) => ({ el, s: score(el) }))
      .filter((x) => x.s >= 4)
      .sort((a, b) => b.s - a.s);
    const best = ranked[0] && ranked[0].el;
    if (!best) {
      return null;
    }

    if (best.id) {
      const raw = String(best.id);
      try {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
          return `#${CSS.escape(raw)}`;
        }
      } catch (_e) {
        /* fall through */
      }
      return `[id="${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    }
    const nm = best.getAttribute("name");
    if (nm && document.querySelectorAll(`[name="${nm.replace(/"/g, '\\"')}"]`).length === 1) {
      return `[name="${nm.replace(/"/g, '\\"')}"]`;
    }
    return null;
  });
}

async function sendFarmlists(getPage, settings, options = {}) {
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable. Retry after re-login completes.");
  }

  // Pin the farmlist to a village that actually has a Rally Point. Other loops
  // (builder/troop) can leave the game on a village without a rally point, which
  // makes build.php?id=39&gid=16 show nothing to send. A pinned vid keeps context.
  const pinnedVillageId =
    options && Number.isFinite(Number(options.villageId)) && Number(options.villageId) > 0
      ? Math.trunc(Number(options.villageId))
      : settings && Number.isFinite(Number(settings.farmlistVillageId)) && Number(settings.farmlistVillageId) > 0
        ? Math.trunc(Number(settings.farmlistVillageId))
        : null;
  const farmlistTargetUrl = pinnedVillageId
    ? withVillageId(settings.farmlistUrl, pinnedVillageId)
    : settings.farmlistUrl;

  await gotoFarmlistWithNewsEscape(page, farmlistTargetUrl);

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
  await page.waitForTimeout(600);

  if (!(await isLikelyFarmlistPage(page))) {
    await gotoFarmlistWithNewsEscape(page, farmlistTargetUrl);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(600);
  }

  const sendSelectors = [
    "#btn_send_all",
    settings.sendButtonSelector,
    'button[id^="btn_send"]',
    '[id*="btn_send"]',
    '[id*="send_all"]',
    '[id*="sendall"]',
    'input[name="start_all_raids"]',
    'input[type="submit"][name*="raid"]',
    'button[name="start_all_raids"]',
    'input[id*="send_all"]',
    'input[type="submit"][value*="Send"]',
    'input[type="submit"][value*="send"]',
    'input[type="button"][value*="Send"]',
    "button:has-text(\"Send\")",
    "button:has-text(\"send\")",
    "a:has-text(\"Send\")"
  ].filter(Boolean);

  const findSendSelector = async () => {
    for (const selector of sendSelectors) {
      const exists = await page
        .locator(selector)
        .first()
        .count()
        .then((count) => count > 0)
        .catch(() => false);
      if (exists && (await validateFarmlistSendSelector(page, selector))) {
        return selector;
      }
    }
    const discovered = await discoverFarmlistSendSelectorFromDom(page).catch(() => null);
    if (discovered && typeof discovered === "string" && discovered.trim()) {
      const trimmed = discovered.trim();
      const ok =
        (await page
          .locator(trimmed)
          .first()
          .count()
          .then((c) => c > 0)
          .catch(() => false)) && (await validateFarmlistSendSelector(page, trimmed));
      if (ok) {
        return trimmed;
      }
    }
    return null;
  };

  const waitForSendSelector = async (timeoutMs = 12000) => {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() < deadline) {
      const found = await findSendSelector();
      if (found) {
        return found;
      }
      await page.waitForTimeout(400);
    }
    return null;
  };

  let chosenSendSelector = await waitForSendSelector(12000);

  // Fallback 1: discover farmlist URL from the current page and navigate there.
  if (!chosenSendSelector) {
    const discoveredFarmlistHref = await page.evaluate(() => {
      const candidates = [
        "a[href*='build.php'][href*='t=99'][href*='gid=16']",
        "a[href*='t=99'][href*='gid=16']",
        "a[href*='farmlist']"
      ];
      for (const selector of candidates) {
        const link = document.querySelector(selector);
        if (link && typeof link.getAttribute === "function") {
          const href = link.getAttribute("href") || "";
          if (href) {
            return href;
          }
        }
      }
      return null;
    });

    if (discoveredFarmlistHref) {
      const resolved = new URL(discoveredFarmlistHref, page.url()).toString();
      await page.goto(resolved, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
      if (await escapeShownewBlockingPage(page)) {
        await page.goto(resolved, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        }).catch(() => null);
      }
    } else {
      await gotoFarmlistWithNewsEscape(page, farmlistTargetUrl);
    }

    chosenSendSelector = await waitForSendSelector(12000);
  }

  // Fallback 2: Village center -> Rally Point -> Farm Lists.
  if (!chosenSendSelector) {
    let villageCenterHref = null;
    if (!pinnedVillageId) {
      villageCenterHref = await page.evaluate(() => {
        const link = document.querySelector("a#n2[href], a[href*='village2.php']");
        return link && typeof link.getAttribute === "function"
          ? (link.getAttribute("href") || null)
          : null;
      });
    }
    const targetVillageCenter = villageCenterHref
      ? withVillageId(new URL(villageCenterHref, page.url()).toString(), pinnedVillageId)
      : withVillageId(new URL("/village2.php", page.url()).toString(), pinnedVillageId);

    await page.goto(targetVillageCenter, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const rallyPointHref = await page.evaluate(() => {
      const link = document.querySelector(
        "area[href*='build.php?id=39'], a[href*='build.php?id=39']"
      );
      return link && typeof link.getAttribute === "function"
        ? (link.getAttribute("href") || null)
        : null;
    });

    if (rallyPointHref) {
      await page.goto(new URL(rallyPointHref, page.url()).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      const farmListsHref = await page.evaluate(() => {
        const link = document.querySelector(
          "a[href*='build.php?id=39'][href*='t=99'], a[href*='?t=99'], a[href*='&t=99']"
        );
        return link && typeof link.getAttribute === "function"
          ? (link.getAttribute("href") || null)
          : null;
      });

      if (farmListsHref) {
        await page.goto(new URL(farmListsHref, page.url()).toString(), {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
      }
    }

    chosenSendSelector = await waitForSendSelector(12000);
  }

  // Legacy path: if send button still not found, try old select-all flow.
  if (!chosenSendSelector) {
    const selectAll = page.locator(settings.selectAllSelector);
    const hasSelectAll = await selectAll.count().then((count) => count > 0).catch(() => false);
    if (hasSelectAll) {
      const alreadyChecked = await selectAll.isChecked().catch(() => false);
      if (!alreadyChecked) {
        await selectAll.check({ force: true });
      }
    }

    chosenSendSelector = await waitForSendSelector(8000);
  }

  if (!chosenSendSelector && /shownew\.php|show_news\.php/i.test(String(page.url() || ""))) {
    await gotoFarmlistWithNewsEscape(page, farmlistTargetUrl);
    chosenSendSelector = await waitForSendSelector(12000);
  }

  if (!chosenSendSelector) {
    await ensureFarmlistSelectAllBeforeSend(page, settings);
    await page.waitForTimeout(500);

    const trySendByRoleOrLabel = async () => {
      const candidates = [
        () => page.getByRole("button", { name: /send\s*all/i }),
        () => page.getByRole("button", { name: /^send$/i }),
        () => page.getByRole("button", { name: /start.*raid/i }),
        () => page.getByRole("button", { name: /farm.*list/i }),
        () => page.getByRole("link", { name: /send/i })
      ];
      for (const pick of candidates) {
        const loc = pick();
        const count = await loc.count().catch(() => 0);
        if (!count) {
          continue;
        }
        const first = loc.first();
        if (!(await first.isVisible().catch(() => false))) {
          continue;
        }
        const preMs = Math.max(600, getRandomDelayMs(settings));
        await page.waitForTimeout(preMs);
        await first.scrollIntoViewIfNeeded().catch(() => {});
        await first.click({ timeout: 15000 }).catch(async () => {
          await first.click({ force: true, timeout: 10000 }).catch(() => {});
        });
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        return true;
      }
      return false;
    };

    if (await trySendByRoleOrLabel()) {
      return { status: "sent" };
    }

    const authState = await page.evaluate(() => {
      const hasLoginForm = Boolean(document.querySelector("form[name='login'], input[name='name'], input[name='password']"));
      const onIndex = /\/index\.php/i.test(window.location.pathname);
      return { hasLoginForm, onIndex, href: window.location.href };
    }).catch(() => ({ hasLoginForm: false, onIndex: false, href: page.url() }));

    if (authState.hasLoginForm || authState.onIndex) {
      throw new Error(`Farmlist page unavailable (likely redirected/out of session): ${authState.href}`);
    }
    if (/shownew\.php|show_news\.php/i.test(String(page.url() || ""))) {
      throw new Error(
        `Farmlist blocked on news/shownew page (no escape link matched). Try opening the game in browser once, then retry. URL: ${page.url()}`
      );
    }
    throw new Error(
      `Could not find a farmlist send button on page: ${page.url()} ` +
        `(this village may have no Rally Point — set FARMLIST_VILLAGE_ID in .env to a village that has one, ` +
        `or set FARMLIST_SEND_BUTTON_SELECTOR if the UI uses a non-standard control).`
    );
  }

  if (
    chosenSendSelector &&
    (!(await validateFarmlistSendSelector(page, chosenSendSelector)) || !(await isLikelyFarmlistPage(page)))
  ) {
    await gotoFarmlistWithNewsEscape(page, farmlistTargetUrl);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(600);
    chosenSendSelector = await waitForSendSelector(12000);
  }

  if (chosenSendSelector && isBlockedFarmlistSendSelector(chosenSendSelector)) {
    const villageHint = pinnedVillageId ? ` (vid=${pinnedVillageId})` : "";
    throw new Error(
      `Not on farmlist page — troop trainer #btn_train was not used as send control${villageHint}. URL: ${page.url()}`
    );
  }

  await ensureFarmlistSelectAllBeforeSend(page, settings);
  let sendEnabled = await waitSendControlEnabled(page, chosenSendSelector, 12000);
  if (!sendEnabled) {
    await ensureFarmlistSelectAllBeforeSend(page, settings);
    sendEnabled = await waitSendControlEnabled(page, chosenSendSelector, 8000);
  }

  // Safety delay before submitting farmlists:
  // use configured random delay range, but never below 1000ms.
  const preSendDelayMs = Math.max(1000, getRandomDelayMs(settings));
  await page.waitForTimeout(preSendDelayMs);

  if (!sendEnabled) {
    const sendState = await inspectFarmlistSendState(page, chosenSendSelector);
    const villageHint = pinnedVillageId ? ` (vid=${pinnedVillageId})` : "";
    if (sendState.nothingToSend) {
      return {
        status: "idle",
        message: `[Farmlist] ${sendState.message}${villageHint}`,
        ...sendState
      };
    }
    if (sendState.noListsConfigured) {
      throw new Error(
        `${sendState.message}${villageHint} Set FARMLIST_VILLAGE_ID in .env to a village with Rally Point farmlists. URL: ${sendState.href || page.url()}`
      );
    }
  }

  const clicked = await activateFarmlistSendControl(page, chosenSendSelector);
  if (!clicked) {
    const stillDisabled = await isSendControlDisabled(page, chosenSendSelector);
    if (stillDisabled) {
      const sendState = await inspectFarmlistSendState(page, chosenSendSelector);
      const villageHint = pinnedVillageId ? ` (vid=${pinnedVillageId})` : "";
      if (sendState.nothingToSend) {
        return {
          status: "idle",
          message: `[Farmlist] ${sendState.message}${villageHint}`,
          ...sendState
        };
      }
      throw new Error(
        sendState.enabledLists > 0
          ? `Found farmlist send control '${chosenSendSelector}' but it stayed disabled after selecting ${sendState.checkedLists}/${sendState.enabledLists} ready list(s)${villageHint} (UI changed or AJAX did not enable send).`
          : `Found farmlist send control '${chosenSendSelector}' but it stayed disabled after select-all (no active farmlists, wrong village, or UI changed)${villageHint}.`
      );
    }
    throw new Error(
      `Found farmlist send control '${chosenSendSelector}' but could not activate it (blocked click — try adjusting SEND_BUTTON_SELECTOR or run headed once).`
    );
  }

  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  return { status: "sent" };
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
    return url;
  }
}

/** Retry goto when Nexian redirects (e.g. village1.php → village1.php?vid=…). */
async function safeGotoWithRetry(page, url, options = {}, retries = 2) {
  const gotoOptions = { waitUntil: "domcontentloaded", timeout: 60000, ...options };
  const maxRetries = Math.max(retries, 4);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await page.goto(url, gotoOptions);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientNavigationError(error)) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      try {
        const target = new URL(url, page.url());
        const current = new URL(String(page.url() || ""));
        if (current.origin === target.origin) {
          const currentPath = current.pathname.toLowerCase();
          const targetPath = target.pathname.toLowerCase();
          if (
            currentPath === targetPath ||
            /\/(village1|dorf1|village2|dorf2)\.php$/.test(currentPath)
          ) {
            return;
          }
        }
      } catch (_parseError) {
        /* fall through to retry */
      }
      if (attempt >= maxRetries) {
        throw error;
      }
      await page.waitForTimeout(navigationRetryDelayMs(attempt, error)).catch(() => {});
    }
  }
  if (lastError) {
    throw lastError;
  }
}

function resolveVillageStatusUrl(settings, villageState = null) {
  const preferredVid =
    villageState &&
    (villageState.selectedVillageId || villageState.activeVillageId || null);
  return preferredVid
    ? withVillageId(settings.villageStatusUrl, preferredVid)
    : settings.villageStatusUrl;
}

function villageDisplayName(village) {
  if (!village) {
    return "N/A";
  }
  const coords = village.coordsText || "(?|?)";
  const capitalTag = village.isCapital ? " [Capital]" : "";
  return `${village.name || "?"} ${coords}${capitalTag} (vid=${village.id})`;
}

function printVillageContextStatus(villageState, settings) {
  const total = villageState.villages.length;
  const selected = villageState.villages.find((v) => v.id === villageState.selectedVillageId) || null;
  const active = villageState.villages.find((v) => v.id === villageState.activeVillageId) || null;
  const excludedSet = parsePivotVillageIdSet(settings && settings.builderRoundRobinExcludedVillageIds);
  const selectedExcluded = selected && excludedSet.has(Number(selected.id));
  const activeExcluded = active && excludedSet.has(Number(active.id));

  if (isCompactDisplay(settings)) {
    console.log("");
    console.log("");
    const sel = villageDisplayName(selected);
    const act = villageDisplayName(active);
    let line = `  ${color("Villages:", ANSI.gray)} ${color(String(total), ANSI.bold, ANSI.cyan)}  ${color("Sel:", ANSI.gray)} ${color(sel, ANSI.bold, ANSI.yellow)}  ${color("Act:", ANSI.gray)} ${color(act, ANSI.bold, ANSI.green)}`;
    if (selectedExcluded || activeExcluded) {
      line += color("  RR excl", ANSI.bold, ANSI.yellow);
    }
    console.log(line);
    return;
  }

  console.log("");
  console.log(`  ${color("Villages:", ANSI.gray)} ${color(String(total), ANSI.bold, ANSI.cyan)}`);
  console.log(
    `  ${color("Selected:", ANSI.gray)} ${color(villageDisplayName(selected), ANSI.bold, ANSI.yellow)}`
  );
  if (selectedExcluded) {
    console.log(`  ${color("Selected RR:", ANSI.gray)} ${color("EXCLUDED", ANSI.bold, ANSI.yellow)}`);
  }
  console.log(
    `  ${color("Currently Active:", ANSI.gray)} ${color(villageDisplayName(active), ANSI.bold, ANSI.green)}`
  );
  if (activeExcluded) {
    console.log(`  ${color("Active RR:", ANSI.gray)} ${color("EXCLUDED", ANSI.bold, ANSI.yellow)}`);
  }
}

function printVillageSelectionMenu(villageState) {
  printSubDivider("VILLAGE SELECTOR");
  if (!villageState.villages.length) {
    console.log(`  ${color("No villages detected yet.", ANSI.yellow)}`);
    return;
  }

  villageState.villages.forEach((village, index) => {
    const selectedMark = village.id === villageState.selectedVillageId ? "*" : " ";
    const activeMark = village.id === villageState.activeVillageId ? "A" : " ";
    const marker = `[${selectedMark}${activeMark}]`;
    console.log(
      `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${color(marker, ANSI.gray)} ${villageDisplayName(village)}`
    );
  });

  console.log("");
  console.log(`  ${color("B", ANSI.bold, ANSI.cyan)}  Back`);
}

/** Same row layout as village selector; `[pivot]` marks saved raid pivot IDs. */
function printRaidPivotVillageSheet(snapshot, pivotIdSet) {
  const set = pivotIdSet instanceof Set ? pivotIdSet : parsePivotVillageIdSet("");
  printSubDivider("SET PIVOT VILLAGES");
  if (!snapshot || !Array.isArray(snapshot.villages) || !snapshot.villages.length) {
    console.log(`  ${color("No villages detected yet.", ANSI.yellow)}`);
    return;
  }

  snapshot.villages.forEach((village, index) => {
    const selectedMark = village.id === snapshot.selectedVillageId ? "*" : " ";
    const activeMark = village.id === snapshot.activeVillageId ? "A" : " ";
    const marker = `[${selectedMark}${activeMark}]`;
    const pivotTag = set.has(Number(village.id))
      ? color(" [pivot]", ANSI.bold, ANSI.green)
      : "";
    console.log(
      `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${color(marker, ANSI.gray)} ${villageDisplayName(village)}${pivotTag}`
    );
  });

  console.log("");
  console.log(`  ${color("A", ANSI.bold, ANSI.cyan)}  Clear pivot (auto / capital)`);
  console.log(`  ${color("M", ANSI.bold, ANSI.cyan)}  Set multiple pivots (CSV)`);
  console.log(`  ${color("B", ANSI.bold, ANSI.cyan)}  Back`);
}

function printBuilderRrExclusionSheet(snapshot, excludedIdSet) {
  const set = excludedIdSet instanceof Set ? excludedIdSet : parsePivotVillageIdSet("");
  printSubDivider("BUILDER RR EXCLUSIONS");
  if (!snapshot || !Array.isArray(snapshot.villages) || !snapshot.villages.length) {
    console.log(`  ${color("No villages detected yet.", ANSI.yellow)}`);
    return;
  }

  snapshot.villages.forEach((village, index) => {
    const selectedMark = village.id === snapshot.selectedVillageId ? "*" : " ";
    const activeMark = village.id === snapshot.activeVillageId ? "A" : " ";
    const marker = `[${selectedMark}${activeMark}]`;
    const excludedTag = set.has(Number(village.id))
      ? color(" [RR OFF]", ANSI.bold, ANSI.yellow)
      : color(" [RR ON]", ANSI.dim, ANSI.green);
    console.log(
      `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${color(marker, ANSI.gray)} ${villageDisplayName(village)}${excludedTag}`
    );
  });

  console.log("");
  console.log(`  ${color("A", ANSI.bold, ANSI.cyan)}  Clear all exclusions`);
  console.log(`  ${color("M", ANSI.bold, ANSI.cyan)}  Set exclusions by CSV (row numbers / vids)`);
  console.log(`  ${color("B", ANSI.bold, ANSI.cyan)}  Back`);
}

function printMainMenu(automationStatus, settings = terminalUiSettings) {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const paused = Boolean(automationStatus && automationStatus.paused);
  const reason = String((automationStatus && automationStatus.reason) || "online");
  const pauseLabel = paused ? "PAUSED" : "RUNNING";
  const pauseColor = paused ? ANSI.yellow : ANSI.green;

  if (isCompactDisplay(settings)) {
    printDivider("NEXIAN");
    console.log(
      `  ${color(`${hh}:${min}:${ss}`, ANSI.bold, ANSI.cyan)}  ${color(pauseLabel, ANSI.bold, pauseColor)} ${color(`(${reason})`, ANSI.gray)}`
    );
    return;
  }

  printDivider("NEXIAN");
  console.log(`  ${color("0", ANSI.bold, ANSI.cyan)}  Village Status`);
  console.log(`  ${color("1", ANSI.bold, ANSI.cyan)}  Send Farmlists`);
  console.log(`  ${color("2", ANSI.bold, ANSI.cyan)}  Village Stage Builder`);
  console.log(`  ${color("3", ANSI.bold, ANSI.cyan)}  Resource Fields Builder`);
  console.log(`  ${color("4", ANSI.bold, ANSI.cyan)}  Troop Trainer`);
  console.log(`  ${color("C", ANSI.bold, ANSI.cyan)}  Cranny defense (selected village)`);
  console.log(`  ${color("T", ANSI.bold, ANSI.cyan)}  Troop Plans (timers + per-village)`);
  console.log(`  ${color("5", ANSI.bold, ANSI.cyan)}  Expansion / Residence Check`);
  console.log(`  ${color("X", ANSI.bold, ANSI.cyan)}  Stop Builder Process`);
  console.log(`  ${color("r", ANSI.bold, ANSI.cyan)}  Relogin Now`);
  console.log(`  ${color("R", ANSI.bold, ANSI.cyan)}  Relogin + Village Status`);
  console.log(`  ${color("y", ANSI.bold, ANSI.cyan)}  Change Proxy + Relogin`);
  console.log(`  ${color("V", ANSI.bold, ANSI.cyan)}  Select Village Context`);
  console.log(`  ${color("L", ANSI.bold, ANSI.cyan)}  Logs (Summary)`);
  console.log(`  ${color("O", ANSI.bold, ANSI.cyan)}  Top 10 Snapshot Now`);
  console.log(`  ${color("P", ANSI.bold, ANSI.cyan)}  Pause/Unpause Automation`);
  console.log(`  ${color("S", ANSI.bold, ANSI.cyan)}  Settings`);
  console.log(`  ${color("Q", ANSI.bold, ANSI.cyan)}  Quit`);
}

function printCompactMenuKeys(settings = terminalUiSettings) {
  if (!isCompactDisplay(settings)) {
    return;
  }
  console.log("");
  console.log(
    `  ${color("0", ANSI.bold, ANSI.cyan)} Status  ${color("1", ANSI.bold, ANSI.cyan)} Farm  ${color("2", ANSI.bold, ANSI.cyan)} V.Bld  ${color("3", ANSI.bold, ANSI.cyan)} R.Bld  ${color("4", ANSI.bold, ANSI.cyan)} Troop  ${color("5", ANSI.bold, ANSI.cyan)} Exp`
  );
  console.log(
    `  ${color("T", ANSI.bold, ANSI.cyan)} Tpl  ${color("C", ANSI.bold, ANSI.cyan)} Cranny  ${color("V", ANSI.bold, ANSI.cyan)} Village  ${color("L", ANSI.bold, ANSI.cyan)} Log  ${color("P", ANSI.bold, ANSI.cyan)} Pause  ${color("S", ANSI.bold, ANSI.cyan)} Set  ${color("Q", ANSI.bold, ANSI.cyan)} Quit`
  );
}

function printCompactPromptStatus(settings, bits = {}) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const paused = Boolean(bits.paused);
  const reason = String(bits.reason || "online");
  const pauseLabel = paused
    ? color(`PAUSED (${reason})`, ANSI.bold, ANSI.yellow)
    : color("RUNNING", ANSI.bold, ANSI.green);
  const state = bits.busy
    ? color(bits.busyLabel || "Busy", ANSI.bold, ANSI.yellow)
    : color("Ready", ANSI.bold, ANSI.green);
  const hints = [];
  if (Number.isFinite(bits.farmlistNext)) {
    hints.push(color(`Farm ${bits.farmlistNext}m`, ANSI.cyan));
  }
  if (Number.isFinite(bits.builderNext)) {
    hints.push(color(`Bld ${bits.builderNext}m`, ANSI.cyan));
  }
  const hintText = hints.length ? `  ${hints.join(color(" · ", ANSI.gray))}` : "";
  console.log("");
  console.log(
    `  ${color(`${hh}:${min}:${ss}`, ANSI.bold, ANSI.cyan)}  ${pauseLabel}  ${state}${hintText}  ${color("(S settings · V villages · ? keys above)", ANSI.gray)}`
  );
}

function printSessionLoopStatus(settings, runtimeStatus, builderPlanMode = "village") {
  const sessionStatus = runtimeStatus && runtimeStatus.sessionLoop
    ? runtimeStatus.sessionLoop
    : { enabled: settings.sessionLoopEnabled, nextInMinutes: null };
  const farmlistStatus = runtimeStatus && runtimeStatus.farmlistLoop
    ? runtimeStatus.farmlistLoop
    : { enabled: settings.farmlistLoopEnabled, nextInMinutes: null };
  const builderStatus = runtimeStatus && runtimeStatus.builderLoop
    ? runtimeStatus.builderLoop
    : { enabled: settings.builderLoopEnabled, nextInMinutes: null };
  const troopStatus = runtimeStatus && runtimeStatus.troopLoop
    ? runtimeStatus.troopLoop
    : { enabled: settings.troopTrainingRoundRobinEnabled, nextInMinutes: null };
  const crannyStatus = runtimeStatus && runtimeStatus.crannyLoop
    ? runtimeStatus.crannyLoop
    : { enabled: settings.crannyDefenseRoundRobinEnabled, nextInMinutes: null };
  const builderPlanLabel = String(builderPlanMode || "village").toLowerCase() === "resource"
    ? "resource"
    : "village";

  if (isCompactDisplay(settings)) {
    const fmtLoop = (label, enabled, min, max, nextMin, nextSuffix = "") => {
      const on = enabled ? color("ON", ANSI.bold, ANSI.green) : color("OFF", ANSI.bold, ANSI.yellow);
      const next =
        enabled && Number.isFinite(nextMin)
          ? color(`→${nextMin}m${nextSuffix}`, ANSI.bold, ANSI.cyan)
          : "";
      return `${label} ${on}(${min}-${max}m)${next ? ` ${next}` : ""}`;
    };
    if (settings.sessionLoopEnabled) {
      const nextSessionText = Number.isFinite(sessionStatus.nextInMinutes)
        ? `${sessionStatus.nextInMinutes}m`
        : "—";
      console.log(
        `  ${color("Session:", ANSI.gray)} ${color("ON", ANSI.bold, ANSI.green)} play ${settings.playMinMinutes}-${settings.playMaxMinutes}m rest ${settings.restMinMinutes}-${settings.restMaxMinutes}m next ${color(nextSessionText, ANSI.bold, ANSI.cyan)}`
      );
    }
    const mainLoops = [
      fmtLoop(
        "Farm",
        settings.farmlistLoopEnabled,
        settings.farmlistLoopMinMinutes,
        settings.farmlistLoopMaxMinutes,
        farmlistStatus.nextInMinutes
      ),
      fmtLoop(
        "Bld",
        settings.builderLoopEnabled,
        settings.builderLoopMinMinutes,
        settings.builderLoopMaxMinutes,
        builderStatus.nextInMinutes,
        `/${builderPlanLabel}`
      ),
      fmtLoop(
        "Troop",
        settings.troopTrainingRoundRobinEnabled,
        settings.troopTrainingLoopMinMinutes,
        settings.troopTrainingLoopMaxMinutes,
        troopStatus.nextInMinutes
      )
    ].join(color(" | ", ANSI.gray));
    console.log(`  ${color("Loops:", ANSI.gray)} ${mainLoops}`);
    console.log(
      ` ${fmtLoop(
        "Cranny",
        settings.crannyDefenseRoundRobinEnabled,
        settings.crannyDefenseLoopMinMinutes,
        settings.crannyDefenseLoopMaxMinutes,
        crannyStatus.nextInMinutes
      )}`
    );
    return;
  }

  const modeLabel = settings.sessionLoopEnabled ? "Repeating Session" : "One-Time Login";
  const modeColor = settings.sessionLoopEnabled ? ANSI.green : ANSI.yellow;
  console.log("");
  console.log(
    `  ${color("Session Mode:", ANSI.gray)} ${color(modeLabel, ANSI.bold, modeColor)}`
  );

  if (settings.sessionLoopEnabled) {
    console.log(
      `  ${color("Play Window:", ANSI.gray)} ${color(`${settings.playMinMinutes}-${settings.playMaxMinutes} min`, ANSI.bold)}`
    );
    console.log(
      `  ${color("Rest Window:", ANSI.gray)} ${color(`${settings.restMinMinutes}-${settings.restMaxMinutes} min`, ANSI.bold)}`
    );
    const nextSessionText = Number.isFinite(sessionStatus.nextInMinutes)
      ? `${sessionStatus.nextInMinutes} min`
      : "N/A";
    console.log(
      `  ${color("Next Session Cycle:", ANSI.gray)} ${color(nextSessionText, ANSI.bold, ANSI.cyan)}`
    );
  }

  const farmModeLabel = settings.farmlistLoopEnabled ? "ON" : "OFF";
  const farmModeColor = settings.farmlistLoopEnabled ? ANSI.green : ANSI.yellow;
  console.log(
    `  ${color("Farmlist Loop:", ANSI.gray)} ${color(farmModeLabel, ANSI.bold, farmModeColor)} ${color(`(${settings.farmlistLoopMinMinutes}-${settings.farmlistLoopMaxMinutes} min)`, ANSI.bold)}`
  );
  if (settings.farmlistLoopEnabled) {
    const nextFarmlistText = Number.isFinite(farmlistStatus.nextInMinutes)
      ? `${farmlistStatus.nextInMinutes} min`
      : "N/A";
    console.log(
      `  ${color("Next Farmlist Send:", ANSI.gray)} ${color(nextFarmlistText, ANSI.bold, ANSI.cyan)}`
    );
  }

  const builderModeLabel = settings.builderLoopEnabled ? "ON" : "OFF";
  const builderModeColor = settings.builderLoopEnabled ? ANSI.green : ANSI.yellow;
  console.log(
    `  ${color("Builder Loop:", ANSI.gray)} ${color(builderModeLabel, ANSI.bold, builderModeColor)} ${color(`(${settings.builderLoopMinMinutes}-${settings.builderLoopMaxMinutes} min)`, ANSI.bold)} ${color(`[plan: ${builderPlanLabel}]`, ANSI.gray)}`
  );
  if (settings.builderLoopEnabled) {
    const nextBuilderText = Number.isFinite(builderStatus.nextInMinutes)
      ? `${builderStatus.nextInMinutes} min`
      : "N/A";
    console.log(
      `  ${color("Next Builder Run:", ANSI.gray)} ${color(nextBuilderText, ANSI.bold, ANSI.cyan)}`
    );
    if (builderStatus.roundRobinProgress) {
      console.log(
        `  ${color("Round-Robin Progress:", ANSI.gray)} ${color(builderStatus.roundRobinProgress, ANSI.bold, ANSI.cyan)}`
      );
    }
  }

  const troopModeLabel = settings.troopTrainingRoundRobinEnabled ? "ON" : "OFF";
  const troopModeColor = settings.troopTrainingRoundRobinEnabled ? ANSI.green : ANSI.yellow;
  console.log(
    `  ${color("Troop RR Loop:", ANSI.gray)} ${color(troopModeLabel, ANSI.bold, troopModeColor)} ${color(`(${settings.troopTrainingLoopMinMinutes}-${settings.troopTrainingLoopMaxMinutes} min)`, ANSI.bold)}`
  );
  if (settings.troopTrainingRoundRobinEnabled) {
    const nextTroopText = Number.isFinite(troopStatus.nextInMinutes)
      ? `${troopStatus.nextInMinutes} min`
      : "N/A";
    console.log(
      `  ${color("Next Troop Run:", ANSI.gray)} ${color(nextTroopText, ANSI.bold, ANSI.cyan)}`
    );
    console.log(
      `  ${color("Troop RR:", ANSI.gray)} ${color("trains each village's assigned plan (menu T)", ANSI.bold, ANSI.cyan)}`
    );
  }

  const crannyModeLabel = settings.crannyDefenseRoundRobinEnabled ? "ON" : "OFF";
  const crannyModeColor = settings.crannyDefenseRoundRobinEnabled ? ANSI.green : ANSI.yellow;
  console.log(
    `  ${color("Cranny defense RR:", ANSI.gray)} ${color(crannyModeLabel, ANSI.bold, crannyModeColor)} ${color(`(${settings.crannyDefenseLoopMinMinutes}-${settings.crannyDefenseLoopMaxMinutes} min)`, ANSI.bold)}`
  );
  if (settings.crannyDefenseRoundRobinEnabled) {
    const nextCrannyText = Number.isFinite(crannyStatus.nextInMinutes)
      ? `${crannyStatus.nextInMinutes} min`
      : "N/A";
    console.log(
      `  ${color("Next Cranny Run:", ANSI.gray)} ${color(nextCrannyText, ANSI.bold, ANSI.cyan)}`
    );
  }
}

function printSettings(settings, villageState) {
  normalizeDelayRange(settings);
  normalizeExpansionSettlementSettings(settings);

  if (isCompactDisplay(settings)) {
    printSubDivider("SETTINGS");
    console.log(
      `  ${color("display", ANSI.gray)}: ${color(
        settings.dashboardCompactView ? "Compact view" : "Full view",
        ANSI.bold,
        ANSI.cyan
      )}  ${color("(D toggles)", ANSI.gray)}`
    );
    return;
  }

  printSubDivider("SETTINGS");
  printKeyValueRows([
    { label: "browserMode", value: settings.headless ? "Headless" : "Full Browser" },
    { label: "proxy", value: formatProxyDisplay(settings) },
    { label: "randomDelayMs", value: `${settings.randomDelayMinMs}-${settings.randomDelayMaxMs}` },
    { label: "pauseAutoUnpauseMinutes", value: `${settings.manualPauseAutoUnpauseMinutes || 5}` },
    { label: "dashboardDisplay", value: settings.dashboardCompactView ? "Compact view" : "Full view" },
    { label: "farmlistUrl", value: settings.farmlistUrl },
    { label: "villageBuilderUrl", value: settings.villageBuilderUrl },
    { label: "troopTrainerUrl", value: settings.troopTrainerUrl },
    { label: "troopStableTrainerUrl", value: settings.troopStableTrainerUrl },
    { label: "troopPlans", value: `${troopPlans.listPlans().length} plan(s) — manage in menu T` },
    { label: "farmlistLoop", value: `${settings.farmlistLoopEnabled ? "ON" : "OFF"} (${settings.farmlistLoopMinMinutes}-${settings.farmlistLoopMaxMinutes} min)` },
    { label: "builderLoop", value: `${settings.builderLoopEnabled ? "ON" : "OFF"} (${settings.builderLoopMinMinutes}-${settings.builderLoopMaxMinutes} min)` },
    {
      label: "builderDefaultPlan",
      value: settings.builderDefaultPlanMode === "resource" ? "resource fields" : "village stage"
    },
    { label: "villageStatusUrl", value: settings.villageStatusUrl },
    { label: "selectAllSelector", value: settings.selectAllSelector },
    { label: "sendButtonSelector", value: settings.sendButtonSelector },
    { label: "builderGoldComplete", value: `${settings.builderGoldCompleteEnabled ? "ON" : "OFF"} (max ${settings.builderGoldCompleteMax}/run)` },
    { label: "builderMasterBuilder", value: settings.builderMasterBuilderEnabled ? "ON" : "OFF" },
    {
      label: "raidEvacuation",
      value:
        `${settings.raidEvacuationEnabled !== false ? "ON" : "OFF"} ` +
        `(trigger ${settings.raidEvacuationTriggerMinutes || 30}m, reserve ${settings.raidEvacuationReservePerResource || 300}, troops ${settings.raidEvacuationTroopsEnabled !== false ? "ON" : "OFF"}, recall ${settings.raidEvacuationTroopRecallSeconds || 60}s)`
    },
    {
      label: "raidPivotVillageIds",
      value: formatPivotVillageLabelsForSettings(settings, villageState && villageState.villages)
    },
    {
      label: "statusAfterFarmlists",
      value: `${settings.statusAfterFarmlistsEnabled ? "ON" : "OFF"} (${settings.statusAfterFarmlistsCooldownMinutes} min cooldown)`
    },
    {
      label: "roundRobinBuilder",
      value: settings.builderRoundRobinEnabled ? "ON" : "OFF"
    },
    {
      label: "builderRrExcludedVillages",
      value: (() => {
        const excludedCount = parsePivotVillageIdSet(settings.builderRoundRobinExcludedVillageIds).size;
        return excludedCount > 0 ? `${excludedCount} village(s)` : "none";
      })()
    },
    {
      label: "troopRoundRobinLoop",
      value: `${settings.troopTrainingRoundRobinEnabled ? "ON" : "OFF"} (${settings.troopTrainingLoopMinMinutes}-${settings.troopTrainingLoopMaxMinutes} min)`
    },
    {
      label: "crannyDefenseRoundRobin",
      value: `${settings.crannyDefenseRoundRobinEnabled ? "ON" : "OFF"} (${settings.crannyDefenseLoopMinMinutes}-${settings.crannyDefenseLoopMaxMinutes} min)`
    },
    {
      label: "expansionPlannedTargets",
      value: `${settings.expansionUsePlannedTargets ? "ON" : "OFF"} (${settings.expansionPlannedTargetsFile})`
    },
    {
      label: "expansionAutoDispatch",
      value: settings.expansionAutoDispatchEnabled ? "ON" : "OFF"
    },
    {
      label: "resourceCirculation",
      value: `${settings.resourceCirculationEnabled ? "ON" : "OFF"} (≤${Math.round(
        (settings.resourceCirculationReceiverMaxFillRatio || 0.8) * 100
      )}% store fill)`
    },
    {
      label: "resourceCirculationExpansion",
      value: settings.resourceCirculationExpansionEnabled ? "ON" : "OFF"
    }
  ]);
}

function printSettingsMenu(settings, villageState) {
  printSubDivider("SETTINGS MENU");
  const compact = isCompactDisplay(settings);
  const onOff = (v) => v ? color("ON", ANSI.bold, ANSI.green) : color("OFF", ANSI.bold, ANSI.yellow);
  const val = (v) => color(v, ANSI.bold, ANSI.white);
  const dim = (v) => color(v, ANSI.gray);
  const section = (title) => console.log(`  ${color(title, ANSI.bold, ANSI.magenta)}`);
  const gap = () => {
    if (!compact) {
      console.log();
    }
  };
  const tag = (label, value) => label
    ? `${dim("[")}${dim(label)} ${val(value)}${dim("]")}`
    : `${dim("[")}${val(value)}${dim("]")}`;

  const opt = (n) => color(`[${n}]`, ANSI.bold, ANSI.cyan);

  section("General");
  console.log(
    `  ${opt("1")}  Browser Mode       ${tag("", settings.headless ? "Headless" : "Full")}`
  );
  console.log(
    `  ${opt("2")}  Random Delay       ${tag("", `${settings.randomDelayMinMs}-${settings.randomDelayMaxMs}ms`)}`
  );
  console.log(
    `  ${opt("3")}  Pause Auto-Unpause ${tag("after", `${settings.manualPauseAutoUnpauseMinutes || 5}m`)}`
  );
  console.log(
    `  ${opt("Y")}  Proxy              ${tag("", formatProxyDisplay(settings))}`
  );
  console.log(
    `  ${opt("4")}  Activity Simulation ${dim("[")}${onOff(settings.activitySimulationEnabled)}${dim("]")}  ${tag("every", `${settings.activitySimulationLoopMinMinutes}-${settings.activitySimulationLoopMaxMinutes}m`)}`
  );
  console.log(
    `  ${opt("O")}  Top 10 Tracking    ${dim("[")}${onOff(settings.top10TrackingEnabled)}${dim("]")}  ${tag("every", `${settings.top10TrackingLoopMinMinutes}-${settings.top10TrackingLoopMaxMinutes}m`)}  ${tag("log", settings.top10TrackingLogFile || DEFAULT_TOP10_LOG_FILE)}`
  );
  console.log(
    `  ${opt("D")}  Compact UI           ${tag("", settings.dashboardCompactView ? "Compact view" : "Full view")}`
  );
  gap();

  section("Session and Farm");
  console.log(
    `  ${opt("5")}  Session Loop       ${dim("[")}${onOff(settings.sessionLoopEnabled)}${dim("]")}  ${tag("play", `${settings.playMinMinutes}-${settings.playMaxMinutes}m`)} ${tag("rest", `${settings.restMinMinutes}-${settings.restMaxMinutes}m`)}`
  );
  console.log(
    `  ${opt("6")}  Farmlist Loop      ${dim("[")}${onOff(settings.farmlistLoopEnabled)}${dim("]")}  ${tag("every", `${settings.farmlistLoopMinMinutes}-${settings.farmlistLoopMaxMinutes}m`)}`
  );
  console.log(
    `  ${opt("7")}  Post-Farm Status   ${dim("[")}${onOff(settings.statusAfterFarmlistsEnabled)}${dim("]")}  ${tag("cd", `${settings.statusAfterFarmlistsCooldownMinutes}m`)}`
  );
  gap();

  section("Builder");
  console.log(
    `  ${opt("G")}  Gold Complete      ${dim("[")}${onOff(settings.builderGoldCompleteEnabled)}${dim("]")}  ${tag("max", `${settings.builderGoldCompleteMax}/run`)}`
  );
  console.log(
    `  ${opt("BL")}  Builder Loop        ${dim("[")}${onOff(settings.builderLoopEnabled)}${dim("]")}  ${tag("every", `${settings.builderLoopMinMinutes}-${settings.builderLoopMaxMinutes}m`)}`
  );
  console.log(
    `  ${opt("BR")}  Builder RR          ${dim("[")}${onOff(settings.builderRoundRobinEnabled)}${dim("]")}`
  );
  console.log(
    `  ${opt("X")}  Builder RR Exclusion ${tag(
      "count",
      `${parsePivotVillageIdSet(settings.builderRoundRobinExcludedVillageIds).size}`
    )}`
  );
  console.log(
    `  ${opt("M")}  Master Builder      ${dim("[")}${onOff(settings.builderMasterBuilderEnabled)}${dim("]")}`
  );
  console.log(
    `  ${opt("R")}  Resource Circulation ${dim("[")}${onOff(settings.resourceCirculationEnabled)}${dim("]")}`
  );
  gap();

  section("Troops and Defense");
  console.log(
    `  ${opt("T")}  Troop RR Loop      ${dim("[")}${onOff(settings.troopTrainingRoundRobinEnabled)}${dim("]")}  ${tag("every", `${settings.troopTrainingLoopMinMinutes}-${settings.troopTrainingLoopMaxMinutes}m`)}`
  );
  console.log(
    `  ${opt("U")}  Troop Plans        ${tag("manage", "plans + village assignment")}`
  );
  console.log(
    `  ${opt("I")}  Cranny RR          ${dim("[")}${onOff(settings.crannyDefenseRoundRobinEnabled)}${dim("]")}  ${tag("every", `${settings.crannyDefenseLoopMinMinutes}-${settings.crannyDefenseLoopMaxMinutes}m`)}`
  );
  gap();

  section("Raid Evac");
  console.log(
    `  ${opt("E")}  Raid Evacuation    ${dim("[")}${onOff(settings.raidEvacuationEnabled !== false)}${dim("]")}  ${tag("trigger", `${settings.raidEvacuationTriggerMinutes || 30}m`)}`
  );
  console.log(
    `  ${opt("K")}  Troop Evacuation   ${dim("[")}${onOff(settings.raidEvacuationTroopsEnabled !== false)}${dim("]")}  ${tag("after", `${settings.raidEvacuationTroopRecallSeconds || 60}s`)}`
  );
  console.log(
    `  ${opt("H")}  Pivot Villages     ${tag(
      "to",
      formatPivotVillageLabelsForSettings(settings, villageState && villageState.villages)
    )}`
  );
  gap();

  section("Expansion");
  console.log(
    `  ${opt("A")}  Planned Targets    ${dim("[")}${onOff(settings.expansionUsePlannedTargets)}${dim("]")}`
  );
  console.log(
  `  ${opt("W")}  Auto Dispatch       ${dim("[")}${onOff(settings.expansionAutoDispatchEnabled)}${dim("]")}`
  );
  console.log(
    `  ${opt("P")}  Targets File       ${tag("file", settings.expansionPlannedTargetsFile)}`
  );
  console.log(
    `  ${opt("V")}  Settler Circulation ${dim("[")}${onOff(settings.resourceCirculationExpansionEnabled)}${dim(
      "]"
    )}`
  );
  gap();
  section("Navigation");
  console.log(`  ${opt("B")}  Back`);
  console.log(`  ${opt("Q")}  Quit`);
}

function parsePivotVillageIdSet(csv) {
  const s = new Set();
  String(csv || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const n = Number(part);
      if (Number.isFinite(n)) {
        s.add(n);
      }
    });
  return s;
}

function formatPivotCsvFromSet(selected) {
  return Array.from(selected)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .join(",");
}

function formatPivotVillageLabelsForSettings(settings, villages) {
  const list = Array.isArray(villages) ? villages : [];
  const set = parsePivotVillageIdSet(settings && settings.raidEvacuationPivotVillageIds);
  if (!set.size) {
    return "auto (capital)";
  }
  const ids = Array.from(set);
  const labels = ids
    .map((id) => list.find((v) => Number(v.id) === Number(id)) || null)
    .map((v, idx) => (v ? villageDisplayName(v) : `vid=${ids[idx]}`))
    .filter(Boolean);
  return labels.length ? labels.join("; ") : String(settings.raidEvacuationPivotVillageIds || "auto");
}

function formatVillageLabelsFromIdCsv(csv, villages, emptyLabel = "none") {
  const list = Array.isArray(villages) ? villages : [];
  const set = parsePivotVillageIdSet(csv);
  if (!set.size) {
    return String(emptyLabel || "none");
  }
  const ids = Array.from(set);
  const labels = ids
    .map((id) => list.find((v) => Number(v.id) === Number(id)) || null)
    .map((v, idx) => (v ? villageDisplayName(v) : `vid=${ids[idx]}`))
    .filter(Boolean);
  return labels.length ? labels.join("; ") : String(csv || emptyLabel || "none");
}

function resolvePivotCsvTokensToVillageIds(csv, villages) {
  const villageList = Array.isArray(villages) ? villages : [];
  const villageIds = new Set(
    villageList
      .map((village) => Number(village && village.id))
      .filter((id) => Number.isFinite(id))
  );

  const resolvedIds = new Set();
  const invalidTokens = [];

  String(csv || "")
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const value = Number(part);
      if (!Number.isFinite(value)) {
        invalidTokens.push(part);
        return;
      }

      const integerValue = Math.trunc(value);
      if (villageIds.has(integerValue)) {
        resolvedIds.add(integerValue);
        return;
      }

      if (integerValue >= 1 && integerValue <= villageList.length) {
        const villageAtIndex = villageList[integerValue - 1];
        const mappedId = Number(villageAtIndex && villageAtIndex.id);
        if (Number.isFinite(mappedId)) {
          resolvedIds.add(mappedId);
          return;
        }
      }

      invalidTokens.push(part);
    });

  return { resolvedIds, invalidTokens };
}

/**
 * Same UX as main-menu village selector (V): numbered list, `[*` / `A]` markers,
 * `Select village number or B:`. A number sets that village as the sole pivot and saves;
 * A clears; M enters a CSV for multiple pivots.
 */
async function runRaidPivotVillageMenu(rl, settings, runtimeControls) {
  const refresh =
    runtimeControls && typeof runtimeControls.refreshSideInfoVillages === "function"
      ? runtimeControls.refreshSideInfoVillages
      : null;
  const getSnapshot =
    runtimeControls && typeof runtimeControls.getRaidPivotVillageUiState === "function"
      ? runtimeControls.getRaidPivotVillageUiState
      : null;

  const persistPivot = async (pivotSet) => {
    settings.raidEvacuationPivotVillageIds = pivotSet.size ? formatPivotCsvFromSet(pivotSet) : "";
    if (runtimeControls.persistSettings) {
      await runtimeControls.persistSettings(["RAID_EVACUATION_PIVOT_VILLAGE_IDS"]);
    }
  };

  if (refresh) {
    try {
      await refresh();
    } catch (_error) {
      logWarn("Could not refresh village list from game (session busy?).");
    }
  }

  let pivotSet = parsePivotVillageIdSet(settings.raidEvacuationPivotVillageIds);

  let pivotMenuDone = false;
  while (!pivotMenuDone) {
    const snapshot =
      typeof getSnapshot === "function"
        ? getSnapshot()
        : { villages: [], selectedVillageId: null, activeVillageId: null };
    const villages = Array.isArray(snapshot.villages) ? snapshot.villages : [];

    printRaidPivotVillageSheet(snapshot, pivotSet);

    if (!villages.length) {
      logWarn("No villages detected.");
    }

    const answer = (await askQuestion(rl, "Select village number or B: ")).trim().toUpperCase();

    if (answer === "B") {
      pivotMenuDone = true;
      continue;
    }

    if (answer === "A") {
      pivotSet = new Set();
      await persistPivot(pivotSet);
      logSuccess(`Pivot villages: ${settings.raidEvacuationPivotVillageIds || "auto (capital)"}`);
      continue;
    }

    if (answer === "M") {
      const typed = (await askQuestion(rl, "Pivot village IDs (CSV), or empty for auto: ")).trim();
      if (!typed) {
        pivotSet = new Set();
      } else {
        const { resolvedIds, invalidTokens } = resolvePivotCsvTokensToVillageIds(typed, villages);
        const nextSet = new Set(pivotSet);

        resolvedIds.forEach((id) => {
          if (nextSet.has(id)) {
            nextSet.delete(id);
          } else {
            nextSet.add(id);
          }
        });
        pivotSet = nextSet;

        if (invalidTokens.length) {
          logWarn(
            `Ignored unknown entries: ${invalidTokens.join(", ")}. Use village row numbers or existing village IDs.`
          );
        }
      }
      await persistPivot(pivotSet);
      logSuccess(`Pivot villages: ${settings.raidEvacuationPivotVillageIds || "auto (capital)"}`);
      continue;
    }

    const index = Number(answer);
    if (!Number.isFinite(index) || index < 1 || index > villages.length) {
      logWarn("Invalid selection. Enter a listed number, A, M, or B.");
      continue;
    }

    const nextVillage = villages[index - 1];
    pivotSet = new Set([Number(nextVillage.id)]);
    await persistPivot(pivotSet);
    logSuccess(`Pivot village: ${villageDisplayName(nextVillage)}`);
  }
}

async function runBuilderRrExclusionMenu(rl, settings, runtimeControls) {
  const refresh =
    runtimeControls && typeof runtimeControls.refreshSideInfoVillages === "function"
      ? runtimeControls.refreshSideInfoVillages
      : null;
  const getSnapshot =
    runtimeControls && typeof runtimeControls.getRaidPivotVillageUiState === "function"
      ? runtimeControls.getRaidPivotVillageUiState
      : null;

  const persistExcludedSet = async (excludedSet) => {
    settings.builderRoundRobinExcludedVillageIds = excludedSet.size
      ? formatPivotCsvFromSet(excludedSet)
      : "";
    if (runtimeControls.persistSettings) {
      await runtimeControls.persistSettings(["BUILDER_RR_EXCLUDED_VILLAGE_IDS"]);
    }
  };

  if (refresh) {
    try {
      await refresh();
    } catch (_error) {
      logWarn("Could not refresh village list from game (session busy?).");
    }
  }

  let excludedSet = parsePivotVillageIdSet(settings.builderRoundRobinExcludedVillageIds);
  let done = false;
  while (!done) {
    if (runtimeControls.menuSession?.quitRequested) {
      done = true;
      continue;
    }
    const snapshot =
      typeof getSnapshot === "function"
        ? getSnapshot()
        : { villages: [], selectedVillageId: null, activeVillageId: null };
    const villages = Array.isArray(snapshot.villages) ? snapshot.villages : [];
    printBuilderRrExclusionSheet(snapshot, excludedSet);

    if (!villages.length) {
      logWarn("No villages detected.");
    }

    const answer = (await askQuestion(rl, "Toggle village number, or A/M/B: ")).trim().toUpperCase();
    if (answer === "Q") {
      if (runtimeControls.menuSession) {
        runtimeControls.menuSession.quitRequested = true;
      }
      done = true;
      continue;
    }
    if (answer === "B") {
      done = true;
      continue;
    }
    if (answer === "A") {
      excludedSet = new Set();
      await persistExcludedSet(excludedSet);
      logSuccess("Builder RR exclusions cleared.");
      continue;
    }
    if (answer === "M") {
      const typed = (await askQuestion(rl, "Exclude villages CSV (rows/vids), empty to clear: ")).trim();
      if (!typed) {
        excludedSet = new Set();
      } else {
        const { resolvedIds, invalidTokens } = resolvePivotCsvTokensToVillageIds(typed, villages);
        excludedSet = new Set(resolvedIds);
        if (invalidTokens.length) {
          logWarn(
            `Ignored unknown entries: ${invalidTokens.join(", ")}. Use village row numbers or existing village IDs.`
          );
        }
      }
      await persistExcludedSet(excludedSet);
      logSuccess(
        `Builder RR exclusions: ${formatVillageLabelsFromIdCsv(
          settings.builderRoundRobinExcludedVillageIds,
          villages,
          "none"
        )}`
      );
      continue;
    }

    const index = Number(answer);
    if (!Number.isFinite(index) || index < 1 || index > villages.length) {
      logWarn("Invalid selection. Enter a listed number, A, M, or B.");
      continue;
    }

    const village = villages[index - 1];
    const vid = Number(village && village.id);
    if (!Number.isFinite(vid)) {
      logWarn("Selected village has invalid id.");
      continue;
    }
    if (excludedSet.has(vid)) {
      excludedSet.delete(vid);
      await persistExcludedSet(excludedSet);
      logSuccess(`RR enabled for ${villageDisplayName(village)}.`);
    } else {
      excludedSet.add(vid);
      await persistExcludedSet(excludedSet);
      logSuccess(`RR excluded for ${villageDisplayName(village)}.`);
    }
  }
}

function printTroopPlansMenu(settings, plans) {
  printSubDivider("TROOP PLANS");
  console.log(`  ${color(`Engine v${APP_VERSION}`, ANSI.gray)} — Barracks, Great Barracks, Stable, Great Stable per plan`);
  const rrLabel = settings.troopTrainingRoundRobinEnabled ? "ON" : "OFF";
  console.log(
    `  ${color("Auto-train loop:", ANSI.gray)} ${color(rrLabel, ANSI.bold, settings.troopTrainingRoundRobinEnabled ? ANSI.green : ANSI.yellow)} ${color(`(default ${settings.troopTrainingLoopMinMinutes}-${settings.troopTrainingLoopMaxMinutes} min)`, ANSI.gray)}`
  );
  console.log("");
  if (!plans.length) {
    console.log(`  ${color("(no plans yet — press N to create one)", ANSI.gray)}`);
  } else {
    plans.forEach((plan, index) => {
      console.log(
        `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${color(plan.name, ANSI.bold)}  ${color(troopPlans.describePlan(plan), ANSI.gray)}`
      );
    });
  }
  console.log("");
  console.log(`  ${color("[N]", ANSI.bold, ANSI.cyan)}  New plan`);
  console.log(`  ${color("[E]", ANSI.bold, ANSI.cyan)}  Edit plan`);
  console.log(`  ${color("[X]", ANSI.bold, ANSI.cyan)}  Delete plan`);
  console.log(`  ${color("[V]", ANSI.bold, ANSI.cyan)}  Assign villages to plans`);
  console.log(`  ${color("[U]", ANSI.bold, ANSI.cyan)}  Show trainable unit names from a village`);
  console.log(`  ${color("[L]", ANSI.bold, ANSI.cyan)}  Toggle auto-train loop + default interval`);
  console.log(`  ${color("[B]", ANSI.bold, ANSI.cyan)}  Back`);
}

async function promptTroopPlanFields(rl, currentPlan) {
  const isNew = !currentPlan;
  const cur = currentPlan || {};
  const branches = troopPlans.PLAN_BRANCHES;

  const askKeep = async (label, currentValue) => {
    const shown = currentValue !== undefined && currentValue !== null && String(currentValue) !== ""
      ? ` (Enter keep: ${currentValue})`
      : isNew
        ? ""
        : " (Enter keep: none)";
    return (await askQuestion(rl, `${label}${shown}: `)).trim();
  };

  printSubDivider(isNew ? "NEW PLAN — BUILDINGS" : `EDIT PLAN — ${cur.name || "?"}`);
  console.log(
    `  ${color("Set each building separately (blank = skip that building):", ANSI.gray)}`
  );
  branches.forEach((branch, index) => {
    const unit = String(cur[branch.unitField] || "").trim();
    const qty = cur[branch.qtyField];
    const current = unit ? `${unit} x${qty}` : "—";
    console.log(
      `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${branch.label}  ${color(current, ANSI.gray)}`
    );
  });
  console.log("");

  const patch = {};

  for (let index = 0; index < branches.length; index++) {
    const branch = branches[index];
    const step = `[${index + 1}/${branches.length}] ${branch.label}`;
    const unit = await askKeep(`${step} — unit name (blank = none)`, cur[branch.unitField]);
    if (unit !== "" || isNew) {
      patch[branch.unitField] = unit;
    }
    if (patch[branch.unitField] || cur[branch.unitField]) {
      const qty = await askKeep(`${step} — qty per train`, cur[branch.qtyField]);
      if (qty !== "") {
        patch[branch.qtyField] = qty;
      }
    }
  }

  const minM = await askKeep("Timer MIN minutes", cur.minMinutes);
  if (minM !== "") {
    patch.minMinutes = minM;
  }
  const maxM = await askKeep("Timer MAX minutes", cur.maxMinutes);
  if (maxM !== "") {
    patch.maxMinutes = maxM;
  }

  return patch;
}

async function runTroopPlanAssignMenu(rl, hooks) {
  const getSnapshot =
    typeof hooks.getSnapshot === "function"
      ? hooks.getSnapshot
      : () => ({ villages: [] });

  if (typeof hooks.refreshVillages === "function") {
    try {
      await hooks.refreshVillages();
    } catch (_error) {
      logWarn("Could not refresh village list (session busy?).");
    }
  }

  let done = false;
  while (!done) {
    if (hooks.menuSession && hooks.menuSession.quitRequested) {
      done = true;
      continue;
    }
    const plans = troopPlans.listPlans();
    const snapshot = getSnapshot();
    const villages = Array.isArray(snapshot.villages) ? snapshot.villages : [];

    printSubDivider("TROOP — ASSIGN VILLAGES");
    if (!plans.length) {
      console.log(`  ${color("(no plans yet — create one first)", ANSI.gray)}`);
      return;
    }
    if (!villages.length) {
      console.log(`  ${color("(no villages loaded — open main menu V first)", ANSI.gray)}`);
    }
    villages.forEach((village, index) => {
      const assignment = troopPlans.getAssignment(village);
      const active = troopPlans.resolvePlanForVillage(village);
      const planLabel = assignment && assignment.plan ? assignment.plan : "—";
      const stateLabel = active
        ? color("ON", ANSI.bold, ANSI.green)
        : assignment && assignment.plan
          ? color("off", ANSI.gray)
          : color("—", ANSI.gray);
      console.log(
        `  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${stateLabel} ${villageDisplayName(village)}  ${color(`plan: ${planLabel}`, ANSI.gray)}`
      );
    });
    console.log("");
    console.log(
      `  ${color("Pick", ANSI.bold, ANSI.cyan)} village number  ${color("B", ANSI.bold, ANSI.cyan)} back`
    );

    const answer = (await askQuestion(rl, "Village: ")).trim().toUpperCase();
    if (answer === "B") {
      done = true;
      continue;
    }
    if (answer === "Q") {
      if (hooks.menuSession) {
        hooks.menuSession.quitRequested = true;
      }
      done = true;
      continue;
    }
    const index = Number(answer);
    if (!Number.isFinite(index) || index < 1 || index > villages.length) {
      logWarn("Invalid selection. Enter a village number or B.");
      continue;
    }
    const village = villages[index - 1];

    printSubDivider(`ASSIGN — ${villageDisplayName(village)}`);
    plans.forEach((plan, i) => {
      console.log(`  ${color(String(i + 1), ANSI.bold, ANSI.cyan)} ${plan.name}  ${color(troopPlans.describePlan(plan), ANSI.gray)}`);
    });
    console.log("");
    console.log(`  ${color("[T]", ANSI.bold, ANSI.cyan)}  Toggle on/off   ${color("[U]", ANSI.bold, ANSI.cyan)}  Unassign   ${color("[B]", ANSI.bold, ANSI.cyan)}  Back`);
    const pick = (await askQuestion(rl, "Assign plan number / T / U: ")).trim().toUpperCase();

    if (pick === "B" || pick === "") {
      continue;
    }
    if (pick === "U") {
      troopPlans.clearAssignment(village);
      logSuccess(`Unassigned ${villageDisplayName(village)}.`);
      if (typeof hooks.onAssignmentChanged === "function") {
        hooks.onAssignmentChanged(village);
      }
      continue;
    }
    if (pick === "T") {
      const assignment = troopPlans.getAssignment(village);
      if (!assignment || !assignment.plan) {
        logWarn("Assign a plan first, then toggle.");
        continue;
      }
      const next = troopPlans.setAssignment(village, { enabled: assignment.enabled === false });
      logSuccess(`${villageDisplayName(village)} auto-train ${next.enabled ? "ON" : "OFF"}.`);
      if (typeof hooks.onAssignmentChanged === "function") {
        hooks.onAssignmentChanged(village);
      }
      continue;
    }
    const planIndex = Number(pick);
    if (!Number.isFinite(planIndex) || planIndex < 1 || planIndex > plans.length) {
      logWarn("Invalid plan selection.");
      continue;
    }
    const chosenPlan = plans[planIndex - 1];
    troopPlans.setAssignment(village, { plan: chosenPlan.name, enabled: true });
    logSuccess(`${villageDisplayName(village)} → plan "${chosenPlan.name}" (auto-train ON).`);
    if (typeof hooks.onAssignmentChanged === "function") {
      hooks.onAssignmentChanged(village);
    }
  }
}

async function showTrainableUnitsFromVillage(rl, hooks) {
  if (typeof hooks.listTrainableUnits !== "function") {
    logWarn("Unit preview is not available in this runtime.");
    return;
  }
  const getSnapshot =
    typeof hooks.getSnapshot === "function" ? hooks.getSnapshot : () => ({ villages: [] });
  const villages = Array.isArray(getSnapshot().villages) ? getSnapshot().villages : [];
  if (!villages.length) {
    logWarn("No villages loaded — open main menu V first.");
    return;
  }
  printSubDivider("SHOW TRAINABLE UNITS");
  villages.forEach((village, index) => {
    console.log(`  ${color(String(index + 1), ANSI.bold, ANSI.cyan)} ${villageDisplayName(village)}`);
  });
  const answer = (await askQuestion(rl, "Village number (B to cancel): ")).trim().toUpperCase();
  if (answer === "B" || answer === "") {
    return;
  }
  const index = Number(answer);
  if (!Number.isFinite(index) || index < 1 || index > villages.length) {
    logWarn("Invalid selection.");
    return;
  }
  const village = villages[index - 1];
  logInfo(`Reading trainable units from ${villageDisplayName(village)}…`);
  try {
    const rows = [];
    for (const branch of troopPlans.PLAN_BRANCHES) {
      const data = await hooks.listTrainableUnits(village, branch.building);
      rows.push({
        label: branch.label,
        value: data.missingBuilding
          ? `(no ${branch.label.toLowerCase()})`
          : data.units.join(", ") || "(none)"
      });
    }
    printKeyValueRows(rows);
  } catch (error) {
    logWarn(`Could not read units: ${error.message || error}`);
  }
}

async function runTroopPlansMenu(rl, settings, runtimeControls, hooks = {}) {
  let done = false;
  while (!done) {
    if (hooks.menuSession && hooks.menuSession.quitRequested) {
      done = true;
      continue;
    }
    const plans = troopPlans.listPlans();
    printTroopPlansMenu(settings, plans);
    const input = (await askQuestion(rl, "Troop plans option: ")).trim().toUpperCase();

    if (input === "Q") {
      if (hooks.menuSession) {
        hooks.menuSession.quitRequested = true;
      }
      if (typeof hooks.requestQuit === "function") {
        hooks.requestQuit();
      }
      done = true;
      continue;
    }
    if (input === "B" || input === "") {
      done = true;
      continue;
    }

    if (input === "N") {
      const name = (await askQuestion(rl, "New plan name: ")).trim();
      if (!name) {
        logWarn("Plan name required.");
        continue;
      }
      if (troopPlans.getPlan(name)) {
        logWarn(`Plan "${name}" already exists — use Edit.`);
        continue;
      }
      const patch = await promptTroopPlanFields(rl, null);
      const saved = troopPlans.upsertPlan(name, patch);
      logSuccess(`Created plan "${saved.name}" — ${troopPlans.describePlan(saved)}.`);
      if (typeof hooks.onPlansChanged === "function") {
        hooks.onPlansChanged();
      }
      continue;
    }

    if (input === "E") {
      if (!plans.length) {
        logWarn("No plans to edit.");
        continue;
      }
      const pick = (await askQuestion(rl, "Edit plan number: ")).trim();
      const i = Number(pick);
      if (!Number.isFinite(i) || i < 1 || i > plans.length) {
        logWarn("Invalid plan number.");
        continue;
      }
      const plan = plans[i - 1];
      const patch = await promptTroopPlanFields(rl, plan);
      const saved = troopPlans.upsertPlan(plan.name, patch);
      logSuccess(`Updated "${saved.name}" — ${troopPlans.describePlan(saved)}.`);
      if (typeof hooks.onPlansChanged === "function") {
        hooks.onPlansChanged();
      }
      continue;
    }

    if (input === "X") {
      if (!plans.length) {
        logWarn("No plans to delete.");
        continue;
      }
      const pick = (await askQuestion(rl, "Delete plan number: ")).trim();
      const i = Number(pick);
      if (!Number.isFinite(i) || i < 1 || i > plans.length) {
        logWarn("Invalid plan number.");
        continue;
      }
      const plan = plans[i - 1];
      const confirm = (await askQuestion(rl, `Delete "${plan.name}" and unassign its villages? (Y/N): `)).trim().toUpperCase();
      if (confirm === "Y") {
        troopPlans.deletePlan(plan.name);
        logSuccess(`Deleted plan "${plan.name}".`);
        if (typeof hooks.onPlansChanged === "function") {
          hooks.onPlansChanged();
        }
      }
      continue;
    }

    if (input === "V") {
      await runTroopPlanAssignMenu(rl, hooks);
      continue;
    }

    if (input === "U") {
      await showTrainableUnitsFromVillage(rl, hooks);
      continue;
    }

    if (input === "L") {
      const enabledText = (await askQuestion(rl, "Enable auto-train loop? (Y/N, Enter keep): ")).trim().toUpperCase();
      let nextEnabled = settings.troopTrainingRoundRobinEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }
      const nextMinText = (await askQuestion(rl, "Default MIN minutes (Enter keep): ")).trim();
      const nextMaxText = (await askQuestion(rl, "Default MAX minutes (Enter keep): ")).trim();
      if (!runtimeControls.updateTroopTrainingLoopConfig) {
        logWarn("Troop loop update is not available in this runtime.");
        continue;
      }
      try {
        const applied = await runtimeControls.updateTroopTrainingLoopConfig({
          enabled: nextEnabled,
          minMinutes: nextMinText ? Number(nextMinText) : settings.troopTrainingLoopMinMinutes,
          maxMinutes: nextMaxText ? Number(nextMaxText) : settings.troopTrainingLoopMaxMinutes
        });
        settings.troopTrainingRoundRobinEnabled = applied.enabled;
        settings.troopTrainingLoopMinMinutes = applied.minMinutes;
        settings.troopTrainingLoopMaxMinutes = applied.maxMinutes;
        if (typeof hooks.onPlansChanged === "function") {
          hooks.onPlansChanged();
        }
        logSuccess(
          `Auto-train loop ${applied.enabled ? "ON" : "OFF"}, default ${applied.minMinutes}-${applied.maxMinutes} min (plans can override).`
        );
      } catch (error) {
        logError(`Failed to update troop loop: ${error.message || error}`);
      }
      continue;
    }

    logWarn("Unknown option. Use N, E, X, V, U, L, or B.");
  }
}

async function readMultilineUntilBlank(rl, intro) {
  console.log(intro);
  const lines = [];
  while (true) {
    const line = await askQuestion(rl, lines.length ? "> " : "> ");
    if (!String(line || "").trim()) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

async function runProxySettingsMenu(rl, settings, runtimeControls) {
  const getDisplay = () =>
    typeof runtimeControls.getProxyDisplay === "function"
      ? runtimeControls.getProxyDisplay()
      : formatProxyDisplay(settings, proxyPool.loadStore());

  const askKeep = async (label, currentValue, secret = false) => {
    const shown =
      currentValue !== undefined && currentValue !== null && String(currentValue) !== ""
        ? secret
          ? " (Enter keep: ****)"
          : ` (Enter keep: ${currentValue})`
        : " (Enter keep: none)";
    return (await askQuestion(rl, `${label}${shown}: `)).trim();
  };

  const renderProxyList = () => {
    const store = proxyPool.loadStore();
    if (!store.proxies.length) {
      console.log(`  ${color("(no proxies in pool — paste with [2])", ANSI.gray)}`);
      return;
    }
    store.proxies.forEach((entry, index) => {
      const active = index === store.activeIndex;
      console.log(
        `  ${color(String(index + 1), ANSI.bold, active ? ANSI.green : ANSI.cyan)} ${proxyPool.formatProxyEntryLabel(entry, index, active)}`
      );
    });
  };

  let done = false;
  while (!done) {
    if (runtimeControls.menuSession?.quitRequested) {
      done = true;
      continue;
    }

    printSubDivider("PROXY POOL");
    console.log(`  ${color("Active", ANSI.gray)}: ${color(getDisplay(), ANSI.bold, ANSI.white)}`);
    renderProxyList();
    console.log("");
    console.log(
      `  ${color("Formats", ANSI.gray)}: host:port:user:pass · user:pass@host:port · http://user:pass@host:port`
    );
    console.log("");
    console.log(`  ${color("[1]", ANSI.bold, ANSI.cyan)}  Edit single active proxy fields`);
    console.log(`  ${color("[2]", ANSI.bold, ANSI.cyan)}  Paste proxy list (one per line, blank line to finish)`);
    console.log(`  ${color("[3]", ANSI.bold, ANSI.cyan)}  Pick active proxy by number`);
    console.log(`  ${color("[A]", ANSI.bold, ANSI.cyan)}  Apply active proxy + logout/relogin`);
    console.log(`  ${color("[N]", ANSI.bold, ANSI.cyan)}  Next proxy in list + logout/relogin`);
    console.log(`  ${color("[D]", ANSI.bold, ANSI.cyan)}  Disable proxy + relogin direct`);
    console.log(`  ${color("[B]", ANSI.bold, ANSI.cyan)}  Back`);

    const pick = (await askQuestion(rl, "Proxy option: ")).trim().toUpperCase();
    if (pick === "B" || pick === "") {
      done = true;
      continue;
    }
    if (pick === "Q") {
      if (runtimeControls.menuSession) {
        runtimeControls.menuSession.quitRequested = true;
      }
      done = true;
      continue;
    }

    if (pick === "2") {
      const text = await readMultilineUntilBlank(
        rl,
        "Paste proxies (one per line). End with a blank line:"
      );
      if (!text.trim()) {
        logWarn("No proxy lines pasted.");
        continue;
      }
      const parsed = proxyPool.parseProxyListText(text);
      if (!parsed.length) {
        logWarn("Could not parse any proxies from pasted text.");
        continue;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ proxyText: text, action: "save" });
        } else {
          const store = proxyPool.loadStore();
          store.proxies = parsed;
          store.activeIndex = 0;
          proxyPool.saveStore(store);
          proxyPool.applyActiveToSettings(settings, store);
        }
        logSuccess(`Saved ${parsed.length} proxy/proxies. Active: #1. Pick [A] to relogin.`);
      } catch (error) {
        logError(`Could not save proxy list: ${error.message || error}`);
      }
      continue;
    }

    if (pick === "3") {
      const store = proxyPool.loadStore();
      if (!store.proxies.length) {
        logWarn("No proxies in pool. Paste with [2] first.");
        continue;
      }
      const answer = (await askQuestion(rl, `Active proxy number (1-${store.proxies.length}): `)).trim();
      const index = Number(answer);
      if (!Number.isFinite(index) || index < 1 || index > store.proxies.length) {
        logWarn("Invalid proxy number.");
        continue;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ activeIndex: index - 1, action: "save" });
        } else {
          proxyPool.setActiveIndex(store, index - 1);
          proxyPool.saveStore(store);
          proxyPool.applyActiveToSettings(settings, store);
        }
        logSuccess(`Active proxy set to #${index} (${getDisplay()}). Pick [A] to relogin.`);
      } catch (error) {
        logError(`Could not set active proxy: ${error.message || error}`);
      }
      continue;
    }

    if (pick === "1") {
      const server = (await askKeep("Proxy server (type direct to disable)", settings.proxyServer)).trim();
      const patch = {};
      if (/^(direct|none|-)$/i.test(server)) {
        patch.server = "";
      } else if (server !== "") {
        patch.server = normalizeProxyServer(server);
      }
      const username = (await askKeep("Proxy username", settings.proxyUsername)).trim();
      if (username !== "") {
        patch.username = username;
      }
      const password = await askKeep("Proxy password", settings.proxyPassword, true);
      if (password !== "" && password !== "********") {
        patch.password = password;
      }
      const bypass = (await askKeep("Proxy bypass hosts (comma-separated)", settings.proxyBypass)).trim();
      if (bypass !== "") {
        patch.bypass = bypass;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ ...patch, action: "save" });
        } else if (runtimeControls.changeProxyAndRelogin) {
          await runtimeControls.changeProxyAndRelogin(patch, "proxy_edit");
        }
        logSuccess(`Proxy fields updated (${getDisplay()}). Pick [A] to relogin.`);
      } catch (error) {
        logError(`Proxy update failed: ${error.message || error}`);
      }
      continue;
    }

    if (pick === "N") {
      if (!runtimeControls.updateProxySettings && !runtimeControls.changeProxyAndRelogin) {
        logWarn("Proxy control is unavailable in this runtime.");
        continue;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ action: "next" });
        } else {
          await runtimeControls.changeProxyAndRelogin({ action: "next" }, "proxy_next");
        }
        logSuccess(`Next proxy active (${getDisplay()}). Re-login complete.`);
      } catch (error) {
        logError(`Proxy rotation failed: ${error.message || error}`);
      }
      done = true;
      continue;
    }

    if (pick === "D") {
      const confirm = (await askQuestion(rl, "Disable proxy and relogin direct? (Y/N): ")).trim().toUpperCase();
      if (confirm !== "Y") {
        continue;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ action: "disable" });
        } else if (runtimeControls.changeProxyAndRelogin) {
          await runtimeControls.changeProxyAndRelogin(
            { server: "", username: "", password: "", bypass: "" },
            "proxy_disabled"
          );
        }
        logSuccess("Proxy disabled. Re-login complete — automation continues.");
      } catch (error) {
        logError(`Proxy change failed: ${error.message || error}`);
      }
      done = true;
      continue;
    }

    if (pick === "A") {
      const confirm = (await askQuestion(rl, `Logout and relogin via ${getDisplay()}? (Y/N): `))
        .trim()
        .toUpperCase();
      if (confirm !== "Y") {
        continue;
      }
      try {
        if (runtimeControls.updateProxySettings) {
          await runtimeControls.updateProxySettings({ action: "apply" });
        } else if (runtimeControls.changeProxyAndRelogin) {
          await runtimeControls.changeProxyAndRelogin({}, "proxy_change");
        }
        logSuccess("Proxy applied. Re-login complete — automation continues.");
      } catch (error) {
        logError(`Proxy change failed: ${error.message || error}`);
      }
      done = true;
      continue;
    }

    logWarn("Unknown option. Use 1, 2, 3, A, N, D, B, or Q.");
  }
}

async function runSettingsMenu(rl, settings, runtimeControls) {
  normalizeExpansionSettlementSettings(settings);
  const getVillageStateForUi = () => {
    if (!runtimeControls || typeof runtimeControls.getRaidPivotVillageUiState !== "function") {
      return null;
    }
    try {
      return runtimeControls.getRaidPivotVillageUiState() || null;
    } catch (_error) {
      return null;
    }
  };
  let done = false;
  while (!done) {
    if (runtimeControls.menuSession?.quitRequested) {
      done = true;
      continue;
    }
    const villageState = getVillageStateForUi();
    printSettings(settings, villageState);
    printSettingsMenu(settings, villageState);

    const input = (await askQuestion(rl, "Settings option: ")).trim().toUpperCase();

    if (input === "Q") {
      if (runtimeControls.menuSession) {
        runtimeControls.menuSession.quitRequested = true;
      }
      done = true;
      continue;
    }

    if (input === "1") {
      try {
        const isHeadless = await runtimeControls.toggleHeadlessMode();
        settings.headless = isHeadless;
        logSuccess(
          `Browser mode changed to: ${isHeadless ? "Headless" : "Full Browser"}`
        );
      } catch (error) {
        logError(`Failed to toggle browser mode: ${error.message || error}`);
      }
      continue;
    }

    if (input === "2") {
      const maybeMin = (
        await askQuestion(rl, "New random delay MIN in ms (Enter to keep): ")
      ).trim();
      if (maybeMin) {
        const parsed = Number(maybeMin);
        if (Number.isFinite(parsed) && parsed >= 0) {
          settings.randomDelayMinMs = parsed;
        } else {
          logWarn("Invalid min value. Keeping previous value.");
        }
      }

      const maybeMax = (
        await askQuestion(rl, "New random delay MAX in ms (Enter to keep): ")
      ).trim();
      if (maybeMax) {
        const parsed = Number(maybeMax);
        if (Number.isFinite(parsed) && parsed >= 0) {
          settings.randomDelayMaxMs = parsed;
        } else {
          logWarn("Invalid max value. Keeping previous value.");
        }
      }

      normalizeDelayRange(settings);
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "RANDOM_DELAY_MIN_MS",
          "RANDOM_DELAY_MAX_MS"
        ]);
      }
      logSuccess(
        `Random delay updated to ${settings.randomDelayMinMs}-${settings.randomDelayMaxMs}ms.`
      );
      continue;
    }

    if (input === "3") {
      const typed = (
        await askQuestion(rl, "Pause auto-unpause MINUTES (1-120, Enter keep): ")
      ).trim();
      if (!typed) {
        continue;
      }
      const n = Number(typed);
      if (!Number.isFinite(n)) {
        logWarn("Invalid number. Keeping previous value.");
        continue;
      }
      settings.manualPauseAutoUnpauseMinutes = Math.max(1, Math.min(120, Math.floor(n)));
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES"
        ]);
      }
      logSuccess(
        `Pause auto-unpause set to ${settings.manualPauseAutoUnpauseMinutes} minute(s).`
      );
      continue;
    }

    if (input === "Y") {
      await runProxySettingsMenu(rl, settings, runtimeControls);
      continue;
    }

    if (input === "4") {
      const enabledText = (
        await askQuestion(rl, "Enable activity simulation? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.activitySimulationEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Activity loop MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Activity loop MAX minutes (Enter keep): ")
      ).trim();
      const nextPatternsText = (
        await askQuestion(
          rl,
          `Browse patterns CSV (status,builder,troops,stable,reports,statistics — Enter keep): `
        )
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.activitySimulationLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.activitySimulationLoopMaxMinutes
      };
      if (nextPatternsText) {
        nextConfig.patterns = activitySimulation.parsePatterns(nextPatternsText);
      }

      try {
        if (!runtimeControls.updateActivitySimulationLoopConfig) {
          throw new Error("Activity simulation config is unavailable.");
        }
        const applied = await runtimeControls.updateActivitySimulationLoopConfig(nextConfig);
        settings.activitySimulationEnabled = applied.enabled;
        settings.activitySimulationLoopMinMinutes = applied.minMinutes;
        settings.activitySimulationLoopMaxMinutes = applied.maxMinutes;
        if (applied.patterns) {
          settings.activitySimulationPatterns = activitySimulation.serializePatterns(applied.patterns);
        }
        logSuccess(
          `Activity simulation: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes}m, patterns: ${activitySimulation.serializePatterns(applied.patterns || activitySimulation.parsePatterns(settings.activitySimulationPatterns))}.`
        );
      } catch (error) {
        logError(`Failed to update activity simulation: ${error.message || error}`);
      }

      continue;
    }

    if (input === "O") {
      const enabledText = (
        await askQuestion(rl, "Enable Top 10 tracking loop? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.top10TrackingEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Top 10 loop MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Top 10 loop MAX minutes (Enter keep): ")
      ).trim();
      const nextLogFileText = (
        await askQuestion(rl, `Top 10 log file (Enter keep ${settings.top10TrackingLogFile || DEFAULT_TOP10_LOG_FILE}): `)
      ).trim();
      const nextPlayerNameText = (
        await askQuestion(
          rl,
          `In-game player name for self-rank matching (Enter keep${settings.top10TrackingPlayerName ? ` ${settings.top10TrackingPlayerName}` : ", blank = auto-detect"}): `
        )
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.top10TrackingLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.top10TrackingLoopMaxMinutes
      };
      if (nextLogFileText) {
        nextConfig.logFile = nextLogFileText;
      }
      if (nextPlayerNameText) {
        nextConfig.playerName = nextPlayerNameText;
      }

      try {
        if (!runtimeControls.updateTop10TrackingLoopConfig) {
          throw new Error("Top 10 tracking config is unavailable.");
        }
        const applied = await runtimeControls.updateTop10TrackingLoopConfig(nextConfig);
        settings.top10TrackingEnabled = applied.enabled;
        settings.top10TrackingLoopMinMinutes = applied.minMinutes;
        settings.top10TrackingLoopMaxMinutes = applied.maxMinutes;
        settings.top10TrackingLogFile = applied.logFile;
        settings.top10TrackingPlayerName = applied.playerName;
        logSuccess(
          `Top 10 tracking: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes}m, log ${applied.logFile || DEFAULT_TOP10_LOG_FILE}.`
        );
      } catch (error) {
        logError(`Failed to update Top 10 tracking: ${error.message || error}`);
      }

      continue;
    }

    if (input === "D") {
      settings.dashboardCompactView = !settings.dashboardCompactView;
      try {
        if (runtimeControls.updateDashboardDisplayConfig) {
          await runtimeControls.updateDashboardDisplayConfig({
            compactView: settings.dashboardCompactView
          });
        } else if (runtimeControls.persistSettings) {
          await runtimeControls.persistSettings(["DASHBOARD_COMPACT_VIEW"]);
        }
        logSuccess(
          `Compact UI: ${settings.dashboardCompactView ? "ON" : "OFF"} (web dashboard + terminal menus).`
        );
        if (settings.dashboardCompactView && runtimeControls.dashboardPort) {
          logInfo(`[Dashboard] Open http://127.0.0.1:${runtimeControls.dashboardPort} for compact web UI.`);
        }
      } catch (error) {
        logError(`Failed to update dashboard display: ${error.message || error}`);
      }
      continue;
    }

    if (input === "5") {
      const enabledText = (
        await askQuestion(rl, "Enable repeating session loop? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.sessionLoopEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextPlayMinText = (
        await askQuestion(rl, "Play MIN minutes (Enter keep): ")
      ).trim();
      const nextPlayMaxText = (
        await askQuestion(rl, "Play MAX minutes (Enter keep): ")
      ).trim();
      const nextRestMinText = (
        await askQuestion(rl, "Rest MIN minutes (Enter keep): ")
      ).trim();
      const nextRestMaxText = (
        await askQuestion(rl, "Rest MAX minutes (Enter keep): ")
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        playMinMinutes: nextPlayMinText ? Number(nextPlayMinText) : settings.playMinMinutes,
        playMaxMinutes: nextPlayMaxText ? Number(nextPlayMaxText) : settings.playMaxMinutes,
        restMinMinutes: nextRestMinText ? Number(nextRestMinText) : settings.restMinMinutes,
        restMaxMinutes: nextRestMaxText ? Number(nextRestMaxText) : settings.restMaxMinutes
      };

      try {
        const applied = await runtimeControls.updateSessionLoopConfig(nextConfig);
        settings.sessionLoopEnabled = applied.enabled;
        settings.playMinMinutes = applied.playMinMinutes;
        settings.playMaxMinutes = applied.playMaxMinutes;
        settings.restMinMinutes = applied.restMinMinutes;
        settings.restMaxMinutes = applied.restMaxMinutes;

        logSuccess(
          `Session loop updated: ${applied.enabled ? "ON" : "OFF"}, play ${applied.playMinMinutes}-${applied.playMaxMinutes}m, rest ${applied.restMinMinutes}-${applied.restMaxMinutes}m.`
        );
      } catch (error) {
        logError(`Failed to update session loop: ${error.message || error}`);
      }

      continue;
    }

    if (input === "6") {
      const enabledText = (
        await askQuestion(rl, "Enable farmlist loop? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.farmlistLoopEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Farmlist loop MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Farmlist loop MAX minutes (Enter keep): ")
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.farmlistLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.farmlistLoopMaxMinutes
      };

      try {
        const applied = await runtimeControls.updateFarmlistLoopConfig(nextConfig);
        settings.farmlistLoopEnabled = applied.enabled;
        settings.farmlistLoopMinMinutes = applied.minMinutes;
        settings.farmlistLoopMaxMinutes = applied.maxMinutes;

        logSuccess(
          `Farmlist loop updated: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes}m.`
        );
      } catch (error) {
        logError(`Failed to update farmlist loop: ${error.message || error}`);
      }

      continue;
    }

    if (input === "7") {
      const enabledText = (
        await askQuestion(rl, "Enable status print after farmlists? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      if (enabledText === "Y") {
        settings.statusAfterFarmlistsEnabled = true;
      } else if (enabledText === "N") {
        settings.statusAfterFarmlistsEnabled = false;
      }

      const cooldownText = (
        await askQuestion(rl, "Status print cooldown MINUTES (Enter keep): ")
      ).trim();
      if (cooldownText) {
        const parsed = Number(cooldownText);
        if (Number.isFinite(parsed) && parsed >= 1) {
          settings.statusAfterFarmlistsCooldownMinutes = Math.floor(parsed);
        } else {
          logWarn("Invalid cooldown value. Keeping previous value.");
        }
      }

      if (!Number.isFinite(settings.statusAfterFarmlistsCooldownMinutes) || settings.statusAfterFarmlistsCooldownMinutes < 1) {
        settings.statusAfterFarmlistsCooldownMinutes = 15;
      }

      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "STATUS_AFTER_FARMLISTS_ENABLED",
          "STATUS_AFTER_FARMLISTS_COOLDOWN_MINUTES"
        ]);
      }

      logSuccess(
        `Status after farmlists: ${settings.statusAfterFarmlistsEnabled ? "ON" : "OFF"}, cooldown ${settings.statusAfterFarmlistsCooldownMinutes} minute(s).`
      );
      continue;
    }

    if (input === "B") {
      done = true;
      continue;
    }

    if (input === "G") {
      settings.builderGoldCompleteEnabled = !settings.builderGoldCompleteEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "BUILDER_GOLD_COMPLETE_ENABLED"
        ]);
      }
      logSuccess(
        `Builder gold complete: ${settings.builderGoldCompleteEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "BL") {
      const enabledText = (
        await askQuestion(rl, "Enable builder loop? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.builderLoopEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Builder loop MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Builder loop MAX minutes (Enter keep): ")
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.builderLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.builderLoopMaxMinutes
      };

      try {
        const applied = await runtimeControls.updateBuilderLoopConfig(nextConfig);
        settings.builderLoopEnabled = applied.enabled;
        settings.builderLoopMinMinutes = applied.minMinutes;
        settings.builderLoopMaxMinutes = applied.maxMinutes;

        logSuccess(
          `Builder loop updated: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes}m.`
        );
      } catch (error) {
        logError(`Failed to update builder loop: ${error.message || error}`);
      }

      continue;
    }

    if (input === "M") {
      settings.builderMasterBuilderEnabled = !settings.builderMasterBuilderEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "BUILDER_MASTER_BUILDER_ENABLED"
        ]);
      }
      logSuccess(
        `Builder master builder usage: ${settings.builderMasterBuilderEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "E") {
      settings.raidEvacuationEnabled = !(settings.raidEvacuationEnabled !== false);
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "RAID_EVACUATION_ENABLED"
        ]);
      }
      logSuccess(
        `Raid resource evacuation: ${settings.raidEvacuationEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "K") {
      const enabledText = (
        await askQuestion(rl, "Enable raid troop evacuation? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      if (enabledText === "Y") {
        settings.raidEvacuationTroopsEnabled = true;
      } else if (enabledText === "N") {
        settings.raidEvacuationTroopsEnabled = false;
      }

      const typed = (
        await askQuestion(rl, "Troop evacuation recall delay SECONDS (10-3600, Enter keep): ")
      ).trim();
      if (typed) {
        const n = Number(typed);
        if (!Number.isFinite(n)) {
          logWarn("Invalid number. Keeping previous recall delay.");
        } else {
          settings.raidEvacuationTroopRecallSeconds = Math.max(10, Math.min(3600, Math.floor(n)));
        }
      }

      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "RAID_EVACUATION_TROOPS_ENABLED",
          "RAID_EVACUATION_TROOP_RECALL_SECONDS"
        ]);
      }
      logSuccess(
        `Raid troop evacuation: ${settings.raidEvacuationTroopsEnabled ? "ON" : "OFF"}, recall after ${settings.raidEvacuationTroopRecallSeconds || 60}s.`
      );
      continue;
    }

    if (input === "H") {
      await runRaidPivotVillageMenu(rl, settings, runtimeControls);
      continue;
    }

    if (input === "BR") {
      settings.builderRoundRobinEnabled = !settings.builderRoundRobinEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "BUILDER_ROUND_ROBIN_ENABLED"
        ]);
      }
      logSuccess(
        `Builder round-robin: ${settings.builderRoundRobinEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "X") {
      await runBuilderRrExclusionMenu(rl, settings, runtimeControls);
      continue;
    }

    if (input === "T") {
      const enabledText = (
        await askQuestion(rl, "Enable troop RR loop? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.troopTrainingRoundRobinEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Troop RR loop MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Troop RR loop MAX minutes (Enter keep): ")
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.troopTrainingLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.troopTrainingLoopMaxMinutes
      };

      if (!runtimeControls.updateTroopTrainingLoopConfig) {
        logWarn("Troop RR loop update is not available in this runtime.");
        continue;
      }

      try {
        const applied = await runtimeControls.updateTroopTrainingLoopConfig(nextConfig);
        settings.troopTrainingRoundRobinEnabled = applied.enabled;
        settings.troopTrainingLoopMinMinutes = applied.minMinutes;
        settings.troopTrainingLoopMaxMinutes = applied.maxMinutes;

        logSuccess(
          `Troop RR loop updated: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes} minute(s).`
        );
      } catch (error) {
        logError(`Failed to update troop RR loop: ${error.message || error}`);
      }

      continue;
    }

    if (input === "U") {
      await runTroopPlansMenu(rl, settings, runtimeControls, runtimeControls.troopPlanHooks || {});
      continue;
    }

    if (input === "I") {
      const enabledText = (
        await askQuestion(rl, "Enable Cranny RR? (Y/N, Enter keep): ")
      ).trim().toUpperCase();

      let nextEnabled = settings.crannyDefenseRoundRobinEnabled;
      if (enabledText === "Y") {
        nextEnabled = true;
      } else if (enabledText === "N") {
        nextEnabled = false;
      }

      const nextMinText = (
        await askQuestion(rl, "Cranny defense RR MIN minutes (Enter keep): ")
      ).trim();
      const nextMaxText = (
        await askQuestion(rl, "Cranny defense RR MAX minutes (Enter keep): ")
      ).trim();

      const nextConfig = {
        enabled: nextEnabled,
        minMinutes: nextMinText ? Number(nextMinText) : settings.crannyDefenseLoopMinMinutes,
        maxMinutes: nextMaxText ? Number(nextMaxText) : settings.crannyDefenseLoopMaxMinutes
      };

      if (!runtimeControls.updateCrannyDefenseLoopConfig) {
        logWarn("Cranny defense interval update is not available in this runtime.");
        continue;
      }

      try {
        const applied = await runtimeControls.updateCrannyDefenseLoopConfig(nextConfig);
        settings.crannyDefenseRoundRobinEnabled = applied.enabled;
        settings.crannyDefenseLoopMinMinutes = applied.minMinutes;
        settings.crannyDefenseLoopMaxMinutes = applied.maxMinutes;

        logSuccess(
          `Cranny RR updated: ${applied.enabled ? "ON" : "OFF"}, every ${applied.minMinutes}-${applied.maxMinutes} minute(s).`
        );
      } catch (error) {
        logError(`Failed to update Cranny RR: ${error.message || error}`);
      }

      continue;
    }

    if (input === "A") {
      settings.expansionUsePlannedTargets = !settings.expansionUsePlannedTargets;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "EXPANSION_USE_PLANNED_TARGETS"
        ]);
      }
      logSuccess(
        `Expansion planned-target mode: ${settings.expansionUsePlannedTargets ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "P") {
      const current = settings.expansionPlannedTargetsFile || "templates/settlement_targets.json";
      const typed = (await askQuestion(
        rl,
        `Targets file path (Enter keep): ${current}\nNew file path: `
      )).trim();
      if (typed) {
        settings.expansionPlannedTargetsFile = typed;
      }

      const loaded = loadPlannedSettlementTargetsFromFile(settings.expansionPlannedTargetsFile);
      if (!loaded.ok) {
        logWarn(`${loaded.message}`);
      } else {
        logSuccess(
          `Loaded ${loaded.targets.length} planned target(s) from ${loaded.absolutePath}`
        );
      }

      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "EXPANSION_PLANNED_TARGETS_FILE"
        ]);
      }
      continue;
    }

    if (input === "W") {
      settings.expansionAutoDispatchEnabled = !settings.expansionAutoDispatchEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings([
          "EXPANSION_AUTO_DISPATCH_ENABLED"
        ]);
      }
      logSuccess(
        `Expansion auto-dispatch: ${settings.expansionAutoDispatchEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "R") {
      settings.resourceCirculationEnabled = !settings.resourceCirculationEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings(["RESOURCE_CIRCULATION_ENABLED"]);
      }
      logSuccess(
        `Builder resource circulation: ${settings.resourceCirculationEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    if (input === "V") {
      settings.resourceCirculationExpansionEnabled = !settings.resourceCirculationExpansionEnabled;
      if (runtimeControls.persistSettings) {
        await runtimeControls.persistSettings(["RESOURCE_CIRCULATION_EXPANSION_ENABLED"]);
      }
      logSuccess(
        `Settlement-prep circulation: ${settings.resourceCirculationExpansionEnabled ? "ON" : "OFF"}`
      );
      continue;
    }

    logWarn("Unknown option. Use 1-7, D, G, BL, BR, X, M, R, T, U, I, W, A, E, K, H, P, V, B, or Q.");
  }
}

async function openVillageBuilder(page, settings, selectedVillageId) {
  await page.goto(withVillageId(settings.villageBuilderUrl, selectedVillageId), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
}

async function navigateToVillageCenterMap(page, settings, selectedVillageId) {
  const villageMapUrl = withVillageId(settings.villageBuilderUrl, selectedVillageId);

  await safeGotoWithRetry(page, villageMapUrl, {}, 4);

  const villageCenterUrl = await page.evaluate(() => {
    const topBar = document.querySelector("#mtop a#n2[href]");
    if (topBar) {
      return topBar.getAttribute("href");
    }

    const centerImg =
      document.querySelector("img[alt='Village center'][title='Village center']") ||
      document.querySelector("img[title='Village center'][alt='Village center']") ||
      document.querySelector("img[title='Village center']");

    if (centerImg) {
      const parentLink = centerImg.closest("a[href]");
      return parentLink ? parentLink.getAttribute("href") : null;
    }

    return null;
  });

  if (villageCenterUrl) {
    const absoluteCenter = withVillageId(new URL(villageCenterUrl, page.url()).toString(), selectedVillageId);
    await safeGotoWithRetry(page, absoluteCenter, {}, 4);
  } else {
    const fallbackCenter = withVillageId(new URL("village2.php", page.url()).toString(), selectedVillageId);
    await safeGotoWithRetry(page, fallbackCenter, {}, 4);
  }
}

const TRAINER_BUILDING_GID = {
  barracks: 19,
  great_barracks: 29,
  stable: 20,
  great_stable: 30
};

const TRAINER_BUILDING_LABELS = {
  barracks: "Barracks",
  great_barracks: "Great Barracks",
  stable: "Stable",
  great_stable: "Great Stable"
};

function normalizeMapBuildingLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\blevel\s+\d+\b/gi, " ")
    .replace(/\blvl\.?\s*\d+\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mapLabelMatchesTrainerKind(label, kind) {
  const n = normalizeMapBuildingLabel(label);
  const c = n.replace(/\s+/g, "");
  if (!n) {
    return false;
  }
  switch (kind) {
    case "great_barracks":
      return c.includes("greatbarracks") || /\bgreat barracks\b/.test(n);
    case "barracks":
      return (/\bbarracks\b/.test(n) || c === "barracks") && !/great/.test(n);
    case "great_stable":
      return c.includes("greatstable") || /\bgreat stable\b/.test(n);
    case "stable":
      return (c === "stable" || c === "stables" || /\bstable\b/.test(n) || /\bstables\b/.test(n)) && !/great/.test(n);
    default:
      return false;
  }
}

async function surveyVillageMapTrainerSlots(getPage, settings, villageId) {
  const page = getPage();
  await navigateToVillageCenterMap(page, settings, villageId);
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\blevel\s+\d+\b/gi, " ")
        .replace(/\blvl\.?\s*\d+\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    const areas = Array.from(
      document.querySelectorAll("map#map2 area[href*='build.php?id='], area[href*='build.php?id=']")
    );
    const rows = [];
    for (const area of areas) {
      const href = area.getAttribute("href") || "";
      const match = href.match(/[?&]id=(\d+)/i);
      const slotId = match ? Number(match[1]) : null;
      if (!Number.isFinite(slotId) || slotId < 19) {
        continue;
      }
      const gidMatch = href.match(/[?&]gid=(\d+)/i);
      rows.push({
        slotId,
        gid: gidMatch ? Number(gidMatch[1]) : null,
        label: normalize(`${area.getAttribute("title") || ""} ${area.getAttribute("alt") || ""}`),
        href
      });
    }
    return rows;
  });
}

async function villageHasTrainerBuildingOnMap(getPage, settings, villageId, kind) {
  const rows = await surveyVillageMapTrainerSlots(getPage, settings, villageId);
  const expectedGid = TRAINER_BUILDING_GID[kind];
  for (const row of rows) {
    if (expectedGid && row.gid === expectedGid) {
      return true;
    }
    if (mapLabelMatchesTrainerKind(row.label, kind)) {
      return true;
    }
  }
  return false;
}

async function resolveTrainerBuildUrlFromVillageMap(getPage, settings, selectedVillageId, kind) {
  const page = getPage();
  const rows = await surveyVillageMapTrainerSlots(getPage, settings, selectedVillageId);
  const expectedGid = TRAINER_BUILDING_GID[kind];

  let chosen = null;
  for (const row of rows) {
    if (expectedGid && row.gid === expectedGid) {
      chosen = row;
      break;
    }
    if (mapLabelMatchesTrainerKind(row.label, kind)) {
      chosen = row;
      break;
    }
  }

  if (!chosen) {
    return null;
  }

  if (chosen.href) {
    return withVillageId(new URL(chosen.href, page.url()).toString(), selectedVillageId);
  }
  if (chosen.slotId) {
    return withVillageId(new URL(`build.php?id=${chosen.slotId}`, page.url()).toString(), selectedVillageId);
  }
  return null;
}

async function resolveBarracksUrlFromVillageMap(getPage, settings, selectedVillageId) {
  return resolveTrainerBuildUrlFromVillageMap(getPage, settings, selectedVillageId, "barracks");
}

async function resolveGreatBarracksUrlFromVillageMap(getPage, settings, selectedVillageId) {
  return resolveTrainerBuildUrlFromVillageMap(getPage, settings, selectedVillageId, "great_barracks");
}

async function resolveStableUrlFromVillageMap(getPage, settings, selectedVillageId) {
  return resolveTrainerBuildUrlFromVillageMap(getPage, settings, selectedVillageId, "stable");
}

async function resolveGreatStableUrlFromVillageMap(getPage, settings, selectedVillageId) {
  return resolveTrainerBuildUrlFromVillageMap(getPage, settings, selectedVillageId, "great_stable");
}

const TROOP_ROW_SELECTOR = "form[name='snd'] table.build_details tbody tr";

const TRAINER_BUILDING_RESOLVERS = {
  barracks: resolveBarracksUrlFromVillageMap,
  great_barracks: resolveGreatBarracksUrlFromVillageMap,
  stable: resolveStableUrlFromVillageMap,
  great_stable: resolveGreatStableUrlFromVillageMap
};

function normalizeTrainerBuilding(building) {
  return TRAINER_BUILDING_RESOLVERS[building] ? building : "barracks";
}

async function trainerPageMatchesBuilding(page, kind) {
  const gid = TRAINER_BUILDING_GID[kind];
  if (!gid) {
    return true;
  }

  if (await page.locator(`#build.gid${gid}`).first().isVisible().catch(() => false)) {
    return true;
  }
  if (await page.locator(`img.building.g${gid}, .building.g${gid}`).first().isVisible().catch(() => false)) {
    return true;
  }

  const heading = await page.locator("h1").first().textContent().catch(() => "");
  const h1 = String(heading || "").replace(/\s+/g, " ").trim();
  if (kind === "stable") {
    return /\bstables?\b/i.test(h1) && !/great\s+stable/i.test(h1);
  }
  if (kind === "barracks") {
    return /\bbarracks\b/i.test(h1) && !/great\s+barracks/i.test(h1);
  }
  if (kind === "great_stable") {
    return /great\s+stable/i.test(h1);
  }
  if (kind === "great_barracks") {
    return /great\s+barracks/i.test(h1);
  }

  try {
    const urlGid = Number(new URL(String(page.url() || "")).searchParams.get("gid"));
    if (Number.isFinite(urlGid) && urlGid === gid) {
      return true;
    }
  } catch (_error) {
    /* ignore */
  }

  return false;
}

/** Nexian submits troop training via AJAX; wait for the request or cleared inputs. */
async function submitTroopTraining(page, inputName) {
  const trainButton = page.locator("#btn_train").first();
  const inputSelector = `input[name='${inputName}']`;

  const waitForAjax = page
    .waitForResponse(
      (resp) => {
        if (!resp.url().includes("ajax_build.php")) {
          return false;
        }
        const postData = resp.request().postData() || "";
        return /train_troops/.test(postData);
      },
      { timeout: 20000 }
    )
    .then(async (resp) => {
      try {
        const body = await resp.json();
        if (body && body.success === false) {
          return { ok: false, message: body.message || body.error || "Training rejected" };
        }
        return { ok: resp.ok(), message: body && body.message ? body.message : null };
      } catch (_error) {
        return { ok: resp.ok(), message: null };
      }
    })
    .catch(() => null);

  const waitForClearedInput = page
    .waitForFunction(
      (selector) => {
        const input = document.querySelector(selector);
        return Boolean(input && String(input.value || "").trim() === "0");
      },
      inputSelector,
      { timeout: 20000 }
    )
    .then(() => ({ ok: true, message: null }))
    .catch(() => null);

  await trainButton.click({ force: true });

  const outcome = await Promise.race([waitForAjax, waitForClearedInput]);
  if (outcome && outcome.ok) {
    return { ok: true, message: outcome.message };
  }
  if (outcome && outcome.ok === false) {
    return { ok: false, message: outcome.message || "Training rejected" };
  }

  const stillFilled = await page
    .locator(inputSelector)
    .first()
    .inputValue()
    .then((value) => String(value || "").trim() !== "" && String(value || "").trim() !== "0")
    .catch(() => false);
  if (!stillFilled) {
    return { ok: true, message: null };
  }
  return { ok: false, message: "Training did not complete (no AJAX response)" };
}

/** Open a trainer building for a village and return the list of trainable unit rows. */
async function loadTrainerPageWithRows(page, url, kind) {
  if (!url) {
    return false;
  }
  await safeGotoWithRetry(page, url, {}, 4);
  let hasRows = await page.locator(TROOP_ROW_SELECTOR).first().isVisible().catch(() => false);
  if (!hasRows) {
    await page.waitForSelector(TROOP_ROW_SELECTOR, { timeout: 15000 }).catch(() => null);
    hasRows = await page.locator(TROOP_ROW_SELECTOR).first().isVisible().catch(() => false);
  }
  if (!hasRows) {
    return false;
  }
  return trainerPageMatchesBuilding(page, kind);
}

async function openTrainerAndReadRows(getPage, settings, villageId, building) {
  const page = getPage();
  const kind = normalizeTrainerBuilding(building);
  let loaded = false;
  const expectedGid = TRAINER_BUILDING_GID[kind];

  const mapRows = await surveyVillageMapTrainerSlots(getPage, settings, villageId);
  const mapCandidates = mapRows.filter(
    (row) => (expectedGid && row.gid === expectedGid) || mapLabelMatchesTrainerKind(row.label, kind)
  );

  for (const row of mapCandidates) {
    let candidateUrl = null;
    if (row.href) {
      candidateUrl = withVillageId(new URL(row.href, page.url()).toString(), villageId);
    } else if (row.slotId) {
      candidateUrl = withVillageId(new URL(`build.php?id=${row.slotId}`, page.url()).toString(), villageId);
    }
    if (candidateUrl && (await loadTrainerPageWithRows(page, candidateUrl, kind))) {
      loaded = true;
      break;
    }
  }

  if (!loaded && (kind === "barracks" || kind === "stable")) {
    const configuredTrainer =
      kind === "stable" ? settings.troopStableTrainerUrl : settings.troopTrainerUrl;
    const targetTrainerUrl = withVillageId(configuredTrainer, villageId);
    loaded = await loadTrainerPageWithRows(page, targetTrainerUrl, kind);
  }

  if (!loaded) {
    return { page, building: kind, rows: [], missingBuilding: true };
  }

  const rows = await page.evaluate((rowSelector) => {
    return Array.from(document.querySelectorAll(rowSelector))
      .map((row) => {
        const tit = row.querySelector("td.desc .tit");
        const nameEl = tit ? tit.querySelector("a") : null;
        const unitImg = tit ? tit.querySelector("img.unit[title], img.unit[alt]") : null;
        let troopName = nameEl ? nameEl.textContent.replace(/\u00a0/g, " ").trim() : "";
        if (!troopName && unitImg) {
          troopName = String(unitImg.getAttribute("title") || unitImg.getAttribute("alt") || "").trim();
        }
        const inputEl = row.querySelector("td.val input.text[type='text'], td.val input.text");
        const maxLink = row.querySelector("td.max a");
        const inputName = inputEl ? inputEl.getAttribute("name") : "";
        const maxText = maxLink ? maxLink.textContent : "";
        const onclickText = maxLink ? maxLink.getAttribute("onclick") || "" : "";
        const maxFromText = (() => {
          const match = String(maxText).match(/(\d+)/);
          return match ? Number(match[1]) : NaN;
        })();
        const maxFromOnclick = (() => {
          const m =
            String(onclickText).match(/\.value\s*=\s*(\d+)/i) ||
            String(onclickText).match(/\bvalue\s*=\s*(\d+)/i);
          return m ? Number(m[1]) : NaN;
        })();
        let maxTrainable = Number.isFinite(maxFromText)
          ? maxFromText
          : Number.isFinite(maxFromOnclick)
            ? maxFromOnclick
            : 0;
        const availEl = row.querySelector(".tit span.info span[id^='availCount_']");
        const availDigits = availEl ? String(availEl.textContent || "").replace(/\D/g, "").trim() : "";
        const availableNow = availDigits !== "" ? Number(availDigits) : NaN;
        if (Number.isFinite(availableNow)) {
          if (availableNow <= 0) {
            maxTrainable = 0;
          } else {
            maxTrainable = Math.min(maxTrainable, availableNow);
          }
        }
        return { troopName, inputName, maxTrainable };
      })
      .filter((item) => item.inputName);
  }, TROOP_ROW_SELECTOR);

  return { page, building: kind, rows, missingBuilding: false };
}

/** List the unit names currently visible in a village's Barracks or Stable (used by the plan editor). */
async function listTrainableUnits(getPage, settings, villageId, building) {
  const { rows, missingBuilding } = await openTrainerAndReadRows(getPage, settings, villageId, building);
  return {
    missingBuilding,
    units: rows
      .map((r) => String(r.troopName || "").trim())
      .filter(Boolean)
  };
}

/**
 * Train a single unit in one building. Trains the requested targetQty, or the maximum
 * affordable if resources fall short. Returns a status object (never throws for game state).
 */
async function trainPlanBranch(getPage, settings, villageId, options = {}) {
  const building = normalizeTrainerBuilding(options.building);
  const buildingLabel = TRAINER_BUILDING_LABELS[building] || building;
  const unitName = String(options.unitName || "").trim();
  const targetQty = Math.max(1, Math.floor(Number(options.targetQty) || 1));

  if (!unitName) {
    return { status: "no_unit_configured", building, buildingLabel, queued: 0 };
  }

  const { page, rows, missingBuilding } = await openTrainerAndReadRows(
    getPage,
    settings,
    villageId,
    building
  );

  if (missingBuilding) {
    return { status: "missing_building", building, buildingLabel, unitName, queued: 0 };
  }

  const needle = unitName.toLowerCase();
  const match =
    rows.find((r) => String(r.troopName || "").trim().toLowerCase() === needle) ||
    rows.find((r) => String(r.troopName || "").trim().toLowerCase().includes(needle));

  if (!match) {
    const available = rows.map((r) => r.troopName).filter(Boolean).join(", ") || "none";
    return {
      status: "unit_not_found",
      building,
      buildingLabel,
      unitName,
      queued: 0,
      availableUnits: available
    };
  }

  const maxTrainable = Math.max(0, Math.floor(Number(match.maxTrainable) || 0));
  if (maxTrainable <= 0) {
    return {
      status: "no_resources",
      building,
      buildingLabel,
      unitName: match.troopName || unitName,
      queued: 0,
      maxTrainable: 0
    };
  }

  const trainQty = Math.min(targetQty, maxTrainable);
  const input = page.locator(`input[name='${match.inputName}']`).first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill(String(trainQty));

  const submit = await submitTroopTraining(page, match.inputName);
  if (!submit.ok) {
    return {
      status: "train_failed",
      building,
      buildingLabel,
      unitName: match.troopName || unitName,
      queued: 0,
      errorMessage: submit.message || "Training did not complete"
    };
  }

  return {
    status: "trained",
    building,
    buildingLabel,
    unitName: match.troopName || unitName,
    queued: trainQty,
    maxTrainable,
    cappedByResources: trainQty < targetQty
  };
}

async function showVillageStatus(getPage, settings, selectedVillageId, selectedVillage) {
  const page = getPage();
  await safeGotoWithRetry(page, withVillageId(settings.villageStatusUrl, selectedVillageId));

  const status = await page.evaluate(() => {
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.replace(/\u00a0/g, " ").trim() : "N/A";
    };

    const resources = [
      { name: "Wood", value: getText("#l4") },
      { name: "Clay", value: getText("#l3") },
      { name: "Iron", value: getText("#l2") },
      { name: "Crop", value: getText("#l1") }
    ];

    const classifyMovementRowDirection = (row) => {
      const tbody = row.closest("tbody");
      const tbClass = tbody ? String(tbody.className || "").toLowerCase() : "";
      if (/\bincomings?\b/.test(tbClass) || /\bincoming troop/.test(tbClass)) {
        return "in";
      }
      if (
        /\boutgoings?\b/.test(tbClass) ||
        /\boutgoing troop/.test(tbClass) ||
        /\bcommands\b/.test(tbClass) ||
        /\bbefehl/.test(tbClass)
      ) {
        return "out";
      }
      const rc = String(row.className || "").toLowerCase();
      if (/\boutgoing\b|\boutgo\b|\bmov(?:ement)?_?out\b|\btroopout\b|\bcommand_out\b/.test(rc)) {
        return "out";
      }
      if (/\bincoming\b|\bmov(?:ement)?_?in\b|\btroopin\b|\bcommand_in\b/.test(rc)) {
        return "in";
      }
      const typ = row.querySelector("td.typ");
      if (typ) {
        const gc = `${typ.className || ""}`.toLowerCase();
        if (/\bd2\b|^d2 |\sd2\b/.test(gc) || /dir_?out|direction_?2|movement_?out/.test(gc)) {
          return "out";
        }
        if (/\bd1\b|^d1 |\sd1\b/.test(gc) || /dir_?in|direction_?1|movement_?in/.test(gc)) {
          return "in";
        }
        const img = typ.querySelector("img[src]");
        if (img) {
          const src = String(img.getAttribute("src") || "").toLowerCase();
          if (/uhr\b|ruck|rück|backward|befehle_back|\bret\b|return(?:ing)?\b/i.test(src)) {
            return "out";
          }
        }
      }
      return "unknown";
    };

    const movementRows = Array.from(document.querySelectorAll("#movements tbody tr"));
    const movements = movementRows
      .map((row) => {
        const movementDirection = classifyMovementRowDirection(row);
        const icon = row.querySelector("td.typ img");
        const label = row.querySelector(".mov span");
        const eta = row.querySelector(".dur_r");

        const type =
          (icon && (icon.getAttribute("title") || icon.getAttribute("alt"))) ||
          "Movement";
        const text = label ? label.textContent.replace(/\u00a0/g, " ").trim() : "";
        const etaText = eta
          ? eta.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
          : "";

        return { movementDirection, type, text, eta: etaText };
      })
      .filter((item) => item.text || item.eta);

    const unitRows = Array.from(document.querySelectorAll("#troops tbody tr"));
    const units = unitRows
      .map((row) => {
        const nameEl = row.querySelector("td.un");
        const countEl = row.querySelector("td.num");
        const name = nameEl ? nameEl.textContent.replace(/\u00a0/g, " ").trim() : "";
        const count = countEl ? countEl.textContent.replace(/\u00a0/g, " ").trim() : "";
        return { name, count };
      })
      .filter((item) => item.name && item.count);

    const productionRows = Array.from(document.querySelectorAll("#production tbody tr"));
    const production = productionRows
      .map((row) => {
        const resourceNameEl = row.querySelector("td.res");
        const valueEl = row.querySelector("td.num");
        const perEl = row.querySelector("td.per");

        const resource = resourceNameEl
          ? resourceNameEl.textContent.replace(/\u00a0/g, " ").replace(":", "").trim()
          : "";
        const value = valueEl ? valueEl.textContent.replace(/\u00a0/g, " ").trim() : "";
        const per = perEl ? perEl.textContent.replace(/\u00a0/g, " ").trim() : "";

        return { resource, value, per };
      })
      .filter((item) => item.resource && item.value);

    const parseContractTable = (selector) => {
      const table = document.querySelector(selector);
      if (!table) {
        return {
          queueCount: 0,
          goldFinishAvailable: false,
          items: []
        };
      }

      const rows = Array.from(table.querySelectorAll("tbody tr"));
      const items = rows
        .map((row) => {
          const buildingCell = row.querySelector("td:nth-child(2)");
          const remainingCell = row.querySelector("td:nth-child(3)");
          const buildLink = buildingCell
            ? buildingCell.querySelector("a[href*='build.php?id=']")
            : null;

          const href = buildLink ? buildLink.getAttribute("href") || "" : "";
          const slotMatch = href.match(/[?&]id=(\d+)/i);
          const slot = slotMatch ? Number(slotMatch[1]) : null;

          const building = buildingCell
            ? buildingCell.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
            : "";
          const timerEl = row.querySelector("span[id^='timer']");
          const remaining = timerEl
            ? timerEl.textContent.replace(/\u00a0/g, " ").trim()
            : (remainingCell
              ? remainingCell.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
              : "");

          return {
            slot,
            building,
            remaining,
            waitingLoop: /waiting\s+loop/i.test(building)
          };
        })
        .filter((item) => item.building || item.remaining);

      const goldFinishLink = table.querySelector("thead a[href*='bfs']");
      return {
        queueCount: items.length,
        goldFinishAvailable: Boolean(goldFinishLink),
        items
      };
    };

    const buildingContract = parseContractTable("#building_contract");
    const masterBuilderContract = parseContractTable("#building_contract_mb");

    return {
      resources,
      movements,
      units,
      production,
      buildingContract,
      masterBuilderContract
    };
  });
  const incomingAttacks = getIncomingAttackAlerts(status.movements);

  printDivider("VILLAGE STATUS");

  if (selectedVillage) {
    const planModes = [
      { key: "village", title: "VILLAGE STAGE BUILDER" },
      { key: "resource", title: "RESOURCE FIELDS BUILDER" }
    ];

    for (const plan of planModes) {
      let syncMessage = null;
      try {
        const syncResult = await builder.syncProgressToWorldState(
          getPage,
          settings,
          selectedVillage,
          { planMode: plan.key }
        );
        if (syncResult && (syncResult.status === "realigned" || syncResult.status === "error")) {
          syncMessage = syncResult.message;
        }
      } catch (error) {
        syncMessage = `Progress sync failed: ${error.message || error}`;
      }

      const villageProgress = builder.getVillageProgress(selectedVillage, { planMode: plan.key });
      const templatePreview = builder.previewPlan(selectedVillage, { planMode: plan.key });

      let templateValue = "N/A";
      let progressValue = "N/A";
      let nextStepValue = "N/A";

      if (templatePreview && templatePreview.activeTemplate) {
        const templateName = templatePreview.templateName || templatePreview.activeTemplate;
        templateValue = `${templateName} (${templatePreview.activeTemplate})`;
      } else if (villageProgress && villageProgress.active_template) {
        templateValue = villageProgress.active_template;
      }

      if (villageProgress) {
        const stageNum = Number(villageProgress.stage_index || 0) + 1;
        const stepNum = Number(villageProgress.step_index || 0) + 1;
        progressValue = `stage ${stageNum}, step ${stepNum}`;
      }

      if (templatePreview) {
        if (templatePreview.status === "pending") {
          const next = templatePreview.next;
          nextStepValue = `${next.step.building} slot ${next.step.slot} -> lvl ${next.step.target_level}`;
        } else if (templatePreview.status === "template_complete" || templatePreview.status === "all_complete") {
          nextStepValue = templatePreview.message;
        } else if (templatePreview.status === "error") {
          nextStepValue = `Template error: ${templatePreview.message}`;
        }
      }

      printSubDivider(plan.title);
      printKeyValueRows([
        { label: "Village", value: villageDisplayName(selectedVillage) },
        { label: "Template", value: templateValue },
        { label: "Progress", value: progressValue },
        { label: "Next step", value: nextStepValue }
      ]);

      if (syncMessage) {
        logWarn(`[${plan.title}] ${syncMessage}`);
      }
    }
  }

  printSubDivider("BUILDING CONTRACT");
  if (!status.buildingContract || !status.buildingContract.items.length) {
    console.log(`  ${color("none", ANSI.dim)}`);
  } else {
    const goldFinishValue = status.buildingContract.goldFinishAvailable
      ? color("Available", ANSI.bold, ANSI.green)
      : color("Unavailable", ANSI.bold, ANSI.yellow);

    printKeyValueRows([
      { label: "Queue items", value: String(status.buildingContract.queueCount) },
      { label: "Gold finish", value: goldFinishValue, raw: true }
    ]);

    status.buildingContract.items.forEach((item, index) => {
      const slotText = Number.isFinite(item.slot) ? `slot ${item.slot}` : "slot ?";
      const waitingText = item.waitingLoop
        ? ` ${color("[waiting loop]", ANSI.yellow)}`
        : "";
      console.log(
        `  ${color(`${index + 1}.`, ANSI.bold, ANSI.cyan)} ` +
        `${color(slotText, ANSI.gray)} ${color("|", ANSI.dim)} ` +
        `${color(item.building || "?", ANSI.bold)} ${color("|", ANSI.dim)} ` +
        `${color(item.remaining || "N/A", ANSI.cyan)}${waitingText}`
      );
    });
  }

  printSubDivider("MASTER BUILDER CONTRACT");
  if (!status.masterBuilderContract || !status.masterBuilderContract.items.length) {
    console.log(`  ${color("none", ANSI.dim)}`);
  } else {
    const mbGoldFinishValue = status.masterBuilderContract.goldFinishAvailable
      ? color("Available", ANSI.bold, ANSI.green)
      : color("Unavailable", ANSI.bold, ANSI.yellow);

    printKeyValueRows([
      { label: "Queue items", value: String(status.masterBuilderContract.queueCount) },
      { label: "Gold finish", value: mbGoldFinishValue, raw: true }
    ]);

    status.masterBuilderContract.items.forEach((item, index) => {
      const slotText = Number.isFinite(item.slot) ? `slot ${item.slot}` : "slot ?";
      const waitingText = item.waitingLoop
        ? ` ${color("[waiting loop]", ANSI.yellow)}`
        : "";
      console.log(
        `  ${color(`${index + 1}.`, ANSI.bold, ANSI.cyan)} ` +
        `${color(slotText, ANSI.gray)} ${color("|", ANSI.dim)} ` +
        `${color(item.building || "?", ANSI.bold)} ${color("|", ANSI.dim)} ` +
        `${color(item.remaining || "N/A", ANSI.cyan)}${waitingText}`
      );
    });
  }

  printSubDivider("WAREHOUSE + PRODUCTION");
  const productionByName = Object.fromEntries(
    status.production.map((item) => [item.resource.toLowerCase(), item])
  );
  const combinedRows = status.resources.map((resource) => {
    const production = productionByName[resource.name.toLowerCase()];
    const productionText = production
      ? `${production.value}${production.per ? ` ${production.per}` : ""}`
      : "N/A";

    const label = color(resource.name, ANSI.bold, resourceColorCode(resource.name));
    const stock = color(resource.value, ANSI.bold, ANSI.gray);
    const productionPart = color(productionText, ANSI.bold, ANSI.green);

    return {
      label,
      value: `${stock} ${color("|", ANSI.dim)} ${productionPart}`,
      raw: true
    };
  });
  printKeyValueRows(combinedRows);

  if (!status.movements.length) {
    printSubDivider("TROOP MOVEMENTS");
    console.log(`  ${color("none", ANSI.dim)}`);
  } else {
    printSubDivider("TROOP MOVEMENTS");
    status.movements.forEach((movement, index) => {
      const indexPart = color(`${index + 1}.`, ANSI.bold, ANSI.cyan);
      const movementColor = movementColorCode(movement);
      const typePart = color(movement.type, ANSI.bold, ANSI.yellow);
      const textPart = color(movement.text, ANSI.bold, movementColor);
      const etaPart = movement.eta
        ? `${color("|", ANSI.dim)} ${color(movement.eta, ANSI.cyan)}`
        : "";
      console.log(
        `  ${indexPart} ${typePart} ${color("|", ANSI.dim)} ${textPart} ${etaPart}`.trimEnd()
      );
    });
  }

  printSubDivider("ATTACK ALERT");
  if (!incomingAttacks.length) {
    console.log(`  ${color("none", ANSI.dim)}`);
  } else {
    const earliest = incomingAttacks[0];
    const earliestMinutes = Math.max(1, Math.ceil((Number(earliest.etaSeconds) || 0) / 60));
    printKeyValueRows([
      { label: "Incoming attacks", value: String(incomingAttacks.length) },
      { label: "Earliest impact", value: `${earliestMinutes} min (${earliest.eta || "N/A"})` }
    ]);
  }

  if (!status.units.length) {
    printSubDivider("UNITS");
    console.log(`  ${color("none", ANSI.dim)}`);
  } else {
    printSubDivider("UNITS");
    printKeyValueRows(
      status.units.map((unit) => ({
        label: color(unit.name, ANSI.bold, ANSI.yellow),
        value: color(unit.count, ANSI.bold, ANSI.cyan),
        raw: true
      }))
    );
  }

}

function resolveVillageSwitchDelayMs(settings) {
  if (settings && Number.isFinite(Number(settings.villageSwitchDelayMs))) {
    return Math.max(0, Math.floor(Number(settings.villageSwitchDelayMs)));
  }
  return settings && settings.headless ? 0 : 800;
}

async function waitAfterVillageSwitch(page, settings) {
  const delayMs = resolveVillageSwitchDelayMs(settings);
  if (delayMs > 0 && page && !page.isClosed()) {
    await page.waitForTimeout(delayMs);
  }
}

function getCurrentVidFromPageUrl(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  try {
    const url = new URL(String(page.url() || ""));
    const raw = url.searchParams.get("vid") || url.searchParams.get("newdid");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

async function readIncomingAttackAlerts(getPage, settings, villageId) {
  const page = getPage();
  const statusUrl = withVillageId(settings.villageStatusUrl, villageId);
  const currentVid = getCurrentVidFromPageUrl(page);
  if (!(Number.isFinite(currentVid) && Number(currentVid) === Number(villageId))) {
    await safeGotoWithRetry(page, statusUrl, {}, 3);
    await waitAfterVillageSwitch(page, settings);
  }
  const movements = await page.evaluate(() => {
    const classifyMovementRowDirection = (row) => {
      const tbody = row.closest("tbody");
      const tbClass = tbody ? String(tbody.className || "").toLowerCase() : "";
      if (/\bincomings?\b/.test(tbClass) || /\bincoming troop/.test(tbClass)) {
        return "in";
      }
      if (
        /\boutgoings?\b/.test(tbClass) ||
        /\boutgoing troop/.test(tbClass) ||
        /\bcommands\b/.test(tbClass) ||
        /\bbefehl/.test(tbClass)
      ) {
        return "out";
      }
      const rc = String(row.className || "").toLowerCase();
      if (
        /\boutgoing\b|\boutgo\b|\bmov(?:ement)?_?out\b|\btroopout\b|\bcommand_out\b/.test(rc)
      ) {
        return "out";
      }
      if (
        /\bincoming\b|\bmov(?:ement)?_?in\b|\btroopin\b|\bcommand_in\b/.test(rc)
      ) {
        return "in";
      }

      const typ = row.querySelector("td.typ");
      if (typ) {
        const gc = `${typ.className || ""}`.toLowerCase();
        if (/\bd2\b|^d2 |\sd2\b/.test(gc) || /dir_?out|direction_?2|movement_?out/.test(gc)) {
          return "out";
        }
        if (/\bd1\b|^d1 |\sd1\b/.test(gc) || /dir_?in|direction_?1|movement_?in/.test(gc)) {
          return "in";
        }

        const img = typ.querySelector("img[src]");
        if (img) {
          const src = String(img.getAttribute("src") || "").toLowerCase();
          if (/uhr\b|ruck|rück|backward|befehle_back|\bret\b|return(?:ing)?\b/i.test(src)) {
            return "out";
          }
        }
      }
      return "unknown";
    };

    const rows = Array.from(document.querySelectorAll("#movements tbody tr"));
    return rows.map((row) => {
      const movementDirection = classifyMovementRowDirection(row);
      const icon = row.querySelector("td.typ img");
      const label = row.querySelector(".mov span");
      const eta = row.querySelector(".dur_r");
      const timer = row.querySelector(".dur_r span[id^='timer']");
      const type =
        (icon && (icon.getAttribute("title") || icon.getAttribute("alt"))) ||
        "Movement";
      const text = label ? label.textContent.replace(/\u00a0/g, " ").trim() : "";
      const etaText = timer
        ? timer.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
        : (eta
          ? eta.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
          : "");
      const etaRaw = eta
        ? eta.textContent.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
        : "";
      return {
        movementDirection,
        type,
        text,
        eta: etaText,
        etaRaw
      };
    }).filter((item) => item.text || item.eta);
  });
  return getIncomingAttackAlerts(movements);
}

async function evacuateTroopsToPivot(getPage, settings, sourceVillage, pivotVillage, options = {}) {
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }
  if (!sourceVillage || !Number.isFinite(Number(sourceVillage.id))) {
    return { status: "troop_evac_skipped", message: "Missing source village for troop evacuation." };
  }
  if (!pivotVillage || !Number.isFinite(Number(pivotVillage.id))) {
    return { status: "troop_evac_skipped", message: "No pivot village for troop evacuation." };
  }
  if (!Number.isFinite(Number(pivotVillage.x)) || !Number.isFinite(Number(pivotVillage.y))) {
    return {
      status: "troop_evac_skipped",
      message: `Pivot ${villageDisplayName(pivotVillage)} has no coordinates. Refresh village list and retry.`
    };
  }
  if (Number(sourceVillage.id) === Number(pivotVillage.id)) {
    return { status: "troop_evac_skipped", message: "Source village equals pivot village." };
  }

  const fromVid = Number(sourceVillage.id);
  const base = settings.villageBuilderUrl || "https://nexian.world/village2.php";
  let root;
  try {
    const u = new URL(base);
    root = `${u.protocol}//${u.host}`;
  } catch (_e) {
    root = "https://nexian.world";
  }
  const candidates = [
    withVillageId(`${root}/build.php?id=39&tt=2`, fromVid),
    withVillageId(`${root}/build.php?id=39&t=1`, fromVid),
    withVillageId(`${root}/build.php?id=39`, fromVid)
  ];

  let opened = false;
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const hasSendForm = await page
        .locator("form[name='snd'], form[action*='build.php'][action*='id=39']")
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (hasSendForm) {
        opened = true;
        break;
      }
    } catch (_e) {}
  }
  if (!opened) {
    return { status: "troop_evac_skipped", message: "Could not open Rally Point send troops form." };
  }

  const parsed = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("form[name='snd'] table tbody tr, form[name='snd'] tr"));
    const troops = [];
    rows.forEach((row) => {
      const input = row.querySelector("input[name^='t']");
      if (!input) {
        return;
      }
      const inputName = String(input.getAttribute("name") || "");
      if (!/^t\d+$/i.test(inputName)) {
        return;
      }
      const titleAnchor = row.querySelector("td.un a, td.desc .tit a");
      const titleImg = row.querySelector("img.unit[title], img.unit[alt]");
      const troopName =
        (titleAnchor && String(titleAnchor.textContent || "").trim()) ||
        (titleImg && String(titleImg.getAttribute("title") || titleImg.getAttribute("alt") || "").trim()) ||
        inputName;
      const maxLink = row.querySelector("td.max a, a[onclick*='.value']");
      const maxText = maxLink ? String(maxLink.textContent || "") : "";
      const maxFromText = (() => {
        const m = maxText.match(/(\d+)/);
        return m ? Number(m[1]) : NaN;
      })();
      const maxFromOnclick = (() => {
        const o = maxLink ? String(maxLink.getAttribute("onclick") || "") : "";
        const m = o.match(/\.value\s*=\s*(\d+)/i) || o.match(/\bvalue\s*=\s*(\d+)/i);
        return m ? Number(m[1]) : NaN;
      })();
      const maxTrainable = Number.isFinite(maxFromText)
        ? maxFromText
        : (Number.isFinite(maxFromOnclick) ? maxFromOnclick : 0);
      if (maxTrainable > 0) {
        troops.push({ inputName, troopName, qty: maxTrainable });
      }
    });

    const xSel = [
      "input[name='x']",
      "input#xCoordInput",
      "input[name='xCoord']",
      "input[name='dname'][placeholder*='x']"
    ];
    const ySel = [
      "input[name='y']",
      "input#yCoordInput",
      "input[name='yCoord']",
      "input[name='dname'][placeholder*='y']"
    ];
    const pickFirst = (arr) => arr.find((s) => document.querySelector(s)) || null;
    return {
      troops,
      xSelector: pickFirst(xSel),
      ySelector: pickFirst(ySel)
    };
  });

  if (!parsed || !Array.isArray(parsed.troops) || !parsed.troops.length) {
    return { status: "troop_evac_skipped", message: "No movable troops available for evacuation." };
  }
  if (!parsed.xSelector || !parsed.ySelector) {
    return { status: "troop_evac_skipped", message: "Troop destination coordinate fields not found." };
  }

  for (const troop of parsed.troops) {
    const input = page.locator(`input[name='${troop.inputName}']`).first();
    await input.fill(String(Math.max(0, Math.floor(Number(troop.qty) || 0)))).catch(() => {});
  }
  await page.locator(parsed.xSelector).first().fill(String(Math.trunc(Number(pivotVillage.x)))).catch(() => {});
  await page.locator(parsed.ySelector).first().fill(String(Math.trunc(Number(pivotVillage.y)))).catch(() => {});

  const clickFirstAvailable = async (selectors) => {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      const ok = await loc.count().then((n) => n > 0).catch(() => false);
      if (!ok) {
        continue;
      }
      try {
        await loc.click({ timeout: 10000 });
        return true;
      } catch (_e) {
        try {
          await loc.click({ force: true, timeout: 8000 });
          return true;
        } catch (_e2) {}
      }
    }
    return false;
  };

  const submitOk = await clickFirstAvailable([
    "form[name='snd'] #btn_ok",
    "form[name='snd'] input[name='s1']",
    "form[name='snd'] button[type='submit']",
    "#btn_ok"
  ]);
  if (!submitOk) {
    return { status: "troop_evac_failed", message: "Could not submit troop evacuation send form." };
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});

  // Travian/Nexian can show a confirmation step.
  await clickFirstAvailable([
    "form[name='snd2'] #btn_ok",
    "form[name='snd2'] input[name='s1']",
    "form[name='snd2'] button[type='submit']",
    "#btn_ok"
  ]).catch(() => false);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const totalSent = parsed.troops.reduce((sum, t) => sum + Math.max(0, Math.floor(Number(t.qty) || 0)), 0);
  const heroIncluded = parsed.troops.some((t) => /^t11$/i.test(String(t.inputName || "")));
  const topTroops = parsed.troops
    .slice()
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3)
    .map((t) => `${t.troopName} x${t.qty}`)
    .join(", ");

  const recallAfterSeconds = Math.max(
    10,
    Math.floor(
      Number.isFinite(Number(options.recallAfterSeconds))
        ? Number(options.recallAfterSeconds)
        : 60
    )
  );
  const pivotCoordsText =
    Number.isFinite(Number(pivotVillage.x)) && Number.isFinite(Number(pivotVillage.y))
      ? `(${Math.trunc(Number(pivotVillage.x))}|${Math.trunc(Number(pivotVillage.y))})`
      : null;

  // Requested defense mode: short evacuation hop, then cancel command so troops return home.
  await page.waitForTimeout(recallAfterSeconds * 1000);
  const rallyCommandUrl = withVillageId(`${root}/build.php?id=39&tt=1`, fromVid);
  await page.goto(rallyCommandUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(600);
  const recall = await page.evaluate((coordsNeedle) => {
    const textOf = (el) => String(el && el.textContent ? el.textContent : "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const rows = Array.from(
      document.querySelectorAll("#movements tbody tr, #troop_movements tbody tr, .movements tbody tr")
    );
    const scored = rows
      .map((row, idx) => {
        const rowText = textOf(row).toLowerCase();
        let score = 0;
        if (/\boutgoing\b|\battack on\b|\braid on\b|\bto\b/.test(rowText)) score += 2;
        if (coordsNeedle && rowText.includes(String(coordsNeedle).toLowerCase())) score += 5;
        const cancelLink = row.querySelector(
          "a[href*='delEvent'], a[href*='cancel'], a[href*='abort'], a[href*='back'], a[onclick*='delEvent'], a[onclick*='cancel']"
        );
        const cancelBtn = row.querySelector(
          "button[onclick*='delEvent'], button[onclick*='cancel'], input[onclick*='delEvent'], input[onclick*='cancel']"
        );
        const actionEl = cancelLink || cancelBtn;
        if (actionEl) score += 4;
        return { row, idx, score, actionEl, rowText };
      })
      .filter((x) => x.actionEl && x.score > 0)
      .sort((a, b) => b.score - a.score || a.idx - b.idx);
    const best = scored[0];
    if (!best || !best.actionEl) {
      return { ok: false, reason: "no-cancel-control" };
    }
    try {
      if (typeof best.actionEl.click === "function") {
        best.actionEl.click();
        return { ok: true, reason: "clicked", rowText: best.rowText };
      }
    } catch (_e) {}
    return { ok: false, reason: "click-failed" };
  }, pivotCoordsText);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});

  return {
    status: "troop_evac_sent",
    message:
      `Evacuated ${totalSent} troop(s) to ${villageDisplayName(pivotVillage)} ` +
      `${heroIncluded ? "(hero included)" : ""}.` +
      (topTroops ? ` Top: ${topTroops}.` : "") +
      ` Recall ${recall && recall.ok ? "submitted" : "not confirmed"} after ${recallAfterSeconds}s.`,
    totalSent,
    heroIncluded,
    sentTypes: parsed.troops.length,
    recallAfterSeconds,
    recallSubmitted: Boolean(recall && recall.ok)
  };
}

async function readUnderAttackVillageIds(getPage, settings) {
  const page = getPage();
  const collect = async () => page.evaluate(() => {
    const ids = new Set();

    Array.from(document.querySelectorAll("#vlist tr.under-attack[data-vid]"))
      .forEach((row) => {
        const id = Number(row.getAttribute("data-vid"));
        if (Number.isFinite(id)) {
          ids.add(id);
        }
      });

    // Fallback signal for templates where row class may not be present:
    // attack icon/link title, e.g. <a title="Under Attack!"><img class="att1"></a>
    Array.from(document.querySelectorAll(
      "#vlist tr[data-vid] a[title*='Under Attack'], #vlist tr[data-vid] img.att1"
    ))
      .forEach((node) => {
        const row = node.closest("tr[data-vid]");
        if (!row) {
          return;
        }
        const id = Number(row.getAttribute("data-vid"));
        if (Number.isFinite(id)) {
          ids.add(id);
        }
      });

    return Array.from(ids);
  });

  let ids = await collect().catch(() => []);
  if (ids.length > 0) {
    return ids;
  }

  await safeGotoWithRetry(page, settings.villageStatusUrl).catch(() => null);
  ids = await collect().catch(() => []);
  return ids;
}

async function runTerminalMenu(getPage, settings, runtimeControls) {
  terminalUiSettings = settings;
  const dashboardMode = Boolean(runtimeControls.dashboardMode && runtimeControls.dashboardBridge);
  const dashboardBridge = runtimeControls.dashboardBridge || null;
  const dashboardPort = runtimeControls.dashboardPort || 3847;

  const terminalRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Unified input model for dashboard mode: a single persistent "line" listener
  // on the terminal feeds either an active sub-menu question (pendingTerminalAnswer)
  // or, at the main menu, the shared command queue used by the web dashboard.
  let pendingTerminalAnswer = null;
  const menuSession = { quitRequested: false };
  if (dashboardMode && dashboardBridge) {
    terminalRl.on("line", (line) => {
      const text = String(line == null ? "" : line);
      if (pendingTerminalAnswer) {
        const deliver = pendingTerminalAnswer;
        pendingTerminalAnswer = null;
        deliver(text);
        return;
      }
      const trimmed = text.trim();
      if (trimmed) {
        dashboardBridge.enqueueCommand(trimmed);
      }
    });
  }

  const menuRl = dashboardMode && dashboardBridge
    ? {
        closed: false,
        question(message, callback) {
          // Sub-menu prompts (Settings, troop templates, village select, etc.)
          // are answered in the terminal only — no web popup is shown.
          let settled = false;
          const finish = (answer) => {
            if (settled) {
              return;
            }
            settled = true;
            pendingTerminalAnswer = null;
            if (typeof callback === "function") {
              callback(answer);
            }
          };
          pendingTerminalAnswer = (answer) => finish(answer);
          process.stdout.write(`\n${message}`);
        },
        write(text) {
          terminalRl.write(text);
        },
        close() {
          this.closed = true;
          terminalRl.close();
        }
      }
    : terminalRl;
  let farmlistLoopTimer = null;
  let activitySimulationLoopTimer = null;
  let top10TrackingLoopTimer = null;
  let builderLoopTimer = null;
  let crannyDefenseLoopTimer = null;
  let raidEvacuationLoopTimer = null;
  let sigintHandler = null;
  const raidEvacuationByVillage = new Map();
  const raidEvacuationSkipLogAtByVillage = new Map();
  const troopVillageLoopState = new Map();
  /** Serializes troop auto runs so per-village timers do not fight for the browser lock. */
  let troopAutoRunChain = Promise.resolve();
  const TROOP_MISSING_BUILDING_RETRY_MS = 12 * 60 * 60 * 1000;

  try {
    let done = false;
    let actionInProgress = false;
    let currentActionLabel = "";
    let cancelRequested = false;
    let nextFarmlistRunAt = null;

    const requestQuit = () => {
      if (menuSession.quitRequested) {
        return;
      }
      menuSession.quitRequested = true;
      done = true;
      cancelRequested = true;
      logInfo("Quit requested. Shutting down...");
      if (dashboardBridge && typeof dashboardBridge.cancelCommandWaiters === "function") {
        dashboardBridge.cancelCommandWaiters();
      }
      if (pendingTerminalAnswer) {
        const deliver = pendingTerminalAnswer;
        pendingTerminalAnswer = null;
        deliver("Q");
      }
    };

    if (dashboardBridge) {
      dashboardBridge.setQuitHandler(requestQuit);
    }
    let lastFarmlistDelayMinutes = null;
    let farmlistResumeWaitLogged = false;
    let farmlistShortRetriesLeft = 0;
    const FARMLIST_SHORT_RETRY_MS = 120000;
    /** Max time troop auto waits for another action (manual menu, Top10 snapshot, etc.) before skipping this tick. */
    const TROOP_AUTO_ACTION_IDLE_WAIT_MS = 10000;
    const TROOP_AUTO_BUSY_RETRY_MIN_MS = 15000;
    const TROOP_AUTO_BUSY_RETRY_JITTER_MS = 10000;
    let nextBuilderRunAt = null;
    let lastBuilderDelayMinutes = null;
    let nextCrannyDefenseRunAt = null;
    let lastCrannyDefenseDelayMinutes = null;
    let nextActivitySimulationRunAt = null;
    let lastActivitySimulationDelayMinutes = null;
    let activitySimulationResumeWaitLogged = false;
    let lastActivitySimulationAction = null;
    let activitySimulationCompletedCount = 0;
    let nextTop10TrackingRunAt = null;
    let lastTop10TrackingDelayMinutes = null;
    let top10TrackingResumeWaitLogged = false;
    let lastTop10TrackingAction = null;
    let top10TrackingCompletedCount = 0;
    let builderResumeWaitLogged = false;
    let builderTemplateDeferredForCrannyLogged = false;
    let builderVillageWaitLastLogAt = null;
    let lastAutoFarmlistStatusPrintedAt = null;
    let activeBuilderPlanMode =
      String(settings.builderDefaultPlanMode || "resource").toLowerCase() === "village"
        ? "village"
        : "resource";
    let roundRobinIndex = 0;
    const realignStreakByKey = new Map();
    let crannyRoundRobinIndex = 0;
    const sessionId = runtimeControls.getSessionId
      ? runtimeControls.getSessionId()
      : `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const logFilePath = runtimeControls.getLogFilePath
      ? runtimeControls.getLogFilePath()
      : path.resolve(process.cwd(), "log.jsonl");
    let sessionActionCounter = 0;
    const villageState = {
      villages: [],
      activeVillageId: null,
      selectedVillageId: null,
      lastRefreshIso: null
    };

    const pendingMerchantArrivalByVillage = new Map();
    const builderVillageCooldownUntilByVillage = new Map();
    const builderEfficiencyWindow = {
      startedAt: Date.now(),
      attempts: 0,
      success: 0,
      blocked: 0,
      skippedCooldown: 0
    };

    const getBuilderCooldownMsForStatus = (status) => {
      switch (status) {
        case "blocked_queue":
        case "idle_saturated":
          return 2 * 60 * 1000;
        case "blocked_resources":
        case "blocked_master_builder_only":
          return 5 * 60 * 1000;
        case "blocked_storage":
          return 10 * 60 * 1000;
        case "all_complete":
          return 30 * 60 * 1000;
        default:
          return 0;
      }
    };

    const maybeLogBuilderEfficiencyWindow = () => {
      const elapsedMs = Date.now() - builderEfficiencyWindow.startedAt;
      if (elapsedMs < 30 * 60 * 1000) {
        return;
      }
      const attempts = builderEfficiencyWindow.attempts;
      const successRate = attempts > 0
        ? ((builderEfficiencyWindow.success / attempts) * 100).toFixed(1)
        : "0.0";
      logInfo(
        `[Builder Loop] 30m efficiency: attempts=${attempts}, success=${builderEfficiencyWindow.success}, blocked=${builderEfficiencyWindow.blocked}, cooldown_skips=${builderEfficiencyWindow.skippedCooldown}, success_rate=${successRate}%`
      );
      builderEfficiencyWindow.startedAt = Date.now();
      builderEfficiencyWindow.attempts = 0;
      builderEfficiencyWindow.success = 0;
      builderEfficiencyWindow.blocked = 0;
      builderEfficiencyWindow.skippedCooldown = 0;
    };

    const fetchVillageSnapshotFromPage = async () => {
      const page = getPage();
      if (!page || page.isClosed()) {
        throw new Error("Session page is currently unavailable. Retry after re-login completes.");
      }

      return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#vlist tr[data-vid]"));
        let villages = rows.map((row) => {
          const villageId = Number(row.getAttribute("data-vid"));
          const link = row.querySelector("td.link a");
          const name = link ? link.textContent.replace(/\u00a0/g, " ").trim() : `Village ${villageId}`;
          const href = link ? link.getAttribute("href") || "" : "";

          const cox = row.querySelector("td.aligned_coords .cox");
          const coy = row.querySelector("td.aligned_coords .coy");
          const x = cox
            ? Number((cox.textContent || "").replace(/[^\d-]/g, ""))
            : null;
          const y = coy
            ? Number((coy.textContent || "").replace(/[^\d-]/g, ""))
            : null;

          const section = row.closest("tbody.vg-section");
          const groupNameEl = section ? section.querySelector("tr.vg-group-header .vg-group-name") : null;
          const groupName = groupNameEl
            ? groupNameEl.textContent.replace(/\u00a0/g, " ").trim()
            : "Ungrouped";
          const isCapital = Boolean(
            section && section.getAttribute("data-group-id") === "_capital"
          );

          const dotCell = row.querySelector("td.dot, td.dothl");
          const isActive = Boolean(
            dotCell &&
            (dotCell.classList.contains("dothl") ||
              row.classList.contains("active") ||
              row.classList.contains("current"))
          );

          const underAttack = Boolean(
            row.classList.contains("under-attack") ||
              row.querySelector(".attack-glow") ||
              row.querySelector("img.att1")
          );

          return {
            id: Number.isFinite(villageId) ? villageId : null,
            name,
            groupName,
            isCapital,
            x: Number.isFinite(x) ? x : null,
            y: Number.isFinite(y) ? y : null,
            coordsText:
              Number.isFinite(x) && Number.isFinite(y)
                ? `(${x}|${y})`
                : "(?|?)",
            switchHref: href,
            isActive,
            underAttack
          };
        }).filter((village) => Number.isFinite(village.id));

        // Fallback layout: some worlds/themes render villages in sidebar/dropdown links
        // without #vlist rows. Parse anchors with newdid/vid and infer basic meta.
        if (!villages.length) {
          const linkNodes = Array.from(
            document.querySelectorAll(
              [
                "#sidebarBoxVillagelist a[href*='newdid=']",
                "#sidebarBoxVillagelist a[href*='vid=']",
                ".villageList a[href*='newdid=']",
                ".villageList a[href*='vid=']",
                "#villageList a[href*='newdid=']",
                "#villageList a[href*='vid=']",
                "a[href*='newdid='][class*='village']",
                "a[href*='vid='][class*='village']"
              ].join(", ")
            )
          );
          villages = linkNodes
            .map((link) => {
              const href = link.getAttribute("href") || "";
              const absoluteHref = (() => {
                try {
                  return new URL(href, window.location.href);
                } catch (_error) {
                  return null;
                }
              })();
              const idRaw =
                (absoluteHref && (absoluteHref.searchParams.get("newdid") || absoluteHref.searchParams.get("vid"))) ||
                null;
              const villageId = Number(idRaw);
              if (!Number.isFinite(villageId)) {
                return null;
              }

              const rawText = (link.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
              const coordMatch = rawText.match(/\((-?\d+)\|(-?\d+)\)/);
              const x = coordMatch ? Number(coordMatch[1]) : null;
              const y = coordMatch ? Number(coordMatch[2]) : null;
              const name = coordMatch ? rawText.replace(coordMatch[0], "").trim() : rawText;

              const linkClass = String(link.className || "").toLowerCase();
              const rowClass = String((link.closest("li, tr, div") || {}).className || "").toLowerCase();
              const isActive =
                /\bactive\b|\bcurrent\b|\bselected\b/.test(linkClass) ||
                /\bactive\b|\bcurrent\b|\bselected\b/.test(rowClass) ||
                (absoluteHref &&
                  (absoluteHref.searchParams.get("newdid") ===
                    new URL(window.location.href).searchParams.get("newdid") ||
                    absoluteHref.searchParams.get("vid") ===
                      new URL(window.location.href).searchParams.get("vid")));

              return {
                id: villageId,
                name: name || `Village ${villageId}`,
                groupName: "Ungrouped",
                isCapital: false,
                x: Number.isFinite(x) ? x : null,
                y: Number.isFinite(y) ? y : null,
                coordsText:
                  Number.isFinite(x) && Number.isFinite(y)
                    ? `(${x}|${y})`
                    : "(?|?)",
                switchHref: href,
                isActive,
                underAttack: false
              };
            })
            .filter((village) => village && Number.isFinite(village.id));
        }

        // Last fallback: if no village list is rendered at all, infer current village from URL.
        if (!villages.length) {
          let inferredId = null;
          try {
            const url = new URL(window.location.href);
            const raw = url.searchParams.get("vid") || url.searchParams.get("newdid");
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
              inferredId = parsed;
            }
          } catch (_error) {
            inferredId = null;
          }
          if (Number.isFinite(inferredId)) {
            villages = [
              {
                id: inferredId,
                name: `Village ${inferredId}`,
                groupName: "Ungrouped",
                isCapital: false,
                x: null,
                y: null,
                coordsText: "(?|?)",
                switchHref: "",
                isActive: true,
                underAttack: false
              }
            ];
          }
        }

        // Some UI layouts can render duplicate village rows (e.g. mirrored sections).
        // Keep first occurrence by village id so round-robin doesn't hit same village repeatedly.
        const uniqueVillages = [];
        const seenVillageIds = new Set();
        villages.forEach((village) => {
          if (seenVillageIds.has(village.id)) {
            return;
          }
          seenVillageIds.add(village.id);
          uniqueVillages.push(village);
        });

        const active = uniqueVillages.find((village) => village.isActive) || null;
        return {
          villages: uniqueVillages,
          activeVillageId: active ? active.id : null
        };
      });
    };

    const refreshVillageState = async ({ navigateToStatusPage = true, silent = false } = {}) => {
      const page = getPage();
      if (!page || page.isClosed()) {
        throw new Error("Session page is currently unavailable. Retry after re-login completes.");
      }

      if (navigateToStatusPage) {
        const vlistCount = await page.locator("#vlist tr[data-vid]").count().catch(() => 0);
        if (!vlistCount) {
          await safeGotoWithRetry(page, resolveVillageStatusUrl(settings, villageState));
        }
      }

      const snapshot = await fetchVillageSnapshotFromPage();
      villageState.villages = snapshot.villages;
      villageState.activeVillageId = snapshot.activeVillageId;
      villageState.lastRefreshIso = new Date().toISOString();

      const selectedStillExists = villageState.villages.some(
        (village) => village.id === villageState.selectedVillageId
      );
      if (!selectedStillExists) {
        villageState.selectedVillageId =
          snapshot.activeVillageId || (villageState.villages[0] ? villageState.villages[0].id : null);
      }

      if (!silent) {
        logInfo(`[Village] ${villageState.villages.length} village(s) loaded`);
      }

      return villageState;
    };

    const getSelectedVillage = () =>
      villageState.villages.find((village) => village.id === villageState.selectedVillageId) || null;

    /**
     * Farmlists must be sent from a village that has a Rally Point. Prefer an
     * explicitly configured village, then the capital, then selected/active, then
     * the first known village. Returns a numeric village id or null.
     */
    const resolveFarmlistVillageId = () => {
      const configured = Number(settings.farmlistVillageId);
      if (Number.isFinite(configured) && configured > 0) {
        return Math.trunc(configured);
      }
      const capital = villageState.villages.find((v) => v.isCapital);
      if (capital && capital.id) {
        return Number(capital.id);
      }
      const selected = getSelectedVillage();
      if (selected && selected.id) {
        return Number(selected.id);
      }
      const active = villageState.villages.find(
        (v) => v.id === villageState.activeVillageId
      );
      if (active && active.id) {
        return Number(active.id);
      }
      return villageState.villages.length ? Number(villageState.villages[0].id) : null;
    };

    /** When builder RR is off, match troop trainer behavior: use explicit selection, else game-active village, else first row. */
    const resolveBuilderFallbackVillage = () =>
      getSelectedVillage() ||
      villageState.villages.find((village) => village.id === villageState.activeVillageId) ||
      (villageState.villages.length ? villageState.villages[0] : null);

    const getCurrentVidFromPage = (page) => {
      if (!page || page.isClosed()) {
        return null;
      }
      try {
        const url = new URL(String(page.url() || ""));
        const raw = url.searchParams.get("vid") || url.searchParams.get("newdid");
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      } catch (_error) {
        return null;
      }
    };

    const isOnVillageStatusLikePage = (page) => {
      if (!page || page.isClosed()) {
        return false;
      }
      try {
        const pathname = new URL(String(page.url() || "")).pathname.toLowerCase();
        return /\/(village1|dorf1|village2|dorf2)\.php$/.test(pathname);
      } catch (_error) {
        return false;
      }
    };

    const restoreSelectedVillageContext = async (sourceLabel = "Context Restore") => {
      const selectedVillage = getSelectedVillage();
      if (!selectedVillage) {
        return;
      }
      const page = getPage();
      if (!page || page.isClosed()) {
        return;
      }
      const currentVid = getCurrentVidFromPage(page);
      const sameVillageAlready = Number.isFinite(currentVid) && Number(currentVid) === Number(selectedVillage.id);
      if (!sameVillageAlready) {
        await safeGotoWithRetry(
          page,
          withVillageId(settings.villageStatusUrl, selectedVillage.id)
        ).catch(() => null);
        await waitAfterVillageSwitch(page, settings);
      }
      await refreshVillageState({ navigateToStatusPage: false, silent: true }).catch(() => null);
      if (!sameVillageAlready) {
        logInfo(`[${sourceLabel}] Restored selected village context: ${villageDisplayName(selectedVillage)}.`);
      }
    };

    /** Open status/overview for `village` in the browser (does not change menu selection). Round-robin builder needs this before slot reads. */
    const ensureVillageBrowserContext = async (village, sourceLabel = "Context") => {
      if (!village || !Number.isFinite(Number(village.id))) {
        return;
      }
      const page = getPage();
      if (!page || page.isClosed()) {
        return;
      }
      const currentVid = getCurrentVidFromPage(page);
      const sameVillageAlready = Number.isFinite(currentVid) && Number(currentVid) === Number(village.id);
      const alreadyOnUsableVillagePage = sameVillageAlready && isOnVillageStatusLikePage(page);
      if (!alreadyOnUsableVillagePage) {
        await safeGotoWithRetry(
          page,
          withVillageId(settings.villageStatusUrl, village.id)
        ).catch(() => null);
        await waitAfterVillageSwitch(page, settings);
      }
      await refreshVillageState({ navigateToStatusPage: false, silent: true }).catch(() => null);
      if (!alreadyOnUsableVillagePage) {
        logInfo(`[${sourceLabel}] Village browser context: ${villageDisplayName(village)}`);
      }
    };

    const getVillageMeta = (scope) => {
      const selected = getSelectedVillage();
      if (scope === "all") {
        return {
          villageScope: "all",
          villageCount: villageState.villages.length || null
        };
      }
      return {
        villageScope: "single",
        villageId: selected ? selected.id : null,
        villageName: selected ? selected.name : null,
        villageGroup: selected ? selected.groupName : null,
        villageCoords: selected ? selected.coordsText : null,
        villageIsCapital: selected ? Boolean(selected.isCapital) : null
      };
    };

    const printSelectedVillageStatus = async (sourceLabel = "Status") => {
      const targetVillage = resolveBuilderFallbackVillage();
      if (!targetVillage) {
        logWarn(`[${sourceLabel}] No villages loaded; skipping village status print.`);
        return;
      }

      const explicit = getSelectedVillage();
      if (explicit) {
        logInfo(`[${sourceLabel}] Printing selected village status...`);
      } else {
        logInfo(
          `[${sourceLabel}] Village status (fallback): ${villageDisplayName(targetVillage)} — use V to pin a village.`
        );
      }
      try {
        await showVillageStatus(
          getPage,
          settings,
          targetVillage.id,
          targetVillage
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const isTransientNav =
          /net::ERR_ABORTED|Execution context was destroyed|interrupted by another navigation/i.test(message);
        if (isTransientNav) {
          logWarn(`[${sourceLabel}] Status navigation aborted; skipping status print this time.`);
          return;
        }
        throw error;
      }
    };

    const maybePrintAutoFarmlistStatus = async (sourceLabel = "Farmlist Loop") => {
      const enabled = settings.statusAfterFarmlistsEnabled !== false;
      const cooldownMinutes = Number.isFinite(Number(settings.statusAfterFarmlistsCooldownMinutes))
        ? Math.max(1, Math.floor(Number(settings.statusAfterFarmlistsCooldownMinutes)))
        : 15;

      if (!enabled) {
        logInfo(`[${sourceLabel}] Auto status print disabled in settings.`);
        return;
      }

      const now = Date.now();
      if (Number.isFinite(lastAutoFarmlistStatusPrintedAt)) {
        const elapsedMs = now - lastAutoFarmlistStatusPrintedAt;
        const cooldownMs = cooldownMinutes * 60 * 1000;
        if (elapsedMs < cooldownMs) {
          const remainingMinutes = Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 60000));
          logInfo(
            `[${sourceLabel}] Auto status print cooldown active (${remainingMinutes} minute(s) remaining).`
          );
          return;
        }
      }

      await printSelectedVillageStatus(sourceLabel);
      lastAutoFarmlistStatusPrintedAt = now;
    };


    const getBuilderVillagePlanKey = (villageId, planMode) =>
      `${Number(villageId) || 0}:${String(planMode || "village").toLowerCase() === "resource" ? "resource" : "village"}`;

    const resetRealignStreak = (villageId, planMode) => {
      realignStreakByKey.delete(getBuilderVillagePlanKey(villageId, planMode));
    };

    const incrementRealignStreak = (villageId, planMode) => {
      const key = getBuilderVillagePlanKey(villageId, planMode);
      const nextValue = (realignStreakByKey.get(key) || 0) + 1;
      realignStreakByKey.set(key, nextValue);
      return nextValue;
    };

    const normalizeBuilderPlanMode = (planMode) =>
      String(planMode || settings.builderDefaultPlanMode || "resource").toLowerCase() === "resource"
        ? "resource"
        : "village";

    const isBuilderPlanFullyComplete = (village, planMode) => {
      try {
        const preview = builder.previewPlan(village, { planMode: normalizeBuilderPlanMode(planMode) });
        return preview && preview.status === "all_complete";
      } catch (_error) {
        return false;
      }
    };

    const builderRrUsesResourceThenVillagePipeline = () =>
      Boolean(
        settings.builderRoundRobinEnabled &&
          settings.builderRrResourceThenVillage !== false &&
          normalizeBuilderPlanMode(settings.builderDefaultPlanMode) === "resource"
      );

    const resolveBuilderPlanModeForVillage = (village) => {
      if (!village) {
        return normalizeBuilderPlanMode(activeBuilderPlanMode);
      }
      if (builderRrUsesResourceThenVillagePipeline()) {
        if (!isBuilderPlanFullyComplete(village, "resource")) {
          return "resource";
        }
        if (!isBuilderPlanFullyComplete(village, "village")) {
          return "village";
        }
        return null;
      }
      return normalizeBuilderPlanMode(activeBuilderPlanMode);
    };

    const villageHasPendingBuilderWork = (village) =>
      resolveBuilderPlanModeForVillage(village) != null;

    const getRoundRobinPipelineProgress = (villages) => {
      const list = (Array.isArray(villages) ? villages : []).filter((v) => !v.isCapital);
      if (!list.length) {
        return null;
      }
      let resourceDone = 0;
      let villageDone = 0;
      for (const village of list) {
        if (isBuilderPlanFullyComplete(village, "resource")) {
          resourceDone += 1;
        }
        if (isBuilderPlanFullyComplete(village, "village")) {
          villageDone += 1;
        }
      }
      return `res ${resourceDone}/${list.length} · village ${villageDone}/${list.length}`;
    };

    const getRoundRobinProgress = (villages, planMode) => {
      const list = Array.isArray(villages) ? villages : [];
      if (!list.length) {
        return null;
      }
      let completedCount = 0;
      for (const village of list) {
        if (isBuilderPlanFullyComplete(village, planMode)) {
          completedCount += 1;
        }
      }
      return `${completedCount}/${list.length} complete`;
    };

    const getBuilderPlanMeta = (planMode) => {
      const normalized = normalizeBuilderPlanMode(planMode);
      if (normalized === "resource") {
        return {
          key: "resource",
          name: "Resource Fields Builder",
          short: "resource"
        };
      }

      return {
        key: "village",
        name: "Village Stage Builder",
        short: "village"
      };
    };

    const runVillageSelectorMenu = async () => {
      if (!(await waitForActionIdle("Village selector"))) {
        return;
      }
      await refreshVillageState({ navigateToStatusPage: true, silent: true });

      if (!villageState.villages.length) {
        logWarn("No villages detected.");
        return;
      }

      let selectorDone = false;
      while (!selectorDone) {
        if (menuSession.quitRequested) {
          selectorDone = true;
          continue;
        }
        printVillageSelectionMenu(villageState);
        const answer = (await askQuestion(menuRl, "Select village number or B: ")).trim().toUpperCase();

        if (answer === "Q") {
          requestQuit();
          selectorDone = true;
          continue;
        }

        if (answer === "B") {
          selectorDone = true;
          continue;
        }

        const index = Number(answer);
        if (!Number.isFinite(index) || index < 1 || index > villageState.villages.length) {
          logWarn("Invalid selection. Enter a listed number or B.");
          continue;
        }

        const nextVillage = villageState.villages[index - 1];
        villageState.selectedVillageId = nextVillage.id;
        const page = getPage();
        if (page && !page.isClosed()) {
          if (!(await waitForActionIdle("Village select"))) {
            logWarn("Could not switch village — session still busy.");
            continue;
          }
          await safeGotoWithRetry(
            page,
            withVillageId(settings.villageStatusUrl, nextVillage.id)
          );
          await refreshVillageState({ navigateToStatusPage: false, silent: true });
        }
        logSuccess(`Selected village context: ${villageDisplayName(nextVillage)}`);
      }
    };

    const normalizeMinuteRange = (minValue, maxValue, fallbackMin, fallbackMax) => {
      let min = Number.isFinite(minValue) ? minValue : fallbackMin;
      let max = Number.isFinite(maxValue) ? maxValue : fallbackMax;
      min = Math.max(1, Math.floor(min));
      max = Math.max(1, Math.floor(max));
      if (min > max) {
        const t = min;
        min = max;
        max = t;
      }
      return { min, max };
    };

    const randomIntBetween = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    const pickNextFarmlistDelayMinutes = (min, max) => {
      let next = randomIntBetween(min, max);
      if (lastFarmlistDelayMinutes !== null && max > min && next === lastFarmlistDelayMinutes) {
        // Keep the timing dynamic by avoiding the same delay twice in a row when possible.
        next = next === max ? next - 1 : next + 1;
      }
      lastFarmlistDelayMinutes = next;
      return next;
    };

    let runRaidGuardPriorityCheck = async () => false;

    /** Auto loops farmlist may cancel so farm raids are not delayed by builder/troop/etc. */
    const isPreemptibleAutoAction = (actionLabel) => {
      const label = String(actionLabel || "").toLowerCase();
      return (
        label === "auto-builder" ||
        label === "auto-troop-trainer" ||
        label === "cranny-defense-rr" ||
        label === "activity-simulation"
      );
    };

    const waitForPreemptedActionRelease = async (requestLabel, preemptedLabel, maxWaitMs = 90000) => {
      cancelRequested = true;
      const stepMs = 400;
      let waited = 0;
      while (actionInProgress && waited < maxWaitMs) {
        await sleep(stepMs);
        waited += stepMs;
      }
      if (actionInProgress) {
        logWarn(
          `[${requestLabel}] ${preemptedLabel} did not release within ${Math.round(maxWaitMs / 1000)}s — skipping this tick.`
        );
        return false;
      }
      return true;
    };

    const waitForActionIdle = async (label = "command", options = {}) => {
      const maxWaitMs = Number.isFinite(Number(options.maxWaitMs))
        ? Math.max(0, Number(options.maxWaitMs))
        : 120000;
      const pollMs = Number.isFinite(Number(options.pollMs))
        ? Math.max(50, Number(options.pollMs))
        : 400;
      const noticeEveryMs = Number.isFinite(Number(options.noticeEveryMs))
        ? Math.max(0, Number(options.noticeEveryMs))
        : maxWaitMs > 15000
          ? 10000
          : 0;
      if (!actionInProgress) {
        return true;
      }
      logInfo(
        `[${label}] Waiting for ${currentActionLabel || "current action"} to finish…`
      );
      let waited = 0;
      let lastNoticeAt = 0;
      while (actionInProgress && waited < maxWaitMs) {
        await sleep(pollMs);
        waited += pollMs;
        if (noticeEveryMs > 0 && waited - lastNoticeAt >= noticeEveryMs) {
          lastNoticeAt = waited;
          logInfo(`[${label}] Still waiting (${Math.round(waited / 1000)}s)…`);
        }
      }
      if (actionInProgress) {
        logWarn(
          `[${label}] Timed out after ${Math.round(maxWaitMs / 1000)}s — ${currentActionLabel || "action"} still running.`
        );
        return false;
      }
      return true;
    };

    const runAction = async (label, fn, options = {}) => {
      const allowWhilePaused = Boolean(options && options.allowWhilePaused);
      const raidGuardPriority = Boolean(options && options.raidGuardPriority);
      const preemptAutoBuilder = Boolean(options && options.preemptAutoBuilder);
      const farmlistPriority = Boolean(options && options.farmlistPriority);
      const automationStatus = runtimeControls.getAutomationStatus
        ? runtimeControls.getAutomationStatus()
        : { paused: false, reason: "online" };
      if (automationStatus.paused && !allowWhilePaused) {
        logInfo(
          `Skipped ${label}: automation is paused (${automationStatus.reason}).`
        );
        return false;
      }

      const canPreemptForFarmlist =
        farmlistPriority &&
        actionInProgress &&
        isPreemptibleAutoAction(currentActionLabel);

      const canPreemptTemplateBuilder =
        !canPreemptForFarmlist &&
        preemptAutoBuilder &&
        actionInProgress &&
        currentActionLabel === "auto-builder";

      if (canPreemptForFarmlist) {
        logInfo(
          `[Farmlist] Pre-empting ${currentActionLabel || "auto loop"} for ${label}…`
        );
        if (!(await waitForPreemptedActionRelease(label, currentActionLabel || "auto loop"))) {
          return false;
        }
      } else if (canPreemptTemplateBuilder) {
        logInfo(
          `[Cranny defense] Pre-empting template builder (${currentActionLabel}) for ${label}…`
        );
        if (!(await waitForPreemptedActionRelease(label, currentActionLabel || "auto-builder"))) {
          return false;
        }
      } else if (actionInProgress) {
        logWarn(
          `Skipped ${label}: another action is currently running (${currentActionLabel || "unknown"}).`
        );
        return false;
      }

      if (raidGuardPriority) {
        try {
          await runRaidGuardPriorityCheck();
        } catch (error) {
          logWarn(
            `[Raid guard] Pre-action check failed: ${error && error.message ? error.message : error}`
          );
        }
      }

      actionInProgress = true;
      currentActionLabel = label;
      cancelRequested = false;
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot({ force: true });
      }
      try {
        await fn();
        if (cancelRequested) {
          throw new MenuInterruptError("Interrupted by user");
        }
        return true;
      } catch (error) {
        if (error instanceof MenuInterruptError) {
          logWarn(`${label} canceled. Back to main menu.`);
          return false;
        }
        throw error;
      } finally {
        actionInProgress = false;
        currentActionLabel = "";
        cancelRequested = false;
        if (dashboardBridge) {
          dashboardBridge.publishSnapshot({ force: true });
        }
      }
    };

    if (typeof runtimeControls.registerAutomationIdleWaiter === "function") {
      runtimeControls.registerAutomationIdleWaiter((label, options) =>
        waitForActionIdle(label, options)
      );
    }

    let lastUserInterruptAt = 0;
    const handleUserInterrupt = () => {
      if (menuRl.closed) {
        return;
      }

      const now = Date.now();
      if (now - lastUserInterruptAt < 200) {
        return;
      }
      lastUserInterruptAt = now;

      if (pendingTerminalAnswer) {
        console.log("");
        logInfo("Ctrl+C pressed. Leaving submenu (Back)...");
        const deliver = pendingTerminalAnswer;
        pendingTerminalAnswer = null;
        deliver("B");
        return;
      }

      if (actionInProgress) {
        cancelRequested = true;
        const currentPage = getPage();
        if (currentPage && !currentPage.isClosed()) {
          currentPage
            .evaluate(() => {
              if (typeof window.stop === "function") {
                window.stop();
              }
            })
            .catch(() => {});
        }

        logWarn("Ctrl+C received. Cancel requested for current activity...");
        return;
      }

      if (dashboardMode) {
        console.log("");
        requestQuit();
        return;
      }

      console.log("");
      logInfo("Ctrl+C pressed. Returning to main menu...");
      try {
        menuRl.write("\n");
      } catch (_error) {
        // Ignore race where readline closes between check and write.
      }
    };

    sigintHandler = handleUserInterrupt;
    process.on("SIGINT", sigintHandler);
    terminalRl.on("SIGINT", sigintHandler);

    const writeAuditEvent = (event) => {
      try {
        const rotation = appendActionLogLine(logFilePath, `${JSON.stringify(event)}\n`);
        if (rotation && rotation.rotated) {
          logInfo(
            `[Log] Rotated — archived to ${path.basename(rotation.archivePath)} (${Math.round((rotation.archivedBytes || 0) / 1024 / 1024)} MB), started fresh ${path.basename(logFilePath)}`
          );
        }
      } catch (error) {
        logWarn(`Failed to write action log: ${error.message || error}`);
      }
    };

    const recordAction = ({ actionType, status, details, durationMs, errorMessage }) => {
      sessionActionCounter += 1;
      writeAuditEvent({
        timestamp: new Date().toISOString(),
        sessionId,
        actionIndex: sessionActionCounter,
        actionType,
        status,
        durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0,
        details: details || {},
        error: errorMessage || null
      });
    };

    const attemptResourceCirculation = async ({
      kind,
      buildResult,
      expansionResult,
      source,
      targetVillage,
      planMode
    }) => {
      const settlement = kind === "settlement";
      const blocker = settlement ? expansionResult : buildResult;

      const okStatus =
        settlement
          ? !!(
            blocker &&
            (
              blocker.status === "need_settlement_resources" ||
              blocker.status === "need_residence_resources" ||
              blocker.status === "need_settler_training_resources"
            )
          )
          : !!(blocker && blocker.status === "blocked_resources");

      if (!okStatus) {
        return { status: "circulation_not_needed" };
      }

      const enabled = settlement ? settings.resourceCirculationExpansionEnabled : settings.resourceCirculationEnabled;
      if (!enabled) {
        const hint = settlement ? "Settings [V]" : "Settings [R]";
        const logPrefix =
          source === "manual"
            ? settlement
              ? "Expansion"
              : "Builder"
            : settlement
              ? "Expansion"
              : "Builder Loop";
        logInfo(`[${logPrefix}] Resource circulation OFF (${hint}); send merchants manually.`);
        return { status: "circulation_disabled" };
      }

      if (!targetVillage || !Number.isFinite(Number(targetVillage.id))) {
        logWarn("[Circulation] No target village selected; skipping.");
        return { status: "circulation_skipped", message: "no_target_village" };
      }

      const logPrefixAuto =
        source === "manual"
          ? settlement
            ? "Expansion"
            : "Builder"
          : settlement
            ? "Expansion Loop"
            : "Builder Loop";

      if (resourceCirculation.isMarketplaceBusy()) {
        logWarn(`[${logPrefixAuto}] Marketplace is busy elsewhere; skipping auto circulation this pass.`);
        return { status: "circulation_skipped", message: "market_busy" };
      }

      await refreshVillageState({
        navigateToStatusPage: !(
          villageState.lastRefreshIso &&
          Date.now() - Date.parse(villageState.lastRefreshIso) < 5 * 60 * 1000
        ),
        silent: true
      }).catch(() => null);

      const deficit = blocker.deficit || {};
      const progressLog = (line) => logInfo(`[${logPrefixAuto}] ${line}`);

      const circulateOptions =
        settlement
          ? {
              targetVillage,
              villages: villageState.villages,
              deficit,
              targetStock: blocker.stock,
              targetWarehouseCap: blocker.warehouseCap,
              targetGranaryCap: blocker.granaryCap,
              progressLog,

              planMode: "village",
              warehouseTopMerchantTrips: Number(settings.resourceCirculationBuilderMerchantLoads)
            }
          : {
              targetVillage,
              villages: villageState.villages,
              deficit,
              targetStock: buildResult.report && buildResult.report.stock,
              targetWarehouseCap: buildResult.report && buildResult.report.warehouseCap,
              targetGranaryCap: buildResult.report && buildResult.report.granaryCap,
              progressLog,
              planMode:
                normalizeBuilderPlanMode(planMode) === "resource" ? "resource" : "village",
              warehouseTopMerchantTrips: Number(settings.resourceCirculationBuilderMerchantLoads)
            };

      logInfo(`[${logPrefixAuto}] Starting automated resource circulation toward ${villageDisplayName(targetVillage)}…`);

      let circ;
      try {
        circ = await resourceCirculation.circulateResourcesForBuild(getPage, settings, circulateOptions);
      } catch (err) {
        if (isResourceExhaustionError(err)) {
          logWarn(
            `[${logPrefixAuto}] Browser resource pressure (${err.message || err}) — waiting 15s and retrying circulation once…`
          );
          const page = getPage();
          if (page && !page.isClosed()) {
            await page.waitForTimeout(15000).catch(() => null);
          }
          try {
            circ = await resourceCirculation.circulateResourcesForBuild(getPage, settings, circulateOptions);
          } catch (retryErr) {
            const msg = retryErr && retryErr.message ? retryErr.message : String(retryErr);
            logError(`[${logPrefixAuto}] Circulation failed after retry: ${msg}`);
            if (runtimeControls.reloginNow && isResourceExhaustionError(retryErr)) {
              logWarn(`[${logPrefixAuto}] Requesting browser restart to recover resources…`);
              try {
                await runtimeControls.reloginNow("resource_circulation_exhaustion");
              } catch (reloginError) {
                logWarn(
                  `[${logPrefixAuto}] Browser restart failed: ${reloginError.message || reloginError}`
                );
              }
            }
            await restoreSelectedVillageContext(`${logPrefixAuto} Circulation`).catch(() => null);
            return { status: "circulation_failed", message: msg };
          }
        } else {
          const msg = err && err.message ? err.message : String(err);
          logError(`[${logPrefixAuto}] Circulation failed: ${msg}`);
          await restoreSelectedVillageContext(`${logPrefixAuto} Circulation`).catch(() => null);
          return { status: "circulation_failed", message: msg };
        }
      }

      await restoreSelectedVillageContext(`${logPrefixAuto} Circulation`).catch(() => null);

      if (!circ || circ.status === "circulation_skipped") {
        logWarn(`[${logPrefixAuto}] ${(circ && circ.message) || "Circulation skipped."}`);
        return circ || { status: "circulation_skipped" };
      }

      if (circ.status === "transfer_sent") {
        logSuccess(`[${logPrefixAuto}] ${circ.message}`);
        recordAction({
          actionType: "resource.transfer",
          status: "success",
          durationMs: 0,
          details: {
            source: settlement ? "settlement_prep" : "builder",
            trigger: source === "manual" ? "manual" : "auto-loop",
            etaMinutes: circ.etaMinutes,
            shipmentCount: Array.isArray(circ.shipments) ? circ.shipments.length : 0,
            villageId: targetVillage.id,
            villageName: targetVillage.name,
            ...(circ.remainingDeficit ? { remainingDeficit: circ.remainingDeficit } : {})
          }
        });
        const etaMs = Math.max(
          Number.isFinite(Number(circ.etaMinutes)) ? Math.ceil(Number(circ.etaMinutes)) * 60 * 1000 : 5 * 60 * 1000,
          60 * 1000
        );
        pendingMerchantArrivalByVillage.set(targetVillage.id, Date.now() + etaMs);
        return circ;
      }

      logWarn(`[${logPrefixAuto}] Unexpected circulation result: ${circ.status || "?"} (${circ.message || ""})`);
      return circ;
    };

    const resolveRaidEvacuationPivotVillage = (sourceVillage) => {
      const villages = Array.isArray(villageState.villages) ? villageState.villages : [];
      if (!villages.length) {
        return null;
      }
      const sourceId = sourceVillage && Number.isFinite(Number(sourceVillage.id))
        ? Number(sourceVillage.id)
        : null;
      const pivotSet = parsePivotVillageIdSet(settings.raidEvacuationPivotVillageIds);
      const matchesPivot = villages.filter((v) => pivotSet.has(Number(v.id)));
      const notSource = (v) => Number(v.id) !== sourceId;

      const chosenPivot =
        matchesPivot.find(notSource) ||
        villages.find((v) => v.isCapital && notSource(v)) ||
        villages.find((v) => notSource(v)) ||
        null;
      return chosenPivot;
    };

    const attemptRaidEvacuationForAllVillages = async () => {
      if (settings.raidEvacuationEnabled === false) {
        return { status: "evacuation_disabled", results: [], handledNearImpact: false };
      }
      if (!villageState.villages.length) {
        return { status: "evacuation_no_villages", results: [], handledNearImpact: false };
      }
      if (resourceCirculation.isMarketplaceBusy && resourceCirculation.isMarketplaceBusy()) {
        return { status: "evacuation_market_busy", results: [], handledNearImpact: false };
      }

      const triggerMinutes = Number.isFinite(Number(settings.raidEvacuationTriggerMinutes))
        ? Math.max(1, Math.floor(Number(settings.raidEvacuationTriggerMinutes)))
        : 30;
      const reservePerResource = Number.isFinite(Number(settings.raidEvacuationReservePerResource))
        ? Math.max(0, Math.floor(Number(settings.raidEvacuationReservePerResource)))
        : 300;
      const nowTs = Date.now();
      const results = [];
      let handledNearImpact = false;

      const page = getPage();
      if (page && !page.isClosed()) {
        const vlistCount = await page.locator("#vlist tr[data-vid]").count().catch(() => 0);
        await refreshVillageState({ navigateToStatusPage: !vlistCount, silent: true }).catch(() => null);
      }

      const villagesToCheck = villageState.villages.filter((v) => v && v.underAttack);
      if (!villagesToCheck.length) {
        return { status: "evacuation_checked", results, handledNearImpact: false };
      }

      for (const village of villagesToCheck) {
        if (!village || !Number.isFinite(Number(village.id))) {
          continue;
        }

        const alerts = await readIncomingAttackAlerts(getPage, settings, village.id).catch(() => []);
        if (!alerts.length) {
          raidEvacuationByVillage.delete(village.id);
          continue;
        }

        const nearest = alerts[0];
        const nearestMinutes = Math.max(1, Math.ceil((Number(nearest.etaSeconds) || 0) / 60));
        if (!(nearestMinutes <= triggerMinutes)) {
          continue;
        }

        const lock = raidEvacuationByVillage.get(village.id);
        if (lock && Number.isFinite(lock.nextAttemptAt) && lock.nextAttemptAt > nowTs) {
          const prevLog = Number(raidEvacuationSkipLogAtByVillage.get(village.id) || 0);
          if (!Number.isFinite(prevLog) || nowTs - prevLog > 120000) {
            raidEvacuationSkipLogAtByVillage.set(village.id, nowTs);
            const waitSec = Math.max(1, Math.ceil((lock.nextAttemptAt - nowTs) / 1000));
            logInfo(
              `[Raid Evacuation] ${villageDisplayName(village)} already handled recently; ` +
                `retry allowed in ${waitSec}s.`
            );
          }
          continue;
        }

        const pivotVillage = resolveRaidEvacuationPivotVillage(village);
        if (!pivotVillage) {
          continue;
        }
        if (Number(pivotVillage.id) === Number(village.id)) {
          continue;
        }

        try {
          const executed = await runAction(
            `raid-evacuation-${village.id}`,
            async () => {
              await ensureVillageBrowserContext(village, "Raid Evacuation");
              const evac = await resourceCirculation.evacuateResourcesFromVillage({
                getPage,
                settings,
                sourceVillage: village,
                pivotVillage,
                attackAlerts: alerts,
                triggerEtaMinutes: nearestMinutes,
                reservePerResource,
                crannyKeepRatio: 0.8,
                nowTs,
                log: (m) => logInfo(m)
              });
              let troopEvac = {
                status: "troop_evac_skipped",
                message: "Troop evacuation disabled."
              };
              if (settings.raidEvacuationTroopsEnabled !== false) {
                troopEvac = await evacuateTroopsToPivot(
                  getPage,
                  settings,
                  village,
                  pivotVillage,
                  {
                    attackAlerts: alerts,
                    triggerEtaMinutes: nearestMinutes,
                    recallAfterSeconds: settings.raidEvacuationTroopRecallSeconds
                  }
                );
                if (troopEvac.status === "troop_evac_sent") {
                  logSuccess(`[Raid Evacuation] ${troopEvac.message}`);
                } else {
                  logInfo(`[Raid Evacuation] ${troopEvac.message}`);
                }
              }
              results.push({
                villageId: village.id,
                villageName: village.name,
                pivotVillageId: pivotVillage.id,
                pivotVillageName: pivotVillage.name,
                nearestMinutes,
                result: evac,
                troopEvacuation: troopEvac
              });

              if (evac && evac.status === "evacuation_sent") {
                handledNearImpact = true;
                raidEvacuationByVillage.set(village.id, {
                  nextAttemptAt: Date.now() + 120000
                });
                logSuccess(`[Raid Evacuation] ${evac.message}`);
                recordAction({
                  actionType: "resource.evacuation",
                  status: "success",
                  durationMs: 0,
                  details: {
                    source: "raid-guard",
                    villageId: village.id,
                    villageName: village.name || null,
                    pivotVillageId: pivotVillage.id,
                    pivotVillageName: pivotVillage.name || null,
                    triggerMinutes,
                    nearestImpactMinutes: nearestMinutes,
                    keepRatio: 0.8,
                    reservePerResource,
                    sent: evac.sent || null,
                    troopEvacuation: troopEvac && troopEvac.status ? troopEvac.status : "n/a",
                    troopEvacuationSent: troopEvac && Number.isFinite(Number(troopEvac.totalSent))
                      ? Number(troopEvac.totalSent)
                      : 0
                  }
                });
              } else if (troopEvac && troopEvac.status === "troop_evac_sent") {
                handledNearImpact = true;
              } else {
                const msg = (evac && evac.message) || (evac && evac.status) || "evacuation skipped";
                logWarn(`[Raid Evacuation] ${villageDisplayName(village)}: ${msg}`);
              }
            },
            { raidGuardPriority: true }
          );
          if (!executed) {
            continue;
          }
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          logWarn(`[Raid Evacuation] Failed for ${villageDisplayName(village)}: ${message}`);
          recordAction({
            actionType: "resource.evacuation",
            status: "failed",
            durationMs: 0,
            details: {
              source: "raid-guard",
              villageId: village.id,
              villageName: village.name || null,
              pivotVillageId: pivotVillage.id,
              pivotVillageName: pivotVillage.name || null
            },
            errorMessage: message
          });
        }
      }

      return { status: "evacuation_checked", results, handledNearImpact };
    };

    runRaidGuardPriorityCheck = async () => {
      if (settings.raidEvacuationEnabled === false || actionInProgress) {
        return false;
      }
      const result = await attemptRaidEvacuationForAllVillages();
      return Boolean(result && result.handledNearImpact);
    };

    const summarizeActions = async () => {
      const summary = {
        totalActions: 0,
        successfulActions: 0,
        failedActions: 0,
        buildingUpgradeFails: 0,
        thisSessionActions: 0,
        byType: {
          "farmlist.send": 0,
          "troop.train": 0,
          "building.upgrade": 0,
          "building.gold_complete": 0,
          "village.builder.open": 0,
          "resource.transfer": 0,
          "resource.evacuation": 0
        },
        totals: {
          goldCompletions: 0,
          goldSpent: 0,
          transferShipments: 0,
          evacuationSends: 0
        },
        recentBuilds: []
      };

      if (!fs.existsSync(logFilePath)) {
        return summary;
      }

      const ingestEvent = (event) => {
        summary.totalActions += 1;
        if (event.status === "success") {
          summary.successfulActions += 1;
        }
        if (event.status === "failed") {
          summary.failedActions += 1;
        }
        if (event.actionType === "building.upgrade" && event.status === "failed") {
          summary.buildingUpgradeFails += 1;
        }
        if (event.sessionId === sessionId) {
          summary.thisSessionActions += 1;
        }
        if (event.actionType && Object.prototype.hasOwnProperty.call(summary.byType, event.actionType)) {
          summary.byType[event.actionType] += 1;
        }
        if (event.actionType === "building.gold_complete" && event.status === "success") {
          summary.totals.goldCompletions += Number((event.details && event.details.completions) || 0);
          summary.totals.goldSpent += Number((event.details && event.details.goldSpent) || 0);
        }
        if (event.actionType === "resource.transfer" && event.status === "success") {
          summary.totals.transferShipments += Number((event.details && event.details.shipmentCount) || 0);
        }
        if (event.actionType === "resource.evacuation" && event.status === "success") {
          summary.totals.evacuationSends += 1;
        }
        if (
          (event.actionType === "building.upgrade" || event.actionType === "building.gold_complete") &&
          event.status === "success"
        ) {
          summary.recentBuilds.push({
            timestamp: event.timestamp,
            building: (event.details && event.details.building) || "?",
            slot: (event.details && event.details.slot) || "?",
            fromLevel: (event.details && event.details.fromLevel) || "?",
            toLevel: (event.details && event.details.toLevel) || "?",
            village: (event.details && event.details.villageName) || "?",
            type: event.actionType
          });
          if (summary.recentBuilds.length > 40) {
            summary.recentBuilds.splice(0, summary.recentBuilds.length - 40);
          }
        }
      };

      await forEachLogLine(logFilePath, ingestEvent);
      return summary;
    };

    const showLogSummary = async () => {
      const summary = await summarizeActions();
      const archives = listArchivedLogs(logFilePath);
      printDivider("ACTION LOG SUMMARY");
      printKeyValueRows([
        { label: "Log file", value: logFilePath },
        { label: "Archive folder", value: resolveArchiveDir(logFilePath) },
        { label: "Archived files", value: archives.length ? String(archives.length) : "none" },
        { label: "Retention", value: "Current log rotates when over size limit; old files kept in archive" },
        { label: "Total actions", value: String(summary.totalActions) },
        { label: "This session", value: String(summary.thisSessionActions) },
        { label: "Successful", value: String(summary.successfulActions) },
        { label: "Failed", value: String(summary.failedActions) },
        { label: "Farmlist sends", value: String(summary.byType["farmlist.send"] || 0) },
        { label: "Troop trainings", value: String(summary.byType["troop.train"] || 0) },
        { label: "Building upgrades", value: String(summary.byType["building.upgrade"] || 0) },
        { label: "Building upgrade fails", value: String(summary.buildingUpgradeFails || 0) },
        { label: "Autocomplete actions", value: String(summary.byType["building.gold_complete"] || 0) },
        { label: "Autocompletes used", value: String(summary.totals.goldCompletions || 0) },
        { label: "Gold spent", value: String(summary.totals.goldSpent || 0) },
        { label: "Builder opens", value: String(summary.byType["village.builder.open"] || 0) },
        { label: "Merchant transfer events", value: String(summary.byType["resource.transfer"] || 0) },
        { label: "Transfer shipment batches", value: String(summary.totals.transferShipments || 0) },
        { label: "Raid evacuation events", value: String(summary.byType["resource.evacuation"] || 0) },
        { label: "Raid evacuation sends", value: String(summary.totals.evacuationSends || 0) }
      ]);

      // Show last 5 building actions
      if (summary.recentBuilds.length > 0) {
        printSubDivider("RECENT BUILDING ACTIONS");
        const recent = summary.recentBuilds.slice(-5);
        recent.forEach((b) => {
          const ts = b.timestamp ? b.timestamp.replace("T", " ").slice(0, 19) : "?";
          const typeLabel = b.type === "building.gold_complete"
            ? color("[GOLD]", ANSI.yellow, ANSI.bold)
            : "";
          console.log(
            `  ${color(ts, ANSI.gray)} ${b.building} slot ${b.slot} ${b.fromLevel}->${b.toLevel} ${color(`(${b.village})`, ANSI.dim)} ${typeLabel}`
          );
        });
      }
    };

    logInfo(`[Log] ${path.basename(logFilePath)}`);
    try {
      const startupRotation = maybeRotateActionLog(logFilePath);
      if (startupRotation.rotated) {
        logInfo(
          `[Log] Rotated on startup — archived to ${path.basename(startupRotation.archivePath)} (${Math.round((startupRotation.archivedBytes || 0) / 1024 / 1024)} MB), fresh ${path.basename(logFilePath)}`
        );
      }
    } catch (error) {
      logWarn(`[Log] Startup rotation check failed: ${error.message || error}`);
    }

    const cancelFarmlistLoopTimer = () => {
      if (farmlistLoopTimer) {
        clearTimeout(farmlistLoopTimer);
        farmlistLoopTimer = null;
      }
      nextFarmlistRunAt = null;
    };

    const scheduleFarmlistLoop = () => {
      cancelFarmlistLoopTimer();

      const normalized = normalizeMinuteRange(
        settings.farmlistLoopMinMinutes,
        settings.farmlistLoopMaxMinutes,
        10,
        20
      );
      settings.farmlistLoopMinMinutes = normalized.min;
      settings.farmlistLoopMaxMinutes = normalized.max;

      if (!settings.farmlistLoopEnabled || done) {
        return;
      }

      const minutes = pickNextFarmlistDelayMinutes(
        settings.farmlistLoopMinMinutes,
        settings.farmlistLoopMaxMinutes
      );
      farmlistResumeWaitLogged = false;
      farmlistShortRetriesLeft = 2;
      nextFarmlistRunAt = Date.now() + minutes * 60 * 1000;
      logInfo(`[Farmlist Loop] Next auto-send in ${minutes} minute(s).`);

      const scheduleFarmlistShortRetry = (reason) => {
        const delayMs = FARMLIST_SHORT_RETRY_MS;
        nextFarmlistRunAt = Date.now() + delayMs;
        if (farmlistShortRetriesLeft > 0) {
          farmlistShortRetriesLeft -= 1;
          logWarn(
            `[Farmlist Loop] ${reason} Retrying in ${Math.round(delayMs / 60000)} minute(s) (${farmlistShortRetriesLeft} short retries left).`
          );
          farmlistLoopTimer = setTimeout(() => void runFarmlistScheduledTick(), delayMs);
          return;
        }
        logWarn(`[Farmlist Loop] ${reason} Short retries exhausted — scheduling normal interval.`);
        scheduleFarmlistLoop();
      };

      const runFarmlistSendCore = async (attemptLabel) => {
        const startedAt = Date.now();
        const executed = await runAction(attemptLabel, async () => {
          logInfo("[Farmlist Loop] Auto-send starting...");
          const sendResult = await runWithRandomDelay(
            settings,
            "Auto Send Farmlists",
            () => sendFarmlists(getPage, settings, { villageId: resolveFarmlistVillageId() }),
            () => cancelRequested
          );
          if (sendResult && sendResult.status === "idle") {
            logInfo(`[Farmlist Loop] ${String(sendResult.message || "Nothing to send.").replace(/^\[Farmlist\]\s*/, "")}`);
          } else {
            logSuccess("[Farmlist Loop] Auto-send completed.");
          }
          await maybePrintAutoFarmlistStatus("Farmlist Loop");
          return sendResult;
        }, { raidGuardPriority: true, farmlistPriority: true });
        return { executed, startedAt };
      };

      const runFarmlistScheduledTick = async () => {
        if (done || !settings.farmlistLoopEnabled) {
          scheduleFarmlistLoop();
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };

        if (automationStatus.paused) {
          nextFarmlistRunAt = null;
          if (!farmlistResumeWaitLogged) {
            logInfo(
              `[Farmlist Loop] Paused (${automationStatus.reason}). Waiting for session to resume...`
            );
            farmlistResumeWaitLogged = true;
          }

          farmlistLoopTimer = setTimeout(() => {
            if (!done && settings.farmlistLoopEnabled) {
              scheduleFarmlistLoop();
            }
          }, 15000);
          return;
        }

        let farmlistExecuted = false;
        try {
          const { executed, startedAt } = await runFarmlistSendCore("auto-send farmlists");
          farmlistExecuted = executed;
          if (!farmlistExecuted) {
            scheduleFarmlistShortRetry("Auto-send skipped.");
            return;
          }
          recordAction({
            actionType: "farmlist.send",
            status: "success",
            durationMs: Date.now() - startedAt,
            details: {
              source: "auto-loop",
              minMinutes: settings.farmlistLoopMinMinutes,
              maxMinutes: settings.farmlistLoopMaxMinutes,
              ...getVillageMeta("all")
            }
          });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          const isIdleNothingToSend = /no farmlists ready to send|nothing to send/i.test(message);
          if (isIdleNothingToSend) {
            logInfo(`[Farmlist Loop] ${message}`);
            recordAction({
              actionType: "farmlist.send",
              status: "info",
              durationMs: 0,
              details: {
                source: "auto-loop",
                idle: true,
                ...getVillageMeta("all")
              }
            });
            await restoreSelectedVillageContext("Farmlist Loop").catch(() => null);
            scheduleFarmlistLoop();
            return;
          }
          const isTransientSessionState =
            /has been closed|context or browser has been closed|Session page is currently unavailable|net::ERR_ABORTED|interrupted by another navigation/i.test(
              message
            );
          const isLoggedOutState =
            /Farmlist page unavailable \(likely redirected\/out of session\)|\/index\.php/i.test(
              message
            );

          if (isLoggedOutState && runtimeControls.reloginNow) {
            logWarn(`[Farmlist Loop] ${message}`);
            try {
              await runtimeControls.reloginNow("farmlist_loop_logged_out");
              logSuccess("[Farmlist Loop] Re-login complete. Retrying auto-send now...");

              const retryStartedAt = Date.now();
              const { executed: retryExecuted } = await runFarmlistSendCore("auto-send farmlists retry");

              if (retryExecuted) {
                recordAction({
                  actionType: "farmlist.send",
                  status: "success",
                  durationMs: Date.now() - retryStartedAt,
                  details: {
                    source: "auto-loop-retry",
                    minMinutes: settings.farmlistLoopMinMinutes,
                    maxMinutes: settings.farmlistLoopMaxMinutes,
                    ...getVillageMeta("all")
                  }
                });
                farmlistExecuted = true;
              }

              if (farmlistExecuted) {
                await restoreSelectedVillageContext("Farmlist Loop");
                scheduleFarmlistLoop();
                return;
              }
              scheduleFarmlistShortRetry("Auto-send failed after re-login.");
              return;
            } catch (reloginError) {
              const reloginMessage =
                reloginError && reloginError.message ? reloginError.message : String(reloginError);
              recordAction({
                actionType: "farmlist.send",
                status: "failed",
                durationMs: 0,
                details: {
                  source: "auto-loop",
                  ...getVillageMeta("all")
                },
                errorMessage: `${message} | relogin failed: ${reloginMessage}`
              });
              logError(`[Farmlist Loop] Re-login/retry failed: ${reloginMessage}`);
              scheduleFarmlistShortRetry(`Re-login failed: ${reloginMessage}`);
              return;
            }
          } else {
            recordAction({
              actionType: "farmlist.send",
              status: "failed",
              durationMs: 0,
              details: {
                source: "auto-loop",
                ...getVillageMeta("all")
              },
              errorMessage: message
            });
            if (isTransientSessionState) {
              logWarn(`[Farmlist Loop] Auto-send failed (transient): ${message}`);
            } else {
              logError(`[Farmlist Loop] Auto-send failed: ${message}`);
            }
            scheduleFarmlistShortRetry(`Send failed: ${message}`);
            return;
          }
        }

        if (farmlistExecuted) {
          await restoreSelectedVillageContext("Farmlist Loop");
        }
        scheduleFarmlistLoop();
      };

      farmlistLoopTimer = setTimeout(() => void runFarmlistScheduledTick(), minutes * 60 * 1000);
    };

    const cancelBuilderLoopTimer = () => {
      if (builderLoopTimer) {
        clearTimeout(builderLoopTimer);
        builderLoopTimer = null;
      }
      nextBuilderRunAt = null;
    };

    const pickNextBuilderDelayMinutes = (min, max) => {
      let next = randomIntBetween(min, max);
      if (lastBuilderDelayMinutes !== null && max > min && next === lastBuilderDelayMinutes) {
        next = next === max ? next - 1 : next + 1;
      }
      lastBuilderDelayMinutes = next;
      return next;
    };

    const scheduleBuilderLoop = () => {
      cancelBuilderLoopTimer();

      const normalized = normalizeMinuteRange(
        settings.builderLoopMinMinutes,
        settings.builderLoopMaxMinutes,
        5,
        10
      );
      settings.builderLoopMinMinutes = normalized.min;
      settings.builderLoopMaxMinutes = normalized.max;

      if (!settings.builderLoopEnabled || done) {
        return;
      }

      if (!villageState.villages.length) {
        const now = Date.now();
        if (
          !Number.isFinite(builderVillageWaitLastLogAt) ||
          now - builderVillageWaitLastLogAt > 120000
        ) {
          builderVillageWaitLastLogAt = now;
          logInfo(
            "[Builder Loop] Village list is empty (not loaded yet). Retrying in 30s..."
          );
        }
        builderLoopTimer = setTimeout(() => {
          if (!done && settings.builderLoopEnabled) {
            scheduleBuilderLoop();
          }
        }, 30000);
        return;
      }

      if (!settings.builderRoundRobinEnabled) {
        const fallback = resolveBuilderFallbackVillage();
        if (fallback && villageState.selectedVillageId !== fallback.id) {
          villageState.selectedVillageId = fallback.id;
        }
      }

      const minutes = pickNextBuilderDelayMinutes(
        settings.builderLoopMinMinutes,
        settings.builderLoopMaxMinutes
      );
      const activePlan = getBuilderPlanMeta(activeBuilderPlanMode);
      builderResumeWaitLogged = false;
      nextBuilderRunAt = Date.now() + minutes * 60 * 1000;
      const schedulePlanLabel = builderRrUsesResourceThenVillagePipeline()
        ? "resource→village"
        : activePlan.short;
      logInfo(`[Builder Loop] Next auto-build (${schedulePlanLabel}) in ${minutes} minute(s).`);

      const runBuilderScheduledTick = async () => {
        if (done || !settings.builderLoopEnabled) {
          scheduleBuilderLoop();
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };

        if (automationStatus.paused) {
          nextBuilderRunAt = null;
          if (!builderResumeWaitLogged) {
            logInfo(
              `[Builder Loop] Paused (${automationStatus.reason}). Waiting for session to resume...`
            );
            builderResumeWaitLogged = true;
          }

          builderLoopTimer = setTimeout(() => {
            if (!done && settings.builderLoopEnabled) {
              scheduleBuilderLoop();
            }
          }, 15000);
          return;
        }

        if (settings.crannyDefenseRoundRobinEnabled) {
          if (!builderTemplateDeferredForCrannyLogged) {
            builderTemplateDeferredForCrannyLogged = true;
            logInfo(
              "[Builder Loop] Template auto-build is suspended while Cranny defense RR is ON (Settings [I] to turn off)."
            );
          }
          scheduleBuilderLoop();
          return;
        }
        builderTemplateDeferredForCrannyLogged = false;

        let targetVillage;
        let roundRobinAdvanceStep = 1;
        if (settings.builderRoundRobinEnabled && villageState.villages.length > 0) {
          const excludedVillageIds = parsePivotVillageIdSet(settings.builderRoundRobinExcludedVillageIds);
          const nonCapitalVillages = villageState.villages.filter((village) => !village.isCapital);
          const rrCandidateVillages = nonCapitalVillages.filter(
            (village) =>
              !excludedVillageIds.has(Number(village.id)) && villageHasPendingBuilderWork(village)
          );
          if (!rrCandidateVillages.length) {
            if (nonCapitalVillages.length) {
              logInfo(
                builderRrUsesResourceThenVillagePipeline()
                  ? "[Builder Loop] All non-capital villages finished resource fields + village stage plans."
                  : `[Builder Loop] All non-capital villages are complete for ${getBuilderPlanMeta(activeBuilderPlanMode).short} plan. Waiting for next changes.`
              );
            } else {
              logWarn("[Builder Loop] No non-capital villages available for template auto-build. Skipping.");
            }
            scheduleBuilderLoop();
            return;
          }
          const totalVillages = rrCandidateVillages.length;
          const now = Date.now();
          let earliestBlockedUntil = null;

          for (let offset = 0; offset < totalVillages; offset += 1) {
            const candidate = rrCandidateVillages[(roundRobinIndex + offset) % totalVillages];
            const merchantWaitUntil = pendingMerchantArrivalByVillage.get(candidate.id);
            const cooldownUntil = builderVillageCooldownUntilByVillage.get(candidate.id);
            const blockedUntil = Math.max(
              Number.isFinite(merchantWaitUntil) ? merchantWaitUntil : 0,
              Number.isFinite(cooldownUntil) ? cooldownUntil : 0
            );

            if (!Number.isFinite(blockedUntil) || blockedUntil <= now) {
              targetVillage = candidate;
              roundRobinAdvanceStep = offset + 1;
              break;
            }
            earliestBlockedUntil = earliestBlockedUntil === null
              ? blockedUntil
              : Math.min(earliestBlockedUntil, blockedUntil);
          }

          if (!targetVillage) {
            const delayMs = Math.max(
              30000,
              (Number.isFinite(earliestBlockedUntil) ? earliestBlockedUntil - now : 60000) + 10000
            );
            builderEfficiencyWindow.skippedCooldown += 1;
            maybeLogBuilderEfficiencyWindow();
            logInfo(
              `[Builder Loop] All RR villages are waiting (merchant/cooldown). Retrying in ~${Math.max(
                1,
                Math.ceil(delayMs / 60000)
              )} min...`
            );
            nextBuilderRunAt = now + delayMs;
            builderLoopTimer = setTimeout(() => void runBuilderScheduledTick(), delayMs);
            return;
          }
        } else {
          targetVillage = resolveBuilderFallbackVillage();
        }

        if (!targetVillage) {
          logWarn("[Builder Loop] No village available for auto-build. Skipping.");
          scheduleBuilderLoop();
          return;
        }

        const now = Date.now();
        const merchantWaitUntil = pendingMerchantArrivalByVillage.get(targetVillage.id);
        const cooldownUntil = builderVillageCooldownUntilByVillage.get(targetVillage.id);
        const blockedUntil = Math.max(
          Number.isFinite(merchantWaitUntil) ? merchantWaitUntil : 0,
          Number.isFinite(cooldownUntil) ? cooldownUntil : 0
        );
        if (Number.isFinite(blockedUntil) && now < blockedUntil) {
          const delayMs = Math.max(30000, blockedUntil - now + 10000);
          builderEfficiencyWindow.skippedCooldown += 1;
          maybeLogBuilderEfficiencyWindow();
          logInfo(
            `[Builder Loop] ${villageDisplayName(targetVillage)} still in cooldown/wait state. Retrying in ~${Math.max(
              1,
              Math.ceil(delayMs / 60000)
            )} min...`
          );
          nextBuilderRunAt = now + delayMs;
          builderLoopTimer = setTimeout(() => void runBuilderScheduledTick(), delayMs);
          return;
        }
        if (Number.isFinite(merchantWaitUntil)) {
          const now = Date.now();
          if (now < merchantWaitUntil) {
            const delayMs = Math.max(30000, merchantWaitUntil - now + 20000);
            logInfo(
              `[Builder Loop] Waiting ~${Math.max(1, Math.ceil(delayMs / 60000))} min for merchants to arrive at ${villageDisplayName(
                targetVillage
              )} before building again…`
            );
            nextBuilderRunAt = now + delayMs;
            builderLoopTimer = setTimeout(() => void runBuilderScheduledTick(), delayMs);
            return;
          }
          pendingMerchantArrivalByVillage.delete(targetVillage.id);
        }

        let shouldFastRetryDifferentVillage = false;
        try {
          const startedAt = Date.now();
          const executed = await runAction("auto-builder", async () => {
            let loopPlan = getBuilderPlanMeta(
              resolveBuilderPlanModeForVillage(targetVillage) || activeBuilderPlanMode
            );
            builderEfficiencyWindow.attempts += 1;
            await ensureVillageBrowserContext(targetVillage, "Builder Loop");
            logInfo(`[Builder Loop] Auto-build (${loopPlan.short}) starting for ${villageDisplayName(targetVillage)}...`);
            const result = await runWithRandomDelay(
              settings,
              `Auto Builder (${loopPlan.short})`,
              () =>
                builder.runBuilderStep(getPage, settings, targetVillage, {
                  goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                  goldCompleteMax: settings.builderGoldCompleteMax,
                  masterBuilderEnabled: settings.builderMasterBuilderEnabled,
                  planMode: loopPlan.key
                }),
              () => cancelRequested
            );

            let finalResult = result;
            const maxFollowupAttempts = 20;
            const maxFollowupElapsedMs = 120000;
            let followupAttempt = 0;
            while (followupAttempt < maxFollowupAttempts) {
              if (Date.now() - startedAt > maxFollowupElapsedMs) {
                logInfo("[Builder Loop] Follow-up retry budget reached for this tick. Continuing on next cycle.");
                break;
              }

              if (
                finalResult &&
                finalResult.status === "all_complete" &&
                loopPlan.key === "resource" &&
                builderRrUsesResourceThenVillagePipeline() &&
                !isBuilderPlanFullyComplete(targetVillage, "village")
              ) {
                loopPlan = getBuilderPlanMeta("village");
                logInfo(
                  `[Builder Loop] Resource fields complete for ${villageDisplayName(targetVillage)} — continuing with village stage plan.`
                );
                await ensureVillageBrowserContext(targetVillage, "Builder Loop");
                finalResult = await builder.runBuilderStep(getPage, settings, targetVillage, {
                  goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                  goldCompleteMax: settings.builderGoldCompleteMax,
                  masterBuilderEnabled: settings.builderMasterBuilderEnabled,
                  planMode: loopPlan.key
                });
                followupAttempt += 1;
                continue;
              }

              if (
                !finalResult ||
                !(
                  finalResult.status === "already_satisfied" ||
                  finalResult.status === "template_complete" ||
                  finalResult.status === "realigned_template"
                )
              ) {
                break;
              }

              const followupTag =
                finalResult.status === "realigned_template" ? "realigned_template" : "progress_advanced";
              logInfo(`[Builder Loop] ${followupTag}: ${finalResult.message} Retrying next step...`);
              await ensureVillageBrowserContext(targetVillage, "Builder Loop");
              finalResult = await builder.runBuilderStep(getPage, settings, targetVillage, {
                goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                goldCompleteMax: settings.builderGoldCompleteMax,
                masterBuilderEnabled: settings.builderMasterBuilderEnabled,
                planMode: loopPlan.key
              });
              followupAttempt += 1;
            }

            if (finalResult.status === "realigned_template") {
              const streak = incrementRealignStreak(targetVillage.id, loopPlan.key);
              if (streak >= 3) {
                logWarn(
                  `[Builder Loop] repeated_realign (${streak}): ${villageDisplayName(targetVillage)} in ${loopPlan.short} plan keeps realigning. ` +
                  "Likely unmet prerequisites (e.g. Main Building level or required resource-field levels)."
                );
              }
            } else {
              resetRealignStreak(targetVillage.id, loopPlan.key);
            }

            if (finalResult.status === "blocked_resources") {
              logInfo(`[Builder Loop] ${finalResult.message}`);
              await attemptResourceCirculation({
                kind: "builder",
                buildResult: finalResult,
                source: "auto-loop",
                targetVillage,
                planMode: loopPlan.key
              });
            }

            const cooldownMs = getBuilderCooldownMsForStatus(finalResult.status);
            if (cooldownMs > 0) {
              builderVillageCooldownUntilByVillage.set(targetVillage.id, Date.now() + cooldownMs);
            } else {
              builderVillageCooldownUntilByVillage.delete(targetVillage.id);
            }

            // If this village is temporarily blocked (queue full / MB-only / etc.),
            // immediately move on to another unfinished village rather than waiting
            // the full builder interval.
            if (
              settings.builderRoundRobinEnabled &&
              (String(finalResult.status || "").startsWith("blocked_") || finalResult.status === "idle_saturated") &&
              villageState.villages.length > 1
            ) {
              shouldFastRetryDifferentVillage = true;
            }

            if (finalResult.status === "success") {
              builderEfficiencyWindow.success += 1;
              logSuccess(`[Builder Loop] ${finalResult.message}`);
              recordAction({
                actionType: "building.upgrade",
                status: "success",
                durationMs: Date.now() - startedAt,
                details: {
                  source: "auto-loop",
                  planMode: loopPlan.key,
                  ...finalResult.report,
                  ...getVillageMeta("single")
                }
              });
            } else if (finalResult.status === "template_complete" || finalResult.status === "all_complete") {
              logSuccess(`[Builder Loop] ${finalResult.message}`);
            } else {
              if (String(finalResult.status || "").startsWith("blocked_") || finalResult.status === "idle_saturated") {
                builderEfficiencyWindow.blocked += 1;
              }
              logInfo(`[Builder Loop] ${finalResult.message}`);
            }
            maybeLogBuilderEfficiencyWindow();
          }, { raidGuardPriority: true });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          recordAction({
            actionType: "building.upgrade",
            status: "failed",
            durationMs: 0,
            details: {
              source: "auto-loop",
              planMode: normalizeBuilderPlanMode(activeBuilderPlanMode),
              ...getVillageMeta("single")
            },
            errorMessage: message
          });
          const isTransientSessionState =
            /has been closed|context or browser has been closed|Session page is currently unavailable|ERR_ABORTED|ERR_INSUFFICIENT_RESOURCES|interrupted by another navigation|Execution context was destroyed/i.test(
              message
            );
          if (isTransientSessionState) {
            logWarn(`[Builder Loop] Auto-build skipped: ${message}`);
          } else {
            logError(`[Builder Loop] Auto-build failed: ${message}`);
          }
        }

        if (settings.builderRoundRobinEnabled) {
          roundRobinIndex += Math.max(1, roundRobinAdvanceStep);
        }
        await restoreSelectedVillageContext("Builder Loop");
        if (shouldFastRetryDifferentVillage) {
          const delayMs = 5000;
          nextBuilderRunAt = Date.now() + delayMs;
          logInfo("[Builder Loop] Switching villages (RR) due to temporary block. Retrying in ~5s...");
          builderLoopTimer = setTimeout(() => void runBuilderScheduledTick(), delayMs);
          return;
        }
        scheduleBuilderLoop();
      };

      builderLoopTimer = setTimeout(() => void runBuilderScheduledTick(), minutes * 60 * 1000);
    };

    const getTroopVillageLoopKey = (village) => troopPlans.villageKey(village);

    const getTroopVillageLoopState = (village) => {
      const key = getTroopVillageLoopKey(village);
      if (!troopVillageLoopState.has(key)) {
        troopVillageLoopState.set(key, {
          timer: null,
          nextRunAt: null,
          lastDelayMinutes: null,
          missingBuildings: {}
        });
      }
      return troopVillageLoopState.get(key);
    };

    const troopBranchIsSkipped = (state, building) => {
      const retryAfter = state.missingBuildings[building];
      if (!retryAfter) {
        return false;
      }
      if (Date.now() >= retryAfter) {
        delete state.missingBuildings[building];
        return false;
      }
      return true;
    };

    const rememberMissingTroopBuilding = (state, building) => {
      state.missingBuildings[building] = Date.now() + TROOP_MISSING_BUILDING_RETRY_MS;
    };

    const clearMissingTroopBuilding = (state, building) => {
      delete state.missingBuildings[building];
    };

    const getVillageNextInMinutes = (village) => {
      const state = troopVillageLoopState.get(getTroopVillageLoopKey(village));
      if (!state || !state.nextRunAt) {
        return null;
      }
      return Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 60000));
    };

    const getSoonestTroopVillageNextInMinutes = () => {
      let soonest = null;
      for (const state of troopVillageLoopState.values()) {
        if (!state.nextRunAt) {
          continue;
        }
        const mins = Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 60000));
        if (soonest === null || mins < soonest) {
          soonest = mins;
        }
      }
      return soonest;
    };

    const cancelTroopVillageLoop = (village) => {
      const key = getTroopVillageLoopKey(village);
      const state = troopVillageLoopState.get(key);
      if (state && state.timer) {
        clearTimeout(state.timer);
      }
      troopVillageLoopState.delete(key);
    };

    const cancelAllTroopVillageLoops = () => {
      for (const state of troopVillageLoopState.values()) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      troopVillageLoopState.clear();
    };

    const pickVillageTroopDelayMinutes = (village, min, max) => {
      const state = getTroopVillageLoopState(village);
      let next = randomIntBetween(min, max);
      if (state.lastDelayMinutes !== null && max > min && next === state.lastDelayMinutes) {
        next = next === max ? next - 1 : next + 1;
      }
      state.lastDelayMinutes = next;
      return next;
    };

    const logTroopBranchOutcome = (targetVillage, result) => {
      if (!result) {
        return;
      }
      const where = villageDisplayName(targetVillage);
      switch (result.status) {
        case "trained":
          logSuccess(
            `[Troop Auto] ${where}: queued ${result.queued} ${result.unitName} (${result.buildingLabel})` +
              (result.cappedByResources ? " — capped by resources" : "")
          );
          break;
        case "no_resources":
          logInfo(`[Troop Auto] ${where}: not enough resources for ${result.unitName} (${result.buildingLabel}).`);
          break;
        case "unit_not_found":
          logWarn(
            `[Troop Auto] ${where}: unit "${result.unitName}" not in ${result.buildingLabel}. Available: ${result.availableUnits || "none"}.`
          );
          break;
        case "missing_building":
          logInfo(`[Troop Auto] ${where}: no ${result.buildingLabel} in this village yet.`);
          break;
        case "train_failed":
          logWarn(
            `[Troop Auto] ${where}: could not train ${result.unitName} in ${result.buildingLabel} — ${result.errorMessage || "unknown error"}.`
          );
          break;
        default:
          break;
      }
    };

    /** Train a village's assigned plan across Barracks, Great Barracks, Stable, and/or Great Stable. */
    const runTroopTrainingForVillage = async (targetVillage) => {
      const plan = troopPlans.resolvePlanForVillage(targetVillage);
      if (!plan) {
        return "no_plan";
      }

      const branches = troopPlans.planBranches(plan);
      if (!branches.length) {
        logInfo(`[Troop Auto] Plan "${plan.name}" has no units set; nothing to train for ${villageDisplayName(targetVillage)}.`);
        return "no_units";
      }

      const loopState = getTroopVillageLoopState(targetVillage);
      const branchesToRun = branches.filter((branch) => !troopBranchIsSkipped(loopState, branch.building));
      if (!branchesToRun.length) {
        return "executed";
      }

      const enqueueTroopAutoRun = (fn) => {
        const next = troopAutoRunChain.then(() => fn(), () => fn());
        troopAutoRunChain = next.catch(() => {});
        return next;
      };

      return enqueueTroopAutoRun(async () => {
        if (!(await waitForActionIdle("Troop Auto", { maxWaitMs: TROOP_AUTO_ACTION_IDLE_WAIT_MS }))) {
          return "busy";
        }

        const startedAt = Date.now();
        const outcomes = [];
        let troopExecuted = false;

        try {
          troopExecuted = await runAction(
            "auto-troop-trainer",
            async () => {
              await ensureVillageBrowserContext(targetVillage, "Troop Auto");
              logInfo(
                `[Troop Auto] ${villageDisplayName(targetVillage)} — plan "${plan.name}" (${troopPlans.describePlan(plan)}).`
              );
              for (const branch of branchesToRun) {
                if (cancelRequested) {
                  break;
                }
                const result = await runWithRandomDelay(
                  settings,
                  "Auto Troop Trainer",
                  () => trainPlanBranch(getPage, settings, targetVillage.id, branch),
                  () => cancelRequested
                );
                outcomes.push(result);
                if (result && result.status === "missing_building") {
                  const existsOnMap = await villageHasTrainerBuildingOnMap(
                    getPage,
                    settings,
                    targetVillage.id,
                    result.building
                  );
                  if (existsOnMap) {
                    clearMissingTroopBuilding(loopState, result.building);
                    logWarn(
                      `[Troop Auto] ${villageDisplayName(targetVillage)}: could not open ${result.buildingLabel} (found on village map) — will retry next cycle.`
                    );
                  } else {
                    rememberMissingTroopBuilding(loopState, result.building);
                    logInfo(
                      `[Troop Auto] ${villageDisplayName(targetVillage)}: no ${result.buildingLabel} yet — skipping that branch on future runs (recheck in ~12h).`
                    );
                  }
                } else {
                  if (result && result.status === "trained") {
                    clearMissingTroopBuilding(loopState, result.building);
                  }
                  logTroopBranchOutcome(targetVillage, result);
                }
              }
            },
            { raidGuardPriority: true }
          );

          if (troopExecuted) {
            const trained = outcomes.filter((o) => o && o.status === "trained");
            recordAction({
              actionType: "troop.train",
              status: trained.length ? "success" : "info",
              durationMs: Date.now() - startedAt,
              details: {
                source: "auto-loop",
                plan: plan.name,
                villageId: targetVillage.id,
                villageName: targetVillage.name,
                villageCoords: targetVillage.coordsText || null,
                trained: trained.map((o) => ({ unit: o.unitName, qty: o.queued, building: o.building }))
              }
            });
            await restoreSelectedVillageContext("Troop Auto");
          }
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          recordAction({
            actionType: "troop.train",
            status: "failed",
            durationMs: 0,
            details: {
              source: "auto-loop",
              plan: plan.name,
              villageId: targetVillage.id,
              villageName: targetVillage.name,
              villageCoords: targetVillage.coordsText || null
            },
            errorMessage: message
          });
          logWarn(
            `[Troop Auto] Auto-train skipped/failed for ${villageDisplayName(targetVillage)}: ${message}`
          );
          if (isTransientNavigationError(error)) {
            return "retry";
          }
          return "executed";
        }

        return troopExecuted ? "executed" : "busy";
      });
    };

    const scheduleTroopVillageLoop = (village, options = {}) => {
      if (!village) {
        return;
      }
      cancelTroopVillageLoop(village);

      if (done || !settings.troopTrainingRoundRobinEnabled) {
        return;
      }
      const plan = troopPlans.resolvePlanForVillage(village);
      if (!plan) {
        return;
      }

      const interval = troopPlans.resolveInterval(
        plan,
        settings.troopTrainingLoopMinMinutes,
        settings.troopTrainingLoopMaxMinutes
      );
      const minutes = pickVillageTroopDelayMinutes(village, interval.min, interval.max);
      let delayMs = minutes * 60 * 1000 + Math.floor(Math.random() * 60000);
      const staggerTotal = Number(options.staggerTotal) || 0;
      const staggerIndex = Number(options.staggerIndex) || 0;
      if (staggerTotal > 1) {
        const spreadMs = Math.floor((interval.max * 60 * 1000) / staggerTotal);
        delayMs += staggerIndex * spreadMs;
      }
      const state = getTroopVillageLoopState(village);
      state.nextRunAt = Date.now() + delayMs;
      logInfo(
        `[Troop Auto] ${villageDisplayName(village)} next train in ${formatDelayMs(delayMs)} (plan "${plan.name}", ${interval.min}-${interval.max} min).`
      );

      const runTroopVillageScheduledTick = async () => {
        state.timer = null;
        if (done || !settings.troopTrainingRoundRobinEnabled) {
          return;
        }
        if (!troopPlans.resolvePlanForVillage(village)) {
          cancelTroopVillageLoop(village);
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };
        if (automationStatus.paused) {
          state.nextRunAt = Date.now() + 15000;
          state.timer = setTimeout(() => void runTroopVillageScheduledTick(), 15000);
          return;
        }

        const outcome = await runTroopTrainingForVillage(village);
        if (outcome === "busy") {
          const retryMs =
            TROOP_AUTO_BUSY_RETRY_MIN_MS +
            Math.floor(Math.random() * TROOP_AUTO_BUSY_RETRY_JITTER_MS);
          state.nextRunAt = Date.now() + retryMs;
          logInfo(
            `[Troop Auto] ${villageDisplayName(village)} — browser busy, retrying in ${formatDelayMs(retryMs)}.`
          );
          state.timer = setTimeout(() => void runTroopVillageScheduledTick(), retryMs);
        } else if (outcome === "retry") {
          const retryMs = 20000 + Math.floor(Math.random() * 25000);
          state.nextRunAt = Date.now() + retryMs;
          logInfo(
            `[Troop Auto] ${villageDisplayName(village)} — navigation interrupted, retrying in ${formatDelayMs(retryMs)}.`
          );
          state.timer = setTimeout(() => void runTroopVillageScheduledTick(), retryMs);
        } else {
          scheduleTroopVillageLoop(village);
        }
        if (dashboardBridge) {
          dashboardBridge.publishSnapshot();
        }
      };

      state.timer = setTimeout(() => void runTroopVillageScheduledTick(), delayMs);
    };

    const syncAllTroopVillageLoops = () => {
      cancelAllTroopVillageLoops();
      if (done || !settings.troopTrainingRoundRobinEnabled) {
        return;
      }
      if (!villageState.villages.length) {
        setTimeout(() => {
          if (!done && settings.troopTrainingRoundRobinEnabled) {
            syncAllTroopVillageLoops();
          }
        }, 30000);
        return;
      }
      const rrVillages = troopPlans.listEnabledVillages(villageState.villages);
      if (!rrVillages.length && villageState.villages.length) {
        logInfo("[Troop Auto] No villages assigned to a troop plan — assign one in Troop Plans (menu T).");
      }
      for (let i = 0; i < rrVillages.length; i++) {
        scheduleTroopVillageLoop(rrVillages[i], {
          staggerIndex: i,
          staggerTotal: rrVillages.length
        });
      }
    };

    /** Re-sync a single village's timer after its plan assignment changes. */
    const resyncTroopVillageLoop = (villageRef) => {
      const village =
        villageState.villages.find((v) => Number(v.id) === Number(villageRef.id)) || villageRef;
      cancelTroopVillageLoop(village);
      if (
        !done &&
        settings.troopTrainingRoundRobinEnabled &&
        troopPlans.resolvePlanForVillage(village)
      ) {
        scheduleTroopVillageLoop(village);
      }
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot({ force: true });
      }
    };

    const troopPlanHooks = {
      menuSession,
      requestQuit,
      getSnapshot: () => ({
        villages: villageState.villages.slice(),
        selectedVillageId: villageState.selectedVillageId,
        activeVillageId: villageState.activeVillageId
      }),
      refreshVillages: () =>
        refreshVillageState({ navigateToStatusPage: true, silent: true }),
      listTrainableUnits: (village, building) =>
        listTrainableUnits(getPage, settings, village.id, building),
      onAssignmentChanged: (village) => resyncTroopVillageLoop(village),
      onPlansChanged: () => syncAllTroopVillageLoops()
    };

    const runTroopTemplateCategoryMenu = async () => {
      await runTroopPlansMenu(menuRl, settings, runtimeControls, troopPlanHooks);
    };

    const scheduleTroopTrainingLoop = () => {
      syncAllTroopVillageLoops();
    };

    const cancelCrannyDefenseLoopTimer = () => {
      if (crannyDefenseLoopTimer) {
        clearTimeout(crannyDefenseLoopTimer);
        crannyDefenseLoopTimer = null;
      }
      nextCrannyDefenseRunAt = null;
    };

    const pickNextCrannyDefenseDelayMinutes = (min, max) => {
      let next = randomIntBetween(min, max);
      if (
        lastCrannyDefenseDelayMinutes !== null &&
        max > min &&
        next === lastCrannyDefenseDelayMinutes
      ) {
        next = next === max ? next - 1 : next + 1;
      }
      lastCrannyDefenseDelayMinutes = next;
      return next;
    };

    const scheduleCrannyDefenseLoop = () => {
      cancelCrannyDefenseLoopTimer();

      if (!settings.crannyDefenseRoundRobinEnabled || done) {
        return;
      }
      if (!villageState.villages.length) {
        crannyDefenseLoopTimer = setTimeout(() => {
          if (!done && settings.crannyDefenseRoundRobinEnabled) {
            scheduleCrannyDefenseLoop();
          }
        }, 30000);
        return;
      }

      const normalized = normalizeMinuteRange(
        settings.crannyDefenseLoopMinMinutes,
        settings.crannyDefenseLoopMaxMinutes,
        8,
        15
      );
      settings.crannyDefenseLoopMinMinutes = normalized.min;
      settings.crannyDefenseLoopMaxMinutes = normalized.max;
      const minutes = pickNextCrannyDefenseDelayMinutes(normalized.min, normalized.max);
      nextCrannyDefenseRunAt = Date.now() + minutes * 60 * 1000;
      logInfo(`[Cranny defense RR] Next run in ${minutes} minute(s).`);

      const runCrannyDefenseScheduledTick = async () => {
        if (done || !settings.crannyDefenseRoundRobinEnabled) {
          scheduleCrannyDefenseLoop();
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };
        if (automationStatus.paused) {
          nextCrannyDefenseRunAt = null;
          crannyDefenseLoopTimer = setTimeout(() => {
            if (!done && settings.crannyDefenseRoundRobinEnabled) {
              scheduleCrannyDefenseLoop();
            }
          }, 15000);
          return;
        }

        const villages = villageState.villages;
        const n = villages.length;
        if (!n) {
          scheduleCrannyDefenseLoop();
          return;
        }

        try {
          const startedAt = Date.now();
          let defenseResult = null;
          let recordVillage = null;
          let rotationStart = 0;
          let rotationAttempts = 0;
          let crannyExecuted = false;

          crannyExecuted = await runAction(
            "cranny-defense-rr",
            async () => {
              const start = ((crannyRoundRobinIndex % n) + n) % n;
              rotationStart = start;
              let decidedNextStart = (start + 1) % n;

              for (let attempt = 0; attempt < n; attempt++) {
                const idx = (start + attempt) % n;
                const targetVillage = villages[idx];
                recordVillage = targetVillage;
                rotationAttempts = attempt + 1;

                await ensureVillageBrowserContext(targetVillage, "Cranny defense RR");
                logInfo(
                  `[Cranny defense RR] ${attempt + 1}/${n} ${villageDisplayName(targetVillage)} — scanning slots...`
                );
                defenseResult = await builder.runCrannyDefenseStep(getPage, settings, targetVillage, {
                  goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                  goldCompleteMax: settings.builderGoldCompleteMax,
                  masterBuilderEnabled: settings.builderMasterBuilderEnabled
                });

                if (defenseResult.status === "success") {
                  logSuccess(`[Cranny defense RR] ${defenseResult.message}`);
                  decidedNextStart = (idx + 1) % n;
                  break;
                }
                if (defenseResult.status === "idle_saturated") {
                  logInfo(`[Cranny defense RR] ${defenseResult.message}`);
                  if (attempt + 1 < n) {
                    logInfo("[Cranny defense RR] No work here — trying next village in rotation…");
                    await waitAfterVillageSwitch(getPage(), settings);
                  }
                  continue;
                }
                logWarn(`[Cranny defense RR] ${defenseResult.message || defenseResult.status}`);
              }

              if (
                defenseResult &&
                defenseResult.status === "idle_saturated" &&
                rotationAttempts === n
              ) {
                const nextV = villages[decidedNextStart];
                logInfo(
                  `[Cranny defense RR] Scanned all ${n} village(s); none queued Cranny work. ` +
                    `Next tick starts at ${villageDisplayName(nextV)}.`
                );
              }

              crannyRoundRobinIndex = decidedNextStart;
            },
            { preemptAutoBuilder: true, raidGuardPriority: true }
          );

          if (crannyExecuted && defenseResult && recordVillage) {
            const ok =
              defenseResult.status === "success" || defenseResult.status === "idle_saturated";
            recordAction({
              actionType: "building.cranny_defense",
              status: ok ? "success" : "info",
              durationMs: Date.now() - startedAt,
              details: {
                source: "auto-loop",
                status: defenseResult.status,
                message: defenseResult.message,
                report: defenseResult.report,
                villageId: recordVillage.id,
                villageName: recordVillage.name,
                villageCoords: recordVillage.coordsText || null,
                crannyRotationStartIndex: rotationStart,
                crannyRotationAttempts: rotationAttempts,
                crannyRotationVillageCount: n
              }
            });
          }
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          const fallbackVillage =
            villages[((crannyRoundRobinIndex % n) + n) % n] || villages[0] || null;
          recordAction({
            actionType: "building.cranny_defense",
            status: "failed",
            durationMs: 0,
            details: {
              source: "auto-loop",
              villageId: fallbackVillage ? fallbackVillage.id : null,
              villageName: fallbackVillage ? fallbackVillage.name : null,
              villageCoords: fallbackVillage ? fallbackVillage.coordsText : null
            },
            errorMessage: message
          });
          logWarn(
            `[Cranny defense RR] Failed: ${message}` +
              (fallbackVillage ? ` (while near ${villageDisplayName(fallbackVillage)})` : "")
          );
          crannyRoundRobinIndex = (crannyRoundRobinIndex + 1) % n;
        }

        if (crannyExecuted) {
          await restoreSelectedVillageContext("Cranny defense RR");
        }
        scheduleCrannyDefenseLoop();
      };

      crannyDefenseLoopTimer = setTimeout(
        () => void runCrannyDefenseScheduledTick(),
        minutes * 60 * 1000
      );
    };

    const cancelRaidEvacuationLoopTimer = () => {
      if (raidEvacuationLoopTimer) {
        clearTimeout(raidEvacuationLoopTimer);
        raidEvacuationLoopTimer = null;
      }
    };

    const scheduleRaidEvacuationLoop = () => {
      cancelRaidEvacuationLoopTimer();
      if (done || settings.raidEvacuationEnabled === false) {
        return;
      }

      const runRaidEvacuationScheduledTick = async () => {
        if (done || settings.raidEvacuationEnabled === false) {
          scheduleRaidEvacuationLoop();
          return;
        }
        if (actionInProgress) {
          scheduleRaidEvacuationLoop();
          return;
        }
        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };
        if (!automationStatus.paused) {
          try {
            await attemptRaidEvacuationForAllVillages();
          } catch (error) {
            const message = String(error && error.message ? error.message : error);
            const isTransientNavRace = /ERR_ABORTED|interrupted by another navigation|Execution context was destroyed/i.test(
              message
            );
            if (!isTransientNavRace) {
              logWarn(`[Raid Guard] Check failed: ${message}`);
            }
          }
        }
        scheduleRaidEvacuationLoop();
      };

      const pollMs = Math.max(
        5000,
        Math.floor(Number(settings.raidEvacuationPollSeconds) || 30) * 1000
      );
      raidEvacuationLoopTimer = setTimeout(() => void runRaidEvacuationScheduledTick(), pollMs);
    };

    const cancelActivitySimulationLoopTimer = () => {
      if (activitySimulationLoopTimer) {
        clearTimeout(activitySimulationLoopTimer);
        activitySimulationLoopTimer = null;
      }
      nextActivitySimulationRunAt = null;
    };

    const pickNextActivitySimulationDelayMinutes = (min, max) => {
      let next = randomIntBetween(min, max);
      if (
        lastActivitySimulationDelayMinutes !== null &&
        max > min &&
        next === lastActivitySimulationDelayMinutes
      ) {
        next = next === max ? next - 1 : next + 1;
      }
      lastActivitySimulationDelayMinutes = next;
      return next;
    };

    const buildActivitySimulationPayload = () => ({
      enabled: settings.activitySimulationEnabled,
      minMinutes: settings.activitySimulationLoopMinMinutes,
      maxMinutes: settings.activitySimulationLoopMaxMinutes,
      patterns: activitySimulation.parsePatterns(settings.activitySimulationPatterns),
      availablePatterns: activitySimulation.listAvailablePatterns(),
      dwellMinMs: settings.activitySimulationDwellMinMs,
      dwellMaxMs: settings.activitySimulationDwellMaxMs,
      nextInMinutes: nextActivitySimulationRunAt
        ? Math.max(0, Math.ceil((nextActivitySimulationRunAt - Date.now()) / 60000))
        : null,
      completedCount: activitySimulationCompletedCount,
      lastAction: lastActivitySimulationAction
    });

    const buildActivitySimulationStatus = () => ({
      enabled: settings.activitySimulationEnabled,
      minMinutes: settings.activitySimulationLoopMinMinutes,
      maxMinutes: settings.activitySimulationLoopMaxMinutes,
      nextInMinutes: nextActivitySimulationRunAt
        ? Math.max(0, Math.ceil((nextActivitySimulationRunAt - Date.now()) / 60000))
        : null,
      completedCount: activitySimulationCompletedCount,
      lastAction: lastActivitySimulationAction
    });

    const snapshotVillageList = () =>
      villageState.villages.map((v) => ({
        id: v.id,
        name: v.name,
        x: v.x,
        y: v.y,
        coordsText: v.coordsText,
        isCapital: Boolean(v.isCapital),
        underAttack: Boolean(v.underAttack)
      }));

    const applyActivitySettingsPatch = async (patch) => {
      if (!runtimeControls.updateActivitySimulationLoopConfig) {
        throw new Error("Activity settings are not available");
      }
      const applied = await runtimeControls.updateActivitySimulationLoopConfig({
        enabled:
          patch && patch.enabled !== undefined
            ? Boolean(patch.enabled)
            : settings.activitySimulationEnabled,
        minMinutes:
          patch && patch.minMinutes !== undefined
            ? Number(patch.minMinutes)
            : settings.activitySimulationLoopMinMinutes,
        maxMinutes:
          patch && patch.maxMinutes !== undefined
            ? Number(patch.maxMinutes)
            : settings.activitySimulationLoopMaxMinutes,
        patterns: patch && patch.patterns !== undefined ? patch.patterns : undefined
      });
      settings.activitySimulationEnabled = applied.enabled;
      settings.activitySimulationLoopMinMinutes = applied.minMinutes;
      settings.activitySimulationLoopMaxMinutes = applied.maxMinutes;
      if (applied.patterns) {
        settings.activitySimulationPatterns = activitySimulation.serializePatterns(applied.patterns);
      }
      scheduleActivitySimulationLoop();
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot();
      }
      return buildActivitySimulationPayload();
    };

    const applyDisplaySettingsPatch = async (patch) => {
      if (!runtimeControls.updateDashboardDisplayConfig) {
        throw new Error("Display settings are not available");
      }
      const compactView =
        patch && patch.compactView !== undefined
          ? Boolean(patch.compactView)
          : settings.dashboardCompactView;
      const applied = await runtimeControls.updateDashboardDisplayConfig({ compactView });
      settings.dashboardCompactView = applied.compactView;
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot();
      }
      return { compactView: settings.dashboardCompactView };
    };

    const scheduleActivitySimulationLoop = () => {
      cancelActivitySimulationLoopTimer();

      const normalized = normalizeMinuteRange(
        settings.activitySimulationLoopMinMinutes,
        settings.activitySimulationLoopMaxMinutes,
        20,
        45
      );
      settings.activitySimulationLoopMinMinutes = normalized.min;
      settings.activitySimulationLoopMaxMinutes = normalized.max;

      if (!settings.activitySimulationEnabled || done) {
        return;
      }

      const minutes = pickNextActivitySimulationDelayMinutes(
        settings.activitySimulationLoopMinMinutes,
        settings.activitySimulationLoopMaxMinutes
      );
      activitySimulationResumeWaitLogged = false;
      nextActivitySimulationRunAt = Date.now() + minutes * 60 * 1000;
      logInfo(
        `[Activity Sim] Next browse in ${minutes} minute(s). (${activitySimulationCompletedCount} event(s) completed this session.)`
      );

      const runActivitySimulationScheduledTick = async () => {
        if (done || !settings.activitySimulationEnabled) {
          scheduleActivitySimulationLoop();
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };

        if (automationStatus.paused) {
          nextActivitySimulationRunAt = null;
          if (!activitySimulationResumeWaitLogged) {
            logInfo(
              `[Activity Sim] Paused (${automationStatus.reason}). Waiting for session to resume...`
            );
            activitySimulationResumeWaitLogged = true;
          }
          activitySimulationLoopTimer = setTimeout(() => {
            if (!done && settings.activitySimulationEnabled) {
              scheduleActivitySimulationLoop();
            }
          }, 15000);
          return;
        }

        if (!villageState.villages.length) {
          logInfo("[Activity Sim] No villages loaded yet — retrying later.");
          scheduleActivitySimulationLoop();
          return;
        }

        let activityExecuted = false;
        const startedAt = Date.now();
        try {
          activityExecuted = await runAction("activity-simulation", async () => {
            const step = await runWithRandomDelay(
              settings,
              "Activity Simulation",
              () =>
                activitySimulation.runActivityBrowsingStep(getPage, settings, {
                  villages: villageState.villages
                }),
              () => cancelRequested
            );

            if (step.shouldRefreshVillages) {
              await refreshVillageState({ navigateToStatusPage: false, silent: true });
            }

            lastActivitySimulationAction = {
              at: new Date().toISOString(),
              pattern: step.pattern,
              patternLabel: step.patternLabel,
              villageId: step.villageId,
              villageName: step.villageName,
              dwellMs: step.dwellMs,
              hints: step.hints,
              completedCount: activitySimulationCompletedCount + 1
            };

            const villageLabel = step.villageName
              ? `${step.villageName} (vid=${step.villageId})`
              : "account-wide";
            logInfo(
              `[Activity Sim] Event #${activitySimulationCompletedCount + 1}: browsed ${step.patternLabel} @ ${villageLabel} (${Math.round(step.dwellMs / 1000)}s).`
            );
            if (step.hints && (step.hints.wood || step.hints.clay)) {
              logInfo(
                `[Activity Sim] Snapshot: W ${step.hints.wood || "?"} C ${step.hints.clay || "?"} I ${step.hints.iron || "?"} Cr ${step.hints.crop || "?"}`
              );
            }
          }, { raidGuardPriority: false });

          if (activityExecuted && lastActivitySimulationAction) {
            activitySimulationCompletedCount += 1;
            logSuccess(
              `[Activity Sim] Done — ${activitySimulationCompletedCount} browse event(s) completed this session.`
            );
            recordAction({
              actionType: "activity.simulation",
              status: "success",
              durationMs: Date.now() - startedAt,
              details: {
                source: "auto-loop",
                completedCount: activitySimulationCompletedCount,
                ...lastActivitySimulationAction
              }
            });
            await restoreSelectedVillageContext("Activity Sim");
            if (dashboardBridge) {
              dashboardBridge.publishSnapshot();
            }
          }
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          recordAction({
            actionType: "activity.simulation",
            status: "failed",
            durationMs: 0,
            details: { source: "auto-loop" },
            errorMessage: message
          });
          logWarn(`[Activity Sim] Browse skipped/failed: ${message}`);
        }

        scheduleActivitySimulationLoop();
      };

      activitySimulationLoopTimer = setTimeout(
        () => void runActivitySimulationScheduledTick(),
        minutes * 60 * 1000
      );
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot();
      }
    };

    const cancelTop10TrackingLoopTimer = () => {
      if (top10TrackingLoopTimer) {
        clearTimeout(top10TrackingLoopTimer);
        top10TrackingLoopTimer = null;
      }
      nextTop10TrackingRunAt = null;
    };

    const pickNextTop10TrackingDelayMinutes = (min, max) => {
      let next = randomIntBetween(min, max);
      if (
        lastTop10TrackingDelayMinutes !== null &&
        max > min &&
        next === lastTop10TrackingDelayMinutes
      ) {
        next = next === max ? next - 1 : next + 1;
      }
      lastTop10TrackingDelayMinutes = next;
      return next;
    };

    const buildTop10TrackingStatus = () => ({
      enabled: settings.top10TrackingEnabled,
      minMinutes: settings.top10TrackingLoopMinMinutes,
      maxMinutes: settings.top10TrackingLoopMaxMinutes,
      logFile: settings.top10TrackingLogFile || DEFAULT_TOP10_LOG_FILE,
      playerName: settings.top10TrackingPlayerName || null,
      categories: top10Tracking.listCategories(),
      nextInMinutes: nextTop10TrackingRunAt
        ? Math.max(0, Math.ceil((nextTop10TrackingRunAt - Date.now()) / 60000))
        : null,
      completedCount: top10TrackingCompletedCount,
      lastAction: lastTop10TrackingAction
    });

    const executeTop10TrackingSnapshot = async (source) => {
      const startedAt = Date.now();
      const account = runtimeControls.dashboardAccount || {};
      let executed = false;

      try {
        executed = await runAction(
          "top10-tracking",
          async () => {
            const snapshot = await runWithRandomDelay(
              settings,
              "Top 10 Tracking",
              () =>
                top10Tracking.runTop10TrackingSnapshot(getPage, settings, {
                  username: account.username || null
                }),
              () => cancelRequested
            );

            lastTop10TrackingAction = {
              at: snapshot.ts,
              logFilePath: snapshot.logFilePath,
              gameHost: snapshot.gameHost,
              categories: snapshot.categories
            };

            const okCount = snapshot.categories.filter((entry) => entry.ok).length;
            logSuccess(
              `[Top10] ${source}: logged ${okCount}/${snapshot.categories.length} categories to ${path.basename(snapshot.logFilePath)}.`
            );
            for (const cat of snapshot.categories) {
              if (!cat.ok) {
                logWarn(
                  `[Top10] ${cat.categoryLabel}: ${(cat.warnings && cat.warnings[0]) || cat.warning || "no rows parsed"}`
                );
              } else if (cat.selfRank) {
                logInfo(`[Top10] ${cat.categoryLabel}: your rank #${cat.selfRank}`);
              }
            }

            recordAction({
              actionType: "top10.tracking",
              status: okCount > 0 ? "success" : "failed",
              durationMs: Date.now() - startedAt,
              details: {
                source,
                logFilePath: snapshot.logFilePath,
                categories: snapshot.categories
              }
            });

            await restoreSelectedVillageContext("Top10 Tracking");
            if (dashboardBridge) {
              dashboardBridge.publishSnapshot();
            }
            return snapshot;
          },
          { raidGuardPriority: false }
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        recordAction({
          actionType: "top10.tracking",
          status: "failed",
          durationMs: Date.now() - startedAt,
          details: { source },
          errorMessage: message
        });
        logWarn(`[Top10] ${source} skipped/failed: ${message}`);
      }

      if (executed) {
        top10TrackingCompletedCount += 1;
      }
      return executed;
    };

    const scheduleTop10TrackingLoop = () => {
      cancelTop10TrackingLoopTimer();

      const normalized = normalizeMinuteRange(
        settings.top10TrackingLoopMinMinutes,
        settings.top10TrackingLoopMaxMinutes,
        60,
        120
      );
      settings.top10TrackingLoopMinMinutes = normalized.min;
      settings.top10TrackingLoopMaxMinutes = normalized.max;

      if (!settings.top10TrackingEnabled || done) {
        return;
      }

      const minutes = pickNextTop10TrackingDelayMinutes(
        settings.top10TrackingLoopMinMinutes,
        settings.top10TrackingLoopMaxMinutes
      );
      top10TrackingResumeWaitLogged = false;
      nextTop10TrackingRunAt = Date.now() + minutes * 60 * 1000;
      logInfo(
        `[Top10] Next snapshot in ${minutes} minute(s). (${top10TrackingCompletedCount} snapshot(s) completed this session.)`
      );

      const runTop10TrackingScheduledTick = async () => {
        if (done || !settings.top10TrackingEnabled) {
          scheduleTop10TrackingLoop();
          return;
        }

        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };

        if (automationStatus.paused) {
          nextTop10TrackingRunAt = null;
          if (!top10TrackingResumeWaitLogged) {
            logInfo(
              `[Top10] Paused (${automationStatus.reason}). Waiting for session to resume...`
            );
            top10TrackingResumeWaitLogged = true;
          }
          top10TrackingLoopTimer = setTimeout(() => {
            if (!done && settings.top10TrackingEnabled) {
              scheduleTop10TrackingLoop();
            }
          }, 15000);
          return;
        }

        await executeTop10TrackingSnapshot("auto-loop");
        scheduleTop10TrackingLoop();
      };

      top10TrackingLoopTimer = setTimeout(
        () => void runTop10TrackingScheduledTick(),
        minutes * 60 * 1000
      );
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot();
      }
    };

    const buildTroopLiveSummary = () => {
      const allVillages = villageState.villages;
      const rrVillages = troopPlans.listEnabledVillages(allVillages);
      return {
        troopLoop: {
          enabled: settings.troopTrainingRoundRobinEnabled,
          minMinutes: settings.troopTrainingLoopMinMinutes,
          maxMinutes: settings.troopTrainingLoopMaxMinutes,
          nextInMinutes: getSoonestTroopVillageNextInMinutes(),
          enabledVillageCount: rrVillages.length,
          totalVillageCount: allVillages.length
        },
        selectedVillageId: villageState.selectedVillageId,
        activeVillageId: villageState.activeVillageId,
        villages: allVillages.map((v) => {
          const plan = troopPlans.resolvePlanForVillage(v);
          return {
            villageId: v.id,
            name: v.name,
            isCapital: Boolean(v.isCapital),
            underAttack: Boolean(v.underAttack),
            plan: plan ? plan.name : null,
            planSummary: plan ? troopPlans.describePlan(plan) : null,
            enabled: Boolean(plan),
            nextInMinutes: getVillageNextInMinutes(v)
          };
        })
      };
    };

    // Terminal-driven engine. The web dashboard troop tab is read-only.
    const buildFullTroopDashboardPayload = () => {
      const allVillages = villageState.villages;
      const rrVillages = troopPlans.listEnabledVillages(allVillages);
      return {
        terminalOnly: true,
        troopLoop: {
          enabled: settings.troopTrainingRoundRobinEnabled,
          minMinutes: settings.troopTrainingLoopMinMinutes,
          maxMinutes: settings.troopTrainingLoopMaxMinutes,
          nextInMinutes: getSoonestTroopVillageNextInMinutes(),
          enabledVillageCount: rrVillages.length,
          totalVillageCount: allVillages.length
        },
        plans: troopPlans.listPlans(),
        selectedVillageId: villageState.selectedVillageId,
        activeVillageId: villageState.activeVillageId,
        villages: allVillages.map((v) => {
          const plan = troopPlans.resolvePlanForVillage(v);
          const assignment = troopPlans.getAssignment(v);
          return {
            villageId: v.id,
            name: v.name,
            x: v.x,
            y: v.y,
            coordsText: v.coordsText,
            isCapital: Boolean(v.isCapital),
            underAttack: Boolean(v.underAttack),
            plan: assignment ? assignment.plan : null,
            enabled: Boolean(plan),
            planSummary: plan ? troopPlans.describePlan(plan) : null,
            nextInMinutes: getVillageNextInMinutes(v)
          };
        })
      };
    };

    // Troop plans are managed from the terminal; the web updater is a read-only no-op.
    const applyTroopSettingsPatch = async () => buildFullTroopDashboardPayload();

    let cachedDashboardSnapshot = null;
    let cachedDashboardSnapshotKey = "";
    let cachedDashboardSnapshotAt = 0;

    const buildDashboardSnapshot = () => {
      const automationStatus = runtimeControls.getAutomationStatus
        ? runtimeControls.getAutomationStatus()
        : { paused: false, reason: "online" };
      const farmlistNextInMinutes = nextFarmlistRunAt
        ? Math.max(0, Math.ceil((nextFarmlistRunAt - Date.now()) / 60000))
        : null;
      const builderNextInMinutes = nextBuilderRunAt
        ? Math.max(0, Math.ceil((nextBuilderRunAt - Date.now()) / 60000))
        : null;
      const crannyNextInMinutes = nextCrannyDefenseRunAt
        ? Math.max(0, Math.ceil((nextCrannyDefenseRunAt - Date.now()) / 60000))
        : null;
      const activityNextInMinutes = nextActivitySimulationRunAt
        ? Math.max(0, Math.ceil((nextActivitySimulationRunAt - Date.now()) / 60000))
        : null;
      const top10NextInMinutes = nextTop10TrackingRunAt
        ? Math.max(0, Math.ceil((nextTop10TrackingRunAt - Date.now()) / 60000))
        : null;

      const cacheKey = [
        automationStatus.paused,
        automationStatus.reason,
        settings.sessionLoopEnabled,
        settings.farmlistLoopEnabled,
        settings.builderLoopEnabled,
        settings.troopTrainingRoundRobinEnabled,
        settings.crannyDefenseRoundRobinEnabled,
        settings.activitySimulationEnabled,
        settings.top10TrackingEnabled,
        villageState.selectedVillageId,
        villageState.activeVillageId,
        villageState.villages.length,
        actionInProgress,
        currentActionLabel,
        activeBuilderPlanMode,
        settings.dashboardCompactView
      ].join("|");

      const now = Date.now();
      if (
        cachedDashboardSnapshot &&
        cachedDashboardSnapshotKey === cacheKey &&
        now - cachedDashboardSnapshotAt < 1500
      ) {
        const snap = cachedDashboardSnapshot;
        snap.updatedAt = new Date().toISOString();
        if (snap.loops) {
          if (snap.loops.farmlist) snap.loops.farmlist.nextInMinutes = farmlistNextInMinutes;
          if (snap.loops.builder) snap.loops.builder.nextInMinutes = builderNextInMinutes;
          if (snap.loops.troop) snap.loops.troop.nextInMinutes = getSoonestTroopVillageNextInMinutes();
          if (snap.loops.cranny) snap.loops.cranny.nextInMinutes = crannyNextInMinutes;
          if (snap.loops.activity) snap.loops.activity.nextInMinutes = activityNextInMinutes;
          if (snap.loops.top10) snap.loops.top10.nextInMinutes = top10NextInMinutes;
        }
        if (runtimeControls.getSessionLoopStatus) {
          snap.sessionLoop = runtimeControls.getSessionLoopStatus();
        }
        return snap;
      }

      const sessionLoopStatus = runtimeControls.getSessionLoopStatus
        ? runtimeControls.getSessionLoopStatus()
        : { enabled: settings.sessionLoopEnabled, nextInMinutes: null };
      const farmlistLoopStatus = {
        enabled: settings.farmlistLoopEnabled,
        minMinutes: settings.farmlistLoopMinMinutes,
        maxMinutes: settings.farmlistLoopMaxMinutes,
        nextInMinutes: farmlistNextInMinutes
      };
      const builderLoopStatus = {
        enabled: settings.builderLoopEnabled,
        minMinutes: settings.builderLoopMinMinutes,
        maxMinutes: settings.builderLoopMaxMinutes,
        nextInMinutes: builderNextInMinutes,
        roundRobinProgress: settings.builderRoundRobinEnabled
          ? builderRrUsesResourceThenVillagePipeline()
            ? getRoundRobinPipelineProgress(villageState.villages)
            : getRoundRobinProgress(villageState.villages, activeBuilderPlanMode)
          : null
      };
      const troopLoopStatus = {
        enabled: settings.troopTrainingRoundRobinEnabled,
        minMinutes: settings.troopTrainingLoopMinMinutes,
        maxMinutes: settings.troopTrainingLoopMaxMinutes,
        nextInMinutes: getSoonestTroopVillageNextInMinutes()
      };
      const crannyLoopStatus = {
        enabled: settings.crannyDefenseRoundRobinEnabled,
        minMinutes: settings.crannyDefenseLoopMinMinutes,
        maxMinutes: settings.crannyDefenseLoopMaxMinutes,
        nextInMinutes: crannyNextInMinutes
      };
      const activityLoopStatus = {
        enabled: settings.activitySimulationEnabled,
        minMinutes: settings.activitySimulationLoopMinMinutes,
        maxMinutes: settings.activitySimulationLoopMaxMinutes,
        nextInMinutes: activityNextInMinutes,
        completedCount: activitySimulationCompletedCount
      };
      const top10LoopStatus = {
        enabled: settings.top10TrackingEnabled,
        minMinutes: settings.top10TrackingLoopMinMinutes,
        maxMinutes: settings.top10TrackingLoopMaxMinutes,
        nextInMinutes: top10NextInMinutes,
        completedCount: top10TrackingCompletedCount,
        logFile: settings.top10TrackingLogFile || DEFAULT_TOP10_LOG_FILE
      };
      const selectedVillage =
        villageState.villages.find((v) => v.id === villageState.selectedVillageId) || null;
      const activeVillage =
        villageState.villages.find((v) => v.id === villageState.activeVillageId) || null;
      const account = runtimeControls.dashboardAccount || {};
      let gameHost = null;
      try {
        gameHost = new URL(settings.villageStatusUrl || settings.farmlistUrl || "").hostname;
      } catch (_error) {
        gameHost = null;
      }

      const snapshot = {
        updatedAt: new Date().toISOString(),
        starting: !villageState.lastRefreshIso,
        loadingVillages: !villageState.lastRefreshIso,
        account: {
          username: account.username || null,
          browserMode: account.browserMode || (settings.headless ? "headless" : "headed"),
          localAddresses: Array.isArray(account.localAddresses) ? account.localAddresses : [],
          publicAddress: account.publicAddress || null,
          gameHost,
          dashboardPort: account.dashboardPort || runtimeControls.dashboardPort || 3847,
          dashboardUrls: Array.isArray(account.dashboardUrls) ? account.dashboardUrls : []
        },
        automation: automationStatus,
        sessionLoop: sessionLoopStatus,
        browserRefresh: runtimeControls.getBrowserRefreshStatus
          ? runtimeControls.getBrowserRefreshStatus()
          : null,
        loops: {
          farmlist: farmlistLoopStatus,
          builder: builderLoopStatus,
          troop: troopLoopStatus,
          cranny: crannyLoopStatus,
          activity: activityLoopStatus,
          top10: top10LoopStatus
        },
        activitySimulation: buildActivitySimulationStatus(),
        top10Tracking: buildTop10TrackingStatus(),
        display: {
          compactView: Boolean(settings.dashboardCompactView)
        },
        proxy: runtimeControls.getProxySettings
          ? runtimeControls.getProxySettings()
          : buildProxySettingsPayload(settings),
        villages: snapshotVillageList(),
        selectedVillageId: villageState.selectedVillageId,
        activeVillageId: villageState.activeVillageId,
        selectedVillage,
        activeVillage,
        actionInProgress,
        currentActionLabel,
        builderPlanMode: activeBuilderPlanMode,
        envFile: runtimeControls.dashboardEnvLabel || null,
        pendingPrompt: dashboardBridge ? dashboardBridge.getPendingPrompt() : null
      };

      cachedDashboardSnapshot = snapshot;
      cachedDashboardSnapshotKey = cacheKey;
      cachedDashboardSnapshotAt = now;
      return snapshot;
    };

    if (dashboardBridge) {
      dashboardBridge.setTroopSettingsProvider(() => buildFullTroopDashboardPayload());
      dashboardBridge.setTroopSettingsUpdater(applyTroopSettingsPatch);
      dashboardBridge.setActivitySettingsProvider(() => buildActivitySimulationPayload());
      dashboardBridge.setActivitySettingsUpdater(applyActivitySettingsPatch);
      dashboardBridge.setDisplaySettingsUpdater(applyDisplaySettingsPatch);
      if (runtimeControls.getProxySettings) {
        dashboardBridge.setProxySettingsProvider(() => runtimeControls.getProxySettings());
      }
      if (runtimeControls.updateProxySettings) {
        dashboardBridge.setProxySettingsUpdater((patch) => runtimeControls.updateProxySettings(patch));
      }
    }

    const printInteractiveMenu = () => {
      const automationStatus = runtimeControls.getAutomationStatus
        ? runtimeControls.getAutomationStatus()
        : { paused: false, reason: "online" };
      printMainMenu(automationStatus);
      const sessionLoopStatus = runtimeControls.getSessionLoopStatus
        ? runtimeControls.getSessionLoopStatus()
        : { enabled: settings.sessionLoopEnabled, nextInMinutes: null };
      const farmlistLoopStatus = {
        enabled: settings.farmlistLoopEnabled,
        nextInMinutes: nextFarmlistRunAt
          ? Math.max(0, Math.ceil((nextFarmlistRunAt - Date.now()) / 60000))
          : null
      };
      const builderLoopStatus = {
        enabled: settings.builderLoopEnabled,
        nextInMinutes: nextBuilderRunAt
          ? Math.max(0, Math.ceil((nextBuilderRunAt - Date.now()) / 60000))
          : null,
        roundRobinProgress: settings.builderRoundRobinEnabled
          ? builderRrUsesResourceThenVillagePipeline()
            ? getRoundRobinPipelineProgress(villageState.villages)
            : getRoundRobinProgress(villageState.villages, activeBuilderPlanMode)
          : null
      };
      const troopLoopStatus = {
        enabled: settings.troopTrainingRoundRobinEnabled,
        nextInMinutes: getSoonestTroopVillageNextInMinutes()
      };
      const crannyLoopStatus = {
        enabled: settings.crannyDefenseRoundRobinEnabled,
        nextInMinutes: nextCrannyDefenseRunAt
          ? Math.max(0, Math.ceil((nextCrannyDefenseRunAt - Date.now()) / 60000))
          : null
      };
      printSessionLoopStatus(settings, {
        sessionLoop: sessionLoopStatus,
        farmlistLoop: farmlistLoopStatus,
        builderLoop: builderLoopStatus,
        troopLoop: troopLoopStatus,
        crannyLoop: crannyLoopStatus
      }, activeBuilderPlanMode);
      printCompactMenuKeys(settings);
      printVillageContextStatus(villageState, settings);
    };

    if (dashboardBridge) {
      dashboardBridge.setSnapshotProvider(buildDashboardSnapshot);
      dashboardBridge.publishSnapshot({ force: true });
      const compactNote = settings.dashboardCompactView ? " compact UI" : "";
      logInfo(
        `[Dashboard] Web UI${compactNote} — open http://127.0.0.1:${dashboardPort} (loading villages…)`
      );
    }

    const finishStartup = async () => {
      try {
        await refreshVillageState({ navigateToStatusPage: true, silent: false });
      } catch (error) {
        logWarn(`[Village] Failed to load village list: ${error.message || error}`);
      }
      scheduleFarmlistLoop();
      scheduleBuilderLoop();
      scheduleTroopTrainingLoop();
      scheduleCrannyDefenseLoop();
      scheduleActivitySimulationLoop();
      scheduleTop10TrackingLoop();
      scheduleRaidEvacuationLoop();
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot({ force: true });
        logInfo(`[Dashboard] Villages loaded — web UI ready`);
      }
    };
    void finishStartup();

    let menuNeedsFullRefresh = true;
    let deferMenuFullRefresh = false;
    const menuFullRefreshInputs = new Set(["S", "V", "T"]);

    while (!done) {
      let rawInput;
      let input;

      if (deferMenuFullRefresh) {
        menuNeedsFullRefresh = true;
        deferMenuFullRefresh = false;
      }

      if (dashboardMode) {
        dashboardBridge.clearPendingPrompt();
        dashboardBridge.publishSnapshot();
      } else {
        const automationStatus = runtimeControls.getAutomationStatus
          ? runtimeControls.getAutomationStatus()
          : { paused: false, reason: "online" };
        if (menuNeedsFullRefresh) {
          printInteractiveMenu();
          menuNeedsFullRefresh = false;
        } else {
          printCompactPromptStatus(settings, {
            paused: automationStatus.paused,
            reason: automationStatus.reason,
            busy: actionInProgress,
            busyLabel: currentActionLabel,
            farmlistNext: nextFarmlistRunAt
              ? Math.max(0, Math.ceil((nextFarmlistRunAt - Date.now()) / 60000))
              : null,
            builderNext: nextBuilderRunAt
              ? Math.max(0, Math.ceil((nextBuilderRunAt - Date.now()) / 60000))
              : null
          });
        }
      }

      if (dashboardMode) {
        rawInput = null;
        while ((rawInput === null || rawInput === undefined) && !done && !menuSession.quitRequested) {
          const cmd = await dashboardBridge.waitForCommand(300);
          if (cmd !== null && cmd !== undefined && String(cmd).trim()) {
            rawInput = String(cmd).trim();
          }
        }
        if (rawInput === null || rawInput === undefined || menuSession.quitRequested) {
          break;
        }
        logInfo(`[Command] ${rawInput}`);
      } else {
        rawInput = (await askQuestion(menuRl, "Choose option: ")).trim();
      }
      input = rawInput.toUpperCase();
      deferMenuFullRefresh = menuFullRefreshInputs.has(input);

      const dashboardNoWait = new Set(["L", "P", "Q"]);
      if (
        dashboardMode &&
        !dashboardNoWait.has(input) &&
        !input.startsWith("@SELECT-VILLAGE ")
      ) {
        if (!(await waitForActionIdle("Dashboard command"))) {
          logWarn(`[Dashboard] Command "${rawInput}" timed out — session still busy`);
          continue;
        }
      }

      if (input.startsWith("@SELECT-VILLAGE ")) {
        const vid = Number(input.slice("@SELECT-VILLAGE ".length));
        const target = villageState.villages.find((v) => Number(v.id) === vid);
        if (!target) {
          logWarn(`[Dashboard] Unknown village id: ${vid}`);
          continue;
        }
        if (!(await waitForActionIdle("Dashboard village select"))) {
          continue;
        }
        villageState.selectedVillageId = target.id;
        await ensureVillageBrowserContext(target, "Dashboard select").catch(() => null);
        logSuccess(`Selected village context: ${villageDisplayName(target)}`);
        continue;
      }

      if (input === "1") {
        const startedAt = Date.now();
        await runAction(
          "Send Farmlists",
          async () => {
          logInfo("Running: Send Farmlists...");
          const sendResult = await runWithRandomDelay(
            settings,
            "Send Farmlists",
            () => sendFarmlists(getPage, settings, { villageId: resolveFarmlistVillageId() }),
            () => cancelRequested
          );
          if (sendResult && sendResult.status === "idle") {
            logInfo(String(sendResult.message || "No farmlists ready to send.").replace(/^\[Farmlist\]\s*/, ""));
          } else {
            logSuccess("Send Farmlists completed.");
          }
          await printSelectedVillageStatus("Farmlists");
          recordAction({
            actionType: "farmlist.send",
            status: sendResult && sendResult.status === "idle" ? "info" : "success",
            durationMs: Date.now() - startedAt,
            details: {
              source: "manual",
              idle: Boolean(sendResult && sendResult.status === "idle"),
              ...getVillageMeta("all")
            }
          });
        },
          { farmlistPriority: true }
        ).catch((error) => {
          const message = error.message || String(error);
          recordAction({
            actionType: "farmlist.send",
            status: "failed",
            durationMs: Date.now() - startedAt,
            details: {
              source: "manual",
              ...getVillageMeta("all")
            },
            errorMessage: message
          });
          logError(`Send Farmlists failed: ${message}`);
        });
        continue;
      }

      if (input === "2" || input === "3") {
        const selectedPlan = getBuilderPlanMeta(input === "3" ? "resource" : "village");
        activeBuilderPlanMode = selectedPlan.key;
        const startedAt = Date.now();
        await runAction(selectedPlan.name, async () => {
          let selectedVillage = getSelectedVillage();
          let roundRobinAdvanceStepManual = 1;
          let rrCandidateVillagesManual = [];
          let rrCursorManual = 0;
          if (settings.builderRoundRobinEnabled && villageState.villages.length > 0) {
            const excludedVillageIds = parsePivotVillageIdSet(settings.builderRoundRobinExcludedVillageIds);
            const nonCapitalVillages = villageState.villages.filter((village) => !village.isCapital);
            rrCandidateVillagesManual = nonCapitalVillages.filter(
              (village) =>
                !excludedVillageIds.has(Number(village.id)) &&
                !isBuilderPlanFullyComplete(village, selectedPlan.key)
            );
            if (rrCandidateVillagesManual.length) {
              const totalVillages = rrCandidateVillagesManual.length;
              rrCursorManual = ((roundRobinIndex % totalVillages) + totalVillages) % totalVillages;
              selectedVillage = rrCandidateVillagesManual[rrCursorManual] || rrCandidateVillagesManual[0];
              roundRobinAdvanceStepManual = 1;
              logInfo(`[Builder Manual] RR picked ${villageDisplayName(selectedVillage)} (${selectedPlan.short}).`);
            }
          }
          if (!selectedVillage) {
            logWarn("No village selected/available for builder. Use V to select a village first.");
            return;
          }

          // Show preview first
          const preview = builder.previewPlan(selectedVillage, { planMode: selectedPlan.key });
          printSubDivider(`${selectedPlan.name.toUpperCase()} PLAN`);

          if (preview.status === "all_complete") {
            logSuccess(preview.message);
            return;
          }

          if (preview.status === "template_complete") {
            logInfo(preview.message);
          }

          if (preview.status === "error") {
            logError(preview.message);
            return;
          }

          if (preview.status === "pending") {
            printKeyValueRows([
              { label: "Template", value: `${preview.templateName} (${preview.activeTemplate})` },
              { label: "Progress", value: `Stage ${preview.currentStageIndex + 1}/${preview.totalStages}` },
              { label: "Next step", value: preview.message }
            ]);

            if (preview.upcoming && preview.upcoming.length > 0) {
              printSubDivider("UPCOMING");
              preview.upcoming.forEach((item, idx) => {
                const marker = item.isCurrent
                  ? color(">>", ANSI.bold, ANSI.green)
                  : color("  ", ANSI.dim);
                console.log(
                  `  ${marker} ${color(`${idx + 1}.`, ANSI.bold, ANSI.cyan)} ${item.building} slot ${item.slot} -> lvl ${item.targetLevel} ${color(`(${item.stageName})`, ANSI.gray)}`
                );
              });
            }
          }

          // Execute the next step
          logInfo("Executing next build step...");
          const result = await runWithRandomDelay(
            settings,
            selectedPlan.name,
            () =>
              builder.runBuilderStep(getPage, settings, selectedVillage, {
                goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                goldCompleteMax: settings.builderGoldCompleteMax,
                masterBuilderEnabled: settings.builderMasterBuilderEnabled,
                planMode: selectedPlan.key
              }),
            () => cancelRequested
          );
          let finalResult = result;

          // Match scheduled builder behavior: when a step is already satisfied or a template just
          // completed, keep progressing in the same manual run so we do not appear "stuck" on
          // template boundaries.
          const maxFollowupAttempts = 20;
          const maxFollowupElapsedMs = 120000;
          let followupAttempt = 0;
          const followupStartedAt = Date.now();
          while (
            finalResult &&
            (finalResult.status === "already_satisfied" ||
              finalResult.status === "template_complete" ||
              finalResult.status === "realigned_template") &&
            followupAttempt < maxFollowupAttempts
          ) {
            if (Date.now() - followupStartedAt > maxFollowupElapsedMs) {
              logInfo("[Builder Manual] Follow-up retry budget reached for this run.");
              break;
            }
            logInfo(`[Builder Manual] ${finalResult.status}: ${finalResult.message} Retrying next step...`);
            finalResult = await builder.runBuilderStep(getPage, settings, selectedVillage, {
              goldCompleteEnabled: settings.builderGoldCompleteEnabled,
              goldCompleteMax: settings.builderGoldCompleteMax,
              masterBuilderEnabled: settings.builderMasterBuilderEnabled,
              planMode: selectedPlan.key
            });
            followupAttempt += 1;
          }

          const isTemporaryBlockedBuilderStatus = (status) =>
            String(status || "").startsWith("blocked_") || status === "idle_saturated";

          if (
            settings.builderRoundRobinEnabled &&
            isTemporaryBlockedBuilderStatus(finalResult && finalResult.status) &&
            rrCandidateVillagesManual.length > 1
          ) {
            for (let hop = 1; hop < rrCandidateVillagesManual.length; hop += 1) {
              const nextCursor = (rrCursorManual + hop) % rrCandidateVillagesManual.length;
              const nextVillage = rrCandidateVillagesManual[nextCursor];
              if (!nextVillage || Number(nextVillage.id) === Number(selectedVillage.id)) {
                continue;
              }
              logInfo(
                `[Builder Manual] ${finalResult.status} on ${villageDisplayName(selectedVillage)}. ` +
                `Trying next RR village: ${villageDisplayName(nextVillage)}...`
              );
              selectedVillage = nextVillage;
              rrCursorManual = nextCursor;
              roundRobinAdvanceStepManual = hop + 1;
              await ensureVillageBrowserContext(selectedVillage, "Builder Manual");
              const hoppedResult = await builder.runBuilderStep(getPage, settings, selectedVillage, {
                goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                goldCompleteMax: settings.builderGoldCompleteMax,
                masterBuilderEnabled: settings.builderMasterBuilderEnabled,
                planMode: selectedPlan.key
              });
              finalResult = hoppedResult;
              if (!isTemporaryBlockedBuilderStatus(finalResult && finalResult.status)) {
                break;
              }
            }
          }

          // Display result
          if (finalResult.report) {
            printSubDivider("BUILD STEP RESULT");
            const r = finalResult.report;
            const costText = Object.keys(r.costs).length > 0
              ? Object.entries(r.costs).map(([k, v]) => `${k}: ${v}`).join(" | ")
              : "N/A";
            const stockText = `W:${r.stock.wood} C:${r.stock.clay} I:${r.stock.iron} Cr:${r.stock.crop}`;
            const storageText = `WH:${r.warehouseCap} GR:${r.granaryCap}`;
            const availableBuildOptions = Array.isArray(r.availableNewBuildingOptions)
              ? r.availableNewBuildingOptions
              : [];
            const normalizeName = (value) =>
              String(value || "")
                .toLowerCase()
                .replace(/\u00a0/g, " ")
                .replace(/[^a-z0-9]+/g, " ")
                .trim()
                .replace(/\s+/g, " ");
            const targetName = normalizeName(r.targetBuilding);
            const targetCompact = targetName.replace(/\s+/g, "");
            const optionsText = availableBuildOptions.length > 0
              ? availableBuildOptions
                .map((opt) => {
                  const optionLabel = `${opt.name || "?"}${opt.canBuild ? "" : " (locked)"}`;
                  const optionName = normalizeName(opt.name);
                  const optionCompact = optionName.replace(/\s+/g, "");
                  const isTarget =
                    Boolean(targetCompact) &&
                    Boolean(optionCompact) &&
                    (optionName === targetName || optionCompact === targetCompact);

                  return isTarget
                    ? color(optionLabel, ANSI.red, ANSI.bold)
                    : optionLabel;
                })
                .join(color(" | ", ANSI.dim))
              : "N/A";
            const upgradeStatus = (() => {
              if (r.isEmptySlot) {
                return "N/A";
              }
              const hasRegular = Boolean(r.hasUpgradeButton);
              const regularState = hasRegular ? (r.upgradeDisabled ? "regular (disabled)" : "regular") : "regular: none";
              const hasMb = Boolean(r.hasMasterBuilderUpgradeButton);
              const mbState = hasMb ? (r.masterBuilderUpgradeDisabled ? "MB (disabled)" : "MB") : "MB: none";
              return `${regularState} | ${mbState}`;
            })();
            printKeyValueRows([
              { label: "Slot", value: String(r.slot) },
              { label: "Building", value: `${r.currentBuilding || r.targetBuilding} (target: ${r.targetBuilding})` },
              { label: "Level", value: `${r.currentLevel} -> ${r.targetLevel}` },
              { label: "Cost", value: costText },
              { label: "Stock", value: stockText },
              { label: "Storage", value: storageText },
              { label: "Upgrade btn", value: upgradeStatus },
              { label: "Gold used", value: `${finalResult.goldCompletions || 0} completion(s), ${finalResult.goldSpent || 0} gold` },
              { label: "Build options", value: optionsText, raw: true }
            ]);
          }

          if (finalResult.status === "success") {
            logSuccess(finalResult.message);
            recordAction({
              actionType: "building.upgrade",
              status: "success",
              durationMs: Date.now() - startedAt,
              details: {
                planMode: selectedPlan.key,
                template: finalResult.report.template,
                stage: finalResult.report.stage,
                slot: finalResult.report.slot,
                building: finalResult.report.targetBuilding,
                fromLevel: finalResult.report.currentLevel,
                toLevel: finalResult.report.targetLevel,
                goldCompleted: finalResult.goldCompletions || 0,
                goldSpent: finalResult.goldSpent || 0,
                ...getVillageMeta("single")
              }
            });
            if (finalResult.goldCompletions > 0) {
              logInfo(`Builder: Gold autocomplete used ${finalResult.goldCompletions} time(s), spent ${finalResult.goldSpent || 0} gold.`);
              recordAction({
                actionType: "building.gold_complete",
                status: "success",
                durationMs: 0,
                details: {
                  planMode: selectedPlan.key,
                  slot: finalResult.report.slot,
                  building: finalResult.report.targetBuilding,
                  completions: finalResult.goldCompletions,
                  goldSpent: finalResult.goldSpent || 0,
                  ...getVillageMeta("single")
                }
              });
            }
          } else if (finalResult.status === "realigned_template") {
            logWarn(`Builder: ${finalResult.message}`);
          } else if (finalResult.status === "already_satisfied") {
            logInfo(finalResult.message);
          } else if (finalResult.status === "template_complete") {
            logSuccess(finalResult.message);
          } else if (finalResult.status === "all_complete") {
            logSuccess(finalResult.message);
          } else if (finalResult.status === "blocked_resources") {
            logInfo(`Builder: ${finalResult.message}`);
            await attemptResourceCirculation({
              kind: "builder",
              buildResult: finalResult,
              source: "manual",
              targetVillage: selectedVillage,
              planMode: selectedPlan.key
            });
            recordAction({
              actionType: "building.upgrade",
              status: "failed",
              durationMs: Date.now() - startedAt,
              details: {
                planMode: selectedPlan.key,
                template: finalResult.report ? finalResult.report.template : null,
                slot: finalResult.report ? finalResult.report.slot : null,
                building: finalResult.report ? finalResult.report.targetBuilding : null,
                reason: finalResult.status,
                ...getVillageMeta("single")
              },
              errorMessage: finalResult.message
            });
          } else {
            logWarn(`Builder: ${finalResult.message}`);
            recordAction({
              actionType: "building.upgrade",
              status: "failed",
              durationMs: Date.now() - startedAt,
              details: {
                planMode: selectedPlan.key,
                template: finalResult.report ? finalResult.report.template : null,
                slot: finalResult.report ? finalResult.report.slot : null,
                building: finalResult.report ? finalResult.report.targetBuilding : null,
                reason: finalResult.status,
                ...getVillageMeta("single")
              },
              errorMessage: finalResult.message
            });
          }

          if (settings.builderRoundRobinEnabled) {
            roundRobinIndex += Math.max(1, roundRobinAdvanceStepManual);
          }
        }).catch((error) => {
          const message = error.message || String(error);
          recordAction({
            actionType: "building.upgrade",
            status: "failed",
            durationMs: Date.now() - startedAt,
            details: {
              planMode: selectedPlan.key,
              ...getVillageMeta("single")
            },
            errorMessage: message
          });
          logError(`${selectedPlan.name} failed: ${message}`);
        });
        continue;
      }

      if (input === "0") {
        await runAction("Village Status", async () => {
          const selectedVillage = getSelectedVillage();
          logInfo("Reading: Village Status...");
          await runWithRandomDelay(
            settings,
            "Village Status",
            () =>
              showVillageStatus(
                getPage,
                settings,
                selectedVillage ? selectedVillage.id : null,
                selectedVillage || null
              ),
            () => cancelRequested
          );
        }).catch((error) => {
          logError(`Village Status failed: ${error.message || error}`);
        });
        continue;
      }

      if (input === "4") {
        const startedAt = Date.now();
        await runAction("Troop Trainer", async () => {
          const selectedVillage = getSelectedVillage();
          if (!selectedVillage) {
            logWarn("No village selected. Use V to select a village first.");
            return;
          }
          const plan = troopPlans.resolvePlanForVillage(selectedVillage);
          if (!plan) {
            logWarn(
              `No troop plan assigned to ${villageDisplayName(selectedVillage)}. Assign one in Troop Plans (menu T → V).`
            );
            return;
          }
          const branches = troopPlans.planBranches(plan);
          if (!branches.length) {
            logWarn(`Plan "${plan.name}" has no units set. Edit it in Troop Plans (menu T).`);
            return;
          }
          logInfo(`Running: Troop Trainer — plan "${plan.name}" (${troopPlans.describePlan(plan)}).`);
          await ensureVillageBrowserContext(selectedVillage, "Troop Trainer");
          const outcomes = [];
          for (const branch of branches) {
            if (cancelRequested) {
              break;
            }
            const result = await runWithRandomDelay(
              settings,
              "Troop Trainer",
              () => trainPlanBranch(getPage, settings, selectedVillage.id, branch),
              () => cancelRequested
            );
            outcomes.push(result);
            logTroopBranchOutcome(selectedVillage, result);
          }
          const trained = outcomes.filter((o) => o && o.status === "trained");
          recordAction({
            actionType: "troop.train",
            status: trained.length ? "success" : "info",
            durationMs: Date.now() - startedAt,
            details: {
              source: "manual",
              plan: plan.name,
              trained: trained.map((o) => ({ unit: o.unitName, qty: o.queued, building: o.building })),
              ...getVillageMeta("single")
            }
          });
        }).catch((error) => {
          const message = error.message || String(error);
          recordAction({
            actionType: "troop.train",
            status: "failed",
            durationMs: Date.now() - startedAt,
            details: {
              source: "manual",
              ...getVillageMeta("single")
            },
            errorMessage: message
          });
          logError(`Troop Trainer failed: ${message}`);
        });
        continue;
      }

      if (input === "C") {
        const startedAt = Date.now();
        await runAction(
          "Cranny defense",
          async () => {
            const selectedVillage =
              getSelectedVillage() || resolveBuilderFallbackVillage();
            if (!selectedVillage) {
              logWarn("No village context. Use V to select a village or refresh the village list.");
              return;
            }
            logInfo("Running: Cranny defense (one step)...");
            await ensureVillageBrowserContext(selectedVillage, "Cranny defense");
            const result = await runWithRandomDelay(
              settings,
              "Cranny defense",
              () =>
                builder.runCrannyDefenseStep(getPage, settings, selectedVillage, {
                  goldCompleteEnabled: settings.builderGoldCompleteEnabled,
                  goldCompleteMax: settings.builderGoldCompleteMax,
                  masterBuilderEnabled: settings.builderMasterBuilderEnabled
                }),
              () => cancelRequested
            );
            const ok = result && (result.status === "success" || result.status === "idle_saturated");
            recordAction({
              actionType: "building.cranny_defense",
              status: ok ? "success" : "info",
              durationMs: Date.now() - startedAt,
              details: {
                status: result && result.status,
                message: result && result.message,
                report: result && result.report,
                ...getVillageMeta("single")
              }
            });
            if (result.status === "success") {
              logSuccess(result.message || "Cranny defense step completed.");
            } else if (result.status === "idle_saturated") {
              logInfo(result.message || "Nothing to do for Cranny defense.");
            } else {
              logWarn(result.message || String(result.status || "Cranny defense skipped."));
            }
          },
          { preemptAutoBuilder: true, raidGuardPriority: true }
        ).catch((error) => {
          const message = error.message || String(error);
          recordAction({
            actionType: "building.cranny_defense",
            status: "failed",
            durationMs: Date.now() - startedAt,
            details: {
              ...getVillageMeta("single")
            },
            errorMessage: message
          });
          logError(`Cranny defense failed: ${message}`);
        });
        continue;
      }

      if (input === "T") {
        await runTroopTemplateCategoryMenu();
        if (menuSession.quitRequested) {
          done = true;
        }
        continue;
      }

      if (input === "5") {
        const startedAt = Date.now();
        await runAction("Expansion / Residence Check", async () => {
          const selectedVillage = getSelectedVillage();
          if (!selectedVillage) {
            logWarn("No village selected. Use V to select a village first.");
            return;
          }
          logInfo("Running: Expansion / Residence Check...");
          const result = await runWithRandomDelay(
            settings,
            "Expansion Check",
            () =>
              villageExpansion.runExpansionStep(
                getPage,
                settings,
                selectedVillage
              ),
            () => cancelRequested
          );
          printSubDivider("EXPANSION STATUS");
          printKeyValueRows([
            { label: "Village", value: villageDisplayName(selectedVillage) },
            { label: "Status", value: result.status },
            { label: "Phase", value: result.phase || "N/A" },
            { label: "Message", value: result.message }
          ]);
          if (result.residenceLevel !== undefined) {
            console.log(`  Residence Level: ${result.residenceLevel}`);
          }
          if (result.settlers !== undefined) {
            console.log(`  Settlers: ${result.settlers}`);
          }
          if (result.queued !== undefined) {
            console.log(`  Queued: ${result.queued}`);
          }
          if (
            result.status === "need_settlement_resources" ||
            result.status === "need_residence_resources" ||
            result.status === "need_settler_training_resources"
          ) {
            await attemptResourceCirculation({
              kind: "settlement",
              expansionResult: result,
              source: "manual",
              targetVillage: selectedVillage,
              planMode: "village"
            });
          }
          let settleResult = null;
          if (result.status === "ready_to_expand" || result.status === "settlers_ready") {
            logInfo("Settlers are ready. Dispatching automatically...");
            let preferredTargets = [];
            if (settings.expansionUsePlannedTargets) {
              const loaded = loadPlannedSettlementTargetsFromFile(settings.expansionPlannedTargetsFile);
              if (!loaded.ok) {
                logWarn(`${loaded.message}`);
              } else {
                preferredTargets = loaded.targets;
                logInfo(`Loaded ${preferredTargets.length} planned target(s) from file.`);
              }
            }
            settleResult = await runWithRandomDelay(
              settings,
              "Settle New Village",
              () =>
                villageExpansion.sendSettlersToFoundVillage(
                  getPage(),
                  selectedVillage,
                  undefined,
                  undefined,
                  { preferredTargets, settings }
                ),
              () => cancelRequested
            );

            if (
              settleResult &&
              settleResult.status === "settle_dispatched" &&
              settleResult.targetSource === "planned" &&
              Number.isFinite(settleResult.plannedTargetIndex)
            ) {
              const loaded = loadPlannedSettlementTargetsFromFile(settings.expansionPlannedTargetsFile);
              const currentTargets = loaded.ok ? loaded.targets : [];
              if (settleResult.plannedTargetIndex >= 0 && settleResult.plannedTargetIndex < currentTargets.length) {
                currentTargets.splice(settleResult.plannedTargetIndex, 1);
                const savedPath = savePlannedSettlementTargetsToFile(
                  settings.expansionPlannedTargetsFile,
                  currentTargets
                );
                logInfo(`Removed used planned target from ${savedPath}. Remaining: ${currentTargets.length}`);
              }
            }

            if (settleResult && settleResult.status === "no_settle_target_found") {
              logWarn("Auto-target failed. Skipping manual prompt for this cycle.");
            }

            if (settleResult) {
              printSubDivider("SETTLEMENT STATUS");
              printKeyValueRows([
                { label: "Status", value: settleResult.status },
                { label: "Phase", value: settleResult.phase || "N/A" },
                { label: "Target Source", value: settleResult.targetSource || "unknown" },
                { label: "Message", value: settleResult.message }
              ]);
              if (settleResult.status === "settle_dispatched" && settleResult.target) {
                logSuccess(
                  `Settlers sent successfully to (${settleResult.target.x}|${settleResult.target.y})`
                );
              }
            }
          }
          recordAction({
            actionType: "village.expansion",
            status: settleResult
              ? (settleResult.status === "settle_dispatched" ? "success" : "info")
              : (result.status === "ready_to_expand" || result.status === "settlers_queued" || result.status === "settlers_ready" ? "success" : "info"),
            durationMs: Date.now() - startedAt,
            details: {
              villageId: selectedVillage.id,
              villageName: selectedVillage.name,
              status: result.status,
              phase: result.phase,
              residenceLevel: result.residenceLevel,
              settlers: result.settlers,
              queued: result.queued,
              settlementStatus: settleResult ? settleResult.status : null,
              settlementTarget: settleResult && settleResult.target ? settleResult.target : null
            }
          });
        }).catch((error) => {
          const message = error.message || String(error);
          recordAction({
            actionType: "village.expansion",
            status: "failed",
            durationMs: Date.now() - startedAt,
            details: {
              ...getVillageMeta("single")
            },
            errorMessage: message
          });
          logError(`Expansion check failed: ${message}`);
        });
        continue;
      }

      if (input === "X") {
        const wasEnabled = settings.builderLoopEnabled;

        if (runtimeControls.updateBuilderLoopConfig) {
          try {
            const applied = await runtimeControls.updateBuilderLoopConfig({
              enabled: false,
              minMinutes: settings.builderLoopMinMinutes,
              maxMinutes: settings.builderLoopMaxMinutes
            });
            settings.builderLoopEnabled = applied.enabled;
            settings.builderLoopMinMinutes = applied.minMinutes;
            settings.builderLoopMaxMinutes = applied.maxMinutes;
          } catch (error) {
            logWarn(`Could not persist builder loop OFF state: ${error.message || error}`);
            settings.builderLoopEnabled = false;
          }
        } else {
          settings.builderLoopEnabled = false;
        }

        cancelBuilderLoopTimer();

        const isBuilderActionRunning =
          actionInProgress && /builder/i.test(String(currentActionLabel || ""));
        if (isBuilderActionRunning) {
          cancelRequested = true;
          const currentPage = getPage();
          if (currentPage && !currentPage.isClosed()) {
            currentPage.evaluate(() => {
              if (typeof window.stop === "function") {
                window.stop();
              }
            }).catch(() => {});
          }
          logInfo("Stop requested for current builder action...");
        }

        if (wasEnabled || isBuilderActionRunning) {
          logSuccess("Builder process stopped (loop disabled and current builder action canceled if active).");
        } else {
          logInfo("Builder process is already stopped.");
        }
        continue;
      }

      if (input === "R") {
        if (!runtimeControls.reloginNow) {
          logWarn("Relogin control is unavailable in this runtime.");
          continue;
        }

        const withStatusAfterRelogin = rawInput === "R";
        await runAction("Relogin Now", async () => {
          logInfo("Re-login requested. Refreshing session now...");
          const result = await runtimeControls.reloginNow("manual-menu");
          if (result && result.ok) {
            logSuccess("Re-login complete.");
            if (withStatusAfterRelogin) {
              await printSelectedVillageStatus("Relogin");
            }
          } else {
            logWarn("Re-login finished with an unknown status.");
          }
        }, { allowWhilePaused: true }).catch((error) => {
          logError(`Relogin failed: ${error.message || error}`);
        });
        continue;
      }

      if (input === "Y") {
        await runProxySettingsMenu(menuRl, settings, runtimeControls);
        if (menuSession.quitRequested) {
          done = true;
        }
        continue;
      }

      if (input === "V") {
        await runVillageSelectorMenu().catch((error) => {
          logError(`Village selector failed: ${error.message || error}`);
        });
        if (menuSession.quitRequested) {
          done = true;
        }
        continue;
      }

      if (input === "L") {
        await showLogSummary().catch((error) => {
          logError(`Log summary failed: ${error.message || error}`);
        });
        continue;
      }

      if (input === "O") {
        await executeTop10TrackingSnapshot("manual").catch((error) => {
          logError(`Top 10 snapshot failed: ${error.message || error}`);
        });
        continue;
      }

      if (input === "P") {
        if (!runtimeControls.setAutomationPaused || !runtimeControls.getAutomationStatus) {
          logWarn("Pause control is unavailable in this runtime.");
          continue;
        }
        const current = runtimeControls.getAutomationStatus();
        const next = runtimeControls.setAutomationPaused(!current.paused);
        if (next && next.paused) {
          logSuccess(`Automation paused (${next.reason || "manual_pause"}).`);
        } else {
          logSuccess("Automation resumed.");
        }
        continue;
      }

      if (input === "S") {
        settings.headless = runtimeControls.getHeadlessMode();
        await runSettingsMenu(menuRl, settings, {
          ...runtimeControls,
          menuSession,
          troopPlanHooks,
          refreshSideInfoVillages: async () =>
            refreshVillageState({ navigateToStatusPage: true, silent: true }),
          getRaidPivotVillageUiState: () => ({
            villages: villageState.villages.slice(),
            selectedVillageId: villageState.selectedVillageId,
            activeVillageId: villageState.activeVillageId
          })
        });
        if (menuSession.quitRequested) {
          done = true;
          continue;
        }
        scheduleFarmlistLoop();
        scheduleBuilderLoop();
        scheduleTroopTrainingLoop();
        scheduleCrannyDefenseLoop();
        scheduleActivitySimulationLoop();
        scheduleTop10TrackingLoop();
        scheduleRaidEvacuationLoop();
        continue;
      }

      if (input === "Q") {
        requestQuit();
        continue;
      }

      logWarn("Unknown option. Use 0, 1, 2, 3, T, C, 4, 5, X, r, R, V, L, O, P, S, or Q.");
    }
  } finally {
    if (dashboardBridge) {
      dashboardBridge.setQuitHandler(null);
      dashboardBridge.setTroopSettingsProvider(null);
      dashboardBridge.setTroopSettingsUpdater(null);
      dashboardBridge.setActivitySettingsUpdater(null);
      dashboardBridge.setDisplaySettingsUpdater(null);
    }
    if (sigintHandler) {
      process.removeListener("SIGINT", sigintHandler);
      if (!terminalRl.closed) {
        terminalRl.removeListener("SIGINT", sigintHandler);
      }
      sigintHandler = null;
    }
    if (farmlistLoopTimer) {
      clearTimeout(farmlistLoopTimer);
      farmlistLoopTimer = null;
    }
    if (builderLoopTimer) {
      clearTimeout(builderLoopTimer);
      builderLoopTimer = null;
    }
    if (activitySimulationLoopTimer) {
      clearTimeout(activitySimulationLoopTimer);
      activitySimulationLoopTimer = null;
    }
    if (top10TrackingLoopTimer) {
      clearTimeout(top10TrackingLoopTimer);
      top10TrackingLoopTimer = null;
    }
    for (const state of troopVillageLoopState.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    troopVillageLoopState.clear();
    if (crannyDefenseLoopTimer) {
      clearTimeout(crannyDefenseLoopTimer);
      crannyDefenseLoopTimer = null;
    }
    if (raidEvacuationLoopTimer) {
      clearTimeout(raidEvacuationLoopTimer);
      raidEvacuationLoopTimer = null;
    }
    menuRl.close();
  }
}

module.exports = {
  runTerminalMenu
};
