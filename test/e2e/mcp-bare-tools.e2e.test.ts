/**
 * mcp-bare-tools.e2e.test.ts — #370 end to end: an agent whose `tools:` names an
 * MCP tool as Claude Code does (`mcp__<server>__<tool>`) calls it through pi's real
 * built-in MCP extension, with no adapter.
 *
 * Real pieces: the extension in print mode, a child session built by `runAgent`,
 * pi's MCP extension reading `mcp.json` from the agent dir, and a stdio MCP server
 * (`fixtures/e2e-mcp-stdio-server.mjs`) that serves `echo` and `secret`. The model
 * is faux. The server's answer proves a real tool call; `secret` must be refused
 * when the agent named only `echo`. Workflows are pinned off in project settings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, agentToolResults, type PrintModeRun, routeBySession, runPrintMode } from "../helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const SERVER = resolve(fileURLToPath(new URL("../fixtures/e2e-mcp-stdio-server.mjs", import.meta.url)));

/** The text of every tool result in the child's context, by tool name. */
function toolResult(context: Context, toolName: string): string | undefined {
  const msg = context.messages.find(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === toolName,
  );
  return msg ? ((msg.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("") : undefined;
}

describe("bare mcp__ entries in tools: (real pi MCP, stdio server, faux model)", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  /** Spawn an agent with `tools`; it calls `secret`, then `echo`, and reports both results. */
  async function reportFor(tools: string): Promise<string> {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mcp-e2e-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: false }));
    writeFileSync(
      join(cwd, ".pi", "agents", "mcp-test.md"),
      `---\ndescription: Calls an MCP tool.\ntools: ${tools}\n---\nCall the MCP tool.\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to mcp-test.",
      cwd,
      live: false,
      beforeRun: () => {
        const agentDir = process.env.PI_CODING_AGENT_DIR as string;
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(
          join(agentDir, "mcp.json"),
          JSON.stringify({
            mcpServers: { fixture: { command: process.execPath, args: [SERVER], exposure: "direct" } },
          }),
        );
      },
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "mcp-test",
          description: "mcp",
          prompt: "Call the MCP tool.",
          run_in_background: false,
        }),
        parentFinal: "Reported.",
        subagent: (ctx: Context) => {
          const secret = toolResult(ctx, "mcp__fixture__secret");
          if (secret === undefined) return fauxToolCall("mcp__fixture__secret", {});
          const echo = toolResult(ctx, "mcp__fixture__echo");
          if (echo === undefined) return fauxToolCall("mcp__fixture__echo", { text: "hello" });
          return `SECRET=[${secret}] ECHO=[${echo}]`;
        },
      }),
    });

    return agentToolResults(run.parentSession)[0] ?? "";
  }

  it("calls the named MCP tool and is refused the server's other tool", async () => {
    const report = await reportFor("mcp__fixture__echo");
    expect(report).toContain("ECHO=[echo: hello]"); // answered by the real server
    expect(report).not.toContain("secret: called"); // never reached the server
  });

  it("a server-level mcp__<server> entry reaches every tool of that server", async () => {
    const report = await reportFor("mcp__fixture");
    expect(report).toContain("ECHO=[echo: hello]");
    expect(report).toContain("SECRET=[secret: called]");
  });
});
