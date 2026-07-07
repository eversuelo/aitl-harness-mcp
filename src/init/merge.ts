/**
 * Conservative merge helpers for `aitl init` (P5/F1). All pure (string in → string
 * out) so they are unit-testable without fs or Mongo. The shared philosophy: NEVER
 * destroy user content — parse, add only what is missing, and leave everything else
 * byte-identical where possible (JSON files are re-serialized with 2-space indent).
 */

export interface MergeResult {
  /** The full content the caller should write (unchanged input when `changed` is false). */
  content: string;
  changed: boolean;
  /** Human line for the init report ("añadido", "ya presente", …). */
  reason: string;
}

/** Parse JSON or throw with a path-friendly message (caller reports, never clobbers). */
function parseJson(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what}: JSON inválido (${err instanceof Error ? err.message : String(err)}) — no se toca.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what}: la raíz no es un objeto JSON — no se toca.`);
  }
  return parsed as Record<string, unknown>;
}

const stringify = (obj: unknown): string => `${JSON.stringify(obj, null, 2)}\n`;

// ── .mcp.json ─────────────────────────────────────────────────────────────────

/**
 * Ensure `.mcp.json` declares the given MCP server. `raw === null` creates the file;
 * an existing entry with the same name is NEVER replaced (the user may have tuned it).
 */
export function mergeMcpJson(
  raw: string | null,
  serverName: string,
  entry: Record<string, unknown>,
): MergeResult {
  if (raw === null) {
    return {
      content: stringify({ mcpServers: { [serverName]: entry } }),
      changed: true,
      reason: `creado con el server '${serverName}'`,
    };
  }
  const doc = parseJson(raw, ".mcp.json");
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(".mcp.json: 'mcpServers' no es un objeto — no se toca.");
  }
  if (serverName in servers) {
    return { content: raw, changed: false, reason: `ya declara el server '${serverName}'` };
  }
  doc.mcpServers = { ...servers, [serverName]: entry };
  return { content: stringify(doc), changed: true, reason: `server '${serverName}' añadido` };
}

// ── .claude/settings.json hooks ───────────────────────────────────────────────

export interface HookSpec {
  /** Claude Code hook event (UserPromptSubmit | Stop | …). */
  event: string;
  /** Shell command to run. */
  command: string;
  /** Substring that identifies an already-installed equivalent hook (skip marker). */
  marker: string;
}

/**
 * Merge hook commands into a Claude Code settings.json. Existing hooks are PRESERVED:
 * each spec is appended as a new matcher-group only when no existing command under
 * that event contains its `marker`. `raw === null` creates a minimal settings file.
 */
export function mergeClaudeSettings(raw: string | null, specs: HookSpec[]): MergeResult {
  const doc = raw === null ? {} : parseJson(raw, ".claude/settings.json");
  const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error(".claude/settings.json: 'hooks' no es un objeto — no se toca.");
  }

  const added: string[] = [];
  const kept: string[] = [];
  for (const spec of specs) {
    const groupsRaw = hooks[spec.event];
    const groups: unknown[] = Array.isArray(groupsRaw) ? groupsRaw : [];
    // Conservative detection: any command string under this event containing the marker.
    const already = JSON.stringify(groups).includes(spec.marker);
    if (already) {
      kept.push(spec.event);
      continue;
    }
    hooks[spec.event] = [...groups, { hooks: [{ type: "command", command: spec.command }] }];
    added.push(spec.event);
  }
  if (!added.length) {
    return { content: raw ?? stringify(doc), changed: false, reason: `hooks ya presentes (${kept.join(", ")})` };
  }
  doc.hooks = hooks;
  return {
    content: stringify(doc),
    changed: true,
    reason: `hooks añadidos: ${added.join(", ")}${kept.length ? ` (ya presentes: ${kept.join(", ")})` : ""}`,
  };
}

// ── CLAUDE.md / AGENTS.md minimal section merge ───────────────────────────────

/** Does the guide already carry AITL instructions? (marker: "## AITL", "aitl hydrate", or any AITL mention). */
export function hasAitlSection(content: string): boolean {
  return /(^|\n)##\s+AITL\b/.test(content) || content.includes("aitl hydrate") || content.includes("AITL");
}

/** The minimal AITL section appended to a pre-existing guide (never replaces content). */
export function renderAitlSection(project: string, mcp = "aitl-js"): string {
  return `
## AITL

Este repo usa el harness AITL como memoria durable (proyecto \`${project}\`, MCP \`${mcp}\`).
Consulta la memoria ANTES de decidir y persiste lo aprendido DESPUÉS.

- Contexto por prompt: \`aitl hydrate --project ${project} --no-vector\`
- Captura de sesión:   \`aitl capture-session --project ${project}\`
- Búsqueda semántica:  \`aitl search "<query>" --project ${project}\`
- Espejo markdown:     \`aitl sync --project ${project}\`
`;
}

/**
 * Minimal merge for an existing guide: append the AITL section only when the file
 * shows no AITL marker. Existing content is left untouched.
 */
export function mergeGuideSection(existing: string, project: string, mcp = "aitl-js"): MergeResult {
  if (hasAitlSection(existing)) {
    return { content: existing, changed: false, reason: "ya contiene sección/marcador AITL" };
  }
  const sep = existing.endsWith("\n") ? "" : "\n";
  return {
    content: `${existing}${sep}${renderAitlSection(project, mcp)}`,
    changed: true,
    reason: "sección AITL añadida (merge mínimo)",
  };
}

// ── .git/hooks/post-merge ─────────────────────────────────────────────────────

export const POST_MERGE_MARKER = "branch sync --reindex";

/**
 * Ensure the post-merge hook runs the AITL reindex line. `raw === null` creates the
 * script; an existing hook is APPENDED to (never truncated) when the line is missing.
 */
export function mergePostMergeHook(raw: string | null, line: string): MergeResult {
  const comment = "# AITL: reindexa cuando avanza el trunk base (best-effort; nunca rompe el merge).";
  if (raw === null) {
    return {
      content: `#!/bin/sh\n${comment}\n${line}\n`,
      changed: true,
      reason: "hook post-merge creado",
    };
  }
  if (raw.includes(POST_MERGE_MARKER)) {
    return { content: raw, changed: false, reason: "el hook ya reindexa (branch sync --reindex)" };
  }
  const sep = raw.endsWith("\n") ? "" : "\n";
  return {
    content: `${raw}${sep}${comment}\n${line}\n`,
    changed: true,
    reason: "línea de reindex añadida al hook existente",
  };
}
