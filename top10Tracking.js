const fs = require("fs");
const path = require("path");
const { safeGotoWithRetry } = require("./browserNavigation");

const LOG_SCHEMA_VERSION = 1;
const DEFAULT_TOP10_LOG_FILE = "top10.log";

const TRACKING_CATEGORIES = [
  {
    id: "attackers",
    label: "Attackers",
    tabPatterns: ["attacker", "attackers", "offensive", "off"],
    urlPaths: [
      "/statistics/player/top10/attackers",
      "/statistics/player/top10/attacker",
      "/statistics/top10/attackers",
      "/statistics/top10/attacker"
    ]
  },
  {
    id: "defenders",
    label: "Defenders",
    tabPatterns: ["defender", "defenders", "defensive", "def"],
    urlPaths: [
      "/statistics/player/top10/defenders",
      "/statistics/player/top10/defender",
      "/statistics/top10/defenders",
      "/statistics/top10/defender"
    ]
  },
  {
    id: "robbers",
    label: "Robbers",
    tabPatterns: ["robber", "robbers", "raider", "raiders", "raid"],
    urlPaths: [
      "/statistics/player/top10/robbers",
      "/statistics/player/top10/robber",
      "/statistics/player/top10/raiders",
      "/statistics/top10/robbers",
      "/statistics/top10/raider"
    ]
  },
  {
    id: "climbers",
    label: "Climbers",
    tabPatterns: ["climber", "climbers", "climb"],
    urlPaths: [
      "/statistics/player/top10/climbers",
      "/statistics/player/top10/climber",
      "/statistics/top10/climbers",
      "/statistics/top10/climber"
    ]
  },
  {
    id: "population",
    label: "Population",
    tabPatterns: ["population", "inhabitants", "pop"],
    urlPaths: ["/statistics/player", "/statistics/player/population", "/statistics/population"]
  },
  {
    id: "alliances",
    label: "Alliances",
    tabPatterns: ["alliance", "alliances"],
    urlPaths: ["/statistics/alliance", "/statistics/alliances"]
  },
  {
    id: "villages",
    label: "Villages",
    tabPatterns: ["village", "villages"],
    urlPaths: ["/statistics/village", "/statistics/villages"]
  }
];

function gameOrigin(settings) {
  try {
    return new URL(settings.villageStatusUrl || settings.farmlistUrl || "https://example.com").origin;
  } catch (_error) {
    return "https://example.com";
  }
}

function resolveLogFilePath(settings) {
  const configured = String(
    settings.top10TrackingLogFile || process.env.TOP10_TRACKING_LOG_FILE || DEFAULT_TOP10_LOG_FILE
  ).trim();
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function ensureLogDirectory(logFilePath) {
  const dir = path.dirname(logFilePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendTop10LogLine(logFilePath, entry) {
  ensureLogDirectory(logFilePath);
  fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function listCategories() {
  return TRACKING_CATEGORIES.map(({ id, label }) => ({ id, label }));
}

function buildCategoryUrls(origin, category) {
  const urls = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    urls.push(value);
  };

  for (const suffix of category.urlPaths || []) {
    add(`${origin}${suffix.startsWith("/") ? suffix : `/${suffix}`}`);
  }

  add(`${origin}/statistics`);
  return urls;
}

async function pageHasRankingTable(page) {
  return page
    .evaluate(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const parseRank = (text) => {
        const match = normalize(text).match(/(\d+)/);
        return match ? Number(match[1]) : null;
      };

      const tables = Array.from(document.querySelectorAll("table"));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
          (row) => row.querySelectorAll("td").length >= 2
        );
        if (rows.length < 3) {
          continue;
        }
        let rankHits = 0;
        for (const row of rows.slice(0, 12)) {
          const rank = parseRank(row.querySelector("td")?.textContent || "");
          if (rank && rank >= 1 && rank <= 100) {
            rankHits += 1;
          }
        }
        if (rankHits >= 3) {
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function clickCategoryTab(page, category) {
  const clicked = await page
    .evaluate(({ tabPatterns, categoryId }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const elements = Array.from(
        document.querySelectorAll('a[href], button, [role="tab"], .tab, .subtab, li')
      );
      const patterns = Array.isArray(tabPatterns) ? tabPatterns.map((p) => p.toLowerCase()) : [];
      patterns.push(String(categoryId || "").toLowerCase());

      for (const el of elements) {
        const text = normalize(el.textContent);
        const href = normalize(el.getAttribute("href") || el.getAttribute("data-href") || "");
        const id = normalize(el.id || "");
        const cls = normalize(el.className || "");
        const haystack = `${text} ${href} ${id} ${cls}`;
        if (patterns.some((pattern) => pattern && haystack.includes(pattern))) {
          el.click();
          return true;
        }
      }
      return false;
    }, { tabPatterns: category.tabPatterns, categoryId: category.id })
    .catch(() => false);

  if (clicked) {
    await page.waitForTimeout(600).catch(() => {});
  }
  return clicked;
}

async function navigateToCategory(page, settings, category) {
  const origin = gameOrigin(settings);
  const urls = buildCategoryUrls(origin, category);

  for (const url of urls) {
    try {
      await safeGotoWithRetry(page, url);
      await page.waitForTimeout(400).catch(() => {});
      if (url.endsWith("/statistics")) {
        await clickCategoryTab(page, category);
      }
      if (await pageHasRankingTable(page)) {
        return url;
      }
    } catch (_error) {
      /* try next URL */
    }
  }

  return null;
}

async function scrapeInGamePlayerName(page) {
  return page
    .evaluate(() => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const selectors = [
        "#userName",
        "#playerName a",
        "#playerName",
        ".playerName",
        ".player-name",
        "#menuAccount .player",
        "#menuAccount a",
        "a[href*='profile']",
        "a[href*='spieler']"
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const text = normalize(el && el.textContent);
        if (text && text.length >= 2 && text.length <= 64) {
          return text;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function scrapeCategoryRankings(page, options = {}) {
  const selfNames = Array.isArray(options.selfNames)
    ? options.selfNames.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 10));

  return page.evaluate(
    ({ selfNamesLower, limitRows }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const parseRank = (text) => {
        const match = normalize(text).match(/(\d+)/);
        return match ? Number(match[1]) : null;
      };

      const parseMetricValue = (text) => {
        const raw = normalize(text);
        if (!raw) {
          return { value: null, valueText: raw };
        }
        const match = raw.match(/([\d.,]+)\s*([kKmMbB])?/);
        if (!match) {
          const digits = raw.replace(/[^\d]/g, "");
          if (digits) {
            return { value: Number(digits), valueText: raw };
          }
          return { value: null, valueText: raw };
        }
        let value = Number(String(match[1]).replace(/,/g, ""));
        const suffix = String(match[2] || "").toLowerCase();
        if (suffix === "k") {
          value *= 1000;
        } else if (suffix === "m") {
          value *= 1000000;
        } else if (suffix === "b") {
          value *= 1000000000;
        }
        if (!Number.isFinite(value)) {
          return { value: null, valueText: raw };
        }
        return { value: Math.round(value), valueText: raw };
      };

      const rowLooksOwn = (row) => {
        const cls = String(row.className || "").toLowerCase();
        if (/(\bown\b|\bme\b|\bmy\b|highlight|selected|active-row)/.test(cls)) {
          return true;
        }
        return Boolean(row.querySelector(".own, .me, .my, .hl, .marked"));
      };

      const extractAlliance = (cells, nameCellIndex) => {
        for (let i = 0; i < cells.length; i += 1) {
          if (i === nameCellIndex) {
            continue;
          }
          const link = cells[i].querySelector('a[href*="alliance"], a[href*="allianz"]');
          const text = normalize(link ? link.textContent : cells[i].textContent);
          if (text && text.length <= 12 && !/^\d/.test(text)) {
            return text;
          }
        }
        const nameText = normalize(cells[nameCellIndex]?.textContent || "");
        const bracket = nameText.match(/\(([A-Za-z0-9._\-]{1,12})\)/);
        return bracket ? bracket[1] : null;
      };

      const extractName = (cells) => {
        for (let i = 0; i < cells.length; i += 1) {
          const link = cells[i].querySelector(
            'a[href*="profile"], a[href*="spieler"], a[href*="player"], a[href*="village"], a[href*="dorf"]'
          );
          const text = normalize(link ? link.textContent : cells[i].textContent);
          if (text && !/^\d+$/.test(text) && text.length >= 2) {
            return { name: text.replace(/\s*\([^)]*\)\s*$/, "").trim(), nameCellIndex: i };
          }
        }
        const fallback = normalize(cells[1]?.textContent || cells[0]?.textContent || "");
        return { name: fallback.replace(/\s*\([^)]*\)\s*$/, "").trim(), nameCellIndex: 1 };
      };

      const extractMetricCell = (cells, nameCellIndex, rank) => {
        let best = { value: null, valueText: "" };
        for (let i = cells.length - 1; i >= 0; i -= 1) {
          if (i === nameCellIndex || i === 0) {
            continue;
          }
          const metric = parseMetricValue(cells[i].textContent || "");
          if (metric.value != null && metric.value >= rank) {
            return metric;
          }
          if (metric.valueText && !best.valueText) {
            best = metric;
          }
        }
        return best;
      };

      const tables = Array.from(document.querySelectorAll("table"));
      const candidates = [];
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
          (row) => row.querySelectorAll("td").length >= 2
        );
        if (rows.length < 3) {
          continue;
        }
        let rankHits = 0;
        for (const row of rows.slice(0, 15)) {
          const rank = parseRank(row.querySelector("td")?.textContent || "");
          if (rank && rank >= 1 && rank <= 100) {
            rankHits += 1;
          }
        }
        if (rankHits >= 3) {
          candidates.push({ table, score: rankHits + rows.length });
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      const warnings = [];
      if (!candidates.length) {
        return { top10: [], self: null, warnings: ["no ranking table found"] };
      }

      const table = candidates[0].table;
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
        (row) => row.querySelectorAll("td").length >= 2
      );

      const entries = [];
      let self = null;

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        const rank = parseRank(cells[0]?.textContent || "");
        if (!rank || rank > 500) {
          continue;
        }

        const { name, nameCellIndex } = extractName(cells);
        if (!name) {
          continue;
        }

        const metric = extractMetricCell(cells, nameCellIndex, rank);
        const alliance = extractAlliance(cells, nameCellIndex);
        const tribeCell = cells.find((cell) =>
          /(roman|teuton|gaul|egyptian|hun|spartan|natar)/i.test(cell.textContent || "")
        );
        const entry = {
          rank,
          name,
          alliance,
          tribe: tribeCell ? normalize(tribeCell.textContent) : null,
          value: metric.value,
          valueText: metric.valueText || null
        };

        const ownByClass = rowLooksOwn(row);
        const ownByName = selfNamesLower.some(
          (needle) => needle && name.toLowerCase().includes(needle)
        );
        if (ownByClass || ownByName) {
          self = {
            ...entry,
            inTop10: rank <= limitRows,
            matchedBy: ownByClass ? "row-class" : "name"
          };
        }

        if (rank <= limitRows) {
          entries.push(entry);
        }
      }

      if (!self && selfNamesLower.length) {
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          const rank = parseRank(cells[0]?.textContent || "");
          if (!rank) {
            continue;
          }
          const { name, nameCellIndex } = extractName(cells);
          if (!name) {
            continue;
          }
          if (!selfNamesLower.some((needle) => name.toLowerCase().includes(needle))) {
            continue;
          }
          const metric = extractMetricCell(cells, nameCellIndex, rank);
          self = {
            rank,
            name,
            alliance: extractAlliance(cells, nameCellIndex),
            tribe: null,
            value: metric.value,
            valueText: metric.valueText || null,
            inTop10: rank <= limitRows,
            matchedBy: "name-scan"
          };
          break;
        }
      }

      if (!entries.length) {
        warnings.push("table found but no ranked rows parsed");
      }

      return {
        top10: entries.slice(0, limitRows),
        self,
        warnings
      };
    },
    { selfNamesLower: selfNames, limitRows: limit }
  );
}

async function runTop10TrackingSnapshot(getPage, settings, options = {}) {
  const page = getPage();
  if (!page || page.isClosed()) {
    throw new Error("Session page is currently unavailable.");
  }

  const logFilePath = resolveLogFilePath(settings);
  const origin = gameOrigin(settings);
  let gameHost = null;
  try {
    gameHost = new URL(origin).hostname;
  } catch (_error) {
    gameHost = origin;
  }

  const configuredSelfName = String(
    settings.top10TrackingPlayerName || options.playerName || options.username || ""
  ).trim();
  const scrapedSelfName = configuredSelfName ? null : await scrapeInGamePlayerName(page);
  const selfNames = [configuredSelfName, scrapedSelfName, options.username]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const capturedAt = new Date();
  const ts = capturedAt.toISOString();
  const epochMs = capturedAt.getTime();
  const results = [];

  for (const category of TRACKING_CATEGORIES) {
    const sourceUrl = await navigateToCategory(page, settings, category);
    if (!sourceUrl) {
      const entry = {
        v: LOG_SCHEMA_VERSION,
        ts,
        epochMs,
        gameHost,
        category: category.id,
        categoryLabel: category.label,
        sourceUrl: null,
        top10: [],
        self: null,
        meta: {
          rowCount: 0,
          parseWarnings: ["failed to open statistics category page"]
        }
      };
      appendTop10LogLine(logFilePath, entry);
      results.push({
        category: category.id,
        categoryLabel: category.label,
        ok: false,
        warning: entry.meta.parseWarnings[0]
      });
      continue;
    }

    const scraped = await scrapeCategoryRankings(page, {
      selfNames,
      limit: 10
    });

    const entry = {
      v: LOG_SCHEMA_VERSION,
      ts,
      epochMs,
      gameHost,
      category: category.id,
      categoryLabel: category.label,
      sourceUrl,
      top10: scraped.top10,
      self: scraped.self,
      meta: {
        rowCount: scraped.top10.length,
        parseWarnings: scraped.warnings || []
      }
    };

    appendTop10LogLine(logFilePath, entry);
    results.push({
      category: category.id,
      categoryLabel: category.label,
      ok: scraped.top10.length > 0,
      rowCount: scraped.top10.length,
      selfRank: scraped.self ? scraped.self.rank : null,
      warnings: scraped.warnings || []
    });
  }

  return {
    logFilePath,
    ts,
    gameHost,
    selfNames,
    categories: results
  };
}

module.exports = {
  TRACKING_CATEGORIES,
  LOG_SCHEMA_VERSION,
  DEFAULT_TOP10_LOG_FILE,
  listCategories,
  resolveLogFilePath,
  appendTop10LogLine,
  runTop10TrackingSnapshot
};
