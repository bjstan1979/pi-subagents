/**
 * shutdown-disposal.test.ts — pins #316/#256 on this local fork: the root
 * activation's session_shutdown must release the widget, group joins AND the
 * local 100ms batch debounce / 200ms held-notification timers. The upstream
 * notification outbox is deliberately NOT part of this port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { GroupJoinManager } from "../src/group-join.js";
import subagentsExtension from "../src/index.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** A run that stays pending until `finish` is called, so timers can be armed. */
function pendingRun() {
  let finish!: (value: any) => void;
  vi.mocked(runAgent).mockImplementation(
    () => new Promise((resolve) => { finish = resolve; }) as ReturnType<typeof runAgent>,
  );
  return (result = "done") => finish({
    responseText: result,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
}

async function spawn(tools: Map<string, any>, id: string, sessionCtx = ctx()) {
  await tools.get("Agent")!.execute(
    id,
    {
      prompt: "go",
      description: id,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    sessionCtx,
  );
}

function contextWithUI() {
  return ctx({
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
  });
}

describe("session_shutdown disposes activation-owned resources (#316/#256)", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({
      settings: { schedulingEnabled: false, workflowsEnabled: false },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    hermetic.restore();
  });

  it("disposes the widget and group joins on shutdown", async () => {
    const { pi, lifecycle } = makePi();
    const widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    const groupJoinDispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    subagentsExtension(pi);

    await lifecycle.get("session_shutdown")?.({}, contextWithUI());

    expect(widgetDispose).toHaveBeenCalledTimes(1);
    expect(groupJoinDispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the widget and group joins on session_before_switch (a vetoed switch continues)", async () => {
    const { pi, lifecycle } = makePi();
    const widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    const groupJoinDispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    subagentsExtension(pi);

    await lifecycle.get("session_before_switch")?.();

    expect(widgetDispose).not.toHaveBeenCalled();
    expect(groupJoinDispose).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, contextWithUI());
    expect(widgetDispose).toHaveBeenCalledTimes(1);
    expect(groupJoinDispose).toHaveBeenCalledTimes(1);
  });

  it("cancels the 100ms batch debounce and its buffered completion on shutdown", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const finish = pendingRun();
    const uiCtx = contextWithUI();
    await lifecycle.get("tool_execution_start")?.({}, uiCtx);
    await spawn(tools, "batch-agent", ctx());

    finish();
    await vi.advanceTimersByTimeAsync(0); // completion buffered; debounce still open
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, uiCtx);
    // manager.dispose owns a bounded 3s race timer; run past it too so the
    // assertion counts only the activation's own intervals/debounces.
    await vi.advanceTimersByTimeAsync(3000);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the 200ms held notification and 80ms widget interval on shutdown", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const uiCtx = contextWithUI();
    await lifecycle.get("tool_execution_start")?.({}, uiCtx);
    await spawn(tools, "nudge-agent", ctx());
    await vi.advanceTimersByTimeAsync(100); // finalizeBatch arms the 200ms held nudge

    expect(pi.sendMessage).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, uiCtx);
    await vi.advanceTimersByTimeAsync(3000);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
