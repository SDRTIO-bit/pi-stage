@echo off
chcp 65001 >nul
title RP Engine - Deploy

echo ============================================
echo     RP Engine - Project Setup
echo ============================================
echo.

REM ---- 1. Check Node.js ----
echo [1/4] Checking Node.js ...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo FAILED: Node.js not found. Please install from https://nodejs.org/
    echo        Node.js 18+ recommended
    pause
    exit /b 1
)
for /f "tokens=*" %%a in ('node --version') do set "NODE_VER=%%a"
echo   OK   Node.js %NODE_VER%

echo.

REM ---- 2. Install dependencies ----
echo [2/4] Installing dependencies ...
call npm install
if %errorlevel% neq 0 (
    echo FAILED: npm install error. Check your network.
    pause
    exit /b 1
)
echo   OK   Dependencies installed

echo.

REM ---- 3. Install pi agent ----
echo [3/4] Checking pi coding agent ...
pi --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing @earendil-works/pi-coding-agent ...
    call npm install -g @earendil-works/pi-coding-agent
    if %errorlevel% neq 0 (
        echo FAILED: Install pi failed. Try: npm install -g @earendil-works/pi-coding-agent
        pause
        exit /b 1
    )
    echo   OK   pi installed
) else (
    echo   OK   pi already installed
)

echo.

REM ---- 4. Done ----
echo [4/4] All done!
echo.
echo ============================================
echo   Next steps:
echo ============================================
echo.
echo   1. Import character cards:
echo      Drag .png/.json files onto "ImportCharacterCard.bat"
echo.
echo   2. Start pi:
echo      pi
echo.
echo   3. In pi, use:
echo      /card list       - list imported cards
echo      /card activate   - activate a card
echo      /status          - show status panel
echo.
echo   4. Start role playing!
echo.
echo ============================================
echo.
pause
