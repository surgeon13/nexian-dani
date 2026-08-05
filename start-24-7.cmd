@echo off
REM Start Nexian 24/7 stack on Windows (keep-alive + dashboard bot).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install from https://nodejs.org/ then re-run.
  exit /b 1
)
if not exist ".env" (
  echo WARNING: .env missing. Copy .env.example to .env and set NEXIAN_USERNAME / NEXIAN_PASSWORD / GAME_HOST.
)
echo Starting 24/7 keep-alive on this PC...
echo Dashboard: http://127.0.0.1:3847
echo Leave this window open. Ctrl+C stops the watchdog.
node --max-old-space-size=256 scripts\start-24-7.js
