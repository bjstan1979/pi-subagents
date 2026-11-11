/** Recheck immediately before execution, including after pool reservation. */
export function refreshTerminalInput(input: ManagedInputV1): boolean {
  const parts = input.terminalParts;
  if (!parts || parts.length !== input.deliveryIds.length || parts.some((part, i) => part.deliveryId !== input.deliveryIds[i])) return true;
  const remaining = parts.filter(part => { try { return !part.observed(); } catch { return true; } });
  if (!remaining.length) return false;
  input.message = { ...input.message, content: remaining.map(part => part.message.content).join("\n\n") };
  return true;
}

/** Explicit capability contract shared with callback producers. No SDK interception. */
export interface ManagedLeaseV1 { release(reason: string): void }
export type AdmissionOutcomeV1 = { status: "accepted" | "duplicate" } | { status: "rejected"; reason: string };
export type CompletionOutcomeV1 = { status: "completed" } | { status: "failed"; error: string } | { status: "cancelled" | "rejected"; reason: string };
export interface ManagedInputV1 {
  deliveryIds: readonly string[];
  message: { customType: string; content: string; display: boolean };
  options: Record<string, unknown>;
  leases: readonly ManagedLeaseV1[];
  /** Optional trusted producer parts. Never derived from model message text. */
  terminalParts?: readonly { deliveryId: string; message: ManagedInputV1["message"]; observed: () => boolean }[];
}
export interface ManagedReceiptV1 {
  acceptedPromise: Promise<AdmissionOutcomeV1>;
  completedPromise: Promise<CompletionOutcomeV1>;
}
export interface ManagedContinuationEndpointV1 {
  readonly version: 1;
  readonly closed: boolean;
  acquire(source: string, operationId: string): ManagedLeaseV1;
  readonly terminalObservationV1?: {
    scope(): object;
    record(fact: object, scope: object): void;
    has(fact: object, scope: object): boolean;
  };
  admit(input: ManagedInputV1): ManagedReceiptV1;
}
const KEY = Symbol.for("pi.managed-continuation.registry.v1");
export function managedRegistry(): { version: 1; endpoints: WeakMap<object, ManagedContinuationEndpointV1> } {
  const root = globalThis as unknown as Record<symbol, unknown>;
  if (root[KEY] === undefined) root[KEY] = { version: 1, endpoints: new WeakMap() };
  const value = root[KEY] as { version?: unknown; endpoints?: unknown } | null;
  if (!value || value.version !== 1 || !(value.endpoints instanceof WeakMap)) throw new Error("Incompatible managed continuation registry");
  return value as { version: 1; endpoints: WeakMap<object, ManagedContinuationEndpointV1> };
}

/** One endpoint per child lifetime. Closing is permanent, including registry tombstones. */
export class ManagedEndpoint implements ManagedContinuationEndpointV1 {
  readonly version = 1;
  closed = false;
  private leases = new Set<ManagedLeaseV1>();
  private deliveries = new Map<string, ManagedReceiptV1>();
  private pending: { input: ManagedInputV1; complete: (outcome: CompletionOutcomeV1) => void }[] = [];
  private executing = false;
  private observationScope = {};
  private observationEpoch: unknown;
  private observations = new WeakSet<object>();
  readonly terminalObservationV1 = {
    scope: (): object => {
      const epoch = this.executionIdentity();
      if (epoch !== this.observationEpoch) {
        this.observationEpoch = epoch;
        this.observationScope = {};
        this.observations = new WeakSet();
      }
      return this.observationScope;
    },
    record: (fact: object, scope: object): void => {
      if (!this.closed && this.terminalObservationV1.scope() === scope) this.observations.add(fact);
    },
    has: (fact: object, scope: object): boolean => !this.closed && this.terminalObservationV1.scope() === scope && this.observations.has(fact),
  };
  constructor(
    private ready: () => boolean,
    private execute: (input: ManagedInputV1) => Promise<CompletionOutcomeV1>,
    private changed: () => void,
    private executionIdentity: () => unknown = () => undefined,
  ) {}
  get retained(): boolean { return this.leases.size > 0 || this.pending.length > 0 || this.executing; }
  acquire(_source: string, _operationId: string): ManagedLeaseV1 {
    if (this.closed) throw new Error("Managed child endpoint is closed");
    const lease = { release: (_reason: string) => { if (this.leases.delete(lease)) this.changed(); } };
    this.leases.add(lease);
    return lease;
  }
  admit(input: ManagedInputV1): ManagedReceiptV1 {
    const reject = (reason: string): ManagedReceiptV1 => ({
      acceptedPromise: Promise.resolve({ status: "rejected", reason }),
      completedPromise: Promise.resolve({ status: "rejected", reason }),
    });
    if (this.closed) return reject("Managed child endpoint is closed");
    if (!input.deliveryIds.length || input.deliveryIds.some(id => !id) || !input.leases.length || input.leases.some(lease => !this.leases.has(lease))) return reject("Invalid delivery identity or lease ownership");
    const prior = input.deliveryIds.map(id => this.deliveries.get(id));
    if (prior.some(Boolean)) {
      const receipt = prior[0];
      if (!receipt || prior.some(value => value !== receipt)) return reject("Overlapping delivery batch");
      return { acceptedPromise: Promise.resolve({ status: "duplicate" }), completedPromise: receipt.completedPromise };
    }
    if (input.options.triggerTurn !== true || (input.options.deliverAs !== undefined && !["steer", "followUp"].includes(String(input.options.deliverAs)))) return reject("Managed callbacks require a triggering custom message");
    let complete!: (outcome: CompletionOutcomeV1) => void;
    const receipt: ManagedReceiptV1 = {
      acceptedPromise: Promise.resolve({ status: "accepted" }),
      completedPromise: new Promise(resolve => { complete = resolve; }),
    };
    for (const id of input.deliveryIds) this.deliveries.set(id, receipt);
    this.pending.push({ input: { ...input, deliveryIds: [...input.deliveryIds], message: { ...input.message }, options: { ...input.options }, leases: [...input.leases] }, complete });
    this.pump();
    return receipt;
  }
  pump(): void {
    if (this.closed || this.executing || !this.ready()) return;
    const next = this.pending.shift();
    if (!next) return;
    if (!refreshTerminalInput(next.input)) {
      next.complete({ status: "completed" });
      this.changed();
      this.pump();
      return;
    }
    const completions = [next.complete];
    // Only waiting deliveries can share execution. Preserve incompatible boundaries,
    // message order and every admission's independent stable-ID receipt.
    while (this.pending.length) {
      const candidate = this.pending[0];
      if (!refreshTerminalInput(candidate.input)) {
        this.pending.shift();
        candidate.complete({ status: "completed" });
        continue;
      }
      if (candidate.input.message.customType !== next.input.message.customType || candidate.input.message.display !== next.input.message.display) break;
      const options = next.input.options;
      const candidateOptions = candidate.input.options;
      const keys = Object.keys(options);
      if (keys.length !== Object.keys(candidateOptions).length || keys.some(key => !Object.hasOwn(candidateOptions, key) || !Object.is(options[key], candidateOptions[key]))) break;
      const content = `${next.input.message.content}\n\n${candidate.input.message.content}`;
      if (Buffer.byteLength(content, "utf8") > 8192) break;
      this.pending.shift();
      if (next.input.terminalParts || candidate.input.terminalParts) {
        const parts = (input: ManagedInputV1) => input.terminalParts ?? input.deliveryIds.map(deliveryId => ({ deliveryId, message: input.message, observed: () => false }));
        next.input.terminalParts = [...parts(next.input), ...parts(candidate.input)];
      }
      next.input.message.content = content;
      next.input.deliveryIds = [...next.input.deliveryIds, ...candidate.input.deliveryIds];
      next.input.leases = [...next.input.leases, ...candidate.input.leases];
      completions.push(candidate.complete);
    }
    const complete = (outcome: CompletionOutcomeV1) => { for (const completion of completions) completion(outcome); };
    this.executing = true;
    // execute reserves queue state synchronously before any callback can race resume.
    void this.execute(next.input).then(complete, error => complete({ status: "failed", error: String(error) })).finally(() => {
      this.executing = false;
      this.changed();
      this.pump();
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Tombstones must not retain a manager, record, or full session through closures.
    const changed = this.changed;
    this.ready = () => false;
    this.execute = async () => ({ status: "rejected", reason: "Closed endpoint" });
    this.changed = () => {};
    this.leases.clear();
    this.observations = new WeakSet();
    this.executionIdentity = () => undefined;
    for (const item of this.pending.splice(0)) item.complete({ status: "cancelled", reason: "Managed child endpoint closed" });
    changed();
  }
}
