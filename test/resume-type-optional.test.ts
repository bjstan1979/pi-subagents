/**
 * resume-type-optional.test.ts — `subagent_type` is optional on a resume.
 *
 * A resume continues a conversation that already has a type, and the tool
 * ignored the caller's `subagent_type` on every resume path while the schema
 * still demanded it. The observed cost was a whole wasted turn per resume: the
 * model omitted the field and pi rejected the call before `execute` ran.
 *
 * Three contracts keep the relaxation from becoming a hole:
 * - a resume needs no type, and continues the type it was started with;
 * - a FRESH spawn without a type is refused here, never routed through
 *   `fallbackSubagent` into an agent the caller did not ask for (#183);
 * - the resumed run's turn budget, hard-limit mode and transcript gate come
 *   from the RESUMED type's frontmatter, not from the call — which used to be
 *   the caller's type (or general-purpose, once the field became optional).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ensureOutputFile, writeInitialEntry } from "../src/output-file.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

const AGENT_FILES = {
  scout: "---\ndescription: Scout\nmax_turns: 2\nhard_limit: true\noutput_transcript: false\n---\nScout.",
  conflicting: "---\ndescription: Conflicting\nmodel: test/allowed\nmax_turns: 9\nhard_limit: false\nrun_in_background: false\noutput_transcript: true\n---\nConflict.",
  unlimited: "---\ndescription: Unlimited\nmax_turns: 0\n---\nUnlimited.",
};

/** A settled background agent, so it holds a resumable session. */
async function spawnSettled(tools: Map<string, any>, type?: string): Promise<string> {
  const result = await tools.get("Agent").execute(
    "spawn-call",
    { prompt: "first task", description: "First task", ...(type ? { subagent_type: type } : {}), run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
  if (!id) throw new Error(`no agent id in result: ${textOf(result)}`);
  await flush();
  return id;
}

function boot(): Map<string, any> {
  hermetic = hermeticDir({ settings: { outputTranscript: true, schedulingEnabled: false }, agentFiles: AGENT_FILES });
  const { pi, tools, lifecycle } = makePi();
  subagentsExtension(pi);
  booted = lifecycle;
  vi.mocked(runAgent).mockImplementation((async (_c: any, _t: any, _p: any, options: any) => {
    options.onSessionCreated?.({ messages: [], subscribe: vi.fn(() => vi.fn()), steer: vi.fn() });
    return { responseText: "first answer", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false };
  }) as never);
  vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as never);
  return tools;
}

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(ensureOutputFile).mockReset();
  vi.mocked(writeInitialEntry).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

describe("Agent tool schema", () => {
  it("no longer marks subagent_type required", () => {
    // The regression was a HOST-side rejection: pi validates parameters before
    // `execute`, so no amount of tolerance inside the handler could help.
    const tools = boot();
    const parameters = tools.get("Agent").parameters;
    expect(parameters.properties.subagent_type).toBeDefined();
    expect(parameters.required ?? []).not.toContain("subagent_type");
  });
});

describe("resume without subagent_type", () => {
  it("continues the record's own type in the background", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");

    const resumed = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(resumed)).toContain("resumed in background");
    expect(textOf(resumed)).toContain("Type: scout");
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("continues the record's own type inline", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");

    const resumed = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", resume: id, run_in_background: false },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(resumed)).toContain("resumed answer");
    expect(resumeAgent).toHaveBeenCalledTimes(1);
  });

  it("still resumes a live agent whose type is no longer dispatchable", async () => {
    // `resume` ignores the type, so a deleted or disabled agent must stay
    // resumable — the reason the field was never gated on this path.
    const tools = boot();
    const id = await spawnSettled(tools, "scout");
    // The agent file goes away after the spawn, as a deleted/renamed .md would.
    hermetic!.restore();
    hermetic = hermeticDir({ settings: { outputTranscript: true, schedulingEnabled: false } });

    const resumed = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(resumed)).toContain("resumed in background");
    expect(textOf(resumed)).toContain("Type: scout");
  });

  it("takes the turn budget from the RESUMED type's frontmatter, not the call", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");

    await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    const options = vi.mocked(resumeAgent).mock.calls[0][2] as any;
    expect(options.maxTurns).toBe(2);
  });

  it("ignores conflicting type configuration and uses caller mode when target has none", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");
    const result = await tools.get("Agent").execute("resume", {
      prompt: "go", description: "go", resume: id, subagent_type: "conflicting",
      run_in_background: true, max_turns: 8, hard_limit: false,
    }, undefined, undefined, ctx());
    expect(textOf(result)).toContain("resumed in background");
    expect(vi.mocked(resumeAgent).mock.calls[0][2]).toMatchObject({ maxTurns: 2, hardLimit: true });
  });

  it("preserves the target's zero turn budget rather than the caller's", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "unlimited");
    await tools.get("Agent").execute("resume", {
      prompt: "go", description: "go", resume: id, subagent_type: "conflicting", max_turns: 7,
      run_in_background: true,
    }, undefined, undefined, ctx());
    expect((vi.mocked(resumeAgent).mock.calls[0][2] as any).maxTurns).toBeUndefined();
  });

  it("rejects an explicit out-of-scope model even with conflicting pinned model", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");
    const { setScopeModelsEnabled } = await import("../src/model-scope.js");
    const allowed = { provider: "test", id: "allowed" };
    const denied = { provider: "test", id: "denied" };
    writeFileSync(join(hermetic!.dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/allowed"] }));
    const registry = { find: vi.fn((_provider: string, id: string) => id === "allowed" ? allowed : id === "denied" ? denied : undefined), getAvailable: vi.fn(() => [allowed, denied]) };
    setScopeModelsEnabled(true);
    try {
      const result = await tools.get("Agent").execute("resume", {
        prompt: "go", description: "go", resume: id, subagent_type: "conflicting", model: "test/denied",
      }, undefined, undefined, ctx({ modelRegistry: registry }));
      expect(textOf(result)).toContain("Model not in scope");
      expect(resumeAgent).not.toHaveBeenCalled();
    } finally { setScopeModelsEnabled(false); }
  });

  it("keeps the RESUMED type's output_transcript gate", async () => {
    // `output_transcript: false` on the type being resumed must not lose to the
    // project's `outputTranscript: true`, which is what the call's own config
    // said before this was resolved from the record.
    const tools = boot();
    const id = await spawnSettled(tools, "scout");
    vi.mocked(writeInitialEntry).mockClear();
    vi.mocked(ensureOutputFile).mockClear();

    const resumed = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(ensureOutputFile).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(textOf(resumed)).not.toContain("Output file:");
  });
});

describe("fresh spawn without subagent_type", () => {
  it("is refused instead of falling back to another agent", async () => {
    const tools = boot();

    const result = await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "do it", description: "no type" },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain("subagent_type is required to start a new agent");
    expect(textOf(result)).toContain("scout");
    // #183's whole point: nothing may start before the caller learns anything.
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("still spawns the type the caller named", async () => {
    const tools = boot();
    const id = await spawnSettled(tools, "scout");
    expect(id).toBeTruthy();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still routes an explicitly blank type through the fallback policy", async () => {
    // Left deliberately unchanged: `subagent_type: "   "` is a value the caller
    // sent, and the scheduler contract in fallback-subagent-wiring.test.ts pins
    // what that means. Only the OMITTED property is newly refused.
    const tools = boot();

    const result = await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "do it", description: "blank type", subagent_type: "   " },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).not.toContain("subagent_type is required to start a new agent");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
