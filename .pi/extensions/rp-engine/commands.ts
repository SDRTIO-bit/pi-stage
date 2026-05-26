/**
 * RP Engine - 命令注册（/status, /history, /rp, /route）
 *
 * 每个命令定义为独立对象，通过 CommandRegistry 收集后批量注册到 pi API。
 * 后续加新命令只需：① 在此文件或新文件中定义 ② 加入 cmdRegistry.register()。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { StatusPanel, HistoryPanel } from "./tui-panels";
import { CommandRegistry, type CommandDefinition } from "./registry";
import {
  getRegistry,
  getActiveCardIds,
  getActiveCards,
  activateCards,
  deactivateCards,
  setActiveCard,
  getCardName,
} from "./card-manager";

/**
 * 创建所有命令定义，返回注册表
 */
export function createCommandRegistry(
  getState: () => Record<string, any>,
  saveState: () => void,
  getHistoryPath: () => string,
  stateDir?: string,  // 卡片模板读取用
  resetCardFromTemplate?: (cardId: string) => number  // 卡片隔离重置
): CommandRegistry {
  const registry = new CommandRegistry();

  // --------------------------------------------------
  // /status - 状态面板
  // --------------------------------------------------
  registry.register({
    name: "status",
    description: "显示所有角色的当前状态面板",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/status 需要交互模式", "error");
        return;
      }
      await (ctx.ui as any).custom((_tui: any, theme: any, _kb: any, done: any) => {
        return new StatusPanel(theme, () => done(), getState);
      });
    },
  });

  // --------------------------------------------------
  // /history - 查看历史
  // --------------------------------------------------
  registry.register({
    name: "history",
    description: "查看指定角色的状态变更历史。用法: /history <角色名>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/history 需要交互模式", "error");
        return;
      }
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("用法: /history <角色名>", "error");
        return;
      }
      await (ctx.ui as any).custom((_tui: any, theme: any, _kb: any, done: any) => {
        return new HistoryPanel(name, theme, () => done(), getHistoryPath);
      });
    },
  });

  // --------------------------------------------------
  // /rp - 帮助
  // --------------------------------------------------
  registry.register({
    name: "rp",
    description: "显示角色扮演系统帮助",
    handler: async (_args, ctx) => {
      const help = `
╔══ 角色扮演系统帮助 ══╗

工具（供 AI 调用）:
  read_state               - 读取角色状态
  update_state             - 更新角色状态
  advance_time             - 推进游戏时间
  load_worldbook           - 搜索世界书设定
  load_constant_worldbook  - 按顺序读取常开设定

命令（供你使用）:
  /status                  - 状态面板
  /history <角色名>        - 变更历史
  /card list               - 列出角色卡
  /card import <路径>      - 导入角色卡（.png / .json）
  /card activate <id>      - 激活卡片
  /card deactivate <id>    - 取消激活
  /reset [卡片id]          - 重置角色数值
  /rp                      - 本帮助

快速开始:
  1. /import C:\\路径\\角色卡.png   — 导入角色卡
  2. /card list                     — 确认卡片已注册
  3. 开始对话，AI 将自动读取角色设定并推进剧情
`;

      ctx.ui.notify(help, "info");
    },
  });

  // --------------------------------------------------
  // /card - 卡片管理
  // --------------------------------------------------
  registry.register({
    name: "card",
    description: "管理角色卡片。用法: /card list | /card import <路径> | /card activate <id...> | /card deactivate <id...> | /card set <id>",
    handler: async (args, ctx) => {
      const rawArgs = args?.trim() || "";
      const parts = rawArgs.split(/\s+/).filter(Boolean);
      const subCmd = parts[0] || "list";

      // /card list — 列出所有卡片
      if (subCmd === "list" || subCmd === "ls") {
        const reg = getRegistry();
        const activeIds = getActiveCardIds();
        const cardIds = Object.keys(reg.cards);

        if (cardIds.length === 0) {
          ctx.ui.notify("📭 没有已导入的角色卡。请使用 setup.mjs 导入角色卡。", "info");
          return;
        }

        let msg = `📇 角色卡列表 (${cardIds.length} 张)\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        for (const id of cardIds) {
          const name = getCardName(id);
          const status = activeIds.includes(id) ? "🟢 激活" : "⚪ 休眠";
          msg += `${status}  ${name} (${id})\n`;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `当前激活: ${activeIds.length > 0 ? activeIds.join(", ") : "无"}\n`;
        msg += `使用 /card activate <id> 激活卡片，/card deactivate <id> 取消激活`;
        ctx.ui.notify(msg, "info");
        return;
      }

      // /card import <path> — 导入角色卡
      if (subCmd === "import" || subCmd === "i") {
        const filePath = parts.slice(1).join(" ");
        if (!filePath) {
          ctx.ui.notify(
            "用法: /card import <文件路径>\n" +
            "支持 .png（SillyTavern V2/V3）和 .json 格式。\n" +
            "例如: /card import C:\\角色卡\\mycard.png",
            "error"
          );
          return;
        }

        if (!existsSync(filePath)) {
          ctx.ui.notify(`❌ 文件不存在: ${filePath}`, "error");
          return;
        }

        const ext = filePath.toLowerCase().split(".").pop();
        if (ext !== "png" && ext !== "json") {
          ctx.ui.notify("❌ 仅支持 .png 和 .json 格式的角色卡", "error");
          return;
        }

        ctx.ui.notify(`⏳ 正在导入角色卡...`, "info");

        try {
          const setupPath = join(process.cwd(), "setup.mjs");
          if (!existsSync(setupPath)) {
            ctx.ui.notify(`❌ 未找到 setup.mjs，请确认项目根目录结构完整`, "error");
            return;
          }

          const result = execSync(
            `node "${setupPath}" --import "${filePath}"`,
            { cwd: process.cwd(), encoding: "utf-8", timeout: 30000 }
          );

          const lines = result.trim().split("\n").filter(Boolean);
          const summary = lines.slice(-8).join("\n");
          ctx.ui.notify(`✅ 导入完成！\n${summary}`, "success");
        } catch (e: any) {
          ctx.ui.notify(`❌ 导入失败: ${e.message}`, "error");
        }
        return;
      }

      // /card activate <id...> — 激活卡片
      if (subCmd === "activate" || subCmd === "on") {
        const cardIds = parts.slice(1);
        if (cardIds.length === 0) {
          ctx.ui.notify("用法: /card activate <卡片id...>", "error");
          return;
        }
        const activated = activateCards(cardIds);
        if (activated.length === 0) {
          ctx.ui.notify("未找到有效的卡片 id。请先 /card list 确认。", "error");
        } else {
          const names = activated.map((id) => getCardName(id)).join("、");
          ctx.ui.notify(`✅ 已激活: ${names}\n⚠️ 请重启会话以使世界书和状态生效。`, "success");
        }
        return;
      }

      // /card deactivate <id...> — 取消激活
      if (subCmd === "deactivate" || subCmd === "off") {
        const cardIds = parts.slice(1);
        if (cardIds.length === 0) {
          ctx.ui.notify("用法: /card deactivate <卡片id...>", "error");
          return;
        }
        deactivateCards(cardIds);
        const names = cardIds.map((id) => getCardName(id)).join("、");
        ctx.ui.notify(`💤 已取消激活: ${names}\n⚠️ 请重启会话以使世界书和状态生效。`, "info");
        return;
      }

      // /card set <id> — 仅激活单张
      if (subCmd === "set") {
        const cardId = parts[1];
        if (!cardId) {
          ctx.ui.notify("用法: /card set <卡片id>", "error");
          return;
        }
        const ok = setActiveCard(cardId);
        if (!ok) {
          ctx.ui.notify(`未找到卡片 "${cardId}"。请先 /card list 确认。`, "error");
        } else {
          ctx.ui.notify(`✅ 已切换为单卡模式: ${getCardName(cardId)}\n⚠️ 请重启会话以使世界书和状态生效。`, "success");
        }
        return;
      }

      ctx.ui.notify(`未知子命令 "${subCmd}"。可用: list, activate, deactivate, set`, "error");
    },
  });

  // --------------------------------------------------
  // /reset - 重置所有角色数值到初始状态
  // --------------------------------------------------
  registry.register({
    name: "reset",
    description: "从卡片模板 state.json 重新加载角色初始数据。用法: /reset [卡片id]（省略则重置所有激活卡片）。",
    handler: async (args, ctx) => {
      const dir = stateDir || join(process.cwd(), ".pi");
      const activeIds = getActiveCardIds();

      // 解析目标卡片
      let targetIds: string[];
      const rawArgs = args?.trim() || "";
      if (rawArgs) {
        targetIds = rawArgs.split(/\s+/).filter(Boolean);
        // 验证都是已激活的卡片
        for (const id of targetIds) {
          if (!activeIds.includes(id)) {
            ctx.ui.notify(`卡片 "${id}" 未激活或不存在`, "error");
            return;
          }
        }
      } else {
        targetIds = activeIds;
      }

      if (targetIds.length === 0) {
        ctx.ui.notify("没有可重置的激活卡片", "error");
        return;
      }

      let totalResetCount = 0;
      for (const cardId of targetIds) {
        const count = resetCardFromTemplate ? resetCardFromTemplate(cardId) : 0;
        if (count === 0) {
          ctx.ui.notify(`卡片 "${cardId}" 的模板文件不存在，跳过`, "warning");
        } else {
          totalResetCount += count;
        }
      }

      saveState();
      const targetLabel = targetIds.length === 1 ? targetIds[0] : `${targetIds.length} 张卡片`;
      ctx.ui.notify(`✅ 已从模板重置 ${targetLabel}，共 ${totalResetCount} 个角色`, "success");
    },
  });

  return registry;
}

// 保留旧的 registerCommands 导出以兼容
export { createCommandRegistry as registerCommands };
