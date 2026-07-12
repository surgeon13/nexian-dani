const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const projectDir = __dirname;
const parentDir = path.dirname(projectDir);
const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = pkg.version || "0.0.0";
const exportBase = String(pkg.name || "nexian").trim() || "nexian";
const now = new Date();
const pad2 = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}-${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
const zipName = `${exportBase}-v${version}-${stamp}.zip`;
const zipPath = path.join(parentDir, zipName);
const exportRootName = `${exportBase}-v${version}`;
const tempDir = path.join(require("os").tmpdir(), `nexian-export-${Date.now()}`);
const stagedProjectDir = path.join(tempDir, exportRootName);

const exclude = new Set([
  ".git",
  "node_modules",
  ".env",
  "storageState.json",
  "log.jsonl",
  "log-archive",
  ".DS_Store",
  "Thumbs.db"
]);

function shouldSkip(name, relPath) {
  if (exclude.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  if (relPath === path.join("templates", "progress.json")) return true;
  if (relPath === path.join("templates", "troop_plans.json")) return true;
  if (relPath === path.join("templates", "proxy_list.json")) return true;
  if (relPath === path.join("templates", "troop_village_preferences.json")) return true;
  if (/^(npm-debug\.log|yarn-error\.log|pnpm-debug\.log)$/i.test(name)) return true;
  return false;
}

function copyDir(src, dest, rel) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    if (shouldSkip(entry.name, relPath)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, relPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log(`Zipping ${exportBase} v${version} -> ${zipPath}`);
console.log(
  "Excluding: .git, node_modules, .env files, storageState.json, log.jsonl, log-archive, templates/progress.json, templates/troop_plans.json, templates/proxy_list.json, debug logs\n"
);

copyDir(projectDir, stagedProjectDir, "");

execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${stagedProjectDir}' -DestinationPath '${zipPath}' -Force"`,
  { stdio: "inherit" }
);

fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`Done: ${zipPath}`);
