/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extract text from a message content block array. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && typeof c === "object" && c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

/**
 * Filter session entries to prune pre-compaction history while preserving
 * the latest compaction summary, kept pre-compaction entries (from firstKeptEntryId),
 * and all post-compaction entries.
 */
export function getPrunedSessionEntries(entries: any[]): any[] {
  if (!entries || !Array.isArray(entries) || entries.length === 0) return [];

  // Locate the latest compaction entry
  let latestCompactionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      latestCompactionIdx = i;
      break;
    }
  }

  // If no compaction occurred, all entries are active
  if (latestCompactionIdx === -1) {
    return entries;
  }

  const compaction = entries[latestCompactionIdx];
  const firstKeptEntryId = compaction.firstKeptEntryId;

  const pruned: any[] = [compaction];

  // If firstKeptEntryId is specified, include kept entries between firstKeptEntryId and compaction
  if (firstKeptEntryId) {
    let keeping = false;
    for (let i = 0; i < latestCompactionIdx; i++) {
      const entry = entries[i];
      if (entry?.id === firstKeptEntryId) {
        keeping = true;
      }
      if (keeping && entry?.type !== "compaction") {
        pruned.push(entry);
      }
    }
  }

  // Include all entries after the compaction
  for (let i = latestCompactionIdx + 1; i < entries.length; i++) {
    pruned.push(entries[i]);
  }

  return pruned;
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 */
export function buildParentContext(ctx: ExtensionContext): string {
  let entries: any[] = [];
  if (typeof (ctx?.sessionManager as any)?.buildContextEntries === "function") {
    try {
      const contextEntries = (ctx.sessionManager as any).buildContextEntries();
      if (Array.isArray(contextEntries)) {
        entries = contextEntries;
      }
    } catch {
      // Fall back to getBranch() if buildContextEntries fails
    }
  }

  if (entries.length === 0 && typeof ctx?.sessionManager?.getBranch === "function") {
    entries = ctx.sessionManager.getBranch() ?? [];
  }

  entries = getPrunedSessionEntries(entries);
  if (!entries || entries.length === 0) return "";

  const parts: string[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (text.trim()) parts.push(`[User]: ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
      }
      // Skip toolResult messages — too verbose for context
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      // Include compaction and branch summaries — they're already condensed
      if (typeof entry.summary === "string" && entry.summary.trim()) {
        parts.push(`[Summary]: ${entry.summary.trim()}`);
      }
    }
  }

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
