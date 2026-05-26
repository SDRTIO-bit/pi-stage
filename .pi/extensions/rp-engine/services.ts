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
}
