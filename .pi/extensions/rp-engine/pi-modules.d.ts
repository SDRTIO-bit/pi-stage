/**
 * RP Engine - pi 平台模块类型声明
 *
 * @earendil-works/pi-coding-agent 和 @earendil-works/pi-tui 由 pi 运行时提供，
 * 不是 npm 包。此文件提供最小类型声明，使 TypeScript --strict 编译通过。
 */

declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx?: any) => void): void;
    off(event: string, handler?: (event: any, ctx?: any) => void): void;
    registerTool(tool: { name: string; label: string; description: string; parameters: any; execute: (...args: any[]) => Promise<any> }): void;
    registerCommand(name: string, cmd: { description: string; handler: (args: string, ctx: any) => Promise<void> }): void;
    registerShortcut(shortcut: { key: string; description: string; command: string; handler?: () => void }): void;
    registerFlag(flag: { name: string; description: string; handler: (value: string) => void }): void;
    sendUserMessage(text: string, opts?: { deliverAs?: string }): void;
    appendEntry(type: string, data: any): void;
  }

  export interface ExtensionContext {
    cwd: string;
    ui: {
      setStatus(tag: string, content: string): void;
      notify(msg: string, level?: string): void;
      custom<T>(fn: (...args: any[]) => T): Promise<T>;
      theme: any;
    };
    sessionManager: {
      getBranch(): any[];
      getEntries(): any[];
    };
    model: any;
    isIdle(): boolean;
    abort(): void;
    compact(hint?: string): Promise<any>;
    hasUI: boolean;
  }

  export interface Theme {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  }

  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(text: string, width: number): string;
}

declare module '@earendil-works/pi-tui' {
  export function matchesKey(data: string, key: string): boolean;
  export function truncateToWidth(text: string, width: number): string;
}
