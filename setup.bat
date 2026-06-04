@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo.
echo +==========================================+
echo ^|     PI RP Engine -- Setup Script         ^|
echo +==========================================+
echo.

REM ============================================================
REM Step 0: Check Node.js
REM ============================================================
echo [1/5] Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] Node.js not found. Install from: https://nodejs.org/
    echo   Requires version ^>= 22
    pause
    exit /b 1
)
echo   Node.js:
node -v
echo   npm:
npm -v

REM ============================================================
REM Step 1: Install / Update PI CLI
REM ============================================================
echo.
echo [2/5] Installing PI CLI (@earendil-works/pi-coding-agent)...
npm list -g @earendil-works/pi-coding-agent >nul 2>&1
if %errorlevel% equ 0 (
    echo   PI CLI already installed, checking for updates...
    call npm update -g @earendil-works/pi-coding-agent
) else (
    echo   First-time install of PI CLI...
    call npm install -g @earendil-works/pi-coding-agent
)
if %errorlevel% neq 0 (
    echo   [WARNING] PI CLI install failed. Run manually:
    echo   npm install -g @earendil-works/pi-coding-agent
)

REM ============================================================
REM Step 2: Install project dependencies
REM ============================================================
echo.
echo [3/5] Installing project dependencies...

if exist "node_modules\" (
    echo   node_modules exists, installing new deps only...
)

REM esbuild binary compat on Node 24+
for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if !NODE_MAJOR! geq 24 (
    echo   Node 24 detected, installing esbuild compat layer...
    call npm install esbuild@latest --save-dev 2>nul
)

call npm install
if %errorlevel% neq 0 (
    echo   [ERROR] npm install failed
    pause
    exit /b 1
)
echo   Project dependencies installed

REM ============================================================
REM Step 3: Install PI extensions (pi-total-recall)
REM ============================================================
echo.
echo [4/5] Checking PI extensions...

if not exist "node_modules\pi-total-recall\" (
    echo   pi-total-recall not installed, retrying --ignore-scripts...
    call npm install pi-total-recall --ignore-scripts
)

if exist "node_modules\@samfp\pi-memory\" (
    echo   [OK] @samfp/pi-memory -- semantic memory
) else (
    echo   [MISSING] @samfp/pi-memory not found
)
if exist "node_modules\pi-session-search\" (
    echo   [OK] pi-session-search -- cross-session search
) else (
    echo   [MISSING] pi-session-search not found
)
if exist "node_modules\pi-knowledge-search\" (
    echo   [OK] pi-knowledge-search -- worldbook search
) else (
    echo   [MISSING] pi-knowledge-search not found
)

REM ============================================================
REM Step 4: Create dirs + verify project structure
REM ============================================================
echo.
echo [5/5] Initializing project directories...

if not exist ".pi\memory\" mkdir ".pi\memory"
if not exist ".pi\sessions\" mkdir ".pi\sessions"
if not exist ".pi\extensions\rp-web\" mkdir ".pi\extensions\rp-web"

set ALL_OK=1
if not exist ".pi\agents\rp.md" (
    echo   [MISSING] .pi\agents\rp.md (agent definition)
    set ALL_OK=0
)
if not exist ".pi\settings.json" (
    echo   [MISSING] .pi\settings.json (PI extension config)
    set ALL_OK=0
)
if not exist ".pi\extensions\rp-engine\index.ts" (
    echo   [MISSING] .pi\extensions\rp-engine\index.ts (RP engine entry)
    set ALL_OK=0
)
if not exist ".pi\extensions\rp-web\rp-web.html" (
    echo   [MISSING] .pi\extensions\rp-web\rp-web.html (RP Web frontend)
    set ALL_OK=0
)

REM ============================================================
REM Done
REM ============================================================
echo.
if !ALL_OK! equ 1 (
    echo +==========================================+
    echo ^|  [OK] Setup complete!                   ^|
    echo +==========================================+
    echo.
    echo   Start command:
    echo     pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
    echo.
    echo   RP Web UI:   http://localhost:3012
    echo   RP status:   /rp-mode
    echo   Card list:   /rp-cards
    echo.
) else (
    echo +==========================================+
    echo ^|  [WARN] Setup done but some files missing ^|
    echo +==========================================+
    echo   Make sure you are in the correct project directory.
)
pause
