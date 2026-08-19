#!/usr/bin/env node
/**
 * Assigns a builder template (e.g. an experimental one like
 * village_stage_fast_basic_15c) to a single village's progress record,
 * without needing a terminal-menu UI for it. Village identity uses the
 * same "vid_and_coords" key the builder loop already relies on
 * (templates/progress.json), so the village id AND coordinates must match
 * what's shown in-game exactly.
 *
 * Usage:
 *   node scripts/set-village-template.js --village-id=41623 --x=104 --y=22 --template=village_stage_fast_basic_15c
 *   node scripts/set-village-template.js --village-id=41623 --x=104 --y=22 --template=resource_fields_01 --plan=resource
 *
 * Options:
 *   --village-id=   required. In-game village id (the vid= value in build.php URLs).
 *   --x=            required. Village map X coordinate.
 *   --y=            required. Village map Y coordinate.
 *   --template=     required. Template key from templates/index.json.
 *   --plan=         optional. "village" (default) or "resource" — must match the
 *                   template's key prefix (village_stage_* / resource_fields_*).
 *   --name=         optional. Village display name, stored for readability only.
 *   --reset         optional. Only reset stage/step back to 0/0 for the CURRENT
 *                   active template instead of switching templates.
 */

const path = require("path");
const builder = require(path.join(__dirname, "..", "villageBuilder.js"));

function getArgValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const villageId = getArgValue("--village-id=");
const xRaw = getArgValue("--x=");
const yRaw = getArgValue("--y=");
const templateKey = getArgValue("--template=");
const planMode = getArgValue("--plan=") || "village";
const villageName = getArgValue("--name=") || null;
const resetOnly = process.argv.includes("--reset");

if (!villageId || xRaw == null || yRaw == null) {
  fail("--village-id=, --x=, and --y= are all required.");
}
if (!resetOnly && !templateKey) {
  fail("--template= is required (or pass --reset to just re-zero stage/step).");
}

const village = {
  id: Number(villageId),
  x: Number(xRaw),
  y: Number(yRaw),
  name: villageName
};

if (!Number.isFinite(village.id) || !Number.isFinite(village.x) || !Number.isFinite(village.y)) {
  fail("--village-id=, --x=, and --y= must all be numbers.");
}

const mode = String(planMode).toLowerCase() === "resource" ? "resource" : "village";

let resolvedTemplateKey = templateKey;
if (resetOnly) {
  const current = builder.getVillageProgress(village, { planMode: mode });
  if (!current || !current.active_template) {
    fail(`No existing ${mode} progress found for this village — nothing to reset. Pass --template= instead.`);
  }
  resolvedTemplateKey = current.active_template;
} else {
  // Fail fast on a typo'd/unknown key instead of writing progress that
  // silently never resolves (loadTemplate() would throw later, inside the
  // builder loop, which is a much worse place to discover this).
  try {
    builder.loadTemplate(resolvedTemplateKey);
  } catch (error) {
    fail(`Could not load template '${resolvedTemplateKey}': ${error.message}`);
  }

  const expectedPrefix = mode === "resource" ? "resource_fields_" : "village_stage_";
  if (!resolvedTemplateKey.startsWith(expectedPrefix)) {
    fail(
      `Template '${resolvedTemplateKey}' doesn't start with '${expectedPrefix}', which --plan=${mode} expects. ` +
        `Pass the matching --plan= for this template's key prefix.`
    );
  }
}

builder.setVillageProgress(
  village,
  {
    active_template: resolvedTemplateKey,
    stage_index: 0,
    step_index: 0,
    prereq_validated_template: null,
    realigned_from_template: null
  },
  { planMode: mode }
);

console.log(
  `Assigned ${mode} template '${resolvedTemplateKey}' to village id=${village.id} (${village.x}|${village.y})` +
    (village.name ? ` "${village.name}"` : "") +
    ". Progress reset to stage 0 / step 0."
);
console.log(
  "The next auto-builder tick (or a manual run) for this village will pick this template up automatically — " +
    "no restart needed unless the session is currently mid-action on this exact village."
);
