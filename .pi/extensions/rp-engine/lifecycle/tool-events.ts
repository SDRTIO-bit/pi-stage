/**
 * RP Engine - 工具生命周期事件处理
 *
 * tool_call: 工具执行前（入参校验、权限检查）
 * tool_result: 工具执行后（审计日志、工具使用统计）
 *
 * ⭐ 各工具自己负责 appendHistory（见 tools.ts）。
 *   tool_result 不做历史写入以避免重复，仅做横切关注点。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ToolLifecycleDeps {
  store: import("../state-store").StateStore;
}

/**
 * 注册 tool 生命周期事件
 */
export function registerToolLifecycle(
  pi: ExtensionAPI,
  _deps: ToolLifecycleDeps
): void {
  // ============================================================
  // tool_call: 工具执行前 — 入参校验
  // 注意：旧版 PI 可能不支持 tool_call 事件，try-catch 静默降级
  // ============================================================
  try {
    pi.on("tool_call", (event: any) => {
      const toolName = event?.name || event?.toolName;
      const params = event?.params || event?.arguments;

      if (!toolName || !params) return;

      let errorMsg: string | null = null;

      switch (toolName) {
        case "update_state":
          if (!params.char) errorMsg = "缺少必填参数: char";
          else if (!params.updates) errorMsg = "缺少必填参数: updates";
          break;
        case "advance_time":
          if (params.days !== undefined) {
            if (params.days < 1 || params.days > 30) errorMsg = "days 必须在 1-30 之间";
          }
          break;
      }

      if (errorMsg) {
        console.warn(`[RP] tool_call 校验 (${toolName}): ${errorMsg}`);
        event.reject?.(errorMsg);
      }
    });
  } catch {
    console.warn("[RP] PI 不支持 tool_call 事件，跳过");
  }

  // ============================================================
  // tool_result: 工具执行后 — 使用统计（暂留扩展点）
  // 各工具自行调 appendHistory，此处不做重复写入
  // ============================================================
  try {
    pi.on("tool_result", (_event: any) => {
      // 未来可扩展：工具执行耗时统计、频率监控等
    });
  } catch {
    // PI 不支持 tool_result，静默跳过
  }
}
