/**
 * RP Engine - Runtime Input State
 *
 * 跨生命周期事件（input → turn_end）传递用户原始输入的模块级缓存。
 *
 * 为什么不用 deps：
 * pi 的 lifecycle event system 中，每个 handler 的 deps 不共享引用，
 * 因此 deps.userLastInput = xxx 天然失效。
 *
 * 这里是 Runtime 生命周期层的共享状态，不是业务状态，
 * 不影响世界状态系统。
 *
 * ⚠️ 当前是模块级单例，多会话场景需要 session 化。
 *    升级路径：const sessionInputState = new Map<sessionId, RuntimeInputState>();
 */

interface RuntimeInputState {
  rawInput: string;
  timestamp: number;
}

const state: RuntimeInputState = {
  rawInput: '',
  timestamp: 0,
};

export function setRawInput(input: string): void {
  state.rawInput = input;
  state.timestamp = Date.now();
}

export function getRawInput(): string {
  return state.rawInput;
}

export function clearRawInput(): void {
  state.rawInput = '';
}

export function getInputState(): Readonly<RuntimeInputState> {
  return { ...state };
}
