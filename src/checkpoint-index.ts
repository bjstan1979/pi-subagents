/**
 * CheckpointIndex — the cross-restart half of subagent resume.
 *
 * A settled agent whose conversation was persisted to disk (`rememberAgents` /
 * `persist_session`) stays resumable long after its in-memory record is gone.
 * Two records serve that:
 *
 * - The manager's tombstone map covers eviction *within* one parent session.
 * - This index covers the parent session itself being reopened
 *   (`pi --continue` / `--resume`): every settled top-level agent with a
 *   session file is appended to the parent session as a `subagents:checkpoint`
 *   custom entry, and `session_start` replays those entries into a fresh
 *   index. No state files of our own — the parent session transcript is the
 *   store, so checkpoints survive process death exactly as well as the
 *   session does, and `/new` deliberately starts clean (a new session gets
 *   fresh handles; nothing reaches an agent the user never started in it
 *   unless the model names that agent's id explicitly).
 *
 * Lookup is by exact agent id first, then handle/alias — the tool result texts
 * are what teach the model the id, so that is the path that must always work.
 */

export interface CheckpointEntry {
  id: string;
  handle?: string;
  alias?: string;
  type: string;
  description: string;
  /** Always set — an agent with no session file has nothing to reopen. */
  sessionFile: string;
  status: string;
  completedAt: number;
}

/** The pi custom-entry type checkpoints ride as, via `pi.appendEntry`. */
export const CHECKPOINT_ENTRY_TYPE = "subagents:checkpoint";

/** Same bound as the manager's tombstone map — a memory cap, nothing else. */
export const MAX_CHECKPOINTS = 100;

export class CheckpointIndex {
  private entries = new Map<string, CheckpointEntry>();

  add(entry: CheckpointEntry): void {
    if (!entry || typeof entry.id !== "string" || !entry.id) return;
    if (typeof entry.sessionFile !== "string" || !entry.sessionFile) return;
    this.entries.set(entry.id, entry);
    // Oldest first, since the agent someone still wants to resume is the one
    // they used most recently.
    while (this.entries.size > MAX_CHECKPOINTS) {
      const oldest = [...this.entries.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.entries.delete(oldest.id);
    }
  }

  /** Drop an entry whose session file has gone: it can only ever fail. */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** Exact agent id first, then handle/alias case-insensitively. Among name
   *  matches the MOST RECENT entry wins, regardless of insertion order — a
   *  replayed index is inserted newest-first while a live session adds
   *  oldest-first, and the two must resolve the same way. */
  get(ref: string): CheckpointEntry | undefined {
    const exact = this.entries.get(ref);
    if (exact) return exact;
    const wanted = ref.toLowerCase();
    let best: CheckpointEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.handle?.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted) {
        if (!best || entry.completedAt > best.completedAt) best = entry;
      }
    }
    return best;
  }

  /** Newest first — the order a listing would present. */
  list(): CheckpointEntry[] {
    return [...this.entries.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Rebuild from the parent session's entries. Only well-formed
   * `subagents:checkpoint` custom entries are kept; anything else (including
   * entries from other extensions and malformed data) is ignored, so a
   * corrupt session file degrades to "fewer resumable agents", never a throw.
   */
  static fromSessionEntries(entries: readonly unknown[]): CheckpointIndex {
    const index = new CheckpointIndex();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (e.type !== "custom" || e.customType !== CHECKPOINT_ENTRY_TYPE) continue;
      const data = e.data as Partial<CheckpointEntry> | undefined;
      if (!data || typeof data !== "object") continue;
      if (typeof data.id !== "string" || typeof data.sessionFile !== "string" || typeof data.type !== "string") continue;
      index.add({
        id: data.id,
        handle: typeof data.handle === "string" ? data.handle : undefined,
        alias: typeof data.alias === "string" ? data.alias : undefined,
        type: data.type,
        description: typeof data.description === "string" ? data.description : "",
        sessionFile: data.sessionFile,
        status: typeof data.status === "string" ? data.status : "completed",
        completedAt: typeof data.completedAt === "number" ? data.completedAt : 0,
      });
    }
    return index;
  }
}
