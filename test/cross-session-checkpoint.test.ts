/** Cross-session discovery must recover IDs without importing another conversation by name. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCheckpointById } from "../src/checkpoint-discovery.js";
import { CHECKPOINT_ENTRY_TYPE, type CheckpointEntry, MAX_CHECKPOINTS } from "../src/checkpoint-index.js";

describe("findCheckpointById — cross-session ID recovery", () => {
  let root: string;
  let sessionDir: string;
  let cwd: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-cross-session-checkpoint-"));
    sessionDir = join(root, "sessions");
    cwd = join(root, "project");
    mkdirSync(sessionDir);
    mkdirSync(cwd);
    target = join(sessionDir, "agent.jsonl");
    writeFileSync(target, "");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function header(overrides: Record<string, unknown> = {}) {
    return { type: "session", version: 3, id: "parent-session", timestamp: "2026-01-01T00:00:00.000Z", cwd, ...overrides };
  }

  function checkpoint(overrides: Partial<CheckpointEntry> = {}): CheckpointEntry {
    return {
      id: "saved-agent-id", handle: "explore", alias: "scout", type: "Explore",
      description: "recover the saved conversation", sessionFile: target,
      status: "completed", completedAt: 10, ...overrides,
    };
  }

  function entry(id: string, parentId: string | null, data: unknown = checkpoint()) {
    return { type: "custom", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", customType: CHECKPOINT_ENTRY_TYPE, data };
  }

  function message(id: string, parentId: string | null) {
    return {
      type: "message", id, parentId, timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "continue", timestamp: 1 },
    };
  }

  function parentFile(name: string, entries: readonly unknown[], sessionHeader: unknown = header()) {
    const path = join(sessionDir, name);
    writeFileSync(path, `${[sessionHeader, ...entries].map(line => JSON.stringify(line)).join("\n")}\n`);
    return path;
  }

  it("recovers an exact data.id from a different parent session", async () => {
    const saved = checkpoint();
    parentFile("older-parent.jsonl", [entry("cp", null, saved), message("tip", "cp")]);
    expect(await findCheckpointById(sessionDir, saved.id, cwd)).toEqual(saved);
  });

  it.each(["explore", "EXPLORE", "scout", "SCOUT", "SAVED-AGENT-ID", "saved-agent", "@saved-agent-id"])(
    "does not recover handle, alias, prefix or normalized ID %s", async ref => {
      parentFile("older-parent.jsonl", [entry("cp", null)]);
      expect(await findCheckpointById(sessionDir, ref, cwd)).toBeUndefined();
    },
  );

  it("does not let a newer handle/alias collision shadow an exact ID", async () => {
    const saved = checkpoint();
    parentFile("older-parent.jsonl", [
      entry("exact", null, saved),
      entry("collision", "exact", checkpoint({ id: "unrelated-id", handle: saved.id, alias: saved.id, completedAt: 100 })),
    ]);
    expect(await findCheckpointById(sessionDir, saved.id, cwd)).toEqual(saved);
  });

  it("does not cross project boundaries even when the parent directory is shared", async () => {
    const otherProject = join(root, "other-project");
    mkdirSync(otherProject);
    parentFile("foreign-parent.jsonl", [entry("cp", null)], header({ cwd: otherProject }));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("compares canonical project paths rather than their spelling", async () => {
    const projectLink = join(root, "project-link");
    symlinkSync(cwd, projectLink, "dir");
    parentFile("older-parent.jsonl", [entry("cp", null)], header({ cwd: projectLink }));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", realpathSync(cwd))).toEqual(checkpoint());
    expect(await findCheckpointById(sessionDir, "saved-agent-id", projectLink)).toEqual(checkpoint());
  });

  it("skips subagent sessions with parentSession set", async () => {
    parentFile("child.jsonl", [entry("cp", null)], header({ parentSession: join(sessionDir, "parent.jsonl") }));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("ignores an abandoned branch despite its newer checkpoint timestamp", async () => {
    const active = checkpoint({ completedAt: 10 });
    parentFile("branched-parent.jsonl", [
      message("root", null),
      entry("abandoned", "root", checkpoint({ completedAt: 1000, description: "wrong branch" })),
      entry("active", "root", active),
      message("tip", "active"),
    ]);
    expect(await findCheckpointById(sessionDir, active.id, cwd)).toEqual(active);
  });

  it("returns not-found when the ID exists only on an abandoned branch", async () => {
    parentFile("branched-parent.jsonl", [
      message("root", null), entry("abandoned", "root"), message("active-tip", "root"),
    ]);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("keeps old exact IDs beyond the CheckpointIndex memory cap", async () => {
    const entries = [entry("old-checkpoint", null)];
    let parentId = "old-checkpoint";
    for (let i = 0; i < MAX_CHECKPOINTS + 5; i++) {
      const id = `new-checkpoint-${i}`;
      entries.push(entry(id, parentId, checkpoint({ id: `new-agent-${i}`, completedAt: 100 + i })));
      parentId = id;
    }
    parentFile("large-parent.jsonl", entries);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toEqual(checkpoint());
  });

  it("chooses maximum completedAt across files and within a branch, not traversal order", async () => {
    const newest = checkpoint({ completedAt: 500, description: "newest completion" });
    parentFile("a-parent.jsonl", [
      entry("newest", null, newest), entry("older-tip", "newest", checkpoint({ completedAt: 1 })),
    ]);
    parentFile("z-parent.jsonl", [entry("middle", null, checkpoint({ completedAt: 100 }))]);
    expect(await findCheckpointById(sessionDir, newest.id, cwd)).toEqual(newest);
  });

  it("uses CheckpointIndex field validation and defaults for matching data", async () => {
    parentFile("older-parent.jsonl", [
      entry("valid", null, { id: "saved-agent-id", sessionFile: target, type: "Explore", handle: 42, alias: false }),
      entry("bad-type", "valid", { id: "saved-agent-id", sessionFile: target, type: 42, completedAt: 1000 }),
      entry("bad-path", "bad-type", { id: "saved-agent-id", sessionFile: 42, type: "Explore" }),
    ]);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toEqual({
      id: "saved-agent-id", sessionFile: target, type: "Explore", description: "", status: "completed", completedAt: 0,
      handle: undefined, alias: undefined,
    });
  });

  it("ignores malformed interior JSON and a truncated tail without losing the active branch", async () => {
    const path = parentFile("damaged-parent.jsonl", []);
    writeFileSync(path, [
      JSON.stringify(header()), "{broken JSON}", "null", JSON.stringify(entry("cp", null)),
      JSON.stringify(message("tip", "cp")), '{"type":"custom","id":"unfinished",',
    ].join("\n"));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toEqual(checkpoint());
  });

  it.each([
    { type: "message", cwd: "/not-a-session" },
    { type: "session", id: "missing-cwd", version: 3 },
    null,
  ])("rejects a file without a valid session header: %j", async invalidHeader => {
    parentFile("invalid-header.jsonl", [entry("cp", null)], invalidHeader);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("does not accept a checkpoint-only file as a parent session", async () => {
    writeFileSync(join(sessionDir, "headerless.jsonl"), `${JSON.stringify(entry("cp", null))}\n`);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("does not recurse or scan non-jsonl files, directories, or symlinked parent files", async () => {
    const nested = join(sessionDir, "nested");
    mkdirSync(nested);
    mkdirSync(join(sessionDir, "directory.jsonl"));
    const contents = `${[header(), entry("cp", null)].map(line => JSON.stringify(line)).join("\n")}\n`;
    writeFileSync(join(nested, "parent.jsonl"), contents);
    writeFileSync(join(sessionDir, "parent.txt"), contents);
    const externalParent = join(root, "external-parent.jsonl");
    writeFileSync(externalParent, contents);
    symlinkSync(externalParent, join(sessionDir, "symlink-parent.jsonl"));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("also skips a parent-file symlink whose target is inside sessionDir", async () => {
    const nested = join(sessionDir, "nested");
    mkdirSync(nested);
    const source = join(nested, "parent.jsonl");
    writeFileSync(source, `${[header(), entry("cp", null)].map(line => JSON.stringify(line)).join("\n")}\n`);
    symlinkSync(source, join(sessionDir, "linked-parent.jsonl"));
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("allows a real target in a subdirectory even though discovery is nonrecursive", async () => {
    const nested = join(sessionDir, "agents");
    mkdirSync(nested);
    const nestedTarget = join(nested, "saved.jsonl");
    writeFileSync(nestedTarget, "");
    const saved = checkpoint({ sessionFile: nestedTarget });
    parentFile("older-parent.jsonl", [entry("cp", null, saved)]);
    expect(await findCheckpointById(sessionDir, saved.id, cwd)).toEqual(saved);
  });

  it.each(["outside", "prefix-sibling", "directory", "wrong-extension", "external-symlink", "symlinked-directory"])(
    "rejects unsafe checkpoint targets: %s", async kind => {
      const external = join(root, "external.jsonl");
      writeFileSync(external, "");
      let unsafe: string;
      switch (kind) {
        case "outside":
          unsafe = external;
          break;
        case "prefix-sibling":
          mkdirSync(`${sessionDir}-other`);
          unsafe = join(`${sessionDir}-other`, "saved.jsonl");
          writeFileSync(unsafe, "");
          break;
        case "directory":
          unsafe = join(sessionDir, "directory.jsonl");
          mkdirSync(unsafe);
          break;
        case "wrong-extension":
          unsafe = join(sessionDir, "saved.txt");
          writeFileSync(unsafe, "");
          break;
        case "external-symlink":
          unsafe = join(sessionDir, "escape.jsonl");
          symlinkSync(external, unsafe);
          break;
        default:
          symlinkSync(root, join(sessionDir, "escape-dir"), "dir");
          unsafe = join(sessionDir, "escape-dir", "external.jsonl");
      }
      parentFile("older-parent.jsonl", [entry("cp", null, checkpoint({ sessionFile: unsafe }))]);
      expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
    },
  );

  it("returns undefined for a deleted checkpoint target", async () => {
    parentFile("older-parent.jsonl", [entry("cp", null)]);
    unlinkSync(target);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
  });

  it("returns undefined for a missing session directory", async () => {
    expect(await findCheckpointById(join(root, "missing"), "saved-agent-id", cwd)).toBeUndefined();
  });

  it("does not cache misses when a new parent file arrives", async () => {
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toBeUndefined();
    parentFile("arrived-later.jsonl", [entry("cp", null)]);
    expect(await findCheckpointById(sessionDir, "saved-agent-id", cwd)).toEqual(checkpoint());
  });

  it.each(["present", "missing"])("throws on pre-aborted discovery even with a %s directory", async state => {
    parentFile("older-parent.jsonl", [entry("cp", null)]);
    const controller = new AbortController();
    controller.abort();
    await expect(findCheckpointById(
      state === "present" ? sessionDir : join(root, "missing"), "saved-agent-id", cwd, controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
