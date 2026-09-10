import { describe, expect, it } from "vitest";
import {
  installSessionToolController,
  isReadOnlyShellCommand,
  isSubpathOrEqual,
  resumeAgent,
} from "../src/agent-runner.js";

describe("Tool Loop Guard & Universal Session Controller", () => {
  function createStubSession() {
    const listeners: ((event: any) => void)[] = [];
    let active = ["read", "bash", "edit", "write"];
    const all = [
      { name: "read" },
      { name: "bash" },
      { name: "edit" },
      { name: "write" },
      { name: "grep" },
    ];

    const session: any = {
      agent: {},
      messages: [],
      subscribe: (l: (event: any) => void) => {
        listeners.push(l);
        return () => {
          const idx = listeners.indexOf(l);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active = [...names];
      },
      getAllTools: () => all,
      prompt: async () => {},
      _emit: (event: any) => {
        for (const l of [...listeners]) l(event);
      },
    };

    return { session, listeners };
  }

  it("blocks 3rd consecutive identical failing tool call", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    const call1 = { toolCall: { id: "c1", name: "bash", arguments: { command: "failing_cmd" } } };
    const res1 = await session.agent.beforeToolCall(call1);
    expect(res1).toBeUndefined();

    // Tool executes and fails
    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "failing_cmd" }, isError: true });
    session._emit({ type: "turn_end" });

    // Turn 2: identical failing call
    const call2 = { toolCall: { id: "c2", name: "bash", arguments: { command: "failing_cmd" } } };
    const res2 = await session.agent.beforeToolCall(call2);
    expect(res2).toBeUndefined();

    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "failing_cmd" }, isError: true });
    session._emit({ type: "turn_end" });

    // Turn 3: 3rd identical attempt is blocked
    const call3 = { toolCall: { id: "c3", name: "bash", arguments: { command: "failing_cmd" } } };
    const res3 = await session.agent.beforeToolCall(call3);
    expect(res3).toBeDefined();
    expect(res3.block).toBe(true);
    expect(res3.reason).toMatch(/failed consecutively \(2 times\)/);
  });

  it("permits tool call when arguments change", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Call 1 fails
    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "cmd_a" }, isError: true });
    session._emit({ type: "turn_end" });

    // Call 2 fails
    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "cmd_a" }, isError: true });
    session._emit({ type: "turn_end" });

    // Different arguments: allowed!
    const callDiff = { toolCall: { id: "c3", name: "bash", arguments: { command: "cmd_b" } } };
    const res = await session.agent.beforeToolCall(callDiff);
    expect(res).toBeUndefined();
  });

  it("resets failure counter when modifying tool succeeds", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Failing calls twice
    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "pytest" }, isError: true });
    session._emit({ type: "turn_end" });
    session._emit({ type: "tool_execution_end", toolName: "bash", args: { command: "pytest" }, isError: true });
    session._emit({ type: "turn_end" });

    // Agent edits file to fix bug
    session._emit({ type: "tool_execution_end", toolName: "edit", args: { path: "test.py" }, isError: false });
    session._emit({ type: "turn_end" });

    // pytest is now permitted again!
    const callAfterFix = { toolCall: { id: "c4", name: "bash", arguments: { command: "pytest" } } };
    const res = await session.agent.beforeToolCall(callAfterFix);
    expect(res).toBeUndefined();
  });

  it("blocks redundant identical consecutive read calls", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    const readCall = { toolCall: { id: "r1", name: "read", arguments: { path: "foo.ts", offset: 1, limit: 50 } } };
    const res1 = await session.agent.beforeToolCall(readCall);
    expect(res1).toBeUndefined();

    // Read succeeds
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "foo.ts", offset: 1, limit: 50 }, isError: false });
    session._emit({ type: "turn_end" });

    // Next turn: identical read without any modifications
    const res2 = await session.agent.beforeToolCall(readCall);
    expect(res2).toBeDefined();
    expect(res2.block).toBe(true);
    expect(res2.reason).toMatch(/already executed in the preceding turn/);

    // But reading a different range is allowed
    const diffRead = { toolCall: { id: "r2", name: "read", arguments: { path: "foo.ts", offset: 51, limit: 50 } } };
    const resDiff = await session.agent.beforeToolCall(diffRead);
    expect(resDiff).toBeUndefined();
  });

  it("permits re-reading after an edit or write modifies the file", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Initial read
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "foo.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Modifying tool
    session._emit({ type: "tool_execution_end", toolName: "write", args: { path: "foo.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Re-reading modified file is allowed!
    const reRead = { toolCall: { id: "r3", name: "read", arguments: { path: "foo.ts" } } };
    const res = await session.agent.beforeToolCall(reRead);
    expect(res).toBeUndefined();
  });

  it("prevents multi-file read loops across consecutive turns (fixes single-slot erasure)", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1 reads both file A and file B
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "a.ts" }, isError: false });
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "b.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: Attempting to re-read file A must be blocked (not erased by file B!)
    const callA = { toolCall: { id: "rA", name: "read", arguments: { path: "a.ts" } } };
    const resA = await session.agent.beforeToolCall(callA);
    expect(resA?.block).toBe(true);
    expect(resA?.reason).toMatch(/already executed in the preceding turn/);

    // Attempting to re-read file B must also be blocked
    const callB = { toolCall: { id: "rB", name: "read", arguments: { path: "b.ts" } } };
    const resB = await session.agent.beforeToolCall(callB);
    expect(resB?.block).toBe(true);
    expect(resB?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("blocks duplicate read-only executions in the same turn", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // First read in turn 1 completes
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "dup.ts" }, isError: false });

    // Duplicate read arriving in the SAME turn before turn_end
    const dupCall = { toolCall: { id: "rDup", name: "read", arguments: { path: "dup.ts" } } };
    const res = await session.agent.beforeToolCall(dupCall);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/already executed in this turn/);
  });

  it("blocks concurrent parallel duplicate read-only calls before completion", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1 emits parallel tool_execution_start for two identical read calls
    const call1 = { toolCall: { id: "par1", name: "read", arguments: { path: "par.ts" } } };
    const call2 = { toolCall: { id: "par2", name: "read", arguments: { path: "par.ts" } } };

    session._emit({ type: "tool_execution_start", toolCallId: "par1", toolName: "read", args: { path: "par.ts" } });
    const res1 = await session.agent.beforeToolCall(call1);
    expect(res1).toBeUndefined();

    // Call 2 arrives while Call 1 is still in flight (no tool_execution_end yet)
    session._emit({ type: "tool_execution_start", toolCallId: "par2", toolName: "read", args: { path: "par.ts" } });
    const res2 = await session.agent.beforeToolCall(call2);
    expect(res2?.block).toBe(true);
    expect(res2?.reason).toMatch(/already executed in this turn/);
  });
  it("permits re-reading after undo_last_edit, rollback, and ts_morph modifications", async () => {
    for (const tool of ["undo_last_edit", "rollback", "ts_morph"]) {
      const { session } = createStubSession();
      installSessionToolController(session);

      // Initial read
      session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "test.ts" }, isError: false });
      session._emit({ type: "turn_end" });

      // Mutating tool executes
      session._emit({ type: "tool_execution_end", toolName: tool, args: { path: "test.ts" }, isError: false });
      session._emit({ type: "turn_end" });

      // Post-mutation read must be allowed!
      const postMutationRead = { toolCall: { id: `r-${tool}`, name: "read", arguments: { path: "test.ts" } } };
      const res = await session.agent.beforeToolCall(postMutationRead);
      expect(res).toBeUndefined();
    }
  });

  it("covers read_skill in read-only loop guard", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    session._emit({ type: "tool_execution_end", toolName: "read_skill", args: { path: "ref.md" }, isError: false });
    session._emit({ type: "turn_end" });

    const callSkill = { toolCall: { id: "s1", name: "read_skill", arguments: { path: "ref.md" } } };
    const res = await session.agent.beforeToolCall(callSkill);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("does not poison consecutiveFailures when a tool call is blocked at preflight", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Initial read
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "clean.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: read is blocked by redundant read guard
    const call = { toolCall: { id: "r-block", name: "read", arguments: { path: "clean.ts" } } };
    const blocked = await session.agent.beforeToolCall(call);
    expect(blocked?.block).toBe(true);

    // Runtime emits tool_execution_end with isError: true for the blocked call
    session._emit({ type: "tool_execution_end", toolCallId: "r-block", toolName: "read", isError: true });

    // Now an intervening edit occurs
    session._emit({ type: "tool_execution_end", toolName: "edit", args: { path: "clean.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Now when read is called again, consecutiveFailures must be 0, not 1 or 2!
    const callAfter = { toolCall: { id: "r-clean", name: "read", arguments: { path: "clean.ts" } } };
    const allowed = await session.agent.beforeToolCall(callAfter);
    expect(allowed).toBeUndefined();
  });

  it("permanently blocks unmutated re-reading across multiple turns without oscillating", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: initial read
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "osc.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: re-read is blocked (preceding turn)
    const callTurn2 = { toolCall: { id: "r-t2", name: "read", arguments: { path: "osc.ts" } } };
    const res2 = await session.agent.beforeToolCall(callTurn2);
    expect(res2?.block).toBe(true);
    expect(res2?.reason).toMatch(/already executed in the preceding turn/);
    session._emit({ type: "tool_execution_end", toolCallId: "r-t2", toolName: "read", isError: true });
    session._emit({ type: "turn_end" });

    // Turn 3: re-read is still blocked (turn 1), no oscillation!
    const callTurn3 = { toolCall: { id: "r-t3", name: "read", arguments: { path: "osc.ts" } } };
    const res3 = await session.agent.beforeToolCall(callTurn3);
    expect(res3?.block).toBe(true);
    expect(res3?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
    session._emit({ type: "tool_execution_end", toolCallId: "r-t3", toolName: "read", isError: true });
    session._emit({ type: "turn_end" });

    // Turn 4: re-read is still blocked (turn 1)
    const callTurn4 = { toolCall: { id: "r-t4", name: "read", arguments: { path: "osc.ts" } } };
    const res4 = await session.agent.beforeToolCall(callTurn4);
    expect(res4?.block).toBe(true);
    expect(res4?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("blocks ping-pong alternating multi-file read loops", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read A
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "a.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: read B
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "b.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: Attempting to ping-pong back to A must be blocked (turn 1)
    const callA3 = { toolCall: { id: "r-a3", name: "read", arguments: { path: "a.ts" } } };
    const resA3 = await session.agent.beforeToolCall(callA3);
    expect(resA3?.block).toBe(true);
    expect(resA3?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
    session._emit({ type: "tool_execution_end", toolCallId: "r-a3", toolName: "read", isError: true });
    session._emit({ type: "turn_end" });

    // Turn 4: Attempting to ping-pong back to B must also be blocked (turn 2)
    const callB4 = { toolCall: { id: "r-b4", name: "read", arguments: { path: "b.ts" } } };
    const resB4 = await session.agent.beforeToolCall(callB4);
    expect(resB4?.block).toBe(true);
    expect(resB4?.reason).toMatch(/already executed in turn 2 with no intervening modifications/);
  });

  it("distinguishes ts_morph inspect (read-only) from ts_morph replace/insert (modifying)", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Initial read of file
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "module.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Execute ts_morph with operation="inspect" (does not modify disk)
    const inspectCall = { toolCall: { id: "tm-insp", name: "ts_morph", arguments: { operation: "inspect", filePath: "module.ts", target: "MyClass" } } };
    const resInspect = await session.agent.beforeToolCall(inspectCall);
    expect(resInspect).toBeUndefined();
    session._emit({ type: "tool_execution_end", toolCallId: "tm-insp", toolName: "ts_morph", args: { operation: "inspect", filePath: "module.ts", target: "MyClass" }, isError: false });
    session._emit({ type: "turn_end" });

    // 1. Subsequent read of module.ts must STILL be blocked because inspect did not modify files
    const readAfterInspect = { toolCall: { id: "r-after-insp", name: "read", arguments: { path: "module.ts" } } };
    const resRead = await session.agent.beforeToolCall(readAfterInspect);
    expect(resRead?.block).toBe(true);
    expect(resRead?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);

    // 2. Duplicate ts_morph inspect with identical arguments is also guarded
    const dupInspect = { toolCall: { id: "tm-insp2", name: "ts_morph", arguments: { operation: "inspect", filePath: "module.ts", target: "MyClass" } } };
    const resDupInspect = await session.agent.beforeToolCall(dupInspect);
    expect(resDupInspect?.block).toBe(true);
    expect(resDupInspect?.reason).toMatch(/already executed in the preceding turn/);

    // 3. Now execute ts_morph with operation="replace" (modifying operation)
    const replaceCall = { toolCall: { id: "tm-repl", name: "ts_morph", arguments: { operation: "replace", filePath: "module.ts", target: "MyClass", code: "class MyClass {}" } } };
    const resReplace = await session.agent.beforeToolCall(replaceCall);
    expect(resReplace).toBeUndefined();
    session._emit({ type: "tool_execution_end", toolCallId: "tm-repl", toolName: "ts_morph", args: { operation: "replace", filePath: "module.ts", target: "MyClass", code: "class MyClass {}" }, isError: false });
    session._emit({ type: "turn_end" });

    // 4. Now reading module.ts is permitted because mutation occurred
    const readAfterReplace = { toolCall: { id: "r-after-repl", name: "read", arguments: { path: "module.ts" } } };
    const resReadAllowed = await session.agent.beforeToolCall(readAfterReplace);
    expect(resReadAllowed).toBeUndefined();
  });

  it("handles nested arguments stably regardless of key order", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Call 1 with nested object { a: 1, b: { y: 2, x: 1 } }
    const call1 = { toolCall: { id: "c1", name: "read", arguments: { path: "nested.ts", options: { y: 2, x: 1 } } } };
    const res1 = await session.agent.beforeToolCall(call1);
    expect(res1).toBeUndefined();
    session._emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", args: { path: "nested.ts", options: { y: 2, x: 1 } }, isError: false });
    session._emit({ type: "turn_end" });

    // Call 2 with inverted nested keys { options: { x: 1, y: 2 }, path: "nested.ts" }
    const call2 = { toolCall: { id: "c2", name: "read", arguments: { options: { x: 1, y: 2 }, path: "nested.ts" } } };
    const res2 = await session.agent.beforeToolCall(call2);
    expect(res2?.block).toBe(true);
    expect(res2?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("blocks redundant re-read in subsequent turn when file was read in the same turn after an edit", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: edit succeeds, then read succeeds in the same turn
    session._emit({ type: "tool_execution_end", toolName: "edit", args: { path: "code.ts" }, isError: false });
    session._emit({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", args: { path: "code.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: immediate re-read in preceding turn must be blocked
    const callTurn2 = { toolCall: { id: "r2", name: "read", arguments: { path: "code.ts" } } };
    const res2 = await session.agent.beforeToolCall(callTurn2);
    expect(res2?.block).toBe(true);
    expect(res2?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("blocks same-turn duplicate read after a modifying tool executes in that turn", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: edit succeeds, then read 1 succeeds in the same turn
    session._emit({ type: "tool_execution_end", toolName: "edit", args: { path: "code.ts" }, isError: false });
    session._emit({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", args: { path: "code.ts" }, isError: false });

    // Turn 1: identical read 2 arrives in the SAME turn
    const call2 = { toolCall: { id: "r2", name: "read", arguments: { path: "code.ts" } } };
    const res2 = await session.agent.beforeToolCall(call2);
    expect(res2?.block).toBe(true);
    expect(res2?.reason).toMatch(/already executed in this turn/);
  });
  it("invalidates read cache only for modified file while preserving read cache for untouched files", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read file A and file B
    session._emit({ type: "tool_execution_end", toolCallId: "rA1", toolName: "read", args: { path: "a.ts" }, isError: false });
    session._emit({ type: "tool_execution_end", toolCallId: "rB1", toolName: "read", args: { path: "b.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: edit file A only
    session._emit({ type: "tool_execution_end", toolCallId: "eA", toolName: "edit", args: { path: "a.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: re-reading file A is PERMITTED because file A was mutated
    const callA = { toolCall: { id: "rA2", name: "read", arguments: { path: "a.ts" } } };
    const resA = await session.agent.beforeToolCall(callA);
    expect(resA).toBeUndefined();

    // Turn 3: re-reading untouched file B must remain BLOCKED (redundancy eliminated)
    const callB = { toolCall: { id: "rB2", name: "read", arguments: { path: "b.ts" } } };
    const resB = await session.agent.beforeToolCall(callB);
    expect(resB?.block).toBe(true);
    expect(resB?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("preserves read_skill cache across file modifications", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read skill reference
    session._emit({ type: "tool_execution_end", toolCallId: "s1", toolName: "read_skill", args: { path: "git-guide.md" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: edit source file
    session._emit({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", args: { path: "app.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: re-reading skill must still be blocked (skills are never mutated by code edits)
    const callSkill = { toolCall: { id: "s2", name: "read_skill", arguments: { path: "git-guide.md" } } };
    const resSkill = await session.agent.beforeToolCall(callSkill);
    expect(resSkill?.block).toBe(true);
    expect(resSkill?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("normalizes file paths with leading ./ and redundant slashes to prevent loop evasion", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read path without ./
    session._emit({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", args: { path: "src/main.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: read same path with leading ./ and redundant slash ./src//main.ts
    const callEvade = { toolCall: { id: "r2", name: "read", arguments: { path: "./src//main.ts" } } };
    const res = await session.agent.beforeToolCall(callEvade);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("clears consecutive failure deadlock on resumeAgent prompt", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Failing tool twice in previous run
    session._emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", args: { command: "npm test" }, isError: true });
    session._emit({ type: "turn_end" });
    session._emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", args: { command: "npm test" }, isError: true });
    session._emit({ type: "turn_end" });

    // Turn 3 of run 1: 3rd identical attempt would be blocked
    const callBlocked = { toolCall: { id: "c3", name: "bash", arguments: { command: "npm test" } } };
    const resBlocked = await session.agent.beforeToolCall(callBlocked);
    expect(resBlocked?.block).toBe(true);

    // Now resumeAgent is called with a new prompt (e.g. user fixed environment or directed retry)
    await resumeAgent(session, "Retry running npm test now");

    // After resume, bash with identical arguments must be permitted (deadlock broken)
    const callResume = { toolCall: { id: "c4", name: "bash", arguments: { command: "npm test" } } };
    const resResume = await session.agent.beforeToolCall(callResume);
    expect(resResume).toBeUndefined();
  });

  it("recognizes powershell as a modifying tool", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Consecutive failures on command
    session._emit({ type: "tool_execution_end", toolCallId: "p1", toolName: "powershell", args: { command: "Get-Item missing" }, isError: true });
    session._emit({ type: "turn_end" });
    session._emit({ type: "tool_execution_end", toolCallId: "p2", toolName: "powershell", args: { command: "Get-Item missing" }, isError: true });
    session._emit({ type: "turn_end" });

    // Powershell modifying command succeeds
    session._emit({ type: "tool_execution_end", toolCallId: "p3", toolName: "powershell", args: { command: "New-Item file.txt" }, isError: false });
    session._emit({ type: "turn_end" });

    // Command failure counter is cleared
    const callAllowed = { toolCall: { id: "p4", name: "powershell", arguments: { command: "Get-Item missing" } } };
    const res = await session.agent.beforeToolCall(callAllowed);
    expect(res).toBeUndefined();
  });

  it("prevents preflight veto failure counter poisoning when callId is undefined", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Initial read without callId
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "file.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Preflight blocks redundant read (no callId)
    const callNoId = { toolCall: { name: "read", arguments: { path: "file.ts" } } };
    const blocked = await session.agent.beforeToolCall(callNoId);
    expect(blocked?.block).toBe(true);

    // tool_execution_end emitted with isError: true without toolCallId
    session._emit({ type: "tool_execution_end", toolName: "read", args: { path: "file.ts" }, isError: true });

    // Edit file to mutate state
    session._emit({ type: "tool_execution_end", toolName: "edit", args: { path: "file.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Subsequent read must be allowed, not poisoned
    const callAfter = { toolCall: { name: "read", arguments: { path: "file.ts" } } };
    const allowed = await session.agent.beforeToolCall(callAfter);
    expect(allowed).toBeUndefined();
  });

  it("preserves absolute path distinction without colliding with relative paths", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read absolute path /tmp/data.json
    session._emit({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", args: { path: "/tmp/data.json" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: reading relative path tmp/data.json must NOT collide with /tmp/data.json
    const callRel = { toolCall: { id: "r2", name: "read", arguments: { path: "tmp/data.json" } } };
    const resRel = await session.agent.beforeToolCall(callRel);
    expect(resRel).toBeUndefined();

    // Re-reading /tmp/data.json itself must be blocked
    const callAbsAgain = { toolCall: { id: "r3", name: "read", arguments: { path: "/tmp/data.json" } } };
    const resAbs = await session.agent.beforeToolCall(callAbsAgain);
    expect(resAbs?.block).toBe(true);
    expect(resAbs?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("preserves read_skill cache across workspace bash commands", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read skill reference
    session._emit({ type: "tool_execution_end", toolCallId: "s1", toolName: "read_skill", args: { path: "git-guide.md" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: bash execution (workspace mutation)
    session._emit({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", args: { command: "npm test" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: re-reading skill must remain blocked (skills are never mutated by bash workspace commands)
    const callSkill = { toolCall: { id: "s2", name: "read_skill", arguments: { path: "git-guide.md" } } };
    const resSkill = await session.agent.beforeToolCall(callSkill);
    expect(resSkill?.block).toBe(true);
    expect(resSkill?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("normalizes paths in grep, find, and ls to prevent loop evasion", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: grep with ./src
    session._emit({ type: "tool_execution_end", toolCallId: "g1", toolName: "grep", args: { pattern: "foo", path: "./src" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: grep with src (must be blocked)
    const callGrep = { toolCall: { id: "g2", name: "grep", arguments: { pattern: "foo", path: "src" } } };
    const resGrep = await session.agent.beforeToolCall(callGrep);
    expect(resGrep?.block).toBe(true);
    expect(resGrep?.reason).toMatch(/already executed in the preceding turn/);

    // Turn 2: find with ./src
    session._emit({ type: "tool_execution_end", toolCallId: "f1", toolName: "find", args: { pattern: "*.ts", path: "./src" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: find with src// (must be blocked)
    const callFind = { toolCall: { id: "f2", name: "find", arguments: { pattern: "*.ts", path: "src//" } } };
    const resFind = await session.agent.beforeToolCall(callFind);
    expect(resFind?.block).toBe(true);
    expect(resFind?.reason).toMatch(/already executed in the preceding turn/);
    expect(resFind?.reason).toMatch(/already executed in the preceding turn/);
  });

  it("classifies shell commands correctly as read-only vs mutating", () => {
    // Read-only commands
    expect(isReadOnlyShellCommand("git status")).toBe(true);
    expect(isReadOnlyShellCommand("git diff HEAD~1")).toBe(true);
    expect(isReadOnlyShellCommand("git log -n 5")).toBe(true);
    expect(isReadOnlyShellCommand("git show HEAD")).toBe(true);
    expect(isReadOnlyShellCommand("git rev-parse HEAD")).toBe(true);
    expect(isReadOnlyShellCommand("pwd")).toBe(true);
    expect(isReadOnlyShellCommand("ls -la")).toBe(true);
    expect(isReadOnlyShellCommand("cat package.json")).toBe(true);
    expect(isReadOnlyShellCommand("head -n 20 file.txt")).toBe(true);
    expect(isReadOnlyShellCommand("tail -n 10 file.txt")).toBe(true);
    expect(isReadOnlyShellCommand("grep 'foo' file.txt")).toBe(true);
    expect(isReadOnlyShellCommand("rg 'foo'")).toBe(true);
    expect(isReadOnlyShellCommand("which node")).toBe(true);
    expect(isReadOnlyShellCommand("node -v")).toBe(true);
    expect(isReadOnlyShellCommand("python3 --version")).toBe(true);
    expect(isReadOnlyShellCommand("cargo --version")).toBe(true);
    expect(isReadOnlyShellCommand("echo 'hello'")).toBe(true);
    expect(isReadOnlyShellCommand("git status && ls -la")).toBe(true);
    expect(isReadOnlyShellCommand("FOO=1 git log")).toBe(true);

    // PowerShell read-only cmdlets
    expect(isReadOnlyShellCommand("Get-ChildItem -Path .")).toBe(true);
    expect(isReadOnlyShellCommand("Get-Content package.json")).toBe(true);
    expect(isReadOnlyShellCommand("Get-Location")).toBe(true);

    // Mutating commands
    expect(isReadOnlyShellCommand("echo 'hello' > file.txt")).toBe(false);
    expect(isReadOnlyShellCommand("echo 'hello' >> file.txt")).toBe(false);
    expect(isReadOnlyShellCommand("cat foo | tee out.txt")).toBe(false);
    expect(isReadOnlyShellCommand("rm -rf dist")).toBe(false);
    expect(isReadOnlyShellCommand("touch newfile.ts")).toBe(false);
    expect(isReadOnlyShellCommand("mkdir -p dir")).toBe(false);
    expect(isReadOnlyShellCommand("git checkout branch")).toBe(false);
    expect(isReadOnlyShellCommand("git commit -m 'fix'")).toBe(false);
    expect(isReadOnlyShellCommand("git reset --hard")).toBe(false);
    expect(isReadOnlyShellCommand("npm install")).toBe(false);
    expect(isReadOnlyShellCommand("git status && rm file.txt")).toBe(false);
    expect(isReadOnlyShellCommand("New-Item file.txt")).toBe(false);
    expect(isReadOnlyShellCommand("Remove-Item file.txt")).toBe(false);
  });

  it("preserves file read cache across read-only bash commands (git status, pwd, ls)", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: read src/index.ts
    session._emit({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", args: { path: "src/index.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: run git status (read-only bash inspection)
    session._emit({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", args: { command: "git status" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: re-reading src/index.ts must REMAIN BLOCKED (git status did not mutate workspace)
    const callRead = { toolCall: { id: "r2", name: "read", arguments: { path: "src/index.ts" } } };
    const res = await session.agent.beforeToolCall(callRead);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("preserves consecutive failure count across read-only bash commands to prevent loop evasion", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: npm test fails
    session._emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", args: { command: "npm test" }, isError: true });
    session._emit({ type: "turn_end" });

    // Turn 2: agent runs git status (read-only inspection, must NOT clear consecutiveFailures)
    session._emit({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", args: { command: "git status" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: npm test fails again (failure count becomes 2)
    session._emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", args: { command: "npm test" }, isError: true });
    session._emit({ type: "turn_end" });

    // Turn 4: 3rd attempt at npm test must be BLOCKED (evasion via git status foiled)
    const callTest = { toolCall: { id: "c3", name: "bash", arguments: { command: "npm test" } } };
    const res = await session.agent.beforeToolCall(callTest);
    expect(res?.block).toBe(true);
    expect(res?.reason).toMatch(/failed consecutively \(2 times\)/);
  });

  it("preserves grep cache on unaffected directories when a different file is modified", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: grep in docs directory and grep in src directory
    session._emit({ type: "tool_execution_end", toolCallId: "g1", toolName: "grep", args: { path: "docs", pattern: "api" }, isError: false });
    session._emit({ type: "tool_execution_end", toolCallId: "g2", toolName: "grep", args: { path: "src", pattern: "api" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: edit src/main.ts only
    session._emit({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", args: { path: "src/main.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: grep in docs must remain BLOCKED (docs was completely untouched by src/main.ts edit)
    const callGrepDocs = { toolCall: { id: "g3", name: "grep", arguments: { path: "docs", pattern: "api" } } };
    const resDocs = await session.agent.beforeToolCall(callGrepDocs);
    expect(resDocs?.block).toBe(true);
    expect(resDocs?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);

    // Turn 3: grep in src is ALLOWED because src/main.ts was modified
    const callGrepSrc = { toolCall: { id: "g4", name: "grep", arguments: { path: "src", pattern: "api" } } };
    const resSrc = await session.agent.beforeToolCall(callGrepSrc);
    expect(resSrc).toBeUndefined();
  });

  it("preserves find and ls directory listings across file content edits", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: find in src and ls in src
    session._emit({ type: "tool_execution_end", toolCallId: "f1", toolName: "find", args: { path: "src" }, isError: false });
    session._emit({ type: "tool_execution_end", toolCallId: "l1", toolName: "ls", args: { path: "src" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: edit src/main.ts (edit only modifies existing file lines, never alters directory structure)
    session._emit({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", args: { path: "src/main.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: find and ls in src must remain BLOCKED
    const callFind = { toolCall: { id: "f2", name: "find", arguments: { path: "src" } } };
    const resFind = await session.agent.beforeToolCall(callFind);
    expect(resFind?.block).toBe(true);
    expect(resFind?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);

    const callLs = { toolCall: { id: "l2", name: "ls", arguments: { path: "src" } } };
    const resLs = await session.agent.beforeToolCall(callLs);
    expect(resLs?.block).toBe(true);
    expect(resLs?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);

    // Turn 4: write creates a new file src/new.ts
    session._emit({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", args: { path: "src/new.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 5: find in src is now permitted because write altered directory structure
    const callFindAfterWrite = { toolCall: { id: "f3", name: "find", arguments: { path: "src" } } };
    const resFindAfterWrite = await session.agent.beforeToolCall(callFindAfterWrite);
    expect(resFindAfterWrite).toBeUndefined();
  });

  it("guards web_search and web_extract against duplicate and redundant executions", async () => {
    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: web search for docs
    const searchCall1 = { toolCall: { id: "ws1", name: "web_search", arguments: { query: "vitest coverage guide" } } };
    const resSearch1 = await session.agent.beforeToolCall(searchCall1);
    expect(resSearch1).toBeUndefined();

    // Duplicate search call in the SAME turn
    session._emit({ type: "tool_execution_start", toolCallId: "ws1", toolName: "web_search", args: { query: "vitest coverage guide" } });
    const searchDup = { toolCall: { id: "ws2", name: "web_search", arguments: { query: "vitest coverage guide" } } };
    const resDup = await session.agent.beforeToolCall(searchDup);
    expect(resDup?.block).toBe(true);
    expect(resDup?.reason).toMatch(/already executed in this turn/);

    // Complete search 1
    session._emit({ type: "tool_execution_end", toolCallId: "ws1", toolName: "web_search", args: { query: "vitest coverage guide" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: re-executing identical web search in next turn is blocked
    const searchCall2 = { toolCall: { id: "ws3", name: "web_search", arguments: { query: "vitest coverage guide" } } };
    const resSearch2 = await session.agent.beforeToolCall(searchCall2);
    expect(resSearch2?.block).toBe(true);
    expect(resSearch2?.reason).toMatch(/already executed in the preceding turn/);

    // Turn 2: edit a file
    session._emit({ type: "tool_execution_end", toolCallId: "e1", toolName: "edit", args: { path: "src/a.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: web search remains blocked (local file edits do not invalidate web searches)
    const resSearch3 = await session.agent.beforeToolCall(searchCall2);
    expect(resSearch3?.block).toBe(true);
    expect(resSearch3?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);
  });

  it("attaches terminate: true when hard-limited agent with zero tools calls a tool", async () => {
    const { session } = createStubSession();
    installSessionToolController(session, {
      isHardLimited: () => true,
      hardLimitAllowedTools: () => [],
    });

    const call = { toolCall: { id: "c1", name: "read", arguments: { path: "src/a.ts" } } };
    const res = await session.agent.beforeToolCall(call);
    expect(res?.block).toBe(true);
    expect(res?.terminate).toBe(true);
    expect(res?.reason).toMatch(/disabled by hard limit/);
  });

  it("accurately classifies mutating shell commands containing flags or find -delete", () => {
    // Flag parsing must not falsely classify mutating commands as read-only
    expect(isReadOnlyShellCommand("git commit -m fix -v")).toBe(false);
    expect(isReadOnlyShellCommand("git commit -m \"added --help button\"")).toBe(false);
    expect(isReadOnlyShellCommand("git push -v")).toBe(false);
    expect(isReadOnlyShellCommand("tar -czf out.tar.gz src -v")).toBe(false);
    expect(isReadOnlyShellCommand("python3 script.py -v")).toBe(false);
    expect(isReadOnlyShellCommand("npm test -v")).toBe(false);

    // Git subcommands that mutate repo or tree
    expect(isReadOnlyShellCommand("git branch -D feat")).toBe(false);
    expect(isReadOnlyShellCommand("git branch new-feature")).toBe(false);
    expect(isReadOnlyShellCommand("git tag v1.0")).toBe(false);
    expect(isReadOnlyShellCommand("git tag -d v1.0")).toBe(false);
    expect(isReadOnlyShellCommand("git remote add origin https://example.com")).toBe(false);
    expect(isReadOnlyShellCommand("git diff --output=out.patch")).toBe(false);
    expect(isReadOnlyShellCommand("git diff -o out.patch")).toBe(false);
    expect(isReadOnlyShellCommand("git log --output=out.log")).toBe(false);

    // find with -delete or -exec
    expect(isReadOnlyShellCommand("find . -name \"*.tmp\" -delete")).toBe(false);
    expect(isReadOnlyShellCommand("find . -exec rm {} +")).toBe(false);

    // Legitimate inspection commands remain read-only
    expect(isReadOnlyShellCommand("git status")).toBe(true);
    expect(isReadOnlyShellCommand("git diff")).toBe(true);
    expect(isReadOnlyShellCommand("git log -n 5")).toBe(true);
    expect(isReadOnlyShellCommand("git branch")).toBe(true);
    expect(isReadOnlyShellCommand("git branch -a")).toBe(true);
    expect(isReadOnlyShellCommand("git tag")).toBe(true);
    expect(isReadOnlyShellCommand("git tag -l")).toBe(true);
    expect(isReadOnlyShellCommand("git remote -v")).toBe(true);
    expect(isReadOnlyShellCommand("node -v")).toBe(true);
    expect(isReadOnlyShellCommand("node --version")).toBe(true);
    expect(isReadOnlyShellCommand("python3 --version")).toBe(true);
    expect(isReadOnlyShellCommand("python3 -V")).toBe(true);
  });

  it("handles root / and distinguishes external absolute from project relative paths in isSubpathOrEqual and loop guard", async () => {
    // Syntactic path hierarchy checks
    expect(isSubpathOrEqual("/tmp/foo", "/")).toBe(true);
    expect(isSubpathOrEqual("/", "/")).toBe(true);
    expect(isSubpathOrEqual("src/app.ts", "/")).toBe(false);
    expect(isSubpathOrEqual("src/app.ts", ".")).toBe(true);
    expect(isSubpathOrEqual("/tmp/foo", ".")).toBe(false);
    expect(isSubpathOrEqual("src/app.ts", "src")).toBe(true);
    expect(isSubpathOrEqual("docs/app.ts", "src")).toBe(false);

    const { session } = createStubSession();
    installSessionToolController(session);

    // Turn 1: grep in project root .
    session._emit({ type: "tool_execution_end", toolCallId: "g1", toolName: "grep", args: { path: ".", pattern: "TODO" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 2: write to an external absolute path (/tmp/external.log)
    session._emit({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", args: { path: "/tmp/external.log" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 3: grep in project root . must remain BLOCKED (external /tmp file did not mutate project .)
    const callGrepProj = { toolCall: { id: "g2", name: "grep", arguments: { path: ".", pattern: "TODO" } } };
    const resGrepProj = await session.agent.beforeToolCall(callGrepProj);
    expect(resGrepProj?.block).toBe(true);
    expect(resGrepProj?.reason).toMatch(/already executed in turn 1 with no intervening modifications/);

    // Turn 3: write to internal project file (src/new.ts)
    session._emit({ type: "tool_execution_end", toolCallId: "w2", toolName: "write", args: { path: "src/new.ts" }, isError: false });
    session._emit({ type: "turn_end" });

    // Turn 4: grep in project root . is now ALLOWED
    const resGrepAllowed = await session.agent.beforeToolCall(callGrepProj);
    expect(resGrepAllowed).toBeUndefined();
  });
});
