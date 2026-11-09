/**
 * agent-record-entry.ts — the read-only, trust-scoped result snapshot a
 * finished top-level agent leaves in the parent session.
 *
 * The live record is evicted about ten minutes after an agent finishes, read or
 * not, and is gone after a reload or a restart. Its completion notification
 * carries only a preview of the result and points at `get_subagent_result` for
 * the rest, so that pointer has to outlive the record. `subagents:record`
 * entries are the persisted snapshots; `get_subagent_result` falls back to
 * them, but ONLY to entries whose identity stamp matches the currently bound
 * parent. This stamp is not authentication against an extension that can write
 * arbitrary entries to the same session.
 *
 * This module is deliberately NOT a resume source. It never carries a child
 * session file, never checks `existsSync`, and never opens anything. Resuming a
 * conversation stays with the tombstone/checkpoint machinery in
 * `checkpoint-index.ts` / `checkpoint-discovery.ts`, which is exact-ID-only
 * across parents. Anything here is a RESULT read, on the ACTIVE BRANCH only.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "./agent-types.js";
import { getStatusNote, partialOutputSuffix } from "./status-note.js";
import type { AgentRecord } from "./types.js";

/** `customType` of the session entry a finished top-level agent appends. */
export const AGENT_RECORD_ENTRY_TYPE = "subagents:record";

/** Canonical identity of the parent session that owns a result record. */
export interface ParentIdentity {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  /** sha256 over the three fields above, with NUL separators. */
  epoch: string;
}

/**
 * v1 trust block. Written only when spawn-time parent identity was derivable;
 * a record without one is legacy history for cross-extension consumers and is
 * NEVER readable through the saved-result fallback.
 */
export interface ResultTrustV1 {
  version: 1;
  /** The manager's parentGeneration at spawn; guards in-process /new races. */
  switchEpoch: number;
  parentEpoch: string;
  parentSessionId: string;
  parentSessionFile: string;
  parentCwd: string;
}

/** The persisted snapshot of a finished agent. No path or resume fields. */
export interface AgentRecordEntryData {
  id: string;
  type: AgentRecord["type"];
  description: string;
  handle?: string;
  alias?: string;
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  resultRevision?: number;
  executionEpoch?: number;
  consumedRevision?: number;
  startedAt: number;
  completedAt?: number;
  trust?: ResultTrustV1;
}

/** Terminal statuses only: a queued/running snapshot has no result to return. */
const TERMINAL_STATUSES = new Set(["completed", "error", "stopped", "aborted", "steered"]);

/** Fields the excluded upstream reopen path would have added. Reject them. */
const REOPEN_FIELDS = ["sessionFile", "worktreeLost", "reopenTarget", "resumeSessionFile"] as const;

export function parentEpoch(sessionFile: string, sessionId: string, cwd: string): string {
  return createHash("sha256").update([sessionFile, sessionId, cwd].join("\0")).digest("hex");
}

/**
 * Canonicalize a parent session file path. A persisted parent file normally
 * exists, but a fresh/in-memory session may not have been flushed yet: fall
 * back to canonicalizing its directory and appending the basename, so identity
 * stays stable across a reload. An unresolvable cwd fails closed (undefined).
 */
function canonicalSessionFile(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    try {
      const absolute = resolve(file);
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return undefined;
    }
  }
}

/** Derive the current parent's identity from a live extension context. */
export function parentIdentityFromCtx(ctx: ExtensionContext): ParentIdentity | undefined {
  try {
    const sm = ctx.sessionManager as {
      getSessionId?: () => string;
      getSessionFile?: () => string | undefined;
    } | undefined;
    const sessionId = sm?.getSessionId?.();
    const sessionFile = sm?.getSessionFile?.();
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    if (typeof sessionFile !== "string" || sessionFile.length === 0) return undefined;
    if (typeof ctx.cwd !== "string" || ctx.cwd.length === 0) return undefined;
    const canonicalFile = canonicalSessionFile(sessionFile);
    const cwd = realpathSync(ctx.cwd);
    return {
      sessionId,
      sessionFile: canonicalFile ?? "",
      cwd,
      epoch: parentEpoch(canonicalFile ?? "", sessionId, cwd),
    };
  } catch {
    return undefined;
  }
}

/** Build a trust block from identity fields captured on the record at spawn. */
export function trustFromRecord(record: AgentRecord): ResultTrustV1 | undefined {
  const { parentEpoch: epoch, parentSessionId, parentSessionFile, parentCwd, switchEpoch } = record;
  if (
    typeof epoch !== "string" || epoch.length === 0 ||
    typeof parentSessionId !== "string" || parentSessionId.length === 0 ||
    typeof parentSessionFile !== "string" || parentSessionFile.length === 0 ||
    typeof parentCwd !== "string" || parentCwd.length === 0 ||
    typeof switchEpoch !== "number" || !Number.isSafeInteger(switchEpoch) || switchEpoch < 0
  ) return undefined;
  // Re-derive, so a record whose epoch does not match its own identity fields
  // cannot be stamped by mutating one field.
  if (epoch !== parentEpoch(parentSessionFile, parentSessionId, parentCwd)) return undefined;
  return {
    version: 1,
    switchEpoch,
    parentEpoch: epoch,
    parentSessionId,
    parentSessionFile,
    parentCwd,
  };
}

/** Snapshot a finished record for {@link AGENT_RECORD_ENTRY_TYPE}. */
export function agentRecordEntryData(record: AgentRecord): AgentRecordEntryData {
  const trust = trustFromRecord(record);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    handle: record.handle,
    alias: record.alias,
    status: record.status,
    result: record.result,
    error: record.error,
    resultRevision: record.resultRevision ?? 1,
    executionEpoch: record.executionEpoch ?? 1,
    consumedRevision: record.consumedRevision,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    ...(trust ? { trust } : {}),
  };
}

/** Shape validation, shared by trusted and untrusted inspection. */
function isAgentRecordEntryData(data: unknown): data is AgentRecordEntryData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  for (const field of REOPEN_FIELDS) if (field in d) return false;
  if (typeof d.id !== "string" || d.id.length === 0) return false;
  if (typeof d.type !== "string" || d.type.length === 0) return false;
  if (typeof d.description !== "string") return false;
  if (typeof d.status !== "string" || !TERMINAL_STATUSES.has(d.status)) return false;
  if (typeof d.startedAt !== "number" || !Number.isFinite(d.startedAt)) return false;
  if (d.completedAt !== undefined && (typeof d.completedAt !== "number" || !Number.isFinite(d.completedAt))) return false;
  for (const key of ["result", "error", "handle", "alias"] as const) {
    if (d[key] !== undefined && typeof d[key] !== "string") return false;
  }
  for (const key of ["resultRevision", "executionEpoch", "consumedRevision"] as const) {
    const value = d[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) return false;
  }
  return true;
}

/** Whether a persisted record is trusted for a result read in THIS parent. */
export function isTrustedSavedResult(
  data: unknown,
  current: ParentIdentity,
): data is AgentRecordEntryData & { trust: ResultTrustV1 } {
  if (!isAgentRecordEntryData(data)) return false;
  const trust = data.trust;
  if (typeof trust !== "object" || trust === null) return false;
  const t = trust as unknown as Record<string, unknown>;
  if (t.version !== 1) return false;
  if (typeof t.switchEpoch !== "number" || !Number.isSafeInteger(t.switchEpoch) || t.switchEpoch < 0) return false;
  for (const key of ["parentEpoch", "parentSessionId", "parentSessionFile", "parentCwd"] as const) {
    if (typeof t[key] !== "string" || (t[key] as string).length === 0) return false;
  }
  if (t.parentSessionId !== current.sessionId) return false;
  if (t.parentSessionFile !== current.sessionFile) return false;
  if (t.parentCwd !== current.cwd) return false;
  if (t.parentEpoch !== current.epoch) return false;
  if (t.parentEpoch !== parentEpoch(t.parentSessionFile as string, t.parentSessionId as string, t.parentCwd as string)) return false;
  return true;
}

/** Whether a trusted record answers a handle/alias ref, case-insensitively. */
export function hasTrustedName(data: unknown, ref: string, current: ParentIdentity): boolean {
  if (!isTrustedSavedResult(data, current)) return false;
  const wanted = ref.toLowerCase();
  return data.handle?.toLowerCase() === wanted || data.alias?.toLowerCase() === wanted;
}

/**
 * The latest trusted result record for `ref` on the CURRENT branch. Exact ID
 * always wins, even over a newer handle/alias collision. With `matchNames`,
 * the newest matching handle/alias by `completedAt` (then branch order) wins.
 * Reads `getBranch()` only — never `getEntries()`, never any file — and returns
 * undefined for a missing/unreadable branch or an unverifiable parent identity.
 */
export function findTrustedAgentRecordEntry(
  ctx: ExtensionContext,
  ref: string,
  options: { matchNames?: boolean } = {},
): AgentRecordEntryData | undefined {
  const current = parentIdentityFromCtx(ctx);
  if (!current || current.sessionFile.length === 0) return undefined;
  let entries: readonly unknown[];
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    entries = branch;
  } catch {
    return undefined;
  }
  let named: AgentRecordEntryData | undefined;
  let namedCompletedAt = -Infinity;
  let namedIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | null | undefined;
    if (!entry || entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isAgentRecordEntryData(data) || !isTrustedSavedResult(data, current)) continue;
    if (data.id === ref) return data;
    if (options.matchNames && hasTrustedName(data, ref, current)) {
      const at = data.completedAt ?? -Infinity;
      if (named === undefined || at > namedCompletedAt || (at === namedCompletedAt && i > namedIndex)) {
        named = data;
        namedCompletedAt = at;
        namedIndex = i;
      }
    }
  }
  return named;
}

function savedDurationMs(startedAt: number, completedAt?: number): string {
  return `${(((completedAt ?? Date.now()) - startedAt) / 1000).toFixed(1)}s`;
}

/** The read-only answer for a saved result. Mirrors the live result's shape. */
export function formatSavedAgentRecord(saved: AgentRecordEntryData): string {
  const displayName = getConfig(saved.type).displayName;
  let out =
    `Agent: ${saved.id}\n` +
    `Result revision: ${saved.resultRevision ?? 1}\n` +
    `Type: ${displayName} | Status: ${saved.status}${getStatusNote(saved.status)} | Duration: ${savedDurationMs(saved.startedAt, saved.completedAt)}\n` +
    `Description: ${saved.description}\n` +
    "(From this session's saved result record: the live record has been cleaned up, so live stats and the full conversation are unavailable.)\n\n";
  if (saved.status === "error") {
    out += `Error: ${saved.error ?? ""}${partialOutputSuffix(saved)}`;
  } else {
    out += saved.result?.trim() || "No output.";
  }
  return out;
}
