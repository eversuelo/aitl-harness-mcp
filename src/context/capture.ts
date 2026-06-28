/**
 * Session capture for external agent hosts (the "Cara B" cognitive backend, ADR-0020).
 *
 * When the harness is NOT the loop — e.g. a Claude Code session driven by a human — there
 * is no `runAgent` to hydrate/summarize. These helpers let a host's lifecycle hook feed
 * the same durable store:
 *
 *   - `readHookStdin()`      parse the JSON a Claude Code hook pipes on stdin.
 *   - `parseTranscript()`    read a Claude Code transcript (JSONL) into a convo + edited paths.
 *   - `componentTags()`      derive `component:<dir>` tags from the files a session touched.
 *   - `captureSession()`     summarize the transcript into ONE durable memory doc
 *                            (via summarizeSession) AND store a context snapshot, both
 *                            auto-tagged by component so the work is recoverable later.
 *
 * Everything is best-effort: a host hook must never break the user's session.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDb } from "../db/client.js";
import { MemoryStore } from "../memory/store.js";
import { summarizeSession, type SessionSummary } from "../memory/lifecycle.js";
import type { Provider } from "../providers/base.js";

/** Tool names whose input names a file the session edited. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "create_file", "edit_file"]);

export interface Msg {
  role: string;
  content: string;
  // Index signature so a convo is assignable to summarizeSession's Record<string, unknown>[].
  [key: string]: unknown;
}

export interface ParsedTranscript {
  convo: Msg[];
  editedPaths: string[];
}

/** Read all of stdin (returns "" when nothing is piped / stdin is a TTY). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/** Parse the JSON object a Claude Code hook pipes on stdin (best-effort, never throws). */
export async function readHookStdin(): Promise<Record<string, unknown>> {
  const raw = (await readStdin()).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { prompt: raw };
  } catch {
    return { prompt: raw };
  }
}

/** Flatten a message `content` (string OR array of blocks) into plain text + collect tool edits. */
function flattenContent(content: unknown, editedPaths: string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      const name = String(b.name ?? "");
      const input = (b.input ?? {}) as Record<string, unknown>;
      const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
      if (EDIT_TOOLS.has(name) && file) {
        editedPaths.push(file);
        parts.push(`[edit ${name}: ${file}]`);
      } else if (name) {
        parts.push(`[tool ${name}]`);
      }
    }
  }
  return parts.join("\n").trim();
}

/** Read a Claude Code transcript JSONL into a normalized convo + the list of edited paths. */
export async function parseTranscript(path: string): Promise<ParsedTranscript> {
  const convo: Msg[] = [];
  const editedPaths: string[] = [];
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { convo, editedPaths };
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? entry.type ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const text = flattenContent(message.content, editedPaths);
    if (text) convo.push({ role, content: text });
  }
  return { convo, editedPaths };
}

/** Derive `component:<dir>` tags from edited file paths (relative to cwd, first 2 segments). */
export function componentTags(editedPaths: string[], cwd?: string): string[] {
  const base = (cwd ?? process.cwd()).replace(/\\/g, "/").replace(/\/+$/, "");
  const seen = new Set<string>();
  for (const p of editedPaths) {
    let rel = p.replace(/\\/g, "/");
    if (base && rel.toLowerCase().startsWith(base.toLowerCase())) rel = rel.slice(base.length);
    rel = rel.replace(/^\/+/, "").replace(/^\.\//, "");
    const segs = rel.split("/").filter(Boolean);
    if (segs.length === 0) continue;
    // Drop noise dirs; keep up to the first two meaningful segments as the component id.
    if (["node_modules", "dist", ".git"].includes(segs[0])) continue;
    const comp = segs.length > 1 ? `${segs[0]}/${segs[1]}` : segs[0];
    seen.add(`component:${comp}`);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

export interface CaptureResult {
  summary: SessionSummary | null;
  components: string[];
  context_id: string | null;
  run_id: string;
}

export interface CaptureOpts {
  project: string;
  transcriptPath?: string;
  sessionId?: string;
  cwd?: string;
  /** Explicit semantic component name (added alongside the auto dir tags). */
  component?: string;
  /** Repo sub-scope this session belongs to (ADR-0028). */
  repo?: string;
  source?: string;
  provider?: Provider;
  store?: MemoryStore;
}

/** Persist a context snapshot to `mcp_context` (mirrors the save_mcp_context MCP tool shape). */
async function saveSnapshot(args: {
  project: string;
  title: string;
  summary: string;
  convo: Msg[];
  tags: string[];
  runId: string;
  source: string;
  repo?: string | null;
}): Promise<string | null> {
  try {
    const coll = getDb().collection("mcp_context");
    // Best-effort indexes (no-op once they exist); the collection is created on first insert.
    await coll.createIndex({ project: 1, created_at: -1 }).catch(() => {});
    await coll.createIndex({ project: 1, tags: 1 }).catch(() => {});
    const contextId = randomUUID();
    const contentText = [args.title, args.summary, ...args.convo.map((m) => `${m.role}: ${m.content}`)]
      .filter(Boolean)
      .join("\n");
    await coll.insertOne({
      context_id: contextId,
      project: args.project,
      repo: args.repo ?? null,
      title: args.title,
      summary: args.summary,
      source: args.source,
      model: null,
      run_id: args.runId,
      tags: args.tags,
      messages: args.convo,
      context: {},
      metadata: { captured_by: "capture-session" },
      content_text: contentText,
      created_at: new Date(),
      updated_at: new Date(),
    });
    return contextId;
  } catch {
    return null;
  }
}

/**
 * Capture a finished host session: summarize the transcript into durable memory and a
 * context snapshot, auto-tagged by the components (dirs) the session touched.
 */
export async function captureSession(opts: CaptureOpts): Promise<CaptureResult> {
  const store = opts.store ?? new MemoryStore();
  const source = opts.source ?? "claude-code";
  const runId = opts.sessionId ?? randomUUID();

  const parsed = opts.transcriptPath
    ? await parseTranscript(opts.transcriptPath)
    : { convo: [] as Msg[], editedPaths: [] as string[] };

  const compTags = componentTags(parsed.editedPaths, opts.cwd);
  const explicit = opts.component ? [`component:${opts.component}`] : [];
  const tags = [...new Set([`host:${source}`, ...compTags, ...explicit])];

  const summary = await summarizeSession(opts.project, runId, parsed.convo, {
    store,
    provider: opts.provider,
    extraTags: tags,
  });

  const context_id = await saveSnapshot({
    project: opts.project,
    title: `Session ${runId.slice(0, 8)} (${source})`,
    summary: summary?.category ? `Auto-captured session — category ${summary.category}.` : "Auto-captured session.",
    convo: parsed.convo,
    tags,
    runId,
    source,
    repo: opts.repo ?? null,
  });

  return { summary, components: [...compTags, ...explicit], context_id, run_id: runId };
}
