#!/usr/bin/env node
/**
 * Cross-platform 24/7 watchdog (PC / VPS / Windows / macOS / Linux).
 * Restarts the dashboard bot if the process dies, the API is down, or
 * log.jsonl goes stale while automation loops should be active.
 *
 * Usage:
 *   node scripts/keep-alive.js
 *   npm run keep-alive:pc
 *
 * Env (optional): CHECK_SECONDS, STALE_MINUTES, STALE_GRACE_MINUTES, DASH_URL, DASHBOARD_PORT
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const CHECK_SECONDS = Number(process.env.CHECK_SECONDS || 15);
// Must exceed SESSION_REST_MAX_MINUTES so intentional rest never looks like a stall.
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 25);
const STALE_GRACE_MINUTES = Number(process.env.STALE_GRACE_MINUTES || 5);
const DASH_PORT = Number(process.env.DASHBOARD_PORT || 3847);
const DASH_URL = process.env.DASH_URL || `http://127.0.0.1:${DASH_PORT}/api/status`;
const LOG_FILE = process.env.LOG_FILE || path.join(ROOT, "keep-alive.log");
const ACTION_LOG = path.join(ROOT, "log.jsonl");
const ENV_FILE = path.join(ROOT, ".env");

let lastRestartEpoch = 0;
let botChild = null;

function log(msg) {
  const line = `[${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}] ${msg}`;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch (_e) {
    /* ignore */
  }
  console.log(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fileAgeMinutes(filePath) {
  try {
    const st = fs.statSync(filePath);
    return (Date.now() - st.mtimeMs) / 60000;
  } catch (_e) {
    return 99999;
  }
}

function minutesSinceRestart() {
  if (!lastRestartEpoch) return 99999;
  return (Date.now() / 1000 - lastRestartEpoch) / 60;
}

function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get(DASH_URL, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_e) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function loginJsRunning() {
  if (botChild && botChild.exitCode === null && !botChild.killed) {
    return true;
  }
  try {
    if (process.platform === "win32") {
      const out = execSync(
        'wmic process where "CommandLine like \'%login.js%\' and not CommandLine like \'%wmic%\'" get ProcessId /FORMAT:LIST',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      );
      return /ProcessId=\d+/i.test(out);
    }
    const out = execSync("pgrep -af 'node.*login\\.js' || true", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return /login\.js/.test(out);
  } catch (_e) {
    return false;
  }
}

function killLoginJs() {
  try {
    if (botChild && botChild.exitCode === null) {
      try {
        botChild.kill("SIGTERM");
      } catch (_e) {
        /* ignore */
      }
      botChild = null;
    }
    if (process.platform === "win32") {
      try {
        execSync(
          'wmic process where "CommandLine like \'%login.js%\' and not CommandLine like \'%wmic%\'" call terminate',
          { stdio: "ignore", windowsHide: true }
        );
      } catch (_e) {
        /* ignore */
      }
    } else {
      try {
        execSync("pkill -f 'node --max-old-space-size=768 login.js' || true", { stdio: "ignore" });
      } catch (_e) {
        /* ignore */
      }
    }
  } catch (_e) {
    /* ignore */
  }
}

function startBot() {
  killLoginJs();
  const nodeArgs = ["--max-old-space-size=768", "login.js", "--dashboard", "--keep-open"];
  botChild = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    env: process.env,
    detached: false,
    stdio: "ignore",
    windowsHide: true
  });
  botChild.on("exit", (code, signal) => {
    log(`bot process exited code=${code} signal=${signal || ""}`);
    botChild = null;
  });
  botChild.unref?.();
  log("started bot (npm-equivalent: node login.js --dashboard --keep-open)");
}

async function restartBot(reason) {
  log(`restarting bot (${reason})`);
  killLoginJs();
  await sleep(1500);
  startBot();
  lastRestartEpoch = Date.now() / 1000;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await fetchStatus();
    if (st && st.ok !== false && (st.status || st)) {
      log(`bot dashboard healthy after restart (stale-check grace ${STALE_GRACE_MINUTES}m)`);
      return true;
    }
  }
  log("WARNING: dashboard still down after restart wait");
  return false;
}

function automationExpected() {
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    return /^(FARMLIST_LOOP_ENABLED|BUILDER_LOOP_ENABLED|TROOP_TRAINING_ROUND_ROBIN_ENABLED|TOP10_TRACKING_ENABLED|ACTIVITY_SIMULATION_ENABLED)=true/m.test(
      text
    );
  } catch (_e) {
    return false;
  }
}

async function tick() {
  const running = loginJsRunning();
  const statusPayload = await fetchStatus();
  const dashOk = Boolean(statusPayload);

  if (!running || !dashOk) {
    await restartBot(!running ? "login.js not running" : "dashboard API down");
    return;
  }

  const age = Math.floor(fileAgeMinutes(ACTION_LOG));
  const graceAge = Math.floor(minutesSinceRestart());
  log(`heartbeat bot=up dash=up log_age=${age}m restart_age=${graceAge}m`);

  if (!automationExpected()) return;
  if (age < STALE_MINUTES) return;
  if (graceAge < STALE_GRACE_MINUTES) {
    log(`log.jsonl stale ${age}m but within ${STALE_GRACE_MINUTES}m post-restart grace — skip`);
    return;
  }

  const status = statusPayload.status || statusPayload;
  const automation = status.automation || {};
  const reason = String(automation.reason || "").toLowerCase();
  const intentionalOff =
    Boolean(automation.paused) ||
    [
      "resting",
      "relogin",
      "reconnecting",
      "logging_in",
      "starting",
      "manual_pause",
      "stopped"
    ].includes(reason);
  if (intentionalOff) {
    log(
      `log.jsonl stale ${age}m but intentional off (${reason || "paused"}) — skip restart`
    );
    return;
  }
  await restartBot(`log.jsonl stale ${age}m while online`);
}

async function main() {
  process.chdir(ROOT);
  log(
    `keep-alive:pc starting (stale=${STALE_MINUTES}m check=${CHECK_SECONDS}s grace=${STALE_GRACE_MINUTES}m platform=${process.platform})`
  );
  if (!loginJsRunning() || !(await fetchStatus())) {
    await restartBot("initial ensure");
  } else {
    lastRestartEpoch = Date.now() / 1000;
    log("bot already up — armed restart grace from now");
  }
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick error: ${err && err.message ? err.message : err}`);
    }
    await sleep(Math.max(5, CHECK_SECONDS) * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
