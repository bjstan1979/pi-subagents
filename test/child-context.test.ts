import type { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("exposes only a generic non-HCOM marker with concurrent branch isolation", async () => {
    const symbol = Symbol.for("pi-subagents:child-session-context");
    const marker = (globalThis as unknown as Record<symbol, AsyncLocalStorage<boolean>>)[symbol];
    expect(marker).toBeDefined();
    await Promise.all([
      runInChildSessionContext(async () => {
        await Promise.resolve();
        expect(marker.getStore()).toBe(true);
      }),
      (async () => {
        await Promise.resolve();
        expect(marker.getStore()).toBeUndefined();
      })(),
    ]);
    expect(marker.getStore()).toBeUndefined();
  });

  it("prevents a child resource load from creating another extension manager", async () => {
    const pi = new Proxy({}, {
      get: vi.fn(() => {
        throw new Error("child extension factory must be a no-op");
      }),
    });

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });
  });
});
