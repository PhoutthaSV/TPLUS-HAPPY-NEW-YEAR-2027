@echo off
chcp 65001 >nul
cd /d "%~dp0"
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  cloudflared is not installed. Install it once with:
  echo     winget install --id Cloudflare.cloudflared
  echo  then close this window and run start-online.bat again.
  echo.
  pause
  exit /b
)
start "" http://localhost:3000
node server.js --tunnel
pause
