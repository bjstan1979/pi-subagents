/**
 * saved-record-retrieval.test.ts — get_subagent_result after the live record is
 * gone, with the trust-stamped, read-only saved-record fallback.
 *
 * A completion notification carries only a preview and points at
 * get_subagent_result for the full text, but the live record is evicted ten
 * minutes after the agent finishes (or dropped by a reload). Its final snapshot
 * rides the parent session as `subagents:record`; only entries carrying a v1
 * trust block that matches the CURRENT parent's canonical identity are read.
 * No session is ever reopened from a result record here.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AGENT_RECORD_ENTRY_TYPE, type AgentRecordEntryData, parentEpoch } from "../src/agent-record-entry.js";
import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import { CHECKPOINT_ENTRY_TYPE } from "../src/checkpoint-index.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** Every activation in this test, so teardown runs even when a test throws. */
let activations: Map<string, any>[] = [];

const sessionFile = () => join(process.cwd(), "parent-session.jsonl");

beforeEach(() => {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false, outputTranscript: false } });
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  activations = [];
});

afterEach(async () => {
  for (const lifecycle of activations.reverse()) {
    await lifecycle.get("session_shutdown")?.();
  }
  activations = [];
  hermetic?.restore();
  hermetic = undefined;
});

/** Boot the extension with `appendEntry` landing on `branch`, as pi's session does. */
function boot(branch: any[]) {
  const { pi, tools, lifecycle } = makePi();
  pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  subagentsExtension(pi);
  activations.push(lifecycle);
  return { pi, tools, lifecycle };
}

/** The parent ctx this suite's records are stamped with. */
function parentCtx(branch: any[]) {
  return ctx({ sessionManager: {
    getSessionId: vi.fn(() => "s1"),
    getSessionFile: vi.fn(() => sessionFile()),
    getBranch: vi.fn(() => branch),
  } });
}

/**
 * Run an agent to completion in a first activation, shut it down, and return
 * its id. The parent session file exists inside the hermetic cwd, so the
 * settle record is trust-stamped.
 */
async function finishedAgent(
  branch: any[],
  run: Partial<RunResult> = {},
  spawn: Record<string, unknown> = {},
): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-FULL-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
    ...run,
  });
  const { tools, lifecycle } = boot(branch);
  const context = parentCtx(branch);
  const res = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "Review the change.", description: "Review the change", subagent_type: "Explore", run_in_background: false, ...spawn },
    undefined, undefined, context,
  );
  const id = (res as any).details.agentId;
  await flush();
  await lifecycle.get("session_shutdown")?.();
  return id;
}

/** get_subagent_result in a fresh activation over the same branch. */
async function read(branch: any[], ref: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { tools } = boot(branch);
  const result = await tools.get("get_subagent_result").execute(
    "tc-read", { agent_id: ref, ...extra }, undefined, undefined, parentCtx(branch),
  );
  return textOf(result);
}

/** A hand-written saved-record entry, for trust-validation cases. */
function recordEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: AGENT_RECORD_ENTRY_TYPE, data };
}

/** A v1 trust block matching the current parent. */
function trust(over: Record<string, unknown> = {}) {
  const file = sessionFile();
  const cwd = process.cwd();
  return {
    version: 1, switchEpoch: 0,
    parentEpoch: parentEpoch(file, "s1", cwd),
    parentSessionId: "s1", parentSessionFile: file, parentCwd: cwd,
    ...over,
  };
}

function validSaved(over: Record<string, unknown> = {}): AgentRecordEntryData {
  return {
    id: "saved-agent-1", type: "Explore", description: "Review the change",
    handle: "explore", status: "completed", result: "THE-SAVED-RESULT",
    resultRevision: 1, executionEpoch: 1, startedAt: 1000, completedAt: 2000,
    trust: trust() as any, ...over,
  } as AgentRecordEntryData;
}

describe("get_subagent_result falls back to the trust-stamped saved record", () => {
  it("answers from the session's subagents:record entry once the live record is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    const saved = branch.find(e => e.customType === AGENT_RECORD_ENTRY_TYPE && e.data.id === id);
    expect(saved?.data?.trust).toMatchObject({ version: 1, parentSessionId: "s1" });
    expect(saved.data).not.toHaveProperty("sessionFile");
    expect(saved.data).not.toHaveProperty("worktreeLost");

    const out = await read(branch, id);
    expect(out).toContain(`Agent: ${id}`);
    expect(out).toContain("Result revision:");
    expect(out).toContain("Status: completed");
    expect(out).toContain("THE-FULL-RESULT");
    expect(out).toContain("saved result record");
  });

  it("keeps a failed run's partial output, labelled as partial", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { responseText: "THE-PARTIAL-OUTPUT", failure: "provider error" });
    const out = await read(branch, id);
    expect(out).toContain("Status: error");
    expect(out).toContain("Error: provider error\n\nPartial output before the failure:\nTHE-PARTIAL-OUTPUT");
  });

  it("is repeatable and never appends or consumes anything", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    const before = branch.length;
    const first = await read(branch, id);
    const second = await read(branch, id);
    expect(second).toBe(first);
    expect(branch).toHaveLength(before);
  });

  it("ignores verbose/wait because the saved record has no conversation or promise", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    const out = await read(branch, id, { verbose: true, wait: true });
    expect(out).toContain("THE-FULL-RESULT");
    expect(out).not.toContain("--- Agent Conversation ---");
    expect(out).toContain("full conversation are unavailable");
  });

  it("answers by name and by type handle after reload, case-insensitively", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { responseText: "THE-NAMED-RESULT" }, { name: "auth-audit" });
    const saved = branch.find(e => e.customType === AGENT_RECORD_ENTRY_TYPE && e.data.id === id);
    expect(saved.data).toMatchObject({ handle: "explore", alias: "auth-audit" });

    for (const ref of ["Auth-Audit", "EXPLORE"]) {
      const out = await read(branch, ref);
      expect(out).toContain(`Agent: ${id}`);
      expect(out).toContain("THE-NAMED-RESULT");
      expect(out).toContain("saved result record");
    }
    expect(await read(branch, "no-such-handle")).toContain("Agent not found");
  });

  it("exact ID wins and handle/alias collisions resolve to the newest completion", async () => {
    const branch: any[] = [];
    const first = await finishedAgent(branch, { responseText: "FIRST-RESULT" }, { name: "auth-audit" });
    const second = await finishedAgent(branch, { responseText: "SECOND-RESULT" });

    const byHandle = await read(branch, "explore");
    expect(byHandle).toContain(`Agent: ${second}`);
    expect(byHandle).toContain("SECOND-RESULT");
    expect(byHandle).not.toContain("FIRST-RESULT");

    const byName = await read(branch, "auth-audit");
    expect(byName).toContain(`Agent: ${first}`);
    expect(byName).toContain("FIRST-RESULT");

    const byId = await read(branch, first);
    expect(byId).toContain(`Agent: ${first}`);
    expect(byId).toContain("FIRST-RESULT");
    expect(byId).not.toContain("SECOND-RESULT");
  });

  it("prefers a saved exact ID over a live agent's matching alias", async () => {
    const branch = [recordEntry(validSaved({ id: "collision", result: "SAVED-ID" }))];
    const { tools } = boot(branch);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "LIVE", session: undefined, aborted: false, steered: false });
    const spawned = await tools.get("Agent").execute("spawn", {
      prompt: "go", description: "live", subagent_type: "Explore", name: "collision", run_in_background: true,
    }, undefined, undefined, parentCtx(branch));
    const liveId = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();
    expect(liveId).not.toBe("collision");
    const out = textOf(await tools.get("get_subagent_result").execute("read", { agent_id: "collision" }, undefined, undefined, parentCtx(branch)));
    expect(out).toContain("SAVED-ID");
    expect(out).not.toContain("\nLIVE");
  });

  it("prefers a newer saved name over an older checkpoint mapping", async () => {
    const branch: any[] = [
      recordEntry(validSaved({ id: "old", alias: "shared", result: "OLD", completedAt: 1 })),
      { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: {
        id: "old", alias: "shared", type: "Explore", description: "d", sessionFile: sessionFile(), status: "completed", completedAt: 1,
      } },
      recordEntry(validSaved({ id: "new", alias: "shared", result: "NEW", completedAt: 2 })),
    ];
    const { tools, lifecycle } = boot(branch);
    await lifecycle.get("session_start")?.({ type: "session_start" }, parentCtx(branch));
    const out = textOf(await tools.get("get_subagent_result").execute("read", { agent_id: "shared" }, undefined, undefined, parentCtx(branch)));
    expect(out).toContain("Agent: new");
    expect(out).toContain("NEW");
  });

  it("reads through a local tombstone/checkpoint name-to-ID mapping", async () => {
    const branch: any[] = [];
    const saved = validSaved({ id: "mapped-id", handle: "explore", alias: "mapper" });
    branch.push(recordEntry(saved));
    // A checkpoint in the same branch with a different id supplies the name→ID
    // mapping; it never supplies a result itself.
    branch.push({ type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: {
      id: "mapped-id", handle: "cp-handle", alias: "cp-alias", type: "Explore",
      description: "d", sessionFile: sessionFile(), status: "completed", completedAt: 1,
    } });
    const { tools, lifecycle } = boot(branch);
    await lifecycle.get("session_start")?.({ type: "session_start" }, parentCtx(branch));
    const out = textOf(await tools.get("get_subagent_result").execute(
      "tc-read", { agent_id: "cp-alias" }, undefined, undefined, parentCtx(branch),
    ));
    expect(out).toContain("Agent: mapped-id");
    expect(out).toContain("THE-SAVED-RESULT");
  });

  it("still reports an unknown id as ordinary not-found", async () => {
    const branch: any[] = [];
    await finishedAgent(branch);
    expect(await read(branch, "3f1320a7-74ec-422")).toContain("Agent not found");
  });

  it("rejects a legacy record with no trust block", async () => {
    const branch: any[] = [recordEntry({
      id: "legacy-id", type: "Explore", description: "old", status: "completed",
      result: "LEGACY-RESULT", startedAt: 1, completedAt: 2,
    })];
    expect(await read(branch, "legacy-id")).toContain("Agent not found");
    expect(await read(branch, "legacy-id")).not.toContain("LEGACY-RESULT");
  });

  it.each([
    ["wrong session id", { parentSessionId: "other-session" }],
    ["wrong cwd", { parentCwd: "/definitely/another/cwd" }],
    ["wrong epoch", { parentEpoch: "0".repeat(64) }],
    ["wrong version", { version: 2 }],
    ["bad switchEpoch", { switchEpoch: -1 }],
  ])("rejects a forged/stale trust block: %s", async (_label, over) => {
    const branch: any[] = [recordEntry(validSaved({ trust: trust(over) as any }))];
    expect(await read(branch, "saved-agent-1")).toContain("Agent not found");
  });

  it("rejects malformed, running, and upstream reopen-shaped records", async () => {
    const branch: any[] = [
      recordEntry({ ...validSaved({ id: "running-id" }), status: "running" }),
      recordEntry({ ...validSaved({ id: "bad-start" }), startedAt: "not-a-number" }),
      recordEntry({ ...validSaved({ id: "reopen-id" }), sessionFile: "/some/child.jsonl" }),
      recordEntry({ ...validSaved({ id: "worktree-id" }), worktreeLost: true }),
      { type: "custom", customType: AGENT_RECORD_ENTRY_TYPE, data: "garbage" },
      null,
    ];
    for (const ref of ["running-id", "bad-start", "reopen-id", "worktree-id"]) {
      expect(await read(branch, ref)).toContain("Agent not found");
    }
  });

  it("fails closed for an empty/unreadable branch, a missing session file, and a foreign parent", async () => {
    const saved = validSaved();
    const noBranch = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionFile()) } });
    const { tools: t1 } = boot([]);
    expect(textOf(await t1.get("get_subagent_result").execute("r", { agent_id: "saved-agent-1" }, undefined, undefined, noBranch))).toContain("Agent not found");

    const branch = [recordEntry(saved)];
    const noFile = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
    const { tools: t2 } = boot(branch);
    expect(textOf(await t2.get("get_subagent_result").execute("r", { agent_id: "saved-agent-1" }, undefined, undefined, noFile))).toContain("Agent not found");

    const foreign = ctx({ sessionManager: {
      getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionFile()),
      getBranch: vi.fn(() => branch),
    }, cwd: "/definitely/another/cwd" });
    const { tools: t3 } = boot(branch);
    expect(textOf(await t3.get("get_subagent_result").execute("r", { agent_id: "saved-agent-1" }, undefined, undefined, foreign))).toContain("Agent not found");
  });

  it("does not read an abandoned branch's newer record via getEntries", async () => {
    const branch: any[] = [recordEntry(validSaved({ id: "active-id", result: "ACTIVE-RESULT", handle: "explore" }))];
    const abandoned = ctx({ sessionManager: {
      getSessionId: vi.fn(() => "s1"), getSessionFile: vi.fn(() => sessionFile()),
      getBranch: vi.fn(() => branch),
      getEntries: vi.fn(() => [recordEntry(validSaved({ id: "abandoned-id", result: "ABANDONED-RESULT" }))]),
    } });
    const { tools } = boot(branch);
    const out = textOf(await tools.get("get_subagent_result").execute(
      "r", { agent_id: "abandoned-id" }, undefined, undefined, abandoned,
    ));
    expect(out).toContain("Agent not found");
    expect(out).not.toContain("ABANDONED-RESULT");
  });
});

describe("parent-switch guard", () => {
  it("publishes after a cancelled before-switch, including a completion during the hook window", async () => {
    const branch: any[] = [];
    const { pi, tools, lifecycle } = boot(branch);
    const context = parentCtx(branch);
    await lifecycle.get("session_start")?.({ type: "session_start" }, context);
    let finish!: (value: any) => void;
    const session = { dispose: vi.fn(), sessionManager: { getSessionFile: vi.fn(() => join(process.cwd(), "child.jsonl")) } };
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, opts) => {
      opts?.onSessionCreated?.(session as any);
      return new Promise(resolve => { finish = resolve; });
    });
    const spawned = await tools.get("Agent").execute("spawn", {
      prompt: "go", description: "cancelled switch", subagent_type: "Explore", run_in_background: true,
    }, undefined, undefined, context);
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await flush();
    await lifecycle.get("session_before_switch")?.({ type: "session_before_switch", reason: "new" }, context);
    finish({ responseText: "CANCELLED-SWITCH-RESULT", session, aborted: false, steered: false });
    await flush();
    expect(branch.find(e => e.customType === AGENT_RECORD_ENTRY_TYPE && e.data.id === id)?.data.result).toBe("CANCELLED-SWITCH-RESULT");
    expect(branch.some(e => e.customType === CHECKPOINT_ENTRY_TYPE && e.data.id === id)).toBe(true);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id }));
    expect(await read(branch, id)).toContain("CANCELLED-SWITCH-RESULT");
  });

  it("does not publish a stale task's result into the new parent session", async () => {
    const branch: any[] = [];
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: false } });
    const { pi, tools, lifecycle } = boot(branch);
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const spawn = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "old parent work", subagent_type: "Explore", run_in_background: true },
      undefined, undefined, parentCtx(branch),
    );
    const staleId = /Agent ID: (\S+)/.exec(textOf(spawn))![1];
    await flush();

    // A /new boundary: session_start bumps the parent generation. The old
    // run then settles into the NEW parent.
    await lifecycle.get("session_before_switch")?.();
    const before = branch.length;
    pi.events.emit.mockClear();
    await lifecycle.get("session_start")?.({ type: "session_start" }, parentCtx(branch));
    finish({ responseText: "STALE-RESULT", session: undefined, aborted: false, steered: false });
    await flush();

    const records = branch.filter(e => e.customType === AGENT_RECORD_ENTRY_TYPE);
    expect(records).toHaveLength(0);
    expect(branch).toHaveLength(before);
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id: staleId }));
    expect(await read(branch, staleId)).toContain("Agent not found");
  });

  it("publishes a live record resumed in a new parent under the new identity", async () => {
    const oldBranch: any[] = [];
    const newBranch: any[] = [];
    let activeBranch = oldBranch;
    const { pi, tools, lifecycle } = boot(oldBranch);
    pi.appendEntry = vi.fn((customType: string, data: unknown) => activeBranch.push({ type: "custom", customType, data }));
    const oldCtx = parentCtx(oldBranch);
    const newCtx = ctx({ sessionManager: {
      getSessionId: vi.fn(() => "s2"), getSessionFile: vi.fn(() => join(process.cwd(), "new-parent.jsonl")),
      getBranch: vi.fn(() => newBranch),
    } });
    await lifecycle.get("session_start")?.({ type: "session_start" }, oldCtx);
    const session = {
      dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}),
      getActiveToolNames: vi.fn(() => []),
      sessionManager: { getSessionFile: vi.fn(() => join(process.cwd(), "child.jsonl")) },
    };
    vi.mocked(runAgent).mockImplementation(async (_c, _t, _p, opts) => {
      opts?.onSessionCreated?.(session as any);
      return { responseText: "OLD", session: session as any, aborted: false, steered: false };
    });
    const spawn = await tools.get("Agent").execute("spawn", {
      prompt: "go", description: "live resume", subagent_type: "Explore", run_in_background: true,
    }, undefined, undefined, oldCtx);
    const id = /Agent ID: (\S+)/.exec(textOf(spawn))![1];
    await flush();
    await lifecycle.get("session_before_switch")?.({ type: "session_before_switch", reason: "new" }, oldCtx);
    activeBranch = newBranch;
    await lifecycle.get("session_start")?.({ type: "session_start", reason: "new" }, newCtx);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "NEW RESUME", aborted: false, steered: false } as any);
    const resumed = await tools.get("Agent").execute("resume", { resume: id, prompt: "continue", run_in_background: true }, undefined, undefined, newCtx);
    expect(textOf(resumed)).toContain("resumed in background");
    await flush();
    const saved = newBranch.find(e => e.customType === AGENT_RECORD_ENTRY_TYPE && e.data.id === id);
    expect(saved?.data.result).toBe("NEW RESUME");
    expect(saved?.data.trust.parentSessionId).toBe("s2");
    expect(newBranch.some(e => e.customType === CHECKPOINT_ENTRY_TYPE && e.data.id === id)).toBe(true);
    const { tools: freshTools } = boot(newBranch);
    expect(textOf(await freshTools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, newCtx))).toContain("NEW RESUME");
  });

  it("never trusts a realistic record already polluting the new branch", async () => {
    const branch: any[] = [];
    // Exactly the old shape, including a plausible result — no v1 trust block.
    branch.push(recordEntry({
      id: "polluting-id", type: "Explore", description: "old work",
      status: "completed", result: "POLLUTED-RESULT", startedAt: 1, completedAt: 2,
    }));
    expect(await read(branch, "polluting-id")).toContain("Agent not found");
    expect(await read(branch, "polluting-id")).not.toContain("POLLUTED-RESULT");
  });
});

describe("cross-parent exact ID stays a resume-only facility", () => {
  it("a checkpoint from a foreign parent cannot supply a result", async () => {
    const foreignParent = join(process.cwd(), "foreign-parent.jsonl");
    writeFileSync(foreignParent, "");
    const branch: any[] = [];
    // A checkpoint entry on the active branch is a resume target only.
    branch.push({ type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: {
      id: "foreign-agent-id", handle: "explore", type: "Explore", description: "foreign",
      sessionFile: foreignParent, status: "completed", completedAt: 1,
    } });
    const { tools, lifecycle } = boot(branch);
    await lifecycle.get("session_start")?.({ type: "session_start" }, parentCtx(branch));
    const out = textOf(await tools.get("get_subagent_result").execute(
      "r", { agent_id: "foreign-agent-id" }, undefined, undefined, parentCtx(branch),
    ));
    // The checkpoint remains a RESUME hint only — never a result source.
    expect(out).toContain("stored checkpoint");
    expect(out).toContain("not a read-only result lookup");
    expect(out).not.toContain("From this session's saved result record");
  });
});
