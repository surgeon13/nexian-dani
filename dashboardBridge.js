function createDashboardBridge() {
  const commandQueue = [];
  const commandWaiters = [];
  const sseClients = new Set();
  const consoleBuffer = [];
  const CONSOLE_BUFFER_LIMIT = 250;
  const MAX_CONSOLE_TEXT_CHARS = 1200;
  const COMMAND_QUEUE_LIMIT = 32;
  const SNAPSHOT_MIN_INTERVAL_MS = 1200;
  let consoleSeq = 0;
  let snapshotProvider = () => ({ updatedAt: new Date().toISOString() });
  let pendingPrompt = null;
  let quitHandler = null;
  let troopSettingsProvider = null;
  let troopSettingsUpdater = null;
  let activitySettingsUpdater = null;
  let displaySettingsUpdater = null;
  let lastSnapshotJson = null;
  let lastSnapshotAt = 0;
  let snapshotFlushTimer = null;

  function setQuitHandler(fn) {
    quitHandler = typeof fn === "function" ? fn : null;
  }

  function setTroopSettingsProvider(fn) {
    troopSettingsProvider = typeof fn === "function" ? fn : null;
  }

  function setTroopSettingsUpdater(fn) {
    troopSettingsUpdater = typeof fn === "function" ? fn : null;
  }

  function getTroopSettings() {
    try {
      return troopSettingsProvider ? troopSettingsProvider() : null;
    } catch (_error) {
      return null;
    }
  }

  async function updateTroopSettings(patch) {
    if (!troopSettingsUpdater) {
      throw new Error("Troop settings are not available");
    }
    return troopSettingsUpdater(patch || {});
  }

  function setActivitySettingsUpdater(fn) {
    activitySettingsUpdater = typeof fn === "function" ? fn : null;
  }

  async function updateActivitySettings(patch) {
    if (!activitySettingsUpdater) {
      throw new Error("Activity settings are not available");
    }
    return activitySettingsUpdater(patch || {});
  }

  function setDisplaySettingsUpdater(fn) {
    displaySettingsUpdater = typeof fn === "function" ? fn : null;
  }

  async function updateDisplaySettings(patch) {
    if (!displaySettingsUpdater) {
      throw new Error("Display settings are not available");
    }
    return displaySettingsUpdater(patch || {});
  }

  function publishEvent(type, data) {
    if (!sseClients.size) {
      return;
    }
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch (_error) {
        sseClients.delete(client);
      }
    }
  }

  function setSnapshotProvider(fn) {
    snapshotProvider = typeof fn === "function" ? fn : () => ({});
    lastSnapshotJson = null;
    lastSnapshotAt = 0;
  }

  function getSnapshot() {
    try {
      return snapshotProvider();
    } catch (_error) {
      return { updatedAt: new Date().toISOString(), error: "snapshot_failed" };
    }
  }

  function flushSnapshot(force = false) {
    snapshotFlushTimer = null;
    const snap = getSnapshot();
    let payload;
    try {
      payload = JSON.stringify(snap);
    } catch (_error) {
      payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        error: "snapshot_stringify_failed"
      });
    }
    if (!force && payload === lastSnapshotJson) {
      lastSnapshotAt = Date.now();
      return snap;
    }
    lastSnapshotJson = payload;
    lastSnapshotAt = Date.now();
    if (sseClients.size) {
      const message = `event: status\ndata: ${payload}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(message);
        } catch (_error) {
          sseClients.delete(client);
        }
      }
    }
    return snap;
  }

  function publishSnapshot(options = {}) {
    const force = Boolean(options && options.force);
    const now = Date.now();
    if (!force && now - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) {
      if (!snapshotFlushTimer) {
        snapshotFlushTimer = setTimeout(() => {
          flushSnapshot(true);
        }, SNAPSHOT_MIN_INTERVAL_MS - (now - lastSnapshotAt));
      }
      return getSnapshot();
    }
    if (snapshotFlushTimer) {
      clearTimeout(snapshotFlushTimer);
      snapshotFlushTimer = null;
    }
    return flushSnapshot(force);
  }

  function enqueueCommand(command) {
    const normalized = String(command || "").trim();
    if (!normalized) {
      return false;
    }
    if (normalized.toUpperCase() === "Q" && quitHandler) {
      quitHandler();
    }
    if (commandWaiters.length) {
      commandWaiters.shift().resolve(normalized);
    } else {
      commandQueue.push(normalized);
      if (commandQueue.length > COMMAND_QUEUE_LIMIT) {
        commandQueue.splice(0, commandQueue.length - COMMAND_QUEUE_LIMIT);
      }
    }
    publishEvent("command", { command: normalized, at: Date.now() });
    return true;
  }

  function waitForCommand(pollMs = 400) {
    if (commandQueue.length) {
      return Promise.resolve(commandQueue.shift());
    }
    if (pollMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          const index = commandWaiters.indexOf(waiter);
          if (index >= 0) {
            commandWaiters.splice(index, 1);
          }
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        const index = commandWaiters.indexOf(waiter);
        if (index >= 0) {
          commandWaiters.splice(index, 1);
        }
        resolve(null);
      }, pollMs);
      commandWaiters.push(waiter);
    });
  }

  function cancelCommandWaiters() {
    while (commandWaiters.length) {
      const waiter = commandWaiters.shift();
      waiter.resolve(null);
    }
  }

  function ask(message) {
    return new Promise((resolve) => {
      pendingPrompt = { message: String(message || ""), resolve };
      publishEvent("prompt", { message: pendingPrompt.message, at: Date.now() });
      publishSnapshot({ force: true });
    });
  }

  function clearPendingPrompt() {
    if (!pendingPrompt) {
      return false;
    }
    pendingPrompt = null;
    publishEvent("prompt_dismiss", { at: Date.now() });
    publishSnapshot({ force: true });
    return true;
  }

  function answerPrompt(answer) {
    if (!pendingPrompt) {
      return false;
    }
    const { resolve } = pendingPrompt;
    pendingPrompt = null;
    resolve(String(answer ?? ""));
    publishEvent("prompt_answer", { answer: String(answer ?? ""), at: Date.now() });
    publishEvent("prompt_dismiss", { at: Date.now() });
    publishSnapshot({ force: true });
    return true;
  }

  function getPendingPrompt() {
    return pendingPrompt ? pendingPrompt.message : null;
  }

  function hasSseClients() {
    return sseClients.size > 0;
  }

  function pushConsole(level, text) {
    let message = String(text == null ? "" : text);
    if (!message) {
      return;
    }
    if (message.length > MAX_CONSOLE_TEXT_CHARS) {
      message = `${message.slice(0, MAX_CONSOLE_TEXT_CHARS - 1)}…`;
    }
    const entry = {
      id: ++consoleSeq,
      level: String(level || "log"),
      text: message,
      at: Date.now()
    };
    consoleBuffer.push(entry);
    if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
      consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
    }
    publishEvent("console", entry);
  }

  function getConsole(limit = 120) {
    const count = Math.max(1, Math.min(Number(limit) || 120, CONSOLE_BUFFER_LIMIT));
    return consoleBuffer.slice(-count);
  }

  function addSseClient(res) {
    sseClients.add(res);
  }

  function removeSseClient(res) {
    sseClients.delete(res);
  }

  return {
    setSnapshotProvider,
    getSnapshot,
    publishSnapshot,
    enqueueCommand,
    waitForCommand,
    cancelCommandWaiters,
    setQuitHandler,
    setTroopSettingsProvider,
    setTroopSettingsUpdater,
    getTroopSettings,
    updateTroopSettings,
    setActivitySettingsUpdater,
    updateActivitySettings,
    setDisplaySettingsUpdater,
    updateDisplaySettings,
    ask,
    answerPrompt,
    clearPendingPrompt,
    getPendingPrompt,
    hasSseClients,
    pushConsole,
    getConsole,
    addSseClient,
    removeSseClient,
    publishEvent
  };
}

module.exports = {
  createDashboardBridge
};
