const proxyPool = require("./proxyPool");

const { normalizeProxyServer } = proxyPool;

function loadProxyFromEnv(env = process.env) {
  return {
    server: normalizeProxyServer(env.PROXY_SERVER),
    username: String(env.PROXY_USERNAME || "").trim(),
    password: String(env.PROXY_PASSWORD || "").trim(),
    bypass: String(env.PROXY_BYPASS || "").trim()
  };
}

function applyProxyToSettings(settings, proxy = {}) {
  proxyPool.applyProxyFieldsToSettings(settings, proxy);
}

function syncSettingsFromProxyStore(settings) {
  let store = proxyPool.loadStore();
  store = proxyPool.importLegacyProxyIfEmpty(store, settings);
  if (store.proxies.length) {
    proxyPool.applyActiveToSettings(settings, store);
    if (!store.updatedAt) {
      proxyPool.saveStore(store);
    }
    return store;
  }
  applyProxyToSettings(settings, loadProxyFromEnv(process.env));
  return store;
}

function getPlaywrightProxy(settings) {
  const server = normalizeProxyServer(settings && settings.proxyServer);
  if (!server) {
    return undefined;
  }
  const proxy = { server };
  if (settings.proxyUsername) {
    proxy.username = settings.proxyUsername;
  }
  if (settings.proxyPassword) {
    proxy.password = settings.proxyPassword;
  }
  if (settings.proxyBypass) {
    proxy.bypass = settings.proxyBypass;
  }
  return proxy;
}

function formatProxyDisplay(settings, store = null) {
  const pool = store || proxyPool.loadStore();
  if (pool.proxies && pool.proxies.length) {
    const active = proxyPool.getActiveProxy(pool);
    const total = pool.proxies.length;
    if (!active) {
      return `pool (${total}) — none active`;
    }
    let label = `#${active.index + 1}/${total} ${active.server}`;
    if (active.username) {
      label += ` (${active.username})`;
    }
    return label;
  }

  const server = normalizeProxyServer(settings && settings.proxyServer);
  if (!server) {
    return "direct (none)";
  }
  let label = server;
  if (settings.proxyUsername) {
    label += ` (user: ${settings.proxyUsername})`;
  }
  if (settings.proxyBypass) {
    label += ` bypass=${settings.proxyBypass}`;
  }
  return label;
}

function proxyEnvValues(settings) {
  return {
    PROXY_SERVER: String(settings.proxyServer || ""),
    PROXY_USERNAME: String(settings.proxyUsername || ""),
    PROXY_PASSWORD: String(settings.proxyPassword || ""),
    PROXY_BYPASS: String(settings.proxyBypass || "")
  };
}

function buildProxySettingsPayload(settings) {
  const store = proxyPool.loadStore();
  const active = proxyPool.getActiveProxy(store);
  return {
    bypass: store.bypass || settings.proxyBypass || "",
    activeIndex: store.activeIndex,
    count: store.proxies.length,
    activeDisplay: formatProxyDisplay(settings, store),
    active: active
      ? {
          index: active.index,
          server: active.server,
          username: active.username || "",
          hasPassword: Boolean(active.password)
        }
      : null,
    proxies: proxyPool.serializeProxiesForClient(store),
    listFile: proxyPool.PROXY_LIST_FILE
  };
}

module.exports = {
  normalizeProxyServer,
  loadProxyFromEnv,
  applyProxyToSettings,
  syncSettingsFromProxyStore,
  getPlaywrightProxy,
  formatProxyDisplay,
  proxyEnvValues,
  buildProxySettingsPayload,
  proxyPool
};
