const DISPLAY_VIEW_KEY = "nexian-dashboard-view";

const ACTIONS = [
  { action: "status", key: "0", label: "Village status", shortLabel: "Status" },
  { action: "farmlist", key: "1", label: "Send farmlists", shortLabel: "Farm" },
  { action: "village-builder", key: "2", label: "Village builder", shortLabel: "V.Bld" },
  { action: "resource-builder", key: "3", label: "Resource builder", shortLabel: "R.Bld" },
  { action: "troops", key: "4", label: "Troop trainer", shortLabel: "Troop" },
  { action: "cranny", key: "C", label: "Cranny defense", shortLabel: "Cranny" },
  { action: "expansion", key: "5", label: "Expansion", shortLabel: "Exp" },
  { action: "pause", key: "P", label: "Pause / resume", shortLabel: "Pause" },
  { action: "relogin", key: "r", label: "Relogin", shortLabel: "Relog" },
  { action: "relogin-status", key: "R", label: "Relogin + status", shortLabel: "R+St" },
  { action: "logs", key: "L", label: "Log summary", shortLabel: "Log" },
  { action: "top10", key: "O", label: "Top 10 snapshot", shortLabel: "Top10" },
  { action: "stop-builder", key: "X", label: "Stop builder", shortLabel: "Stop", danger: true },
  { action: "quit", key: "Q", label: "Quit", shortLabel: "Quit", danger: true }
];

const els = {
  clock: document.getElementById("clock"),
  automationPill: document.getElementById("automation-pill"),
  accountStrip: document.getElementById("account-strip"),
  statusGrid: document.getElementById("status-grid"),
  villageContext: document.getElementById("village-context"),
  actionGrid: document.getElementById("action-grid"),
  busyNote: document.getElementById("busy-note"),
  villageList: document.getElementById("village-list"),
  logList: document.getElementById("log-list"),
  troopGlobalForm: document.getElementById("troop-global-form"),
  troopRrPanel: document.getElementById("troop-rr-panel"),
  troopRrPill: document.getElementById("troop-rr-pill"),
  troopRrStatusText: document.getElementById("troop-rr-status-text"),
  troopRrInterval: document.getElementById("troop-rr-interval"),
  troopRrNext: document.getElementById("troop-rr-next"),
  troopRrForm: document.getElementById("troop-rr-form"),
  troopRrEnabled: document.getElementById("troop-rr-enabled"),
  troopRrMin: document.getElementById("troop-rr-min"),
  troopRrMax: document.getElementById("troop-rr-max"),
  troopVillagesList: document.getElementById("troop-villages-list"),
  troopVillagesEmpty: document.getElementById("troop-villages-empty"),
  activityPill: document.getElementById("activity-pill"),
  activityStatusText: document.getElementById("activity-status-text"),
  activityInterval: document.getElementById("activity-interval"),
  activityNext: document.getElementById("activity-next"),
  activityCompleted: document.getElementById("activity-completed"),
  activityLast: document.getElementById("activity-last"),
  activityForm: document.getElementById("activity-form"),
  activityEnabled: document.getElementById("activity-enabled"),
  activityMin: document.getElementById("activity-min"),
  activityMax: document.getElementById("activity-max"),
  activityPatterns: document.getElementById("activity-patterns"),
  proxyPill: document.getElementById("proxy-pill"),
  proxyActiveText: document.getElementById("proxy-active-text"),
  proxyCount: document.getElementById("proxy-count"),
  proxyForm: document.getElementById("proxy-form"),
  proxyText: document.getElementById("proxy-text"),
  proxyBypass: document.getElementById("proxy-bypass"),
  proxyActiveIndex: document.getElementById("proxy-active-index"),
  proxyListPreview: document.getElementById("proxy-list-preview"),
  proxySaveBtn: document.getElementById("proxy-save-btn"),
  proxyNextBtn: document.getElementById("proxy-next-btn"),
  proxyDisableBtn: document.getElementById("proxy-disable-btn"),
  displayCompact: document.getElementById("display-compact"),
  displayModeBadge: document.getElementById("display-mode-badge"),
  villagePicker: document.getElementById("village-picker"),
  top10Pill: document.getElementById("top10-pill"),
  top10StatusText: document.getElementById("top10-status-text"),
  top10Interval: document.getElementById("top10-interval"),
  top10Next: document.getElementById("top10-next"),
  top10Completed: document.getElementById("top10-completed"),
  top10Updated: document.getElementById("top10-updated"),
  top10Standings: document.getElementById("top10-standings"),
  top10CategoryTabs: document.getElementById("top10-category-tabs"),
  top10Podium: document.getElementById("top10-podium"),
  top10Board: document.getElementById("top10-board"),
  top10Trend: document.getElementById("top10-trend"),
  top10RefreshBtn: document.getElementById("top10-refresh-btn"),
  top10SnapshotBtn: document.getElementById("top10-snapshot-btn"),
  toast: document.getElementById("toast")
};

let latestStatus = null;
let toastTimer = null;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function isCompactView() {
  return document.body.classList.contains("compact-view");
}

function isMicroView() {
  if (!isCompactView()) {
    return false;
  }
  try {
    return window.matchMedia("(max-width: 480px), (max-height: 400px)").matches;
  } catch (_) {
    return false;
  }
}

let clientActionPending = false;
let pendingClientActionLabel = "";
let lastVillageRenderKey = "";
let lastActionRenderKey = "";
let lastStatusGridKey = "";
let lastVillageContextKey = "";
let pendingStatusPayload = null;
let statusRenderTimer = null;
const STATUS_RENDER_MS = 350;

function renderActions(busy, force = false) {
  const compact = isCompactView();
  const effectiveBusy = busy || clientActionPending;
  const renderKey = `${effectiveBusy}|${compact}`;
  if (!force && renderKey === lastActionRenderKey && els.actionGrid.childElementCount) {
    els.busyNote.classList.toggle("hidden", !effectiveBusy);
    if (effectiveBusy) {
      els.busyNote.textContent = clientActionPending && pendingClientActionLabel && !busy
        ? `Queued: ${pendingClientActionLabel}…`
        : latestStatus && latestStatus.currentActionLabel
          ? `Running: ${latestStatus.currentActionLabel}…`
          : "Action in progress…";
    }
    return;
  }
  lastActionRenderKey = renderKey;
  els.actionGrid.innerHTML = "";
  ACTIONS.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `action-btn${item.danger ? " danger" : ""}`;
    btn.disabled = effectiveBusy;
    const label = compact && item.shortLabel ? item.shortLabel : item.label;
    btn.innerHTML = `<span class="key">${item.key}</span>${label}`;
    btn.addEventListener("click", () => runAction(item.action, item.label));
    els.actionGrid.appendChild(btn);
  });
  els.busyNote.classList.toggle("hidden", !effectiveBusy);
  if (effectiveBusy) {
    els.busyNote.textContent = clientActionPending && pendingClientActionLabel && !busy
      ? `Queued: ${pendingClientActionLabel}…`
      : latestStatus && latestStatus.currentActionLabel
        ? `Running: ${latestStatus.currentActionLabel}…`
        : "Action in progress…";
  }
}

function loopLabelShort(loop) {
  if (!loop || !loop.enabled) {
    return "off";
  }
  if (Number.isFinite(loop.nextInMinutes)) {
    return `${loop.nextInMinutes}m`;
  }
  return "on";
}

function loopLabel(loop) {
  if (!loop) return "OFF";
  const on = loop.enabled ? "ON" : "OFF";
  const next =
    loop.enabled && Number.isFinite(loop.nextInMinutes) ? ` · ${loop.nextInMinutes}m` : "";
  const range =
    loop.minMinutes != null && loop.maxMinutes != null
      ? ` (${loop.minMinutes}-${loop.maxMinutes}m)`
      : "";
  const done =
    loop.completedCount != null && loop.completedCount > 0
      ? ` · ${loop.completedCount} done`
      : "";
  return `${on}${range}${next}${done}`;
}

function formatIpList(account) {
  if (!account) return "—";
  const parts = [];
  if (account.publicAddress) {
    parts.push(`Public ${account.publicAddress}`);
  }
  if (Array.isArray(account.localAddresses) && account.localAddresses.length) {
    parts.push(`LAN ${account.localAddresses.join(", ")}`);
  }
  if (!parts.length) {
    return "127.0.0.1";
  }
  return parts.join(" · ");
}

function renderAccountStrip(account, proxy) {
  if (!account) {
    els.accountStrip.innerHTML = "";
    return;
  }

  const proxyLabel = proxy && proxy.activeDisplay ? proxy.activeDisplay : "direct (none)";

  if (isCompactView()) {
    const user = account.username || "—";
    const server = account.gameHost || "—";
    const browser = account.browserMode === "Headless" ? "headless" : "headed";
    els.accountStrip.innerHTML = `
    <div class="account-item account-compact-line">
      <div class="account-value">${escapeHtml(user)} · ${escapeHtml(server)} · ${escapeHtml(browser)} · ${escapeHtml(proxyLabel)}</div>
    </div>`;
    return;
  }

  const items = [
    { label: "Username", value: account.username || "—" },
    { label: "IP address", value: formatIpList(account) },
    { label: "Game server", value: account.gameHost || "—" },
    { label: "Browser", value: account.browserMode || "—" },
    { label: "Proxy", value: proxyLabel }
  ];

  els.accountStrip.innerHTML = items
    .map(
      (item) => `
    <div class="account-item">
      <div class="account-label">${escapeHtml(item.label)}</div>
      <div class="account-value">${escapeHtml(String(item.value))}</div>
    </div>`
    )
    .join("");
}

function scheduleRenderStatus(status) {
  pendingStatusPayload = status;
  if (statusRenderTimer) {
    return;
  }
  statusRenderTimer = setTimeout(() => {
    statusRenderTimer = null;
    if (pendingStatusPayload) {
      const next = pendingStatusPayload;
      pendingStatusPayload = null;
      renderStatusNow(next);
    }
  }, STATUS_RENDER_MS);
}

function renderStatus(status) {
  scheduleRenderStatus(status);
}

function renderStatusNow(status) {
  latestStatus = status;
  if (!status) return;

  if (!status.actionInProgress) {
    clientActionPending = false;
    pendingClientActionLabel = "";
    lastActionRenderKey = "";
  }

  const starting = Boolean(status.starting);
  const paused = Boolean(status.automation && status.automation.paused);
  let pillText = "RUNNING";
  let pillClass = "pill-running";
  if (starting) {
    const phase = status.phase || (status.loadingVillages ? "starting" : "");
    pillText =
      phase === "logging_in" ? "LOGGING IN" : phase === "menu" || status.loadingVillages ? "LOADING" : "STARTING";
    pillClass = "pill-paused";
  } else if (paused) {
    pillText = "PAUSED";
    pillClass = "pill-paused";
  }
  els.automationPill.textContent = pillText;
  els.automationPill.className = `pill ${pillClass}`;

  renderAccountStrip(status.account, status.proxy);

  if (status.proxy) {
    renderProxySettingsPanel(status.proxy);
  }

  const compact = isCompactView();
  const stats = compact
    ? [
        { label: "Farm", value: loopLabelShort(status.loops && status.loops.farmlist) },
        { label: "Builder", value: loopLabelShort(status.loops && status.loops.builder) },
        { label: "Troop", value: loopLabelShort(status.loops && status.loops.troop) },
        { label: "Cranny", value: loopLabelShort(status.loops && status.loops.cranny) },
        { label: "Activity", value: loopLabelShort(status.loops && status.loops.activity) },
        { label: "Top10", value: loopLabelShort(status.loops && status.loops.top10) },
        {
          label: "Now",
          value: starting
            ? "Starting…"
            : status.actionInProgress
              ? status.currentActionLabel || "…"
              : "Idle"
        }
      ]
    : [
    {
      label: "Automation",
      value: starting
        ? status.automation && status.automation.reason
          ? `Starting (${status.automation.reason})`
          : "Starting…"
        : paused
          ? `Paused (${status.automation.reason})`
          : "Online"
    },
    { label: "Session loop", value: loopLabel(status.sessionLoop) },
    { label: "Farmlist", value: loopLabel(status.loops && status.loops.farmlist) },
    { label: "Builder", value: loopLabel(status.loops && status.loops.builder) },
    { label: "Troop RR", value: loopLabel(status.loops && status.loops.troop) },
    { label: "Cranny RR", value: loopLabel(status.loops && status.loops.cranny) },
    { label: "Activity", value: loopLabel(status.loops && status.loops.activity) },
    { label: "Top 10", value: loopLabel(status.loops && status.loops.top10) },
    {
      label: "Current action",
      value: status.actionInProgress ? status.currentActionLabel || "…" : "Idle"
    }
  ];

  const gridKey = `${compact}|${paused}|${stats.map((s) => s.value).join(";")}`;
  if (gridKey !== lastStatusGridKey) {
    lastStatusGridKey = gridKey;
    els.statusGrid.innerHTML = stats
      .map(
        (s) => `
    <div class="stat">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${escapeHtml(String(s.value))}</div>
    </div>`
      )
      .join("");
  }

  const sel = status.selectedVillage;
  const act = status.activeVillage;
  const ctxKey = `${compact}|${formatVillage(sel, true)}|${formatVillage(act, true)}|${status.builderPlanMode || "resource"}`;
  if (ctxKey !== lastVillageContextKey) {
    lastVillageContextKey = ctxKey;
    if (compact) {
      els.villageContext.innerHTML = `
    <div class="village-context-compact">${escapeHtml(formatVillage(sel, true))} → ${escapeHtml(formatVillage(act, true))} · ${escapeHtml(status.builderPlanMode || "resource")}</div>`;
    } else {
      els.villageContext.innerHTML = `
    <div><strong>Selected:</strong> ${escapeHtml(formatVillage(sel))}</div>
    <div><strong>Active:</strong> ${escapeHtml(formatVillage(act))}</div>
    <div><strong>Builder plan:</strong> ${escapeHtml(status.builderPlanMode || "resource")}</div>
  `;
    }
  }

  renderVillages(status.villages || [], status.selectedVillageId, status.activeVillageId);
  renderActions(Boolean(status.actionInProgress));
  if (status.activitySimulation) {
    if (activeTab === "settings" && !activityFormDirty) {
      if (Array.isArray(status.activitySimulation.patterns)) {
        renderActivitySettingsPanel(status.activitySimulation);
      }
    } else {
      syncActivityCountdown(status.activitySimulation);
      if (activeTab === "settings") {
        renderActivityLastAction(status.activitySimulation.lastAction);
      }
    }
  }
  if (status.display && !displayFormDirty) {
    renderDisplaySettingsPanel(status.display);
  }
  if (activeTab === "troops" && status.loops && status.loops.troop) {
    renderTroopLoopPanel(status.loops.troop);
  }
  if (status.top10Tracking || (status.loops && status.loops.top10)) {
    renderTop10LoopPanel(status.top10Tracking || status.loops.top10);
  }
}

function formatVillage(v, short = false) {
  if (!v) return "—";
  const coords = v.coordsText || (v.x != null && v.y != null ? (short ? `${v.x}|${v.y}` : `(${v.x}|${v.y})`) : "");
  const name = v.name || "?";
  if (short) {
    return `${name} ${coords}`.trim();
  }
  return `${name} ${coords} (vid=${v.id})`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function villageListKey(villages, selectedId, activeId) {
  const compact = isCompactView();
  const body = villages
    .map((v) => `${v.id}:${v.underAttack ? 1 : 0}:${v.name || ""}:${v.x}:${v.y}`)
    .join(",");
  return `${compact}|${selectedId}|${activeId}|${body}`;
}

function renderVillages(villages, selectedId, activeId, force = false) {
  const key = villageListKey(villages, selectedId, activeId);
  if (!force && key === lastVillageRenderKey && els.villageList.childElementCount) {
    return;
  }
  lastVillageRenderKey = key;
  els.villageList.innerHTML = "";
  if (!villages.length) {
    els.villageList.innerHTML = '<div class="log-entry">No villages loaded yet.</div>';
    return;
  }
  villages.forEach((v) => {
    const row = document.createElement("div");
    const classes = ["village-item"];
    if (Number(v.id) === Number(selectedId)) classes.push("selected");
    if (Number(v.id) === Number(activeId)) classes.push("active");
    row.className = classes.join(" ");
    row.innerHTML = `
      <span>${escapeHtml(formatVillage(v, isCompactView()))}${v.underAttack ? " ⚠" : ""}</span>
      <button type="button">${isCompactView() ? "Sel" : "Select"}</button>
    `;
    row.querySelector("button").addEventListener("click", () => selectVillage(v.id));
    els.villageList.appendChild(row);
  });
}

async function runAction(action, label) {
  clientActionPending = true;
  pendingClientActionLabel = label;
  lastActionRenderKey = "";
  renderActions(false, true);
  try {
    await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action })
    });
    showToast(`Queued: ${label}`);
  } catch (error) {
    clientActionPending = false;
    pendingClientActionLabel = "";
    lastActionRenderKey = "";
    renderActions(Boolean(latestStatus && latestStatus.actionInProgress), true);
    showToast(error.message || "Action failed");
  }
}

async function selectVillage(id) {
  clientActionPending = true;
  pendingClientActionLabel = `Village ${id}`;
  lastActionRenderKey = "";
  renderActions(Boolean(latestStatus && latestStatus.actionInProgress), true);
  try {
    await api("/api/village", {
      method: "POST",
      body: JSON.stringify({ id })
    });
    showToast(`Selecting village ${id}`);
  } catch (error) {
    clientActionPending = false;
    pendingClientActionLabel = "";
    lastActionRenderKey = "";
    renderActions(Boolean(latestStatus && latestStatus.actionInProgress), true);
    showToast(error.message || "Select failed");
  }
}

function renderLogs(entries) {
  els.logList.innerHTML = "";
  if (!entries.length) {
    els.logList.innerHTML = '<div class="log-entry">No log entries yet.</div>';
    return;
  }
  entries.slice().reverse().forEach((entry) => {
    const line = document.createElement("div");
    line.className = "log-entry";
    const type = entry.actionType || entry.raw || "event";
    const status = entry.status ? ` · ${entry.status}` : "";
    const village = entry.details && entry.details.villageName ? ` · ${entry.details.villageName}` : "";
    line.innerHTML = `<strong>${escapeHtml(String(type))}</strong>${escapeHtml(status + village)}`;
    els.logList.appendChild(line);
  });
}

async function refreshLogs() {
  try {
    const data = await api("/api/logs?tail=40");
    renderLogs(data.entries || []);
  } catch (_error) {
    /* ignore */
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("status", (event) => {
    try {
      renderStatus(JSON.parse(event.data));
    } catch (_error) {
      /* ignore */
    }
  });
  source.onerror = () => {
    /* EventSource reconnects automatically */
  };
}

async function refreshActivitySettingsPanel() {
  try {
    const data = await api("/api/activity-settings");
    if (data && data.activitySimulation) {
      renderActivitySettingsPanel(data.activitySimulation);
      if (latestStatus) {
        latestStatus.activitySimulation = {
          ...(latestStatus.activitySimulation || {}),
          ...data.activitySimulation
        };
      }
    }
  } catch (_error) {
    if (latestStatus && latestStatus.activitySimulation) {
      renderActivitySettingsPanel(latestStatus.activitySimulation);
    }
  }
}

function startHeavyTabPolling() {
  setInterval(() => {
    if (activeTab === "troops") {
      api("/api/troop-templates")
        .then((data) => {
          if (data && data.troop) {
            applyTroopLiveUpdates(data.troop);
          }
        })
        .catch(() => {});
    }
    if (activeTab === "top10") {
      refreshTop10Dashboard({ silent: true }).catch(() => {});
    }
  }, 12000);
}

// --- Troop Templates tab ---------------------------------------------------

let troopsLoadedOnce = false;
let troopDirtyGlobal = false;
const troopDirtyVillages = new Set();
let latestTroopData = null;
let troopRenderedMountKey = "";
let troopInteractionUntil = 0;
let troopLoopCountdownEnd = null;
let troopLoopCountdownTimer = null;
let troopRrFormDirty = false;
const villageLoopCountdownEnds = new Map();
const troopDirtyVillageTimers = new Set();
const troopDirtyVillageRr = new Set();
const villageLoopSaveTimers = new Map();
let activeTab = "dashboard";

const TROOP_CATALOG = {
  teuton: {
    label: "Teuton",
    infantry: ["Clubswinger", "Spearman", "Axesman"],
    cavalry: ["Scout", "Paladin", "Teutonic Knight"]
  },
  roman: {
    label: "Roman",
    infantry: ["Legionnaire", "Praetorian", "Imperian"],
    cavalry: ["Equites Legati", "Equites Imperatoris", "Equites Caesaris"]
  },
  gaul: {
    label: "Gaul",
    infantry: ["Phalanx", "Swordsman"],
    cavalry: ["Pathfinder", "Theutates Thunder", "Druidrider", "Haeduan"]
  }
};

const TROOP_BRANCHES = ["infantry", "cavalry"];

function hasTroopEditsInProgress() {
  return troopDirtyGlobal || troopDirtyVillages.size > 0;
}

function markTroopInteraction() {
  troopInteractionUntil = Date.now() + 120000;
}

function isTroopInteractionActive() {
  return Date.now() < troopInteractionUntil;
}

function shouldFreezeTroopDom() {
  return hasTroopEditsInProgress() || isTroopInteractionActive();
}

function formatTroopLoopCountdown(ms) {
  if (ms <= 0) {
    return "due now";
  }
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function syncVillageLoopCountdowns(villages) {
  (villages || []).forEach((v) => {
    const id = String(v.villageId);
    if (v.roundRobinEnabled && v.nextInMinutes != null && !troopDirtyVillageTimers.has(id)) {
      villageLoopCountdownEnds.set(id, Date.now() + v.nextInMinutes * 60000);
    } else if (!troopDirtyVillageTimers.has(id)) {
      villageLoopCountdownEnds.delete(id);
    }
  });
  updateVillageCountdownDisplays();
}

function updateVillageCountdownDisplays() {
  document.querySelectorAll(".troop-village-next-value").forEach((el) => {
    const vid = el.dataset.villageId;
    if (!vid) {
      return;
    }
    const end = villageLoopCountdownEnds.get(vid);
    if (end == null) {
      el.textContent = "—";
      return;
    }
    const ms = end - Date.now();
    el.textContent = ms <= 0 ? "Due now" : formatTroopLoopCountdown(ms);
  });
}

function syncTroopLoopCountdown(loop) {
  if (loop && loop.enabled && loop.nextInMinutes != null) {
    troopLoopCountdownEnd = Date.now() + loop.nextInMinutes * 60000;
  } else {
    troopLoopCountdownEnd = null;
  }
  updateTroopLoopCountdownDisplay();
}

function updateTroopLoopCountdownDisplay() {
  if (!els.troopRrNext) {
    return;
  }
  if (troopLoopCountdownEnd == null) {
    return;
  }
  els.troopRrNext.textContent = formatTroopLoopCountdown(troopLoopCountdownEnd - Date.now());
}

function startLoopCountdownTicker() {
  if (troopLoopCountdownTimer) {
    return;
  }
  troopLoopCountdownTimer = setInterval(() => {
    if (activeTab === "troops") {
      updateTroopLoopCountdownDisplay();
      updateVillageCountdownDisplays();
    }
    if (activeTab === "settings") {
      updateActivityCountdownDisplay();
    }
  }, 10000);
}

function startTroopLoopCountdownTicker() {
  startLoopCountdownTicker();
}

function renderTroopLoopPanel(loop) {
  if (!els.troopRrPanel) {
    return;
  }
  if (!loop) {
    els.troopRrPill.textContent = "OFF";
    els.troopRrPill.className = "pill pill-paused";
    els.troopRrStatusText.textContent = "Unavailable";
    els.troopRrInterval.textContent = "—";
    els.troopRrNext.textContent = "—";
    troopLoopCountdownEnd = null;
    return;
  }

  const enabled = Boolean(loop.enabled);
  const min = loop.minMinutes != null ? loop.minMinutes : "—";
  const max = loop.maxMinutes != null ? loop.maxMinutes : "—";

  els.troopRrPill.textContent = enabled ? "ON" : "OFF";
  els.troopRrPill.className = `pill ${enabled ? "pill-running" : "pill-paused"}`;
  els.troopRrStatusText.textContent = enabled
    ? `${loop.enabledVillageCount != null ? loop.enabledVillageCount : "?"} of ${loop.totalVillageCount != null ? loop.totalVillageCount : "?"} villages with independent timers`
    : "Scheduler off — use Train now or enable above";
  els.troopRrInterval.textContent =
    min !== "—" && max !== "—" ? `Default ${min}–${max} min per village` : "—";

  if (enabled) {
    syncTroopLoopCountdown(loop);
    if (loop.nextInMinutes == null) {
      els.troopRrNext.textContent = "Scheduling…";
      troopLoopCountdownEnd = null;
    }
  } else {
    els.troopRrNext.textContent = "—";
    troopLoopCountdownEnd = null;
  }

  if (!troopRrFormDirty) {
    if (els.troopRrEnabled) {
      els.troopRrEnabled.checked = enabled;
    }
    if (els.troopRrMin && min !== "—") {
      els.troopRrMin.value = String(min);
    }
    if (els.troopRrMax && max !== "—") {
      els.troopRrMax.value = String(max);
    }
  }
}

function buildTroopMountKey(data) {
  if (!data) {
    return "";
  }
  const villages = data.villages || [];
  const villagePart = villages
    .map(
      (v) =>
        `${v.villageId}:${v.hasCustom ? 1 : 0}:${v.underAttack ? 1 : 0}:${v.roundRobinEnabled ? 1 : 0}:${v.loopMinMinutes}:${v.loopMaxMinutes}`
    )
    .join("|");
  return `${villagePart}#sel:${data.selectedVillageId || ""}`;
}

function captureOpenVillageCards() {
  const open = new Set();
  if (!els.troopVillagesList) {
    return open;
  }
  els.troopVillagesList.querySelectorAll(".troop-village-card[open]").forEach((el) => {
    if (el.dataset.villageId) {
      open.add(el.dataset.villageId);
    }
  });
  return open;
}

function villageBadgesHtml(v) {
  const badges = [];
  if (v.roundRobinEnabled) {
    const interval =
      v.loopMinMinutes != null && v.loopMaxMinutes != null
        ? ` every ${v.loopMinMinutes}–${v.loopMaxMinutes}m`
        : "";
    badges.push(`<span class="troop-badge rr-on">Auto repeat${escapeHtml(interval)}</span>`);
  } else {
    badges.push('<span class="troop-badge rr-off">Manual only</span>');
  }
  if (v.hasCustom) {
    badges.push('<span class="troop-badge custom">Custom troops</span>');
  }
  if (v.isCapital) {
    badges.push('<span class="troop-badge">Capital</span>');
  }
  if (v.underAttack) {
    badges.push('<span class="troop-badge attack">Under attack</span>');
  }
  return badges.join("");
}

function syncVillageAutoRepeatChrome(card, v) {
  const vid = String(v.villageId);
  if (troopDirtyVillageRr.has(vid)) {
    return;
  }
  const rrToggle = card.querySelector(".troop-village-rr-cb");
  const rrSwitchText = card.querySelector(".troop-switch-label");
  const scheduleBlock = card.querySelector(".troop-village-schedule");
  const minInput = card.querySelector(".troop-village-min");
  const maxInput = card.querySelector(".troop-village-max");
  if (rrToggle) {
    rrToggle.checked = Boolean(v.roundRobinEnabled);
  }
  if (rrSwitchText) {
    rrSwitchText.textContent = v.roundRobinEnabled ? "On" : "Off";
  }
  if (scheduleBlock) {
    scheduleBlock.classList.toggle("hidden", !v.roundRobinEnabled);
  }
  if (minInput && !troopDirtyVillageTimers.has(vid) && v.loopMinMinutes != null) {
    minInput.value = String(v.loopMinMinutes);
  }
  if (maxInput && !troopDirtyVillageTimers.has(vid) && v.loopMaxMinutes != null) {
    maxInput.value = String(v.loopMaxMinutes);
  }
  card.classList.toggle("auto-repeat-on", Boolean(v.roundRobinEnabled));
}

function syncVillageCardChrome(data) {
  if (!els.troopVillagesList || !data) {
    return;
  }
  (data.villages || []).forEach((v) => {
    const card = els.troopVillagesList.querySelector(`[data-village-id="${v.villageId}"]`);
    if (!card) {
      return;
    }
    const badges = card.querySelector(".troop-village-badges");
    if (badges) {
      badges.innerHTML = villageBadgesHtml(v);
    }
    card.classList.toggle("has-custom", Boolean(v.hasCustom));
    card.classList.toggle(
      "is-selected",
      Number(v.villageId) === Number(data.selectedVillageId)
    );
    syncVillageAutoRepeatChrome(card, v);
  });
}

function mergeTroopLivePayload(data) {
  if (!data) {
    return null;
  }
  if (data.globalDefaults || data.defaults) {
    return data;
  }
  if (!latestTroopData) {
    return data;
  }
  const liveById = new Map((data.villages || []).map((v) => [Number(v.villageId), v]));
  return {
    ...latestTroopData,
    troopLoop: data.troopLoop || latestTroopData.troopLoop,
    selectedVillageId: data.selectedVillageId ?? latestTroopData.selectedVillageId,
    activeVillageId: data.activeVillageId ?? latestTroopData.activeVillageId,
    villages: (latestTroopData.villages || []).map((v) => {
      const live = liveById.get(Number(v.villageId));
      return live ? { ...v, ...live } : v;
    })
  };
}

function applyTroopLiveUpdates(data) {
  if (!els.troopGlobalForm) {
    return;
  }
  if (!data) {
    if (els.troopRrPanel) {
      renderTroopLoopPanel(null);
    }
    return;
  }

  const merged = mergeTroopLivePayload(data);
  const isFullPayload = Boolean(data.globalDefaults || data.defaults);
  if (isFullPayload) {
    latestTroopData = merged;
  } else if (merged && latestTroopData) {
    latestTroopData = merged;
  }
  data = merged || data;

  renderTroopLoopPanel(data.troopLoop || (data.globalDefaults && data.globalDefaults.troopLoop));
  syncVillageLoopCountdowns(data.villages);

  if (!isFullPayload && !latestTroopData) {
    return;
  }

  if (shouldFreezeTroopDom()) {
    if (!isFullPayload && latestTroopData) {
      syncVillageCardChrome(data);
    }
    return;
  }

  if (!isFullPayload) {
    syncVillageCardChrome(data);
    return;
  }

  const mountKey = buildTroopMountKey(data);
  const needsFullMount =
    mountKey !== troopRenderedMountKey || !els.troopVillagesList.childElementCount;

  if (needsFullMount) {
    renderTroopDashboard(data, { force: true, preserveOpen: true });
    return;
  }

  syncVillageCardChrome(data);
}

function resolvePreviewTribe(tribe) {
  const t = String(tribe || "auto").toLowerCase();
  return t === "teuton" || t === "roman" || t === "gaul" ? t : "teuton";
}

function getDefaultBranchTroopSet(defaults, tribe, branch) {
  const resolved = resolvePreviewTribe(tribe);
  const pack = defaults && defaults[resolved];
  const names = new Set();
  for (const mode of ["offensive", "defensive"]) {
    const list = pack && pack[mode] && pack[mode][branch];
    (Array.isArray(list) ? list : []).forEach((name) => {
      names.add(String(name).trim().toLowerCase());
    });
  }
  return names;
}

function mergeCsvIntoTroopMap(map, csv, defaultBatch) {
  parseTroopListEntries(csv, defaultBatch).forEach((entry) => {
    const key = String(entry.name).trim().toLowerCase();
    const qty = entry.qty != null ? entry.qty : defaultBatch;
    map.set(key, qty);
  });
}

function mergeEffectiveIntoTroopMap(map, branchInfo, defaultBatch) {
  if (!branchInfo) {
    return;
  }
  if (Array.isArray(branchInfo.entries) && branchInfo.entries.length) {
    branchInfo.entries.forEach((entry) => {
      const name = typeof entry === "string" ? entry : entry.name;
      const qty =
        entry && entry.qty != null ? Math.max(1, Number(entry.qty) || defaultBatch) : defaultBatch;
      map.set(String(name).trim().toLowerCase(), qty);
    });
    return;
  }
  if (Array.isArray(branchInfo.effective) && branchInfo.effective.length) {
    branchInfo.effective.forEach((name) => {
      map.set(String(name).trim().toLowerCase(), defaultBatch);
    });
  }
}

function readBranchMapFromConfig(config, branch, defaults, tribe, defaultBatch) {
  const map = new Map();
  const lists = (config && config.lists) || {};
  mergeCsvIntoTroopMap(map, lists[`${branch}Offensive`], defaultBatch);
  mergeCsvIntoTroopMap(map, lists[`${branch}Defensive`], defaultBatch);
  if (map.size) {
    return map;
  }
  const effective = (config && config.effective) || {};
  mergeEffectiveIntoTroopMap(map, effective[`${branch}Offensive`], defaultBatch);
  mergeEffectiveIntoTroopMap(map, effective[`${branch}Defensive`], defaultBatch);
  if (map.size) {
    return map;
  }
  const fallback = getDefaultBranchTroopSet(defaults, tribe, branch);
  fallback.forEach((name) => map.set(name, defaultBatch));
  return map;
}

function parseTroopListEntries(csv, defaultBatch) {
  return String(csv || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => {
      const match = token.match(/^(.+?):(\d+)$/);
      if (match) {
        return {
          name: match[1].trim(),
          qty: Math.max(1, Math.min(Number(match[2]) || defaultBatch, 999999))
        };
      }
      return { name: token, qty: null };
    });
}

function buildToggleState(config, defaults) {
  const tribe = config && config.tribe ? config.tribe : "auto";
  const defaultBatch = Math.max(1, Number((config && config.batchSize) || 5));
  const state = {};
  for (const branch of TROOP_BRANCHES) {
    state[branch] = readBranchMapFromConfig(config, branch, defaults, tribe, defaultBatch);
  }
  return state;
}

function isTroopEnabled(state, branch, troopName) {
  const map = state[branch];
  if (!map) {
    return false;
  }
  return map.has(String(troopName).trim().toLowerCase());
}

function troopUnitQty(state, branch, troopName, defaultBatch) {
  if (!isTroopEnabled(state, branch, troopName)) {
    return defaultBatch;
  }
  const qty = state[branch].get(String(troopName).trim().toLowerCase());
  return qty != null ? qty : defaultBatch;
}

function renderTroopUnitControl(branch, unit, state, defaultBatch) {
  const enabled = isTroopEnabled(state, branch, unit);
  const qty = troopUnitQty(state, branch, unit, defaultBatch);
  return `
    <div class="troop-unit-control">
      <label class="troop-switch" title="Train this unit">
        <input class="troop-unit-toggle" type="checkbox" data-branch="${branch}" data-troop="${escapeHtml(unit)}"${enabled ? " checked" : ""} />
        <span class="troop-switch-track" aria-hidden="true"></span>
      </label>
      <input
        class="troop-unit-qty"
        type="number"
        min="1"
        max="999999"
        step="1"
        data-branch="${branch}"
        data-troop="${escapeHtml(unit)}"
        value="${escapeHtml(String(qty))}"
        ${enabled ? "" : " disabled"}
        aria-label="${escapeHtml(unit)} units"
      />
    </div>`;
}

function troopToggleMatrixHtml(config, defaults) {
  const tribe = (config && config.tribe) || "auto";
  const preview = resolvePreviewTribe(tribe);
  const catalog = TROOP_CATALOG[preview];
  const defaultBatch = Math.max(1, Number((config && config.batchSize) || 5));
  const state = buildToggleState(config, defaults || (config && config.defaults));
  const autoNote =
    tribe === "auto"
      ? ` Tribe is set to Auto — showing ${catalog.label} units for preview (detected at train time).`
      : "";

  const renderGroup = (branch, title, buildingLabel, units) => {
    if (!units.length) {
      return "";
    }
    const rows = units
      .map(
        (unit) => `
        <tr>
          <td>
            <span class="troop-unit-name">${escapeHtml(unit)}</span>
            <span class="troop-unit-building">${escapeHtml(buildingLabel)}</span>
          </td>
          <td>${renderTroopUnitControl(branch, unit, state, defaultBatch)}</td>
        </tr>`
      )
      .join("");

    return `
      <div class="troop-matrix-group" data-branch="${branch}">
        <div class="troop-matrix-group-title">${escapeHtml(title)}</div>
        <table class="troop-matrix">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Train</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };

  return `
    <div class="troop-matrix-wrap" data-preview-tribe="${preview}">
      <p class="troop-matrix-intro">
        Turn units on and set how many to queue each train (e.g. Phalanx → 30). Empty quantity uses the
        default batch below.${autoNote}
      </p>
      <div class="troop-matrix-actions">
        <button type="button" class="troop-quick-btn" data-preset="tribal-defaults">Tribal defaults</button>
        <button type="button" class="troop-quick-btn" data-preset="clear-all">Clear all</button>
      </div>
      ${renderGroup("infantry", "Infantry", "Barracks / Great Barracks", catalog.infantry)}
      ${renderGroup("cavalry", "Cavalry", "Stable", catalog.cavalry)}
    </div>`;
}

function troopFormFieldsHtml(config, defaults) {
  const c = config || {};
  return `
    <div class="troop-settings-row">
      <label class="troop-field">
        <span>Tribe</span>
        <select name="tribe">
          <option value="auto"${c.tribe === "auto" ? " selected" : ""}>Auto (detect in village)</option>
          <option value="teuton"${c.tribe === "teuton" ? " selected" : ""}>Teuton</option>
          <option value="roman"${c.tribe === "roman" ? " selected" : ""}>Roman</option>
          <option value="gaul"${c.tribe === "gaul" ? " selected" : ""}>Gaul</option>
        </select>
      </label>
      <label class="troop-field">
        <span>Default batch</span>
        <div class="batch-row">
          <button type="button" class="mini-btn troop-batch-minus" data-delta="-5">−5</button>
          <input name="batchSize" type="number" min="1" max="999999" step="1" value="${escapeHtml(String(c.batchSize || 5))}" />
          <button type="button" class="mini-btn troop-batch-plus" data-delta="5">+5</button>
        </div>
      </label>
    </div>
    ${troopToggleMatrixHtml(c, defaults)}
    <div class="troop-actions">
      <button type="submit" class="primary-btn">Save troop settings</button>
    </div>`;
}

function findTroopQtyInput(form, branch, troop) {
  const troopKey = String(troop).trim();
  return (
    Array.from(form.querySelectorAll(".troop-unit-qty")).find(
      (el) => el.dataset.branch === branch && el.dataset.troop === troopKey
    ) || null
  );
}

function readToggleStateFromForm(form) {
  const state = {};
  const defaultBatch = Math.max(1, Number(form.querySelector('[name="batchSize"]')?.value) || 5);
  for (const branch of TROOP_BRANCHES) {
    state[branch] = new Map();
  }
  form.querySelectorAll(".troop-unit-toggle:checked").forEach((input) => {
    const branch = input.dataset.branch;
    const troop = input.dataset.troop;
    if (!branch || !troop || !state[branch]) {
      return;
    }
    const qtyEl = findTroopQtyInput(form, branch, troop);
    let qty = defaultBatch;
    if (qtyEl && qtyEl.value !== "") {
      qty = Math.max(1, Math.min(999999, Number(qtyEl.value) || defaultBatch));
    }
    state[branch].set(String(troop).trim().toLowerCase(), qty);
  });
  return state;
}

function listsMatchDefaults(state, tribe, defaults, defaultBatch) {
  const resolved = resolvePreviewTribe(tribe);
  for (const branch of TROOP_BRANCHES) {
    const def = getDefaultBranchTroopSet(defaults, resolved, branch);
    const selected = state[branch];
    if (def.size !== selected.size) {
      return false;
    }
    for (const name of def) {
      if (!selected.has(name)) {
        return false;
      }
      if (Number(selected.get(name)) !== Number(defaultBatch)) {
        return false;
      }
    }
  }
  return true;
}

function serializeBranchEntries(state, branch, tribe, defaultBatch) {
  const resolved = resolvePreviewTribe(tribe);
  const catalog = TROOP_CATALOG[resolved];
  const branchUnits = catalog[branch] || [];
  const parts = [];
  branchUnits.forEach((unit) => {
    const key = String(unit).trim().toLowerCase();
    if (!state[branch].has(key)) {
      return;
    }
    const qty = Number(state[branch].get(key)) || defaultBatch;
    if (qty !== Number(defaultBatch)) {
      parts.push(`${unit}:${qty}`);
    } else {
      parts.push(unit);
    }
  });
  return parts.join(", ");
}

function toggleStateToLists(state, tribe, defaults, defaultBatch) {
  const infantry = serializeBranchEntries(state, "infantry", tribe, defaultBatch);
  const cavalry = serializeBranchEntries(state, "cavalry", tribe, defaultBatch);
  if (listsMatchDefaults(state, tribe, defaults, defaultBatch)) {
    return {
      infantryOffensive: "",
      infantryDefensive: "",
      cavalryOffensive: "",
      cavalryDefensive: ""
    };
  }
  return {
    infantryOffensive: infantry,
    infantryDefensive: infantry,
    cavalryOffensive: cavalry,
    cavalryDefensive: cavalry
  };
}

function readTroopFormPayload(form, defaults) {
  const get = (name) => {
    const el = form.querySelector(`[name="${name}"]`);
    return el ? el.value : "";
  };
  const defaultBatch = Math.max(1, Number(get("batchSize")) || 5);
  const lists = toggleStateToLists(readToggleStateFromForm(form), get("tribe"), defaults, defaultBatch);
  return {
    tribe: get("tribe"),
    batchSize: defaultBatch,
    ...lists
  };
}

function applyTroopPreset(form, preset, defaults) {
  const tribe = form.querySelector('[name="tribe"]').value;
  const resolved = resolvePreviewTribe(tribe);
  const defs = defaults || latestTroopData?.defaults || null;
  const defaultBatch = Math.max(1, Number(form.querySelector('[name="batchSize"]')?.value) || 5);
  form.querySelectorAll(".troop-unit-toggle").forEach((input) => {
    const branch = input.dataset.branch;
    const troop = input.dataset.troop;
    const qtyEl = findTroopQtyInput(form, branch, troop);
    if (preset === "clear-all") {
      input.checked = false;
      if (qtyEl) {
        qtyEl.disabled = true;
      }
      return;
    }
    if (preset === "tribal-defaults") {
      const defSet = getDefaultBranchTroopSet(defs, resolved, branch);
      const enabled = defSet.has(String(troop || "").trim().toLowerCase());
      input.checked = enabled;
      if (qtyEl) {
        qtyEl.disabled = !enabled;
        qtyEl.value = String(defaultBatch);
      }
    }
  });
}

function syncTroopQtyInput(toggle, form) {
  const branch = toggle.dataset.branch;
  const troop = toggle.dataset.troop;
  const qtyEl = findTroopQtyInput(form, branch, troop);
  if (!qtyEl) {
    return;
  }
  const defaultBatch = Math.max(1, Number(form.querySelector('[name="batchSize"]')?.value) || 5);
  qtyEl.disabled = !toggle.checked;
  if (toggle.checked && (!qtyEl.value || Number(qtyEl.value) < 1)) {
    qtyEl.value = String(defaultBatch);
  }
}

function refreshTroopMatrix(form, config, defaults, onDirty) {
  const tribe = form.querySelector('[name="tribe"]').value;
  const defaultBatch = Math.max(1, Number(form.querySelector('[name="batchSize"]')?.value) || 5);
  const currentState = readToggleStateFromForm(form);
  const merged = {
    ...(config || {}),
    tribe,
    batchSize: defaultBatch,
    lists: toggleStateToLists(currentState, tribe, defaults, defaultBatch)
  };
  const wrap = form.querySelector(".troop-matrix-wrap");
  if (wrap) {
    wrap.outerHTML = troopToggleMatrixHtml(merged, defaults);
    bindTroopMatrix(form, defaults, onDirty);
  }
}

function bindTroopMatrix(form, defaults, onDirty) {
  form.querySelectorAll(".troop-quick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTroopPreset(form, btn.dataset.preset, defaults);
      onDirty();
    });
  });
  form.querySelectorAll(".troop-unit-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      syncTroopQtyInput(toggle, form);
      onDirty();
    });
  });
}

function bindTroopForm(form, { onDirty, onSubmit, config, defaults }) {
  if (form.dataset.bound === "1") {
    return;
  }
  form.dataset.bound = "1";
  form.addEventListener("submit", onSubmit);
  form.addEventListener("input", onDirty);
  form.addEventListener("change", (event) => {
    if (event.target && event.target.name === "tribe") {
      refreshTroopMatrix(form, config, defaults, onDirty);
    }
    onDirty();
  });
  form.addEventListener("pointerdown", markTroopInteraction);
  form.querySelectorAll(".troop-batch-minus, .troop-batch-plus").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = form.querySelector('[name="batchSize"]');
      const delta = Number(btn.dataset.delta) || 0;
      const current = Number(input.value) || 5;
      const next = Math.max(1, Math.min(999999, current + delta));
      input.value = String(next);
      onDirty();
    });
  });
  bindTroopMatrix(form, defaults, onDirty);
}

function renderTroopLoopStatus(loop) {
  renderTroopLoopPanel(loop);
}

async function saveTroopRrForm(event) {
  event.preventDefault();
  try {
    const payload = {
      troopLoopEnabled: Boolean(els.troopRrEnabled && els.troopRrEnabled.checked),
      troopLoopMinMinutes: Number(els.troopRrMin && els.troopRrMin.value),
      troopLoopMaxMinutes: Number(els.troopRrMax && els.troopRrMax.value)
    };
    const data = await api("/api/troop-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    troopRrFormDirty = false;
    renderTroopDashboard(data.troop || null, { force: false });
    showToast("Troop RR schedule saved");
  } catch (error) {
    showToast(error.message || "Save failed");
  }
}

function setupTroopRrForm() {
  if (!els.troopRrForm) {
    return;
  }
  els.troopRrForm.addEventListener("submit", saveTroopRrForm);
  els.troopRrForm.addEventListener("input", () => {
    troopRrFormDirty = true;
  });
  els.troopRrForm.addEventListener("change", () => {
    troopRrFormDirty = true;
  });
  startTroopLoopCountdownTicker();
}

function renderGlobalTroopForm(globalDefaults, defaults) {
  if (!els.troopGlobalForm || !globalDefaults) {
    return;
  }
  els.troopGlobalForm.innerHTML = troopFormFieldsHtml(globalDefaults, defaults);
  els.troopGlobalForm.dataset.bound = "";
  bindTroopForm(els.troopGlobalForm, {
    config: globalDefaults,
    defaults,
    onDirty: () => {
      markTroopInteraction();
      troopDirtyGlobal = true;
    },
    onSubmit: saveGlobalTroopForm
  });
}

function renderVillageTroopCards(data, openIds) {
  if (!els.troopVillagesList || !els.troopVillagesEmpty) {
    return;
  }
  const villages = (data && data.villages) || [];
  const defaults = data?.defaults || null;
  const openSet = openIds || captureOpenVillageCards();
  els.troopVillagesEmpty.classList.toggle("hidden", villages.length > 0);
  els.troopVillagesList.innerHTML = "";

  villages.forEach((v) => {
    const card = document.createElement("details");
    const classes = ["troop-village-card"];
    if (v.hasCustom) {
      classes.push("has-custom");
    }
    if (Number(v.villageId) === Number(data.selectedVillageId)) {
      classes.push("is-selected");
    }
    if (v.isCapital) {
      classes.push("is-capital");
    }
    if (v.roundRobinEnabled) {
      classes.push("auto-repeat-on");
    }
    card.className = classes.join(" ");
    card.dataset.villageId = String(v.villageId);
    if (
      openSet.has(String(v.villageId)) ||
      villages.length <= 2 ||
      Number(v.villageId) === Number(data.selectedVillageId)
    ) {
      card.open = true;
    }

    const coords = v.coordsText || (v.x != null && v.y != null ? `(${v.x}|${v.y})` : "");

    card.innerHTML = `
      <summary>
        <div class="troop-village-summary-main">
          <div>
            <div class="troop-village-title">${escapeHtml(v.name || "Village")} ${escapeHtml(coords)}</div>
            <div class="troop-village-meta">vid ${escapeHtml(String(v.villageId))}</div>
            <div class="troop-village-badges">${villageBadgesHtml(v)}</div>
          </div>
        </div>
        <div class="troop-village-actions-top">
          <button type="button" class="ghost-btn troop-train-btn">Train now</button>
          <button type="button" class="ghost-btn troop-reset-btn"${v.hasCustom ? "" : " disabled"}>Reset</button>
        </div>
      </summary>
      <div class="troop-village-auto-panel">
        <div class="troop-village-auto-head">
          <span class="troop-village-auto-title">Auto repeat</span>
          <label class="troop-switch" title="Train this village on its own timer">
            <input type="checkbox" class="troop-village-rr-cb"${v.roundRobinEnabled ? " checked" : ""} />
            <span class="troop-switch-slider" aria-hidden="true"></span>
            <span class="troop-switch-label">${v.roundRobinEnabled ? "On" : "Off"}</span>
          </label>
        </div>
        <div class="troop-village-schedule${v.roundRobinEnabled ? "" : " hidden"}">
          <div class="troop-village-interval">
            <label class="troop-field troop-field-compact">
              <span>Min (min)</span>
              <input type="number" class="troop-village-min" min="1" max="9999" step="1" value="${escapeHtml(String(v.loopMinMinutes ?? 5))}" />
            </label>
            <label class="troop-field troop-field-compact">
              <span>Max (min)</span>
              <input type="number" class="troop-village-max" min="1" max="9999" step="1" value="${escapeHtml(String(v.loopMaxMinutes ?? 10))}" />
            </label>
          </div>
          <div class="troop-village-next-row">
            <span class="troop-village-next-label">Next train</span>
            <span class="troop-village-next-value" data-village-id="${escapeHtml(String(v.villageId))}">—</span>
          </div>
        </div>
      </div>
      <form class="troop-form troop-village-form">${troopFormFieldsHtml(v.config, defaults)}</form>`;

    const stopSummaryToggle = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const rrToggle = card.querySelector(".troop-village-rr-cb");
    const rrSwitchText = card.querySelector(".troop-switch-label");
    const scheduleBlock = card.querySelector(".troop-village-schedule");
    const minInput = card.querySelector(".troop-village-min");
    const maxInput = card.querySelector(".troop-village-max");

    const updateAutoRepeatUi = (enabled) => {
      if (scheduleBlock) {
        scheduleBlock.classList.toggle("hidden", !enabled);
      }
      if (rrSwitchText) {
        rrSwitchText.textContent = enabled ? "On" : "Off";
      }
      card.classList.toggle("auto-repeat-on", enabled);
    };

    const queueVillageLoopSave = () => {
      const vid = String(v.villageId);
      troopDirtyVillageTimers.add(vid);
      markTroopInteraction();
      if (villageLoopSaveTimers.has(vid)) {
        clearTimeout(villageLoopSaveTimers.get(vid));
      }
      villageLoopSaveTimers.set(
        vid,
        setTimeout(() => {
          villageLoopSaveTimers.delete(vid);
          saveVillageAutoRepeatSettings(v, {
            enabled: Boolean(rrToggle && rrToggle.checked),
            loopMinMinutes: Number(minInput && minInput.value),
            loopMaxMinutes: Number(maxInput && maxInput.value)
          });
        }, 600)
      );
    };

    if (rrToggle) {
      rrToggle.addEventListener("change", () => {
        const enabled = Boolean(rrToggle.checked);
        updateAutoRepeatUi(enabled);
        saveVillageAutoRepeatSettings(v, {
          enabled,
          loopMinMinutes: Number(minInput && minInput.value),
          loopMaxMinutes: Number(maxInput && maxInput.value)
        });
      });
    }
    [minInput, maxInput].forEach((input) => {
      if (!input) {
        return;
      }
      input.addEventListener("change", () => {
        queueVillageLoopSave();
      });
    });

    const form = card.querySelector(".troop-village-form");
    bindTroopForm(form, {
      config: v.config,
      defaults,
      onDirty: () => {
        markTroopInteraction();
        troopDirtyVillages.add(String(v.villageId));
      },
      onSubmit: (event) => saveVillageTroopForm(event, v)
    });

    card.querySelector(".troop-train-btn").addEventListener("mousedown", stopSummaryToggle);
    card.querySelector(".troop-train-btn").addEventListener("click", (event) => {
      stopSummaryToggle(event);
      trainVillageNow(v);
    });
    const resetBtn = card.querySelector(".troop-reset-btn");
    if (v.hasCustom) {
      resetBtn.addEventListener("mousedown", stopSummaryToggle);
      resetBtn.addEventListener("click", (event) => {
        stopSummaryToggle(event);
        resetVillageTroopForm(v);
      });
    }

    card.addEventListener("toggle", () => {
      if (card.open) {
        markTroopInteraction();
      }
    });

    els.troopVillagesList.appendChild(card);
  });
}

function renderTroopDashboard(data, options = {}) {
  const force = Boolean(options && options.force);
  const preserveOpen = Boolean(options && options.preserveOpen);
  latestTroopData = data;
  if (!els.troopGlobalForm) {
    return;
  }
  if (data && data.terminalOnly) {
    renderTroopLoopPanel(data.troopLoop || null);
    els.troopGlobalForm.innerHTML =
      '<p class="troop-terminal-note">Troop plans are managed from the terminal (menu <strong>T</strong>). ' +
      "Create plans, set timers and infantry/cavalry units, and assign each village there.</p>";
    if (els.troopVillagesList) {
      const villages = Array.isArray(data.villages) ? data.villages : [];
      els.troopVillagesList.innerHTML = villages
        .map((v) => {
          const state = v.enabled ? "ON" : "off";
          const plan = v.plan || "—";
          const summary = v.planSummary || "no plan";
          return (
            '<div class="troop-village-readonly">' +
            `<strong>${escapeHtml(v.name || String(v.villageId))}</strong> — ` +
            `<span>${escapeHtml(state)}</span> · plan: ${escapeHtml(plan)} ` +
            `<span class="muted">(${escapeHtml(summary)})</span>` +
            "</div>"
          );
        })
        .join("");
      els.troopVillagesEmpty.classList.toggle("hidden", villages.length > 0);
      if (!villages.length) {
        els.troopVillagesEmpty.textContent = "No villages loaded yet.";
      }
    }
    troopRenderedMountKey = "";
    return;
  }
  if (!data) {
    if (els.troopRrPanel) {
      renderTroopLoopPanel(null);
    }
    els.troopVillagesList.innerHTML = "";
    els.troopVillagesEmpty.classList.remove("hidden");
    els.troopVillagesEmpty.textContent = "Troop settings unavailable (bot not ready).";
    troopRenderedMountKey = "";
    return;
  }

  const defaults = data.defaults || null;
  renderTroopLoopPanel(data.troopLoop || (data.globalDefaults && data.globalDefaults.troopLoop));

  const globalMounted = Boolean(els.troopGlobalForm.querySelector(".troop-settings-row"));
  if (!troopDirtyGlobal && data.globalDefaults && (force || !globalMounted)) {
    renderGlobalTroopForm(data.globalDefaults, defaults);
  }

  const mountKey = buildTroopMountKey(data);
  const openIds = preserveOpen ? captureOpenVillageCards() : null;
  if (force || mountKey !== troopRenderedMountKey || !els.troopVillagesList.childElementCount) {
    renderVillageTroopCards(data, openIds);
    troopRenderedMountKey = mountKey;
  } else {
    syncVillageCardChrome(data);
  }
  syncVillageLoopCountdowns(data.villages);
}

async function refreshTroopForm() {
  try {
    const data = await api("/api/troop-templates");
    troopDirtyGlobal = false;
    troopDirtyVillages.clear();
    troopDirtyVillageTimers.clear();
    troopDirtyVillageRr.clear();
    troopInteractionUntil = 0;
    troopRenderedMountKey = "";
    renderTroopDashboard(data.troop || null, { force: true });
  } catch (error) {
    if (els.troopRrStatusText) {
      els.troopRrStatusText.textContent = error.message || "Could not load troop settings.";
    }
  }
}

async function saveGlobalTroopForm(event) {
  event.preventDefault();
  try {
    const defaults = latestTroopData?.defaults || null;
    const payload = readTroopFormPayload(event.currentTarget, defaults);
    const data = await api("/api/troop-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    troopDirtyGlobal = false;
    troopInteractionUntil = 0;
    renderTroopDashboard(data.troop || null, { force: true });
    showToast("Global troop settings saved");
  } catch (error) {
    showToast(error.message || "Save failed");
  }
}

async function saveVillageAutoRepeatSettings(village, { enabled, loopMinMinutes, loopMaxMinutes }) {
  const vid = String(village.villageId);
  troopDirtyVillageRr.add(vid);
  markTroopInteraction();
  try {
    const payload = {
      villageId: village.villageId,
      x: village.x,
      y: village.y,
      name: village.name,
      roundRobinEnabled: Boolean(enabled)
    };
    if (Number.isFinite(loopMinMinutes)) {
      payload.loopMinMinutes = loopMinMinutes;
    }
    if (Number.isFinite(loopMaxMinutes)) {
      payload.loopMaxMinutes = loopMaxMinutes;
    }
    const data = await api("/api/troop-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    troopDirtyVillageRr.delete(vid);
    troopDirtyVillageTimers.delete(vid);
    latestTroopData = data.troop || null;
    renderTroopLoopPanel(data.troop?.troopLoop || (data.troop?.globalDefaults && data.troop.globalDefaults.troopLoop));
    syncVillageLoopCountdowns(data.troop?.villages || []);
    if (data.troop) {
      syncVillageCardChrome(data.troop);
    }
    showToast(`${village.name || village.villageId}: auto repeat ${enabled ? "on" : "off"}`);
  } catch (error) {
    troopDirtyVillageRr.delete(vid);
    const card = els.troopVillagesList?.querySelector(`[data-village-id="${vid}"]`);
    const saved = latestTroopData?.villages?.find((item) => String(item.villageId) === vid);
    if (card && saved) {
      syncVillageAutoRepeatChrome(card, saved);
    }
    showToast(error.message || "Could not update auto repeat");
  }
}

async function saveVillageTroopForm(event, village) {
  event.preventDefault();
  try {
    const defaults = latestTroopData?.defaults || null;
    const payload = {
      ...readTroopFormPayload(event.currentTarget, defaults),
      villageId: village.villageId,
      x: village.x,
      y: village.y,
      name: village.name
    };
    const data = await api("/api/troop-templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    troopDirtyVillages.delete(String(village.villageId));
    troopInteractionUntil = 0;
    renderTroopDashboard(data.troop || null, { force: true, preserveOpen: true });
    showToast(`Saved ${village.name || village.villageId}`);
  } catch (error) {
    showToast(error.message || "Save failed");
  }
}

async function resetVillageTroopForm(village) {
  try {
    const data = await api("/api/troop-templates", {
      method: "POST",
      body: JSON.stringify({
        villageId: village.villageId,
        x: village.x,
        y: village.y,
        name: village.name,
        resetToGlobal: true
      })
    });
    troopDirtyVillages.delete(String(village.villageId));
    troopInteractionUntil = 0;
    renderTroopDashboard(data.troop || null, { force: true, preserveOpen: true });
    showToast(`Reset ${village.name || village.villageId} to global`);
  } catch (error) {
    showToast(error.message || "Reset failed");
  }
}

async function trainVillageNow(village) {
  try {
    await selectVillage(village.villageId);
    await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "troops" })
    });
    showToast(`Queued trainer for ${village.name || village.villageId}`);
  } catch (error) {
    showToast(error.message || "Train failed");
  }
}

let activityFormDirty = false;
let activityCountdownEnd = null;

function renderActivityPatternCheckboxes(config) {
  if (!els.activityPatterns) {
    return;
  }
  const selected = new Set((config && config.patterns) || []);
  const available =
    (config && config.availablePatterns) ||
    [
      { id: "status", label: "Village overview" },
      { id: "builder", label: "Village map" },
      { id: "troops", label: "Barracks" },
      { id: "stable", label: "Stable" },
      { id: "reports", label: "Reports" },
      { id: "statistics", label: "Statistics" }
    ];
  els.activityPatterns.innerHTML = available
    .map(
      (item) => `
    <label class="activity-pattern-item">
      <input type="checkbox" name="pattern" value="${escapeHtml(item.id)}"${selected.has(item.id) ? " checked" : ""} />
      <span>${escapeHtml(item.label || item.id)}</span>
    </label>`
    )
    .join("");
}

function syncActivityCountdown(config) {
  if (config && config.enabled && config.nextInMinutes != null) {
    activityCountdownEnd = Date.now() + config.nextInMinutes * 60000;
  } else {
    activityCountdownEnd = null;
  }
  updateActivityCountdownDisplay();
}

function updateActivityCountdownDisplay() {
  if (!els.activityNext) {
    return;
  }
  if (activityCountdownEnd == null) {
    return;
  }
  const ms = activityCountdownEnd - Date.now();
  els.activityNext.textContent = ms <= 0 ? "Due now" : formatTroopLoopCountdown(ms);
}

function renderActivityLastAction(lastAction) {
  if (!els.activityLast) {
    return;
  }
  if (!lastAction) {
    els.activityLast.classList.add("hidden");
    els.activityLast.textContent = "";
    return;
  }
  const when = lastAction.at ? new Date(lastAction.at).toLocaleTimeString(undefined, { hour12: false }) : "—";
  const village = lastAction.villageName
    ? `${lastAction.villageName}${lastAction.villageId ? ` (vid ${lastAction.villageId})` : ""}`
    : "account-wide";
  els.activityLast.classList.remove("hidden");
  const countPart =
    lastAction.completedCount != null ? ` · #${lastAction.completedCount} total` : "";
  els.activityLast.textContent = `Last browse (${when}): ${lastAction.patternLabel || lastAction.pattern} @ ${village}${countPart}`;
}

function renderActivitySettingsPanel(config) {
  if (!els.activityForm) {
    return;
  }
  if (!config) {
    if (els.activityPill) {
      els.activityPill.textContent = "OFF";
      els.activityPill.className = "pill pill-paused";
    }
    if (els.activityStatusText) {
      els.activityStatusText.textContent = "Unavailable";
    }
    return;
  }

  const enabled = Boolean(config.enabled);
  const min = config.minMinutes != null ? config.minMinutes : "—";
  const max = config.maxMinutes != null ? config.maxMinutes : "—";

  if (els.activityPill) {
    els.activityPill.textContent = enabled ? "ON" : "OFF";
    els.activityPill.className = `pill ${enabled ? "pill-running" : "pill-paused"}`;
  }
  if (els.activityStatusText) {
    const doneCount =
      config.completedCount != null && config.completedCount > 0
        ? ` · ${config.completedCount} completed this session`
        : "";
    els.activityStatusText.textContent = enabled
      ? `Random browsing enabled — no game actions${doneCount}`
      : (config.completedCount || 0) > 0
        ? `Off · ${config.completedCount} event(s) completed this session`
        : "Off — enable below to simulate activity";
  }
  if (els.activityInterval) {
    els.activityInterval.textContent =
      min !== "—" && max !== "—" ? `Every ${min}–${max} minutes` : "—";
  }
  if (els.activityCompleted) {
    els.activityCompleted.textContent = String(config.completedCount != null ? config.completedCount : 0);
  }

  if (enabled) {
    syncActivityCountdown(config);
    if (config.nextInMinutes == null && els.activityNext) {
      els.activityNext.textContent = "Scheduling…";
      activityCountdownEnd = null;
    }
  } else if (els.activityNext) {
    els.activityNext.textContent = "—";
    activityCountdownEnd = null;
  }

  renderActivityLastAction(config.lastAction);

  if (!activityFormDirty) {
    if (els.activityEnabled) {
      els.activityEnabled.checked = enabled;
    }
    if (els.activityMin && min !== "—") {
      els.activityMin.value = String(min);
    }
    if (els.activityMax && max !== "—") {
      els.activityMax.value = String(max);
    }
    renderActivityPatternCheckboxes(config);
  }
}

function readActivityFormPayload() {
  const patterns = [];
  if (els.activityPatterns) {
    els.activityPatterns.querySelectorAll('input[name="pattern"]:checked').forEach((input) => {
      if (input.value) {
        patterns.push(input.value);
      }
    });
  }
  return {
    enabled: Boolean(els.activityEnabled && els.activityEnabled.checked),
    minMinutes: Number(els.activityMin && els.activityMin.value),
    maxMinutes: Number(els.activityMax && els.activityMax.value),
    patterns
  };
}

async function saveActivitySettingsForm(event) {
  event.preventDefault();
  try {
    const payload = readActivityFormPayload();
    if (!payload.patterns.length) {
      showToast("Select at least one browse pattern");
      return;
    }
    const data = await api("/api/activity-settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    activityFormDirty = false;
    renderActivitySettingsPanel(data.activitySimulation || null);
    if (latestStatus) {
      latestStatus.activitySimulation = data.activitySimulation || latestStatus.activitySimulation;
      if (latestStatus.loops) {
        latestStatus.loops.activity = {
          enabled: payload.enabled,
          minMinutes: payload.minMinutes,
          maxMinutes: payload.maxMinutes,
          nextInMinutes: data.activitySimulation && data.activitySimulation.nextInMinutes
        };
      }
    }
    showToast("Activity settings saved");
  } catch (error) {
    showToast(error.message || "Save failed");
  }
}

function setupActivityForm() {
  if (!els.activityForm) {
    return;
  }
  els.activityForm.addEventListener("submit", saveActivitySettingsForm);
  els.activityForm.addEventListener("input", () => {
    activityFormDirty = true;
  });
  els.activityForm.addEventListener("change", () => {
    activityFormDirty = true;
  });
}

let proxyFormDirty = false;

function proxyEntryToLine(entry) {
  if (!entry || !entry.server) {
    return "";
  }
  if (entry.username) {
    return `${entry.username}:${entry.hasPassword ? "****" : ""}@${entry.server.replace(/^https?:\/\//, "")}`;
  }
  return entry.server;
}

function renderProxySettingsPanel(proxy) {
  if (!proxy || proxyFormDirty) {
    return;
  }
  const active = proxy.activeDisplay || "direct (none)";
  const count = Number(proxy.count) || 0;
  if (els.proxyActiveText) {
    els.proxyActiveText.textContent = active;
  }
  if (els.proxyCount) {
    els.proxyCount.textContent = String(count);
  }
  if (els.proxyPill) {
    const usingProxy = count > 0 && proxy.active;
    els.proxyPill.textContent = usingProxy ? "ON" : "DIRECT";
    els.proxyPill.className = `pill ${usingProxy ? "pill-running" : "pill-paused"}`;
  }
  if (els.proxyBypass && proxy.bypass !== undefined) {
    els.proxyBypass.value = proxy.bypass || "";
  }
  if (els.proxyActiveIndex && proxy.active && proxy.active.index != null) {
    els.proxyActiveIndex.value = String(Number(proxy.active.index) + 1);
    els.proxyActiveIndex.max = String(Math.max(1, count));
  } else if (els.proxyActiveIndex) {
    els.proxyActiveIndex.value = count ? "1" : "";
  }
  if (els.proxyListPreview) {
    const rows = Array.isArray(proxy.proxies) ? proxy.proxies : [];
    els.proxyListPreview.innerHTML = rows.length
      ? rows
          .map(
            (entry) => `
        <div class="proxy-list-item${entry.active ? " active" : ""}">
          #${entry.index + 1} ${escapeHtml(entry.server)}${entry.username ? ` (${escapeHtml(entry.username)})` : ""}${entry.active ? " · active" : ""}
        </div>`
          )
          .join("")
      : `<div class="hint">No proxies saved yet.</div>`;
  }
}

async function refreshProxySettingsPanel() {
  if (!els.proxyForm) {
    return;
  }
  try {
    const data = await api("/api/proxy-settings");
    renderProxySettingsPanel(data.proxy || null);
  } catch (_error) {
    if (latestStatus && latestStatus.proxy) {
      renderProxySettingsPanel(latestStatus.proxy);
    }
  }
}

function readProxyFormPayload(action) {
  const activeIndexRaw = els.proxyActiveIndex ? Number(els.proxyActiveIndex.value) : NaN;
  return {
    action,
    proxyText: els.proxyText ? els.proxyText.value : "",
    bypass: els.proxyBypass ? els.proxyBypass.value : "",
    activeIndex: Number.isFinite(activeIndexRaw) && activeIndexRaw > 0 ? activeIndexRaw - 1 : undefined
  };
}

async function submitProxySettings(action, event) {
  if (event) {
    event.preventDefault();
  }
  try {
    const payload = readProxyFormPayload(action);
    const data = await api("/api/proxy-settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    proxyFormDirty = false;
    renderProxySettingsPanel(data.proxy || null);
    if (latestStatus) {
      latestStatus.proxy = data.proxy || latestStatus.proxy;
      renderAccountStrip(latestStatus.account, latestStatus.proxy);
    }
    const messages = {
      save: "Proxy list saved",
      apply: "Proxy applied — relogin started",
      next: "Next proxy applied — relogin started",
      disable: "Proxy disabled — relogin direct"
    };
    showToast(messages[action] || "Proxy updated");
  } catch (error) {
    showToast(error.message || "Proxy update failed");
  }
}

function setupProxyForm() {
  if (!els.proxyForm) {
    return;
  }
  els.proxyForm.addEventListener("submit", (event) => submitProxySettings("apply", event));
  if (els.proxySaveBtn) {
    els.proxySaveBtn.addEventListener("click", () => submitProxySettings("save"));
  }
  if (els.proxyNextBtn) {
    els.proxyNextBtn.addEventListener("click", () => submitProxySettings("next"));
  }
  if (els.proxyDisableBtn) {
    els.proxyDisableBtn.addEventListener("click", () => submitProxySettings("disable"));
  }
  ["input", "change"].forEach((type) => {
    els.proxyForm.addEventListener(type, () => {
      proxyFormDirty = true;
    });
  });
}

function setupTroopForm() {
  if (!els.troopGlobalForm) {
    return;
  }
  const troopPanel = document.querySelector(".troop-panel");
  if (troopPanel) {
    troopPanel.addEventListener("pointerdown", markTroopInteraction);
  }
  setupTroopRrForm();
  renderGlobalTroopForm(
    {
      mode: "offensive",
      tribe: "auto",
      batchSize: 5,
      lists: {},
      effective: {}
    },
    null
  );
}

function getDisplayView() {
  try {
    return localStorage.getItem(DISPLAY_VIEW_KEY) === "compact" ? "compact" : "regular";
  } catch (_) {
    return "regular";
  }
}

function updateTabLabels(compact) {
  document.querySelectorAll(".tab-btn[data-label-short]").forEach((btn) => {
    const full = btn.getAttribute("data-label-full") || btn.textContent.trim();
    btn.textContent = compact ? btn.getAttribute("data-label-short") || full : full;
  });
}

function setCompactDom(compact) {
  document.documentElement.classList.toggle("compact-view", compact);
  document.body.classList.toggle("compact-view", compact);
  document.documentElement.dataset.display = compact ? "compact" : "full";
  if (els.displayModeBadge) {
    els.displayModeBadge.classList.toggle("hidden", !compact);
  }
  if (els.villagePicker) {
    els.villagePicker.open = !compact;
  }
}

function applyDisplayView(view) {
  const compact = view === "compact";
  setCompactDom(compact);
  try {
    localStorage.setItem(DISPLAY_VIEW_KEY, compact ? "compact" : "regular");
  } catch (_) {}
  if (els.displayCompact) {
    els.displayCompact.checked = compact;
  }
  document.querySelectorAll(".display-mode-label").forEach((label) => {
    const mode = label.getAttribute("data-mode");
    label.classList.toggle("active", mode === (compact ? "compact" : "full"));
  });
  updateTabLabels(compact);
  lastVillageRenderKey = "";
  lastActionRenderKey = "";
  lastStatusGridKey = "";
  lastVillageContextKey = "";
  if (latestStatus) {
    renderStatusNow(latestStatus);
  } else {
    renderActions(false, true);
  }
}

let displayFormDirty = false;
let displaySaveTimer = null;

function renderDisplaySettingsPanel(display) {
  if (!display || display.compactView === undefined) {
    return;
  }
  if (displayFormDirty) {
    return;
  }
  applyDisplayView(display.compactView ? "compact" : "regular");
}

async function saveDisplaySettings(compact) {
  displayFormDirty = true;
  clearTimeout(displaySaveTimer);
  applyDisplayView(compact ? "compact" : "regular");
  try {
    await api("/api/display-settings", {
      method: "POST",
      body: JSON.stringify({ compactView: compact })
    });
  } catch (error) {
    showToast(error.message || "Could not save display setting");
  } finally {
    displaySaveTimer = setTimeout(() => {
      displayFormDirty = false;
    }, 1200);
  }
}

function setupDisplaySettings() {
  if (els.displayCompact) {
    els.displayCompact.addEventListener("change", () => {
      saveDisplaySettings(Boolean(els.displayCompact.checked));
    });
  }
}

// --- Top 10 tracking tab ---------------------------------------------------

let top10LoadedOnce = false;
let latestTop10Data = null;
let selectedTop10Category = "attackers";
let top10SnapshotBusy = false;

function formatTop10When(ts) {
  if (!ts) {
    return "—";
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return String(ts);
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatTop10Number(value, fallback = "—") {
  if (value == null || !Number.isFinite(Number(value))) {
    return fallback;
  }
  return Number(value).toLocaleString("en-US");
}

function formatTop10CompactSigned(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  const n = Number(value);
  const abs = Math.abs(n);
  let body;
  if (abs >= 1_000_000_000) {
    body = `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  } else if (abs >= 1_000_000) {
    body = `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  } else if (abs >= 10_000) {
    body = `${Math.round(n / 1000)}K`;
  } else if (abs >= 1000) {
    body = Math.round(n).toLocaleString("en-US");
  } else if (Number.isInteger(n) || abs >= 100) {
    body = String(Math.round(n));
  } else {
    body = String(Math.round(n * 100) / 100);
  }
  if (n > 0 && !body.startsWith("+")) {
    return `+${body}`;
  }
  return body;
}

function formatTop10Delta(delta, options = {}) {
  if (delta == null || !Number.isFinite(Number(delta))) {
    return { text: "—", className: "flat" };
  }
  const n = Number(delta);
  if (n === 0) {
    return { text: "0", className: "flat" };
  }
  const improved = Boolean(options.improved);
  const compact = formatTop10CompactSigned(n);
  return {
    text: compact || `${n > 0 ? "+" : ""}${Math.round(n)}`,
    className: improved ? "up" : "down"
  };
}

function formatTop10Rate(perHour, options = {}) {
  if (perHour == null || !Number.isFinite(Number(perHour))) {
    return { text: "—/h", className: "flat" };
  }
  const n = Number(perHour);
  if (n === 0) {
    return { text: "0/h", className: "flat" };
  }
  const improved =
    options.improved == null ? n > 0 : Boolean(options.improved);
  const compact = formatTop10CompactSigned(n);
  return {
    text: `${compact || `${n > 0 ? "+" : ""}${Math.round(n)}`}/h`,
    className: improved ? "up" : "down"
  };
}

function buildSparklineSvg(values, options = {}) {
  const width = options.width || 72;
  const height = options.height || 28;
  const invert = Boolean(options.invert);
  const stroke = options.stroke || "var(--cyan)";
  const points = (values || []).filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (points.length < 2) {
    return `<svg class="top10-spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  let min = Math.min(...points);
  let max = Math.max(...points);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const coords = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * (width - 2) + 1;
      const ratio = (value - min) / (max - min);
      const y = invert ? 1 + ratio * (height - 2) : height - 1 - ratio * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `
    <svg class="top10-spark" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${coords}"></polyline>
    </svg>`;
}

function buildTrendChartSvg(history, options = {}) {
  const width = options.width || 640;
  const height = options.height || 120;
  const useRank = Boolean(options.useRank);
  const points = (history || [])
    .map((point) => ({
      ts: point.epochMs || (point.ts ? Date.parse(point.ts) : null),
      value: useRank ? point.selfRank : point.selfValue
    }))
    .filter((point) => point.value != null && Number.isFinite(Number(point.value)));

  if (points.length < 2) {
    return `<div class="top10-empty">Not enough history yet — keep snapshots running.</div>`;
  }

  let min = Math.min(...points.map((p) => p.value));
  let max = Math.max(...points.map((p) => p.value));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padX = 8;
  const padY = 10;
  const coords = points
    .map((point, index) => {
      const x = padX + (index / (points.length - 1)) * (width - padX * 2);
      const ratio = (point.value - min) / (max - min);
      const y = useRank
        ? padY + ratio * (height - padY * 2)
        : height - padY - ratio * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  return `
    <svg class="top10-trend-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Trend chart">
      <polyline fill="none" stroke="rgba(61,214,245,0.9)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${coords}"></polyline>
    </svg>
    <div class="top10-trend-legend">
      <span>Start <strong>${escapeHtml(formatTop10Number(first.value))}</strong></span>
      <span>Now <strong>${escapeHtml(formatTop10Number(last.value))}</strong></span>
      <span>Samples <strong>${points.length}</strong></span>
    </div>`;
}

function getSelectedTop10Category(data) {
  const categories = (data && data.categories) || [];
  const found = categories.find((cat) => cat.id === selectedTop10Category);
  if (found) {
    return found;
  }
  return categories[0] || null;
}

function renderTop10LoopPanel(tracking) {
  if (!els.top10Pill) {
    return;
  }
  const enabled = Boolean(tracking && tracking.enabled);
  els.top10Pill.textContent = enabled ? "ON" : "OFF";
  els.top10Pill.classList.toggle("pill-running", enabled);
  els.top10Pill.classList.toggle("pill-paused", !enabled);

  if (els.top10StatusText) {
    els.top10StatusText.textContent = enabled ? "Tracking" : "Paused";
  }
  if (els.top10Interval) {
    const min = tracking && tracking.minMinutes;
    const max = tracking && tracking.maxMinutes;
    els.top10Interval.textContent =
      min != null && max != null ? `every ${min}-${max}m` : "—";
  }
  if (els.top10Next) {
    const next = tracking && tracking.nextInMinutes;
    els.top10Next.textContent =
      next == null ? "—" : next <= 0 ? "due now" : `${next}m`;
  }
  if (els.top10Completed) {
    const completed =
      (tracking && tracking.completedCount) ||
      (latestTop10Data && latestTop10Data.snapshotCount) ||
      0;
    els.top10Completed.textContent = String(completed);
  }
}

function renderTop10Standings(data) {
  if (!els.top10Standings) {
    return;
  }
  const standings = (data && data.standings) || [];
  if (!standings.length) {
    els.top10Standings.innerHTML =
      '<div class="top10-empty">No personal rankings yet. Run a snapshot to populate this board.</div>';
    return;
  }

  els.top10Standings.innerHTML = standings
    .map((item) => {
      const rankLabel =
        item.rank != null ? `#${item.rank}` : item.rankText || "?";
      const rankDelta = formatTop10Delta(item.rankDelta, { improved: item.rankImproved });
      const valueDelta = formatTop10Delta(item.valueDelta, { improved: item.valueImproved });
      const allRate = formatTop10Rate(item.valuePerHour, {
        improved: item.valuePerHourImproved
      });
      const lastRate = formatTop10Rate(item.lastValuePerHour, {
        improved: item.lastValueImproved
      });
      const spark = buildSparklineSvg(item.sparkline, {
        invert: false,
        stroke: item.inTop10 ? "var(--green)" : "var(--cyan)"
      });
      const pollsLabel =
        item.pollCount != null ? `${item.pollCount} polls` : "all polls";
      const spanLabel =
        item.windowHours != null ? `${item.windowHours}h` : "";
      return `
        <button type="button" class="top10-standing-card${item.inTop10 ? " is-top" : ""}" data-top10-cat="${escapeHtml(item.category)}">
          <div class="top10-standing-label">${escapeHtml(item.label)}</div>
          <div class="top10-standing-rank">${escapeHtml(rankLabel)}</div>
          <div class="top10-standing-value">${escapeHtml(item.valueText || formatTop10Number(item.value))} <span style="color:var(--muted);font-weight:500;font-size:0.75rem">${escapeHtml(item.metric)}</span></div>
          <div class="top10-standing-meta">
            <span class="top10-delta ${valueDelta.className}" title="Total change across all polled logs">${escapeHtml(valueDelta.text)}</span>
            <span class="top10-delta ${allRate.className}" title="All polls normalized per hour">${escapeHtml(allRate.text)}</span>
            ${spark}
          </div>
          <div class="top10-standing-rates">
            <span class="top10-delta ${rankDelta.className}">${escapeHtml(rankDelta.text)} rank</span>
            <span title="Last poll pace">last ${escapeHtml(lastRate.text)} · ${escapeHtml(pollsLabel)}${spanLabel ? ` · ${escapeHtml(spanLabel)}` : ""}</span>
          </div>
        </button>`;
    })
    .join("");

  els.top10Standings.querySelectorAll("[data-top10-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedTop10Category = btn.getAttribute("data-top10-cat") || selectedTop10Category;
      renderTop10CategoryViews(latestTop10Data);
    });
  });
}

function renderTop10CategoryTabs(data) {
  if (!els.top10CategoryTabs) {
    return;
  }
  const categories = (data && data.categories) || [];
  els.top10CategoryTabs.innerHTML = categories
    .map((cat) => {
      const active = cat.id === selectedTop10Category ? " active" : "";
      return `<button type="button" class="top10-cat-btn${active}" data-top10-cat="${escapeHtml(cat.id)}">${escapeHtml(cat.label)}</button>`;
    })
    .join("");
  els.top10CategoryTabs.querySelectorAll("[data-top10-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedTop10Category = btn.getAttribute("data-top10-cat") || selectedTop10Category;
      renderTop10CategoryViews(latestTop10Data);
    });
  });
}

function renderTop10Podium(category) {
  if (!els.top10Podium) {
    return;
  }
  const top = ((category && category.top10) || []).slice(0, 3);
  if (top.length < 3) {
    els.top10Podium.innerHTML = "";
    els.top10Podium.classList.add("hidden");
    return;
  }
  els.top10Podium.classList.remove("hidden");
  const medals = ["gold", "silver", "bronze"];
  els.top10Podium.innerHTML = top
    .map((row, index) => {
      const place = index + 1;
      return `
        <div class="top10-podium-card place-${place}">
          <div class="top10-podium-place">${place === 1 ? "1st" : place === 2 ? "2nd" : "3rd"}</div>
          <div class="top10-podium-name">${escapeHtml(row.name)}</div>
          <div class="top10-podium-value">${escapeHtml(row.valueText || formatTop10Number(row.value))}</div>
        </div>`;
    })
    .join("");
}

function renderTop10Board(category) {
  if (!els.top10Board) {
    return;
  }
  if (!category || !category.ok || !category.top10 || !category.top10.length) {
    els.top10Board.innerHTML =
      '<div class="top10-empty">No ranking rows for this category yet.</div>';
    return;
  }

  const selfName = category.self && category.self.name ? category.self.name.toLowerCase() : "";
  const window = category.deltas && category.deltas.window && category.deltas.window.value;
  const pollCountLabel =
    category.pollCount != null ? `${category.pollCount} polls` : "all polls";
  const windowHoursLabel =
    category.windowHours != null ? ` over ${category.windowHours}h` : "";
  const rowsHtml = category.top10
    .map((row) => {
      const isSelf =
        Boolean(selfName) && String(row.name || "").toLowerCase() === selfName;
      const rankClass =
        row.rank === 1 ? "gold" : row.rank === 2 ? "silver" : row.rank === 3 ? "bronze" : "";
      const delta = formatTop10Delta(row.valueDelta, {
        improved: row.valueDelta != null ? row.valueDelta > 0 : false
      });
      const rate = formatTop10Rate(row.valuePerHour, {
        improved: row.valuePerHour != null ? row.valuePerHour > 0 : false
      });
      const lastRate = formatTop10Rate(row.lastValuePerHour, {
        improved: row.lastValueDelta != null ? row.lastValueDelta > 0 : false
      });
      let rankMove = { text: "—", className: "flat" };
      if (row.rankDelta != null && Number.isFinite(Number(row.rankDelta))) {
        const move = Number(row.rankDelta);
        if (move === 0) {
          rankMove = { text: "0", className: "flat" };
        } else if (move < 0) {
          rankMove = { text: `↑${Math.abs(move)}`, className: "up" };
        } else {
          rankMove = { text: `↓${move}`, className: "down" };
        }
      }
      return `
        <tr class="${isSelf ? "is-self" : ""}">
          <td class="rank-cell ${rankClass}">${escapeHtml(row.rank != null ? `#${row.rank}` : row.rankText || "—")}</td>
          <td class="name-cell">${escapeHtml(row.name)}${isSelf ? " · you" : ""}</td>
          <td class="ally-cell">${escapeHtml(row.alliance || "—")}</td>
          <td class="value-cell">${escapeHtml(row.valueText || formatTop10Number(row.value))}</td>
          <td class="delta-cell"><span class="top10-delta ${delta.className}">${escapeHtml(delta.text)}</span></td>
          <td class="rate-cell"><span class="top10-delta ${rate.className}">${escapeHtml(rate.text)}</span></td>
          <td class="rate-cell"><span class="top10-delta ${lastRate.className}">${escapeHtml(lastRate.text)}</span></td>
          <td class="rank-move-cell"><span class="top10-delta ${rankMove.className}">${escapeHtml(rankMove.text)}</span></td>
        </tr>`;
    })
    .join("");

  let selfFooter = "";
  if (category.self && (category.self.rank == null || category.self.rank > 10)) {
    const selfDelta = formatTop10Delta(
      category.deltas && category.deltas.value,
      { improved: category.deltas && category.deltas.valueImproved }
    );
    const selfRate = formatTop10Rate(
      category.deltas && category.deltas.valuePerHour,
      { improved: category.deltas && category.deltas.valuePerHourImproved }
    );
    const selfLast = formatTop10Rate(
      category.deltas &&
        category.deltas.lastPoll &&
        category.deltas.lastPoll.value &&
        category.deltas.lastPoll.value.perHour,
      {
        improved:
          category.deltas &&
          category.deltas.lastPoll &&
          category.deltas.lastPoll.value &&
          category.deltas.lastPoll.value.delta != null
            ? category.deltas.lastPoll.value.delta > 0
            : false
      }
    );
    selfFooter = `
      <tr class="is-self">
        <td class="rank-cell">${escapeHtml(
          category.self.rank != null ? `#${category.self.rank}` : category.self.rankText || "?"
        )}</td>
        <td class="name-cell">${escapeHtml(category.self.name)} · you</td>
        <td class="ally-cell">${escapeHtml(category.self.alliance || "—")}</td>
        <td class="value-cell">${escapeHtml(
          category.self.valueText || formatTop10Number(category.self.value)
        )}</td>
        <td class="delta-cell"><span class="top10-delta ${selfDelta.className}">${escapeHtml(selfDelta.text)}</span></td>
        <td class="rate-cell"><span class="top10-delta ${selfRate.className}">${escapeHtml(selfRate.text)}</span></td>
        <td class="rate-cell"><span class="top10-delta ${selfLast.className}">${escapeHtml(selfLast.text)}</span></td>
        <td class="rank-move-cell">—</td>
      </tr>`;
  }

  const pollRange =
    window && window.fromTs
      ? ` (${escapeHtml(formatTop10When(window.fromTs))} → ${escapeHtml(formatTop10When(window.toTs))})`
      : "";
  els.top10Board.innerHTML = `
    <div class="top10-board-note">Δ and /h use all polled logs (${escapeHtml(pollCountLabel)}${escapeHtml(windowHoursLabel)})${pollRange}. Last /h is the newest interval only.</div>
    <table class="top10-table">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Name</th>
          <th>Alliance</th>
          <th>${escapeHtml(category.metric || "Value")}</th>
          <th>Δ all</th>
          <th>/h</th>
          <th>Last /h</th>
          <th>Rank Δ</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}${selfFooter}</tbody>
    </table>`;
}

function renderTop10Trend(category) {
  if (!els.top10Trend) {
    return;
  }
  if (!category) {
    els.top10Trend.innerHTML = '<div class="top10-empty">Select a category to see your trend.</div>';
    return;
  }
  const useRank = category.id === "climbers" || (category.self && category.self.value == null);
  const chart = buildTrendChartSvg(category.history || [], { useRank });
  const deltas = category.deltas || {};
  const last = useRank
    ? deltas.lastPoll && deltas.lastPoll.rank
    : deltas.lastPoll && deltas.lastPoll.value;
  const window = useRank
    ? deltas.window && deltas.window.rank
    : deltas.window && deltas.window.value;
  const pollSeries =
    (useRank
      ? deltas.polls && deltas.polls.rank
      : deltas.polls && deltas.polls.value) || [];
  const lastDelta = formatTop10Delta(last && last.delta, {
    improved: useRank
      ? last && last.delta != null && last.delta < 0
      : last && last.delta != null && last.delta > 0
  });
  const lastRate = formatTop10Rate(last && last.perHour, {
    improved: useRank
      ? last && last.perHour != null && last.perHour < 0
      : last && last.perHour != null && last.perHour > 0
  });
  const windowDelta = formatTop10Delta(window && window.delta, {
    improved: useRank
      ? window && window.delta != null && window.delta < 0
      : window && window.delta != null && window.delta > 0
  });
  const windowRate = formatTop10Rate(window && window.perHour, {
    improved: useRank
      ? window && window.perHour != null && window.perHour < 0
      : window && window.perHour != null && window.perHour > 0
  });
  const pollRows = pollSeries
    .map((item) => {
      const delta = formatTop10Delta(item.delta, {
        improved: useRank
          ? item.delta != null && item.delta < 0
          : item.delta != null && item.delta > 0
      });
      const rate = formatTop10Rate(item.perHour, {
        improved: useRank
          ? item.perHour != null && item.perHour < 0
          : item.perHour != null && item.perHour > 0
      });
      return `
        <tr>
          <td>${escapeHtml(formatTop10When(item.fromTs))} → ${escapeHtml(formatTop10When(item.toTs))}</td>
          <td>${escapeHtml(item.hours != null ? `${item.hours}h` : "—")}</td>
          <td><span class="top10-delta ${delta.className}">${escapeHtml(delta.text)}</span></td>
          <td><span class="top10-delta ${rate.className}">${escapeHtml(rate.text)}</span></td>
        </tr>`;
    })
    .join("");
  els.top10Trend.innerHTML = `
    <div class="top10-trend-head">
      <div class="top10-trend-title">${escapeHtml(category.label)} · your ${useRank ? "rank" : category.metric.toLowerCase()}</div>
      <div class="top10-trend-sub">Updated ${escapeHtml(formatTop10When(category.updatedAt))} · ${escapeHtml(
        String(category.pollCount || pollSeries.length + (pollSeries.length ? 1 : 0))
      )} polls</div>
    </div>
    <div class="top10-pace">
      <div class="top10-pace-item">
        <div class="top10-pace-label">All polls Δ</div>
        <div class="top10-pace-value"><span class="top10-delta ${windowDelta.className}">${escapeHtml(windowDelta.text)}</span></div>
      </div>
      <div class="top10-pace-item">
        <div class="top10-pace-label">All polls /h</div>
        <div class="top10-pace-value"><span class="top10-delta ${windowRate.className}">${escapeHtml(windowRate.text)}</span></div>
      </div>
      <div class="top10-pace-item">
        <div class="top10-pace-label">Last poll Δ</div>
        <div class="top10-pace-value"><span class="top10-delta ${lastDelta.className}">${escapeHtml(lastDelta.text)}</span></div>
      </div>
      <div class="top10-pace-item">
        <div class="top10-pace-label">Last poll /h</div>
        <div class="top10-pace-value"><span class="top10-delta ${lastRate.className}">${escapeHtml(lastRate.text)}</span></div>
      </div>
    </div>
    ${
      pollRows
        ? `<div class="top10-poll-series">
      <div class="top10-poll-series-title">Poll-by-poll deltas</div>
      <table class="top10-table top10-poll-table">
        <thead><tr><th>Interval</th><th>Span</th><th>Δ</th><th>/h</th></tr></thead>
        <tbody>${pollRows}</tbody>
      </table>
    </div>`
        : '<div class="top10-empty">Need at least two polls to build deltas.</div>'
    }
    ${chart}`;
}

function renderTop10CategoryViews(data) {
  renderTop10CategoryTabs(data);
  const category = getSelectedTop10Category(data);
  if (category) {
    selectedTop10Category = category.id;
  }
  renderTop10Podium(category);
  renderTop10Board(category);
  renderTop10Trend(category);
}

function renderTop10Dashboard(data) {
  latestTop10Data = data;
  if (!data) {
    return;
  }
  renderTop10LoopPanel(data.tracking || {});
  if (els.top10Updated) {
    els.top10Updated.textContent = formatTop10When(data.latestTs || (data.tracking && data.tracking.lastActionAt));
  }
  if (els.top10Completed && data.snapshotCount != null) {
    els.top10Completed.textContent = String(
      Math.max(Number(data.tracking && data.tracking.completedCount) || 0, Number(data.snapshotCount) || 0)
    );
  }
  renderTop10Standings(data);
  renderTop10CategoryViews(data);
}

async function refreshTop10Dashboard(options = {}) {
  const data = await api("/api/top10?limit=700");
  renderTop10Dashboard(data);
  if (!options.silent) {
    showToast("Top 10 dashboard refreshed");
  }
  return data;
}

async function runTop10SnapshotFromDashboard() {
  if (top10SnapshotBusy) {
    return;
  }
  top10SnapshotBusy = true;
  if (els.top10SnapshotBtn) {
    els.top10SnapshotBtn.disabled = true;
  }
  try {
    await api("/api/action", {
      method: "POST",
      body: JSON.stringify({ action: "top10" })
    });
    showToast("Top 10 snapshot started");
    setTimeout(() => {
      refreshTop10Dashboard({ silent: true }).catch(() => {});
    }, 8000);
    setTimeout(() => {
      refreshTop10Dashboard({ silent: true }).catch(() => {});
    }, 20000);
  } catch (error) {
    showToast(error.message || "Snapshot failed");
  } finally {
    top10SnapshotBusy = false;
    if (els.top10SnapshotBtn) {
      els.top10SnapshotBtn.disabled = false;
    }
  }
}

function setupTop10Tab() {
  if (els.top10RefreshBtn) {
    els.top10RefreshBtn.addEventListener("click", () => {
      refreshTop10Dashboard().catch((error) => showToast(error.message || "Refresh failed"));
    });
  }
  if (els.top10SnapshotBtn) {
    els.top10SnapshotBtn.addEventListener("click", () => {
      runTop10SnapshotFromDashboard();
    });
  }
}

function setupTabs() {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const views = {
    dashboard: document.getElementById("tab-dashboard"),
    top10: document.getElementById("tab-top10"),
    settings: document.getElementById("tab-settings"),
    troops: document.getElementById("tab-troops")
  };
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      activeTab = tab || "dashboard";
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      Object.entries(views).forEach(([key, el]) => {
        if (el) {
          el.classList.toggle("active", key === tab);
        }
      });
      if (tab === "troops" && !troopsLoadedOnce) {
        troopsLoadedOnce = true;
        refreshTroopForm();
      }
      if (tab === "top10") {
        refreshTop10Dashboard({ silent: top10LoadedOnce }).catch((error) =>
          showToast(error.message || "Could not load Top 10")
        );
        top10LoadedOnce = true;
      }
      if (tab === "settings") {
        refreshActivitySettingsPanel();
        refreshProxySettingsPanel();
        if (latestStatus && latestStatus.display) {
          renderDisplaySettingsPanel(latestStatus.display);
        }
      }
    });
  });
}

function tickClock() {
  const now = new Date();
  els.clock.textContent = now.toLocaleTimeString(undefined, { hour12: false });
}

renderActions(false);
setupDisplaySettings();
setupTabs();
setupTop10Tab();
setupTroopForm();
setupActivityForm();
setupProxyForm();
connectEvents();
startHeavyTabPolling();
startLoopCountdownTicker();
tickClock();
setInterval(tickClock, 1000);
setInterval(refreshLogs, 20000);
refreshLogs();

api("/api/status")
  .then((data) => {
    const status = data.status || {};
    if (status.display && status.display.compactView !== undefined) {
      applyDisplayView(status.display.compactView ? "compact" : "regular");
    } else {
      applyDisplayView(getDisplayView());
    }
    if (status.proxy) {
      renderProxySettingsPanel(status.proxy);
    }
    renderStatusNow(status);
  })
  .catch(() => showToast("Could not reach dashboard API"));
