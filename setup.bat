@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ============================================
echo       PI RP Engine -- Setup Script
echo ============================================
echo.

REM ============================================================
REM Step 0: Check Node.js (version >= 22)
REM ============================================================
echo [1/6] Checking Node.js...

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] Node.js not found. Install from: https://nodejs.org/
    echo   Requires version ^>= 22
    pause
    exit /b 1
)

REM Verify version >= 22 (let Node check itself -- most reliable)
node -e "process.exit(parseInt(process.version.slice(1).split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if %errorlevel% neq 0 (
    echo   [ERROR] Node.js version ^>= 22 required.
    echo   Current version:
    node -v
    echo   Install from: https://nodejs.org/
    pause
    exit /b 1
)

echo   Node.js -- OK
node -v

REM Get major version for later checks
for /f %%a in ('node -p "process.version.slice(1).split('.')[0]"') do set NODE_MAJOR=%%a

echo   npm:
npm -v

REM ============================================================
REM Step 1: Install / Update PI CLI
REM ============================================================
echo.
echo [2/6] Installing PI CLI (@earendil-works/pi-coding-agent)...

npm list -g @earendil-works/pi-coding-agent >nul 2>&1
if %errorlevel% equ 0 (
    echo   PI CLI already installed, checking for updates...
    call npm update -g @earendil-works/pi-coding-agent
) else (
    echo   First-time install of PI CLI...
    call npm install -g @earendil-works/pi-coding-agent
)
if %errorlevel% neq 0 (
    echo   [WARNING] Global install failed (may need admin).
    echo   Trying local install as fallback...
    call npm install @earendil-works/pi-coding-agent
    if !errorlevel! neq 0 (
        echo   [ERROR] PI CLI install failed completely.
        echo   Run manually as admin: npm install -g @earendil-works/pi-coding-agent
        pause
        exit /b 1
    )
    echo   PI CLI installed locally (use npx pi to run)
)

REM ============================================================
REM Step 2: Install project dependencies
REM ============================================================
echo.
echo [3/6] Installing project dependencies...

REM esbuild binary compat on Node 24+
if !NODE_MAJOR! geq 24 (
    echo   Node 24+ detected, installing esbuild compat layer...
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
echo [4/6] Installing PI extensions...

if not exist "node_modules\pi-total-recall\" (
    echo   Installing pi-total-recall (with postinstall scripts)...
    call npm install pi-total-recall
    if !errorlevel! neq 0 (
        echo   Normal install failed, trying --ignore-scripts...
        call npm install pi-total-recall --ignore-scripts
    )
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
REM Step 4: Create required directories
REM ============================================================
echo.
echo [5/6] Creating project directories...

if not exist ".pi\memory\"           mkdir ".pi\memory"
if not exist ".pi\sessions\"         mkdir ".pi\sessions"
if not exist ".pi\extensions\"       mkdir ".pi\extensions"
if not exist ".pi\extensions\rp-engine\" mkdir ".pi\extensions\rp-engine"
if not exist ".pi\extensions\rp-web\"    mkdir ".pi\extensions\rp-web"

echo   Directories ready

REM ============================================================
REM Step 5: Verify critical files
REM ============================================================
echo.
echo [6/6] Verifying project files...

set ALL_OK=1

if not exist ".pi\agents\rp.md" (
    echo   [MISSING] .pi\agents\rp.md -- Agent definition
    set ALL_OK=0
) else (
    echo   [OK] .pi\agents\rp.md
)
if not exist ".pi\settings.json" (
    echo   [MISSING] .pi\settings.json -- Extension config
    set ALL_OK=0
) else (
    echo   [OK] .pi\settings.json
)
if not exist ".pi\extensions\rp-engine\index.ts" (
    echo   [MISSING] .pi\extensions\rp-engine\index.ts -- Engine entry
    set ALL_OK=0
) else (
    echo   [OK] .pi\extensions\rp-engine\index.ts
)
if not exist ".pi\extensions\rp-web\rp-web.html" (
    echo   [MISSING] .pi\extensions\rp-web\rp-web.html -- Web frontend
    set ALL_OK=0
) else (
    echo   [OK] .pi\extensions\rp-web\rp-web.html
)

REM ============================================================
REM Done
REM ============================================================
echo.
if !ALL_OK! equ 1 (
    echo ============================================
    echo   Setup complete.
    echo ============================================
    echo.
    echo   Start command:
    echo     pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
    echo.
    echo   RP Web UI:   http://localhost:3012
    echo   RP status:   /rp-mode
    echo   Card list:   /rp-cards
    echo.
) else (
    echo ============================================
    echo   Setup done but some files are missing.
    echo ============================================
    echo   Make sure you are in the project root
    echo   directory and all files are in place.
)
pause
