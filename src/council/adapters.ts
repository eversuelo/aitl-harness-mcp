/**
 * Plan-council client adapters (ADR-0003 v1) — the two ways a council seat is filled:
 *
 *   - HostClientAdapter: an external agent CLI (claude-code / codex / antigravity) run
 *     headlessly IN READ-ONLY / PLAN MODE (the council never edits files; hosts whose
 *     spec defines `readonlyArgs` get the flag, see hosts/base.ts). The prompt demands
 *     EXCLUSIVELY one JSON object; the reply is extracted with the balanced-JSON walker
 *     (util/json.ts, factored out of decomposeTasks) and validated with Zod.
 *
 *   - ProviderClientAdapter: a raw-model Provider using `CompleteOpts.jsonSchema`
 *     (constrained decoding — same mechanism decomposeTasks uses); backends without
 *     support fall back to the plain prompt, and the parse-and-repair path still applies.
 *
 * Malformed answers throw `CouncilFormatError` so the orchestrator can retry once
 * quoting the validation error (see orchestrator.ts).
 */

import { type HostAdapter, HOST_SPECS, getHost } from "../hosts/base.js";
import { type Provider, getProvider } from "../providers/base.js";
import { extractJsonObject } from "../util/json.js";
import {
  type CouncilCallCtx,
  type CouncilClientPort,
  type CouncilUsage,
  type CouncilVerdict,
  type LabeledProposal,
  type PlanCritique,
  type PlanProposal,
  CouncilFormatError,
  CouncilVerdictSchema,
  CritiqueReplySchema,
  PlanProposalSchema,
} from "./ports.js";
import { RUBRIC_CRITERIA } from "./rubric.js";

// ── prompts (shared by both adapters) ─────────────────────────────────────────

const JSON_ONLY =
  "Responde EXCLUSIVAMENTE con UN objeto JSON válido (sin prosa alrededor, sin code fences, " +
  "sin comentarios). NO edites archivos ni ejecutes cambios: tu único producto es el JSON.";

const scoresShape = (): string =>
  `{${RUBRIC_CRITERIA.map((c) => `"${c}":0-5`).join(",")}}`;

function proposeSystem(): string {
  return [
    "Eres un miembro de un consejo de planificación de ingeniería. Propón el MEJOR plan",
    "para la tarea dada (solo planificas: nadie ejecuta nada todavía).",
    JSON_ONLY,
    "Forma exacta:",
    '{"steps":[{"title":"…","rationale":"…"}],"risks":["…"],"assumptions":["…"],"estimated_complexity":"low"|"medium"|"high"}',
  ].join("\n");
}

function critiqueSystem(): string {
  return [
    "Eres un crítico en un consejo de planificación. Recibes propuestas ANÓNIMAS (etiquetas",
    '"A", "B", …) para la misma tarea. Critica CADA propuesta y puntúa cada criterio de la',
    `rúbrica de 0 a 5 (${RUBRIC_CRITERIA.join(", ")}). Elige tu voto: la etiqueta de la propuesta preferida.`,
    JSON_ONLY,
    "Forma exacta:",
    `{"critiques":[{"target":"A","findings":[{"severity":"info"|"minor"|"major","comment":"…"}],"scores":${scoresShape()}}],"vote":"A"}`,
  ].join("\n");
}

function judgeSystem(): string {
  return [
    "Eres el JUEZ de un consejo de planificación. Recibes propuestas ANÓNIMAS y las críticas",
    "que otros miembros hicieron. Emite el veredicto: la etiqueta ganadora (o null si ninguna",
    "es aceptable), una síntesis del mejor plan combinado y tu razonamiento.",
    JSON_ONLY,
    "Forma exacta:",
    '{"winner":"A"|null,"synthesis":"…","reasoning":"…","per_proposal_scores":{"A":0-5,"B":0-5}}',
  ].join("\n");
}

function taskBlock(task: string, ctx?: CouncilCallCtx): string {
  const parts: string[] = [];
  if (ctx?.context) parts.push(`# Contexto\n${ctx.context}`);
  parts.push(`# Tarea\n${task}`);
  if (ctx?.repairHint) {
    parts.push(
      `# Corrección\nTu respuesta anterior NO cumplió el esquema (${ctx.repairHint}). ` +
        "Responde de nuevo SOLO con el objeto JSON exigido.",
    );
  }
  return parts.join("\n\n");
}

function proposeUser(task: string, ctx?: CouncilCallCtx): string {
  return taskBlock(task, ctx);
}

function critiqueUser(anonProposals: LabeledProposal[], task: string, ctx?: CouncilCallCtx): string {
  return [
    taskBlock(task, ctx),
    `# Propuestas anónimas\n${JSON.stringify(anonProposals, null, 2)}`,
  ].join("\n\n");
}

function judgeUser(
  anonProposals: LabeledProposal[],
  critiques: PlanCritique[],
  task: string,
  ctx?: CouncilCallCtx,
): string {
  return [
    taskBlock(task, ctx),
    `# Propuestas anónimas\n${JSON.stringify(anonProposals, null, 2)}`,
    `# Críticas del consejo\n${JSON.stringify(critiques, null, 2)}`,
  ].join("\n\n");
}

// ── parsing (balanced JSON object + Zod) ──────────────────────────────────────

function parseObject(text: string): unknown {
  let raw: string;
  try {
    raw = extractJsonObject(text);
  } catch (err) {
    throw new CouncilFormatError(err instanceof Error ? err.message : String(err), text.slice(0, 400));
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CouncilFormatError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw.slice(0, 400),
    );
  }
}

function zodIssues(err: unknown): string {
  const e = err as { issues?: { path?: (string | number)[]; message?: string }[] };
  if (Array.isArray(e.issues)) {
    return e.issues
      .slice(0, 5)
      .map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function parseProposal(text: string): PlanProposal {
  const obj = parseObject(text);
  const res = PlanProposalSchema.safeParse(obj);
  if (!res.success) throw new CouncilFormatError(`proposal schema: ${zodIssues(res.error)}`, text.slice(0, 400));
  return res.data;
}

/** Parse the critique wire reply and fan the single vote out into PlanCritique[]. */
export function parseCritiques(text: string): PlanCritique[] {
  const obj = parseObject(text);
  const res = CritiqueReplySchema.safeParse(obj);
  if (!res.success) throw new CouncilFormatError(`critique schema: ${zodIssues(res.error)}`, text.slice(0, 400));
  return res.data.critiques.map((c) => ({ ...c, vote: res.data.vote }));
}

export function parseVerdict(text: string): CouncilVerdict {
  const obj = parseObject(text);
  const res = CouncilVerdictSchema.safeParse(obj);
  if (!res.success) throw new CouncilFormatError(`verdict schema: ${zodIssues(res.error)}`, text.slice(0, 400));
  return res.data;
}

// ── JSON Schemas for constrained decoding (ProviderClientAdapter) ─────────────

const scoresJsonSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: Object.fromEntries(RUBRIC_CRITERIA.map((c) => [c, { type: "number", minimum: 0, maximum: 5 }])),
  required: [...RUBRIC_CRITERIA],
  additionalProperties: false,
});

const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: { title: { type: "string" }, rationale: { type: "string" } },
        required: ["title", "rationale"],
        additionalProperties: false,
      },
    },
    risks: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    estimated_complexity: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["steps", "risks", "assumptions", "estimated_complexity"],
  additionalProperties: false,
};

function critiqueJsonSchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      critiques: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            target: { type: "string", enum: labels },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  severity: { type: "string", enum: ["info", "minor", "major"] },
                  comment: { type: "string" },
                },
                required: ["severity", "comment"],
                additionalProperties: false,
              },
            },
            scores: scoresJsonSchema(),
          },
          required: ["target", "findings", "scores"],
          additionalProperties: false,
        },
      },
      vote: { type: "string", enum: labels },
    },
    required: ["critiques", "vote"],
    additionalProperties: false,
  };
}

function verdictJsonSchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      winner: { enum: [...labels, null] },
      synthesis: { type: "string" },
      reasoning: { type: "string" },
      per_proposal_scores: {
        type: "object",
        properties: Object.fromEntries(labels.map((l) => [l, { type: "number" }])),
        required: labels,
        additionalProperties: false,
      },
    },
    required: ["winner", "synthesis", "reasoning", "per_proposal_scores"],
    additionalProperties: false,
  };
}

// ── host adapter ──────────────────────────────────────────────────────────────

/**
 * Machine-readable phase marker prepended to every host prompt (first line). Lets test
 * fixtures — and log readers — tell propose/critique/judge calls apart without guessing.
 */
export const COUNCIL_PHASE_MARKER = "AITL-COUNCIL-PHASE:";

export interface HostClientOpts {
  cwd?: string;
  timeoutMs?: number;
}

/** A council seat backed by an external agent CLI in read-only/plan mode. */
export class HostClientAdapter implements CouncilClientPort {
  readonly kind = "host" as const;
  lastUsage: CouncilUsage | null = null;

  constructor(
    readonly id: string,
    private host: HostAdapter,
    private opts: HostClientOpts = {},
  ) {}

  /** Resolve by host name (AITL_HOST_CMD_<NAME> override honored, read-only flag applied). */
  static forHost(name: string, opts: HostClientOpts = {}): HostClientAdapter {
    return new HostClientAdapter(name, getHost(name, { readonly: true }), opts);
  }

  private async call(phase: string, system: string, user: string): Promise<string> {
    const prompt = `${COUNCIL_PHASE_MARKER} ${phase}\n\n${system}\n\n${user}`;
    const res = await this.host.runTask(prompt, { cwd: this.opts.cwd, timeoutMs: this.opts.timeoutMs });
    this.lastUsage = res.usage ?? null;
    if (res.exitCode !== 0) {
      throw new Error(`host '${this.id}' exited ${res.exitCode}: ${res.text.slice(0, 300)}`);
    }
    return res.text;
  }

  async propose(task: string, ctx?: CouncilCallCtx): Promise<PlanProposal> {
    return parseProposal(await this.call("propose", proposeSystem(), proposeUser(task, ctx)));
  }

  async critique(anonProposals: LabeledProposal[], task: string, ctx?: CouncilCallCtx): Promise<PlanCritique[]> {
    return parseCritiques(await this.call("critique", critiqueSystem(), critiqueUser(anonProposals, task, ctx)));
  }

  async judge(
    anonProposals: LabeledProposal[],
    critiques: PlanCritique[],
    task: string,
    ctx?: CouncilCallCtx,
  ): Promise<CouncilVerdict> {
    return parseVerdict(await this.call("judge", judgeSystem(), judgeUser(anonProposals, critiques, task, ctx)));
  }
}

// ── provider adapter ──────────────────────────────────────────────────────────

/** A council seat backed by a raw-model Provider (constrained decoding when supported). */
export class ProviderClientAdapter implements CouncilClientPort {
  readonly kind = "provider" as const;
  /** Provider.complete() reports no token usage — always null (hosts do report). */
  lastUsage: CouncilUsage | null = null;

  constructor(
    readonly id: string,
    private provider: Provider,
  ) {}

  private async call(
    system: string,
    user: string,
    schema: { name: string; schema: Record<string, unknown> },
  ): Promise<string> {
    // Prefer constrained decoding (the backend guarantees parseable JSON); backends that
    // reject response_format/output_config fall back to the plain prompt — the caller's
    // parse-and-repair path still applies (same pattern as decomposeTasks).
    try {
      return await this.provider.complete(user, { system, maxTokens: 4000, jsonSchema: schema });
    } catch {
      return await this.provider.complete(user, { system, maxTokens: 4000 });
    }
  }

  async propose(task: string, ctx?: CouncilCallCtx): Promise<PlanProposal> {
    return parseProposal(
      await this.call(proposeSystem(), proposeUser(task, ctx), {
        name: "council_proposal",
        schema: PROPOSAL_JSON_SCHEMA,
      }),
    );
  }

  async critique(anonProposals: LabeledProposal[], task: string, ctx?: CouncilCallCtx): Promise<PlanCritique[]> {
    const labels = anonProposals.map((p) => p.label);
    return parseCritiques(
      await this.call(critiqueSystem(), critiqueUser(anonProposals, task, ctx), {
        name: "council_critique",
        schema: critiqueJsonSchema(labels),
      }),
    );
  }

  async judge(
    anonProposals: LabeledProposal[],
    critiques: PlanCritique[],
    task: string,
    ctx?: CouncilCallCtx,
  ): Promise<CouncilVerdict> {
    const labels = anonProposals.map((p) => p.label);
    return parseVerdict(
      await this.call(judgeSystem(), judgeUser(anonProposals, critiques, task, ctx), {
        name: "council_verdict",
        schema: verdictJsonSchema(labels),
      }),
    );
  }
}

// ── spec resolution ───────────────────────────────────────────────────────────

/**
 * Build a council client from a CLI spec:
 *   - `"provider"`            → the default raw-model provider (MODEL_PRIMARY / auto chain)
 *   - `"provider:<nombre>"`   → that provider (anthropic | openrouter | lmstudio | openai-compat | auto)
 *   - anything else           → a known host name (claude-code | codex | antigravity), read-only
 */
export async function makeCouncilClient(spec: string, opts: HostClientOpts = {}): Promise<CouncilClientPort> {
  const s = spec.trim();
  if (s === "provider" || s.startsWith("provider:")) {
    const which = s === "provider" ? undefined : s.slice("provider:".length).trim() || undefined;
    const provider = await getProvider(which);
    return new ProviderClientAdapter(`provider:${provider.name}`, provider);
  }
  if (!HOST_SPECS[s]) {
    throw new Error(
      `Spec de cliente desconocido '${spec}'. Usa un host (${Object.keys(HOST_SPECS).join(" | ")}) ` +
        "o 'provider[:anthropic|openrouter|lmstudio|openai-compat|auto]'.",
    );
  }
  return HostClientAdapter.forHost(s, opts);
}
