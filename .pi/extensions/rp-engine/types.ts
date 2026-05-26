/**
 * RP Engine - 引擎核心类型定义
 *
 * 通用引擎类型，不绑定任何特定游戏世界观。
 * 游戏自定义类型（CharacterState、WorldState）见 ./game-types.ts
 */

export interface HistoryRecord {
  timestamp: string;
  char: string;
  field: string;
  oldValue: any;
  newValue: any;
}

// ============================================================
// 卡片管理器相关类型
// ============================================================

/** 单张卡片条目 */
export interface CardEntry {
  id: string;           // 卡片目录名（唯一标识）
  dir: string;          // 卡片目录绝对路径
  imported_at: string;  // ISO 时间戳
}

/** 卡片注册表结构 */
export interface CardRegistry {
  cards: Record<string, CardEntry>;
  active: string[];     // 当前激活的卡片 id 列表（支持多卡并存）
}

/** 世界书条目（带来源卡片标记） */
export interface WorldbookFileEntry {
  /** 文件相对路径（如 "世界观/天作之合.md"） */
  file: string;
  /** 文件内容 */
  content: string;
  /** 命中关键词数（用于优先级排序） */
  hitCount: number;
  /** 内容 token 估算 */
  tokenEstimate: number;
  /** 来源卡片 id */
  sourceCard: string;
}

/** 卡片状态（引擎通用结构，不关心具体角色字段） */
export interface CardState {
  /** 卡片元信息 */
  meta: {
    name: string;
    route: string;
    started: boolean;
  };
  /** 该卡片的角色状态（角色名 → 角色数据，具体字段由卡片 variable_schema 定义） */
  characters: Record<string, any>;
  /** 该卡片的世界状态（可覆盖全局） */
  world?: Record<string, any>;
  /** 卡片特有标记 */
  flags: Record<string, any>;
}

// ============================================================
// 向后兼容的重新导出（从 game-types.ts 迁移而来）
// ============================================================

export type { WorldState, CharacterState } from "./game-types";
