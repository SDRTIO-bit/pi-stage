#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     PI RP Engine — 一键安装脚本          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ============================================================
# Step 0: 检查 Node.js
# ============================================================
echo "[1/5] 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "  [错误] 未找到 Node.js，请先安装: https://nodejs.org/"
    echo "  要求版本 >= 22"
    exit 1
fi
echo "   Node.js $(node -v)"
echo "   npm $(npm -v)"

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)

# ============================================================
# Step 1: 安装 / 更新 PI CLI
# ============================================================
echo ""
echo "[2/5] 安装 PI CLI (@earendil-works/pi-coding-agent)..."
if npm list -g @earendil-works/pi-coding-agent &> /dev/null; then
    echo "   PI CLI 已安装，检查更新..."
    npm update -g @earendil-works/pi-coding-agent
else
    echo "   首次安装 PI CLI..."
    npm install -g @earendil-works/pi-coding-agent
fi || echo "   [警告] PI CLI 安装失败，请手动: npm install -g @earendil-works/pi-coding-agent"

# ============================================================
# Step 2: 安装项目依赖
# ============================================================
echo ""
echo "[3/5] 安装项目依赖..."

# esbuild 在 Node 24 上 binary 可能有问题
if [ "$NODE_MAJOR" -ge 24 ]; then
    echo "   Node 24 检测到，先安装 esbuild 兼容层..."
    npm install esbuild@latest --save-dev 2>/dev/null || true
fi

npm install
echo "   项目依赖安装完成"

# ============================================================
# Step 3: 安装 PI 扩展（pi-total-recall 元包）
# ============================================================
echo ""
echo "[4/5] 安装 PI 扩展..."

if [ ! -d "node_modules/pi-total-recall" ]; then
    echo "   pi-total-recall 未成功安装，尝试 --ignore-scripts..."
    npm install pi-total-recall --ignore-scripts
fi

# 验证三个子扩展
for pkg in "@samfp/pi-memory" "pi-session-search" "pi-knowledge-search"; do
    if [ -d "node_modules/$pkg" ]; then
        echo "   ✅ $pkg"
    else
        echo "   ⚠️  $pkg 未找到"
    fi
done

# ============================================================
# Step 4: 创建必要目录 + 验证项目结构
# ============================================================
echo ""
echo "[5/5] 初始化项目目录..."

mkdir -p .pi/memory .pi/sessions

ALL_OK=1
for f in ".pi/agents/rp.md" ".pi/settings.json" ".pi/extensions/rp-engine/index.ts" ".pi/extensions/rp-web/rp-web.html"; do
    if [ ! -f "$f" ]; then
        echo "   ⚠️  缺少 $f"
        ALL_OK=0
    fi
done

# ============================================================
# 完成
# ============================================================
echo ""
if [ "$ALL_OK" -eq 1 ]; then
    echo "╔══════════════════════════════════════════╗"
    echo "║  ✅ 安装完成！                           ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""
    echo "  启动命令:"
    echo "    pi --extension .pi/extensions/rp-engine/index.ts --tools \"read,bash\" --thinking high"
    echo ""
    echo "  RP Web 前端: http://localhost:3012"
    echo "  RP 模式状态: /rp-mode"
    echo "  角色卡列表:   /rp-cards"
    echo ""
else
    echo "╔══════════════════════════════════════════╗"
    echo "║  ⚠️  安装完成但部分文件缺失               ║"
    echo "╚══════════════════════════════════════════╝"
    echo "  请确认你在正确的项目目录下运行此脚本。"
fi
