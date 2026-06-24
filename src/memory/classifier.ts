/**
 * Per-project classifier for memory docs and chat messages.
 *
 * Two-tier strategy (cheap first, LLM only when needed):
 *   1. Rules: frontmatter `type`, keyword/regex rules from the `categories` taxonomy.
 *   2. LLM fallback (optional): ask the configured provider to pick a category.
 *
 * Sets `category` + `tags` on the document so that `$vectorSearch` can filter by them
 * and so the synthesizer can group related entries.
 */

import type { Provider } from "../providers/base.js";
import type { MemoryDoc, Message } from "./schemas.js";

// Default seed taxonomy; persisted/extended via the `categories` collection.
export const DEFAULT_RULES: Record<string, RegExp[]> = {
  decision: [/\bdecid/i, /\bADR\b/i, /trade-?off/i, /we chose/i, /because/i],
  convention: [/\bconvention/i, /\bpattern\b/i, /\bstyle\b/i, /always/i, /never/i],
  bug: [/\bbug\b/i, /\berror\b/i, /\bfix(ed|es)?\b/i, /traceback/i, /exception/i],
  task: [/\bTODO\b/i, /\btask\b/i, /implement/i, /\bplan\b/i],
  reference: [/https?:\/\//i, /\bdocs?\b/i, /\bAPI\b/i],
};

function matchRules(text: string, rules: Record<string, RegExp[]>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const [cat, patterns] of Object.entries(rules)) {
    const score = patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return bestScore > 0 ? best : null;
}

const FRONTMATTER_TYPES = new Set(["user", "feedback", "project", "reference"]);

export class Classifier {
  constructor(
    private rules: Record<string, RegExp[]> = DEFAULT_RULES,
    private llm: Provider | null = null,
  ) {}

  async classifyText(text: string, opts: { frontmatterType?: string } = {}): Promise<string> {
    if (opts.frontmatterType && FRONTMATTER_TYPES.has(opts.frontmatterType)) return opts.frontmatterType;
    const cat = matchRules(text, this.rules);
    if (cat) return cat;
    if (this.llm !== null) return this.llmClassify(text);
    return "uncategorized";
  }

  private async llmClassify(text: string): Promise<string> {
    const labels = [...Object.keys(this.rules), "uncategorized"];
    const prompt =
      `Classify the following note into exactly one of these categories: ${JSON.stringify(labels)}. ` +
      `Reply with only the category word.\n\n${text.slice(0, 2000)}`;
    const out = (await this.llm!.complete(prompt)).trim().toLowerCase();
    return labels.includes(out) ? out : "uncategorized";
  }

  // ── convenience wrappers ────────────────────────────────────────────
  async classifyMemory(doc: MemoryDoc): Promise<MemoryDoc> {
    const fm = doc.frontmatter as { metadata?: { type?: string }; type?: string };
    const ftype = fm.metadata?.type ?? fm.type;
    doc.category = await this.classifyText(doc.body || doc.description, { frontmatterType: ftype });
    return doc;
  }

  async classifyMessage(msg: Message): Promise<Message> {
    msg.category = await this.classifyText(msg.content);
    return msg;
  }
}
