#!/usr/bin/env node
// Isolated verification for the .env / templates/settings.json split (v1.8.103).
//
// login.js is a self-executing script (dotenv.config(), browser launch, the
// interactive menu, ...) with no module.exports and no `require.main` guard,
// so it can't safely be `require()`d from a test -- doing so would run the
// whole program. Instead this re-implements ensureSettingsJsonFile(),
// loadJsonSettingsIntoEnv(), and persistJsonSettings() verbatim, matching the
// shipped functions in login.js line for line, and exercises them against
// real temp files/directories and a real process.env.
//
// If you change the settings-json helpers in login.js, mirror the change
// here too, or this test silently stops verifying the real behavior.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexian-settings-json-"));
}

// --- verbatim copies of the login.js implementations under test ---

function ensureSettingsJsonFile(settingsJsonPath, settingsExamplePath) {
  if (fs.existsSync(settingsJsonPath)) {
    return;
  }
  if (fs.existsSync(settingsExamplePath)) {
    fs.copyFileSync(settingsExamplePath, settingsJsonPath);
    return;
  }
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(settingsJsonPath, "{}\n", "utf8");
}

function loadJsonSettingsIntoEnv(settingsJsonPath, env) {
  let raw;
  try {
    raw = fs.readFileSync(settingsJsonPath, "utf8");
  } catch (_error) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined && value !== null && value !== undefined) {
      env[key] = String(value);
    }
  }
}

function persistJsonSettings(settingsJsonPath, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) {
    return;
  }
  let current = {};
  try {
    const raw = fs.readFileSync(settingsJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed;
    }
  } catch (_error) {
    current = {};
  }
  for (const key of keys) {
    current[key] = updates[key];
  }
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(settingsJsonPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

// --- tests ---

let root;

// 1. ensureSettingsJsonFile() copies from the example template when settings.json is missing.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  const examplePath = path.join(root, "templates", "settings.example.json");
  fs.mkdirSync(path.dirname(examplePath), { recursive: true });
  fs.writeFileSync(examplePath, JSON.stringify({ HEADLESS: true, DASHBOARD_PORT: 3847 }, null, 2));

  ensureSettingsJsonFile(settingsJsonPath, examplePath);
  assert.ok(fs.existsSync(settingsJsonPath), "settings.json should be created from the example");
  const written = JSON.parse(fs.readFileSync(settingsJsonPath, "utf8"));
  assert.deepStrictEqual(written, { HEADLESS: true, DASHBOARD_PORT: 3847 });

  // Second call must not overwrite an existing file.
  fs.writeFileSync(settingsJsonPath, JSON.stringify({ HEADLESS: false }));
  ensureSettingsJsonFile(settingsJsonPath, examplePath);
  const unchanged = JSON.parse(fs.readFileSync(settingsJsonPath, "utf8"));
  assert.deepStrictEqual(unchanged, { HEADLESS: false }, "existing settings.json must not be clobbered");
}
console.log("PASS: ensureSettingsJsonFile() copies from example, never overwrites an existing file");

// 2. ensureSettingsJsonFile() falls back to an empty object when no example template exists.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  const examplePath = path.join(root, "templates", "settings.example.json"); // does not exist
  ensureSettingsJsonFile(settingsJsonPath, examplePath);
  assert.ok(fs.existsSync(settingsJsonPath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsJsonPath, "utf8")), {});
}
console.log("PASS: ensureSettingsJsonFile() falls back to {} when no example template exists");

// 3. loadJsonSettingsIntoEnv() populates process.env-like object for unset keys only.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(
    settingsJsonPath,
    JSON.stringify({ HEADLESS: true, DASHBOARD_PORT: 3847, GAME_HOST: "https://json-should-not-win.example" })
  );

  // GAME_HOST simulates a key .env already set -- must NOT be overridden by settings.json.
  const env = { GAME_HOST: "https://s1.nexian.world" };
  loadJsonSettingsIntoEnv(settingsJsonPath, env);

  assert.strictEqual(env.HEADLESS, "true", "boolean values should be stringified");
  assert.strictEqual(env.DASHBOARD_PORT, "3847", "numeric values should be stringified");
  assert.strictEqual(
    env.GAME_HOST,
    "https://s1.nexian.world",
    ".env-set keys must always win over templates/settings.json"
  );
}
console.log("PASS: loadJsonSettingsIntoEnv() fills only unset keys, .env always wins on conflict");

// 4. loadJsonSettingsIntoEnv() degrades gracefully on corrupt JSON (no throw, no partial env mutation).
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(settingsJsonPath, "{ this is not valid json");

  const env = { EXISTING: "1" };
  assert.doesNotThrow(() => loadJsonSettingsIntoEnv(settingsJsonPath, env));
  assert.deepStrictEqual(env, { EXISTING: "1" }, "corrupt JSON must leave env untouched");
}
console.log("PASS: loadJsonSettingsIntoEnv() degrades gracefully on corrupt JSON");

// 5. loadJsonSettingsIntoEnv() is a silent no-op when settings.json doesn't exist at all.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json"); // never created
  const env = { EXISTING: "1" };
  assert.doesNotThrow(() => loadJsonSettingsIntoEnv(settingsJsonPath, env));
  assert.deepStrictEqual(env, { EXISTING: "1" });
}
console.log("PASS: loadJsonSettingsIntoEnv() no-ops when settings.json is missing");

// 6. persistJsonSettings() merges into an existing file instead of replacing it.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(settingsJsonPath, JSON.stringify({ HEADLESS: true, KEEP_OPEN: true }));

  persistJsonSettings(settingsJsonPath, { HEADLESS: false, DASHBOARD_ENABLED: true });

  const result = JSON.parse(fs.readFileSync(settingsJsonPath, "utf8"));
  assert.deepStrictEqual(result, { HEADLESS: false, KEEP_OPEN: true, DASHBOARD_ENABLED: true });
}
console.log("PASS: persistJsonSettings() merges updates into the existing file, preserving other keys");

// 7. persistJsonSettings() recovers instead of crashing when the existing file is corrupt.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  fs.mkdirSync(path.dirname(settingsJsonPath), { recursive: true });
  fs.writeFileSync(settingsJsonPath, "{ not json at all");

  assert.doesNotThrow(() => persistJsonSettings(settingsJsonPath, { HEADLESS: true }));
  const result = JSON.parse(fs.readFileSync(settingsJsonPath, "utf8"));
  assert.deepStrictEqual(result, { HEADLESS: true });
}
console.log("PASS: persistJsonSettings() recovers from a pre-existing corrupt file instead of crashing");

// 8. persistJsonSettings() creates templates/ and settings.json when neither exists yet.
root = makeTempRoot();
{
  const settingsJsonPath = path.join(root, "templates", "settings.json");
  assert.ok(!fs.existsSync(settingsJsonPath));
  persistJsonSettings(settingsJsonPath, { HEADLESS: true });
  assert.ok(fs.existsSync(settingsJsonPath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsJsonPath, "utf8")), { HEADLESS: true });
}
console.log("PASS: persistJsonSettings() creates templates/settings.json from scratch when missing");

// 9. templates/settings.example.json (the real shipped file) is valid JSON with no null/array root.
{
  const realExamplePath = path.resolve(__dirname, "..", "templates", "settings.example.json");
  const raw = fs.readFileSync(realExamplePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  assert.ok(Object.keys(parsed).length > 0, "settings.example.json should not be empty");
}
console.log("PASS: templates/settings.example.json is valid, non-empty JSON");

console.log("\nAll settings.json split tests passed.");
