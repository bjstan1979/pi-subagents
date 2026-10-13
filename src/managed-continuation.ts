/** Explicit capability contract shared with callback producers. No SDK interception. */
export interface ManagedLeaseV1 { release(reason: string): void }
export type AdmissionOutcomeV1 = { status: "accepted" | "duplicate" } | { status: "rejected"; reason: string };
export type CompletionOutcomeV1 = { status: "completed" } | { status: "failed"; error: string } | { status: "cancelled" | "rejected"; reason: string };
export interface ManagedInputV1 {
  deliveryIds: readonly string[];
  message: { customType: string; content: string; display: boolean };
  options: Record<string, unknown>;
  leases: readonly ManagedLeaseV1[];
}
export interface ManagedReceiptV1 {
  acceptedPromise: Promise<AdmissionOutcomeV1>;
  completedPromise: Promise<CompletionOutcomeV1>;
}
export interface ManagedContinuationEndpointV1 {
  readonly version: 1;
  readonly closed: boolean;
  acquire(source: string, operationId: string): ManagedLeaseV1;
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
  constructor(
    private ready: () => boolean,
    private execute: (input: ManagedInputV1) => Promise<CompletionOutcomeV1>,
    private changed: () => void,
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
    this.executing = true;
    // execute reserves queue state synchronously before any callback can race resume.
    void this.execute(next.input).then(next.complete, error => next.complete({ status: "failed", error: String(error) })).finally(() => {
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
    for (const item of this.pending.splice(0)) item.complete({ status: "cancelled", reason: "Managed child endpoint closed" });
    changed();
  }
}
