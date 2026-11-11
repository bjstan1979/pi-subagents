import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Shared across loader module copies, keyed by real session identity, never cwd/env.
const key = Symbol.for("pi-subagents:resolved-common-by-session");
const registry = globalThis as typeof globalThis & { [key]?: Map<string, string> };
const sources = registry[key] ??= new Map<string, string>();

export function rememberResolvedCommon(sessionId: string, text: string): void {
  if (typeof text !== "string") throw new Error("Missing loader-resolved append source");
  if (Buffer.byteLength(text, "utf8") > 65536 || text.includes("\0")) {
    throw new Error("Invalid loader-resolved common rules (size/NUL)");
  }
  sources.set(sessionId, text.trim());
}
export function hasResolvedCommon(sessionId: string): boolean { return sources.has(sessionId); }
export function resolvedCommon(sessionId: string): string {
  if (!sources.has(sessionId)) throw new Error(`No resolved common source for session ${sessionId}`);
  return sources.get(sessionId)!;
}
export function forgetResolvedCommon(sessionId: string): void { sources.delete(sessionId); }

// Feature detection permits a clear failure on older runtimes, not a source fallback.
// The API returns only the loader-selected field, never the parent rendered prompt.
export function captureResolvedCommon(ctx: ExtensionContext): string {
  const id = ctx.sessionManager.getSessionId();
  forgetResolvedCommon(id);
  const host = ctx as ExtensionContext & { getResolvedAppendSystemPrompt?: () => string };
  if (typeof host.getResolvedAppendSystemPrompt !== "function") {
    throw new Error("Managed roles require runtime getResolvedAppendSystemPrompt; no common-source fallback is allowed");
  }
  const text = host.getResolvedAppendSystemPrompt();
  rememberResolvedCommon(id, text);
  return resolvedCommon(id);
}

export function registerResolvedCommon(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    captureResolvedCommon(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => { captureResolvedCommon(ctx); });
  pi.on("session_shutdown", (_event, ctx) => forgetResolvedCommon(ctx.sessionManager.getSessionId()));
}
