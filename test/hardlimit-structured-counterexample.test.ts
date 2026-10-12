import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resumeAgent,
  runAgent,
  sessionStructuredCaptures,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";
import { getAgentConfig } from "../src/agent-types.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../src/structured-output.js";

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
  let activeTools = ["read", "bash", STRUCTURED_OUTPUT_TOOL_NAME];
  const session = {
    sessionId: "test-sess",
    messages: [] as any[],
    agent: {
      state: { messages: [] },
      signal: new AbortController().signal,
      beforeToolCall: undefined as any,
    },
    getActiveToolNames: vi.fn(() => activeTools),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
    getAllTools: vi.fn(() => [
      { name: "read", description: "read file" },
      { name: "bash", description: "run bash" },
      { name: STRUCTURED_OUTPUT_TOOL_NAME, description: "structured output" },
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

const sampleSchema = {
  type: "object",
  properties: {
    verdict: { type: "string" },
  },
  required: ["verdict"],
};

describe("Hard-limit and StructuredOutput Counterexample & Verification", () => {
  beforeEach(() => {
    setGraceTurns(5);
    setDefaultMaxTurns(undefined);
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(getAgentConfig).mockReset();
  });

  it("Counterexample 1 resolved: when graceTurns is 0, hard_limit turn ceiling affords structuredRetryPrompt recovery rather than unrecoverable abort", async () => {
    setGraceTurns(0);
    const { session, listeners } = createMockSession();

    let promptCallCount = 0;
    session.prompt.mockImplementation(async () => {
      promptCallCount++;
      if (promptCallCount === 1) {
        // Initial run reaches maxTurns = 3, triggering abort on turn 3
        const maxT = 3;
        for (let i = 1; i <= maxT; i++) {
          for (const l of [...listeners]) {
            l({ type: "turn_end" });
          }
        }
      } else {
        // Retry prompt executes turn 4
        for (const l of [...listeners]) {
          l({ type: "turn_end" });
        }
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Answer in retry" }],
        });
      }
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    const result = await runAgent(ctx, "Explore", "task", {
      pi,
      maxTurns: 3,
      hardLimit: true,
      structuredOutput: sampleSchema,
    });

    // Initial prompt was aborted at ceiling, but structuredRetryPrompt was invoked to recover answer
    expect(promptCallCount).toBe(2);
    expect(result.structuredRetried).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("Measurement: at max_turns under hardLimit, active tools are restricted specifically to [StructuredOutput]", async () => {
    setGraceTurns(2);
    const { session, listeners } = createMockSession();

    let capturedActiveToolsAtSteer: string[] = [];
    session.steer.mockImplementation(async () => {
      capturedActiveToolsAtSteer = [...session.getActiveToolNames()];
    });

    session.prompt.mockImplementation(async () => {
      const maxT = 3;
      for (let i = 1; i <= maxT; i++) {
        for (const l of [...listeners]) {
          l({ type: "turn_end" });
        }
      }
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    await runAgent(ctx, "Explore", "task", {
      pi,
      maxTurns: 3,
      hardLimit: true,
      structuredOutput: sampleSchema,
    });

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer.mock.calls[0][0]).toContain("Return your final answer now by calling StructuredOutput");
    expect(capturedActiveToolsAtSteer).toEqual([STRUCTURED_OUTPUT_TOOL_NAME]);
  });

  it("Counterexample 2 resolved: structuredRetryPrompt is shielded from accumulated turn ceiling aborts via inStructuredRetry", async () => {
    setGraceTurns(2);
    const { session, listeners } = createMockSession();

    let promptCallCount = 0;
    session.prompt.mockImplementation(async () => {
      promptCallCount++;
      if (promptCallCount === 1) {
        const loopCount = 3;
        for (let i = 1; i <= loopCount; i++) {
          for (const l of [...listeners]) {
            l({ type: "turn_end" });
          }
        }
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Prose without structured output" }],
        });
      } else if (promptCallCount === 2) {
        for (const l of [...listeners]) {
          l({ type: "turn_end" });
        }
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Trying to answer in retry" }],
        });
      }
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    const result = await runAgent(ctx, "Explore", "task", {
      pi,
      maxTurns: 2,
      hardLimit: true,
      structuredOutput: sampleSchema,
    });

    // InStructuredRetry protects the retry turn from being aborted by turnCount >= maxTurns + graceTurns
    expect(promptCallCount).toBe(2);
    expect(result.structuredRetried).toBe(true);
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
  });

  it("Resumed agent with structured output supports structuredRetryPrompt lifecycle", async () => {
    setGraceTurns(2);
    const { session, listeners } = createMockSession();

    let promptCallCount = 0;
    session.prompt.mockImplementation(async () => {
      promptCallCount++;
      for (const l of [...listeners]) {
        l({ type: "turn_end" });
      }
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: promptCallCount === 1 ? "Initial prose" : "Retry prose" }],
      });
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    // Initial run sets structured output capture on session
    await runAgent(ctx, "Explore", "task", {
      pi,
      maxTurns: 5,
      hardLimit: true,
      structuredOutput: sampleSchema,
    });

    // Now resume the same session
    promptCallCount = 0;
    const resumeResult = await resumeAgent(session as any, "resume prompt", {
      maxTurns: 2,
      hardLimit: true,
    });

    expect(promptCallCount).toBe(2);
    expect(resumeResult.structuredRetried).toBe(true);
    expect(resumeResult.failure).toContain("The agent did not report its answer through StructuredOutput");
  });

  it("Counterexample 3: Resumed agent restores full in-scope tools even if previous run hit hardLimit limitReached", async () => {
    setGraceTurns(2);
    const { session, listeners } = createMockSession();

    let inResume = false;
    let toolsAtResumeStart: string[] = [];
    session.prompt.mockImplementation(async () => {
      if (!inResume) {
        // Initial run reaches limit
        for (const l of [...listeners]) {
          l({ type: "turn_end" });
        }
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Prose" }],
        });
      } else {
        if (toolsAtResumeStart.length === 0) {
          toolsAtResumeStart = [...session.getActiveToolNames()];
        }
        const capture = sessionStructuredCaptures.get(session as any);
        if (capture) {
          capture.json = JSON.stringify({ verdict: "ok" });
        }
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        });
      }
    });

    vi.mocked(createAgentSession).mockResolvedValue({ session } as any);

    // Initial run with maxTurns: 1, so it reaches limitReached = true
    await runAgent(ctx, "Explore", "task", {
      pi,
      maxTurns: 1,
      hardLimit: true,
      structuredOutput: sampleSchema,
    });

    // At end of runAgent with hardLimit, active tools were restricted to [STRUCTURED_OUTPUT_TOOL_NAME]
    expect(session.getActiveToolNames()).toEqual([STRUCTURED_OUTPUT_TOOL_NAME]);

    // When resuming, tools should be restored to all in-scope tools (read, bash, StructuredOutput)
    inResume = true;
    await resumeAgent(session as any, "resume prompt", {
      maxTurns: 2,
      hardLimit: true,
    });

    expect(toolsAtResumeStart).toEqual(["read", "bash", STRUCTURED_OUTPUT_TOOL_NAME]);
    expect(session.getActiveToolNames()).toEqual(["read", "bash", STRUCTURED_OUTPUT_TOOL_NAME]);
  });
});
