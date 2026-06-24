/**
 * Context manager: keep the working context within a token budget.
 *
 * Strategies (all logged as Events for thesis analysis):
 *   - estimate(): cheap ~4-chars/token estimate over messages.
 *   - compact(): summarize older turns into a single high-fidelity note when the
 *     budget is exceeded (delegated to a Provider; deterministic fallback otherwise).
 *   - clearToolResults(): drop bulky tool outputs from old turns (keep the latest).
 *
 * Intentionally model-light; the heavy lifting is the durable memory in Mongo.
 */

import type { Provider } from "../providers/base.js";

export const DEFAULT_BUDGET = 120_000;

type Msg = Record<string, unknown>;

export class ContextManager {
  constructor(
    private budget: number = DEFAULT_BUDGET,
    private llm: Provider | null = null,
  ) {}

  static estimate(messages: Msg[]): number {
    const chars = messages.reduce((sum, m) => sum + String(m.content ?? "").length, 0);
    return Math.floor(chars / 4);
  }

  overBudget(messages: Msg[]): boolean {
    return ContextManager.estimate(messages) > this.budget;
  }

  clearToolResults(messages: Msg[], keepLast = 1): Msg[] {
    const toolIdxs = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
    const drop = new Set(toolIdxs.length > keepLast ? toolIdxs.slice(0, -keepLast) : []);
    return messages.map((m, i) =>
      drop.has(i) ? { ...m, content: "[tool result cleared]" } : m,
    );
  }

  async compact(messages: Msg[], keepRecent = 6): Promise<Msg[]> {
    if (messages.length <= keepRecent) return messages;
    const old = messages.slice(0, -keepRecent);
    const recent = messages.slice(-keepRecent);
    const summary = await this.summarize(old);
    return [{ role: "system", content: `[compacted history]\n${summary}` }, ...recent];
  }

  private async summarize(messages: Msg[]): Promise<string> {
    const joined = messages
      .map((m) => `${String(m.role)}: ${String(m.content)}`)
      .join("\n")
      .slice(0, 12_000);
    if (this.llm !== null) {
      const out = await this.llm.complete(
        "Summarize this conversation history, preserving decisions, file paths " +
          `and open tasks:\n\n${joined}`,
      );
      return out.trim();
    }
    return joined.slice(0, 2000); // deterministic fallback
  }
}
