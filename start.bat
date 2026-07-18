@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
if not exist assets\icon-256.png (
  node scripts\gen-icon.js
)
start "" /b node_modules\.bin\electron.cmd .
exit /b 0
