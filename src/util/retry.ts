/**
 * Retry with exponential backoff + jitter — loop resilience for transient failures.
 *
 * Used to wrap provider calls in `runAgent`: a flaky 429/5xx/network blip retries
 * instead of killing the run. Non-transient errors (4xx other than 429, bad input)
 * propagate immediately so real bugs surface fast.
 */

/** Heuristic: is this error worth retrying? (rate limits, 5xx, network resets, timeouts) */
export function isTransientError(err: unknown): boolean {
  const s = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /\b(429|500|502|503|504)\b/.test(s) ||
    s.includes("timeout") ||
    s.includes("etimedout") ||
    s.includes("econnreset") ||
    s.includes("econnrefused") ||
    s.includes("enotfound") ||
    s.includes("fetch failed") ||
    s.includes("socket hang up") ||
    s.includes("rate limit") ||
    s.includes("overloaded") ||
    s.includes("temporarily unavailable")
  );
}

export interface RetryOpts {
  /** Max retry attempts after the first try (default 3). */
  retries?: number;
  /** Base backoff in ms; doubles each attempt (default 500). */
  baseMs?: number;
  /** Backoff cap in ms (default 8000). */
  maxMs?: number;
  /** Override which errors are retried. */
  isTransient?: (err: unknown) => boolean;
  /** Called before each backoff sleep (for logging/instrumentation). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void | Promise<void>;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient failures with exponential backoff + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const isTransient = opts.isTransient ?? isTransientError;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isTransient(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.round(backoff / 2 + Math.random() * (backoff / 2)); // full→half jitter
      await opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
