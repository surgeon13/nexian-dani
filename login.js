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
const { startDashboardServer, getDashboardNetworkInfo } = require("./dashboardServer");

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

const envFile = getArgValue("--env-file=") || process.env.NEXIAN_ENV_FILE || ".env";
const resolvedEnvPath = path.resolve(process.cwd(), envFile);
const resolvedEnvExamplePath = path.resolve(__dirname, ".env.example");

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
    if (fs.existsSync(resolvedEnvExamplePath)) {
      fs.copyFileSync(resolvedEnvExamplePath, envPath);
      console.log(`Created ${path.basename(envPath)} from .env.example`);
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

const LOGIN_URL = process.env.NEXIAN_URL || "https://nexian.world/";
const USERNAME = process.env.NEXIAN_USERNAME;
const PASSWORD = process.env.NEXIAN_PASSWORD;

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
  troopGreatTrainerUrl:
    process.env.TROOP_GREAT_TRAINER_URL ||
    gameUrl("/build.php?id=35"),
  troopStableTrainerUrl:
    process.env.TROOP_STABLE_TRAINER_URL ||
    gameUrl("/build.php?id=38"),
  troopTrainingAlternateGreatBarracks:
    String(process.env.TROOP_TRAINING_ALTERNATE_GREAT_BARRACKS || "false").toLowerCase() ===
      "true",
  troopTrainingPreset:
    process.env.TROOP_TRAINING_PRESET ||
    "Clubswinger",
  troopTemplateMode:
    String(process.env.TROOP_TEMPLATE_MODE || "offensive").toLowerCase() === "defensive"
      ? "defensive"
      : "offensive",
  troopTribe: (() => {
    const t = String(process.env.TROOP_TRIBE || "auto").trim().toLowerCase();
    return ["auto", "teuton", "roman", "gaul"].includes(t) ? t : "auto";
  })(),
  troopTemplateOffensive: String(process.env.TROOP_TEMPLATE_OFFENSIVE ?? "").trim(),
  troopTemplateDefensive: String(process.env.TROOP_TEMPLATE_DEFENSIVE ?? "").trim(),
  troopTemplateInfantryOffensive: String(process.env.TROOP_TEMPLATE_INFANTRY_OFFENSIVE ?? "").trim(),
  troopTemplateInfantryDefensive: String(process.env.TROOP_TEMPLATE_INFANTRY_DEFENSIVE ?? "").trim(),
  troopTemplateCavalryOffensive: String(process.env.TROOP_TEMPLATE_CAVALRY_OFFENSIVE ?? "").trim(),
  troopTemplateCavalryDefensive: String(process.env.TROOP_TEMPLATE_CAVALRY_DEFENSIVE ?? "").trim(),
  troopTrainingBatchSize: numberEnv("TROOP_TRAINING_BATCH_SIZE", 5),
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
  manualPauseAutoUnpauseMinutes: numberEnv("MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES", 0),
  logoutUrl:
    process.env.LOGOUT_URL ||
    gameUrl("/logout.php"),
  randomDelayMinMs: numberEnv("RANDOM_DELAY_MIN_MS", 1000),
  randomDelayMaxMs: numberEnv("RANDOM_DELAY_MAX_MS", 2000),
  selectAllSelector:
    process.env.FARMLIST_SELECT_ALL_SELECTOR ||
    "#farmlist_selectall_32",
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
  statusAfterFarmlistsEnabled:
    String(process.env.STATUS_AFTER_FARMLISTS_ENABLED || "true").toLowerCase() === "true",
  statusAfterFarmlistsCooldownMinutes: numberEnv("STATUS_AFTER_FARMLISTS_COOLDOWN_MINUTES", 15),
  builderLoopEnabled:
    String(process.env.BUILDER_LOOP_ENABLED || "false").toLowerCase() === "true",
  builderLoopMinMinutes: numberEnv("BUILDER_LOOP_MIN_MINUTES", 5),
  builderLoopMaxMinutes: numberEnv("BUILDER_LOOP_MAX_MINUTES", 10),
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
  troopTrainingRoundRobinEnabled:
    String(process.env.TROOP_TRAINING_ROUND_ROBIN_ENABLED || "false").toLowerCase() === "true",
  troopTrainingLoopMinMinutes: numberEnv("TROOP_TRAINING_LOOP_MIN_MINUTES", 5),
  troopTrainingLoopMaxMinutes: numberEnv("TROOP_TRAINING_LOOP_MAX_MINUTES", 10),
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
  resourceCirculationReceiverMaxFillRatio: numberEnv("RESOURCE_CIRCULATION_RECEIVER_MAX_FILL_RATIO", 0.8),
  resourceCirculationMaxDonors: numberEnv("RESOURCE_CIRCULATION_MAX_DONORS", 3),
  resourceCirculationBuilderMaxDonors: numberEnv("RESOURCE_CIRCULATION_BUILDER_MAX_DONORS", 1),
  resourceCirculationBuilderMerchantLoads: numberEnv("RESOURCE_CIRCULATION_BUILDER_MERCHANT_LOADS", 4),
  resourceCirculationReservePerResource: numberEnv("RESOURCE_CIRCULATION_RESERVE_PER_RESOURCE", 500)
};

function normalizeRange(minValue, maxValue, fallbackMin, fallbackMax) {
  let min = Number.isFinite(minValue) ? minValue : fallbackMin;
  let max = Number.isFinite(maxValue) ? maxValue : fallbackMax;
  min = Math.max(1, Math.floor(min));
  max = Math.max(1, Math.floor(max));
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return { min, max };
}

function randomIntBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
    SESSION_LOOP_ENABLED: settings.sessionLoopEnabled ? "true" : "false",
    SESSION_PLAY_MIN_MINUTES: String(settings.playMinMinutes),
    SESSION_PLAY_MAX_MINUTES: String(settings.playMaxMinutes),
    SESSION_REST_MIN_MINUTES: String(settings.restMinMinutes),
    SESSION_REST_MAX_MINUTES: String(settings.restMaxMinutes),
    MANUAL_PAUSE_AUTO_UNPAUSE_MINUTES: String(settings.manualPauseAutoUnpauseMinutes),
    TROOP_TRAINING_PRESET: String(settings.troopTrainingPreset),
    TROOP_TRIBE: (() => {
      const t = String(settings.troopTribe || "auto").trim().toLowerCase();
      return ["auto", "teuton", "roman", "gaul"].includes(t) ? t : "auto";
    })(),
    TROOP_TEMPLATE_MODE: String(settings.troopTemplateMode || "offensive"),
    TROOP_TEMPLATE_OFFENSIVE: String(settings.troopTemplateOffensive || ""),
    TROOP_TEMPLATE_DEFENSIVE: String(settings.troopTemplateDefensive || ""),
    TROOP_TEMPLATE_INFANTRY_OFFENSIVE: String(settings.troopTemplateInfantryOffensive || ""),
    TROOP_TEMPLATE_INFANTRY_DEFENSIVE: String(settings.troopTemplateInfantryDefensive || ""),
    TROOP_TEMPLATE_CAVALRY_OFFENSIVE: String(settings.troopTemplateCavalryOffensive || ""),
    TROOP_TEMPLATE_CAVALRY_DEFENSIVE: String(settings.troopTemplateCavalryDefensive || ""),
    TROOP_STABLE_TRAINER_URL: String(settings.troopStableTrainerUrl || ""),
    TROOP_TRAINING_BATCH_SIZE: (() => {
      const n = Math.floor(Number(settings.troopTrainingBatchSize));
      if (!Number.isFinite(n)) {
        return "5";
      }
      return String(Math.max(1, Math.min(n, 999999)));
    })(),
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
    STATUS_AFTER_FARMLISTS_ENABLED: settings.statusAfterFarmlistsEnabled ? "true" : "false",
    STATUS_AFTER_FARMLISTS_COOLDOWN_MINUTES: String(settings.statusAfterFarmlistsCooldownMinutes),
    BUILDER_LOOP_ENABLED: settings.builderLoopEnabled ? "true" : "false",
    BUILDER_LOOP_MIN_MINUTES: String(settings.builderLoopMinMinutes),
    BUILDER_LOOP_MAX_MINUTES: String(settings.builderLoopMaxMinutes),
    BUILDER_ROUND_ROBIN_ENABLED: settings.builderRoundRobinEnabled ? "true" : "false",
    BUILDER_RR_EXCLUDED_VILLAGE_IDS: String(settings.builderRoundRobinExcludedVillageIds || ""),
    BUILDER_DEFAULT_PLAN_MODE: settings.builderDefaultPlanMode === "village" ? "village" : "resource",
    TROOP_TRAINING_ROUND_ROBIN_ENABLED: settings.troopTrainingRoundRobinEnabled ? "true" : "false",
    TROOP_TRAINING_LOOP_MIN_MINUTES: String(settings.troopTrainingLoopMinMinutes),
    TROOP_TRAINING_LOOP_MAX_MINUTES: String(settings.troopTrainingLoopMaxMinutes),
    CRANNY_DEFENSE_ROUND_ROBIN_ENABLED: settings.crannyDefenseRoundRobinEnabled ? "true" : "false",
    CRANNY_DEFENSE_LOOP_MIN_MINUTES: String(settings.crannyDefenseLoopMinMinutes || 8),
    CRANNY_DEFENSE_LOOP_MAX_MINUTES: String(settings.crannyDefenseLoopMaxMinutes || 15),
    ACTIVITY_SIMULATION_ENABLED: settings.activitySimulationEnabled ? "true" : "false",
    ACTIVITY_SIMULATION_LOOP_MIN_MINUTES: String(settings.activitySimulationLoopMinMinutes),
    ACTIVITY_SIMULATION_LOOP_MAX_MINUTES: String(settings.activitySimulationLoopMaxMinutes),
    ACTIVITY_SIMULATION_PATTERNS: String(settings.activitySimulationPatterns || ""),
    ACTIVITY_SIMULATION_DWELL_MIN_MS: String(settings.activitySimulationDwellMinMs),
    ACTIVITY_SIMULATION_DWELL_MAX_MS: String(settings.activitySimulationDwellMaxMs),
    DASHBOARD_COMPACT_VIEW: settings.dashboardCompactView ? "true" : "false",
    EXPANSION_AUTO_DISPATCH_ENABLED: settings.expansionAutoDispatchEnabled ? "true" : "false",
    EXPANSION_USE_PLANNED_TARGETS: settings.expansionUsePlannedTargets ? "true" : "false",
    EXPANSION_PLANNED_TARGETS_FILE: String(settings.expansionPlannedTargetsFile || ""),
    RESOURCE_CIRCULATION_ENABLED: settings.resourceCirculationEnabled ? "true" : "false",
    RESOURCE_CIRCULATION_EXPANSION_ENABLED: settings.resourceCirculationExpansionEnabled ? "true" : "false",
    RESOURCE_CIRCULATION_RECEIVER_MAX_FILL_RATIO: String(settings.resourceCirculationReceiverMaxFillRatio),
    RESOURCE_CIRCULATION_MAX_DONORS: String(settings.resourceCirculationMaxDonors),
    RESOURCE_CIRCULATION_BUILDER_MAX_DONORS: String(settings.resourceCirculationBuilderMaxDonors),
    RESOURCE_CIRCULATION_BUILDER_MERCHANT_LOADS: String(settings.resourceCirculationBuilderMerchantLoads),
    RESOURCE_CIRCULATION_RESERVE_PER_RESOURCE: String(settings.resourceCirculationReservePerResource)
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
    5,
    10
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
    if (/^s\d+\.nexian\.world$/i.test(parsed.hostname)) {
      origin = parsed.origin;
    } else if (
      parsed.hostname.endsWith("nexian.world") &&
      /village\d\.php|dorf\d\.php|build\.php|spieler\.php/i.test(parsed.pathname)
    ) {
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
    "troopGreatTrainerUrl",
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

async function openNexianPortalLoginForm(page) {
  const portalUser = page.locator('input[placeholder="Enter your username"]');
  if (await portalUser.isVisible().catch(() => false)) {
    return;
  }

  const playNow = page.getByRole("link", { name: /Play Now/i });
  if (await playNow.count()) {
    await playNow.first().click({ timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1000);
  }

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (el) => /^login$/i.test((el.textContent || "").trim()) && el.offsetParent !== null
    );
    if (btn) {
      btn.click();
    }
  });

  await portalUser.waitFor({ state: "visible", timeout: 30000 });
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

async function submitPortalLogin(page) {
  const enterRealm = page.getByRole("button", { name: /Enter Realm/i });
  await enterRealm.waitFor({ state: "visible", timeout: 30000 });

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

  // Playwright's click waits for navigation to finish; portal redirects can exceed 15s
  // or never reach networkidle, so submit via DOM click and poll separately.
  await enterRealm.evaluate((button) => button.click());
  await navigationPromise;
  return waitForGameLogin(page, { timeoutMs: 30000 });
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
  return waitForGameLogin(page, { timeoutMs: 30000 });
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
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

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
    console.log("  Login OK");
    const gameOrigin = syncSettingsGameHostFromPage(page, settings);
    if (gameOrigin) {
      console.log(`  Game host: ${gameOrigin}`);
    }
    await context.storageState({ path: "storageState.json" });
    console.log("  Session saved");
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
  const launchArgs = ["--disable-dev-shm-usage"];

  const launchChromium = (options) => chromium.launch({ args: launchArgs, ...options });

  if (!effectiveHeadless) {
    browser = await launchChromium({ headless: false });
  } else {
    try {
      browser = await launchChromium({ headless: true });
    } catch (error) {
      if (!isHeadlessLaunchError(error)) {
        throw error;
      }

      try {
        browser = await launchChromium({ channel: "chrome", headless: true });
        browserLabel = "headless (chrome channel)";
      } catch (chromeError) {
        effectiveHeadless = false;
        browser = await launchChromium({ headless: false });
        browserLabel = "headed (fallback)";
      }
    }
  }

  console.log(`\n  Env:     ${path.basename(resolvedEnvPath)}`);
  console.log(`  Browser: ${browserLabel}`);

  const context = await browser.newContext();
  const page = await context.newPage();
  await loginToPage(page, context);
  return { browser, context, page, headless: effectiveHeadless };
}

async function run() {
  applySessionLoopDefaults();

  let session = await createSession(settings.headless);
  settings.headless = session.headless;
  let sessionLoopTimer = null;
  let nextSessionCycleAt = null;
  let loopStopped = false;
  let sessionCycleInProgress = false;
  let sessionCycleReason = "resting";
  let reloginInProgressPromise = null;
  let manualAutomationPaused = false;
  let manualAutomationPausedAtMs = null;
  let dashboardServer = null;
  let dashboardBridge = null;
  let dashboardAccount = null;

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
        console.log("[Session Loop] Logging off current session...");
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

        const nextSession = await createSession(settings.headless);
        session = nextSession;
        settings.headless = nextSession.headless;
        console.log("[Session Loop] Re-login complete. Session resumed.");
      } catch (error) {
        console.error("[Session Loop] Cycle failed:", error.message || error);
      } finally {
        sessionCycleInProgress = false;
        sessionCycleReason = "resting";
        scheduleNextSessionCycle();
      }
    }, playMinutes * 60 * 1000);
  };

  const updateSessionLoopConfig = async (nextConfig) => {
    settings.sessionLoopEnabled = Boolean(nextConfig.enabled);

    const play = normalizeRange(
      Number(nextConfig.playMinMinutes),
      Number(nextConfig.playMaxMinutes),
      settings.playMinMinutes,
      settings.playMaxMinutes
    );
    settings.playMinMinutes = play.min;
    settings.playMaxMinutes = play.max;

    const rest = normalizeRange(
      Number(nextConfig.restMinMinutes),
      Number(nextConfig.restMaxMinutes),
      settings.restMinMinutes,
      settings.restMaxMinutes
    );
    settings.restMinMinutes = rest.min;
    settings.restMaxMinutes = rest.max;

    persistRuntimeSettings([
      "SESSION_LOOP_ENABLED",
      "SESSION_PLAY_MIN_MINUTES",
      "SESSION_PLAY_MAX_MINUTES",
      "SESSION_REST_MIN_MINUTES",
      "SESSION_REST_MAX_MINUTES"
    ]);

    scheduleNextSessionCycle();

    return {
      enabled: settings.sessionLoopEnabled,
      playMinMinutes: settings.playMinMinutes,
      playMaxMinutes: settings.playMaxMinutes,
      restMinMinutes: settings.restMinMinutes,
      restMaxMinutes: settings.restMaxMinutes
    };
  };

  const getSessionLoopStatus = () => {
    const nextInMinutes = nextSessionCycleAt
      ? Math.max(0, Math.ceil((nextSessionCycleAt - Date.now()) / 60000))
      : null;

    return {
      enabled: settings.sessionLoopEnabled,
      nextInMinutes
    };
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
    scheduleNextSessionCycle();

    if (dashboardEnabled && keepOpen) {
      dashboardBridge = createDashboardBridge();
      const dashboardNetwork = await getDashboardNetworkInfo(dashboardPort);
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
      if (dashboardNetwork.localAddresses.length) {
        console.log(
          `  Dashboard (LAN): ${dashboardNetwork.localAddresses.map((ip) => `http://${ip}:${dashboardPort}`).join(", ")}`
        );
      }
    } else if (dashboardEnabled && !keepOpen) {
      console.warn("Dashboard requires --keep-open; ignoring --dashboard.");
    }

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
          getAutomationStatus,
          setAutomationPaused,
          reloginNow,
          updateSessionLoopConfig,
          updateFarmlistLoopConfig,
          updateBuilderLoopConfig,
          updateTroopTrainingLoopConfig,
          updateCrannyDefenseLoopConfig,
          updateActivitySimulationLoopConfig,
          updateDashboardDisplayConfig,
          async persistSettings(selectedKeys) {
            persistRuntimeSettings(selectedKeys);
          },
          async toggleHeadlessMode() {
            const nextHeadless = !settings.headless;
            const previousSession = session;
            const nextSession = await createSession(nextHeadless);
            session = nextSession;
            settings.headless = nextSession.headless;
            await previousSession.browser.close();
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
    await session.browser.close();
  }
}

run().catch((err) => {
  console.error("Playwright login run failed:", err);
  process.exit(1);
});
