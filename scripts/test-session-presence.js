#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const presence = require("../sessionPresence");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexian-presence-"));
const logFile = path.join(tmpDir, "session-presence.json");

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy wait short */
  }
}

try {
  presence.closeOpenPeriods(logFile, "interrupted");
  let report = presence.buildReport({ limit: 10 }, logFile);
  assert.strictEqual(report.periodCount, 0);

  const first = presence.startPeriod(
    {
      startReason: "login",
      publicIp: "1.1.1.1",
      proxyServer: null,
      proxyDisplay: "direct (none)"
    },
    logFile
  );
  assert.ok(first.id);
  assert.strictEqual(first.publicIp, "1.1.1.1");
  assert.strictEqual(first.active, true);

  sleep(5);
  const ended = presence.endActivePeriod({ endReason: "session_rest" }, logFile);
  assert.ok(ended);
  assert.strictEqual(ended.endReason, "session_rest");
  assert.strictEqual(ended.active, false);
  assert.ok(ended.durationMs >= 0);

  const second = presence.startPeriod(
    {
      startReason: "session_wake",
      proxyDisplay: "#1/2 http://10.0.0.2:8080",
      proxyServer: "http://10.0.0.2:8080"
    },
    logFile
  );
  assert.strictEqual(second.startReason, "session_wake");
  assert.strictEqual(second.publicIp, null);

  const updated = presence.updateActivePeriod({ publicIp: "8.8.8.8" }, logFile);
  assert.strictEqual(updated.publicIp, "8.8.8.8");

  // Crash recovery closes open periods.
  const closed = presence.closeOpenPeriods(logFile, "interrupted");
  assert.strictEqual(closed.closed, 1);

  report = presence.buildReport({ limit: 10 }, logFile);
  assert.strictEqual(report.periodCount, 2);
  assert.strictEqual(report.active, null);
  assert.ok(report.uniqueIps.includes("1.1.1.1"));
  assert.ok(report.uniqueIps.includes("8.8.8.8"));
  assert.ok(report.totalOnlineMs >= 0);
  assert.ok(report.periods[0].endedAt);

  // startPeriod supersedes any leftover open period
  presence.startPeriod({ startReason: "login", publicIp: "9.9.9.9" }, logFile);
  presence.startPeriod({ startReason: "relogin_manual", publicIp: "9.9.9.9" }, logFile);
  report = presence.buildReport({ limit: 20 }, logFile);
  const open = report.periods.filter((p) => p.active);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].startReason, "relogin_manual");

  assert.strictEqual(presence.normalizeIp("  1.2.3.4 "), "1.2.3.4");
  assert.strictEqual(presence.normalizeIp("<html>"), null);
  assert.ok(presence.formatDuration(3661000).includes("h"));

  console.log("sessionPresence tests passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
