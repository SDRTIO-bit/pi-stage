/**
 * RP Engine - Author Note（作者注）
 *
 * 在每轮对话中向 AI 注入一条精简的系统指令，用于维持输出质量和一致性。
 * 支持环境变量动态配置，方便在长对话中调整 AI 行为偏好。
 */

/** 默认的 Author Note 文本，作为环境变量未设置时的兜底 */
const DEFAULT_AUTHOR_NOTE =
  "[系统指令：请以角色的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]";

/**
 * AuthorNote 类
 *
 * - 读取环境变量 `RP_AUTHOR_NOTE` 作为注入文本
 * - 提供 `getInjectionText()` 方法返回当前注文
 * - 支持运行时通过 `setNote()` 动态修改
 */
export class AuthorNote {
  /** 当前注入文本 */
  private note: string;

  constructor() {
    this.note = process.env.RP_AUTHOR_NOTE || DEFAULT_AUTHOR_NOTE;
  }

  /**
   * 获取当前的 Author Note 注入文本
   * @returns 注入文本字符串
   */
  getInjectionText(): string {
    return this.note;
  }

  /**
   * 动态设置新的注入文本（运行时修改）
   * @param text 新的注入文本，为空则恢复默认值
   */
  setNote(text?: string): void {
    this.note = text || process.env.RP_AUTHOR_NOTE || DEFAULT_AUTHOR_NOTE;
  }

  /**
   * 重置为默认值（从环境变量或兜底值读取）
   */
  reset(): void {
    this.note = process.env.RP_AUTHOR_NOTE || DEFAULT_AUTHOR_NOTE;
  }
}
