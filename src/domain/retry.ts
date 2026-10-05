import { toToolError, type ToolError } from "./errors";
import type { RandomSource, Sleeper } from "./runtime";

/**
 * Adapter-owned retry (§14): exponential backoff with full jitter.
 *
 * Generation submission MUST NOT use this helper: a generation request is only
 * ever sent once, because the SDK cannot tell the adapter whether Higgsfield
 * accepted an ambiguous submission. It is used for read-only or idempotent
 * operations: status, discovery, uploads, and result downloads.
 */

export interface RetryPolicy {
  /** Additional attempts after the first one. */
  count: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface RetryDependencies {
  sleeper: Sleeper;
  random: RandomSource;
}

/** Capped exponential delay, then full jitter in [0, capped]. */
export function retryDelayMs(policy: RetryPolicy, attempt: number, random: RandomSource): number {
  const capped = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** attempt);
  return Math.floor(capped * random.next());
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  dependencies: RetryDependencies,
  isRetryable: (error: ToolError) => boolean,
): Promise<T> {
  let lastError: ToolError | undefined;

  for (let attempt = 0; attempt <= policy.count; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const toolError = toToolError(error);
      lastError = toolError;
      if (attempt === policy.count || !isRetryable(toolError)) throw toolError;
      await dependencies.sleeper.sleep(retryDelayMs(policy, attempt, dependencies.random));
    }
  }

  throw lastError ?? new Error("Retry loop exhausted without an error to report.");
}
