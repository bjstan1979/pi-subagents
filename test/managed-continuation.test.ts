import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { GroupJoinManager } from "../src/group-join.js";
import { type ManagedContinuationEndpointV1, managedRegistry } from "../src/managed-continuation.js";
import { cleanupWorktree, createWorktree, setWorktreeIsolationEnabled } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({ createWorktree: vi.fn(), cleanupWorktree: vi.fn(), pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true, setWorktreeIsolationEnabled: vi.fn() }));
const managers: AgentManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); vi.clearAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function session() { return { sessionManager: { getCwd: () => "/tmp", getSessionFile: () => undefined }, messages: [], dispose: vi.fn(), sendCustomMessage: vi.fn(async () => {}) }; }
function input(endpoint: ManagedContinuationEndpointV1, id = "background-task:1:terminal") {
  return { deliveryIds: [id], message: { customType: "background-task", content: "terminal", display: true }, options: { triggerTurn: true, deliverAs: "steer" }, leases: [endpoint.acquire("bg-task", id)] };
}
async function spawn(manager: AgentManager) {
  const child = session();
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
    options?.onSessionReady?.(child as never, { maxTurns: 3, hardLimit: true });
    options?.onSessionCreated?.(child as never);
    return { responseText: "INITIAL_FINAL", session: child, aborted: false, steered: false } as never;
  });
  const id = manager.spawn({} as never, { cwd: "/tmp" } as never, "X", "initial", { description: "child", isBackground: true });
  await manager.getRecord(id)?.promise;
  return { id, child, record: manager.getRecord(id)!, endpoint: managedRegistry().endpoints.get(child.sessionManager)! };
}
describe("managed callbacks", () => {
  it("rejects nextTurn without false completion; idle followUp executes under ownership", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { endpoint, child } = await spawn(manager);
    const delivery = input(endpoint);
    expect(await endpoint.admit({ ...delivery, options: { triggerTurn: true, deliverAs: "nextTurn" } }).completedPromise).toMatchObject({ status: "rejected" });
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session, _prompt, options) => { await options.execute?.(); return { text: "followup" }; });
    expect(await endpoint.admit({ ...delivery, options: { triggerTurn: true, deliverAs: "followUp" } }).completedPromise).toEqual({ status: "completed" });
    delivery.leases[0].release("done");
  });
  it("nonidle SDK cannot falsely complete a deferred custom send", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { endpoint, child } = await spawn(manager);
    Object.assign(child, { isIdle: false });
    const delivery = input(endpoint);
    expect(await endpoint.admit(delivery).completedPromise).toMatchObject({ status: "failed", error: "Managed child session is not idle" });
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    delivery.leases[0].release("done");
  });
  it("stop refuses resume until rejection settles; stale rejection never overwrites and frees pool", async () => {
    const manager = new AgentManager(undefined, 1); managers.push(manager);
    const { id, endpoint, record } = await spawn(manager);
    let reject!: (error: Error) => void;
    vi.mocked(resumeAgent).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r; }));
    const delivery = input(endpoint);
    const receipt = endpoint.admit(delivery);
    manager.abort(id);
    expect(await manager.resume(id, "too early")).toBeUndefined();
    record.executionEpoch!++; record.result = "new epoch result";
    reject(new Error("old failure"));
    expect(await receipt.completedPromise).toMatchObject({ status: "cancelled" });
    expect(record.result).toBe("new epoch result"); expect(record.error).not.toBe("old failure");
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "after settlement" });
    expect(await manager.resume(id, "now safe")).toBeDefined();
    delivery.leases[0].release("done");
  });
  it("removed execution-ownership control admits stop/resume collision; stale success still cannot publish", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { id, endpoint, record } = await spawn(manager);
    const old = deferred<{ text: string }>();
    vi.mocked(resumeAgent).mockReturnValueOnce(old.promise);
    const delivery = input(endpoint); const receipt = endpoint.admit(delivery);
    manager.abort(id);
    expect(await manager.resume(id, "guard present")).toBeUndefined();
    (manager as unknown as { activeExecutions: Set<string> }).activeExecutions.delete(id);
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "new result" });
    expect(await manager.resume(id, "removed guard control")).toBeDefined();
    old.resolve({ text: "old result" });
    expect(await receipt.completedPromise).toMatchObject({ status: "cancelled" });
    expect(record.result).toBe("new result");
    delivery.leases[0].release("done");
  });
  it("pool1 waitForAll awaits queued publication and allows timer-driven holder to settle", async () => {
    const manager = new AgentManager(undefined, 1); managers.push(manager);
    const { endpoint, record } = await spawn(manager);
    const oldPromise = record.promise;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ responseText: "holder", session: session() } as never), 10)));
    manager.spawn({} as never, { cwd: "/tmp" } as never, "X", "hold", { description: "holder", isBackground: true });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "queued final" });
    const delivery = input(endpoint); const receipt = endpoint.admit(delivery);
    expect(record.promise).not.toBe(oldPromise);
    await manager.waitForAll();
    expect(record.resultRevision).toBe(2); expect(await record.promise).toBe("queued final");
    expect(await receipt.completedPromise).toEqual({ status: "completed" });
    delivery.leases[0].release("done");
  });
  it("group holds immutable revision1 while autonomous revision2 remains separate", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { record } = await spawn(manager);
    const delivered: unknown[] = [];
    const group = new GroupJoinManager(records => delivered.push(records.map(r => [r.id, r.result, r.resultRevision])));
    group.registerGroup("g", [record.id, "B"]);
    expect(group.onAgentComplete(record)).toBe("held");
    record.result = "CALLBACK_FINAL"; record.resultRevision = 2; record.status = "running";
    group.onAgentComplete({ ...record, id: "B", result: "B initial", resultRevision: 1 });
    expect(delivered).toEqual([[[record.id, "INITIAL_FINAL", 1], ["B", "B initial", 1]]]);
    group.dispose();
  });
  it.each(["clear", "preserved-session-boundary", "timer"])("paused cleanup never publishes orphaned prior-parent result after %s", async boundary => {
    vi.mocked(createWorktree).mockResolvedValueOnce({ path: "/tmp/tree", workPath: "/tmp/tree", branch: "callback", baseSha: "base" });
    const paused = deferred<never>();
    vi.mocked(cleanupWorktree).mockReturnValueOnce(paused.promise);
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete); managers.push(manager);
    const child = session(); let lease!: ReturnType<ManagedContinuationEndpointV1["acquire"]>;
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options?.onSessionReady?.(child as never, { hardLimit: false });
      lease = managedRegistry().endpoints.get(child.sessionManager)!.acquire("bg", "cleanup-boundary");
      options?.onSessionCreated?.(child as never);
      return { responseText: "initial", session: child } as never;
    });
    const id = manager.spawn({} as never, { cwd: "/tmp" } as never, "X", "initial", { description: "boundary", isolation: "worktree", isBackground: true });
    await manager.awaitStartup(id); await manager.getRecord(id)?.promise;
    expect(onComplete).toHaveBeenCalledTimes(1);
    lease.release("done");
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    if (boundary === "timer") {
      manager.getRecord(id)!.completedAt = 0;
      (manager as unknown as { cleanup(): void }).cleanup();
    } else manager.clearCompleted(boundary === "preserved-session-boundary");
    if (boundary === "preserved-session-boundary") expect(manager.getRecord(id)).toBeDefined();
    else expect(manager.getRecord(id)).toBeUndefined();
    paused.resolve({ hasChanges: true, branch: "orphan-branch" } as never);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((manager as unknown as { cleanupPromises: Map<string, unknown> }).cleanupPromises.size).toBe(0);
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });
  it("callback during initial finalization waits for revision1 publication, preserves worktree through leases, and cleans exactly once", async () => {
    setWorktreeIsolationEnabled(true);
    vi.mocked(createWorktree).mockResolvedValueOnce({ path: "/tmp/tree", workPath: "/tmp/tree", branch: "callback", baseSha: "base" });
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "saved-callback" } as never);
    const published: number[] = [];
    const manager = new AgentManager(record => { published.push(record.resultRevision!); }); managers.push(manager);
    const child = session();
    let delivery!: ReturnType<typeof input>;
    let receipt!: ReturnType<ManagedContinuationEndpointV1["admit"]>;
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options?.onSessionReady?.(child as never, { maxTurns: 2, hardLimit: false });
      const endpoint = managedRegistry().endpoints.get(child.sessionManager)!;
      delivery = input(endpoint);
      receipt = endpoint.admit(delivery);
      expect(resumeAgent).not.toHaveBeenCalled();
      options?.onSessionCreated?.(child as never);
      return { responseText: "INITIAL_FINAL", session: child } as never;
    });
    const callback = deferred<{ text: string }>();
    vi.mocked(resumeAgent).mockReturnValueOnce(callback.promise);
    let initialPromise: Promise<string> | undefined;
    const id = manager.spawn({} as never, { cwd: "/tmp" } as never, "X", "initial", { description: "tree", isolation: "worktree", isBackground: true, onSpawned: childId => { initialPromise = manager.getRecord(childId)?.promise; } });
    await manager.awaitStartup(id);
    await initialPromise;
    expect(published).toEqual([1]); expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)?.result).toBe("INITIAL_FINAL");
    callback.resolve({ text: "CALLBACK_FINAL" });
    await receipt.completedPromise;
    expect(published).toEqual([1, 2]); expect(cleanupWorktree).not.toHaveBeenCalled();
    delivery.leases[0].release("complete");
    await Promise.resolve(); await Promise.resolve();
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(published).toEqual([1, 2, 3]);
    expect(manager.getRecord(id)?.result).toContain("saved-callback");
    expect(manager.getRecord(id)?.autonomousRevision).toBe(true);
    delivery.leases[0].release("duplicate release");
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
  });
  it("charges the saturated background pool before custom execution, keeps prior result, rejects resume collision and deduplicates stable IDs", async () => {
    const manager = new AgentManager(undefined, 1); managers.push(manager);
    const { id, child, record, endpoint } = await spawn(manager);
    const holder = deferred<never>();
    vi.mocked(runAgent).mockReturnValueOnce(holder.promise);
    const holderId = manager.spawn({} as never, { cwd: "/tmp" } as never, "X", "hold", { description: "holder", isBackground: true });
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session, _prompt, options) => { await options.execute?.(); return { text: "CALLBACK_FINAL" }; });
    record.resultConsumed = true; record.consumedRevision = 1;
    const delivery = input(endpoint);
    const receipt = endpoint.admit(delivery);
    expect(await receipt.acceptedPromise).toEqual({ status: "accepted" });
    expect(record.status).toBe("queued"); expect(record.result).toBe("INITIAL_FINAL");
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
    expect(await manager.resume(id, "collision")).toBeUndefined();
    expect(await endpoint.admit(delivery).acceptedPromise).toEqual({ status: "duplicate" });
    holder.resolve({ responseText: "holder", session: session(), aborted: false } as never);
    await manager.getRecord(holderId)?.promise;
    expect(await receipt.completedPromise).toEqual({ status: "completed" });
    expect(record.result).toBe("CALLBACK_FINAL"); expect(record.resultRevision).toBe(2);
    expect(record.consumedRevision).toBe(1); expect(record.resultConsumed).toBe(false);
    expect(child.sendCustomMessage).toHaveBeenCalledExactlyOnceWith(delivery.message, delivery.options);
    expect(vi.mocked(resumeAgent).mock.calls[0][2]).toMatchObject({ maxTurns: 3, hardLimit: true });
    delivery.leases[0].release("completed");
  });
  it("retains GC only while leased; removed-lease control evicts and leaves a closed tombstone", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { id, endpoint, child } = await spawn(manager);
    const lease = endpoint.acquire("bg-task", "pending");
    manager.clearCompleted(); expect(manager.getRecord(id)).toBeDefined();
    lease.release("control remove lease"); manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
    expect(managedRegistry().endpoints.get(child.sessionManager)?.closed).toBe(true);
    expect(() => endpoint.acquire("bg-task", "late")).toThrow(/closed/);
    expect(await endpoint.admit({ ...inputForClosed(), leases: [lease] }).acceptedPromise).toMatchObject({ status: "rejected" });
  });
  it("stop closes a settled endpoint before late callback and never falls back", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { id, child, endpoint } = await spawn(manager);
    const delivery = input(endpoint);
    expect(manager.abort(id)).toBe(true);
    expect(await endpoint.admit(delivery).completedPromise).toMatchObject({ status: "rejected" });
    expect(child.sendCustomMessage).not.toHaveBeenCalled();
  });
  it("resolved provider failures are failed completion outcomes, not accepted success", async () => {
    const manager = new AgentManager(); managers.push(manager);
    const { endpoint, record } = await spawn(manager);
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "", failure: "provider error" });
    const delivery = input(endpoint);
    expect(await endpoint.admit(delivery).completedPromise).toEqual({ status: "failed", error: "provider error" });
    expect(record.status).toBe("error"); delivery.leases[0].release("failed");
  });
});
function inputForClosed() { return { deliveryIds: ["late"], message: { customType: "background-task", content: "late", display: true }, options: { triggerTurn: true } }; }
