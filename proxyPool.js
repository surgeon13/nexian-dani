const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.resolve(__dirname, "templates");
const PROXY_LIST_FILE = path.resolve(TEMPLATES_DIR, "proxy_list.json");

function normalizeProxyServer(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || /^(none|direct|off|disabled|-)$/i.test(trimmed)) {
    return "";
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function applyProxyFieldsToSettings(settings, proxy = {}) {
  settings.proxyServer = normalizeProxyServer(proxy.server);
  settings.proxyUsername = String(proxy.username || "").trim();
  settings.proxyPassword = String(proxy.password || "").trim();
  settings.proxyBypass = String(proxy.bypass || "").trim();
  process.env.PROXY_SERVER = settings.proxyServer;
  process.env.PROXY_USERNAME = settings.proxyUsername;
  process.env.PROXY_PASSWORD = settings.proxyPassword;
  process.env.PROXY_BYPASS = settings.proxyBypass;
}

function emptyStore() {
  return { bypass: "", activeIndex: 0, proxies: [], updatedAt: null };
}

function loadStore() {
  if (!fs.existsSync(PROXY_LIST_FILE)) {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PROXY_LIST_FILE, "utf8"));
    const proxies = Array.isArray(parsed.proxies)
      ? parsed.proxies.map(normalizeProxyEntry).filter(Boolean)
      : [];
    let activeIndex = Number(parsed.activeIndex);
    if (!Number.isFinite(activeIndex) || activeIndex < 0) {
      activeIndex = 0;
    }
    if (proxies.length && activeIndex >= proxies.length) {
      activeIndex = 0;
    }
    return {
      bypass: String(parsed.bypass || "").trim(),
      activeIndex,
      proxies,
      updatedAt: parsed.updatedAt || null
    };
  } catch (_error) {
    return emptyStore();
  }
}

function saveStore(store) {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
  const safe = {
    bypass: String(store && store.bypass ? store.bypass : "").trim(),
    activeIndex: Number(store && store.activeIndex) || 0,
    proxies: Array.isArray(store && store.proxies)
      ? store.proxies.map(normalizeProxyEntry).filter(Boolean)
      : [],
    updatedAt: new Date().toISOString()
  };
  if (safe.proxies.length && safe.activeIndex >= safe.proxies.length) {
    safe.activeIndex = 0;
  }
  fs.writeFileSync(PROXY_LIST_FILE, JSON.stringify(safe, null, 2), "utf8");
  return safe;
}

function normalizeProxyEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const server = normalizeProxyServer(entry.server);
  if (!server) {
    return null;
  }
  return {
    server,
    username: String(entry.username || "").trim(),
    password: String(entry.password || "").trim()
  };
}

function parseProxyLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) {
    return null;
  }

  let match = raw.match(/^(https?|socks5):\/\/([^:@/]+):([^@/]+)@(.+)$/i);
  if (match) {
    return normalizeProxyEntry({
      server: `${match[1]}://${match[4]}`,
      username: match[2],
      password: match[3]
    });
  }

  if (/^(https?|socks5):\/\//i.test(raw)) {
    return normalizeProxyEntry({ server: raw });
  }

  match = raw.match(/^([^:@/]+):([^@/]+)@([^:\s]+):(\d+)\s*$/);
  if (match) {
    return normalizeProxyEntry({
      server: `${match[3]}:${match[4]}`,
      username: match[1],
      password: match[2]
    });
  }

  const parts = raw.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    return normalizeProxyEntry({
      server: `${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts.slice(3).join(":")
    });
  }

  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return normalizeProxyEntry({ server: `${parts[0]}:${parts[1]}` });
  }

  return null;
}

function parseProxyListText(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const entry = parseProxyLine(line);
    if (!entry) {
      continue;
    }
    const key = `${entry.server}|${entry.username}|${entry.password}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function getActiveProxy(store) {
  if (!store || !Array.isArray(store.proxies) || !store.proxies.length) {
    return null;
  }
  const index = Number(store.activeIndex);
  const safeIndex = Number.isFinite(index) && index >= 0 && index < store.proxies.length ? index : 0;
  return { index: safeIndex, ...store.proxies[safeIndex] };
}

function setActiveIndex(store, index) {
  if (!store.proxies.length) {
    store.activeIndex = 0;
    return store;
  }
  const next = Math.floor(Number(index));
  store.activeIndex = Number.isFinite(next)
    ? Math.max(0, Math.min(store.proxies.length - 1, next))
    : 0;
  return store;
}

function rotateActive(store) {
  if (!store.proxies.length) {
    store.activeIndex = 0;
    return store;
  }
  store.activeIndex = (Number(store.activeIndex) + 1) % store.proxies.length;
  return store;
}

function applyActiveToSettings(settings, store) {
  const active = getActiveProxy(store);
  applyProxyFieldsToSettings(settings, {
    server: active ? active.server : "",
    username: active ? active.username : "",
    password: active ? active.password : "",
    bypass: store && store.bypass ? store.bypass : settings.proxyBypass
  });
}

function importLegacyProxyIfEmpty(store, settings) {
  if (store.proxies.length) {
    return store;
  }
  const server = normalizeProxyServer(settings && settings.proxyServer);
  if (!server) {
    return store;
  }
  store.proxies = [
    normalizeProxyEntry({
      server,
      username: settings.proxyUsername,
      password: settings.proxyPassword
    })
  ].filter(Boolean);
  store.activeIndex = 0;
  if (settings.proxyBypass && !store.bypass) {
    store.bypass = settings.proxyBypass;
  }
  return store;
}

function formatProxyEntryLabel(entry, index, active = false) {
  if (!entry) {
    return "—";
  }
  let label = `#${index + 1} ${entry.server}`;
  if (entry.username) {
    label += ` (${entry.username})`;
  }
  if (active) {
    label += " *active*";
  }
  return label;
}

function serializeProxiesForClient(store) {
  return (store.proxies || []).map((entry, index) => ({
    index,
    server: entry.server,
    username: entry.username || "",
    hasPassword: Boolean(entry.password),
    active: index === store.activeIndex
  }));
}

module.exports = {
  PROXY_LIST_FILE,
  normalizeProxyServer,
  applyProxyFieldsToSettings,
  loadStore,
  saveStore,
  parseProxyLine,
  parseProxyListText,
  normalizeProxyEntry,
  getActiveProxy,
  setActiveIndex,
  rotateActive,
  applyActiveToSettings,
  importLegacyProxyIfEmpty,
  formatProxyEntryLabel,
  serializeProxiesForClient
};
