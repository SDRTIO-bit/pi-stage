/**
 * RP Engine - 游戏自定义类型
 *
 * 本文件定义的是具体游戏/角色卡用的类型模板。
 * 这些类型由导入的角色卡（variable_schema.json / state.json）驱动，
 * 不是引擎核心类型——用户可按自己导入的卡片修改此文件。
 *
 * 引擎核心类型见 ./types.ts
 */

/** 世界状态（游戏自定义字段） */
export interface WorldState {
  当前日期: string;
  当前星期: string;
  当前时间: string;
  当前位置: string;
  [key: string]: any;
}

/** 角色状态（由 active card 的 variable_schema.json 驱动，不硬绑定任何特定卡片） */
export interface CharacterState {
  基本信息?: { 姓名?: string; [key: string]: any };
  当前状态?: { 所在地点?: string; 内心想法?: string; [key: string]: any };
  [key: string]: any;
}
