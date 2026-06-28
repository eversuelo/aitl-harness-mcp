/**
 * Definition builder (ADR-0030). Constructs and persists ONE skill or agent
 * definition into the DefinitionStore. If `content` is omitted, a markdown scaffold
 * is generated from a template so the definition is usable immediately and can be
 * refined later (re-running with the same name upserts it).
 */

import { DefinitionStore } from "../projectctx/store.js";
import type { DefinitionKind, DefinitionRecord } from "../projectctx/schemas.js";

export interface BuildDefinitionOpts {
  kind: DefinitionKind;
  project: string;
  name: string;
  description?: string;
  /** Markdown body. If omitted, a scaffold template is generated. */
  content?: string;
  tags?: string[];
  /** For agents: execution host + model, stored in metadata. */
  host?: string;
  model?: string;
}

function scaffoldSkill(name: string, description: string): string {
  return [
    `# Skill: ${name}`,
    "",
    description ? `> ${description}` : "> (describe what this skill does)",
    "",
    "## When to use",
    "- (trigger conditions)",
    "",
    "## Steps",
    "1. (step one)",
    "2. (step two)",
    "",
    "## Output",
    "- (what the skill produces)",
  ].join("\n");
}

function scaffoldAgent(name: string, description: string, host?: string, model?: string): string {
  return [
    `# Agent: ${name}`,
    "",
    description ? `> ${description}` : "> (describe this agent's role)",
    "",
    `- **Host:** ${host ?? "model"}`,
    `- **Model:** ${model ?? "(inherits)"}`,
    "",
    "## Responsibilities",
    "- (what this agent owns)",
    "",
    "## Skills",
    "- (referenced skill names)",
  ].join("\n");
}

/** Build (scaffold if needed) and upsert a skill/agent definition. */
export async function buildDefinition(opts: BuildDefinitionOpts): Promise<DefinitionRecord> {
  const description = opts.description ?? "";
  const content =
    opts.content ??
    (opts.kind === "agent"
      ? scaffoldAgent(opts.name, description, opts.host, opts.model)
      : scaffoldSkill(opts.name, description));

  const metadata: Record<string, unknown> = { built_by: "build_definition" };
  if (opts.kind === "agent") {
    if (opts.host) metadata.host = opts.host;
    if (opts.model) metadata.model = opts.model;
  }

  return new DefinitionStore(opts.kind).upsert({
    project: opts.project,
    name: opts.name,
    description,
    content,
    source: "builder",
    tags: opts.tags ?? [],
    metadata,
  });
}
