/** Tiny dependency-free typed event emitter. Listener exceptions are swallowed. */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    this.listeners[event]?.delete(fn);
  }

  once<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const wrap = (p: Events[K]): void => {
      this.off(event, wrap);
      fn(p);
    };
    return this.on(event, wrap);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch {
        /* a broken listener must not break the meter */
      }
    }
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}
