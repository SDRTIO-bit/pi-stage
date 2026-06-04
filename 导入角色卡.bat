@echo off
chcp 65001 > nul
cd /d "%~dp0"

if "%~1"=="" (
  echo 用法: 导入角色卡.bat ^<角色卡文件路径^>
  echo 支持: PNG / WEBP / JPEG / JSON
  exit /b 1
)

node scripts/import-card.mjs "%~1"
pause
