/**
 * Dependency-free markdown → ANSI renderer for the terminal (streaming-friendly).
 *
 * Line-oriented state machine. Block prefixes (headers, bullets, quotes, fences,
 * rules) are decided as soon as the first characters of a line disambiguate them;
 * inline spans (**bold**, *italic*, `code`, [text](url)) are held only until their
 * closing marker arrives, with a hard cap (`MAX_HOLD`) so a stray marker can never
 * stall the stream. Plain prose therefore still streams token by token.
 *
 * `AnsiMarkdownStream` keeps fence state across `push()` calls (the model may emit
 * a code block over many deltas); `renderMarkdownAnsi` is the one-shot convenience
 * for already-complete text. When disabled (non-TTY stdout or NO_COLOR) both are
 * identity functions, so piped output stays byte-clean markdown.
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GRAY = `${ESC}[90m`;

/** Past this many held chars, an unclosed inline marker is demoted to literal text. */
const MAX_HOLD = 160;

export const markdownEnabledByDefault = (): boolean =>
  process.stdout.isTTY === true && !process.env.NO_COLOR;

// ── inline spans ──────────────────────────────────────────────────────────────

type SpanMatch = { end: number; render: (base: string) => string } | "open" | null;

/**
 * Try to read one inline span starting at `s[i]`. Returns the span, `"open"` when
 * the text so far could still close it (streaming holds here), or `null` when the
 * character is definitively literal. `styleInline` and `firstOpenMarker` MUST share
 * this matcher — the safe-prefix emission relies on both agreeing span by span.
 */
function matchSpan(s: string, i: number): SpanMatch {
  const c = s[i];
  if (c === "`") {
    const j = s.indexOf("`", i + 1);
    if (j === -1) return "open";
    if (j === i + 1) return null; // `` — empty, literal
    const content = s.slice(i + 1, j);
    return { end: j + 1, render: (base) => `${YELLOW}${content}${RESET}${base}` };
  }
  if (c === "*") {
    if (i + 1 >= s.length) return "open";
    if (s[i + 1] === "*") {
      if (i + 2 >= s.length) return "open";
      if (s[i + 2] === " " || s[i + 2] === "*") return null;
      let j = s.indexOf("**", i + 2);
      while (j !== -1 && s[j - 1] === " ") j = s.indexOf("**", j + 1);
      if (j === -1) return "open";
      const content = s.slice(i + 2, j);
      return { end: j + 2, render: (base) => `${BOLD}${styleInline(content, base + BOLD)}${RESET}${base}` };
    }
    if (s[i + 1] === " ") return null;
    let j = s.indexOf("*", i + 1);
    while (j !== -1 && (s[j - 1] === " " || s[j - 1] === "*" || s[j + 1] === "*")) j = s.indexOf("*", j + 1);
    if (j === -1) return "open";
    const content = s.slice(i + 1, j);
    return { end: j + 1, render: (base) => `${ITALIC}${styleInline(content, base + ITALIC)}${RESET}${base}` };
  }
  if (c === "[") {
    const rest = s.slice(i);
    const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const [whole, text, url] = m;
      return {
        end: i + whole.length,
        render: (base) => `${CYAN}${text}${RESET}${base} ${GRAY}(${url})${RESET}${base}`,
      };
    }
    if (/^\[[^\]]*$/.test(rest) || /^\[[^\]]*\]$/.test(rest) || /^\[[^\]]*\]\([^)\s]*$/.test(rest)) return "open";
    return null;
  }
  return null;
}

/** Render inline markdown of a COMPLETE segment; unmatched markers stay literal. */
export function styleInline(s: string, base = ""): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const m = matchSpan(s, i);
    if (m !== null && m !== "open") {
      out += m.render(base);
      i = m.end;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Index of the first inline marker that has not closed yet in `s`, or -1. */
function firstOpenMarker(s: string): number {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`" || c === "*" || c === "[") {
      const m = matchSpan(s, i);
      if (m === "open") return i;
      if (m !== null) {
        i = m.end;
        continue;
      }
    }
    i++;
  }
  return -1;
}

// ── block prefixes ────────────────────────────────────────────────────────────

interface Block {
  kind: "p" | "h" | "bullet" | "ordered" | "quote" | "fence-open" | "fence-close" | "code" | "hr";
  /** Prefix chars consumed off the line (already replaced by `emit`). */
  consume: number;
  /** ANSI printed in place of the consumed prefix. */
  emit: string;
  /** Style applied to the line's remaining content. */
  base: string;
  /** Whether the remaining content goes through the inline styler. */
  inline: boolean;
  /** Accent `|` separators (loose table styling). */
  table?: boolean;
}

const PARAGRAPH: Block = { kind: "p", consume: 0, emit: "", base: "", inline: true };

const FENCE_CLOSE_RE = /^ {0,3}`{3,}\s*$/;

/**
 * Classify the start of a line. `probe` may be a partial line; `"hold"` means the
 * prefix is still ambiguous (only ever returned while the line is incomplete).
 */
function decideBlock(probe: string, complete: boolean, inFence: boolean): Block | "hold" {
  if (inFence) {
    if (FENCE_CLOSE_RE.test(probe)) {
      if (!complete) return "hold"; // closing fences carry no info string — confirm at EOL
      return { kind: "fence-close", consume: probe.length, emit: `${GRAY}${probe}${RESET}`, base: "", inline: false };
    }
    if (!complete && /^ {0,3}`{0,2}$/.test(probe)) return "hold";
    return { kind: "code", consume: 0, emit: "", base: "", inline: false };
  }
  if (/^ {0,3}```/.test(probe)) return { kind: "fence-open", consume: 0, emit: "", base: GRAY, inline: false };
  if (!complete && /^ {0,3}`{1,2}$/.test(probe)) return "hold";
  const h = /^( {0,3})(#{1,6}) /.exec(probe);
  if (h) {
    const level = h[2].length;
    return { kind: "h", consume: h[0].length, emit: h[1], base: level <= 2 ? BOLD + CYAN : BOLD, inline: true };
  }
  if (!complete && /^ {0,3}#{1,6}$/.test(probe)) return "hold";
  const bullet = /^( {0,8})([-*+]) /.exec(probe);
  if (bullet) {
    return { kind: "bullet", consume: bullet[0].length, emit: `${bullet[1]}${CYAN}•${RESET} `, base: "", inline: true };
  }
  const ordered = /^( {0,8})(\d{1,3})\. /.exec(probe);
  if (ordered) {
    return {
      kind: "ordered",
      consume: ordered[0].length,
      emit: `${ordered[1]}${CYAN}${ordered[2]}.${RESET} `,
      base: "",
      inline: true,
    };
  }
  if (!complete && /^ {0,8}\d{1,3}\.?$/.test(probe)) return "hold";
  if (/^ {0,3}(-{3,}|_{3,}|\*{3,})\s*$/.test(probe)) {
    if (!complete) return "hold";
    const width = Math.min(40, Math.max(probe.trim().length, 3));
    return { kind: "hr", consume: probe.length, emit: `${GRAY}${"─".repeat(width)}${RESET}`, base: "", inline: false };
  }
  if (!complete && /^ {0,3}(-+|_+|\*+)\s*$/.test(probe)) return "hold";
  if (!complete && /^ {0,3}>$/.test(probe)) return "hold"; // the optional space may follow
  const quote = /^( {0,3})> ?/.exec(probe);
  if (quote) {
    return { kind: "quote", consume: quote[0].length, emit: `${quote[1]}${GRAY}│ ${RESET}`, base: DIM, inline: true };
  }
  if (!complete && /^ {1,8}$/.test(probe)) return "hold";
  if (/^ {0,3}\|/.test(probe)) return { ...PARAGRAPH, table: true };
  return PARAGRAPH;
}

// ── streaming renderer ────────────────────────────────────────────────────────

export interface AnsiMarkdownOpts {
  /** Defaults to `markdownEnabledByDefault()`; disabled = identity passthrough. */
  enabled?: boolean;
}

export class AnsiMarkdownStream {
  private readonly enabled: boolean;
  private buf = "";
  private block: Block | null = null;
  private inFence = false;

  constructor(opts: AnsiMarkdownOpts = {}) {
    this.enabled = opts.enabled ?? markdownEnabledByDefault();
  }

  /** Feed a delta; returns the ANSI-styled text that is safe to print now. */
  push(chunk: string): string {
    if (!this.enabled) return chunk;
    this.buf += chunk.replace(/\r/g, "");
    return this.drain(false);
  }

  /** Render whatever is still held (unclosed markers become literal text). */
  flush(): string {
    if (!this.enabled) return "";
    const out = this.drain(true);
    this.block = null;
    return out;
  }

  private drain(eof: boolean): string {
    let out = "";
    for (;;) {
      const nl = this.buf.indexOf("\n");
      const lineComplete = nl !== -1;

      if (!this.block) {
        if (!this.buf && !lineComplete) return out;
        const probe = lineComplete ? this.buf.slice(0, nl) : this.buf;
        const decided = decideBlock(probe, lineComplete || eof, this.inFence);
        if (decided === "hold") {
          if (!eof) return out;
          this.block = PARAGRAPH; // defensive: complete probes never hold
        } else {
          this.block = decided;
        }
        out += this.block.emit;
        this.buf = this.buf.slice(this.block.consume);
      }

      const nl2 = this.buf.indexOf("\n");
      if (nl2 === -1) {
        if (!eof) return out + this.emitPartial();
        out += this.renderContent(this.buf);
        this.buf = "";
        this.endLine();
        return out;
      }
      out += `${this.renderContent(this.buf.slice(0, nl2))}\n`;
      this.buf = this.buf.slice(nl2 + 1);
      this.endLine();
    }
  }

  /** Emit the current (incomplete) line up to the first still-open inline marker. */
  private emitPartial(): string {
    const b = this.block as Block;
    if (!b.inline) {
      const text = this.buf;
      this.buf = "";
      return this.renderContent(text);
    }
    let out = "";
    for (;;) {
      const idx = firstOpenMarker(this.buf);
      if (idx === -1) {
        out += this.renderContent(this.buf);
        this.buf = "";
        return out;
      }
      if (idx > 0) {
        out += this.renderContent(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx);
      }
      if (this.buf.length <= MAX_HOLD) return out;
      out += this.renderContent(this.buf[0]); // stuck marker → literal, keep streaming
      this.buf = this.buf.slice(1);
    }
  }

  private renderContent(text: string): string {
    const b = this.block as Block;
    if (!text) return "";
    if (!b.inline) {
      if (b.kind === "code") return text; // code stays byte-exact for copy/paste
      return b.base ? `${b.base}${text}${RESET}` : text;
    }
    let styled = styleInline(text, b.base);
    if (b.table) styled = styled.replaceAll("|", `${GRAY}|${RESET}${b.base}`);
    return b.base ? `${b.base}${styled}${RESET}` : styled;
  }

  private endLine(): void {
    if (this.block?.kind === "fence-open") this.inFence = true;
    else if (this.block?.kind === "fence-close") this.inFence = false;
    this.block = null;
  }
}

/** One-shot render of complete markdown text. */
export function renderMarkdownAnsi(text: string, opts: AnsiMarkdownOpts = {}): string {
  const stream = new AnsiMarkdownStream(opts);
  return stream.push(text) + stream.flush();
}
