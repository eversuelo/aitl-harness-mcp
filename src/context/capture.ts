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
import { ensureMongoose } from "../db/mongoose.js";
import { McpContextModel } from "../models/mcpContext.model.js";
import { MemoryStore } from "../memory/store.js";
import { summarizeSession, type SessionSummary } from "../memory/lifecycle.js";
import { makeRun } from "../memory/schemas.js";
import { classifySpec } from "../specs/classify.js";
import type { Provider } from "../providers/base.js";

/** Tool names whose input names a file the session edited. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "create_file", "edit_file"]);

export interface Msg {
  role: string;
  content: string;
  // Index signature so a convo is assignable to summarizeSession's Record<string, unknown>[].
  [key: string]: unknown;
}

/** Durable artifacts a session produced, parsed from its MCP tool_use calls (ADR-0035). */
export interface SessionArtifacts {
  decisions: string[]; // ADR ids written via record_decision
  memories: string[]; // memory slugs written via write_memory
  prompts: string[]; // prompt titles/snippets recorded via record_prompt
  interventions: number; // record_human_intervention calls
}

export interface ParsedTranscript {
  convo: Msg[];
  editedPaths: string[];
  /** Durable artifacts (ADRs/memories/prompts) the session wrote via MCP. */
  artifacts: SessionArtifacts;
  /** Summed token usage across assistant turns (input includes cache tokens). */
  usage: { input: number; output: number };
  /** Cache-token breakdown + fresh input, for host_meta (cache_read is billed cheaply). */
  cache: { creation: number; read: number; freshInput: number };
  /** Model id seen on the assistant turns (last one wins). */
  model: string | null;
  /** Number of assistant turns (the host's loop-iteration analog). */
  turns: number;
  startedAt: Date | null;
  endedAt: Date | null;
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

/** Record a durable artifact written by an MCP tool_use call (matched by name suffix). */
function collectArtifact(name: string, input: Record<string, unknown>, artifacts?: SessionArtifacts): void {
  if (!artifacts) return;
  if (name.endsWith("record_decision") && input.id) artifacts.decisions.push(String(input.id));
  else if (name.endsWith("write_memory") && input.slug) artifacts.memories.push(String(input.slug));
  else if (name.endsWith("record_prompt"))
    artifacts.prompts.push(String(input.title || String(input.prompt ?? "").replace(/\s+/g, " ").slice(0, 60)));
  else if (name.endsWith("record_human_intervention")) artifacts.interventions += 1;
}

/** Flatten a message `content` (string OR array of blocks) into plain text + collect tool edits/artifacts. */
function flattenContent(content: unknown, editedPaths: string[], artifacts?: SessionArtifacts): string {
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
      collectArtifact(name, input, artifacts);
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
  const artifacts: SessionArtifacts = { decisions: [], memories: [], prompts: [], interventions: 0 };
  const usage = { input: 0, output: 0 };
  const cache = { creation: 0, read: 0, freshInput: 0 };
  let model: string | null = null;
  let turns = 0;
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  const finish = (): ParsedTranscript => {
    artifacts.decisions = [...new Set(artifacts.decisions)];
    artifacts.memories = [...new Set(artifacts.memories)];
    artifacts.prompts = [...new Set(artifacts.prompts)];
    return { convo, editedPaths, artifacts, usage, cache, model, turns, startedAt, endedAt };
  };
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return finish();
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
    // Track the session's wall-clock span from the line timestamps.
    const ts = typeof entry.timestamp === "string" ? new Date(entry.timestamp) : null;
    if (ts && !Number.isNaN(ts.getTime())) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? entry.type ?? "");
    if (role !== "user" && role !== "assistant") continue;

    // Accumulate measured tokens from each assistant turn (same fields as `claude -p` JSON).
    if (role === "assistant" && message.usage && typeof message.usage === "object") {
      const u = message.usage as Record<string, number>;
      const fresh = u.input_tokens ?? 0;
      const cc = u.cache_creation_input_tokens ?? 0;
      const cr = u.cache_read_input_tokens ?? 0;
      usage.input += fresh + cc + cr;
      usage.output += u.output_tokens ?? 0;
      cache.freshInput += fresh;
      cache.creation += cc;
      cache.read += cr;
      turns += 1;
      if (typeof message.model === "string") model = message.model;
    }

    const text = flattenContent(message.content, editedPaths, artifacts);
    if (text) convo.push({ role, content: text });
  }
  return finish();
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
  /** Measured token usage recorded on the run (zeros if the transcript had none). */
  token_usage: { input: number; output: number };
  /** Durable artifacts the session produced (linked in the per-session graph). */
  artifacts: SessionArtifacts;
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
    await ensureMongoose();
    // Best-effort indexes (no-op once they exist); the collection is created on first insert.
    await McpContextModel.collection.createIndex({ project: 1, created_at: -1 }).catch(() => {});
    await McpContextModel.collection.createIndex({ project: 1, tags: 1 }).catch(() => {});
    const contextId = randomUUID();
    const contentText = [args.title, args.summary, ...args.convo.map((m) => `${m.role}: ${m.content}`)]
      .filter(Boolean)
      .join("\n");
    await McpContextModel.create({
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
    : {
        convo: [] as Msg[],
        editedPaths: [] as string[],
        artifacts: { decisions: [], memories: [], prompts: [], interventions: 0 } as SessionArtifacts,
        usage: { input: 0, output: 0 },
        cache: { creation: 0, read: 0, freshInput: 0 },
        model: null as string | null,
        turns: 0,
        startedAt: null as Date | null,
        endedAt: null as Date | null,
      };

  const compTags = componentTags(parsed.editedPaths, opts.cwd);
  const explicit = opts.component ? [`component:${opts.component}`] : [];
  const tags = [...new Set([`host:${source}`, ...compTags, ...explicit])];

  // Record the session as a first-class `run` with its MEASURED tokens, so it shows up in
  // `aitl run-show` and the UI's Runs tab — the human-driven analog of run-host (ADR-0034).
  const firstUser = parsed.convo.find((m) => m.role === "user");
  const isSpec = firstUser ? classifySpec(String(firstUser.content)).isSpec : false;
  try {
    const run = makeRun({
      project: opts.project,
      model: `host:${source}`,
      status: "done",
      token_usage: parsed.usage,
      started_at: parsed.startedAt ?? new Date(),
      ended_at: parsed.endedAt ?? new Date(),
      harness_config: { role: "host", host: source, captured: true, spec: isSpec },
      tags,
    });
    await store.db.collection("runs").updateOne(
      { _id: runId as never },
      {
        $set: {
          ...run,
          iters: parsed.turns,
          spec: isSpec,
          // Durable artifacts produced this session (linked in the per-session graph, ADR-0035).
          artifacts: parsed.artifacts,
          host_meta: {
            model: parsed.model,
            num_turns: parsed.turns,
            duration_ms:
              parsed.startedAt && parsed.endedAt ? parsed.endedAt.getTime() - parsed.startedAt.getTime() : null,
            cache: { creation: parsed.cache.creation, read: parsed.cache.read },
            raw_input_tokens: parsed.cache.freshInput,
            captured_from: "transcript",
          },
        },
      },
      { upsert: true },
    );
  } catch {
    // recording the run is best-effort; never break a capture hook over it
  }

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

  return {
    summary,
    components: [...compTags, ...explicit],
    context_id,
    run_id: runId,
    token_usage: parsed.usage,
    artifacts: parsed.artifacts,
  };
}
