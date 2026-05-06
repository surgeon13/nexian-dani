const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: __dirname });

console.log("Installing dependencies...");
run("npm install");

console.log("\nInstalling Playwright Chromium...");
run("npx playwright install chromium");

const envPath = path.join(__dirname, ".env");
const examplePath = path.join(__dirname, ".env.example");
if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log("\nCreated .env from .env.example - fill in your credentials.");
} else if (!fs.existsSync(envPath)) {
  console.log("\nNo .env.example found. Create .env manually.");
} else {
  console.log("\n.env already exists - skipping.");
}

console.log("\nSetup complete. Run with: node login.js --headed --keep-open");
