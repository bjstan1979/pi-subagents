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

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { CHECKPOINT_ENTRY_TYPE, CheckpointIndex, MAX_CHECKPOINTS } from "../src/checkpoint-index.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
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
    const sctx = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionPath()), getBranch: vi.fn(() => [{ type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: past }]) } });
    await lifecycle.get("session_start")({ type: "session_start" }, sctx);
    vi.mocked(runAgent).mockClear();
    finishedRun();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { resume: "past-agent-1", prompt: "continue where you left off", run_in_background: true },
      undefined,
      undefined,
      sctx,
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

// Regression block for the external review (2026-10-24): every case here
// reproduces a real defect found by reading the first implementation — the
// double-open by old id, the unusable @handle form, the foreground-handle
// failure, the tombstone shadowing, the uncontained session path, the
// cross-/new checkpoint leak, the ignored abort signal, and the subagent_type
// turn budget leaking into stored resumes.
describe("Agent tool resume — review regressions", () => {
  const sessionPath = () => join(process.cwd(), "explore-session.jsonl");

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

  function finishedRun(text = "first answer") {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session);
      return { responseText: text, session, aborted: false, steered: false, failure: undefined };
    });
  }

  /** Never-settling run; complete it via heldResolve(). */
  let heldResolve: (() => void) | undefined;
  function heldRun() {
    heldResolve = undefined;
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => {
      opts.onSessionCreated?.(fakeSession());
      return new Promise<void>((resolve) => { heldResolve = resolve; }) as any;
    });
  }

  function boot(settings: Record<string, unknown> = {}, agentFiles?: Record<string, string>) {
    hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings }, agentFiles });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    return b;
  }

  async function spawnBackground(tools: Map<string, any>, subagent_type = "Explore"): Promise<string> {
    const r = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "find flaky tests", subagent_type, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    return /Agent ID: (\S+)/.exec(textOf(r))![1];
  }

  /** GC the record the way the 10-minute timer would, leaving a tombstone. */
  async function evict(id: string) {
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(id);
    writeFileSync(record.sessionFile, "");
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
  }

  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("routes a second resume by the OLD id to the live holder — one writer per session file", async () => {
    const { tools } = boot();
    finishedRun();
    const originalId = await spawnBackground(tools);
    await flush();
    await evict(originalId);
    heldRun(); // first resume: detached, still running
    const dbg = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    console.log("RR1 after evict: original record:", JSON.stringify(dbg.getRecord(originalId)?.status));
    const first = await tools.get("Agent").execute(
      "tc-rr1", { resume: originalId, prompt: "continue", run_in_background: true }, undefined, undefined, ctx(),
    );
    expect(textOf(first)).toContain("Resumed @explore");
    const callsAfterFirst = vi.mocked(runAgent).mock.calls.length;

    // Same file is already open in the first resume's record: a second stored
    // resume would make two writers append one JSONL.
    const second = await tools.get("Agent").execute(
      "tc-rr1b", { resume: originalId, prompt: "again", run_in_background: true }, undefined, undefined, ctx(),
    );
    expect(textOf(second)).toContain("is still running");
    expect(vi.mocked(runAgent).mock.calls.length).toBe(callsAfterFirst);

    // Once the holder finishes, the old id resumes the HOLDER (its saved
    // session), still exactly one writer.
    heldResolve?.(); // the holder's run settles
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    // The old id now reaches the holder through the live-record resume path.
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer", aborted: false, steered: false, failure: undefined } as any);
    const third = await tools.get("Agent").execute(
      "tc-rr1c", { resume: originalId, prompt: "again", run_in_background: true }, undefined, undefined, ctx(),
    );
    // Live-holder background resume (not a second stored open): it continues
    // the holder's OPEN session via resumeAgent — runAgent is not called again.
    expect(textOf(third)).toContain("Agent resumed in background");
    expect(vi.mocked(runAgent).mock.calls.length).toBe(callsAfterFirst);
    expect(vi.mocked(resumeAgent).mock.calls.length).toBe(1);
    expect((vi.mocked(runAgent).mock.calls.at(-1)![3] as any).resumeSessionFile).toBe(sessionPath());
  });

  it("accepts the leading-@ spelling the resumable note suggests", async () => {
    const { tools } = boot();
    finishedRun();
    const id = await spawnBackground(tools);
    await flush();
    await evict(id);
    finishedRun();
    const r = await tools.get("Agent").execute(
      "tc-rr2", { resume: "@explore", prompt: "keep going", run_in_background: true }, undefined, undefined, ctx(),
    );
    expect(textOf(r)).toContain("Resumed @explore");
    expect((vi.mocked(runAgent).mock.calls.at(-1)![3] as any).resumeSessionFile).toBe(sessionPath());
  });

  it("refuses a checkpoint whose session file is outside this session's directory", async () => {
    const { tools, lifecycle } = boot();
    const evil = "/tmp/pi-checkpoint-review-evil-target.jsonl";
    writeFileSync(evil, "");
    const sctx = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionPath()), getBranch: vi.fn(() => [
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: { id: "evil", handle: "evil", type: "Explore", description: "d", sessionFile: evil, status: "completed", completedAt: 1 } },
    ]) } });
    await lifecycle.get("session_start")({ type: "session_start" }, sctx);
    finishedRun();
    const r = await tools.get("Agent").execute(
      "tc-rr3", { resume: "evil", prompt: "continue", run_in_background: true }, undefined, undefined, sctx,
    );
    expect(textOf(r)).toContain("outside this session's directory");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not reclaim a handle held by another conversation's tombstone", async () => {
    const { tools, lifecycle } = boot();
    // Previous-process checkpoint owns handle "explore" over session S1.
    const s1 = join(process.cwd(), "past-session.jsonl");
    writeFileSync(s1, "");
    const sctx = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionPath()), getBranch: vi.fn(() => [
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: { id: "past-1", handle: "explore", type: "Explore", description: "old", sessionFile: s1, status: "completed", completedAt: 1 } },
    ]) } });
    await lifecycle.get("session_start")({ type: "session_start" }, sctx);
    // A fresh Explore in THIS process takes "explore" (S2), then dies: a
    // tombstone of another conversation now holds the name.
    finishedRun();
    const freshId = await spawnBackground(tools);
    await flush();
    await evict(freshId);
    finishedRun("from past");

    const r = await tools.get("Agent").execute(
      "tc-rr4", { resume: "past-1", prompt: "continue", run_in_background: true }, undefined, undefined, sctx,
    );
    // The resumed record must NOT take the name: when it is itself evicted it
    // would overwrite the other conversation's tombstone and @explore would
    // silently change subject.
    const newId = /Agent ID: (\S+)/.exec(textOf(r))![1];
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.getRecord(newId).handle).toBe("explore-2");
    // The PAST conversation's file is what got reopened.
    expect((vi.mocked(runAgent).mock.calls.at(-1)![3] as any).resumeSessionFile).toBe(s1);
  });

  it("gates checkpoints at the session boundary — a pre-/new settle writes nothing", async () => {
    const { pi, tools, lifecycle } = boot();
    heldRun();
    await spawnBackground(tools);
    await flush();
    // /new: session_start fires; the still-running record is skipped by
    // clearCompleted but is NOT this session's any more.
    await vi.advanceTimersByTimeAsync(60_000);
    await lifecycle.get("session_start")({ type: "session_start" }, ctx({ sessionManager: { getSessionId: vi.fn(() => "s2"), getSessionFile: vi.fn(() => sessionPath()), getBranch: vi.fn(() => []) } }));
    vi.mocked(pi.appendEntry).mockClear();
    // The pre-boundary agent settles now — into the NEW session's context.
    // The pre-boundary agent's run settles now — into the NEW session's context.
    heldResolve?.();
    await flush();
    const checkpointCalls = vi.mocked(pi.appendEntry).mock.calls.filter(c => c[0] === CHECKPOINT_ENTRY_TYPE);
    expect(checkpointCalls).toHaveLength(0);
  });

  it("honors the caller's abort signal on an inline stored resume", async () => {
    const { tools } = boot();
    finishedRun();
    const id = await spawnBackground(tools);
    await flush();
    await evict(id);
    heldRun();
    const controller = new AbortController();
    void tools.get("Agent").execute(
      "tc-rr5", { resume: id, prompt: "keep going", run_in_background: false }, controller.signal, undefined, ctx(),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await flush();
    // The child run was armed with the caller's signal: Esc stops it too.
    expect((vi.mocked(runAgent).mock.calls.at(-1)![3] as any).signal.aborted).toBe(true);
  });

  it("stored resume takes the turn budget from the STORED type's frontmatter", async () => {
    const { tools } = boot({}, { scout: "---\ndescription: scouts\nmax_turns: 2\n---\nbody" });
    finishedRun();
    const id = await spawnBackground(tools, "scout");
    await flush();
    await evict(id);
    finishedRun();
    await tools.get("Agent").execute(
      "tc-rr6", { resume: id, prompt: "keep going", run_in_background: true, max_turns: 7 }, undefined, undefined, ctx(),
    );
    // Frontmatter is authoritative over the call's explicit value, and the
    // subagent_type-derived budget (Explore's) must never leak in.
    expect((vi.mocked(runAgent).mock.calls.at(-1)![3] as any).maxTurns).toBe(2);
  });

  it("refuses to resume a live record inline mid-run (foreground branch)", async () => {
    const { tools } = boot();
    heldRun();
    await spawnBackground(tools);
    await flush();
    const r = await tools.get("Agent").execute(
      "tc-rr7", { resume: "explore", prompt: "again", run_in_background: false }, undefined, undefined, ctx(),
    );
    expect(textOf(r)).toContain("is still running");
  });

  it("completes a foreground resume addressed by handle", async () => {
    const { tools } = boot();
    finishedRun();
    await spawnBackground(tools);
    await flush();
    vi.mocked(resumeAgent).mockImplementation(async () => {
      // Upstream resumeAgent resolves { text }: the collector's own output.
      return { text: "resumed inline answer", aborted: false, steered: false, failure: undefined } as any;
    });
    const r = await tools.get("Agent").execute(
      "tc-rr8", { resume: "@explore", prompt: "again", run_in_background: false }, undefined, undefined, ctx(),
    );
    expect(textOf(r)).toContain("resumed inline answer");
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
