const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_SCHEMA_VERSION = 1;
const DEFAULT_SESSION_PRESENCE_FILE = "session-presence.json";
const DEFAULT_MAX_PERIODS = 500;

function resolveLogFilePath(settings = null) {
  const configured = String(
    (settings && settings.sessionPresenceLogFile) ||
      process.env.SESSION_PRESENCE_LOG_FILE ||
      DEFAULT_SESSION_PRESENCE_FILE
  ).trim();
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function resolveMaxPeriods() {
  const n = Number(process.env.SESSION_PRESENCE_MAX_PERIODS);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_MAX_PERIODS;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function emptyStore() {
  return { version: LOG_SCHEMA_VERSION, periods: [] };
}

function loadStore(logFilePath) {
  const filePath = logFilePath || resolveLogFilePath();
  if (!fs.existsSync(filePath)) {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const periods = Array.isArray(parsed && parsed.periods) ? parsed.periods : [];
    return {
      version: Number(parsed && parsed.version) || LOG_SCHEMA_VERSION,
      periods
    };
  } catch (_error) {
    return emptyStore();
  }
}

function saveStore(store, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath();
  const max = resolveMaxPeriods();
  const periods = Array.isArray(store.periods) ? store.periods.slice(-max) : [];
  const safe = {
    version: LOG_SCHEMA_VERSION,
    periods
  };
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return safe;
}

function newPeriodId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeIp(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  // Basic IPv4 / IPv6-ish sanity (avoid storing HTML error pages).
  if (value.length > 64 || /[\s<>]/.test(value)) {
    return null;
  }
  return value;
}

function durationMs(period, nowMs = Date.now()) {
  if (!period || !period.startedAt) {
    return null;
  }
  const start = Date.parse(period.startedAt);
  if (!Number.isFinite(start)) {
    return null;
  }
  const end = period.endedAt ? Date.parse(period.endedAt) : nowMs;
  if (!Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function enrichPeriod(period, nowMs = Date.now()) {
  const ms = durationMs(period, nowMs);
  return {
    ...period,
    active: !period.endedAt,
    durationMs: ms,
    durationLabel: ms == null ? null : formatDuration(ms)
  };
}

function getActivePeriod(store) {
  const periods = (store && store.periods) || [];
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    if (periods[i] && !periods[i].endedAt) {
      return periods[i];
    }
  }
  return null;
}

function closeOpenPeriods(logFilePath, endReason = "interrupted") {
  const filePath = logFilePath || resolveLogFilePath();
  const store = loadStore(filePath);
  const endedAt = new Date().toISOString();
  let changed = 0;
  for (const period of store.periods) {
    if (period && !period.endedAt) {
      period.endedAt = endedAt;
      period.endReason = String(endReason || "interrupted");
      changed += 1;
    }
  }
  if (changed) {
    saveStore(store, filePath);
  }
  return { closed: changed, store };
}

function startPeriod(details = {}, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath();
  closeOpenPeriods(filePath, details.supersedeReason || "superseded");

  const store = loadStore(filePath);
  const period = {
    id: newPeriodId(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    startReason: String(details.startReason || details.reason || "login"),
    endReason: null,
    publicIp: normalizeIp(details.publicIp),
    proxyServer: String(details.proxyServer || "").trim() || null,
    proxyDisplay: String(details.proxyDisplay || "direct (none)").trim() || "direct (none)"
  };
  store.periods.push(period);
  saveStore(store, filePath);
  return enrichPeriod(period);
}

function endActivePeriod(details = {}, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath();
  const store = loadStore(filePath);
  const active = getActivePeriod(store);
  if (!active) {
    return null;
  }
  active.endedAt = new Date().toISOString();
  active.endReason = String(details.endReason || details.reason || "stopped");
  if (details.publicIp && !active.publicIp) {
    active.publicIp = normalizeIp(details.publicIp);
  }
  if (details.proxyServer) {
    active.proxyServer = String(details.proxyServer).trim() || active.proxyServer;
  }
  if (details.proxyDisplay) {
    active.proxyDisplay = String(details.proxyDisplay).trim() || active.proxyDisplay;
  }
  saveStore(store, filePath);
  return enrichPeriod(active);
}

function updateActivePeriod(patch = {}, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath();
  const store = loadStore(filePath);
  const active = getActivePeriod(store);
  if (!active) {
    return null;
  }
  if (patch.publicIp !== undefined) {
    active.publicIp = normalizeIp(patch.publicIp);
  }
  if (patch.proxyServer !== undefined) {
    active.proxyServer = String(patch.proxyServer || "").trim() || null;
  }
  if (patch.proxyDisplay !== undefined) {
    active.proxyDisplay = String(patch.proxyDisplay || "").trim() || active.proxyDisplay;
  }
  saveStore(store, filePath);
  return enrichPeriod(active);
}

function listPeriods(options = {}, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath(options.settings || null);
  const store = loadStore(filePath);
  const nowMs = Date.now();
  const limitRaw = Number(options.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 100;
  const enriched = store.periods.map((p) => enrichPeriod(p, nowMs));
  const newestFirst = enriched.slice().reverse();
  return newestFirst.slice(0, limit);
}

function buildReport(options = {}, logFilePath) {
  const filePath = logFilePath || resolveLogFilePath(options.settings || null);
  const periods = listPeriods(options, filePath);
  const active = periods.find((p) => p.active) || null;
  const completed = periods.filter((p) => !p.active);
  const totalOnlineMs = periods.reduce((sum, p) => sum + (Number(p.durationMs) || 0), 0);
  const uniqueIps = [
    ...new Set(periods.map((p) => p.publicIp).filter(Boolean))
  ];

  return {
    ok: true,
    logFile: path.basename(filePath),
    logFilePath: filePath,
    active,
    periodCount: periods.length,
    completedCount: completed.length,
    uniqueIps,
    totalOnlineMs,
    totalOnlineLabel: formatDuration(totalOnlineMs),
    periods
  };
}

async function fetchEgressIpDirect(timeoutMs = 4000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return normalizeIp(data && data.ip);
  } catch (_error) {
    return null;
  }
}

/**
 * Prefer Playwright context request so traffic follows the browser proxy (game egress).
 */
async function fetchEgressIpViaContext(context, timeoutMs = 8000) {
  if (!context || !context.request || typeof context.request.get !== "function") {
    return null;
  }
  try {
    const res = await context.request.get("https://api.ipify.org?format=json", {
      timeout: timeoutMs
    });
    if (!res.ok()) {
      return null;
    }
    const data = await res.json();
    return normalizeIp(data && data.ip);
  } catch (_error) {
    return null;
  }
}

async function resolvePublicIp(session = null) {
  if (session && session.context) {
    const viaProxy = await fetchEgressIpViaContext(session.context);
    if (viaProxy) {
      return viaProxy;
    }
  }
  if (session && session.page && !session.page.isClosed()) {
    const viaProxy = await fetchEgressIpViaContext(session.page.context());
    if (viaProxy) {
      return viaProxy;
    }
  }
  return fetchEgressIpDirect();
}

module.exports = {
  LOG_SCHEMA_VERSION,
  DEFAULT_SESSION_PRESENCE_FILE,
  DEFAULT_MAX_PERIODS,
  resolveLogFilePath,
  loadStore,
  saveStore,
  closeOpenPeriods,
  startPeriod,
  endActivePeriod,
  updateActivePeriod,
  getActivePeriod,
  listPeriods,
  buildReport,
  enrichPeriod,
  formatDuration,
  durationMs,
  fetchEgressIpDirect,
  fetchEgressIpViaContext,
  resolvePublicIp,
  normalizeIp
};
