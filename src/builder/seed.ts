/**
 * Seed master skills (ADR-0030): idempotently register the harness's own
 * "constructor" and "indexer" skills into a project's skills collection so any
 * agent can discover them via search_skills / list_skills. Re-running upserts them.
 */

import { buildDefinition } from "./buildDefinition.js";
import type { DefinitionRecord } from "../projectctx/schemas.js";

const DEFINITION_BUILDER = [
  "# Skill: definition-builder (constructora)",
  "",
  "> Construye y persiste definiciones de skill o agente en el harness.",
  "",
  "## When to use",
  "- Cuando necesites crear o actualizar un skill o un agente reutilizable.",
  "",
  "## How",
  "- CLI: `aitl build skill <name> --project <p> [--desc ...] [--content ... | --from <file>] [--tags a,b]`",
  "- CLI: `aitl build agent <name> --project <p> [--host model|claude-code|codex] [--model <id>]`",
  "- MCP: `build_definition { kind: 'skill'|'agent', project, name, description?, content?, tags?, host?, model? }`",
  "- Si omites `content`, se genera un scaffold markdown editable; re-ejecutar con el mismo name lo actualiza (upsert).",
  "",
  "## Output",
  "- Un DefinitionRecord en la colección `skills`/`agents`, keyed por (project, name).",
].join("\n");

const REPO_INDEXER = [
  "# Skill: repo-indexer (maestra)",
  "",
  "> Analiza todo el repo e indexa lo necesario para desarrollar: repo map (símbolos),",
  "> memoria markdown y ADRs, en una sola pasada.",
  "",
  "## When to use",
  "- Al iniciar trabajo en un repo, o tras cambios grandes, para refrescar el contexto durable.",
  "",
  "## How",
  "- CLI: `aitl index-repo --root <dir> --project <p> [--repo <r>] [--memory <dir>] [--adr <dir>]`",
  "- MCP: `index_repo { project, root, repo?, memory?, adr? }`",
  "- Pasos (best-effort, reportados por separado): repomap (tree-sitter + PageRank) → ingest de memoria → adr-sync.",
  "",
  "## Output",
  "- Símbolos en `symbols`, memoria en `memory`, ADRs en `decisions` — todo scopeable por `repo`.",
].join("\n");

/** Upsert the master skills into a project. Returns the stored records. */
export async function seedMasterSkills(project: string): Promise<DefinitionRecord[]> {
  return Promise.all([
    buildDefinition({
      kind: "skill",
      project,
      name: "definition-builder",
      description: "Construye y persiste skills/agentes (constructora).",
      content: DEFINITION_BUILDER,
      tags: ["master", "builder", "meta"],
    }),
    buildDefinition({
      kind: "skill",
      project,
      name: "repo-indexer",
      description: "Indexa todo el repo (symbols + memoria + ADRs) para desarrollar (maestra).",
      content: REPO_INDEXER,
      tags: ["master", "indexer", "meta"],
    }),
  ]);
}
