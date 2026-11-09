import { fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

describe("optional resume type through the real print-mode host", () => {
  let run: PrintModeRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("resumes a foreground child without a type, preserving its conversation", async () => {
    let childCalls = 0;
    let resumedId = "";
    let resumedContext = "";
    run = await runPrintMode({
      live: false,
      prompt: "Delegate and then continue the same child.",
      respond: (context) => {
        if (!getCurrentTools(context.messages).some((tool) => tool.name === "Agent")) {
          childCalls++;
          if (childCalls === 1) return "FIRST_CHILD_ANSWER";
          resumedContext = JSON.stringify(context.messages);
          return resumedContext.includes("FIRST_CHILD_TASK") &&
            resumedContext.includes("FIRST_CHILD_ANSWER") &&
            resumedContext.includes("CONTINUE_CHILD_TASK")
            ? "CONTINUED_WITH_HISTORY"
            : "MISSING_CHILD_HISTORY";
        }
        const results = context.messages.filter(
          (message) => message.role === "toolResult" && message.toolName === "Agent",
        );
        if (results.length === 0) {
          return agentCall({
            subagent_type: "general-purpose",
            description: "first child task",
            prompt: "FIRST_CHILD_TASK",
            run_in_background: false,
          });
        }
        if (results.length === 1) {
          const resultText = results[0].content.map((block) => block.type === "text" ? block.text : "").join("");
          resumedId = /`resume` parameter set to "([^"]+)"/.exec(resultText)?.[1] ?? "";
          if (!resumedId) return "MISSING_RESUME_ID";
          // Do not use agentCall: its helper supplies a default subagent_type.
          return fauxToolCall("Agent", {
            resume: resumedId,
            description: "continue child",
            prompt: "CONTINUE_CHILD_TASK",
            run_in_background: false,
          });
        }
        return "Parent finished.";
      },
    });

    const calls = agentToolCalls(run.parentSession);
    const results = agentToolResults(run.parentSession);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ subagent_type: "general-purpose", run_in_background: false });
    expect(resumedId).not.toBe("");
    expect(calls[1]).toMatchObject({ resume: resumedId, run_in_background: false });
    expect(calls[1]).not.toHaveProperty("subagent_type");
    expect(results).toHaveLength(2);
    expect(results[0]).toContain("FIRST_CHILD_ANSWER");
    expect(results[0]).toContain(`"${resumedId}"`);
    expect(results[1]).toContain("CONTINUED_WITH_HISTORY");
    expect(results[1]).not.toContain("MISSING_CHILD_HISTORY");
    expect(childCalls).toBe(2);
    expect(resumedContext).toContain("FIRST_CHILD_TASK");
    expect(resumedContext).toContain("FIRST_CHILD_ANSWER");
    expect(resumedContext).toContain("CONTINUE_CHILD_TASK");
    const toolMessages = run.parentSession.messages.filter((m) => m.role === "toolResult" && m.toolName === "Agent");
    expect(toolMessages.map((m) => m.isError)).toEqual([false, false]);
  });

  it("rejects a fresh call without a type without starting a child", async () => {
    let childCalls = 0;
    run = await runPrintMode({
      live: false,
      prompt: "Try a fresh delegation without specifying a type.",
      respond: (context) => {
        if (!getCurrentTools(context.messages).some((tool) => tool.name === "Agent")) {
          childCalls++;
          return "UNEXPECTED_CHILD";
        }
        if (context.messages.some((m) => m.role === "toolResult" && m.toolName === "Agent")) return "Done.";
        return fauxToolCall("Agent", { description: "missing type", prompt: "do work", run_in_background: false });
      },
    });

    expect(agentToolCalls(run.parentSession)).toHaveLength(1);
    expect(agentToolCalls(run.parentSession)[0]).not.toHaveProperty("subagent_type");
    expect(agentToolCalls(run.parentSession)[0]).not.toHaveProperty("resume");
    expect(agentToolResults(run.parentSession)).toHaveLength(1);
    expect(agentToolResults(run.parentSession)[0]).toContain("subagent_type is required to start a new agent");
    expect(childCalls).toBe(0);
    expect(run.modelCalls).toBe(2); // parent tool call and final answer only
  });
});
