const path = require("path");
const { tailLogFile } = require("./logTail");

const CATEGORY_ORDER = [
  "attackers",
  "defenders",
  "climbers",
  "robbers",
  "population",
  "alliances",
  "villages"
];

const CATEGORY_META = {
  attackers: { label: "Attackers", metric: "Points", accent: "off" },
  defenders: { label: "Defenders", metric: "Points", accent: "def" },
  climbers: { label: "Climbers", metric: "Ranks", accent: "climb" },
  robbers: { label: "Robbers", metric: "Resources", accent: "raid" },
  population: { label: "Population", metric: "Population", accent: "pop" },
  alliances: { label: "Alliances", metric: "Points", accent: "ally" },
  villages: { label: "Villages", metric: "Population", accent: "vill" }
};

function resolveTop10LogPath(bridge, fallbackPath) {
  if (fallbackPath) {
    return path.isAbsolute(fallbackPath)
      ? fallbackPath
      : path.resolve(process.cwd(), fallbackPath);
  }
  const snap = bridge && typeof bridge.getSnapshot === "function" ? bridge.getSnapshot() : null;
  const configured =
    (snap && snap.top10Tracking && snap.top10Tracking.logFile) ||
    (snap && snap.loops && snap.loops.top10 && snap.loops.top10.logFile) ||
    "top10.log";
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
}

function isTop10Entry(entry) {
  return Boolean(entry && entry.category && (entry.ts || entry.epochMs) && !entry.raw);
}

function formatCompactNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  }
  if (abs >= 10_000) {
    return `${Math.round(n / 1000)}K`;
  }
  return n.toLocaleString("en-US");
}

function summarizeRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    rank: row.rank == null ? null : Number(row.rank),
    rankText: row.rankText || (row.rank != null ? String(row.rank) : "?"),
    name: String(row.name || "").trim() || "—",
    alliance: row.alliance || null,
    tribe: row.tribe || null,
    value: row.value == null || !Number.isFinite(Number(row.value)) ? null : Number(row.value),
    valueText: row.valueText || formatCompactNumber(row.value) || "—",
    inTop10: Boolean(row.inTop10),
    matchedBy: row.matchedBy || null
  };
}

function buildHistoryPoint(entry) {
  const self = summarizeRow(entry.self);
  const leader = Array.isArray(entry.top10) && entry.top10[0] ? summarizeRow(entry.top10[0]) : null;
  return {
    ts: entry.ts || null,
    epochMs: Number(entry.epochMs) || (entry.ts ? Date.parse(entry.ts) : null),
    ok: Array.isArray(entry.top10) && entry.top10.length > 0,
    selfRank: self && self.rank != null ? self.rank : null,
    selfValue: self && self.value != null ? self.value : null,
    selfValueText: self ? self.valueText : null,
    leaderName: leader ? leader.name : null,
    leaderValue: leader && leader.value != null ? leader.value : null
  };
}

function computeDelta(history, key) {
  const points = (history || []).filter((p) => p[key] != null);
  if (points.length < 2) {
    return null;
  }
  const newest = points[points.length - 1][key];
  const previous = points[points.length - 2][key];
  if (!Number.isFinite(newest) || !Number.isFinite(previous)) {
    return null;
  }
  return newest - previous;
}

function hoursBetween(fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  const hours = (to - from) / 3_600_000;
  return hours > 0 ? hours : null;
}

function roundRate(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return Math.round(n);
  }
  if (abs >= 100) {
    return Math.round(n * 10) / 10;
  }
  if (abs >= 10) {
    return Math.round(n * 100) / 100;
  }
  return Math.round(n * 1000) / 1000;
}

function computeTimedRate(history, key) {
  const points = (history || []).filter(
    (point) => point[key] != null && Number.isFinite(Number(point[key])) && point.epochMs != null
  );
  if (points.length < 2) {
    return null;
  }
  const previous = points[points.length - 2];
  const newest = points[points.length - 1];
  const hours = hoursBetween(previous.epochMs, newest.epochMs);
  if (hours == null) {
    return null;
  }
  const delta = Number(newest[key]) - Number(previous[key]);
  return {
    delta,
    hours: Math.round(hours * 1000) / 1000,
    perHour: roundRate(delta / hours),
    fromTs: previous.ts || null,
    toTs: newest.ts || null,
    samples: 2
  };
}

function computeWindowRate(history, key) {
  const points = (history || []).filter(
    (point) => point[key] != null && Number.isFinite(Number(point[key])) && point.epochMs != null
  );
  if (points.length < 2) {
    return null;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const hours = hoursBetween(first.epochMs, last.epochMs);
  if (hours == null) {
    return null;
  }
  const delta = Number(last[key]) - Number(first[key]);
  return {
    delta,
    hours: Math.round(hours * 1000) / 1000,
    perHour: roundRate(delta / hours),
    fromTs: first.ts || null,
    toTs: last.ts || null,
    samples: points.length
  };
}

function indexRowsByName(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = String((row && row.name) || "")
      .trim()
      .toLowerCase();
    if (!name || name === "—") {
      continue;
    }
    map.set(name, row);
  }
  return map;
}

function enrichTop10WithRates(latestRows, previousRows, hours) {
  const previousByName = indexRowsByName(previousRows);
  return (latestRows || []).map((row) => {
    const key = String(row.name || "")
      .trim()
      .toLowerCase();
    const previous = key ? previousByName.get(key) : null;
    const valueDelta =
      previous &&
      previous.value != null &&
      row.value != null &&
      Number.isFinite(Number(previous.value)) &&
      Number.isFinite(Number(row.value))
        ? Number(row.value) - Number(previous.value)
        : null;
    const rankDelta =
      previous &&
      previous.rank != null &&
      row.rank != null &&
      Number.isFinite(Number(previous.rank)) &&
      Number.isFinite(Number(row.rank))
        ? Number(row.rank) - Number(previous.rank)
        : null;
    const perHour =
      valueDelta != null && hours != null && hours > 0 ? roundRate(valueDelta / hours) : null;
    return {
      ...row,
      valueDelta,
      valueDeltaText: valueDelta == null ? null : formatCompactNumber(valueDelta),
      valuePerHour: perHour,
      valuePerHourText: perHour == null ? null : formatCompactNumber(perHour),
      rankDelta,
      previousRank: previous && previous.rank != null ? Number(previous.rank) : null,
      previousValue: previous && previous.value != null ? Number(previous.value) : null
    };
  });
}

function buildTop10DashboardPayload(bridge, options = {}) {
  const logFilePath = resolveTop10LogPath(bridge, options.logFilePath);
  const limit = Math.max(50, Math.min(Number(options.limit) || 700, 2000));
  const entries = tailLogFile(logFilePath, limit).filter(isTop10Entry);

  const byCategory = {};
  for (const id of CATEGORY_ORDER) {
    byCategory[id] = [];
  }

  for (const entry of entries) {
    const id = String(entry.category);
    if (!byCategory[id]) {
      byCategory[id] = [];
    }
    byCategory[id].push(entry);
  }

  const categories = CATEGORY_ORDER.map((id) => {
    const list = byCategory[id] || [];
    const latest = list.length ? list[list.length - 1] : null;
    const previous = list.length > 1 ? list[list.length - 2] : null;
    const history = list.map(buildHistoryPoint);
    const recentHistory = history.slice(-48);
    const self = latest ? summarizeRow(latest.self) : null;
    const previousTop10 =
      previous && Array.isArray(previous.top10)
        ? previous.top10.map(summarizeRow).filter(Boolean)
        : [];
    const latestTop10 =
      latest && Array.isArray(latest.top10) ? latest.top10.map(summarizeRow).filter(Boolean) : [];
    const pollHours = hoursBetween(
      previous && previous.epochMs,
      latest && latest.epochMs
    );
    const top10 = enrichTop10WithRates(latestTop10, previousTop10, pollHours);
    const meta = CATEGORY_META[id] || { label: id, metric: "Value", accent: "pop" };
    const rankDelta = computeDelta(recentHistory, "selfRank");
    const valueDelta = computeDelta(recentHistory, "selfValue");
    const lastPollValueRate = computeTimedRate(recentHistory, "selfValue");
    const lastPollRankRate = computeTimedRate(recentHistory, "selfRank");
    const windowValueRate = computeWindowRate(recentHistory, "selfValue");
    const windowRankRate = computeWindowRate(recentHistory, "selfRank");

    return {
      id,
      label: (latest && latest.categoryLabel) || meta.label,
      metric: meta.metric,
      accent: meta.accent,
      updatedAt: latest ? latest.ts : null,
      epochMs: latest ? latest.epochMs : null,
      ok: top10.length > 0,
      top10,
      self,
      history: recentHistory,
      sparkline: recentHistory
        .map((point) => point.selfValue)
        .filter((value) => value != null),
      rankSparkline: recentHistory
        .map((point) => point.selfRank)
        .filter((value) => value != null),
      pollIntervalHours: pollHours == null ? null : Math.round(pollHours * 1000) / 1000,
      deltas: {
        rank: rankDelta,
        // For ranks, lower is better — flip the "improved" flag.
        rankImproved: rankDelta == null ? null : rankDelta < 0,
        value: valueDelta,
        valueImproved: valueDelta == null ? null : valueDelta > 0,
        valuePerHour: lastPollValueRate ? lastPollValueRate.perHour : null,
        valuePerHourImproved:
          lastPollValueRate && lastPollValueRate.perHour != null
            ? lastPollValueRate.perHour > 0
            : null,
        rankPerHour: lastPollRankRate ? lastPollRankRate.perHour : null,
        rankPerHourImproved:
          lastPollRankRate && lastPollRankRate.perHour != null
            ? lastPollRankRate.perHour < 0
            : null,
        lastPoll: {
          value: lastPollValueRate,
          rank: lastPollRankRate
        },
        window: {
          value: windowValueRate,
          rank: windowRankRate
        }
      },
      warnings:
        latest && latest.meta && Array.isArray(latest.meta.parseWarnings)
          ? latest.meta.parseWarnings.filter(Boolean)
          : []
    };
  });

  const snapshotTimes = [
    ...new Set(entries.map((entry) => entry.ts).filter(Boolean))
  ].sort();
  const latestTs = snapshotTimes.length ? snapshotTimes[snapshotTimes.length - 1] : null;
  const standings = categories
    .filter((cat) => cat.self)
    .map((cat) => ({
      category: cat.id,
      label: cat.label,
      metric: cat.metric,
      accent: cat.accent,
      rank: cat.self.rank,
      rankText: cat.self.rankText,
      value: cat.self.value,
      valueText: cat.self.valueText,
      inTop10: cat.self.inTop10 || (cat.self.rank != null && cat.self.rank <= 10),
      rankDelta: cat.deltas.rank,
      rankImproved: cat.deltas.rankImproved,
      valueDelta: cat.deltas.value,
      valueImproved: cat.deltas.valueImproved,
      valuePerHour: cat.deltas.valuePerHour,
      valuePerHourImproved: cat.deltas.valuePerHourImproved,
      windowValuePerHour:
        cat.deltas.window && cat.deltas.window.value
          ? cat.deltas.window.value.perHour
          : null,
      windowValueImproved:
        cat.deltas.window &&
        cat.deltas.window.value &&
        cat.deltas.window.value.perHour != null
          ? cat.deltas.window.value.perHour > 0
          : null,
      pollIntervalHours: cat.pollIntervalHours,
      sparkline: cat.sparkline
    }));

  const snap = bridge && typeof bridge.getSnapshot === "function" ? bridge.getSnapshot() : null;
  const tracking = (snap && snap.top10Tracking) || {};
  const loop = (snap && snap.loops && snap.loops.top10) || {};

  return {
    ok: true,
    logFile: path.basename(logFilePath),
    logFilePath,
    entryCount: entries.length,
    snapshotCount: snapshotTimes.length,
    latestTs,
    tracking: {
      enabled: Boolean(tracking.enabled ?? loop.enabled),
      minMinutes: tracking.minMinutes ?? loop.minMinutes ?? null,
      maxMinutes: tracking.maxMinutes ?? loop.maxMinutes ?? null,
      nextInMinutes: tracking.nextInMinutes ?? loop.nextInMinutes ?? null,
      completedCount: tracking.completedCount ?? loop.completedCount ?? 0,
      playerName: tracking.playerName || null,
      lastActionAt: tracking.lastAction && tracking.lastAction.at ? tracking.lastAction.at : latestTs
    },
    standings,
    categories,
    categoryOrder: CATEGORY_ORDER
  };
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_META,
  resolveTop10LogPath,
  buildTop10DashboardPayload,
  formatCompactNumber,
  hoursBetween,
  computeTimedRate,
  computeWindowRate,
  enrichTop10WithRates
};
