import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Hard account/model exhaustion, not a transient 429 or generic provider error. */
export function isQuotaExhausted(message: string): boolean {
  return /(?:insufficient_quota|quota[_\s-]*(?:exceeded|exhausted)|(?:usage|credit|spending|billing)[_\s-]*limit[_\s-]*(?:exceeded|reached)|(?:quota|credits?|balance)\s+(?:(?:is|has been)\s+)?(?:exhausted|depleted|insufficient)|insufficient\s+(?:credits?|balance)|you(?:'ve| have)\s+(?:hit|reached)\s+your\s+usage\s+limit|配额.{0,12}(?:耗尽|用完|不足)|余额不足)/i.test(message);
}

export interface ResumeModelOptions {
  /** Explicit override for this child only. */
  model?: Model<any>;
  /** Parent model captured at the current resume call, never at initial spawn. */
  fallbackModel?: Model<any>;
  signal?: AbortSignal;
  onModelChange?: (model: Model<any>, reason: "explicit" | "quota") => void;
}

function lastProviderError(session: AgentSession, startIndex: number): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const message = session.messages[i];
    if (message.role === "assistant") return message.stopReason === "error" ? message.errorMessage : undefined;
  }
  return undefined;
}

/** Keep the current runner's subscriptions, abort controller and turn budget. */
export async function promptWithResumeFallback(
  session: AgentSession,
  execute: () => Promise<void>,
  options: ResumeModelOptions,
  canContinue: () => boolean,
): Promise<void> {
  const different = (model: Model<any>) => model.provider !== session.model?.provider || model.id !== session.model?.id;
  const switchTo = async (model: Model<any>, reason: "explicit" | "quota") => {
    await session.setModel(model);
    options.onModelChange?.(model, reason);
  };
  if (options.signal?.aborted || !canContinue()) return;
  if (options.model && different(options.model)) await switchTo(options.model, "explicit");
  const fallback = options.fallbackModel;
  let switched = false;
  const switchForQuota = async (error: string | undefined): Promise<boolean> => {
    if (switched || !fallback || !different(fallback) || options.signal?.aborted || !canContinue()
      || !error || !isQuotaExhausted(error)) return false;
    // Latch BEFORE auth/model selection so a failed switch cannot recurse.
    switched = true;
    await switchTo(fallback, "quota");
    return true;
  };
  // Avoid knowingly retrying the exhausted model from the preceding run.
  const previousError = !options.model && fallback && different(fallback) ? lastProviderError(session, 0) : undefined;
  if (previousError && isQuotaExhausted(previousError)) await switchForQuota(previousError);
  if (options.signal?.aborted || !canContinue()) return;
  const startIndex = session.messages.length;
  let failure: string | undefined;
  try {
    await execute();
    failure = lastProviderError(session, startIndex);
  } catch (error) {
    if (!(await switchForQuota(error instanceof Error ? error.message : String(error)))) throw error;
    if (options.signal?.aborted || !canContinue()) return;
    await session.prompt("Continue the existing task from the saved conversation after the provider quota failure. Do not repeat completed tool actions; inspect their recorded results and continue only unfinished work.");
    return;
  }
  if (await switchForQuota(failure)) {
    if (options.signal?.aborted || !canContinue()) return;
    await session.prompt("Continue the existing task from the saved conversation after the provider quota failure. Do not repeat completed tool actions; inspect their recorded results and continue only unfinished work.");
  }
}
