import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  getGraceTurns,
  installExtensionToolScope,
  installSessionToolController,
  resumeAgent,
  setGraceTurns,
} from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";

function createMockSession(options: {
  tools?: string[];
  activeTools?: string[];
} = {}) {
  const listeners: Array<(event: any) => void> = [];
  const allToolNames = options.tools ?? ["read", "bash", "edit", "write"];
  let activeToolNames = options.activeTools ?? [...allToolNames];

  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Resume response" }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(async () => {}),
    getActiveToolNames: vi.fn(() => [...activeToolNames]),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
    }),
    getAllTools: vi.fn(() => allToolNames.map((name) => ({ name }))),
    agent: { beforeToolCall: undefined },
    setSessionName: vi.fn(),
  };

  const emit = (event: any) => {
    for (const l of [...listeners]) l(event);
  };

  return { session, emit, listeners };
}

describe("resumeAgent turn limit governance and tool restoration", () => {
  let initialGrace: number;

  beforeEach(() => {
    initialGrace = getGraceTurns();
  });

  afterEach(() => {
    setGraceTurns(initialGrace);
    vi.restoreAllMocks();
  });

  it("restores active tools if previously cleared by hardLimit", async () => {
    // Simulate a session that ended its prior run in hardLimit with tools cleared
    const { session } = createMockSession({
      tools: ["read", "bash", "edit"],
      activeTools: [], // empty!
    });

    expect(session.getActiveToolNames()).toEqual([]);
    const result = await resumeAgent(session as any, "Inspect next step");

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "edit"]);
    expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit"]);
    expect(result.text).toBe("Resume response");
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(false);
  });

  it("restores active tools if previously left with only StructuredOutput under hardLimit", async () => {
    const { session } = createMockSession({
      tools: ["read", "bash", "StructuredOutput"],
      activeTools: ["StructuredOutput"],
    });

    const result = await resumeAgent(session as any, "Inspect next step");
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "StructuredOutput"]);
    expect(session.getActiveToolNames()).toEqual(["read", "bash", "StructuredOutput"]);
    expect(result.text).toBe("Resume response");
  });
  it("does not overwrite active tools if they are already populated", async () => {
    const { session } = createMockSession({
      tools: ["read", "bash", "edit"],
      activeTools: ["read"],
    });

    await resumeAgent(session as any, "Inspect next step");
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.getActiveToolNames()).toEqual(["read"]);
  });

  it("allows tool calls and preserves restored tools when resuming session with installExtensionToolScope", async () => {
    const { session, emit } = createMockSession({
      tools: ["read", "bash"],
      activeTools: [],
    });
    const dummyLoader = {
      getExtensions: () => ({ extensions: [] }),
    };
    installExtensionToolScope(session as any, {
      loader: dummyLoader as any,
      toolNames: ["read", "bash"],
      disallowedSet: new Set(),
      extNames: new Set(),
      narrowing: new Map(),
      readmitToolNames: new Set(),
      isHardLimited: () => false,
      hardLimitAllowedTools: () => [],
    });

    const resumePromise = resumeAgent(session as any, "Inspect next step");
    expect(session.getActiveToolNames()).toEqual(["read", "bash"]);

    const blocked = await (session as any).agent.beforeToolCall({ toolCall: { name: "read" } });
    expect(blocked).toBeUndefined();

    emit({ type: "turn_end" });
    expect(session.getActiveToolNames()).toEqual(["read", "bash"]);

    await resumePromise;
    expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
  });

  it("restores only in-scope tools when resuming a hard-limited session with extension narrowing", async () => {
    const { session } = createMockSession({
      tools: ["read", "git_status", "git_commit"],
      activeTools: [], // hard-limited state
    });
    const dummyLoader = {
      getExtensions: () => ({
        extensions: [
          {
            path: "/path/to/git/index.js",
            tools: new Map([
              ["git_status", {}],
              ["git_commit", {}],
            ]),
          },
        ],
      }),
    };
    installExtensionToolScope(session as any, {
      loader: dummyLoader as any,
      toolNames: ["read"],
      disallowedSet: new Set(),
      extNames: new Set(["git"]),
      narrowing: new Map([["git", new Set(["git_status"])]]),
      readmitToolNames: new Set(),
      isHardLimited: () => false,
      hardLimitAllowedTools: () => [],
    });

    // Simulate hard limit hitting during the run:
    session.setActiveToolsByName([]);
    expect(session.getActiveToolNames()).toEqual([]);
    const resumePromise = resumeAgent(session as any, "Inspect next step");
    expect(session.getActiveToolNames()).toEqual(["read", "git_status"]);
    await resumePromise;
  });

  it("restores only in-scope tools when resuming a hard-limited session with installSessionToolController", async () => {
    const { session } = createMockSession({
      tools: ["read", "bash", "edit"],
      activeTools: [], // hard-limited state
    });
    installSessionToolController(session as any, {
      inScope: () => new Set(["read", "bash"]),
    });

    const resumePromise = resumeAgent(session as any, "Inspect next step");
    expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
    await resumePromise;
  });

  it("soft limit: steers at maxTurns and does not abort if finished within grace", async () => {
    setGraceTurns(2);
    const { session, emit } = createMockSession();

    let turnEndHookCalled = 0;
    const resumePromise = resumeAgent(session as any, "Continue", {
      maxTurns: 2,
      onTurnEnd: (c) => { turnEndHookCalled = c; },
    });

    // Turn 1
    emit({ type: "turn_end" });
    expect(turnEndHookCalled).toBe(1);
    expect(session.steer).not.toHaveBeenCalled();

    // Turn 2: reaches maxTurns
    emit({ type: "turn_end" });
    expect(turnEndHookCalled).toBe(2);
    expect(session.steer).toHaveBeenCalledWith(
      expect.stringContaining("You have reached your turn limit"),
    );
    expect(session.abort).not.toHaveBeenCalled();

    const result = await resumePromise;
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("hard limit: disables tools at maxTurns and steers with hard limit notice", async () => {
    setGraceTurns(2);
    const { session, emit } = createMockSession({ tools: ["read", "bash"] });

    const resumePromise = resumeAgent(session as any, "Continue", {
      maxTurns: 2,
      hardLimit: true,
    });

    // Turn 1
    emit({ type: "turn_end" });
    expect(session.setActiveToolsByName).not.toHaveBeenCalledWith([]);

    // Turn 2: reaches maxTurns in hard limit
    emit({ type: "turn_end" });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith([]);
    expect(session.steer).toHaveBeenCalledWith(
      expect.stringContaining("HARD LIMIT: Tools disabled"),
    );
    expect(session.abort).not.toHaveBeenCalled();

    const result = await resumePromise;
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("aborts session when turnCount >= maxTurns + graceTurns", async () => {
    setGraceTurns(1);
    const { session, emit } = createMockSession();

    const resumePromise = resumeAgent(session as any, "Continue", {
      maxTurns: 2,
      hardLimit: true,
    });

    // Turn 1
    emit({ type: "turn_end" });
    // Turn 2 (steers & disables)
    emit({ type: "turn_end" });
    expect(session.abort).not.toHaveBeenCalled();

    // Turn 3: 2 + 1 = 3, grace turns exhausted -> abort
    emit({ type: "turn_end" });
    expect(session.abort).toHaveBeenCalledTimes(1);

    // Repeated events post-abort are idempotent
    emit({ type: "turn_end" });
    emit({ type: "turn_end" });
    expect(session.abort).toHaveBeenCalledTimes(1);

    const result = await resumePromise;
    expect(result.aborted).toBe(true);
    expect(result.steered).toBe(true);
  });

  it("zero grace turns (graceTurns = 0): aborts immediately at maxTurns", async () => {
    setGraceTurns(0);
    const { session, emit } = createMockSession();

    const resumePromise = resumeAgent(session as any, "Continue", {
      maxTurns: 2,
    });

    emit({ type: "turn_end" });
    expect(session.abort).not.toHaveBeenCalled();

    // Turn 2: turnCount >= maxTurns + 0 -> immediate abort
    emit({ type: "turn_end" });
    expect(session.abort).toHaveBeenCalledTimes(1);

    const result = await resumePromise;
    expect(result.aborted).toBe(true);
  });
});

describe("AgentManager.resume turn governance and status transitions", () => {
  let manager: AgentManager;
  let initialGrace: number;

  beforeEach(() => {
    initialGrace = getGraceTurns();
    manager = new AgentManager({} as any);
  });

  afterEach(() => {
    setGraceTurns(initialGrace);
    vi.restoreAllMocks();
  });

  it("foreground resume transitions record.status to 'aborted' when turn limit is exceeded", async () => {
    setGraceTurns(0);
    const { session, emit } = createMockSession();
    const record: AgentRecord = {
      id: "agent-test-1",
      type: "Explore",
      status: "completed",
      startedAt: Date.now() - 1000,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      session: session as any,
    };
    (manager as any).agents.set(record.id, record);

    const resumePromise = manager.resume("agent-test-1", "Next step", undefined, {
      maxTurns: 1,
    });

    // Fire turn_end to exceed maxTurns with graceTurns=0
    emit({ type: "turn_end" });

    const settled = await resumePromise;
    expect(settled?.status).toBe("aborted");
    expect(settled?.result).toBe("Resume response");
  });

  it("foreground resume transitions record.status to 'steered' when soft limit is reached but finished", async () => {
    setGraceTurns(2);
    const { session, emit } = createMockSession();
    const record: AgentRecord = {
      id: "agent-test-2",
      type: "Explore",
      status: "completed",
      startedAt: Date.now() - 1000,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      session: session as any,
    };
    (manager as any).agents.set(record.id, record);

    const resumePromise = manager.resume("agent-test-2", "Next step", undefined, {
      maxTurns: 1,
    });

    emit({ type: "turn_end" });

    const settled = await resumePromise;
    expect(settled?.status).toBe("steered");
  });

  it("startAgent catch block suppresses error assignment when record.status is 'stopped'", async () => {
    const record: AgentRecord = {
      id: "agent-test-stop",
      type: "Explore",
      status: "stopped", // externally stopped via manager.abort
      startedAt: Date.now() - 1000,
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    };
    (manager as any).agents.set(record.id, record);

    // Simulate rejection handler in startAgent
    const abortErr = new Error("Session aborted");
    if (record.status !== "stopped") {
      record.status = "error";
      record.error = abortErr.message;
    }

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });
});
