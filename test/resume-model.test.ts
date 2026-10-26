import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { isQuotaExhausted, promptWithResumeFallback } from "../src/resume-model.js";

const old = { provider: "exhausted", id: "child" } as Model<any>;
const parent = { provider: "available", id: "parent" } as Model<any>;
function fixture() {
  const session = {
    model: old,
    messages: [] as Array<{ role: string; stopReason?: string; errorMessage?: string }>,
    setModel: vi.fn(async (model: Model<any>) => { session.model = model; }),
    prompt: vi.fn(async (_text: string) => {}),
  };
  return { session, sdk: session as unknown as AgentSession };
}

describe("resume quota model fallback", () => {
  it.each(["insufficient_quota", "quota exceeded", "quota has been exhausted", "You've hit your usage limit", "usage limit reached", "余额不足", "配额已耗尽"])("recognizes hard exhaustion: %s", message => {
    expect(isQuotaExhausted(message)).toBe(true);
  });
  it.each(["429 too many requests", "rate limit exceeded", "network timeout", "context window exceeded", "No API key", "quota remaining: 12"])("does not reroute unrelated error: %s", message => {
    expect(isQuotaExhausted(message)).toBe(false);
  });
  it("switches before execution after a saved quota failure", async () => {
    const { session, sdk } = fixture();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "insufficient_quota" });
    const execute = vi.fn(async () => { expect(session.model).toBe(parent); });
    const changed = vi.fn();
    await promptWithResumeFallback(sdk, execute, { fallbackModel: parent, onModelChange: changed }, () => true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith(parent);
    expect(changed).toHaveBeenCalledWith(parent, "quota");
    expect(session.prompt).not.toHaveBeenCalled();
  });
  it("continues without replaying original execution after a resolved provider error", async () => {
    const { session, sdk } = fixture();
    const execute = vi.fn(async () => { session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "quota exceeded" }); });
    await promptWithResumeFallback(sdk, execute, { fallbackModel: parent }, () => true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith(parent);
    expect(session.prompt).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Do not repeat completed tool actions"));
  });
  it("handles thrown quota errors, but never retries a failing fallback", async () => {
    const { session, sdk } = fixture();
    session.prompt.mockRejectedValue(new Error("insufficient_quota"));
    await expect(promptWithResumeFallback(sdk, async () => { throw new Error("insufficient_quota"); }, { fallbackModel: parent }, () => true)).rejects.toThrow("insufficient_quota");
    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });
  it("honors an explicit model override", async () => {
    const { session, sdk } = fixture();
    await promptWithResumeFallback(sdk, async () => { expect(session.model).toBe(parent); }, { model: parent }, () => true);
    expect(session.setModel).toHaveBeenCalledExactlyOnceWith(parent);
  });
  it("does not switch on a stale error followed by success", async () => {
    const { session, sdk } = fixture();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "quota exceeded" }, { role: "assistant", stopReason: "stop" });
    await promptWithResumeFallback(sdk, async () => {}, { fallbackModel: parent }, () => true);
    expect(session.setModel).not.toHaveBeenCalled();
  });
  it("preserves cancellation, exhausted turn budget and identical model", async () => {
    for (const mode of ["abort", "budget", "same"] as const) {
      const { session, sdk } = fixture();
      const abort = new AbortController();
      if (mode === "abort") abort.abort();
      const execute = vi.fn(async () => { throw new Error("quota exceeded"); });
      const result = promptWithResumeFallback(sdk, execute, { fallbackModel: mode === "same" ? old : parent, signal: abort.signal }, () => mode !== "budget");
      if (mode === "same") await expect(result).rejects.toThrow("quota exceeded");
      else await result;
      expect(session.setModel).not.toHaveBeenCalled();
      expect(session.prompt).not.toHaveBeenCalled();
    }
  });
});
