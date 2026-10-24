/** Exact-id recovery across parent sessions; names remain session-local. */
import { createReadStream, type Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointEntry, CheckpointIndex } from "./checkpoint-index.js";

/**
 * Search only this session store and cwd, on demand after a local lookup misses.
 * Never cache misses: another process may have just finished the requested run.
 * Read-only discovery does not open/migrate a SessionManager or import handles.
 */
export async function findCheckpointById(
  sessionDir: string,
  ref: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CheckpointEntry | undefined> {
  signal?.throwIfAborted();
  if (!ref || ref.includes("/") || ref.includes("\\")) return undefined;
  let root: string;
  let workdir: string;
  let files: Dirent[];
  try {
    root = await realpath(sessionDir);
    workdir = await realpath(cwd);
    files = await readdir(root, { withFileTypes: true });
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
  let best: CheckpointEntry | undefined;
  for (const file of files) {
    signal?.throwIfAborted();
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const parents = new Map<string, string | null>();
    const matches = new Map<string, CheckpointEntry>();
    let leaf: string | undefined;
    const input = createReadStream(join(root, file.name), { encoding: "utf8", signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      let headerSeen = false;
      for await (const line of lines) {
        signal?.throwIfAborted();
        let entry: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          entry = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!headerSeen) {
          // Only real parent sessions in the same project are discovery roots.
          if (entry.type !== "session" || typeof entry.cwd !== "string" || entry.parentSession) break;
          if (await realpath(entry.cwd) !== workdir) break;
          headerSeen = true;
          continue;
        }
        if (typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")) continue;
        parents.set(entry.id, entry.parentId);
        leaf = entry.id;
        if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) continue;
        const data = entry.data as Partial<CheckpointEntry> | null | undefined;
        if (!data || data.id !== ref) continue;
        const checkpoint = CheckpointIndex.fromSessionEntries([entry]).get(ref);
        if (checkpoint) matches.set(entry.id, checkpoint);
      }
      // Follow the active leaf, not abandoned alternatives in the JSONL tree.
      const visited = new Set<string>();
      while (leaf && !visited.has(leaf)) {
        visited.add(leaf);
        const match = matches.get(leaf);
        if (match && (!best || match.completedAt > best.completedAt)) {
          try {
            const target = await realpath(match.sessionFile);
            if (target.startsWith(root + sep) && target.endsWith(".jsonl") && (await stat(target)).isFile()) {
              best = { ...match, sessionFile: target };
            }
          } catch {
            // Deleted files and symlinks escaping the store are not resumable.
          }
        }
        leaf = parents.get(leaf) ?? undefined;
      }
    } catch {
      // A concurrently removed or unreadable transcript must not hide others.
      signal?.throwIfAborted();
    } finally {
      lines.close();
      input.destroy();
    }
  }
  signal?.throwIfAborted();
  return best;
}
