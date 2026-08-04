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

  // Timeline shaped like:
  // 10:00 login with IP1
  // 10:49 logout
  // 10:49 rest time
  // 10:59 login with IP2
  const timelineFile = path.join(tmpDir, "timeline-presence.json");
  presence.startPeriod(
    { startReason: "login", publicIp: "203.0.113.10", proxyDisplay: "direct (none)" },
    timelineFile
  );
  // Force deterministic timestamps for assertion readability.
  const store = presence.loadStore(timelineFile);
  store.periods[0].startedAt = "2026-08-04T10:00:00.000Z";
  store.periods[0].endedAt = "2026-08-04T10:49:00.000Z";
  store.periods[0].endReason = "session_rest";
  store.periods[0].publicIp = "203.0.113.10";
  store.periods.push({
    id: "period-b",
    startedAt: "2026-08-04T10:59:00.000Z",
    endedAt: "2026-08-04T11:48:00.000Z",
    startReason: "session_wake",
    endReason: "session_rest",
    publicIp: "198.51.100.20",
    proxyServer: "http://proxy.example:8080",
    proxyDisplay: "#2/2 http://proxy.example:8080"
  });
  store.periods.push({
    id: "period-c",
    startedAt: "2026-08-04T11:58:00.000Z",
    endedAt: null,
    startReason: "session_wake",
    endReason: null,
    publicIp: "198.51.100.20",
    proxyServer: "http://proxy.example:8080",
    proxyDisplay: "#2/2 http://proxy.example:8080"
  });
  presence.saveStore(store, timelineFile);

  const timelineReport = presence.buildReport({ limit: 20 }, timelineFile);
  assert.ok(Array.isArray(timelineReport.timelineChronological));
  assert.ok(Array.isArray(timelineReport.timelineLines));
  const events = timelineReport.timelineChronological;
  assert.deepStrictEqual(
    events.map((e) => e.type),
    ["login", "logout", "rest", "login", "logout", "rest", "login"]
  );
  assert.strictEqual(events[0].text, "login with 203.0.113.10");
  assert.strictEqual(events[1].text, "logout");
  assert.strictEqual(events[2].text, "rest time (10m)");
  assert.strictEqual(events[3].text, "login with 198.51.100.20");
  assert.strictEqual(events[4].text, "logout");
  assert.strictEqual(events[5].text, "rest time (10m)");
  assert.strictEqual(events[6].text, "login with 198.51.100.20");
  assert.ok(timelineReport.timelineLines[0].includes("login with 203.0.113.10"));
  assert.ok(timelineReport.timelineLines.some((line) => line.includes("rest time")));

  console.log("sessionPresence tests passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
