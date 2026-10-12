import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
export const CHILD_SESSION_CONTEXT_SYMBOL = Symbol.for("pi-subagents:child-session-context");

// Share only the generic marker across duplicate package copies. No retired
// supervisor provider or capability is published or consumed here.
const registry = globalThis as typeof globalThis & {
  [CHILD_SESSION_CONTEXT_SYMBOL]?: AsyncLocalStorage<boolean>;
};
const childSessionContext = registry[CHILD_SESSION_CONTEXT_SYMBOL] ?? new AsyncLocalStorage<boolean>();
registry[CHILD_SESSION_CONTEXT_SYMBOL] = childSessionContext;

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
