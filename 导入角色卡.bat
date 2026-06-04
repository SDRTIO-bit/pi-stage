@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: import-card.bat ^<card-file-path^>
  echo Supports: PNG / WEBP / JPEG / JSON
  pause
  exit /b 1
)

node scripts/import-card.mjs "%~1"
pause
