/**
 * Streaming plumbing for the loop (ADR-0005).
 *
 * `consumeStream` drains a provider's `chatStream` generator, forwarding each delta
 * to an observer, and resolves with the generator's RETURN value — the same
 * normalized ChatTurn `chat()` would produce. The loop stays shape-identical
 * whether it streamed or not.
 */

import type { ChatTurn, StreamDelta } from "../providers/base.js";

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
  opts: { idleMs?: number } = {},
): Promise<ChatTurn> {
  const idleMs = opts.idleMs ?? idleTimeoutMs();
  while (true) {
    let step: IteratorResult<StreamDelta, ChatTurn>;
    try {
      step = idleMs > 0 ? await withDeadline(gen.next(), idleMs) : await gen.next();
    } catch (err) {
      // Close the underlying HTTP stream; the error ("timeout" is transient) then
      // propagates to `withRetry`, which replays the whole turn.
      void gen.return(undefined as never).catch(() => {});
      throw err;
    }
    if (step.done) return step.value;
    onDelta(step.value);
  }
}
