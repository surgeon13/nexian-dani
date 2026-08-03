const fs = require("fs");
const path = require("path");
const { safeGotoWithRetry } = require("./browserNavigation");

const LOG_SCHEMA_VERSION = 1;
const DEFAULT_TOP10_LOG_FILE = "top10.log";

/**
 * Nexian (T3.6 hybrid) uses classic `statistics.php` routes:
 * - Top 10 attackers/defenders/climbers/robbers share `?t=5` (table ids below)
 * - Population / alliances / villages use dedicated ranking pages
 */
const TRACKING_CATEGORIES = [
  {
    id: "attackers",
    label: "Attackers",
    tableSelector: "#top10_offs",
    tabPatterns: ["attacker", "attackers", "offensive", "off", "top 10"],
    urlPaths: ["/statistics.php?t=5", "/statistics.php?t=7&p=0"]
  },
  {
    id: "defenders",
    label: "Defenders",
    tableSelector: "#top10_defs",
    tabPatterns: ["defender", "defenders", "defensive", "def"],
    urlPaths: ["/statistics.php?t=5", "/statistics.php?t=6&p=0"]
  },
  {
    id: "robbers",
    label: "Robbers",
    tableSelector: "#top10_raiders",
    tabPatterns: ["robber", "robbers", "raider", "raiders", "raid"],
    urlPaths: ["/statistics.php?t=5"]
  },
  {
    id: "climbers",
    label: "Climbers",
    tableSelector: "#top10_climbers",
    tabPatterns: ["climber", "climbers", "climb"],
    urlPaths: ["/statistics.php?t=5"]
  },
  {
    id: "population",
    label: "Population",
    tableSelector: "#player",
    tabPatterns: ["population", "inhabitants", "pop", "players", "largest players"],
    urlPaths: ["/statistics.php?p=0", "/statistics.php"]
  },
  {
    id: "alliances",
    label: "Alliances",
    tableSelector: "#alliance",
    tabPatterns: ["alliance", "alliances", "largest alliances"],
    urlPaths: ["/statistics.php?t=1"]
  },
  {
    id: "villages",
    label: "Villages",
    tableSelector: "#villages",
    tabPatterns: ["village", "villages", "largest villages"],
    urlPaths: ["/statistics.php?t=2&p=0", "/statistics.php?t=2"]
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

  // Legacy/modern fallbacks
  add(`${origin}/statistics.php`);
  add(`${origin}/statistiken.php`);
  add(`${origin}/statistics`);
  return urls;
}

async function pageHasRankingTable(page, tableSelector) {
  return page
    .evaluate((selector) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const parseRank = (text) => {
        const match = normalize(text).match(/(\d+)/);
        return match ? Number(match[1]) : null;
      };

      const tables = [];
      if (selector) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (node && node.tagName === "TABLE") {
            tables.push(node);
          } else if (node) {
            const nested = node.closest("table") || node.querySelector("table");
            if (nested) {
              tables.push(nested);
            }
          }
        }
      }
      if (!tables.length) {
        tables.push(...Array.from(document.querySelectorAll("table")));
      }

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
    }, tableSelector || null)
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
        const title = normalize(el.getAttribute("title") || "");
        const imgAlt = normalize(el.querySelector("img")?.getAttribute("alt") || "");
        const id = normalize(el.id || "");
        const cls = normalize(el.className || "");
        const haystack = `${text} ${href} ${title} ${imgAlt} ${id} ${cls}`;
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

      // Only click subtabs when the target URL has no category query already.
      // Clicking after ?t=1 / ?t=2 can jump to unrelated pages (e.g. alliance.php).
      const shouldClickTab = (() => {
        try {
          const parsed = new URL(url);
          if (!/statistics(\.php)?$/i.test(parsed.pathname)) {
            return false;
          }
          return !parsed.searchParams.has("t") && !parsed.searchParams.has("id");
        } catch (_error) {
          return false;
        }
      })();

      if (shouldClickTab && !(await pageHasRankingTable(page, category.tableSelector))) {
        await clickCategoryTab(page, category);
      }
      if (await pageHasRankingTable(page, category.tableSelector)) {
        return url;
      }
      // Fallback: accept any ranking table on this page.
      if (await pageHasRankingTable(page, null)) {
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
        "#side_navi a[href*='spieler']",
        "#side_info .playerName",
        "#userName",
        "#playerName a",
        "#playerName",
        ".playerName",
        ".player-name",
        "#menuAccount .player",
        "#menuAccount a",
        "a[href*='profile.php']",
        "a[href*='spieler']"
      ];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const text = normalize(el && el.textContent);
        if (text && text.length >= 2 && text.length <= 64 && !/^(profile|logout|home)$/i.test(text)) {
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
  const tableSelector = options.tableSelector || null;

  return page.evaluate(
    ({ selfNamesLower, limitRows, preferredSelector }) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const parseRank = (text) => {
        const raw = normalize(text);
        if (!raw || raw === "?" || raw === "-") {
          return null;
        }
        const match = raw.match(/(\d+)/);
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
        if (/(\bown\b|\bme\b|\bmy\b|highlight|\bhl\b|selected|active-row)/.test(cls)) {
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
            'a[href*="profile"], a[href*="spieler"], a[href*="player"], a[href*="village"], a[href*="dorf"], a[href*="alliance"], a[href*="karte"]'
          );
          const text = normalize(link ? link.textContent : cells[i].textContent);
          if (text && !/^\d+[.]?$/.test(text) && text.length >= 1 && text !== "?") {
            return { name: text.replace(/\s*\([^)]*\)\s*$/, "").trim(), nameCellIndex: i };
          }
        }
        const fallback = normalize(cells[1]?.textContent || cells[0]?.textContent || "");
        return { name: fallback.replace(/\s*\([^)]*\)\s*$/, "").trim(), nameCellIndex: 1 };
      };

      const extractMetricCell = (cells, nameCellIndex, rank, preferredIndexes) => {
        const candidates = [];
        for (let i = 0; i < cells.length; i += 1) {
          if (i === nameCellIndex || i === 0) {
            continue;
          }
          // Skip alliance-like short labels without many digits.
          const raw = normalize(cells[i].textContent || "");
          if (raw && !/\d/.test(raw)) {
            continue;
          }
          const metric = parseMetricValue(raw);
          if (metric.value == null) {
            continue;
          }
          candidates.push({ index: i, ...metric });
        }
        if (!candidates.length) {
          return { value: null, valueText: "" };
        }
        if (Array.isArray(preferredIndexes) && preferredIndexes.length) {
          for (const idx of preferredIndexes) {
            const hit = candidates.find((c) => c.index === idx);
            if (hit) {
              return { value: hit.value, valueText: hit.valueText };
            }
          }
        }
        // Prefer the largest numeric value (population/points/resources beat village counts).
        candidates.sort((a, b) => b.value - a.value);
        return { value: candidates[0].value, valueText: candidates[0].valueText };
      };

      const collectTables = () => {
        const found = [];
        const seen = new Set();
        const push = (table, bonus = 0) => {
          if (!table || seen.has(table)) {
            return;
          }
          seen.add(table);
          found.push({ table, bonus });
        };

        if (preferredSelector) {
          for (const node of Array.from(document.querySelectorAll(preferredSelector))) {
            if (node.tagName === "TABLE") {
              push(node, 100);
            } else {
              push(node.closest("table") || node.querySelector("table"), 80);
            }
          }
        }

        for (const table of Array.from(document.querySelectorAll("table"))) {
          push(table, 0);
        }
        return found;
      };

      const resolvePreferredMetricIndexes = (table) => {
        const headerRow =
          table.querySelector("thead tr:last-child") ||
          Array.from(table.querySelectorAll("tr")).find((row) =>
            /population|points|resources|ranks|villages|players|alliance/i.test(row.textContent || "")
          );
        if (!headerRow) {
          return [];
        }
        const headers = Array.from(headerRow.querySelectorAll("td, th")).map((cell) =>
          normalize(cell.textContent).toLowerCase()
        );
        const preferredNames = ["points", "resources", "ranks", "population", "pop"];
        const indexes = [];
        for (const name of preferredNames) {
          const idx = headers.findIndex((h) => h === name || h.includes(name));
          if (idx >= 0) {
            indexes.push(idx);
          }
        }
        return indexes;
      };

      const tables = collectTables();
      const candidates = [];
      for (const { table, bonus } of tables) {
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
        if (rankHits >= 3 || bonus >= 80) {
          candidates.push({ table, score: rankHits + rows.length + bonus });
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      const warnings = [];
      if (!candidates.length) {
        return { top10: [], self: null, warnings: ["no ranking table found"] };
      }

      const table = candidates[0].table;
      const preferredIndexes = resolvePreferredMetricIndexes(table);
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).filter(
        (row) => row.querySelectorAll("td").length >= 2
      );

      const entries = [];
      let self = null;

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) {
          continue;
        }
        if (cells.length === 1 || (cells[0].colSpan && Number(cells[0].colSpan) >= 2)) {
          continue;
        }

        const rankText = normalize(cells[0]?.textContent || "");
        const rank = parseRank(rankText);
        const ownByClass = rowLooksOwn(row);
        const { name, nameCellIndex } = extractName(cells);
        if (!name) {
          continue;
        }

        // Skip header-ish rows without a usable rank unless it's the highlighted self row.
        if (rank == null && !ownByClass && rankText !== "?") {
          continue;
        }
        if (rank != null && rank > 500 && !ownByClass) {
          continue;
        }

        const metric = extractMetricCell(cells, nameCellIndex, rank, preferredIndexes);
        const alliance = extractAlliance(cells, nameCellIndex);
        const tribeCell = cells.find((cell) =>
          /(roman|teuton|gaul|egyptian|hun|spartan|natar)/i.test(cell.textContent || "")
        );
        const entry = {
          rank: rank,
          rankText: rankText || null,
          name,
          alliance,
          tribe: tribeCell ? normalize(tribeCell.textContent) : null,
          value: metric.value,
          valueText: metric.valueText || null
        };

        const ownByName = selfNamesLower.some(
          (needle) => needle && name.toLowerCase().includes(needle)
        );
        if (ownByClass || ownByName) {
          self = {
            ...entry,
            inTop10: rank != null && rank <= limitRows,
            matchedBy: ownByClass ? "row-class" : "name"
          };
        }

        if (rank != null && rank <= limitRows) {
          entries.push(entry);
        }
      }

      if (!self && selfNamesLower.length) {
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          const { name, nameCellIndex } = extractName(cells);
          if (!name) {
            continue;
          }
          if (!selfNamesLower.some((needle) => name.toLowerCase().includes(needle))) {
            continue;
          }
          const rankText = normalize(cells[0]?.textContent || "");
          const rank = parseRank(rankText);
          const metric = extractMetricCell(cells, nameCellIndex, rank, preferredIndexes);
          self = {
            rank,
            rankText: rankText || null,
            name,
            alliance: extractAlliance(cells, nameCellIndex),
            tribe: null,
            value: metric.value,
            valueText: metric.valueText || null,
            inTop10: rank != null && rank <= limitRows,
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
    { selfNamesLower: selfNames, limitRows: limit, preferredSelector: tableSelector }
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
  const openedByUrl = new Map();

  for (const category of TRACKING_CATEGORIES) {
    const preferredUrl = (() => {
      try {
        return `${origin}${category.urlPaths[0]}`;
      } catch (_error) {
        return null;
      }
    })();

    let sourceUrl = null;
    if (preferredUrl && openedByUrl.has(preferredUrl)) {
      sourceUrl = preferredUrl;
    } else {
      sourceUrl = await navigateToCategory(page, settings, category);
      if (sourceUrl) {
        openedByUrl.set(sourceUrl, true);
      }
    }

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

    // When reusing a shared Top 10 page, ensure we are still on it.
    if (preferredUrl && page.url() !== sourceUrl && !page.url().includes("t=5")) {
      try {
        await safeGotoWithRetry(page, sourceUrl);
        await page.waitForTimeout(300).catch(() => {});
      } catch (_error) {
        /* scrape may still succeed from current page */
      }
    }

    const scraped = await scrapeCategoryRankings(page, {
      selfNames,
      limit: 10,
      tableSelector: category.tableSelector
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
