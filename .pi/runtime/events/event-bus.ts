/**
 * Event Bus - 精简实现
 * 提供 Runtime 内部的事件发布/订阅
 */

export type EventHandler = (data: any) => void | Promise<void>;

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, data?: any): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        const result = handler(data);
        if (result instanceof Promise) {
          result.catch(e => console.warn(`[EventBus] handler error on ${event}:`, e));
        }
      }
    }
  }

  async emitAsync(event: string, data?: any): Promise<void> {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const promises: Promise<void>[] = [];
      for (const handler of handlers) {
        try {
          const result = handler(data);
          if (result instanceof Promise) promises.push(result);
        } catch (e) {
          console.warn(`[EventBus] handler error on ${event}:`, e);
        }
      }
      await Promise.allSettled(promises);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export default EventBus;
