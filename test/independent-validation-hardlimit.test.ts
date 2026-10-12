import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGraceTurns,
  runAgent,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";
import { getAgentConfig } from "../src/agent-types.js";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: vi.fn(),
    SessionManager: {
      inMemory: vi.fn(() => ({
        appendMessage: vi.fn(),
        getBranch: vi.fn(() => []),
        getLeafMessage: vi.fn(() => undefined),
      })),
      open: vi.fn(),
      create: vi.fn(),
    },
    SettingsManager: {
      create: vi.fn(() => ({
        getEffectiveSettings: vi.fn(() => ({})),
        getSessionDir: vi.fn(() => undefined),
      })),
    },
    DefaultResourceLoader: class {
      getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
      getSkills() { return { skills: [], errors: [] }; }
      getPrompts() { return { prompts: [], errors: [] }; }
      getAgentsFiles() { return { agentsFiles: [], errors: [] }; }
      async reload() {}
    },
    getAgentDir: vi.fn(() => "/tmp/fake-agent-dir"),
  };
});

vi.mock("../src/agent-types.js", async () => {
  const actual = await vi.importActual<any>("../src/agent-types.js");
  return {
    ...actual,
    getAgentConfig: vi.fn(),
    getConfig: vi.fn(() => ({})),
    getToolNamesForType: vi.fn(() => ["read", "bash"]),
  };
});

vi.mock("../src/nested-tools.js", () => ({
  createNestedSubagentTools: vi.fn(() => []),
  getMaxSubagentDepth: vi.fn(() => 1),
}));

const { createAgentSession } = await import("@earendil-works/pi-coding-agent");

function createMockSession() {
  const listeners: Array<(event: any) => void> = [];
  let activeTools = ["read", "bash"];
  const session = {
    sessionId: "test-sess",
    messages: [] as any[],
    agent: {
      state: { messages: [] },
      signal: new AbortController().signal,
    },
    getActiveToolNames: vi.fn(() => activeTools),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
    getAllTools: vi.fn(() => [
      { name: "read", description: "read file" },
      { name: "bash", description: "run bash" },
    ]),
    getToolDefinition: vi.fn(() => ({ defaultActive: true })),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    subscribe: vi.fn((fn: (event: any) => void) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/workspace",
  isProjectTrusted: () => true,
  getSystemPrompt: () => "You are an agent",
  model: { id: "test-model" },
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []), runtime: undefined },
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
  },
} as any;

const pi = {} as any;

describe("Independent Validation of Hard-Limit and Turn Abort Lifecycle", () => {
  let savedSessionDir: string | undefined;

  beforeEach(() => {
    savedSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    setGraceTurns(5);
    setDefaultMaxTurns(undefined);
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(getAgentConfig).mockReset();
  });

  afterEach(() => {
    if (savedSessionDir !== undefined) {
      process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDir;
    } else {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  async function executeTurns({
    turns,
    maxTurns,
    hardLimit,
    graceTurns,
    completeAtTurn,
  }: {
    turns: number;
    maxTurns?: number;
    hardLimit?: boolean;
    graceTurns: number;
    completeAtTurn?: number;
  }) {
    setGraceTurns(graceTurns);
    const { session, listeners } = createMockSession();

    session.prompt.mockImplementation(async () => {
      for (let i = 1; i <= turns; i++) {
        for (const l of [...listeners]) {
          l({ type: "turn_end" });
        }
        if (completeAtTurn && i === completeAtTurn) {
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: `Done at turn ${i}` }],
          });
          return;
        }
      }
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      });
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    const result = await runAgent(ctx, "Explore", "test prompt", {
      pi,
      maxTurns,
      hardLimit,
    });

    return { session, result };
  }

  it("graceTurns = 0 in hardLimit mode: aborts immediately at maxTurns with no off-by-one turn", async () => {
    const { session, result } = await executeTurns({
      turns: 5,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 0,
    });

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    // When graceTurns is 0, it aborts on turn 5 immediately. No steer was sent because abort branch matched first.
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("graceTurns = 0 in softLimit mode: aborts immediately at maxTurns", async () => {
    const { session, result } = await executeTurns({
      turns: 5,
      maxTurns: 5,
      hardLimit: false,
      graceTurns: 0,
    });

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("graceTurns = 1 in hardLimit mode: steers/disables tools at turn 5, aborts at turn 6", async () => {
    // Check turn 5: steer and disable tools, NO abort
    const t5 = await executeTurns({
      turns: 5,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 1,
    });
    expect(t5.session.steer).toHaveBeenCalledTimes(1);
    expect(t5.session.steer.mock.calls[0][0]).toContain("HARD LIMIT");
    expect(t5.session.setActiveToolsByName).toHaveBeenCalledWith([]);
    expect(t5.session.abort).not.toHaveBeenCalled();
    expect(t5.result.aborted).toBe(false);
    expect(t5.result.steered).toBe(true);

    // Check turn 6: exactly 1 grace turn used -> abort
    const t6 = await executeTurns({
      turns: 6,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 1,
    });
    expect(t6.session.steer).toHaveBeenCalledTimes(1);
    expect(t6.session.abort).toHaveBeenCalledTimes(1);
    expect(t6.result.aborted).toBe(true);
  });

  it("graceTurns = 2 in hardLimit mode: maintains disabled tools on turn 6, aborts at turn 7", async () => {
    const t6 = await executeTurns({
      turns: 6,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 2,
    });
    expect(t6.session.steer).toHaveBeenCalledTimes(1);
    expect(t6.session.abort).not.toHaveBeenCalled();
    const emptyCalls = t6.session.setActiveToolsByName.mock.calls.filter(([names]: [string[]]) => names.length === 0);
    expect(emptyCalls).toHaveLength(2);

    const t7 = await executeTurns({
      turns: 7,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 2,
    });
    expect(t7.session.abort).toHaveBeenCalledTimes(1);
    expect(t7.result.aborted).toBe(true);
  });

  it("repeated post-abort events are strictly idempotent: session.abort() called exactly once", async () => {
    const { session, result } = await executeTurns({
      turns: 20, // 15 turns beyond abort ceiling (5 + 0 = 5)
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 0,
    });

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
  });

  it("repeated post-abort events in softLimit mode are strictly idempotent", async () => {
    const { session, result } = await executeTurns({
      turns: 20, // 13 turns beyond abort ceiling (5 + 2 = 7)
      maxTurns: 5,
      hardLimit: false,
      graceTurns: 2,
    });

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
  });

  it("natural completion during grace window is marked steered, NOT aborted", async () => {
    const { session, result } = await executeTurns({
      turns: 10,
      maxTurns: 5,
      hardLimit: true,
      graceTurns: 3,
      completeAtTurn: 6, // finishes on grace turn 1
    });

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(true);
    expect(result.responseText).toContain("Done at turn 6");
  });

  it("boundary case: maxTurns = 1, graceTurns = 0 aborts on turn 1", async () => {
    const { session, result } = await executeTurns({
      turns: 1,
      maxTurns: 1,
      hardLimit: true,
      graceTurns: 0,
    });

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
  });

  it("boundary case: maxTurns = 1, graceTurns = 1 steers at turn 1, aborts at turn 2", async () => {
    const t1 = await executeTurns({
      turns: 1,
      maxTurns: 1,
      hardLimit: true,
      graceTurns: 1,
    });
    expect(t1.session.steer).toHaveBeenCalledTimes(1);
    expect(t1.session.abort).not.toHaveBeenCalled();

    const t2 = await executeTurns({
      turns: 2,
      maxTurns: 1,
      hardLimit: true,
      graceTurns: 1,
    });
    expect(t2.session.abort).toHaveBeenCalledTimes(1);
    expect(t2.result.aborted).toBe(true);
  });

  it("unlimited turns: maxTurns undefined or 0 never steers or aborts", async () => {
    const { session, result } = await executeTurns({
      turns: 50,
      maxTurns: undefined,
      hardLimit: true,
      graceTurns: 2,
    });

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(false);
  });

  it("clamps negative graceTurns to 0", () => {
    setGraceTurns(-10);
    expect(getGraceTurns()).toBe(0);
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(0);
    setGraceTurns(3);
    expect(getGraceTurns()).toBe(3);
  });

  it("verifies compiled dist/agent-runner.js exports and behavior match src contract", async () => {
    const dist = await import("../dist/agent-runner.js");
    expect(typeof dist.runAgent).toBe("function");
    expect(typeof dist.setGraceTurns).toBe("function");
    expect(typeof dist.getGraceTurns).toBe("function");
    dist.setGraceTurns(0);
    expect(dist.getGraceTurns()).toBe(0);
    dist.setGraceTurns(-5);
    expect(dist.getGraceTurns()).toBe(0);
    dist.setGraceTurns(4);
    expect(dist.getGraceTurns()).toBe(4);
  });
});
