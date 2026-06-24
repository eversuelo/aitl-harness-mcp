/**
 * Parse chat transcripts into Message objects.
 *
 * Supports two common shapes:
 *   - JSONL: one JSON object per line with at least {role, content}.
 *   - Markdown: sections delimited by `## role` headings.
 *
 * Each parsed turn becomes a Message (project/run-scoped) ready for classify + embed.
 */

import { promises as fs } from "node:fs";
import { extname } from "node:path";
import { ROLES, type Message, type Role, makeMessage } from "../memory/schemas.js";

const MD_TURN_RE = /^##\s+(user|assistant|tool|system)\s*$/gim;

function coerceRole(role: string): Role {
  return (ROLES as readonly string[]).includes(role) ? (role as Role) : "user";
}

export async function parseJsonl(path: string, project: string, runId: string): Promise<Message[]> {
  const lines = (await fs.readFile(path, "utf-8")).split(/\r?\n/);
  const msgs: Message[] = [];
  let idx = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    msgs.push(
      makeMessage({
        project,
        run_id: runId,
        idx: idx++,
        role: coerceRole(String(obj.role ?? "user")),
        content: String(obj.content ?? ""),
        tool_calls: (obj.tool_calls as Message["tool_calls"]) ?? [],
        tokens: Number(obj.tokens ?? 0),
      }),
    );
  }
  return msgs;
}

export async function parseMarkdownTranscript(
  path: string,
  project: string,
  runId: string,
): Promise<Message[]> {
  const text = await fs.readFile(path, "utf-8");
  const parts = text.split(MD_TURN_RE); // [pre, role1, body1, role2, body2, ...]
  const msgs: Message[] = [];
  let idx = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const role = coerceRole(parts[i].toLowerCase());
    const body = (parts[i + 1] ?? "").trim();
    msgs.push(makeMessage({ project, run_id: runId, idx: idx++, role, content: body }));
  }
  return msgs;
}

export async function parseTranscript(path: string, project: string, runId: string): Promise<Message[]> {
  return extname(path) === ".jsonl"
    ? parseJsonl(path, project, runId)
    : parseMarkdownTranscript(path, project, runId);
}
