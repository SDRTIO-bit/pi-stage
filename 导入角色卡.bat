@echo off
chcp 65001 >nul
cd /d "%~dp0"

set CARD_PATH=%~1

if not "%CARD_PATH%"=="" goto :import

echo Drag and drop a character card file here, then press Enter.
echo Supports: PNG / WEBP / JPEG / JSON
echo.
set /p CARD_PATH="Card file: "

if "%CARD_PATH%"=="" (
    echo No file provided.
    pause
    exit /b 1
)

REM Strip surrounding quotes from drag-and-drop
set CARD_PATH=%CARD_PATH:"=%

:import
echo.
echo Importing: %CARD_PATH%
node scripts/import-card.mjs "%CARD_PATH%"
pause
