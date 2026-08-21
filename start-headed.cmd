@echo off
REM One-click launcher for "npm run login:headed" (visible browser + keep-open).
REM Double-click this file in Windows Explorer to start the bot.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS release from https://nodejs.org/ then re-run.
  pause
  exit /b 1
)

if not defined NODE_OPTIONS set NODE_OPTIONS=--max-old-space-size=768

echo.
echo Nexian login — headed browser + keep-open (same as "npm run login:headed")
echo.

node login.js --headed --keep-open %*
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="130" (
  echo.
  echo Stopped.
) else if not "%EXIT_CODE%"=="0" (
  echo.
  echo Exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
