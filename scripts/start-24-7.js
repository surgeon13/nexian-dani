#!/usr/bin/env node
/**
 * Cross-platform 24/7 starter for a PC / VPS (no tmux required).
 * Spawns the keep-alive watchdog, which starts/restarts the dashboard bot.
 *
 * Usage:
 *   node scripts/start-24-7.js
 *   npm run start:24-7:pc
 *   start-24-7.cmd   (Windows)
 */
"use strict";

const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const keepAliveJs = path.join(ROOT, "scripts", "keep-alive.js");

function main() {
  process.chdir(ROOT);
  if (!fs.existsSync(path.join(ROOT, ".env"))) {
    console.warn("[start-24-7:pc] WARNING: no .env — copy .env.example to .env and fill credentials");
  }
  console.log("[start-24-7:pc] starting keep-alive watchdog…");
  console.log("[start-24-7:pc] dashboard: http://127.0.0.1:3847");
  console.log("[start-24-7:pc] log: " + path.join(ROOT, "keep-alive.log"));
  console.log("[start-24-7:pc] leave this window open (or run as a scheduled task / service)");

  const child = spawn(process.execPath, [keepAliveJs], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: false
  });

  const shutdown = () => {
    try {
      child.kill("SIGTERM");
    } catch (_e) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  child.on("exit", (code) => process.exit(code == null ? 0 : code));
}

main();
