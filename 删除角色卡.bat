@echo off
chcp 65001 >nul
cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: delete-card.bat [card-id]
  echo Run without arguments to list all cards.
)

node scripts/delete-card.mjs %*
pause
