import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ReturnType<typeof makeHeadlessCtx>,
  ) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      let subscribers = eventHandlers.get(event);
      if (!subscribers) {
        subscribers = new Set();
        eventHandlers.set(event, subscribers);
      }
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    }),
  };

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events,
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never,
    tools,
    handlers,
    events,
    eventHandlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as never;
}

function completedRun() {
  return {
    responseText: "done",
    session: { dispose: vi.fn() },
    aborted: false,
    steered: false,
  } as Awaited<ReturnType<typeof runAgent>>;
}

async function spawnBackground(
  tool: RegisteredTool,
  toolCallId: string,
  description: string,
): Promise<void> {
  await tool.execute(
    toolCallId,
    {
      prompt: "reply done",
      description,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    makeHeadlessCtx(),
  );
}

describe("background completion notification wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { label: "missing options", payload: {}, description: "general-purpose", escaped: "general-purpose" },
    { label: "empty options", payload: { options: {} }, description: "general-purpose", escaped: "general-purpose" },
    { label: "undefined options", payload: { options: undefined }, description: "general-purpose", escaped: "general-purpose" },
    { label: "null options", payload: { options: null }, description: "general-purpose", escaped: "general-purpose" },
    { label: "undefined description", payload: { options: { isBackground: true, description: undefined } }, description: "general-purpose", escaped: "general-purpose" },
    { label: "null description", payload: { options: { isBackground: true, description: null } }, description: "general-purpose", escaped: "general-purpose" },
    { label: "empty description", payload: { options: { isBackground: true, description: "" } }, description: "", escaped: "" },
    { label: "whitespace description", payload: { options: { isBackground: true, description: " \t " } }, description: " \t ", escaped: " \t " },
    { label: "explicit description", payload: { options: { isBackground: true, description: "RPC child" } }, description: "RPC child", escaped: "RPC child" },
    { label: "XML description", payload: { options: { isBackground: true, description: 'inspect <child> & "quotes"' } }, description: 'inspect <child> & "quotes"', escaped: 'inspect &lt;child&gt; &amp; "quotes"' },
    { label: "background options without description", payload: { options: { isBackground: true } }, description: "general-purpose", escaped: "general-purpose" },
  ])("normalizes the real RPC record and respects notification delivery for $label", async ({ payload, description, escaped }) => {
    vi.useFakeTimers();
    // Keep completion separate from the spawn reply, as in a real detached run.
    let complete!: (result: Awaited<ReturnType<typeof runAgent>>) => void;
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const { pi, handlers, events, eventHandlers } = makePi();
    subagentsExtension(pi);

    try {
      expect(eventHandlers.get("subagents:rpc:spawn")?.size ?? 0).toBe(0);
      await handlers.get("session_start")!({}, makeHeadlessCtx());
      expect(eventHandlers.get("subagents:rpc:spawn")?.size).toBe(1);

      // Another extension can observe the same channel without replacing RPC.
      const observedSpawn = vi.fn();
      const unsubscribeObserver = events.on("subagents:rpc:spawn", observedSpawn);
      const reply = vi.fn();
      const unsubscribeReply = events.on("subagents:rpc:spawn:reply:description-case", reply);
      const request = {
        requestId: "description-case",
        type: "general-purpose",
        prompt: "reply done",
        ...payload,
      };
      events.emit("subagents:rpc:spawn", request);
      await vi.advanceTimersByTimeAsync(0);

      expect(observedSpawn).toHaveBeenCalledExactlyOnceWith(request);
      expect(reply).toHaveBeenCalledExactlyOnceWith({ success: true, data: { id: expect.any(String) } });
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(pi.sendMessage).not.toHaveBeenCalled();
      const { data: { id } } = reply.mock.calls[0][0] as { data: { id: string } };
      unsubscribeObserver();
      unsubscribeReply();
      expect(eventHandlers.get("subagents:rpc:spawn")?.has(observedSpawn)).toBe(false);
      expect(eventHandlers.get("subagents:rpc:spawn:reply:description-case")?.size).toBe(0);

      complete(completedRun());
      await vi.advanceTimersByTimeAsync(0);
      expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
        id, description, status: "completed", result: "done",
      }));
      expect(pi.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400); // Past both the debounce and result-consumption hold.

      // Omitted/empty options do not set isBackground: the manager consumes
      // those results on settle. Pin their normalized persisted record above;
      // exercise actual held delivery for every background description variant.
      const isBackground = "options" in payload && payload.options != null
        && "isBackground" in payload.options && payload.options.isBackground === true;
      expect(pi.sendMessage).toHaveBeenCalledTimes(isBackground ? 1 : 0);
      if (isBackground) {
        expect(pi.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            customType: "subagent-notification",
            content: expect.stringContaining(`<summary>Agent "${escaped}" completed</summary>`),
            details: expect.objectContaining({ id, description }),
          }),
          { deliverAs: "steer", triggerTurn: true },
        );
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(pi.sendMessage).toHaveBeenCalledTimes(isBackground ? 1 : 0);
    } finally {
      // An assertion before completion must not strand shutdown on the fake clock.
      complete?.(completedRun());
      await vi.advanceTimersByTimeAsync(0);
      await handlers.get("session_shutdown")?.();
    }
    expect(eventHandlers.get("subagents:rpc:spawn")?.size).toBe(0);
  });

  it("requests steering for an individual completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    await spawnBackground(tools.get("Agent")!, "individual-call", "individual child");
    await vi.advanceTimersByTimeAsync(300); // 100ms smart-batch debounce + 200ms hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("individual child"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("requests steering for a grouped completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    // Both runs settle after their spawns return, as real runs do.
    let settleRuns!: () => void;
    const runsSettled = new Promise<void>((resolve) => { settleRuns = resolve; });
    vi.mocked(runAgent).mockImplementation(async () => {
      await runsSettled;
      return completedRun();
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "group-call-1", "first grouped child"),
      spawnBackground(agentTool, "group-call-2", "second grouped child"),
    ]);
    settleRuns();
    await vi.advanceTimersByTimeAsync(300); // 100ms smart-batch debounce + 200ms group hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("Background agent group completed"),
        details: expect.objectContaining({
          description: expect.stringMatching(/grouped child/),
          others: expect.arrayContaining([
            expect.objectContaining({ description: expect.stringMatching(/grouped child/) }),
          ]),
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });
});
