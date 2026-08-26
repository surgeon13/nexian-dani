const { chromium } = require("playwright");
const dotenv = require("dotenv");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { runTerminalMenu } = require("./terminalMenu");
const { createDashboardBridge } = require("./dashboardBridge");
const {
  parsePatterns: parseActivityPatterns,
  serializePatterns: serializeActivityPatterns
} = require("./activitySimulation");
const { DEFAULT_TOP10_LOG_FILE } = require("./top10Tracking");
const { startDashboardServer, getDashboardNetworkInfo } = require("./dashboardServer");
const {
  syncSettingsFromProxyStore,
  getPlaywrightProxy,
  formatProxyDisplay,
  proxyEnvValues,
  buildProxySettingsPayload,
  applyProxyToSettings,
  proxyPool
} = require("./proxyConfig");
const sessionPresence = require("./sessionPresence");
const { safeGotoWithRetry } = require("./browserNavigation");

function getArgValue(prefix) {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

let consoleMirrorInstalled = false;
function mirrorConsoleToDashboard(bridge) {
  if (consoleMirrorInstalled || !bridge || typeof bridge.pushConsole !== "function") {
    return;
  }
  consoleMirrorInstalled = true;

  const format = (args) => {
    const text = args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }
        try {
          return require("util").inspect(arg, { depth: 1, maxArrayLength: 20, breakLength: 120 });
        } catch (_error) {
          return String(arg);
        }
      })
      .join(" ")
      .replace(ANSI_PATTERN, "");
    const MAX = 1200;
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
  };

  const wrap = (method, level) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        if (typeof bridge.hasSseClients === "function" && !bridge.hasSseClients()) {
          return;
        }
        bridge.pushConsole(level, format(args));
      } catch (_error) {
        /* never let mirroring break logging */
      }
    };
  };

  wrap("log", "log");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
}

// NOTE: this must NOT be named "--env-file" — Node.js itself has a native
// --env-file=<path> CLI flag (since v20.6) that intercepts and consumes that
// exact argument before login.js ever runs, and exits hard with
// "node: <path>: not found" if the target doesn't exist yet — bypassing
// ensureEnvFile()'s own auto-creation entirely. Using a different flag name
// avoids the collision. (NEXIAN_ENV_FILE the env var is unaffected either
// way — Node's native flag only triggers from the CLI argument.)
const envFile = getArgValue("--nexian-env-file=") || process.env.NEXIAN_ENV_FILE || ".env";
const resolvedEnvPath = path.resolve(process.cwd(), envFile);
const resolvedEnvExamplePath = path.resolve(__dirname, ".env.example");

// Flavor-aware template resolution: an env file like ".env.termux" prefers a
// matching ".env.termux.example" (e.g. phone-tuned defaults) over the
// generic .env.example, when one exists next to it. Falls back to
// .env.example unchanged otherwise (e.g. ".env.nexian" has no dedicated
// template today, and that's fine — same behavior as before this existed).
function resolveEnvExampleSource(envPath) {
  const base = path.basename(envPath);
  if (base !== ".env" && base.startsWith(".env")) {
    const flavorExample = path.join(path.dirname(envPath), `${base}.example`);
    if (fs.existsSync(flavorExample)) {
      return flavorExample;
    }
  }
  return resolvedEnvExamplePath;
}

function upsertEnvKeys(envPath, defaults) {
  const exists = fs.existsSync(envPath);
  const current = exists ? fs.readFileSync(envPath, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current ? current.split(/\r?\n/) : [];
  let changed = !exists;

  Object.entries(defaults).forEach(([key, value]) => {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const hasKey = lines.some((line) => pattern.test(line));
    if (!hasKey) {
      lines.push(`${key}=${value}`);
      changed = true;
    }
  });

  if (changed) {
    fs.writeFileSync(envPath, lines.join(eol), "utf8");
  }
}

function ensureEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    const source = resolveEnvExampleSource(envPath);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, envPath);
      console.log(`Created ${path.basename(envPath)} from ${path.basename(source)}`);
    } else {
      const minimal = [
        "NEXIAN_URL=https://nexian.world/",
        "NEXIAN_USERNAME=your_username_here",
        "NEXIAN_PASSWORD=your_password_here"
      ].join("\n");
      fs.writeFileSync(envPath, `${minimal}\n`, "utf8");
      console.log(`Created ${path.basename(envPath)} with minimal defaults`);
    }
  }

  upsertEnvKeys(envPath, {
    NEXIAN_URL: "https://nexian.world/",
    NEXIAN_USERNAME: "your_username_here",
    NEXIAN_PASSWORD: "your_password_here"
  });
}

function hasRealCredential(value, placeholder) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.toLowerCase() !== String(placeholder || "").trim().toLowerCase();
}

ensureEnvFile(resolvedEnvPath);
dotenv.config({ path: resolvedEnvPath, quiet: true });
const actionLogFilePath = path.resolve(
  process.cwd(),
  process.env.NEXIAN_ACTION_LOG_FILE || "log.jsonl"
);
const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const STORAGE_STATE_PATH = path.resolve(process.cwd(), "storageState.json");

// Realm host for in-game pages (farmlist, builder, trainer, status, logout).
// Set GAME_HOST=https://s1.nexian.world (or your realm) so URLs target the realm,
// not the nexian.world portal which redirects to village2.php.
const GAME_HOST = (() => {
  const raw = String(process.env.GAME_HOST || "https://nexian.world").trim();
  try {
    return new URL(raw).origin;
  } catch (_error) {
    return "https://nexian.world";
  }
})();
const gameUrl = (pathAndQuery) => `${GAME_HOST}${pathAndQuery}`;

/** Portal world id from GAME_HOST (s1, s2, …). Empty when GAME_HOST is the marketing portal. */
function portalServerIdFromGameHost(gameHost = GAME_HOST) {
  try {
    const host = new URL(gameHost).hostname.toLowerCase();
    const match = host.match(/^(s\d+|test)\.nexian\.world$/i);
    return match ? match[1].toLowerCase() : "";
  } catch (_error) {
    return "";
  }
}

const PORTAL_SERVER_ID = portalServerIdFromGameHost();

// The portal's own landing-page component (window.landingPage(), served
// inline) supports ?login=1&world=<id> as a documented entry point: it seeds
// the modal's initial Alpine state as { journey: true, view: 'login',
// serverId: <id> } server-side, so the login form is already open and
// visible on the realm we want the instant the page loads — no "Play Now"
// click, no realm-card selection, none of openNexianPortalLoginForm's
// fallback chain needed. Confirmed against the portal's actual served HTML/JS.
//
// setlang=en forces English regardless of whatever geo-IP/browser-locale
// detection the portal does — confirmed live: a real user's session
// rendered the entire portal (realm cards, login modal, button text) in
// Hebrew, so our English-text selectors (e.g.
// input[placeholder="Enter your username"]) never matched and every login
// attempt timed out waiting for a field that was there, just not in
// English. Also confirmed against the portal's served markup that setlang
// accepts en/he/ro/tr/ru/es/th/it/cs/br/pt.
//
// Falls back to the bare portal URL when GAME_HOST doesn't name a specific
// realm (nothing to preselect). NEXIAN_URL still overrides both.
const LOGIN_URL =
  process.env.NEXIAN_URL ||
  (PORTAL_SERVER_ID
    ? `https://nexian.world/?login=1&world=${PORTAL_SERVER_ID}&setlang=en`
    : "https://nexian.world/?setlang=en");
const USERNAME = process.env.NEXIAN_USERNAME;
const PASSWORD = process.env.NEXIAN_PASSWORD;
const headlessByDefault = !(
  process.argv.includes("--headed") || process.env.HEADLESS === "false"
);
const keepOpen = process.argv.includes("--keep-open") || process.env.KEEP_OPEN !== "false";
const dashboardEnabled =
  process.argv.includes("--dashboard") ||
  String(process.env.DASHBOARD_ENABLED || "false").toLowerCase() === "true";
const dashboardPort = Math.max(
  1024,
  Math.min(65535, Math.floor(Number(process.env.DASHBOARD_PORT || 3847) || 3847))
);
const dashboardOpenBrowser =
  String(process.env.DASHBOARD_OPEN_BROWSER ?? "true").toLowerCase() !== "false";
const dashboardCompactView =
  String(process.env.DASHBOARD_COMPACT_VIEW || "false").toLowerCase() === "true";

// Speed: block images/media/fonts so pages load faster and use less RAM. Selectors still work.
const blockMedia =
  String(process.env.BLOCK_MEDIA ?? "true").toLowerCase() !== "false";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

async function applyContextSpeedups(context) {
  if (!blockMedia || !context) {
    return;
  }
  try {
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) {
        route.abort().catch(() => route.continue().catch(() => {}));
      } else {
        route.continue().catch(() => {});
      }
    });
  } catch (_error) {
    /* routing is best-effort; ignore if unsupported */
  }
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const settings = {
  headless: headlessByDefault,
  farmlistUrl:
    process.env.FARMLIST_URL ||
    gameUrl("/build.php?id=39&t=99&gid=16"),
  farmlistVillageId: (() => {
    const raw = Number(process.env.FARMLIST_VILLAGE_ID);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
  })(),
  villageBuilderUrl:
    process.env.VILLAGE_BUILDER_URL ||
    gameUrl("/village2.php"),
  troopTrainerUrl:
    process.env.TROOP_TRAINER_URL ||
    gameUrl("/build.php?id=37"),
  troopStableTrainerUrl:
    process.env.TROOP_STABLE_TRAINER_URL ||
    gameUrl("/build.php?id=38"),
  villageStatusUrl:
    process.env.VILLAGE_STATUS_URL ||
    gameUrl("/village1.php"),
  farmlistLoopEnabled: String(process.env.FARMLIST_LOOP_ENABLED || "false").toLowerCase() === "true",
  farmlistLoopMinMinutes: numberEnv("FARMLIST_LOOP_MIN_MINUTES", 10),
  farmlistLoopMaxMinutes: numberEnv("FARMLIST_LOOP_MAX_MINUTES", 20),
  sessionLoopEnabled: String(process.env.SESSION_LOOP_ENABLED || "false").toLowerCase() === "true",
  playMinMinutes: numberEnv("SESSION_PLAY_MIN_MINUTES", 60),
  playMaxMinutes: numberEnv("SESSION_PLAY_MAX_MINUTES", 120),
  restMinMinutes: numberEnv("SESSION_REST_MIN_MINUTES", 5),
  restMaxMinutes: numberEnv("SESSION_REST_MAX_MINUTES", 15),
  browserRefreshHours: numberEnv("BROWSER_REFRESH_HOURS", 0),
  manualPauseAutoUnpauseMinutes: numberEnv("MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES", 0),
  logoutUrl:
    process.env.LOGOUT_URL ||
    gameUrl("/logout.php"),
  randomDelayMinMs: numberEnv("RANDOM_DELAY_MIN_MS", 1000),
  randomDelayMaxMs: numberEnv("RANDOM_DELAY_MAX_MS", 2000),
  selectAllSelector:
    process.env.FARMLIST_SELECT_ALL_SELECTOR ||
    'input[id^="farmlist_selectall_"]',
  sendButtonSelector:
    process.env.FARMLIST_SEND_BUTTON_SELECTOR ||
    "#btn_send_all",
  builderGoldCompleteEnabled:
    String(process.env.BUILDER_GOLD_COMPLETE_ENABLED || "false").toLowerCase() === "true",
  builderGoldCompleteMax: numberEnv("BUILDER_GOLD_COMPLETE_MAX", 3),
  builderMasterBuilderEnabled:
    String(process.env.BUILDER_MASTER_BUILDER_ENABLED || "false").toLowerCase() === "true",
  raidEvacuationEnabled:
    String(process.env.RAID_EVACUATION_ENABLED || "true").toLowerCase() === "true",
  raidEvacuationTroopsEnabled:
    String(process.env.RAID_EVACUATION_TROOPS_ENABLED || "true").toLowerCase() === "true",
  raidEvacuationTroopRecallSeconds: numberEnv("RAID_EVACUATION_TROOP_RECALL_SECONDS", 60),
  raidEvacuationTriggerMinutes: numberEnv("RAID_EVACUATION_TRIGGER_MINUTES", 30),
  raidEvacuationReservePerResource: numberEnv("RAID_EVACUATION_RESERVE_PER_RESOURCE", 300),
  raidEvacuationMerchantCapacityFallback: numberEnv("RAID_EVACUATION_MERCHANT_CAPACITY_FALLBACK", 1000),
  raidEvacuationPivotVillageIds: String(process.env.RAID_EVACUATION_PIVOT_VILLAGE_IDS || "").trim(),
  raidEvacuationPollSeconds: numberEnv("RAID_EVACUATION_POLL_SECONDS", 30),
  villageSwitchDelayMs: (() => {
    const raw = process.env.VILLAGE_SWITCH_DELAY_MS;
    if (raw === undefined || String(raw).trim() === "") {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
  })(),
  statusAfterFarmlistsEnabled:
    String(process.env.STATUS_AFTER_FARMLISTS_ENABLED || "true").toLowerCase() === "true",
  statusAfterFarmlistsCooldownMinutes: numberEnv("STATUS_AFTER_FARMLISTS_COOLDOWN_MINUTES", 15),
  builderLoopEnabled:
    String(process.env.BUILDER_LOOP_ENABLED || "false").toLowerCase() === "true",
  builderLoopMinMinutes: numberEnv("BUILDER_LOOP_MIN_MINUTES", 0.5),
  builderLoopMaxMinutes: numberEnv("BUILDER_LOOP_MAX_MINUTES", 1),
  builderRoundRobinEnabled:
    String(process.env.BUILDER_ROUND_ROBIN_ENABLED || "false").toLowerCase() === "true",
  builderRoundRobinExcludedVillageIds:
    String(process.env.BUILDER_RR_EXCLUDED_VILLAGE_IDS || "").trim(),
  builderDefaultPlanMode: (() => {
    const raw = String(process.env.BUILDER_DEFAULT_PLAN_MODE || "resource")
      .trim()
      .toLowerCase();
    return raw === "village" ? "village" : "resource";
  })(),
  builderRrResourceThenVillage: (() => {
    const raw = process.env.BUILDER_RR_RESOURCE_THEN_VILLAGE;
    if (raw !== undefined && String(raw).trim() !== "") {
      return String(raw).toLowerCase() === "true";
    }
    const defaultPlan = String(process.env.BUILDER_DEFAULT_PLAN_MODE || "resource")
      .trim()
      .toLowerCase();
    return defaultPlan !== "village";
  })(),
  // Once a village's resource-fields plan is fully complete (all fields at
  // their template's max level, e.g. 10), automatically add it to
  // BUILDER_RR_EXCLUDED_VILLAGE_IDS and stop building it — instead of
  // (or in addition to) falling through to the village-stage plan.
  builderRrAutoExcludeOnResourceComplete:
    String(process.env.BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE || "true").toLowerCase() ===
    "true",
  // Consecutive ticks a village may spend stuck on the same non-transient
  // blocked status before it is auto-excluded from Builder RR, so the
  // rotation stops spending turns on a village nothing can be built in.
  // Only structural blocks count (a missing upgrade button, a mismatched or
  // unavailable target, …) — never blocked_resources / blocked_queue /
  // blocked_storage / idle_saturated, which clear on their own. Set 0 to
  // disable and keep retrying forever.
  builderRrAutoExcludeBlockedStreak: numberEnv("BUILDER_RR_AUTO_EXCLUDE_BLOCKED_STREAK", 12),
  troopTrainingRoundRobinEnabled:
    String(process.env.TROOP_TRAINING_ROUND_ROBIN_ENABLED || "false").toLowerCase() === "true",
  troopTrainingLoopMinMinutes: numberEnv("TROOP_TRAINING_LOOP_MIN_MINUTES", 5),
  troopTrainingLoopMaxMinutes: numberEnv("TROOP_TRAINING_LOOP_MAX_MINUTES", 10),
  // When ON, a branch (Barracks/Great Barracks/Stable/Great Stable/Workshop) is
  // skipped for the tick if its existing training queue already runs at or
  // beyond TROOP_QUEUE_CAP_HOURS — so one building can't hog resources for a
  // whole day while the rest of the plan starves. Off by default: existing
  // installs keep today's behavior until a user opts in.
  troopQueueCapEnabled:
    String(process.env.TROOP_QUEUE_CAP_ENABLED || "false").toLowerCase() === "true",
  troopQueueCapHours: numberEnv("TROOP_QUEUE_CAP_HOURS", 12),
  crannyDefenseRoundRobinEnabled:
    String(process.env.CRANNY_DEFENSE_ROUND_ROBIN_ENABLED || "false").toLowerCase() === "true",
  crannyDefenseLoopMinMinutes: numberEnv("CRANNY_DEFENSE_LOOP_MIN_MINUTES", 8),
  crannyDefenseLoopMaxMinutes: numberEnv("CRANNY_DEFENSE_LOOP_MAX_MINUTES", 15),
  activitySimulationEnabled:
    String(process.env.ACTIVITY_SIMULATION_ENABLED || "false").toLowerCase() === "true",
  activitySimulationLoopMinMinutes: numberEnv("ACTIVITY_SIMULATION_LOOP_MIN_MINUTES", 20),
  activitySimulationLoopMaxMinutes: numberEnv("ACTIVITY_SIMULATION_LOOP_MAX_MINUTES", 45),
  activitySimulationPatterns: serializeActivityPatterns(
    parseActivityPatterns(process.env.ACTIVITY_SIMULATION_PATTERNS)
  ),
  activitySimulationDwellMinMs: numberEnv("ACTIVITY_SIMULATION_DWELL_MIN_MS", 2000),
  activitySimulationDwellMaxMs: numberEnv("ACTIVITY_SIMULATION_DWELL_MAX_MS", 6000),
  top10TrackingEnabled:
    String(process.env.TOP10_TRACKING_ENABLED || "false").toLowerCase() === "true",
  top10TrackingLoopMinMinutes: numberEnv("TOP10_TRACKING_LOOP_MIN_MINUTES", 60),
  top10TrackingLoopMaxMinutes: numberEnv("TOP10_TRACKING_LOOP_MAX_MINUTES", 120),
  top10TrackingLogFile: process.env.TOP10_TRACKING_LOG_FILE || DEFAULT_TOP10_LOG_FILE,
  top10TrackingPlayerName: String(process.env.TOP10_TRACKING_PLAYER_NAME || "").trim(),
  dashboardCompactView,
  expansionAutoDispatchEnabled:
    String(process.env.EXPANSION_AUTO_DISPATCH_ENABLED || "false").toLowerCase() === "true",
  expansionUsePlannedTargets:
    String(process.env.EXPANSION_USE_PLANNED_TARGETS || "false").toLowerCase() === "true",
  expansionPlannedTargetsFile:
    process.env.EXPANSION_PLANNED_TARGETS_FILE || "templates/settlement_targets.json",
  resourceCirculationEnabled:
    String(process.env.RESOURCE_CIRCULATION_ENABLED || "false").toLowerCase() === "true",
  resourceCirculationExpansionEnabled:
    String(process.env.RESOURCE_CIRCULATION_EXPANSION_ENABLED || "false").toLowerCase() === "true",
  resourceCirculationPreferNearest:
    String(process.env.RESOURCE_CIRCULATION_PREFER_NEAREST || "true").toLowerCase() === "true",
  resourceCirculationReceiverMaxFillRatio: numberEnv("RESOURCE_CIRCULATION_RECEIVER_MAX_FILL_RATIO", 0.8),
  resourceCirculationMaxDonors: numberEnv("RESOURCE_CIRCULATION_MAX_DONORS", 3),
  resourceCirculationBuilderMaxDonors: numberEnv("RESOURCE_CIRCULATION_BUILDER_MAX_DONORS", 1),
  resourceCirculationBuilderMerchantLoads: numberEnv("RESOURCE_CIRCULATION_BUILDER_MERCHANT_LOADS", 4),
  resourceCirculationReservePerResource: numberEnv("RESOURCE_CIRCULATION_RESERVE_PER_RESOURCE", 500),
  resourceOverflowGuardEnabled:
    String(process.env.RESOURCE_OVERFLOW_GUARD_ENABLED || "true").toLowerCase() === "true",
  resourceOverflowTriggerRatio: (() => {
    const raw = Number(process.env.RESOURCE_OVERFLOW_TRIGGER_RATIO);
    if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) return raw / 100;
    return 0.9;
  })(),
  resourceOverflowTargetRatio: (() => {
    const raw = Number(process.env.RESOURCE_OVERFLOW_TARGET_RATIO);
    if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) return raw / 100;
    return 0.75;
  })(),
  resourceOverflowMaxDistance: numberEnv("RESOURCE_OVERFLOW_MAX_DISTANCE", 10),
  resourceOverflowLoopMinMinutes: numberEnv("RESOURCE_OVERFLOW_LOOP_MIN_MINUTES", 8),
  resourceOverflowLoopMaxMinutes: numberEnv("RESOURCE_OVERFLOW_LOOP_MAX_MINUTES", 15),
  // Check every non-pivot village on each tick instead of one per
  // round-robin turn. With more than a couple of villages, one-per-tick
  // meant most villages only got checked once every (villageCount *
  // loopInterval) — far too infrequent to actually prevent a warehouse or
  // granary from filling up between checks. Set false to restore the old
  // one-village-per-tick behavior.
  resourceOverflowCheckAllEachTick:
    String(process.env.RESOURCE_OVERFLOW_CHECK_ALL_EACH_TICK || "true").toLowerCase() === "true",
  resourceOverflowPivotVillageIds: String(
    process.env.RESOURCE_OVERFLOW_PIVOT_VILLAGE_IDS || ""
  ).trim(),
  npcCropConvertEnabled:
    String(process.env.NPC_CROP_CONVERT_ENABLED || "false").toLowerCase() === "true",
  npcCropConvertMinMinutes: numberEnv("NPC_CROP_CONVERT_MIN_MINUTES", 10),
  npcCropConvertMaxMinutes: numberEnv("NPC_CROP_CONVERT_MAX_MINUTES", 20),
  npcCropConvertGranaryRatio: (() => {
    const raw = Number(process.env.NPC_CROP_CONVERT_GRANARY_RATIO);
    if (Number.isFinite(raw) && raw > 0 && raw < 1) {
      return raw;
    }
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) {
      return raw / 100;
    }
    return 0.95;
  })(),
  npcCropConvertExcludedVillageIds: String(
    process.env.NPC_CROP_CONVERT_EXCLUDED_VILLAGE_IDS || ""
  ).trim(),
  npcCropConvertMarketplaceBuildingId: numberEnv("NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID", 33),
  // Capital granary watcher: checked every NPC Crop Convert tick (regardless
  // of round-robin turn), independent of the other villages' rotation.
  // Requires NPC_CROP_CONVERT_ENABLED=true — it shares that loop's timer.
  capitalGranaryWatcherEnabled:
    String(process.env.CAPITAL_GRANARY_WATCHER_ENABLED || "true").toLowerCase() === "true",
  // Optional threshold override for the capital; falls back to
  // NPC_CROP_CONVERT_GRANARY_RATIO when unset.
  capitalGranaryWatcherRatio: (() => {
    const raw = Number(process.env.CAPITAL_GRANARY_WATCHER_RATIO);
    if (Number.isFinite(raw) && raw > 0 && raw < 1) {
      return raw;
    }
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) {
      return raw / 100;
    }
    return null;
  })(),
  celebrationsRoundRobinEnabled:
    String(process.env.CELEBRATIONS_ROUND_ROBIN_ENABLED || "false").toLowerCase() === "true",
  celebrationsLoopMinMinutes: numberEnv("CELEBRATIONS_LOOP_MIN_MINUTES", 30),
  celebrationsLoopMaxMinutes: numberEnv("CELEBRATIONS_LOOP_MAX_MINUTES", 60),
  celebrationsType: String(process.env.CELEBRATIONS_TYPE || "auto").trim().toLowerCase() || "auto",
  celebrationsQueueDepth: (() => {
    const n = Math.floor(Number(process.env.CELEBRATIONS_QUEUE_DEPTH || 1));
    return n === 2 ? 2 : 1;
  })(),
  celebrationsIncludedVillageIds: String(
    process.env.CELEBRATIONS_INCLUDED_VILLAGE_IDS || ""
  ).trim(),
  celebrationsExcludedVillageIds: String(
    process.env.CELEBRATIONS_EXCLUDED_VILLAGE_IDS || ""
  ).trim(),
  proxyRotateOnSessionRest:
    String(process.env.PROXY_ROTATE_ON_SESSION_REST ?? "true").toLowerCase() !== "false"
};

syncSettingsFromProxyStore(settings);

// Lowest allowed loop interval (minutes). Loops accept fractional minutes
// (e.g. 0.5 = 30s); this floor just guards against 0/negative misconfig
// causing a runaway tight loop.
const MIN_LOOP_MINUTES = 0.1;

function normalizeRange(minValue, maxValue, fallbackMin, fallbackMax) {
  let min = Number.isFinite(minValue) ? minValue : fallbackMin;
  let max = Number.isFinite(maxValue) ? maxValue : fallbackMax;
  min = Math.max(MIN_LOOP_MINUTES, min);
  max = Math.max(MIN_LOOP_MINUTES, max);
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return { min, max };
}

function randomIntBetween(min, max) {
  if (max <= min) {
    return min;
  }
  if (Number.isInteger(min) && Number.isInteger(max)) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  // Fractional bounds (e.g. 0.5-1 minute): sample continuously instead of
  // treating min/max as an inclusive integer range.
  return Math.random() * (max - min) + min;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEnvValue(value) {
  const str = String(value);
  if (/\s|#/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function persistEnvValues(updates) {
  const keys = Object.keys(updates);
  if (!keys.length) {
    return;
  }

  const exists = fs.existsSync(resolvedEnvPath);
  const current = exists ? fs.readFileSync(resolvedEnvPath, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current ? current.split(/\r?\n/) : [];

  const remaining = new Set(keys);

  for (let i = 0; i < lines.length; i += 1) {
    for (const key of keys) {
      const pattern = new RegExp(`^\\s*${key}\\s*=`);
      if (pattern.test(lines[i])) {
        lines[i] = `${key}=${formatEnvValue(updates[key])}`;
        remaining.delete(key);
      }
    }
  }

  for (const key of remaining) {
    lines.push(`${key}=${formatEnvValue(updates[key])}`);
  }

  fs.writeFileSync(resolvedEnvPath, lines.join(eol), "utf8");
}

function persistRuntimeSettings(selectedKeys) {
  const envValues = {
    HEADLESS: settings.headless ? "true" : "false",
    RANDOM_DELAY_MIN_MS: String(settings.randomDelayMinMs),
    RANDOM_DELAY_MAX_MS: String(settings.randomDelayMaxMs),
    FARMLIST_LOOP_ENABLED: settings.farmlistLoopEnabled ? "true" : "false",
    FARMLIST_LOOP_MIN_MINUTES: String(settings.farmlistLoopMinMinutes),
    FARMLIST_LOOP_MAX_MINUTES: String(settings.farmlistLoopMaxMinutes),
    FARMLIST_VILLAGE_ID:
      settings.farmlistVillageId == null ? "" : String(settings.farmlistVillageId),
    SESSION_LOOP_ENABLED: settings.sessionLoopEnabled ? "true" : "false",
    SESSION_PLAY_MIN_MINUTES: String(settings.playMinMinutes),
    SESSION_PLAY_MAX_MINUTES: String(settings.playMaxMinutes),
    SESSION_REST_MIN_MINUTES: String(settings.restMinMinutes),
    SESSION_REST_MAX_MINUTES: String(settings.restMaxMinutes),
    BROWSER_REFRESH_HOURS: String(settings.browserRefreshHours || 0),
    MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES: String(settings.manualPauseAutoUnpauseMinutes),
    TROOP_STABLE_TRAINER_URL: String(settings.troopStableTrainerUrl || ""),
    BUILDER_GOLD_COMPLETE_ENABLED: settings.builderGoldCompleteEnabled ? "true" : "false",
    BUILDER_GOLD_COMPLETE_MAX: String(settings.builderGoldCompleteMax),
    BUILDER_MASTER_BUILDER_ENABLED: settings.builderMasterBuilderEnabled ? "true" : "false",
    RAID_EVACUATION_ENABLED: settings.raidEvacuationEnabled ? "true" : "false",
    RAID_EVACUATION_TROOPS_ENABLED: settings.raidEvacuationTroopsEnabled ? "true" : "false",
    RAID_EVACUATION_TROOP_RECALL_SECONDS: String(settings.raidEvacuationTroopRecallSeconds || 60),
    RAID_EVACUATION_TRIGGER_MINUTES: String(settings.raidEvacuationTriggerMinutes),
    RAID_EVACUATION_RESERVE_PER_RESOURCE: String(settings.raidEvacuationReservePerResource),
    RAID_EVACUATION_MERCHANT_CAPACITY_FALLBACK: String(settings.raidEvacuationMerchantCapacityFallback),
    RAID_EVACUATION_PIVOT_VILLAGE_IDS: String(settings.raidEvacuationPivotVillageIds || ""),
    RAID_EVACUATION_POLL_SECONDS: String(settings.raidEvacuationPollSeconds || 30),
    VILLAGE_SWITCH_DELAY_MS:
      settings.villageSwitchDelayMs == null ? "" : String(settings.villageSwitchDelayMs),
    STATUS_AFTER_FARMLISTS_ENABLED: settings.statusAfterFarmlistsEnabled ? "true" : "false",
    STATUS_AFTER_FARMLISTS_COOLDOWN_MINUTES: String(settings.statusAfterFarmlistsCooldownMinutes),
    BUILDER_LOOP_ENABLED: settings.builderLoopEnabled ? "true" : "false",
    BUILDER_LOOP_MIN_MINUTES: String(settings.builderLoopMinMinutes),
    BUILDER_LOOP_MAX_MINUTES: String(settings.builderLoopMaxMinutes),
    BUILDER_ROUND_ROBIN_ENABLED: settings.builderRoundRobinEnabled ? "true" : "false",
    BUILDER_RR_EXCLUDED_VILLAGE_IDS: String(settings.builderRoundRobinExcludedVillageIds || ""),
    BUILDER_DEFAULT_PLAN_MODE: settings.builderDefaultPlanMode === "village" ? "village" : "resource",
    BUILDER_RR_RESOURCE_THEN_VILLAGE: settings.builderRrResourceThenVillage ? "true" : "false",
    BUILDER_RR_AUTO_EXCLUDE_ON_RESOURCE_COMPLETE: settings.builderRrAutoExcludeOnResourceComplete
      ? "true"
      : "false",
    BUILDER_RR_AUTO_EXCLUDE_BLOCKED_STREAK: String(settings.builderRrAutoExcludeBlockedStreak ?? 12),
    TROOP_TRAINING_ROUND_ROBIN_ENABLED: settings.troopTrainingRoundRobinEnabled ? "true" : "false",
    TROOP_TRAINING_LOOP_MIN_MINUTES: String(settings.troopTrainingLoopMinMinutes),
    TROOP_TRAINING_LOOP_MAX_MINUTES: String(settings.troopTrainingLoopMaxMinutes),
    TROOP_QUEUE_CAP_ENABLED: settings.troopQueueCapEnabled ? "true" : "false",
    TROOP_QUEUE_CAP_HOURS: String(settings.troopQueueCapHours),
    CRANNY_DEFENSE_ROUND_ROBIN_ENABLED: settings.crannyDefenseRoundRobinEnabled ? "true" : "false",
    CRANNY_DEFENSE_LOOP_MIN_MINUTES: String(settings.crannyDefenseLoopMinMinutes || 8),
    CRANNY_DEFENSE_LOOP_MAX_MINUTES: String(settings.crannyDefenseLoopMaxMinutes || 15),
    ACTIVITY_SIMULATION_ENABLED: settings.activitySimulationEnabled ? "true" : "false",
    ACTIVITY_SIMULATION_LOOP_MIN_MINUTES: String(settings.activitySimulationLoopMinMinutes),
    ACTIVITY_SIMULATION_LOOP_MAX_MINUTES: String(settings.activitySimulationLoopMaxMinutes),
    ACTIVITY_SIMULATION_PATTERNS: String(settings.activitySimulationPatterns || ""),
    ACTIVITY_SIMULATION_DWELL_MIN_MS: String(settings.activitySimulationDwellMinMs),
    ACTIVITY_SIMULATION_DWELL_MAX_MS: String(settings.activitySimulationDwellMaxMs),
    TOP10_TRACKING_ENABLED: settings.top10TrackingEnabled ? "true" : "false",
    TOP10_TRACKING_LOOP_MIN_MINUTES: String(settings.top10TrackingLoopMinMinutes),
    TOP10_TRACKING_LOOP_MAX_MINUTES: String(settings.top10TrackingLoopMaxMinutes),
    TOP10_TRACKING_LOG_FILE: String(settings.top10TrackingLogFile || DEFAULT_TOP10_LOG_FILE),
    TOP10_TRACKING_PLAYER_NAME: String(settings.top10TrackingPlayerName || ""),
    DASHBOARD_COMPACT_VIEW: settings.dashboardCompactView ? "true" : "false",
    EXPANSION_AUTO_DISPATCH_ENABLED: settings.expansionAutoDispatchEnabled ? "true" : "false",
    EXPANSION_USE_PLANNED_TARGETS: settings.expansionUsePlannedTargets ? "true" : "false",
    EXPANSION_PLANNED_TARGETS_FILE: String(settings.expansionPlannedTargetsFile || ""),
    RESOURCE_CIRCULATION_ENABLED: settings.resourceCirculationEnabled ? "true" : "false",
    RESOURCE_CIRCULATION_EXPANSION_ENABLED: settings.resourceCirculationExpansionEnabled ? "true" : "false",
    RESOURCE_CIRCULATION_PREFER_NEAREST: settings.resourceCirculationPreferNearest ? "true" : "false",
    RESOURCE_CIRCULATION_RECEIVER_MAX_FILL_RATIO: String(settings.resourceCirculationReceiverMaxFillRatio),
    RESOURCE_CIRCULATION_MAX_DONORS: String(settings.resourceCirculationMaxDonors),
    RESOURCE_CIRCULATION_BUILDER_MAX_DONORS: String(settings.resourceCirculationBuilderMaxDonors),
    RESOURCE_CIRCULATION_BUILDER_MERCHANT_LOADS: String(settings.resourceCirculationBuilderMerchantLoads),
    RESOURCE_CIRCULATION_RESERVE_PER_RESOURCE: String(settings.resourceCirculationReservePerResource),
    RESOURCE_OVERFLOW_GUARD_ENABLED: settings.resourceOverflowGuardEnabled ? "true" : "false",
    RESOURCE_OVERFLOW_TRIGGER_RATIO: String(settings.resourceOverflowTriggerRatio),
    RESOURCE_OVERFLOW_TARGET_RATIO: String(settings.resourceOverflowTargetRatio),
    RESOURCE_OVERFLOW_MAX_DISTANCE: String(settings.resourceOverflowMaxDistance),
    RESOURCE_OVERFLOW_LOOP_MIN_MINUTES: String(settings.resourceOverflowLoopMinMinutes),
    RESOURCE_OVERFLOW_LOOP_MAX_MINUTES: String(settings.resourceOverflowLoopMaxMinutes),
    RESOURCE_OVERFLOW_CHECK_ALL_EACH_TICK: settings.resourceOverflowCheckAllEachTick ? "true" : "false",
    RESOURCE_OVERFLOW_PIVOT_VILLAGE_IDS: String(settings.resourceOverflowPivotVillageIds || ""),
    NPC_CROP_CONVERT_ENABLED: settings.npcCropConvertEnabled ? "true" : "false",
    NPC_CROP_CONVERT_MIN_MINUTES: String(settings.npcCropConvertMinMinutes),
    NPC_CROP_CONVERT_MAX_MINUTES: String(settings.npcCropConvertMaxMinutes),
    NPC_CROP_CONVERT_GRANARY_RATIO: String(settings.npcCropConvertGranaryRatio),
    NPC_CROP_CONVERT_EXCLUDED_VILLAGE_IDS: String(settings.npcCropConvertExcludedVillageIds || ""),
    CAPITAL_GRANARY_WATCHER_ENABLED: settings.capitalGranaryWatcherEnabled ? "true" : "false",
    CAPITAL_GRANARY_WATCHER_RATIO:
      settings.capitalGranaryWatcherRatio == null ? "" : String(settings.capitalGranaryWatcherRatio),
    NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID: String(
      settings.npcCropConvertMarketplaceBuildingId || 33
    ),
    CELEBRATIONS_ROUND_ROBIN_ENABLED: settings.celebrationsRoundRobinEnabled ? "true" : "false",
    CELEBRATIONS_LOOP_MIN_MINUTES: String(settings.celebrationsLoopMinMinutes),
    CELEBRATIONS_LOOP_MAX_MINUTES: String(settings.celebrationsLoopMaxMinutes),
    CELEBRATIONS_TYPE: String(settings.celebrationsType || "auto"),
    CELEBRATIONS_QUEUE_DEPTH: String(
      Math.floor(Number(settings.celebrationsQueueDepth)) === 2 ? 2 : 1
    ),
    CELEBRATIONS_INCLUDED_VILLAGE_IDS: String(settings.celebrationsIncludedVillageIds || ""),
    CELEBRATIONS_EXCLUDED_VILLAGE_IDS: String(settings.celebrationsExcludedVillageIds || ""),
    ...proxyEnvValues(settings)
  };

  if (!selectedKeys || !selectedKeys.length) {
    persistEnvValues(envValues);
    return;
  }

  const filtered = {};
  selectedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(envValues, key)) {
      filtered[key] = envValues[key];
    }
  });

  persistEnvValues(filtered);
}

function applySessionLoopDefaults() {
  const farmlistLoop = normalizeRange(
    settings.farmlistLoopMinMinutes,
    settings.farmlistLoopMaxMinutes,
    10,
    20
  );
  settings.farmlistLoopMinMinutes = farmlistLoop.min;
  settings.farmlistLoopMaxMinutes = farmlistLoop.max;

  const builderLoop = normalizeRange(
    settings.builderLoopMinMinutes,
    settings.builderLoopMaxMinutes,
    0.5,
    1
  );
  settings.builderLoopMinMinutes = builderLoop.min;
  settings.builderLoopMaxMinutes = builderLoop.max;

  settings.builderDefaultPlanMode =
    String(settings.builderDefaultPlanMode || "resource").toLowerCase() === "village"
      ? "village"
      : "resource";

  const troopTrainingLoop = normalizeRange(
    settings.troopTrainingLoopMinMinutes,
    settings.troopTrainingLoopMaxMinutes,
    5,
    10
  );
  settings.troopTrainingLoopMinMinutes = troopTrainingLoop.min;
  settings.troopTrainingLoopMaxMinutes = troopTrainingLoop.max;

  const crannyDefenseLoop = normalizeRange(
    settings.crannyDefenseLoopMinMinutes,
    settings.crannyDefenseLoopMaxMinutes,
    8,
    15
  );
  settings.crannyDefenseLoopMinMinutes = crannyDefenseLoop.min;
  settings.crannyDefenseLoopMaxMinutes = crannyDefenseLoop.max;

  const activitySimulationLoop = normalizeRange(
    settings.activitySimulationLoopMinMinutes,
    settings.activitySimulationLoopMaxMinutes,
    20,
    45
  );
  settings.activitySimulationLoopMinMinutes = activitySimulationLoop.min;
  settings.activitySimulationLoopMaxMinutes = activitySimulationLoop.max;
  settings.activitySimulationPatterns = serializeActivityPatterns(
    parseActivityPatterns(settings.activitySimulationPatterns)
  );
  settings.activitySimulationDwellMinMs = Math.max(
    500,
    Math.floor(Number(settings.activitySimulationDwellMinMs) || 2000)
  );
  settings.activitySimulationDwellMaxMs = Math.max(
    settings.activitySimulationDwellMinMs,
    Math.floor(Number(settings.activitySimulationDwellMaxMs) || 6000)
  );

  const npcCropConvertLoop = normalizeRange(
    settings.npcCropConvertMinMinutes,
    settings.npcCropConvertMaxMinutes,
    10,
    20
  );
  settings.npcCropConvertMinMinutes = npcCropConvertLoop.min;
  settings.npcCropConvertMaxMinutes = npcCropConvertLoop.max;
  {
    const raw = Number(settings.npcCropConvertGranaryRatio);
    if (Number.isFinite(raw) && raw > 0 && raw < 1) {
      settings.npcCropConvertGranaryRatio = raw;
    } else if (Number.isFinite(raw) && raw >= 1 && raw <= 100) {
      settings.npcCropConvertGranaryRatio = raw / 100;
    } else {
      settings.npcCropConvertGranaryRatio = 0.95;
    }
  }
  settings.npcCropConvertExcludedVillageIds = String(
    settings.npcCropConvertExcludedVillageIds || ""
  ).trim();
  {
    const buildingId = Math.floor(Number(settings.npcCropConvertMarketplaceBuildingId) || 33);
    settings.npcCropConvertMarketplaceBuildingId =
      Number.isFinite(buildingId) && buildingId > 0 ? buildingId : 33;
  }

  {
    const overflowLoop = normalizeRange(
      settings.resourceOverflowLoopMinMinutes,
      settings.resourceOverflowLoopMaxMinutes,
      8,
      15
    );
    settings.resourceOverflowLoopMinMinutes = overflowLoop.min;
    settings.resourceOverflowLoopMaxMinutes = overflowLoop.max;
    const normRatio = (raw, fallback) => {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < 1) return n;
      if (Number.isFinite(n) && n >= 1 && n <= 100) return n / 100;
      return fallback;
    };
    settings.resourceOverflowTriggerRatio = normRatio(settings.resourceOverflowTriggerRatio, 0.9);
    settings.resourceOverflowTargetRatio = normRatio(settings.resourceOverflowTargetRatio, 0.75);
    if (settings.resourceOverflowTargetRatio > settings.resourceOverflowTriggerRatio) {
      settings.resourceOverflowTargetRatio = Math.max(
        0.05,
        settings.resourceOverflowTriggerRatio - 0.1
      );
    }
    settings.resourceOverflowMaxDistance = Math.max(
      1,
      Math.floor(Number(settings.resourceOverflowMaxDistance) || 10)
    );
    settings.resourceOverflowPivotVillageIds = String(
      settings.resourceOverflowPivotVillageIds || ""
    ).trim();
    settings.resourceOverflowGuardEnabled = Boolean(settings.resourceOverflowGuardEnabled);
  }

  const celebrationsLoop = normalizeRange(
    settings.celebrationsLoopMinMinutes,
    settings.celebrationsLoopMaxMinutes,
    30,
    60
  );
  settings.celebrationsLoopMinMinutes = celebrationsLoop.min;
  settings.celebrationsLoopMaxMinutes = celebrationsLoop.max;
  {
    const raw = String(settings.celebrationsType || "auto")
      .trim()
      .toLowerCase();
    settings.celebrationsType =
      raw === "small" || raw === "large" || raw === "great"
        ? raw === "great"
          ? "large"
          : raw
        : "auto";
  }
  {
    const depth = Math.floor(Number(settings.celebrationsQueueDepth));
    settings.celebrationsQueueDepth = depth === 2 ? 2 : 1;
  }
  settings.celebrationsIncludedVillageIds = String(
    settings.celebrationsIncludedVillageIds || ""
  ).trim();
  settings.celebrationsExcludedVillageIds = String(
    settings.celebrationsExcludedVillageIds || ""
  ).trim();

  const play = normalizeRange(settings.playMinMinutes, settings.playMaxMinutes, 60, 120);
  settings.playMinMinutes = play.min;
  settings.playMaxMinutes = play.max;

  const rest = normalizeRange(settings.restMinMinutes, settings.restMaxMinutes, 5, 15);
  settings.restMinMinutes = rest.min;
  settings.restMaxMinutes = rest.max;
  settings.manualPauseAutoUnpauseMinutes = Math.max(
    0,
    Math.min(120, Math.floor(Number(settings.manualPauseAutoUnpauseMinutes) || 0))
  );
}

function isHeadlessLaunchError(error) {
  const message = String((error && error.message) || error || "");
  return (
    message.includes("spawn EFTYPE") ||
    message.includes("chromium_headless_shell") ||
    message.includes("Executable doesn't exist")
  );
}

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function rewriteGameUrlHost(url, gameOrigin) {
  if (!url || !gameOrigin) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const base = new URL(gameOrigin);
    if (parsed.host === base.host) {
      return url;
    }
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch (_error) {
    return url;
  }
}

function syncSettingsGameHostFromPage(page, settings) {
  let origin;
  try {
    const parsed = new URL(page.url());
    // Only realm hosts (s1.nexian.world, …). Never the marketing portal —
    // nexian.world/village2.php redirects there and would poison all game URLs.
    if (/^s\d+\.nexian\.world$/i.test(parsed.hostname)) {
      origin = parsed.origin;
    } else {
      return null;
    }
  } catch (_error) {
    return null;
  }

  [
    "farmlistUrl",
    "villageBuilderUrl",
    "troopTrainerUrl",
    "troopStableTrainerUrl",
    "villageStatusUrl",
    "logoutUrl"
  ].forEach((key) => {
    if (settings[key]) {
      settings[key] = rewriteGameUrlHost(settings[key], origin);
    }
  });

  return origin;
}

async function selectPortalRealm(page, serverId = PORTAL_SERVER_ID) {
  if (!serverId) {
    return false;
  }

  // Prefer the realm card Login that calls openLogin('s1') / openLogin('s2').
  // A generic first "Login" button on the page is usually Speed (s2).
  const opened = await page.evaluate((id) => {
    const want = String(id || "").toLowerCase();
    if (!want) {
      return { ok: false, how: "no-id" };
    }

    const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const byClickAttr = buttons.find((el) => {
      const click = el.getAttribute("@click") || el.getAttribute("x-on:click") || "";
      return new RegExp(`openLogin\\(['"]${want}['"]\\)`, "i").test(click);
    });
    if (byClickAttr && byClickAttr.offsetParent !== null) {
      byClickAttr.click();
      return { ok: true, how: "openLogin-attr" };
    }

    // Alpine component API when present on the journey modal root.
    try {
      const roots = Array.from(document.querySelectorAll("[x-data]"));
      for (const root of roots) {
        const stack = root._x_dataStack;
        const data = stack && stack[0];
        if (data && typeof data.openLogin === "function") {
          data.openLogin(want);
          return { ok: true, how: "alpine-openLogin" };
        }
      }
    } catch (_error) {
      // ignore
    }

    // Last resort: set serverId + login view if Alpine state is already live.
    try {
      const roots = Array.from(document.querySelectorAll("[x-data]"));
      for (const root of roots) {
        const stack = root._x_dataStack;
        const data = stack && stack[0];
        if (data && Object.prototype.hasOwnProperty.call(data, "serverId")) {
          data.serverId = want;
          if (Object.prototype.hasOwnProperty.call(data, "view")) {
            data.view = "login";
          }
          if (Object.prototype.hasOwnProperty.call(data, "journey")) {
            data.journey = true;
          }
          return { ok: true, how: "alpine-serverId" };
        }
      }
    } catch (_error) {
      // ignore
    }

    return { ok: false, how: "none" };
  }, serverId);

  if (opened && opened.ok) {
    console.log(`  Portal realm: ${serverId} (${opened.how})`);
    return true;
  }
  return false;
}

async function ensurePortalLoginTargetsRealm(page, serverId = PORTAL_SERVER_ID) {
  if (!serverId) {
    return;
  }

  await page.evaluate((id) => {
    const want = String(id || "").toLowerCase();
    if (!want) {
      return;
    }
    const servers = window.__nexianServers || {};
    const entry = servers[want];
    const base = entry && entry.baseUrl ? String(entry.baseUrl).replace(/\/+$/, "") : "";
    const action = base ? `${base}/index.php?from=apex` : "";

    try {
      const roots = Array.from(document.querySelectorAll("[x-data]"));
      for (const root of roots) {
        const stack = root._x_dataStack;
        const data = stack && stack[0];
        if (data && Object.prototype.hasOwnProperty.call(data, "serverId")) {
          data.serverId = want;
        }
      }
    } catch (_error) {
      // ignore
    }

    const loginForm = document.querySelector("form.jform-login, form.journey-form.jform-login");
    if (loginForm && action) {
      loginForm.setAttribute("action", action);
      try {
        loginForm.action = action;
      } catch (_error) {
        // ignore
      }
    }

    const hiddenServer = document.querySelector(
      'form.jform-login input[name="server_id"], form.journey-form input[name="server_id"]'
    );
    if (hiddenServer) {
      hiddenServer.value = want;
    }
  }, serverId);
}

async function openNexianPortalLoginForm(page) {
  const portalUser = page.locator('input[placeholder="Enter your username"]');
  if (await portalUser.isVisible().catch(() => false)) {
    await ensurePortalLoginTargetsRealm(page);
    return;
  }

  const playNow = page.getByRole("link", { name: /Play Now/i });
  if (await playNow.count()) {
    await playNow.first().click({ timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(400);
  }

  const realmOpened = await selectPortalRealm(page);
  if (!realmOpened) {
    // Fallback: first visible Login (often s2) — realm is corrected before submit.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (el) => /^login$/i.test((el.textContent || "").trim()) && el.offsetParent !== null
      );
      if (btn) {
        btn.click();
      }
    });
  }

  await portalUser.waitFor({ state: "visible", timeout: 30000 });
  await ensurePortalLoginTargetsRealm(page);
}

function isGameRealmHost(url) {
  try {
    return /^s\d+\.nexian\.world$/i.test(new URL(url).hostname);
  } catch (_error) {
    return false;
  }
}

async function waitForGameLogin(page, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : 90000;
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(100, Number(options.pollMs))
    : 500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await isLoggedIntoGame(page)) {
      return true;
    }

    if (isGameRealmHost(page.url())) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      if (await isLoggedIntoGame(page)) {
        return true;
      }
    }

    await page.waitForTimeout(pollMs);
  }

  return false;
}

async function ensureLoggedInAtVillagePage(page, options = {}) {
  if (await isLoggedIntoGame(page)) {
    return true;
  }

  if (isGameRealmHost(page.url())) {
    const origin = new URL(page.url()).origin;
    const targets = [
      settings.villageStatusUrl,
      `${origin}/dorf1.php`,
      `${origin}/village1.php`
    ].filter(Boolean);
    for (const target of targets) {
      if (await isLoggedIntoGame(page)) {
        return true;
      }
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    }
    if (await isLoggedIntoGame(page)) {
      return true;
    }
  }

  return waitForGameLogin(page, {
    timeoutMs: options.timeoutMs ?? 15000,
    pollMs: options.pollMs ?? 250
  });
}

async function finalizeSuccessfulLogin(page, context, label = "Login OK") {
  console.log(`  ${label}`);
  const gameOrigin = syncSettingsGameHostFromPage(page, settings);
  if (gameOrigin) {
    console.log(`  Game host: ${gameOrigin}`);
  }
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log("  Session saved");
}

async function tryOpenStoredSession(browser, effectiveHeadless) {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    return null;
  }

  let context = null;
  try {
    console.log("  Restoring saved session...");
    context = await browser.newContext({ storageState: STORAGE_STATE_PATH, locale: "en-US" });
    await applyContextSpeedups(context);
    const page = await context.newPage();
    const startUrl = settings.villageStatusUrl || `${GAME_HOST}/dorf1.php`;
    // A transient blip here used to throw away a perfectly good saved
    // session and force a full fresh login — retry first instead.
    await safeGotoWithRetry(page, startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }, 2);
    if (/shownew|show_news/i.test(String(page.url() || ""))) {
      await safeGotoWithRetry(page, startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }, 1).catch(() => null);
    }
    if (!(await ensureLoggedInAtVillagePage(page, { timeoutMs: 12000 }))) {
      await context.close().catch(() => null);
      return null;
    }
    await finalizeSuccessfulLogin(page, context, "Login OK (saved session)");
    return { browser, context, page, headless: effectiveHeadless };
  } catch (_error) {
    if (context) {
      await context.close().catch(() => null);
    }
    return null;
  }
}

async function submitPortalLogin(page) {
  await ensurePortalLoginTargetsRealm(page);

  const enterRealm = page
    .locator('form.jform-login button[type="submit"], form.journey-form.jform-login button.journey-submit')
    .or(page.getByRole("button", { name: /Enter Realm/i }))
    .first();
  await enterRealm.waitFor({ state: "visible", timeout: 20000 });

  if (PORTAL_SERVER_ID) {
    const actionHost = await page.evaluate(() => {
      const form = document.querySelector("form.jform-login, form.journey-form.jform-login");
      try {
        return form ? new URL(form.action, location.href).hostname : "";
      } catch (_error) {
        return "";
      }
    });
    const expectedHost = (() => {
      try {
        return new URL(GAME_HOST).hostname.toLowerCase();
      } catch (_error) {
        return "";
      }
    })();
    if (actionHost && expectedHost && actionHost.toLowerCase() !== expectedHost) {
      console.log(
        `  Portal form action host ${actionHost} != ${expectedHost}; forcing ${PORTAL_SERVER_ID}`
      );
      await ensurePortalLoginTargetsRealm(page);
    } else if (expectedHost) {
      console.log(`  Portal login → ${actionHost || expectedHost}`);
    }
  }

  const navigationPromise = page
    .waitForURL(
      (url) => {
        try {
          const parsed = typeof url === "string" ? new URL(url) : url;
          if (/^s\d+\.nexian\.world$/i.test(parsed.hostname)) {
            return true;
          }
          return /village\d\.php|dorf\d\.php|build\.php|spieler\.php/i.test(parsed.pathname);
        } catch (_error) {
          return false;
        }
      },
      { timeout: 45000, waitUntil: "domcontentloaded" }
    )
    .catch(() => null);

  await enterRealm.evaluate((button) => button.click());
  await navigationPromise;
  if (!(await ensureLoggedInAtVillagePage(page))) {
    throw new Error(
      `Login did not reach the game after Enter Realm (still at ${page.url()}).` +
        (PORTAL_SERVER_ID ? ` Expected realm ${PORTAL_SERVER_ID} (${GAME_HOST}).` : "")
    );
  }
  return true;
}

async function submitLegacyLogin(page) {
  const submit = page.locator(
    'form[name="login"] button[type="submit"], form[name="login"] input[type="submit"]'
  );
  await submit.waitFor({ state: "visible", timeout: 30000 });

  const navigationPromise = page
    .waitForURL(
      (url) => {
        try {
          const parsed = typeof url === "string" ? new URL(url) : url;
          if (/^s\d+\.nexian\.world$/i.test(parsed.hostname)) {
            return true;
          }
          return /village\d\.php|dorf\d\.php|build\.php|spieler\.php/i.test(parsed.pathname);
        } catch (_error) {
          return false;
        }
      },
      { timeout: 90000, waitUntil: "domcontentloaded" }
    )
    .catch(() => null);

  await submit.evaluate((el) => el.click());
  await navigationPromise;
  if (!(await ensureLoggedInAtVillagePage(page))) {
    throw new Error(
      `Login did not reach the game after submit (still at ${page.url()}).`
    );
  }
  return true;
}

async function isLoggedIntoGame(page) {
  const url = page.url();
  try {
    const parsed = new URL(url);
    if (/^s\d+\.nexian\.world$/i.test(parsed.hostname)) {
      return /village\d\.php|dorf\d\.php|build\.php|spieler\.php/i.test(parsed.pathname);
    }
  } catch (_error) {
    return false;
  }

  const legacyLoginVisible = await page.locator('form[name="login"]').isVisible().catch(() => false);
  if (legacyLoginVisible) {
    return false;
  }

  const portalLoginVisible = await page
    .locator('input[placeholder="Enter your username"]')
    .isVisible()
    .catch(() => false);
  if (portalLoginVisible) {
    return false;
  }

  return /village\d\.php|dorf\d\.php|build\.php|spieler\.php/i.test(url);
}

if (
  !hasRealCredential(USERNAME, "your_username_here") ||
  !hasRealCredential(PASSWORD, "your_password_here")
) {
  console.error(
    `Missing credentials. Set real NEXIAN_USERNAME and NEXIAN_PASSWORD in ${envFile}.`
  );
  process.exit(1);
}

async function loginToPage(page, context) {
  console.log(`  Opening ${LOGIN_URL} ...`);
  // The very first navigation of the whole run — a transient network blip
  // here (ERR_TIMED_OUT, DNS hiccup, etc.) used to fail the entire login
  // outright with no retry. Give it the same retry/backoff treatment as
  // every in-game navigation already gets.
  await safeGotoWithRetry(page, LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }, 3);

  const legacyForm = page.locator('form[name="login"]');
  const onLegacyLogin = await legacyForm.isVisible().catch(() => false);

  if (onLegacyLogin) {
    await page.fill('form[name="login"] input[name="name"]', USERNAME);
    await page.fill('form[name="login"] input[name="password"]', PASSWORD);
    await submitLegacyLogin(page);
  } else {
    await openNexianPortalLoginForm(page);
    await page.locator('input[placeholder="Enter your username"]').fill(USERNAME);
    await page.locator('input[placeholder="Enter your password"]').fill(PASSWORD);
    await submitPortalLogin(page);
  }

  if (await isLoggedIntoGame(page)) {
    await finalizeSuccessfulLogin(page, context);
  } else {
    const stuckUrl = page.url();
    throw new Error(
      `Login did not reach the game (still at ${stuckUrl}). Check credentials or portal UI changes.`
    );
  }
}

async function createSession(headless) {
  let effectiveHeadless = headless;
  let browser;
  let browserLabel = headless ? "headless" : "headed";
  const launchArgs = [
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--mute-audio"
  ];

  const launchChromium = (options) => chromium.launch({ args: launchArgs, ...options });
  const playwrightProxy = getPlaywrightProxy(settings);
  const proxyLaunchOptions = playwrightProxy ? { proxy: playwrightProxy } : {};

  if (!effectiveHeadless) {
    browser = await launchChromium({ headless: false, ...proxyLaunchOptions });
  } else {
    try {
      browser = await launchChromium({ headless: true, ...proxyLaunchOptions });
    } catch (error) {
      if (!isHeadlessLaunchError(error)) {
        throw error;
      }

      try {
        browser = await launchChromium({ channel: "chrome", headless: true, ...proxyLaunchOptions });
        browserLabel = "headless (chrome channel)";
      } catch (chromeError) {
        effectiveHeadless = false;
        browser = await launchChromium({ headless: false, ...proxyLaunchOptions });
        browserLabel = "headed (fallback)";
      }
    }
  }

  console.log(`\n  Env:     ${path.basename(resolvedEnvPath)}`);
  console.log(`  Browser: ${browserLabel}`);
  console.log(`  Proxy:   ${formatProxyDisplay(settings)}`);

  const restored = await tryOpenStoredSession(browser, effectiveHeadless);
  if (restored) {
    return restored;
  }

  // locale drives the Accept-Language header Chromium sends on every
  // request, which is what the portal actually uses to pick a language —
  // confirmed live and by direct testing: a session with a non-English
  // Accept-Language rendered the entire portal (realm cards, login modal)
  // in Hebrew, breaking every English-text selector (e.g.
  // input[placeholder="Enter your username"]) and timing out logins that
  // had nothing wrong with them otherwise. The portal's own setlang= URL
  // param turned out unreliable in isolation — Accept-Language wins when
  // they disagree — so this is the actual fix, not that.
  const context = await browser.newContext({ locale: "en-US" });
  await applyContextSpeedups(context);
  const page = await context.newPage();
  try {
    await loginToPage(page, context);
  } catch (error) {
    await captureLoginFailureDiagnostics(page, error).catch(() => {});
    throw error;
  }
  return { browser, context, page, headless: effectiveHeadless };
}

/**
 * Login failures are especially hard to diagnose headless (Termux/CI) — no
 * window to look at when e.g. a portal DOM change or a slow page load makes
 * a selector time out. Save a screenshot + the failing URL so the next
 * report has evidence to root-cause from, instead of just an error message
 * and a locator string.
 */
async function captureLoginFailureDiagnostics(page, error) {
  if (!page || page.isClosed()) {
    return;
  }
  const dir = path.join(process.cwd(), "debug");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_dirError) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(dir, `login-failure-${stamp}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 });
    console.error(`  [Login] Failure screenshot saved: ${screenshotPath}`);
  } catch (_screenshotError) {
    // Best effort — page may already be unresponsive if this is what failed.
  }
  try {
    console.error(`  [Login] Failure URL: ${page.url()}`);
  } catch (_urlError) {
    // ignore
  }
  console.error(`  [Login] Failure reason: ${error && error.message ? error.message : error}`);
}

async function run() {
  applySessionLoopDefaults();

  let session;
  let startupPhase = "login";
  let sessionLoopTimer = null;
  let nextSessionCycleAt = null;
  let loopStopped = false;
  let sessionCycleInProgress = false;
  let sessionCycleReason = "resting";
  let reloginInProgressPromise = null;
  let manualAutomationPaused = false;
  let manualAutomationPausedAtMs = null;
  let browserRefreshTimer = null;
  let nextBrowserRefreshAt = null;
  let automationIdleWaiter = null;
  let dashboardServer = null;
  let dashboardBridge = null;
  let dashboardAccount = null;
  const presenceLogFile = sessionPresence.resolveLogFilePath(settings);

  const presenceProxyMeta = () => {
    const store = proxyPool.loadStore();
    const active = proxyPool.getActiveProxy(store);
    return {
      proxyServer:
        (active && active.server) ||
        String(settings.proxyServer || "").trim() ||
        null,
      proxyDisplay: formatProxyDisplay(settings, store)
    };
  };

  const recordPresenceOffline = (reason) => {
    const ended = sessionPresence.endActivePeriod(
      { endReason: reason, ...presenceProxyMeta() },
      presenceLogFile
    );
    if (ended) {
      console.log(
        `[Presence] Offline ${ended.startedAt} → ${ended.endedAt}` +
          ` · IP ${ended.publicIp || "unknown"}` +
          ` · ${ended.proxyDisplay}` +
          ` · ${ended.durationLabel}` +
          ` (${ended.endReason})`
      );
    }
    return ended;
  };

  const recordPresenceOnline = async (reason, activeSession = session) => {
    const meta = presenceProxyMeta();
    const period = sessionPresence.startPeriod(
      {
        startReason: reason,
        publicIp: null,
        ...meta
      },
      presenceLogFile
    );
    console.log(
      `[Presence] Online from ${period.startedAt}` +
        ` · ${meta.proxyDisplay}` +
        ` (${period.startReason})`
    );

    // Resolve egress IP in the background (via browser proxy when available).
    Promise.resolve()
      .then(async () => {
        const ip = await sessionPresence.resolvePublicIp(activeSession);
        if (!ip) {
          return;
        }
        const updated = sessionPresence.updateActivePeriod(
          { publicIp: ip },
          presenceLogFile
        );
        if (updated && updated.id === period.id) {
          console.log(`[Presence] Egress IP ${ip}`);
          if (dashboardAccount) {
            dashboardAccount.publicAddress = ip;
          }
          if (dashboardBridge) {
            dashboardBridge.publishSnapshot({ force: true });
          }
        }
      })
      .catch(() => null);

    return period;
  };

  const getSessionPresenceReport = (options = {}) =>
    sessionPresence.buildReport({ ...options, settings }, presenceLogFile);

  const cancelSessionLoopTimer = () => {
    if (sessionLoopTimer) {
      clearTimeout(sessionLoopTimer);
      sessionLoopTimer = null;
    }
    nextSessionCycleAt = null;
  };

  const scheduleNextSessionCycle = () => {
    cancelSessionLoopTimer();
    if (!settings.sessionLoopEnabled || loopStopped) {
      return;
    }

    const playMinutes = randomIntBetween(settings.playMinMinutes, settings.playMaxMinutes);
    nextSessionCycleAt = Date.now() + playMinutes * 60 * 1000;
    console.log(`[Session Loop] Next cycle in ${playMinutes} minute(s).`);

    sessionLoopTimer = setTimeout(async () => {
      if (!settings.sessionLoopEnabled || loopStopped || sessionCycleInProgress) {
        scheduleNextSessionCycle();
        return;
      }

      sessionCycleInProgress = true;
      sessionCycleReason = "resting";
      try {
        const pool = proxyPool.loadStore();
        const willRotate =
          settings.proxyRotateOnSessionRest && Array.isArray(pool.proxies) && pool.proxies.length > 1;
        console.log(
          "[Session Loop] Logging off current session..." +
            (willRotate
              ? ` (will rotate proxy on wake — pool ${pool.proxies.length})`
              : pool.proxies && pool.proxies.length
                ? " (same proxy on wake)"
                : " (direct / no proxy pool)")
        );
        recordPresenceOffline("session_rest");
        await session.page.goto(settings.logoutUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000
        }).catch(() => null);

        await session.browser.close();

        const restMinutes = randomIntBetween(settings.restMinMinutes, settings.restMaxMinutes);
        console.log(`[Session Loop] Resting for ${restMinutes} minute(s)...`);
        await waitMs(restMinutes * 60 * 1000);

        if (loopStopped) {
          return;
        }

        prepareProxyForSessionRestRelogin({ rotate: true });

        const loginWithTimeout = async (label) => {
          const timeoutMs = 180000;
          let timer = null;
          try {
            return await Promise.race([
              createSession(settings.headless),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
                  timeoutMs
                );
              })
            ]);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
        };

        let nextSession = null;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            console.log(`[Session Loop] Wake login attempt ${attempt}/3...`);
            nextSession = await loginWithTimeout(`session wake login #${attempt}`);
            break;
          } catch (error) {
            lastError = error;
            console.error(
              `[Session Loop] Wake login attempt ${attempt}/3 failed: ${error.message || error}`
            );
            if (attempt < 3) {
              // Same proxy — do not rotate again or we skip pool addresses.
              prepareProxyForSessionRestRelogin({ rotate: false });
              await waitMs(5000);
            }
          }
        }
        if (!nextSession) {
          throw lastError || new Error("Session wake login failed.");
        }
        session = nextSession;
        settings.headless = nextSession.headless;
        console.log(
          `[Session Loop] Re-login complete. Session resumed via ${formatProxyDisplay(settings)}.`
        );
        await recordPresenceOnline("session_wake", nextSession);
        if (dashboardBridge) {
          dashboardBridge.publishSnapshot({ force: true });
        }
      } catch (error) {
        console.error("[Session Loop] Cycle failed:", error.message || error);
      } finally {
        sessionCycleInProgress = false;
        sessionCycleReason = null;
        scheduleNextSessionCycle();
      }
    }, playMinutes * 60 * 1000);
  };

  const updateSessionLoopConfig = async (nextConfig) => {
    if (nextConfig.enabled !== undefined) {
      settings.sessionLoopEnabled =
        nextConfig.enabled === true || String(nextConfig.enabled).toLowerCase() === "true";
    }

    const play = normalizeRange(
      nextConfig.playMinMinutes !== undefined
        ? Number(nextConfig.playMinMinutes)
        : settings.playMinMinutes,
      nextConfig.playMaxMinutes !== undefined
        ? Number(nextConfig.playMaxMinutes)
        : settings.playMaxMinutes,
      settings.playMinMinutes,
      settings.playMaxMinutes
    );
    settings.playMinMinutes = play.min;
    settings.playMaxMinutes = play.max;

    const rest = normalizeRange(
      nextConfig.restMinMinutes !== undefined
        ? Number(nextConfig.restMinMinutes)
        : settings.restMinMinutes,
      nextConfig.restMaxMinutes !== undefined
        ? Number(nextConfig.restMaxMinutes)
        : settings.restMaxMinutes,
      settings.restMinMinutes,
      settings.restMaxMinutes
    );
    settings.restMinMinutes = rest.min;
    settings.restMaxMinutes = rest.max;

    if (
      nextConfig.proxyRotateOnSessionRest !== undefined ||
      nextConfig.rotateOnSessionRest !== undefined
    ) {
      const raw =
        nextConfig.proxyRotateOnSessionRest !== undefined
          ? nextConfig.proxyRotateOnSessionRest
          : nextConfig.rotateOnSessionRest;
      settings.proxyRotateOnSessionRest =
        raw === true || String(raw).toLowerCase() === "true";
    }

    persistRuntimeSettings([
      "SESSION_LOOP_ENABLED",
      "SESSION_PLAY_MIN_MINUTES",
      "SESSION_PLAY_MAX_MINUTES",
      "SESSION_REST_MIN_MINUTES",
      "SESSION_REST_MAX_MINUTES",
      "PROXY_ROTATE_ON_SESSION_REST"
    ]);

    scheduleNextSessionCycle();

    if (dashboardBridge) {
      dashboardBridge.publishSnapshot({ force: true });
    }

    return getSessionLoopStatus();
  };

  const getSessionLoopStatus = () => {
    const nextInMinutes = nextSessionCycleAt
      ? Math.max(0, Math.ceil((nextSessionCycleAt - Date.now()) / 60000))
      : null;
    const store = proxyPool.loadStore();
    const poolCount = Array.isArray(store.proxies) ? store.proxies.length : 0;
    const activeIndex = poolCount ? Number(store.activeIndex) || 0 : null;

    return {
      enabled: settings.sessionLoopEnabled,
      nextInMinutes,
      playMinMinutes: settings.playMinMinutes,
      playMaxMinutes: settings.playMaxMinutes,
      restMinMinutes: settings.restMinMinutes,
      restMaxMinutes: settings.restMaxMinutes,
      proxyRotateOnSessionRest: settings.proxyRotateOnSessionRest !== false,
      proxyPoolCount: poolCount,
      proxyActiveIndex: activeIndex,
      proxyActiveDisplay: formatProxyDisplay(settings, store),
      proxyWillRotateOnRest:
        settings.proxyRotateOnSessionRest !== false && poolCount > 1
    };
  };

  const cancelBrowserRefreshTimer = () => {
    if (browserRefreshTimer) {
      clearTimeout(browserRefreshTimer);
      browserRefreshTimer = null;
    }
    nextBrowserRefreshAt = null;
  };

  const getBrowserRefreshStatus = () => {
    const hours = Number(settings.browserRefreshHours) || 0;
    if (hours <= 0) {
      return { enabled: false, hours: 0, nextInMinutes: null };
    }
    return {
      enabled: true,
      hours,
      nextInMinutes: nextBrowserRefreshAt
        ? Math.max(0, Math.ceil((nextBrowserRefreshAt - Date.now()) / 60000))
        : null
    };
  };

  const scheduleBrowserRefresh = (delayMs = null) => {
    cancelBrowserRefreshTimer();
    const hours = Number(settings.browserRefreshHours) || 0;
    if (hours <= 0 || loopStopped) {
      return;
    }

    const waitMs =
      Number.isFinite(Number(delayMs)) && Number(delayMs) > 0
        ? Math.floor(Number(delayMs))
        : hours * 60 * 60 * 1000;
    nextBrowserRefreshAt = Date.now() + waitMs;
    const label =
      waitMs >= 60 * 60 * 1000
        ? `${Math.round(waitMs / (60 * 60 * 1000))} hour(s)`
        : `${Math.max(1, Math.round(waitMs / 60000))} minute(s)`;
    console.log(`[Browser Refresh] Next Chromium restart in ${label}.`);

    browserRefreshTimer = setTimeout(async () => {
      browserRefreshTimer = null;
      if (loopStopped || hours <= 0) {
        return;
      }

      try {
        console.log("[Browser Refresh] Uptime limit reached — restarting browser to free memory...");
        if (typeof automationIdleWaiter === "function") {
          const idle = await automationIdleWaiter("Browser refresh", { maxWaitMs: 300000 });
          if (!idle) {
            console.warn("[Browser Refresh] Session still busy — retrying in 15 minute(s).");
            scheduleBrowserRefresh(15 * 60 * 1000);
            return;
          }
        }
        await reloginNow("browser_refresh");
      } catch (error) {
        console.warn(`[Browser Refresh] Failed: ${error.message || error}`);
        scheduleBrowserRefresh(15 * 60 * 1000);
        return;
      }

      scheduleBrowserRefresh();
    }, waitMs);

    if (typeof browserRefreshTimer.unref === "function") {
      browserRefreshTimer.unref();
    }
  };

  const getAutomationStatus = () => {
    const pageClosed = !session || !session.page || session.page.isClosed();

    if (manualAutomationPaused) {
      const manualPauseMinutes = Math.max(
        0,
        Math.floor(Number(settings.manualPauseAutoUnpauseMinutes) || 0)
      );

      if (manualPauseMinutes <= 0) {
        return { paused: true, reason: "manual_pause" };
      }

      const autoUnpauseAfterMs = manualPauseMinutes * 60 * 1000;
      const pausedAtMs = Number(manualAutomationPausedAtMs) || Date.now();

      if (Date.now() - pausedAtMs >= autoUnpauseAfterMs) {
        manualAutomationPaused = false;
        manualAutomationPausedAtMs = null;
        console.log(
          `[Automation] Auto-unpaused after ${manualPauseMinutes} minute(s) (manual pause timeout).`
        );
      } else {
        return { paused: true, reason: "manual_pause" };
      }
    }
    if (loopStopped) {
      return { paused: true, reason: "stopped" };
    }
    if (sessionCycleInProgress) {
      return { paused: true, reason: sessionCycleReason || "resting" };
    }
    if (pageClosed) {
      return { paused: true, reason: "reconnecting" };
    }

    return { paused: false, reason: "online" };
  };

  const setAutomationPaused = (paused) => {
    manualAutomationPaused = Boolean(paused);
    manualAutomationPausedAtMs = manualAutomationPaused ? Date.now() : null;
    return getAutomationStatus();
  };

  const reloginNow = async (reason = "manual") => {
    if (loopStopped) {
      throw new Error("Session manager is stopping; cannot re-login now.");
    }

    if (reloginInProgressPromise) {
      return reloginInProgressPromise;
    }

    reloginInProgressPromise = (async () => {
      sessionCycleInProgress = true;
      sessionCycleReason = "relogin";
      cancelSessionLoopTimer();

      const previousSession = session;
      try {
        console.log(`[Session] Re-login requested (${reason}).`);
        recordPresenceOffline(`relogin_${reason}`);

        if (previousSession && previousSession.page && !previousSession.page.isClosed()) {
          await previousSession.page.goto(settings.logoutUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15000
          }).catch(() => null);
        }

        if (previousSession && previousSession.browser) {
          await previousSession.browser.close().catch(() => null);
        }

        const nextSession = await createSession(settings.headless);
        session = nextSession;
        settings.headless = nextSession.headless;
        console.log("[Session] Re-login complete.");
        await recordPresenceOnline(`relogin_${reason}`, nextSession);

        return {
          ok: true,
          reason
        };
      } finally {
        sessionCycleInProgress = false;
        sessionCycleReason = "resting";
        reloginInProgressPromise = null;
        scheduleNextSessionCycle();
      }
    })();

    return reloginInProgressPromise;
  };

  const clearSessionForProxyChange = () => {
    if (fs.existsSync(STORAGE_STATE_PATH)) {
      fs.unlinkSync(STORAGE_STATE_PATH);
      console.log("[Session] Cleared saved session for proxy change.");
    }
  };

  /** After session-loop rest, rotate proxy (if pool has 2+) and fresh-login through it.
 *  Pass `{ rotate: false }` on wake retries so a failed login does not skip pool entries. */
  const prepareProxyForSessionRestRelogin = (opts = {}) => {
    const shouldRotate = opts.rotate !== false;
    const store = proxyPool.loadStore();
    if (!store.proxies.length) {
      clearSessionForProxyChange();
      return null;
    }

    if (
      shouldRotate &&
      settings.proxyRotateOnSessionRest &&
      store.proxies.length > 1
    ) {
      proxyPool.rotateActive(store);
    }

    proxyPool.applyActiveToSettings(settings, store);
    proxyPool.saveStore(store);
    persistRuntimeSettings([
      "PROXY_SERVER",
      "PROXY_USERNAME",
      "PROXY_PASSWORD",
      "PROXY_BYPASS",
      "PROXY_ROTATE_ON_SESSION_REST"
    ]);
    clearSessionForProxyChange();
    const idx = Number(store.activeIndex) || 0;
    const total = store.proxies.length;
    console.log(
      `[Session Loop] Re-login proxy: ${formatProxyDisplay(settings, store)}` +
        ` (#${idx + 1}/${total})` +
        (shouldRotate && settings.proxyRotateOnSessionRest && total > 1
          ? " (rotated)"
          : shouldRotate
            ? ""
            : " (retry same proxy)")
    );
    if (dashboardBridge) {
      dashboardBridge.publishSnapshot({ force: true });
    }
    return store;
  };

  const updateProxySettings = async (patch = {}) => {
    let store = proxyPool.loadStore();
    const action = String(patch.action || (patch.apply ? "apply" : "save"))
      .trim()
      .toLowerCase();

    if (patch.proxyText !== undefined) {
      store.proxies = proxyPool.parseProxyListText(patch.proxyText);
      store.activeIndex = 0;
    }

    if (Array.isArray(patch.proxies)) {
      store.proxies = patch.proxies.map(proxyPool.normalizeProxyEntry).filter(Boolean);
    }

    if (patch.bypass !== undefined) {
      store.bypass = String(patch.bypass || "").trim();
    }

    if (patch.rotateOnSessionRest !== undefined || patch.proxyRotateOnSessionRest !== undefined) {
      const raw =
        patch.rotateOnSessionRest !== undefined
          ? patch.rotateOnSessionRest
          : patch.proxyRotateOnSessionRest;
      settings.proxyRotateOnSessionRest =
        raw === true || String(raw).toLowerCase() === "true";
    }

    if (patch.activeIndex !== undefined && store.proxies.length) {
      proxyPool.setActiveIndex(store, patch.activeIndex);
    }

    if (action === "next") {
      proxyPool.rotateActive(store);
    }

    if (action === "disable") {
      store.proxies = [];
      store.activeIndex = 0;
      applyProxyToSettings(settings, {
        server: "",
        username: "",
        password: "",
        bypass: store.bypass || settings.proxyBypass
      });
    } else if (store.proxies.length) {
      proxyPool.applyActiveToSettings(settings, store);
    } else if (
      patch.server !== undefined ||
      patch.username !== undefined ||
      patch.password !== undefined
    ) {
      applyProxyToSettings(settings, {
        server: patch.server !== undefined ? patch.server : settings.proxyServer,
        username: patch.username !== undefined ? patch.username : settings.proxyUsername,
        password: patch.password !== undefined ? patch.password : settings.proxyPassword,
        bypass: patch.bypass !== undefined ? patch.bypass : store.bypass || settings.proxyBypass
      });
      store.proxies = settings.proxyServer
        ? [
            proxyPool.normalizeProxyEntry({
              server: settings.proxyServer,
              username: settings.proxyUsername,
              password: settings.proxyPassword
            })
          ].filter(Boolean)
        : [];
      store.activeIndex = 0;
    } else if (action !== "save") {
      proxyPool.applyActiveToSettings(settings, store);
    }

    proxyPool.saveStore(store);
    persistRuntimeSettings([
      "PROXY_SERVER",
      "PROXY_USERNAME",
      "PROXY_PASSWORD",
      "PROXY_BYPASS",
      "PROXY_ROTATE_ON_SESSION_REST"
    ]);

    const shouldRelogin =
      action === "apply" || action === "next" || action === "disable" || patch.relogin === true;
    if (shouldRelogin) {
      clearSessionForProxyChange();
      console.log(`[Session] Proxy set to ${formatProxyDisplay(settings, store)} — re-login starting...`);
      await reloginNow(`proxy_${action}`);
      if (dashboardBridge) {
        dashboardBridge.publishSnapshot({ force: true });
      }
    }

    return buildProxySettingsPayload(settings);
  };

  const changeProxyAndRelogin = async (patch = {}, reason = "proxy_change") => {
    await updateProxySettings({ ...patch, action: patch.action || "apply", relogin: true });
    return { ok: true, reason };
  };

  const getProxySettings = () => buildProxySettingsPayload(settings);

  const updateFarmlistLoopConfig = async (nextConfig) => {
    settings.farmlistLoopEnabled = Boolean(nextConfig.enabled);

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.farmlistLoopMinMinutes,
      settings.farmlistLoopMaxMinutes
    );

    settings.farmlistLoopMinMinutes = range.min;
    settings.farmlistLoopMaxMinutes = range.max;

    persistRuntimeSettings([
      "FARMLIST_LOOP_ENABLED",
      "FARMLIST_LOOP_MIN_MINUTES",
      "FARMLIST_LOOP_MAX_MINUTES"
    ]);

    return {
      enabled: settings.farmlistLoopEnabled,
      minMinutes: settings.farmlistLoopMinMinutes,
      maxMinutes: settings.farmlistLoopMaxMinutes
    };
  };

  const updateBuilderLoopConfig = async (nextConfig) => {
    settings.builderLoopEnabled = Boolean(nextConfig.enabled);

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.builderLoopMinMinutes,
      settings.builderLoopMaxMinutes
    );

    settings.builderLoopMinMinutes = range.min;
    settings.builderLoopMaxMinutes = range.max;

    persistRuntimeSettings([
      "BUILDER_LOOP_ENABLED",
      "BUILDER_LOOP_MIN_MINUTES",
      "BUILDER_LOOP_MAX_MINUTES"
    ]);

    return {
      enabled: settings.builderLoopEnabled,
      minMinutes: settings.builderLoopMinMinutes,
      maxMinutes: settings.builderLoopMaxMinutes
    };
  };

  const updateTroopTrainingLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.troopTrainingRoundRobinEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.troopTrainingLoopMinMinutes,
      settings.troopTrainingLoopMaxMinutes
    );

    settings.troopTrainingLoopMinMinutes = range.min;
    settings.troopTrainingLoopMaxMinutes = range.max;

    persistRuntimeSettings([
      "TROOP_TRAINING_ROUND_ROBIN_ENABLED",
      "TROOP_TRAINING_LOOP_MIN_MINUTES",
      "TROOP_TRAINING_LOOP_MAX_MINUTES"
    ]);

    return {
      enabled: settings.troopTrainingRoundRobinEnabled,
      minMinutes: settings.troopTrainingLoopMinMinutes,
      maxMinutes: settings.troopTrainingLoopMaxMinutes
    };
  };

  const updateTroopQueueCapConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.troopQueueCapEnabled = nextConfig.enabled;
    }

    if (nextConfig.hours !== undefined) {
      const hours = Number(nextConfig.hours);
      if (Number.isFinite(hours) && hours > 0) {
        settings.troopQueueCapHours = hours;
      }
    }

    persistRuntimeSettings(["TROOP_QUEUE_CAP_ENABLED", "TROOP_QUEUE_CAP_HOURS"]);

    return {
      enabled: settings.troopQueueCapEnabled,
      hours: settings.troopQueueCapHours
    };
  };

  const updateNpcCropConvertLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.npcCropConvertEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.npcCropConvertMinMinutes,
      settings.npcCropConvertMaxMinutes
    );
    settings.npcCropConvertMinMinutes = range.min;
    settings.npcCropConvertMaxMinutes = range.max;

    if (nextConfig.granaryRatio !== undefined) {
      const raw = Number(nextConfig.granaryRatio);
      if (Number.isFinite(raw) && raw > 0 && raw < 1) {
        settings.npcCropConvertGranaryRatio = raw;
      } else if (Number.isFinite(raw) && raw >= 1 && raw <= 100) {
        settings.npcCropConvertGranaryRatio = raw / 100;
      }
    }
    if (nextConfig.excludedVillageIds !== undefined) {
      settings.npcCropConvertExcludedVillageIds = String(nextConfig.excludedVillageIds || "").trim();
    }
    if (nextConfig.marketplaceBuildingId !== undefined) {
      const buildingId = Math.floor(Number(nextConfig.marketplaceBuildingId) || 0);
      if (Number.isFinite(buildingId) && buildingId > 0) {
        settings.npcCropConvertMarketplaceBuildingId = buildingId;
      }
    }

    persistRuntimeSettings([
      "NPC_CROP_CONVERT_ENABLED",
      "NPC_CROP_CONVERT_MIN_MINUTES",
      "NPC_CROP_CONVERT_MAX_MINUTES",
      "NPC_CROP_CONVERT_GRANARY_RATIO",
      "NPC_CROP_CONVERT_EXCLUDED_VILLAGE_IDS",
      "NPC_CROP_CONVERT_MARKETPLACE_BUILDING_ID"
    ]);

    return {
      enabled: settings.npcCropConvertEnabled,
      minMinutes: settings.npcCropConvertMinMinutes,
      maxMinutes: settings.npcCropConvertMaxMinutes,
      granaryRatio: settings.npcCropConvertGranaryRatio,
      excludedVillageIds: settings.npcCropConvertExcludedVillageIds,
      marketplaceBuildingId: settings.npcCropConvertMarketplaceBuildingId
    };
  };

  const updateOverflowGuardLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.resourceOverflowGuardEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.resourceOverflowLoopMinMinutes,
      settings.resourceOverflowLoopMaxMinutes
    );
    settings.resourceOverflowLoopMinMinutes = range.min;
    settings.resourceOverflowLoopMaxMinutes = range.max;

    const normRatio = (raw, fallback) => {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < 1) return n;
      if (Number.isFinite(n) && n >= 1 && n <= 100) return n / 100;
      return fallback;
    };
    if (nextConfig.triggerRatio !== undefined) {
      settings.resourceOverflowTriggerRatio = normRatio(
        nextConfig.triggerRatio,
        settings.resourceOverflowTriggerRatio || 0.9
      );
    }
    if (nextConfig.targetRatio !== undefined) {
      settings.resourceOverflowTargetRatio = normRatio(
        nextConfig.targetRatio,
        settings.resourceOverflowTargetRatio || 0.75
      );
    }
    if (settings.resourceOverflowTargetRatio > settings.resourceOverflowTriggerRatio) {
      settings.resourceOverflowTargetRatio = Math.max(
        0.05,
        settings.resourceOverflowTriggerRatio - 0.1
      );
    }
    if (nextConfig.maxDistance !== undefined) {
      settings.resourceOverflowMaxDistance = Math.max(
        1,
        Math.floor(Number(nextConfig.maxDistance) || 10)
      );
    }
    if (nextConfig.pivotVillageIds !== undefined) {
      settings.resourceOverflowPivotVillageIds = String(nextConfig.pivotVillageIds || "").trim();
    }

    persistRuntimeSettings([
      "RESOURCE_OVERFLOW_GUARD_ENABLED",
      "RESOURCE_OVERFLOW_TRIGGER_RATIO",
      "RESOURCE_OVERFLOW_TARGET_RATIO",
      "RESOURCE_OVERFLOW_MAX_DISTANCE",
      "RESOURCE_OVERFLOW_LOOP_MIN_MINUTES",
      "RESOURCE_OVERFLOW_LOOP_MAX_MINUTES",
      "RESOURCE_OVERFLOW_PIVOT_VILLAGE_IDS"
    ]);

    return {
      enabled: settings.resourceOverflowGuardEnabled,
      minMinutes: settings.resourceOverflowLoopMinMinutes,
      maxMinutes: settings.resourceOverflowLoopMaxMinutes,
      triggerRatio: settings.resourceOverflowTriggerRatio,
      targetRatio: settings.resourceOverflowTargetRatio,
      maxDistance: settings.resourceOverflowMaxDistance,
      pivotVillageIds: settings.resourceOverflowPivotVillageIds
    };
  };

  const updateCelebrationsLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.celebrationsRoundRobinEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.celebrationsLoopMinMinutes,
      settings.celebrationsLoopMaxMinutes
    );
    settings.celebrationsLoopMinMinutes = range.min;
    settings.celebrationsLoopMaxMinutes = range.max;

    if (nextConfig.type !== undefined) {
      const raw = String(nextConfig.type || "auto")
        .trim()
        .toLowerCase();
      settings.celebrationsType =
        raw === "small" || raw === "large" || raw === "great"
          ? raw === "great"
            ? "large"
            : raw
          : "auto";
    }
    if (nextConfig.queueDepth !== undefined) {
      const depth = Math.floor(Number(nextConfig.queueDepth));
      settings.celebrationsQueueDepth = depth === 2 ? 2 : 1;
    }
    if (nextConfig.includedVillageIds !== undefined) {
      settings.celebrationsIncludedVillageIds = String(nextConfig.includedVillageIds || "").trim();
    }
    if (nextConfig.excludedVillageIds !== undefined) {
      settings.celebrationsExcludedVillageIds = String(nextConfig.excludedVillageIds || "").trim();
    }

    persistRuntimeSettings([
      "CELEBRATIONS_ROUND_ROBIN_ENABLED",
      "CELEBRATIONS_LOOP_MIN_MINUTES",
      "CELEBRATIONS_LOOP_MAX_MINUTES",
      "CELEBRATIONS_TYPE",
      "CELEBRATIONS_QUEUE_DEPTH",
      "CELEBRATIONS_INCLUDED_VILLAGE_IDS",
      "CELEBRATIONS_EXCLUDED_VILLAGE_IDS"
    ]);

    return {
      enabled: settings.celebrationsRoundRobinEnabled,
      minMinutes: settings.celebrationsLoopMinMinutes,
      maxMinutes: settings.celebrationsLoopMaxMinutes,
      type: settings.celebrationsType,
      queueDepth: settings.celebrationsQueueDepth,
      includedVillageIds: settings.celebrationsIncludedVillageIds,
      excludedVillageIds: settings.celebrationsExcludedVillageIds
    };
  };

  const updateTop10TrackingLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.top10TrackingEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.top10TrackingLoopMinMinutes,
      settings.top10TrackingLoopMaxMinutes
    );
    settings.top10TrackingLoopMinMinutes = range.min;
    settings.top10TrackingLoopMaxMinutes = range.max;

    if (nextConfig.logFile !== undefined) {
      settings.top10TrackingLogFile = String(nextConfig.logFile || DEFAULT_TOP10_LOG_FILE).trim() || DEFAULT_TOP10_LOG_FILE;
    }
    if (nextConfig.playerName !== undefined) {
      settings.top10TrackingPlayerName = String(nextConfig.playerName || "").trim();
    }

    persistRuntimeSettings([
      "TOP10_TRACKING_ENABLED",
      "TOP10_TRACKING_LOOP_MIN_MINUTES",
      "TOP10_TRACKING_LOOP_MAX_MINUTES",
      "TOP10_TRACKING_LOG_FILE",
      "TOP10_TRACKING_PLAYER_NAME"
    ]);

    return {
      enabled: settings.top10TrackingEnabled,
      minMinutes: settings.top10TrackingLoopMinMinutes,
      maxMinutes: settings.top10TrackingLoopMaxMinutes,
      logFile: settings.top10TrackingLogFile,
      playerName: settings.top10TrackingPlayerName
    };
  };

  const updateActivitySimulationLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.activitySimulationEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.activitySimulationLoopMinMinutes,
      settings.activitySimulationLoopMaxMinutes
    );
    settings.activitySimulationLoopMinMinutes = range.min;
    settings.activitySimulationLoopMaxMinutes = range.max;

    if (nextConfig.patterns !== undefined) {
      settings.activitySimulationPatterns = serializeActivityPatterns(
        Array.isArray(nextConfig.patterns)
          ? nextConfig.patterns
          : parseActivityPatterns(nextConfig.patterns)
      );
    }

    persistRuntimeSettings([
      "ACTIVITY_SIMULATION_ENABLED",
      "ACTIVITY_SIMULATION_LOOP_MIN_MINUTES",
      "ACTIVITY_SIMULATION_LOOP_MAX_MINUTES",
      "ACTIVITY_SIMULATION_PATTERNS"
    ]);

    return {
      enabled: settings.activitySimulationEnabled,
      minMinutes: settings.activitySimulationLoopMinMinutes,
      maxMinutes: settings.activitySimulationLoopMaxMinutes,
      patterns: parseActivityPatterns(settings.activitySimulationPatterns)
    };
  };

  const updateDashboardDisplayConfig = async (nextConfig) => {
    if (typeof nextConfig.compactView === "boolean") {
      settings.dashboardCompactView = nextConfig.compactView;
    }
    persistRuntimeSettings(["DASHBOARD_COMPACT_VIEW"]);
    if (dashboardBridge) {
      dashboardBridge.publishSnapshot();
    }
    return { compactView: settings.dashboardCompactView };
  };

  const updateCrannyDefenseLoopConfig = async (nextConfig) => {
    if (typeof nextConfig.enabled === "boolean") {
      settings.crannyDefenseRoundRobinEnabled = nextConfig.enabled;
    }

    const range = normalizeRange(
      Number(nextConfig.minMinutes),
      Number(nextConfig.maxMinutes),
      settings.crannyDefenseLoopMinMinutes,
      settings.crannyDefenseLoopMaxMinutes
    );

    settings.crannyDefenseLoopMinMinutes = range.min;
    settings.crannyDefenseLoopMaxMinutes = range.max;

    persistRuntimeSettings([
      "CRANNY_DEFENSE_ROUND_ROBIN_ENABLED",
      "CRANNY_DEFENSE_LOOP_MIN_MINUTES",
      "CRANNY_DEFENSE_LOOP_MAX_MINUTES"
    ]);

    return {
      enabled: settings.crannyDefenseRoundRobinEnabled,
      minMinutes: settings.crannyDefenseLoopMinMinutes,
      maxMinutes: settings.crannyDefenseLoopMaxMinutes
    };
  };

  try {
    sessionPresence.closeOpenPeriods(presenceLogFile, "interrupted");

    if (dashboardEnabled && keepOpen) {
      dashboardBridge = createDashboardBridge();
      dashboardBridge.setSessionPresenceReportProvider((options) =>
        getSessionPresenceReport(options)
      );
      dashboardBridge.setSnapshotProvider(() => ({
        updatedAt: new Date().toISOString(),
        starting: startupPhase !== "ready",
        phase: startupPhase,
        account: {
          username: USERNAME,
          browserMode: settings.headless ? "headless" : "headed",
          dashboardPort,
          dashboardUrls: [`http://127.0.0.1:${dashboardPort}`]
        },
        automation: {
          paused: true,
          reason:
            startupPhase === "login"
              ? "logging_in"
              : startupPhase === "menu"
                ? "starting"
                : "online"
        },
        sessionPresence: getSessionPresenceReport({ limit: 5 })
      }));
      const dashboardNetwork = await getDashboardNetworkInfo(dashboardPort, "127.0.0.1", {
        skipPublicFetch: true
      });
      dashboardAccount = {
        username: USERNAME,
        browserMode: settings.headless ? "headless" : "headed",
        ...dashboardNetwork
      };
      dashboardServer = startDashboardServer({
        bridge: dashboardBridge,
        port: dashboardPort,
        logFilePath: actionLogFilePath,
        openBrowser: dashboardOpenBrowser
      });
      mirrorConsoleToDashboard(dashboardBridge);
      console.log(`  Dashboard: http://127.0.0.1:${dashboardPort} (starting…)`);
      getDashboardNetworkInfo(dashboardPort)
        .then((fullNetwork) => {
          if (dashboardAccount) {
            dashboardAccount.publicAddress = fullNetwork.publicAddress;
            dashboardAccount.dashboardUrls = fullNetwork.dashboardUrls;
            if (dashboardBridge) {
              dashboardBridge.publishSnapshot({ force: true });
            }
          }
        })
        .catch(() => null);
      if (dashboardNetwork.localAddresses.length) {
        console.log(
          `  Dashboard (LAN): ${dashboardNetwork.localAddresses.map((ip) => `http://${ip}:${dashboardPort}`).join(", ")}`
        );
      }
    } else if (dashboardEnabled && !keepOpen) {
      console.warn("Dashboard requires --keep-open; ignoring --dashboard.");
    }

    session = await createSession(settings.headless);
    settings.headless = session.headless;
    startupPhase = "menu";
    await recordPresenceOnline("login", session);
    if (dashboardBridge) {
      dashboardBridge.publishSnapshot({ force: true });
    }

    scheduleNextSessionCycle();
    scheduleBrowserRefresh();

    if (keepOpen) {
      await runTerminalMenu(
        () => session.page,
        settings,
        {
          dashboardMode: Boolean(dashboardBridge),
          dashboardBridge,
          dashboardPort,
          dashboardEnvLabel: path.basename(resolvedEnvPath),
          dashboardAccount,
          getHeadlessMode: () => settings.headless,
          getSessionId: () => sessionId,
          getLogFilePath: () => actionLogFilePath,
          getSessionLoopStatus,
          getSessionPresenceReport,
          getBrowserRefreshStatus,
          getAutomationStatus,
          setAutomationPaused,
          reloginNow,
          changeProxyAndRelogin,
          updateProxySettings,
          getProxySettings,
          getProxyDisplay: () => formatProxyDisplay(settings, proxyPool.loadStore()),
          registerAutomationIdleWaiter: (fn) => {
            automationIdleWaiter = typeof fn === "function" ? fn : null;
          },
          updateSessionLoopConfig,
          updateFarmlistLoopConfig,
          updateBuilderLoopConfig,
          updateTroopTrainingLoopConfig,
          updateTroopQueueCapConfig,
          updateCrannyDefenseLoopConfig,
          updateActivitySimulationLoopConfig,
          updateTop10TrackingLoopConfig,
          updateNpcCropConvertLoopConfig,
          updateOverflowGuardLoopConfig,
          updateCelebrationsLoopConfig,
          updateDashboardDisplayConfig,
          async persistSettings(selectedKeys) {
            persistRuntimeSettings(selectedKeys);
          },
          async toggleHeadlessMode() {
            const nextHeadless = !settings.headless;
            const previousSession = session;
            recordPresenceOffline("headless_toggle");
            const nextSession = await createSession(nextHeadless);
            session = nextSession;
            settings.headless = nextSession.headless;
            await previousSession.browser.close();
            await recordPresenceOnline("headless_toggle", nextSession);
            persistRuntimeSettings(["HEADLESS"]);
            return settings.headless;
          }
        }
      );
    } else {
      await waitForEnter("Browser will stay open. Press Enter here to close it... ");
    }
    if (keepOpen) {
      console.log("Session ended.");
    }
  } finally {
    loopStopped = true;
    cancelSessionLoopTimer();
    cancelBrowserRefreshTimer();
    recordPresenceOffline("shutdown");
    if (dashboardServer) {
      try {
        if (typeof dashboardServer.closeAllConnections === "function") {
          dashboardServer.closeAllConnections();
        }
        await new Promise((resolve) => {
          dashboardServer.close(() => resolve());
        });
      } catch (_error) {
        /* ignore dashboard shutdown errors */
      }
      dashboardServer = null;
    }
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

run()
  .then(() => {
    // run()'s clean-quit path (finally block above: browser + dashboard
    // server closed, presence recorded offline) never forced the process to
    // exit — it just let run() resolve and relied on Node's event loop
    // draining naturally. Anything still holding a handle open (a readline
    // interface on stdin, a stray timer, a Playwright subprocess handle not
    // fully released) then kept the process alive indefinitely after
    // "Session ended.", forcing a manual kill — most visibly reported on
    // Android/Termux, where that's a dead terminal with no obvious way to
    // force it closed. All cleanup has already awaited by this point, so a
    // hard exit here is safe.
    process.exit(0);
  })
  .catch((err) => {
    console.error("Playwright login run failed:", err);
    process.exit(1);
  });
