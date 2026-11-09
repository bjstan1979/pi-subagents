import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { ctx, flush, makePi } from "./helpers/boot-extension.js";

describe("stored-session reservation", () => {
  let dir: string;
  let file: string;
  let alias: string;
  let manager: AgentManager;
  const pi = makePi().pi;
  let finish: (result: any) => void;
  const result = { responseText: "done", session: undefined, aborted: false, steered: false };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-reservation-"));
    file = join(dir, "child.jsonl");
    alias = join(dir, "alias.jsonl");
    writeFileSync(file, "");
    symlinkSync(file, alias);
    manager = new AgentManager();
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  });

  afterEach(async () => {
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds a canonical path while running and releases after failure", async () => {
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("startup failed"));
    const id = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: file });
    expect(() => manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: alias })).toThrow("already being reopened");
    await manager.awaitStartup(id);
    await flush();
    const retry = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: alias });
    await manager.awaitStartup(retry);
    finish(result);
    await flush();
  });

  it("releases the reservation when startup throws before runAgent", async () => {
    await manager.dispose();
    let fails = true;
    manager = new AgentManager(undefined, 10, () => { if (fails) throw new Error("start failed"); });
    const id = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: file });
    await expect(manager.awaitStartup(id)).rejects.toThrow("start failed");
    fails = false;
    const retry = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: file });
    await manager.awaitStartup(retry);
    finish(result);
    await flush();
  });

  it("keeps the reservation if an onSpawned callback throws after the writer starts", async () => {
    const id = manager.spawn(pi, ctx(), "Explore", "go", {
      isBackground: true, resumeSessionFile: file, onSpawned: () => { throw new Error("observer failed"); },
    });
    await expect(manager.awaitStartup(id)).rejects.toThrow("observer failed");
    expect(manager.getRecord(id)).toBeDefined();
    expect(() => manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: alias })).toThrow("already being reopened");
    finish(result);
    await flush();
    const retry = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: file });
    await manager.awaitStartup(retry);
    finish(result);
    await flush();
  });

  it.each(["abort", "abortAll"])("holds a queued reopen and releases it on %s", async (mode) => {
    manager.setMaxConcurrent(1);
    const active = manager.spawn(pi, ctx(), "Explore", "occupy", { isBackground: true });
    await manager.awaitStartup(active);
    const queued = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: file });
    expect(manager.getRecord(queued)?.status).toBe("queued");
    expect(() => manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: alias })).toThrow("already being reopened");
    if (mode === "abort") expect(manager.abort(queued)).toBe(true);
    else expect(manager.abortAll()).toBeGreaterThan(0);
    const retry = manager.spawn(pi, ctx(), "Explore", "go", { isBackground: true, resumeSessionFile: alias });
    if (mode === "abort") expect(manager.getRecord(retry)?.status).toBe("queued");
    manager.abort(retry);
    finish(result);
    await flush();
  });
});
