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

function validHistoryPoints(history, key) {
  return (history || []).filter(
    (point) =>
      point &&
      point[key] != null &&
      Number.isFinite(Number(point[key])) &&
      point.epochMs != null &&
      Number.isFinite(Number(point.epochMs))
  );
}

function computePollSeries(history, key) {
  const points = validHistoryPoints(history, key);
  const series = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const newest = points[i];
    const hours = hoursBetween(previous.epochMs, newest.epochMs);
    if (hours == null) {
      continue;
    }
    const delta = Number(newest[key]) - Number(previous[key]);
    series.push({
      index: i,
      delta,
      hours: Math.round(hours * 1000) / 1000,
      perHour: roundRate(delta / hours),
      fromTs: previous.ts || null,
      toTs: newest.ts || null,
      fromValue: Number(previous[key]),
      toValue: Number(newest[key])
    });
  }
  return series;
}

function summarizePollSeries(series) {
  if (!series || !series.length) {
    return null;
  }
  const totalDelta = series.reduce((sum, item) => sum + Number(item.delta || 0), 0);
  const totalHours = series.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const last = series[series.length - 1];
  return {
    samples: series.length + 1,
    intervals: series.length,
    totalDelta,
    totalHours: Math.round(totalHours * 1000) / 1000,
    perHour: totalHours > 0 ? roundRate(totalDelta / totalHours) : null,
    lastPoll: last,
    series
  };
}

function computeTimedRate(history, key) {
  const series = computePollSeries(history, key);
  if (!series.length) {
    return null;
  }
  const last = series[series.length - 1];
  return {
    delta: last.delta,
    hours: last.hours,
    perHour: last.perHour,
    fromTs: last.fromTs,
    toTs: last.toTs,
    samples: 2
  };
}

function computeWindowRate(history, key) {
  const summary = summarizePollSeries(computePollSeries(history, key));
  if (!summary) {
    return null;
  }
  const points = validHistoryPoints(history, key);
  const first = points[0];
  const last = points[points.length - 1];
  // Prefer first→latest over the raw span so sparse gaps still normalize correctly.
  const hours = hoursBetween(first.epochMs, last.epochMs);
  const delta = Number(last[key]) - Number(first[key]);
  return {
    delta,
    hours: hours == null ? summary.totalHours : Math.round(hours * 1000) / 1000,
    perHour:
      hours == null || hours <= 0 ? summary.perHour : roundRate(delta / hours),
    fromTs: first.ts || null,
    toTs: last.ts || null,
    samples: points.length,
    intervals: summary.intervals
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

function collectNamedPollHistory(entryList) {
  const byName = new Map();
  for (const entry of entryList || []) {
    const epochMs =
      Number(entry.epochMs) || (entry.ts ? Date.parse(entry.ts) : null);
    const rows = Array.isArray(entry.top10) ? entry.top10.map(summarizeRow).filter(Boolean) : [];
    const self = summarizeRow(entry.self);
    if (self && self.name) {
      // Keep self in the timeline even when outside the printed top 10.
      const selfKey = self.name.trim().toLowerCase();
      if (selfKey && selfKey !== "—") {
        const exists = rows.some(
          (row) => String(row.name || "").trim().toLowerCase() === selfKey
        );
        if (!exists) {
          rows.push(self);
        }
      }
    }
    for (const row of rows) {
      const key = String(row.name || "")
        .trim()
        .toLowerCase();
      if (!key || key === "—") {
        continue;
      }
      if (!byName.has(key)) {
        byName.set(key, []);
      }
      byName.get(key).push({
        ts: entry.ts || null,
        epochMs,
        rank: row.rank,
        value: row.value,
        name: row.name,
        alliance: row.alliance,
        tribe: row.tribe
      });
    }
  }
  return byName;
}

function ratesFromNamedHistory(points) {
  if (!points || points.length < 2) {
    return {
      valueDelta: null,
      valuePerHour: null,
      windowDelta: null,
      windowPerHour: null,
      rankDelta: null,
      windowRankDelta: null,
      pollSeries: [],
      previousRank: null,
      previousValue: null,
      firstRank: null,
      firstValue: null,
      samples: points ? points.length : 0
    };
  }
  const history = points.map((point) => ({
    ts: point.ts,
    epochMs: point.epochMs,
    selfValue: point.value,
    selfRank: point.rank
  }));
  const valueSeries = computePollSeries(history, "selfValue");
  const rankSeries = computePollSeries(history, "selfRank");
  const windowValue = computeWindowRate(history, "selfValue");
  const windowRank = computeWindowRate(history, "selfRank");
  const lastValue = valueSeries.length ? valueSeries[valueSeries.length - 1] : null;
  const lastRank = rankSeries.length ? rankSeries[rankSeries.length - 1] : null;
  const first = points[0];
  const previous = points[points.length - 2];
  return {
    valueDelta: lastValue ? lastValue.delta : null,
    valuePerHour: lastValue ? lastValue.perHour : null,
    windowDelta: windowValue ? windowValue.delta : null,
    windowPerHour: windowValue ? windowValue.perHour : null,
    rankDelta: lastRank ? lastRank.delta : null,
    windowRankDelta: windowRank ? windowRank.delta : null,
    pollSeries: valueSeries,
    previousRank: previous && previous.rank != null ? Number(previous.rank) : null,
    previousValue: previous && previous.value != null ? Number(previous.value) : null,
    firstRank: first && first.rank != null ? Number(first.rank) : null,
    firstValue: first && first.value != null ? Number(first.value) : null,
    samples: points.length,
    windowHours: windowValue ? windowValue.hours : null
  };
}

function enrichTop10FromPollLogs(entryList) {
  const latest = entryList && entryList.length ? entryList[entryList.length - 1] : null;
  const latestRows =
    latest && Array.isArray(latest.top10) ? latest.top10.map(summarizeRow).filter(Boolean) : [];
  const byName = collectNamedPollHistory(entryList);
  return latestRows.map((row) => {
    const key = String(row.name || "")
      .trim()
      .toLowerCase();
    const rates = ratesFromNamedHistory(key ? byName.get(key) || [] : []);
    return {
      ...row,
      valueDelta: rates.windowDelta,
      valueDeltaText: rates.windowDelta == null ? null : formatCompactNumber(rates.windowDelta),
      valuePerHour: rates.windowPerHour,
      valuePerHourText: rates.windowPerHour == null ? null : formatCompactNumber(rates.windowPerHour),
      lastValueDelta: rates.valueDelta,
      lastValuePerHour: rates.valuePerHour,
      rankDelta: rates.windowRankDelta != null ? rates.windowRankDelta : rates.rankDelta,
      lastRankDelta: rates.rankDelta,
      previousRank: rates.previousRank,
      previousValue: rates.previousValue,
      firstRank: rates.firstRank,
      firstValue: rates.firstValue,
      pollSamples: rates.samples,
      windowHours: rates.windowHours,
      pollSeries: rates.pollSeries
    };
  });
}

/** @deprecated Prefer enrichTop10FromPollLogs — kept for tests/callers. */
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

const SELF_PACE_META = {
  attackers: {
    shortLabel: "Attack points",
    heroLabel: "Your attack points",
    unit: "points",
    primary: "value"
  },
  defenders: {
    shortLabel: "Defense points",
    heroLabel: "Your defense points",
    unit: "points",
    primary: "value"
  },
  climbers: {
    shortLabel: "Climbers",
    heroLabel: "Your climber score",
    unit: "ranks",
    primary: "value"
  },
  robbers: {
    shortLabel: "Raid income",
    heroLabel: "Your raid income",
    unit: "resources",
    primary: "value"
  },
  population: {
    shortLabel: "Population",
    heroLabel: "Your population",
    unit: "pop",
    primary: "value"
  },
  alliances: {
    shortLabel: "Alliance points",
    heroLabel: "Your alliance points",
    unit: "points",
    primary: "value"
  },
  villages: {
    shortLabel: "Village pop",
    heroLabel: "Your village population",
    unit: "pop",
    primary: "value"
  }
};

function resolveMaxActiveGapHours(options = {}) {
  const pollMin = Number(options.pollMinMinutes);
  const pollMax = Number(options.pollMaxMinutes);
  const configuredPollMinutes =
    Number.isFinite(pollMax) && pollMax > 0
      ? pollMax
      : Number.isFinite(pollMin) && pollMin > 0
        ? pollMin
        : 10;
  return Math.max(1.5, (configuredPollMinutes * 3) / 60);
}

function splitActivePollSeries(pollSeries, maxActiveGapHours) {
  const activeIntervals = [];
  const downtimeIntervals = [];
  for (const interval of pollSeries || []) {
    if (interval && Number(interval.hours) > 0 && Number(interval.hours) <= maxActiveGapHours) {
      activeIntervals.push(interval);
    } else if (interval) {
      downtimeIntervals.push(interval);
    }
  }
  const activeDelta = activeIntervals.reduce((sum, item) => sum + Number(item.delta || 0), 0);
  const activeHoursRaw = activeIntervals.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const downtimeHoursRaw = downtimeIntervals.reduce(
    (sum, item) => sum + Number(item.hours || 0),
    0
  );
  return {
    activeIntervals,
    downtimeIntervals,
    activeDelta,
    activeHours: activeHoursRaw > 0 ? Math.round(activeHoursRaw * 1000) / 1000 : null,
    downtimeHours: downtimeHoursRaw > 0 ? Math.round(downtimeHoursRaw * 1000) / 1000 : null,
    activePerHour: activeHoursRaw > 0 ? roundRate(activeDelta / activeHoursRaw) : null
  };
}

function buildSelfPaceSummary(category, options = {}) {
  if (!category || !category.self) {
    return null;
  }
  const paceMeta = SELF_PACE_META[category.id] || {
    shortLabel: category.label || category.id,
    heroLabel: category.label || category.id,
    unit: (category.metric || "value").toLowerCase(),
    primary: "value"
  };
  const deltas = category.deltas || {};
  const valueWindow = deltas.window && deltas.window.value ? deltas.window.value : null;
  const rankWindow = deltas.window && deltas.window.rank ? deltas.window.rank : null;
  const valueLast = deltas.lastPoll && deltas.lastPoll.value ? deltas.lastPoll.value : null;
  const rankLast = deltas.lastPoll && deltas.lastPoll.rank ? deltas.lastPoll.rank : null;
  const valueSeries = (deltas.polls && deltas.polls.value) || [];
  const rankSeries = (deltas.polls && deltas.polls.rank) || [];
  const maxActiveGapHours = resolveMaxActiveGapHours(options);
  const valueActive = splitActivePollSeries(valueSeries, maxActiveGapHours);
  const rankActive = splitActivePollSeries(rankSeries, maxActiveGapHours);
  const hasValue = category.self.value != null;
  const hasRank = category.self.rank != null;

  return {
    category: category.id,
    label: paceMeta.shortLabel,
    heroLabel: paceMeta.heroLabel,
    metric: category.metric,
    unit: paceMeta.unit,
    accent: category.accent,
    playerName: category.self.name || options.playerName || null,
    total: hasValue ? Number(category.self.value) : null,
    totalText: hasValue ? category.self.valueText : null,
    rank: hasRank ? Number(category.self.rank) : null,
    rankText: category.self.rankText || null,
    gained: valueWindow ? valueWindow.delta : null,
    gainedText:
      valueWindow && valueWindow.delta != null ? formatCompactNumber(valueWindow.delta) : null,
    wallHours: valueWindow
      ? valueWindow.hours
      : rankWindow
        ? rankWindow.hours
        : null,
    wallPerHour: valueWindow ? valueWindow.perHour : null,
    wallPerHourText:
      valueWindow && valueWindow.perHour != null
        ? formatCompactNumber(valueWindow.perHour)
        : null,
    activeHours: valueActive.activeHours,
    activeGained: valueActive.activeIntervals.length ? valueActive.activeDelta : null,
    activePerHour: valueActive.activePerHour,
    activePerHourText:
      valueActive.activePerHour == null ? null : formatCompactNumber(valueActive.activePerHour),
    downtimeHours: valueActive.downtimeHours,
    downtimeIntervals: valueActive.downtimeIntervals.length,
    activeIntervals: valueActive.activeIntervals.length,
    rankGained: rankWindow ? rankWindow.delta : null,
    rankWallPerHour: rankWindow ? rankWindow.perHour : null,
    rankActivePerHour: rankActive.activePerHour,
    // For ranks, lower is better.
    rankImproved:
      rankWindow && rankWindow.delta != null ? rankWindow.delta < 0 : null,
    lastInterval: valueLast
      ? {
          delta: valueLast.delta,
          hours: valueLast.hours,
          perHour: valueLast.perHour,
          fromTs: valueLast.fromTs,
          toTs: valueLast.toTs
        }
      : rankLast
        ? {
            delta: rankLast.delta,
            hours: rankLast.hours,
            perHour: rankLast.perHour,
            fromTs: rankLast.fromTs,
            toTs: rankLast.toTs,
            kind: "rank"
          }
        : null,
    pollCount: category.pollCount || 0,
    maxActiveGapHours: Math.round(maxActiveGapHours * 1000) / 1000,
    sparkline: category.sparkline || [],
    rankSparkline: category.rankSparkline || [],
    pollSeries: valueSeries.length ? valueSeries : rankSeries,
    available: hasValue || hasRank
  };
}

function buildRaidIncomeSummary(robbersCategory, options = {}) {
  const pace = buildSelfPaceSummary(robbersCategory, options);
  if (!pace) {
    return {
      category: "robbers",
      label: "Raid income",
      metric: "Resources",
      playerName: options.playerName || null,
      totalResources: null,
      settings: buildSelfPaceSettings(options)
    };
  }
  const farmlist = options.farmlist || {};
  return {
    ...pace,
    label: "Raid income",
    // Back-compat aliases used by the existing dashboard hero.
    totalResources: pace.total,
    totalResourcesText: pace.totalText,
    settings: buildSelfPaceSettings(options)
  };
}

function buildSelfPaceSettings(options = {}) {
  const pollMin = Number(options.pollMinMinutes);
  const pollMax = Number(options.pollMaxMinutes);
  const farmlist = options.farmlist || {};
  return {
    top10Enabled: Boolean(options.top10Enabled),
    top10IntervalMinutes:
      Number.isFinite(pollMin) || Number.isFinite(pollMax)
        ? {
            min: Number.isFinite(pollMin) ? pollMin : null,
            max: Number.isFinite(pollMax) ? pollMax : null
          }
        : null,
    farmlistEnabled: Boolean(farmlist.enabled),
    farmlistIntervalMinutes:
      farmlist.minMinutes != null || farmlist.maxMinutes != null
        ? {
            min: farmlist.minMinutes ?? null,
            max: farmlist.maxMinutes ?? null
          }
        : null
  };
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
    // Use every polled log entry for this category — not just the last pair.
    const history = list.map(buildHistoryPoint);
    const self = latest ? summarizeRow(latest.self) : null;
    const top10 = enrichTop10FromPollLogs(list);
    const meta = CATEGORY_META[id] || { label: id, metric: "Value", accent: "pop" };
    const valuePollSeries = computePollSeries(history, "selfValue");
    const rankPollSeries = computePollSeries(history, "selfRank");
    const lastPollValueRate = computeTimedRate(history, "selfValue");
    const lastPollRankRate = computeTimedRate(history, "selfRank");
    const windowValueRate = computeWindowRate(history, "selfValue");
    const windowRankRate = computeWindowRate(history, "selfRank");
    const valueDelta =
      windowValueRate && windowValueRate.delta != null
        ? windowValueRate.delta
        : computeDelta(history, "selfValue");
    const rankDelta =
      windowRankRate && windowRankRate.delta != null
        ? windowRankRate.delta
        : computeDelta(history, "selfRank");
    const pollHours = hoursBetween(
      previous && previous.epochMs,
      latest && latest.epochMs
    );
    const windowHours = windowValueRate
      ? windowValueRate.hours
      : windowRankRate
        ? windowRankRate.hours
        : null;

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
      history,
      sparkline: history
        .map((point) => point.selfValue)
        .filter((value) => value != null),
      rankSparkline: history
        .map((point) => point.selfRank)
        .filter((value) => value != null),
      pollIntervalHours: pollHours == null ? null : Math.round(pollHours * 1000) / 1000,
      windowHours: windowHours == null ? null : Math.round(Number(windowHours) * 1000) / 1000,
      pollCount: history.length,
      deltas: {
        // Primary deltas are first→latest across all polled logs.
        rank: rankDelta,
        rankImproved: rankDelta == null ? null : rankDelta < 0,
        value: valueDelta,
        valueImproved: valueDelta == null ? null : valueDelta > 0,
        valuePerHour: windowValueRate ? windowValueRate.perHour : null,
        valuePerHourImproved:
          windowValueRate && windowValueRate.perHour != null
            ? windowValueRate.perHour > 0
            : null,
        rankPerHour: windowRankRate ? windowRankRate.perHour : null,
        rankPerHourImproved:
          windowRankRate && windowRankRate.perHour != null
            ? windowRankRate.perHour < 0
            : null,
        lastPoll: {
          value: lastPollValueRate,
          rank: lastPollRankRate
        },
        window: {
          value: windowValueRate,
          rank: windowRankRate
        },
        polls: {
          value: valuePollSeries,
          rank: rankPollSeries
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
      lastValueDelta:
        cat.deltas.lastPoll && cat.deltas.lastPoll.value
          ? cat.deltas.lastPoll.value.delta
          : null,
      lastValuePerHour:
        cat.deltas.lastPoll && cat.deltas.lastPoll.value
          ? cat.deltas.lastPoll.value.perHour
          : null,
      lastValueImproved:
        cat.deltas.lastPoll &&
        cat.deltas.lastPoll.value &&
        cat.deltas.lastPoll.value.delta != null
          ? cat.deltas.lastPoll.value.delta > 0
          : null,
      windowValuePerHour: cat.deltas.valuePerHour,
      windowValueImproved: cat.deltas.valuePerHourImproved,
      pollIntervalHours: cat.pollIntervalHours,
      windowHours: cat.windowHours,
      pollCount: cat.pollCount,
      pollSeries: (cat.deltas.polls && cat.deltas.polls.value) || [],
      sparkline: cat.sparkline
    }));

  const snap = bridge && typeof bridge.getSnapshot === "function" ? bridge.getSnapshot() : null;
  const tracking = (snap && snap.top10Tracking) || {};
  const loop = (snap && snap.loops && snap.loops.top10) || {};
  const farmlistLoop = (snap && snap.loops && snap.loops.farmlist) || {};
  const paceOptions = {
    playerName: tracking.playerName || null,
    top10Enabled: Boolean(tracking.enabled ?? loop.enabled),
    pollMinMinutes: tracking.minMinutes ?? loop.minMinutes ?? null,
    pollMaxMinutes: tracking.maxMinutes ?? loop.maxMinutes ?? null,
    farmlist: {
      enabled: farmlistLoop.enabled,
      minMinutes: farmlistLoop.minMinutes,
      maxMinutes: farmlistLoop.maxMinutes
    }
  };
  const robbersCategory = categories.find((cat) => cat.id === "robbers") || null;
  const raidIncome = buildRaidIncomeSummary(robbersCategory, paceOptions);
  const selfPace = CATEGORY_ORDER.map((id) => {
    const cat = categories.find((item) => item.id === id);
    return buildSelfPaceSummary(cat, paceOptions);
  }).filter(Boolean);

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
    raidIncome,
    selfPace,
    standings,
    categories,
    categoryOrder: CATEGORY_ORDER
  };
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_META,
  SELF_PACE_META,
  resolveTop10LogPath,
  buildTop10DashboardPayload,
  buildRaidIncomeSummary,
  buildSelfPaceSummary,
  formatCompactNumber,
  hoursBetween,
  computeTimedRate,
  computeWindowRate,
  computePollSeries,
  enrichTop10WithRates,
  enrichTop10FromPollLogs
};
