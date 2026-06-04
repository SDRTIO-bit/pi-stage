@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════╗
echo ║     PI RP Engine — 一键安装脚本          ║
echo ╚══════════════════════════════════════════╝
echo.

REM ============================================================
REM Step 0: 检查 Node.js
REM ============================================================
echo [1/5] 检查 Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo   [错误] 未找到 Node.js，请先安装: https://nodejs.org/
    echo   要求版本 >= 22
    pause
    exit /b 1
)
for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
echo    Node.js 已安装:
node -v
echo    npm 已安装:
npm -v

REM ============================================================
REM Step 1: 安装 / 更新 PI CLI
REM ============================================================
echo.
echo [2/5] 安装 PI CLI (@earendil-works/pi-coding-agent)...
npm list -g @earendil-works/pi-coding-agent >nul 2>&1
if %errorlevel% equ 0 (
    echo    PI CLI 已安装，检查更新...
    call npm update -g @earendil-works/pi-coding-agent
) else (
    echo    首次安装 PI CLI...
    call npm install -g @earendil-works/pi-coding-agent
)
if %errorlevel% neq 0 (
    echo   [警告] PI CLI 安装失败，请手动执行:
    echo   npm install -g @earendil-works/pi-coding-agent
)

REM ============================================================
REM Step 2: 安装项目依赖
REM ============================================================
echo.
echo [3/5] 安装项目依赖...

REM 检查是否存在 node_modules
if exist "node_modules\" (
    echo    已有 node_modules，仅安装新增依赖...
)

REM esbuild 在 Node 24 上需要单独安装（postinstall 二进制兼容问题）
for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if !NODE_MAJOR! geq 24 (
    echo    Node 24 检测到，先安装 esbuild 兼容层...
    call npm install esbuild@latest --save-dev 2>nul
)

call npm install
if %errorlevel% neq 0 (
    echo   [错误] npm install 失败
    pause
    exit /b 1
)
echo    项目依赖安装完成

REM ============================================================
REM Step 3: 安装 PI 扩展（pi-total-recall 元包）
REM ============================================================
echo.
echo [4/5] 安装 PI 扩展...

REM pi-total-recall 已在 package.json dependencies 中
REM npm install 应已安装。如果 esbuild 导致 postinstall 失败：
if not exist "node_modules\pi-total-recall\" (
    echo    pi-total-recall 未成功安装，尝试 --ignore-scripts...
    call npm install pi-total-recall --ignore-scripts
)

REM 验证三个子扩展
if exist "node_modules\@samfp\pi-memory\" (
    echo    ✅ @samfp/pi-memory — 语义记忆
) else (
    echo    ⚠️  @samfp/pi-memory 未找到
)
if exist "node_modules\pi-session-search\" (
    echo    ✅ pi-session-search — 跨会话记忆搜索
) else (
    echo    ⚠️  pi-session-search 未找到
)
if exist "node_modules\pi-knowledge-search\" (
    echo    ✅ pi-knowledge-search — 世界书语义搜索
) else (
    echo    ⚠️  pi-knowledge-search 未找到
)

REM ============================================================
REM Step 4: 创建必要目录 + 验证项目结构
REM ============================================================
echo.
echo [5/5] 初始化项目目录...

REM 确保内存存储目录存在
if not exist ".pi\memory\" mkdir .pi\memory
if not exist ".pi\sessions\" mkdir .pi\sessions

REM 确保扩展目录存在
if not exist ".pi\extensions\rp-web\" mkdir .pi\extensions\rp-web

REM 验证关键文件
set ALL_OK=1
if not exist ".pi\agents\rp.md" (
    echo   ⚠️  缺少 .pi\agents\rp.md（Agent 定义文件）
    set ALL_OK=0
)
if not exist ".pi\settings.json" (
    echo   ⚠️  缺少 .pi\settings.json（PI 扩展配置）
    set ALL_OK=0
)
if not exist ".pi\extensions\rp-engine\index.ts" (
    echo   ⚠️  缺少 .pi\extensions\rp-engine\index.ts（RP 引擎入口）
    set ALL_OK=0
)
if not exist ".pi\extensions\rp-web\rp-web.html" (
    echo   ⚠️  缺少 .pi\extensions\rp-web\rp-web.html（RP Web 前端）
    set ALL_OK=0
)

REM ============================================================
REM 完成
REM ============================================================
echo.
if !ALL_OK! equ 1 (
    echo ╔══════════════════════════════════════════╗
    echo ║  ✅ 安装完成！                           ║
    echo ╚══════════════════════════════════════════╝
    echo.
    echo   启动命令:
    echo     pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
    echo.
    echo    RP Web 前端: http://localhost:3012
    echo    RP 模式状态: /rp-mode
    echo    角色卡列表:   /rp-cards
    echo.
) else (
    echo ╔══════════════════════════════════════════╗
    echo ║  ⚠️  安装完成但部分文件缺失               ║
    echo ╚══════════════════════════════════════════╝
    echo   请确认你在正确的项目目录下运行此脚本。
)
pause
