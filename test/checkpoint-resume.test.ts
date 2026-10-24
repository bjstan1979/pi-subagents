/**
 * checkpoint-resume.test.ts — the Agent tool's `resume` reaching agents whose
 * in-memory record is gone.
 *
 * Two layers pin opposite failure directions:
 * - evicted this session → the manager's tombstone (the @handle mention path's
 *   own record, now also reachable by the model);
 * - settled before the process exited → the checkpoint index replayed from the
 *   parent session file.
 * A resume that silently started a FRESH agent would read as success while
 * discarding the conversation, so every test asserts on `resumeSessionFile`
 * actually reaching runAgent, not just on the result text.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { CHECKPOINT_ENTRY_TYPE, CheckpointIndex, MAX_CHECKPOINTS } from "../src/checkpoint-index.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("CheckpointIndex", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "a1", handle: "explore", type: "Explore", description: "d",
    sessionFile: "/s/a1.jsonl", status: "completed", completedAt: 1, ...over,
  });

  it("resolves by exact id first, then handle/alias case-insensitively", () => {
    const index = new CheckpointIndex();
    index.add(entry());
    index.add(entry({ id: "a2", handle: "explore-2", alias: "scout", completedAt: 2 }));
    expect(index.get("a2")?.handle).toBe("explore-2");
    expect(index.get("EXPLORE")?.id).toBe("a1");
    expect(index.get("Scout")?.id).toBe("a2");
    expect(index.get("nope")).toBeUndefined();
  });

  it("prunes to the cap, oldest first", () => {
    const index = new CheckpointIndex();
    for (let i = 0; i < MAX_CHECKPOINTS + 5; i++) index.add(entry({ id: `a${i}`, completedAt: i }));
    expect(index.get("a0")).toBeUndefined();
    expect(index.get("a4")).toBeUndefined();
    expect(index.get("a5")).toBeDefined();
    expect(index.get(`a${MAX_CHECKPOINTS + 4}`)).toBeDefined();
  });

  it("rejects entries without an id or session file", () => {
    const index = new CheckpointIndex();
    index.add(entry({ id: "" }));
    index.add(entry({ sessionFile: "" }));
    index.add(undefined as any);
    expect(index.list()).toHaveLength(0);
  });

  it("removes an entry whose session file has gone", () => {
    const index = new CheckpointIndex();
    index.add(entry());
    index.remove("a1");
    expect(index.get("a1")).toBeUndefined();
    expect(index.get("explore")).toBeUndefined();
  });

  it("replays only well-formed checkpoint entries out of a session history", () => {
    const history = [
      { type: "message", message: { role: "user" } },
      { type: "custom", customType: "subagents:record", data: { id: "not-a-checkpoint" } },
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: { id: "a1", sessionFile: "/s/a1.jsonl", type: "Explore" } },
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: { sessionFile: "/s/x.jsonl", type: "Explore" } },
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: "garbage" },
      null,
    ];
    const index = CheckpointIndex.fromSessionEntries(history);
    expect(index.get("a1")?.sessionFile).toBe("/s/a1.jsonl");
    expect(index.list()).toHaveLength(1);
  });
});

describe("Agent tool resume — evicted and reopened sessions", () => {
  /** Inside the hermetic cwd, so teardown takes it with the rest. */
  const sessionPath = () => join(process.cwd(), "explore-session.jsonl");

  /** A session that reports its file, so the settle-time checkpoint fires. */
  function fakeSession() {
    return {
      steer: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
      sessionManager: { getSessionFile: vi.fn(() => sessionPath()) },
    } as any;
  }

  function finishedRun() {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      const session = fakeSession();
      // The manager captures record.sessionFile here, exactly as in production.
      opts.onSessionCreated?.(session);
      return { responseText: "first answer", session, aborted: false, steered: false, failure: undefined };
    });
  }

  function boot(settings: Record<string, unknown> = {}) {
    hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    return b;
  }

  async function spawnBackground(tools: Map<string, any>): Promise<string> {
    const r = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "find flaky tests", subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    return /Agent ID: (\S+)/.exec(textOf(r))![1];
  }

  /** GC the record the way the 10-minute timer would, leaving a tombstone. */
  async function evict(id: string) {
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = manager.getRecord(id);
    expect(record.sessionFile).toBe(sessionPath());
    // The transcript exists on disk — the tombstone is only as good as it.
    writeFileSync(record.sessionFile, "");
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBeUndefined();
    return manager;
  }

  /** The registry hides the manager itself; tombstones show through resolution. */
  const tombstoned = (ref: string) => {
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    return registry.getRecord(ref) === undefined;
  };

  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("resumes an evicted agent from its tombstone through the tool", async () => {
    const { pi, tools } = boot();
    finishedRun();
    const id = await spawnBackground(tools);
    await flush();
    // Settled with a persisted session: the checkpoint entry rode the parent
    // session file alongside the history record.
    const checkpointCalls = vi.mocked(pi.appendEntry).mock.calls.filter(c => c[0] === CHECKPOINT_ENTRY_TYPE);
    expect(checkpointCalls).toHaveLength(1);
    expect(checkpointCalls[0][1]).toMatchObject({ id, handle: "explore", sessionFile: sessionPath() });
    await evict(id);
    vi.mocked(runAgent).mockClear();
    finishedRun();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "keep going", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(result);
    expect(text).toContain("Resumed @explore");
    const newId = /Agent ID: (\S+)/.exec(text)![1];
    expect(newId).not.toBe(id);

    // The saved conversation actually reached the run, and the handle came
    // back with it — a fresh spawn would have failed both assertions.
    const opts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(opts.resumeSessionFile).toBe(sessionPath());
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(manager.getRecord(newId).handle).toBe("explore");
  });

  it("keeps resumable agents resumable after the parent session reopens", async () => {
    const { tools, lifecycle } = boot();
    // A checkpoint written by a PREVIOUS process: this run never saw the
    // agent, so no tombstone could answer — only the replayed index can.
    writeFileSync(sessionPath(), "");
    const past = {
      id: "past-agent-1", handle: "explore", type: "Explore", description: "find flaky tests",
      sessionFile: sessionPath(), status: "completed", completedAt: 1,
    };
    await lifecycle.get("session_start")({ type: "session_start" }, ctx({
      sessionManager: { getSessionId: vi.fn(() => "s1"), getEntries: vi.fn(() => [{ type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: past }]) },
    }));
    vi.mocked(runAgent).mockClear();
    finishedRun();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: "past-agent-1", prompt: "continue where you left off", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(result);
    expect(text).toContain("Resumed @explore");
    const opts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(opts.resumeSessionFile).toBe(sessionPath());
  });

  it("resumes an evicted agent inline when run_in_background is false", async () => {
    const { tools } = boot();
    finishedRun();
    const id = await spawnBackground(tools);
    await flush();
    await evict(id);
    vi.mocked(runAgent).mockClear();
    finishedRun();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "keep going", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(result);
    // Inline: the resumed run's own answer is in THIS result — the only way a
    // print/RPC caller ever sees it.
    expect(text).toContain("Resumed @explore inline from its saved session");
    expect(text).toContain("first answer");
    const opts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(opts.resumeSessionFile).toBe(sessionPath());
  });

  it("reports a tombstone whose session file has gone, and drops it", async () => {
    const { tools } = boot();
    finishedRun();
    const id = await spawnBackground(tools);
    await flush();
    await evict(id);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(sessionPath());
    vi.mocked(runAgent).mockClear();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "keep going", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(result)).toContain("session file is gone");
    expect(runAgent).not.toHaveBeenCalled();
    // Dropped: a later resume attempt falls through to not-found instead of
    // failing forever.
    expect(tombstoned(id)).toBe(true);
  });

  it("tells the model a settled foreground agent is resumable, by id", async () => {
    const { tools } = boot();
    finishedRun();

    const result = await tools.get("Agent").execute(
      "tc-fg",
      { prompt: "go", description: "find flaky tests", subagent_type: "Explore", run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );
    const text = textOf(result);
    expect(text).toContain("first answer");
    // The note carries the id itself, so the model can act on it verbatim.
    const id = /`resume` parameter set to "([^"]+)"/.exec(text)?.[1];
    expect(id).toBeTruthy();
    expect((globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id!)).toBeDefined();
  });
});

describe("Agent tool resume — untouched paths", () => {
  function boot(settings: Record<string, unknown> = {}) {
    hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    return b;
  }

  afterEach(async () => {
    await booted?.get("session_shutdown")?.();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    booted = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  it("still refuses to resume an agent that is still running", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockImplementation(
      (_c: any, _t: any, _p: any, o: any) => new Promise(() => { o.onSessionCreated?.({ steer: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), messages: [] }); }) as any,
    );
    const r = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "find flaky tests", subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
    await flush();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: id, prompt: "keep going", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(result)).toContain("still running");
  });
});
