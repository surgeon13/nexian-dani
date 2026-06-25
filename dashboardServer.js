const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { tailLogFile } = require("./logTail");
let villageBuilder = null;
try {
  villageBuilder = require("./villageBuilder");
} catch (_error) {
  villageBuilder = null;
}

const PUBLIC_DIR = path.join(__dirname, "public");

const ACTION_MAP = {
  status: "0",
  farmlist: "1",
  "village-builder": "2",
  "resource-builder": "3",
  troops: "4",
  cranny: "C",
  templates: "T",
  expansion: "5",
  "stop-builder": "X",
  relogin: "r",
  "relogin-status": "R",
  villages: "V",
  logs: "L",
  pause: "P",
  settings: "S",
  quit: "Q"
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === "/" ? "/index.html" : urlPath;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  };
  res.writeHead(200, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  fs.createReadStream(abs).pipe(res);
}

function resolveActionCommand(body) {
  if (body && body.command) {
    return String(body.command).trim();
  }
  if (body && body.action) {
    const key = String(body.action).trim().toLowerCase();
    if (ACTION_MAP[key]) {
      return ACTION_MAP[key];
    }
    return String(body.action).trim();
  }
  return "";
}

function getLocalIPv4Addresses() {
  const addresses = [];
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return [...new Set(addresses)];
}

async function fetchPublicIPv4() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data.ip || null;
  } catch (_error) {
    return null;
  }
}

async function getDashboardNetworkInfo(port, host = "127.0.0.1") {
  const localAddresses = getLocalIPv4Addresses();
  const publicAddress = await fetchPublicIPv4();
  const dashboardUrls = [`http://127.0.0.1:${port}`];
  localAddresses.forEach((ip) => {
    dashboardUrls.push(`http://${ip}:${port}`);
  });

  return {
    localAddresses,
    publicAddress,
    dashboardHost: host,
    dashboardPort: port,
    dashboardUrls
  };
}

function openDashboardInBrowser(url) {
  const target = String(url || "").trim();
  if (!target) {
    return;
  }

  let command;
  if (process.platform === "win32") {
    command = `start "" "${target}"`;
  } else if (process.platform === "darwin") {
    command = `open "${target}"`;
  } else {
    command = `xdg-open "${target}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.warn(`  Dashboard: could not open browser (${error.message || error})`);
    }
  });
}

function startDashboardServer({
  bridge,
  port = 3847,
  logFilePath,
  host = "127.0.0.1",
  openBrowser = false
}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && pathname === "/api/status") {
        sendJson(res, 200, {
          ok: true,
          status: bridge.getSnapshot(),
          pendingPrompt: bridge.getPendingPrompt()
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/logs") {
        const tail = Number(url.searchParams.get("tail") || 50);
        sendJson(res, 200, {
          ok: true,
          entries: tailLogFile(logFilePath, tail)
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/console") {
        const tail = Number(url.searchParams.get("tail") || 120);
        sendJson(res, 200, {
          ok: true,
          entries: typeof bridge.getConsole === "function" ? bridge.getConsole(tail) : []
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/templates") {
        const payload = {
          ok: true,
          index: { templates: [] },
          templates: {},
          progress: {},
          templateOptions: { village: [], resource: [] },
          loadedVillages: [],
          selectedVillageId: null,
          activeVillageId: null
        };
        try {
          if (villageBuilder) {
            const index = villageBuilder.loadIndex();
            payload.index = index;
            for (const entry of (index && index.templates) || []) {
              if (!entry || !entry.enabled) {
                continue;
              }
              try {
                payload.templates[entry.key] = villageBuilder.loadTemplate(entry.key);
                const option = {
                  key: entry.key,
                  name:
                    (payload.templates[entry.key] && payload.templates[entry.key].name) ||
                    entry.key
                };
                if (String(entry.key).startsWith("resource_")) {
                  payload.templateOptions.resource.push(option);
                } else {
                  payload.templateOptions.village.push(option);
                }
              } catch (_templateError) {
                /* skip a single bad template */
              }
            }
            payload.progress = villageBuilder.loadProgress() || {};
          }
          const snap = bridge.getSnapshot ? bridge.getSnapshot() : null;
          if (snap && Array.isArray(snap.villages)) {
            payload.loadedVillages = snap.villages;
            payload.selectedVillageId = snap.selectedVillageId ?? null;
            payload.activeVillageId = snap.activeVillageId ?? null;
          }
        } catch (error) {
          payload.error = error && error.message ? error.message : String(error);
        }
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === "POST" && pathname === "/api/village-plan") {
        const body = await readJsonBody(req);
        if (!villageBuilder) {
          sendJson(res, 503, { ok: false, error: "Village builder unavailable" });
          return;
        }
        const villageId = Number(body.villageId ?? body.id);
        if (!Number.isFinite(villageId)) {
          sendJson(res, 400, { ok: false, error: "Missing village id" });
          return;
        }
        const village = {
          id: villageId,
          vid: villageId,
          x: Number.isFinite(Number(body.x)) ? Number(body.x) : null,
          y: Number.isFinite(Number(body.y)) ? Number(body.y) : null,
          name: body.name ? String(body.name) : null
        };
        const assigned = [];
        try {
          if (body.villageTemplate) {
            villageBuilder.resetVillageProgress(village, String(body.villageTemplate), {
              planMode: "village"
            });
            assigned.push({ planMode: "village", templateKey: body.villageTemplate });
          }
          if (body.resourceTemplate) {
            villageBuilder.resetVillageProgress(village, String(body.resourceTemplate), {
              planMode: "resource"
            });
            assigned.push({ planMode: "resource", templateKey: body.resourceTemplate });
          }
          if (!assigned.length) {
            sendJson(res, 400, { ok: false, error: "No template selected" });
            return;
          }
          const progressKey = villageBuilder.villageProgressKey(village);
          const progress = villageBuilder.loadProgress() || {};
          if (typeof bridge.publishSnapshot === "function") {
            bridge.publishSnapshot();
          }
          sendJson(res, 200, {
            ok: true,
            assigned,
            progressKey,
            record: progress[progressKey] || null,
            progress
          });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/troop-templates") {
        const troop =
          typeof bridge.getTroopSettings === "function" ? bridge.getTroopSettings() : null;
        if (!troop) {
          sendJson(res, 503, { ok: false, error: "Troop settings unavailable" });
          return;
        }
        sendJson(res, 200, { ok: true, troop });
        return;
      }

      if (req.method === "POST" && pathname === "/api/troop-templates") {
        const body = await readJsonBody(req);
        if (typeof bridge.updateTroopSettings !== "function") {
          sendJson(res, 503, { ok: false, error: "Troop settings unavailable" });
          return;
        }
        try {
          const troop = await bridge.updateTroopSettings(body || {});
          sendJson(res, 200, { ok: true, troop });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/activity-settings") {
        const body = await readJsonBody(req);
        if (typeof bridge.updateActivitySettings !== "function") {
          sendJson(res, 503, { ok: false, error: "Activity settings unavailable" });
          return;
        }
        try {
          const activitySimulation = await bridge.updateActivitySettings(body || {});
          sendJson(res, 200, { ok: true, activitySimulation });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/display-settings") {
        const body = await readJsonBody(req);
        if (typeof bridge.updateDisplaySettings !== "function") {
          sendJson(res, 503, { ok: false, error: "Display settings unavailable" });
          return;
        }
        try {
          const display = await bridge.updateDisplaySettings(body || {});
          sendJson(res, 200, { ok: true, display });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        res.write("\n");
        bridge.addSseClient(res);
        bridge.publishSnapshot();
        req.on("close", () => bridge.removeSseClient(res));
        return;
      }

      if (req.method === "POST" && pathname === "/api/action") {
        const body = await readJsonBody(req);
        const command = resolveActionCommand(body);
        if (!command) {
          sendJson(res, 400, { ok: false, error: "Missing action or command" });
          return;
        }
        bridge.enqueueCommand(command);
        sendJson(res, 202, { ok: true, queued: command });
        return;
      }

      if (req.method === "POST" && pathname === "/api/village") {
        const body = await readJsonBody(req);
        const id = Number(body.id ?? body.villageId);
        if (!Number.isFinite(id)) {
          sendJson(res, 400, { ok: false, error: "Missing village id" });
          return;
        }
        bridge.enqueueCommand(`@select-village ${id}`);
        sendJson(res, 202, { ok: true, queued: id });
        return;
      }

      if (req.method === "POST" && pathname === "/api/prompt") {
        const body = await readJsonBody(req);
        const answered = bridge.answerPrompt(body.answer ?? "");
        if (!answered) {
          bridge.clearPendingPrompt();
        }
        sendJson(res, 200, { ok: true, answered });
        return;
      }

      if (req.method === "GET") {
        serveStatic(req, res, pathname);
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
  });

  const maxPortAttempts = 10;
  let attempt = 0;
  let activePort = port;

  const tryListen = (candidatePort) => {
    activePort = candidatePort;
    server.listen(candidatePort, host);
  };

  server.on("listening", () => {
    const url = `http://${host}:${activePort}`;
    if (activePort !== port) {
      console.warn(
        `  Dashboard: port ${port} was busy — using ${activePort} instead.`
      );
    }
    console.log(`  Dashboard: ${url}`);
    if (openBrowser) {
      openDashboardInBrowser(url);
    }
  });

  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && attempt < maxPortAttempts) {
      attempt += 1;
      const nextPort = port + attempt;
      console.warn(
        `  Dashboard: port ${activePort} in use, retrying on ${nextPort}...`
      );
      setTimeout(() => tryListen(nextPort), 150);
      return;
    }
    if (error && error.code === "EADDRINUSE") {
      console.warn(
        `  Dashboard: could not bind a port near ${port} (another instance may be running). ` +
          `Continuing without the web dashboard.`
      );
    } else {
      console.warn(
        `  Dashboard: server error (${error && error.message ? error.message : error}). ` +
          `Continuing without the web dashboard.`
      );
    }
  });

  const heartbeat = setInterval(() => {
    if (typeof bridge.hasSseClients === "function" && !bridge.hasSseClients()) {
      return;
    }
    bridge.publishSnapshot();
  }, 5000);

  server.on("close", () => clearInterval(heartbeat));

  tryListen(port);

  return server;
}

module.exports = {
  startDashboardServer,
  getDashboardNetworkInfo,
  openDashboardInBrowser,
  ACTION_MAP
};
