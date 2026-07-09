/**
 * Persistent input history for `aitl chat` — one plain-text file per project under
 * `~/.aitl/history/`, oldest entry first. The readline `history` option wants
 * newest-first, so `loadHistory` reverses. Everything here is best-effort: a
 * missing/corrupt/unwritable history file must never break the REPL.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Entries kept when loading; the file is compacted once it doubles this. */
const MAX_ENTRIES = 500;

export function historyFile(project: string, baseDir = join(homedir(), ".aitl", "history")): string {
  const safe = project.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "default";
  return join(baseDir, `chat-${safe}.txt`);
}

/** History entries newest-first (what readline's `history` option expects). */
export async function loadHistory(path: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-MAX_ENTRIES)
      .reverse();
  } catch {
    return [];
  }
}

/** Append one entry (newlines flattened); consecutive duplicates are dropped. */
export async function appendHistory(path: string, line: string): Promise<void> {
  const entry = line.replace(/\r?\n/g, " ").trim();
  if (!entry) return;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const raw = await fs.readFile(path, "utf-8").catch(() => "");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines[lines.length - 1] === entry) return;
    lines.push(entry);
    const kept = lines.length > MAX_ENTRIES * 2 ? lines.slice(-MAX_ENTRIES) : lines;
    await fs.writeFile(path, `${kept.join("\n")}\n`, "utf-8");
  } catch {
    // best-effort — history must never break the REPL
  }
}

// ── @file mentions ────────────────────────────────────────────────────────────

/** Per-file cap when inlining @mentions (keeps a fat file from eating the context). */
const MENTION_MAX_BYTES = 48_000;
const MENTION_MAX_FILES = 5;

export interface MentionExpansion {
  prompt: string;
  /** Files actually inlined (relative paths as typed). */
  attached: string[];
}

/**
 * Expand Claude Code–style `@path` mentions: each readable file is appended to the
 * prompt as a fenced context block. Unknown paths stay literal (an email like
 * user@host must survive), so a token only counts as a mention when the file exists.
 */
export async function expandFileMentions(prompt: string, cwd = process.cwd()): Promise<MentionExpansion> {
  const attached: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of prompt.matchAll(/(^|\s)@([\w./~-]+)/g)) {
    if (attached.length >= MENTION_MAX_FILES) break;
    const rel = m[2].replace(/^~(?=\/|$)/, homedir());
    if (seen.has(rel)) continue;
    seen.add(rel);
    const path = isAbsolute(rel) ? rel : join(cwd, rel);
    try {
      const st = await fs.stat(path);
      if (!st.isFile()) continue;
      let body = await fs.readFile(path, "utf-8");
      let clipped = false;
      if (body.length > MENTION_MAX_BYTES) {
        body = body.slice(0, MENTION_MAX_BYTES);
        clipped = true;
      }
      attached.push(m[2]);
      blocks.push(
        `--- file: ${m[2]}${clipped ? " (truncado)" : ""} ---\n${body}${body.endsWith("\n") ? "" : "\n"}--- end file ---`,
      );
    } catch {
      // not a readable file → leave the token as literal text
    }
  }
  if (!blocks.length) return { prompt, attached };
  return { prompt: `${prompt}\n\n${blocks.join("\n\n")}`, attached };
}
