import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, sessionStructuredCaptures } from "../src/agent-runner.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../src/structured-output.js";

describe("Resume Structured Clean State & Structured Preservation", () => {
  function createStubManager() {
    const manager = new AgentManager();
    return manager;
  }

  it("does not issue a structured-output retry after a terminal provider error", async () => {
    const session: any = {
      agent: {}, messages: [], subscribe: () => () => {},
      getAllTools: () => [{ name: STRUCTURED_OUTPUT_TOOL_NAME }],
      prompt: vi.fn(async () => {
        session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "insufficient_quota", content: [] });
      }),
    };
    sessionStructuredCaptures.set(session, { called: false });
    const result = await resumeAgent(session, "continue");
    expect(result.failure).toBe("insufficient_quota");
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("clears stale structuredJson and structuredRetried on resume start and settlement", async () => {
    const manager = createStubManager();
    const listeners: ((event: any) => void)[] = [];
    const session: any = {
      agent: {},
      messages: [],
      subscribe: (l: any) => {
        listeners.push(l);
        return () => {};
      },
      getActiveToolNames: () => ["read", "bash"],
      setActiveToolsByName: () => {},
      getAllTools: () => [{ name: "read" }, { name: "bash" }],
      prompt: async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Resumed text explanation." }],
        });
      },
    };

    const record: any = {
      id: "agent-1",
      session,
      status: "completed",
      startedAt: Date.now() - 5000,
      completedAt: Date.now() - 1000,
      result: '{"step": 1, "done": true}',
      structuredJson: '{"step": 1, "done": true}',
      structuredRetried: true,
      toolUses: 2,
    };

    (manager as any).agents.set(record.id, record);

    // Prior to resume: record has structuredJson
    expect(record.structuredJson).toBe('{"step": 1, "done": true}');

    // Resume agent with a plain text prompt
    const resumed = await manager.resume("agent-1", "Explain step 1 in prose");
    expect(resumed).toBeDefined();
    expect(resumed?.status).toBe("completed");
    expect(resumed?.result).toBe("Resumed text explanation.");
    // structuredJson and structuredRetried MUST be undefined, not leaking the first-run JSON!
    expect(resumed?.structuredJson).toBeUndefined();
    expect(resumed?.structuredRetried).toBeUndefined();
  });

  it("preserves StructuredOutput tool and steers correctly when resumed session hits hardLimit", async () => {
    const listeners: ((event: any) => void)[] = [];
    let active = ["read", "bash", STRUCTURED_OUTPUT_TOOL_NAME];
    let steeredMessage: string | undefined;

    const session: any = {
      agent: {},
      messages: [],
      subscribe: (l: any) => {
        listeners.push(l);
        return () => {};
      },
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active = [...names];
      },
      getAllTools: () => [
        { name: "read" },
        { name: "bash" },
        { name: STRUCTURED_OUTPUT_TOOL_NAME },
      ],
      steer: (msg: string) => {
        steeredMessage = msg;
      },
      prompt: async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Waiting for wrap up" }],
        });
      },
    };

    const resumePromise = resumeAgent(session, "Continue work", {
      maxTurns: 1,
      hardLimit: true,
    });

    // Fire turn 1 end -> reaches maxTurns
    for (const l of [...listeners]) {
      l({ type: "turn_end" });
    }

    // Active tools must preserve StructuredOutput instead of being wiped to []
    expect(active).toEqual([STRUCTURED_OUTPUT_TOOL_NAME]);
    expect(steeredMessage).toMatch(/Return your final answer now by calling StructuredOutput/);

    // Tool call for read should be blocked by hard limit
    const blockedCall = await session.agent.beforeToolCall({
      toolCall: { id: "t1", name: "read" },
    });
    expect(blockedCall).toBeDefined();
    expect(blockedCall.block).toBe(true);
    expect(blockedCall.reason).toMatch(/disabled by hard limit/);

    // Tool call for StructuredOutput should NOT be blocked
    const allowedCall = await session.agent.beforeToolCall({
      toolCall: { id: "t2", name: STRUCTURED_OUTPUT_TOOL_NAME },
    });
    expect(allowedCall).toBeUndefined();

    await resumePromise;
  });

  it("captures new structured output on resume when StructuredOutput is called", async () => {
    const listeners: ((event: any) => void)[] = [];
    const capture: any = {
      called: true,
      json: '{"old": "data"}',
    };

    const session: any = {
      agent: {},
      messages: [],
      subscribe: (l: any) => {
        listeners.push(l);
        return () => {};
      },
      getActiveToolNames: () => [STRUCTURED_OUTPUT_TOOL_NAME],
      setActiveToolsByName: () => {},
      getAllTools: () => [{ name: STRUCTURED_OUTPUT_TOOL_NAME }],
      prompt: async () => {
        // Simulate StructuredOutput tool invocation during resume
        capture.called = true;
        capture.json = '{"updated": true, "revision": 2}';
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Recorded final structured payload" }],
        });
      },
    };

    sessionStructuredCaptures.set(session, capture);

    const result = await resumeAgent(session, "Update the JSON payload", {
      maxTurns: 2,
    });

    expect(result.structuredJson).toBe('{"updated": true, "revision": 2}');
  });
});
