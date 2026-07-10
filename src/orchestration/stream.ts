/**
 * Streaming plumbing for the loop (ADR-0005).
 *
 * `consumeStream` drains a provider's `chatStream` generator, forwarding each delta
 * to an observer, and resolves with the generator's RETURN value — the same
 * normalized ChatTurn `chat()` would produce. The loop stays shape-identical
 * whether it streamed or not.
 */

import type { ChatTurn, StreamDelta } from "../providers/base.js";

/** Thrown when the caller aborts mid-stream (ESC in the chat REPL). Deliberately
 *  NOT transient (`withRetry` must never replay an interrupted turn). */
export class StreamInterrupted extends Error {
  constructor() {
    super("stream interrupted by caller");
    this.name = "StreamInterrupted";
  }
}

/** Default max silence between deltas. A local server (LM Studio/Ollama/vLLM) that
 *  accepts the request and then wedges holds the SSE open forever — without this
 *  deadline nothing throws, `withRetry` never fires, and the CLI hangs. */
const DEFAULT_IDLE_MS = 180_000;

function idleTimeoutMs(): number {
  const n = Number(process.env.AITL_STREAM_IDLE_MS ?? DEFAULT_IDLE_MS);
  return Number.isFinite(n) ? n : DEFAULT_IDLE_MS;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`stream idle timeout: no delta for ${ms}ms (AITL_STREAM_IDLE_MS)`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function consumeStream(
  gen: AsyncGenerator<StreamDelta, ChatTurn, void>,
  onDelta: (delta: StreamDelta) => void,
  opts: { idleMs?: number; signal?: AbortSignal } = {},
): Promise<ChatTurn> {
  const idleMs = opts.idleMs ?? idleTimeoutMs();
  // Abort support: racing each `gen.next()` against the signal interrupts MID-delta,
  // not just between deltas. The rejection is pre-handled so an abort that fires
  // after the stream already resolved never becomes an unhandled rejection.
  const signal = opts.signal;
  let onAbort: (() => void) | undefined;
  const aborted: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(new StreamInterrupted());
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  if (aborted) void aborted.catch(() => {});
  try {
    while (true) {
      if (signal?.aborted) throw new StreamInterrupted();
      let step: IteratorResult<StreamDelta, ChatTurn>;
      try {
        const next = idleMs > 0 ? withDeadline(gen.next(), idleMs) : gen.next();
        step = aborted ? await Promise.race([next, aborted]) : await next;
      } catch (err) {
        // Close the underlying HTTP stream; the error then propagates — a "timeout"
        // is transient (withRetry replays the turn), a StreamInterrupted is not.
        void gen.return(undefined as never).catch(() => {});
        throw err;
      }
      if (step.done) return step.value;
      onDelta(step.value);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
