/**
 * RP Engine - Tool & Command Registry
 *
 * 零业务依赖的注册表工具类。后续加新工具/命令只需新增并注册。
 * 从 pi-stage-test 提取，无任何角色扮演业务逻辑。
 */

/** 最小类型声明：pi 扩展 API（由 pi 运行时注入） */
export interface ExtensionAPI {
  on(event: string, handler: (event: unknown, ctx?: unknown) => void): void
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: unknown
    execute: (
      callId: string,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>
  }): void
  registerCommand(
    name: string,
    cmd: { description: string; handler: (args: string, ctx: unknown) => Promise<void> },
  ): void
  appendEntry(type: string, data: unknown): void
  sendUserMessage(text: string, opts?: { deliverAs?: string; streamingBehavior?: "steer" | "followUp" }): void
}

export interface ExtensionContext {
  cwd: string
  ui: {
    setStatus?(tag: string, content: string): void
    notify?(msg: string, level?: string): void
  }
  hasUI: boolean
}

// ============================================================
// Tool 注册表
// ============================================================

/** 工具定义 - 对齐 pi.registerTool 的 execute 签名 */
export interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (
    callId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
}

/** 工具注册表 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  getNames(): string[] {
    return [...this.tools.keys()]
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
      })
    }
  }
}

// ============================================================
// Command 注册表
// ============================================================

/** 命令定义 - handler 接收 (args, ctx) */
export interface CommandDefinition {
  name: string
  description: string
  handler: (args: string, ctx: unknown) => Promise<void>
}

/** 命令注册表 */
export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>()

  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd)
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name)
  }

  getAll(): CommandDefinition[] {
    return [...this.commands.values()]
  }

  /** 批量注册到 pi API */
  registerAll(pi: ExtensionAPI): void {
    for (const cmd of this.commands.values()) {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: cmd.handler,
      })
    }
  }
}
