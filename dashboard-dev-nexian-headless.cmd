@echo off
setlocal
cd /d "%~dp0"

if not defined NODE_OPTIONS set NODE_OPTIONS=--max-old-space-size=512

echo.
echo Nexian dashboard (dev) — .env.nexian, headless browser + web UI
echo   Dashboard: http://127.0.0.1:3847
echo.

node login.js --dashboard --keep-open --nexian-env-file=.env.nexian %*
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="130" (
  echo.
  echo Dashboard stopped.
) else if not "%EXIT_CODE%"=="0" (
  echo.
  echo Dashboard exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
