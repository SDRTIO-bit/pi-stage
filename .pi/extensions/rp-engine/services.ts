/**
 * RP Engine - 服务容器
 *
 * 统一收集所有共享服务实例，消除 inline 依赖传递。
 * 各生命周期模块从 EngineServices 中选取自己需要的字段。
 */

import type { RPConfig } from "./config";
import type { StateStore } from "./state-store";
import type { RuntimeBridge } from "./runtime-integration";
import type { AuthorNote } from "./author-note";
import type { CompiledRegexHook } from "./regex-processor";
import type { WorldbookService } from "./worldbook";
import type { TavernRunner } from "./tavern-runner";
import type { MemoryStore } from "./prototypes/memory-store";
import type { SceneScheduler } from "./prototypes/scene-scheduler";
import type { WorldAgent } from "./prototypes/world-agent";
import type { CharacterRegistry } from "./prototypes/character-registry";

export interface EngineServices {
  configRef: { current: RPConfig };
  store: StateStore;
  rpWeb: ReturnType<typeof import("./rp-web-server").createRPWebServer>;
  agentApi: ReturnType<typeof import("./agent-api").createAgentApiServer>;
  runtime: RuntimeBridge;
  authorNote: AuthorNote;
  compiledHooks: { current: CompiledRegexHook[] };
  stateDir: { current: string };
  worldbookDir: { current: string };
  userTurnCounter: { value: number };
  lastTotalTokens: { value: number };
  worldbook: WorldbookService;
  tavernRunner: TavernRunner;
  /** 记忆存储（可选，由 features.memoryStore 控制） */
  memoryStore?: MemoryStore;
  /** 场景调度器（可选，由 features.sceneScheduler 控制） */
  sceneScheduler?: SceneScheduler;
  /** 世界事件推演引擎 */
  worldAgent?: WorldAgent;
  /** 角色 Agent 注册中心 */
  characterRegistry?: CharacterRegistry;
}
