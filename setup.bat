@echo off
chcp 65001 >nul
setlocal

echo.
echo ============================================
echo   PI RP Engine -- Requirements Check
echo ============================================
echo.

set MISSING=0

REM --- Node.js ---
echo Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [MISSING] Node.js (>= 22)
    set MISSING=1
) else (
    for /f %%a in ('node -v') do echo   [OK] Node.js %%a
)

REM --- npm ---
echo Checking npm...
call npm -v >nul 2>&1
if %errorlevel% neq 0 (
    echo   [MISSING] npm
    set MISSING=1
) else (
    for /f %%a in ('call npm -v') do echo   [OK] npm %%a
)

REM --- PI CLI ---
echo Checking PI CLI...
call npm list -g @earendil-works/pi-coding-agent >nul 2>&1
if %errorlevel% neq 0 (
    echo   [MISSING] @earendil-works/pi-coding-agent
) else (
    echo   [OK] PI CLI
)

REM --- Project deps ---
echo Checking project dependencies...
if exist "node_modules\" (
    echo   [OK] node_modules/
) else (
    echo   [MISSING] node_modules/ (run: npm install)
    set MISSING=1
)

REM --- pi-total-recall ---
echo Checking pi-total-recall...
if exist "node_modules\pi-total-recall\" (
    echo   [OK] pi-total-recall
) else (
    echo   [MISSING] pi-total-recall (run: npm install pi-total-recall)
    set MISSING=1
)

REM --- Directories ---
echo Checking directories...
for %%d in (".pi\memory" ".pi\sessions" ".pi\extensions\rp-engine" ".pi\extensions\rp-web") do (
    if not exist %%d (
        echo   [MISSING] %%d
        set MISSING=1
    )
)

REM --- Critical files ---
echo Checking critical files...
for %%f in (
    ".pi\agents\rp.md"
    ".pi\settings.json"
    ".pi\extensions\rp-engine\index.ts"
    ".pi\extensions\rp-web\rp-web.html"
    ".rpconfig.json"
) do (
    if exist %%f (
        echo   [OK] %%f
    ) else (
        echo   [MISSING] %%f
        set MISSING=1
    )
)

REM --- Result ---
echo.
if %MISSING% equ 0 (
    echo ============================================
    echo   All requirements met.
    echo ============================================
    echo.
    echo   To start:
    echo     pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
    echo.
    echo   RP Web:  http://localhost:3012
) else (
    echo ============================================
    echo   Some requirements are missing.
    echo ============================================
    echo.
    echo   Minimum setup:
    echo     1. Install Node.js >= 22: https://nodejs.org/
    echo     2. npm install
    echo     3. npm install -g @earendil-works/pi-coding-agent
    echo     4. npm install pi-total-recall
    echo     5. Ensure .pi/ directory has all required files
)
pause
