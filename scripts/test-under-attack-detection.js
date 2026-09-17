#!/usr/bin/env node
// Isolated verification for the under-attack row detection used by
// refreshVillageState() in terminalMenu.js (and depended on by raid
// evacuation via village.underAttack). Re-implements the exact boolean
// expression shipped there against a real page via Playwright, rather than
// re-typing selector logic in plain Node -- this is real DOM matching
// (classList/querySelector), so it needs a real DOM to mean anything.
//
// If you change the underAttack detection in terminalMenu.js, mirror the
// expression here too, or this test silently stops verifying the real
// behavior.
const assert = require("assert");
const { chromium } = require("playwright");

// Verbatim copy of the boolean expression from terminalMenu.js's #vlist row
// mapping (as of the a[title*='Under Attack'] fallback added in v1.8.108).
const UNDER_ATTACK_EXPR = `
  Boolean(
    row.classList.contains("under-attack") ||
      row.querySelector(".attack-glow") ||
      row.querySelector("img.att1") ||
      row.querySelector("a[title*='Under Attack']")
  )
`;

const FIXTURE_HTML = `
<!doctype html><html><body>
<table><tbody id="vlist">
  <tr data-vid="1" class="under-attack"><td>class signal</td></tr>
  <tr data-vid="2"><td><span class="attack-glow"></span> glow signal</td></tr>
  <tr data-vid="3"><td><img class="att1" src="x.png"> icon signal</td></tr>
  <tr data-vid="4"><td><a title="Under Attack!" href="#">title signal</a></td></tr>
  <tr data-vid="5"><td>no attack signal at all</td></tr>
  <tr data-vid="6"><td><a title="Send merchants" href="#">unrelated title</a></td></tr>
</tbody></table>
</body></html>
`;

async function evaluateUnderAttack(page, vid) {
  return page.evaluate(
    ({ vid, expr }) => {
      const row = document.querySelector(`#vlist tr[data-vid="${vid}"]`);
      if (!row) {
        return null;
      }
      // eslint-disable-next-line no-new-func
      return new Function("row", `return (${expr});`)(row);
    },
    { vid, expr: UNDER_ATTACK_EXPR }
  );
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    // This test needs a real installed Chromium the same way the bot itself
    // does. If it isn't installed yet (e.g. this is running before `npm run
    // setup:pc` / `npx playwright install chromium`), skip rather than fail
    // -- this is a missing-prerequisite, not a code problem.
    if (/Executable doesn't exist/i.test(String(error && error.message))) {
      console.log(
        "SKIP: Chromium not installed -- run `npm run playwright:install` to enable this test."
      );
      process.exit(0);
    }
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(FIXTURE_HTML);

    const cases = [
      [1, true, "under-attack class"],
      [2, true, ".attack-glow element"],
      [3, true, "img.att1 icon"],
      [4, true, "a[title*='Under Attack'] fallback (v1.8.108)"],
      [5, false, "no signal at all"],
      [6, false, "an unrelated title attribute must not false-positive"]
    ];

    for (const [vid, expected, label] of cases) {
      const actual = await evaluateUnderAttack(page, vid);
      assert.strictEqual(actual, expected, `village ${vid} (${label}): expected ${expected}, got ${actual}`);
      console.log(`PASS: village ${vid} -- ${label} -> ${actual}`);
    }
  } finally {
    await browser.close();
  }

  console.log("\nAll under-attack detection tests passed.");
})().catch((error) => {
  console.error("FAILED:", error.message || error);
  process.exit(1);
});
