/**
 * RP Engine - Tool & Command Registry
 * 
 * 可注册的工具/命令注册表，支持批量注册和动态添加。
 * 后续加新工具/命令只需新增文件并导入注册，不用改核心代码。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================
// Tool 注册表
// ============================================================

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (callId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
}

/** 工具注册表 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /** 注册一个工具 */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 获取指定工具 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 获取所有工具 */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 获取所有工具名称 */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 批量注册到 pi API */
  registerAll(pi: ExtensionAPI): void {
    for (const tool of this.tools.values()) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.execute,
      });
    }
  }
}

// ============================================================
// Command 注册表
// ============================================================

/** 命令定义 */
export interface CommandDefinition {
  name: string;
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
}

/** 命令注册表 */
export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();

  /** 注册一个命令 */
  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);
  }

  /** 获取指定命令 */
  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name);
  }

  /** 获取所有命令 */
  getAll(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /** 获取所有命令名称 */
  getNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /** 匹配用户输入，返回命中的命令和剩余参数 */
  match(input: string): { cmd: CommandDefinition; args: string } | null {
    const parts = input.trim().split(/\s+/);
    const cmdName = parts[0];
    const args = parts.slice(1).join(' ');
    const cmd = this.commands.get(cmdName);
    if (cmd) return { cmd, args };
    return null;
  }

  /** 批量注册到 pi API */
  registerAll(pi: ExtensionAPI): void {
    for (const cmd of this.commands.values()) {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: cmd.handler,
      });
    }
  }
}
