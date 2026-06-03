// ============================================================
// 生命周期 — 统一导出
// ============================================================

export { lifecycleBus } from "./events.js"
export { agentPipeline } from "./agent-pipeline.js"
export type { AgentAction, AgentContext, AgentMiddleware } from "./agent-pipeline.js"
export { registerSkillHooks, skillCollector, regenerateSkills } from "./skill-hooks.js"
