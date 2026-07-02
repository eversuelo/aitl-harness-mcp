/**
 * Streaming plumbing for the loop (ADR-0005).
 *
 * `consumeStream` drains a provider's `chatStream` generator, forwarding each delta
 * to an observer, and resolves with the generator's RETURN value — the same
 * normalized ChatTurn `chat()` would produce. The loop stays shape-identical
 * whether it streamed or not.
 */

import type { ChatTurn, StreamDelta } from "../providers/base.js";

export async function consumeStream(
  gen: AsyncGenerator<StreamDelta, ChatTurn, void>,
  onDelta: (delta: StreamDelta) => void,
): Promise<ChatTurn> {
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
    onDelta(step.value);
  }
}
