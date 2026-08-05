@echo off
REM One-time PC setup: npm install + Playwright Chromium.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install LTS from https://nodejs.org/
  exit /b 1
)
echo [setup-pc] npm install...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 exit /b 1
echo [setup-pc] Playwright Chromium...
call npx.cmd playwright install chromium
if errorlevel 1 exit /b 1
if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [setup-pc] created .env from .env.example — edit credentials before starting.
  )
)
echo [setup-pc] done. Next: edit .env then run start-24-7.cmd
