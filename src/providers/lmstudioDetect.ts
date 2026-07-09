/**
 * LM Studio load-state detection: align LMSTUDIO_MODEL with the model that is
 * ACTUALLY loaded in the server instead of failing (or silently pointing at an
 * unloaded one).
 *
 * LM Studio serves two APIs on the same port:
 *   - `/v1/*` (OpenAI-compat): what OpenAIProvider talks to. `/v1/models` lists
 *     DOWNLOADED models with no load state.
 *   - `/api/v0/*` (native REST): `/api/v0/models` adds `state: loaded|not-loaded`,
 *     `loaded_context_length` and `capabilities` — that is what we query here.
 *
 * Two consumers:
 *   - `getProvider("lmstudio")` calls `detectLmStudioModel` when LMSTUDIO_MODEL is
 *     empty (per-process, nothing persisted).
 *   - `aitl models --detect` persists the result via `planLmStudioDetection`
 *     (ENV-style updates for config/store.ts).
 *
 * This module stays pure/injectable (no `settings` import): callers pass the base
 * URL and tests pass a fake `fetchImpl`.
 */

export interface LmStudioModelInfo {
  id: string;
  /** "llm" | "vlm" | "embeddings" — absent on older servers (treated as chat-capable). */
  type?: string;
  /** "loaded" | "not-loaded" */
  state?: string;
  max_context_length?: number;
  /** Context the server actually allocated for the loaded instance. */
  loaded_context_length?: number;
  capabilities?: string[];
}

/** `http://host:1234/v1` (or without the suffix) → `http://host:1234/api/v0/models`. */
export function nativeModelsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/api/v0/models`;
}

export interface FetchModelsOpts {
  timeoutMs?: number;
  /** Tests only: replaces global fetch. */
  fetchImpl?: typeof fetch;
}

/** Query `/api/v0/models`. Throws an actionable error when the server is unreachable. */
export async function fetchLmStudioModels(
  baseUrl: string,
  opts: FetchModelsOpts = {},
): Promise<LmStudioModelInfo[]> {
  const url = nativeModelsUrl(baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
  } catch (err) {
    throw new Error(
      `lmstudio: no se pudo consultar ${url} (${err instanceof Error ? err.message : String(err)}). ` +
        "¿Está corriendo el servidor? Arráncalo con `lms server start` o desde la pestaña Developer.",
    );
  }
  if (!res.ok) throw new Error(`lmstudio: ${url} respondió HTTP ${res.status}.`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(body?.data)) {
    throw new Error(`lmstudio: respuesta inesperada de ${url} (sin \`data[]\`).`);
  }
  return body.data.filter(
    (m): m is LmStudioModelInfo => typeof (m as { id?: unknown }).id === "string",
  );
}

const CHAT_TYPES = new Set(["llm", "vlm"]);

/** Loaded models usable for chat (embeddings excluded; unknown type = chat-capable). */
export function loadedChatModels(models: LmStudioModelInfo[]): LmStudioModelInfo[] {
  return models.filter((m) => m.state === "loaded" && (m.type == null || CHAT_TYPES.has(m.type)));
}

export type DetectionPlan =
  | {
      ok: true;
      model: LmStudioModelInfo;
      /** ENV-style keys ready for writeConfigFile / updateEnvFile. */
      updates: { LMSTUDIO_MODEL: string; LMSTUDIO_MAX_CONTEXT?: string };
    }
  | { ok: false; reason: "none_loaded" | "ambiguous" | "pick_not_loaded"; loaded: LmStudioModelInfo[] };

/**
 * Decide what to configure from a models listing. Without `pick` it only succeeds
 * when EXACTLY one chat model is loaded — ambiguity is the user's call, never a
 * silent first-of-list. LMSTUDIO_MAX_CONTEXT comes from `loaded_context_length`
 * (what the server really allocated), omitted when the API doesn't report it.
 */
export function planLmStudioDetection(models: LmStudioModelInfo[], pick?: string): DetectionPlan {
  const loaded = loadedChatModels(models);
  const chosen = pick ? loaded.find((m) => m.id === pick) : loaded.length === 1 ? loaded[0] : undefined;
  if (!chosen) {
    const reason = pick ? "pick_not_loaded" : loaded.length === 0 ? "none_loaded" : "ambiguous";
    return { ok: false, reason, loaded };
  }
  const updates: { LMSTUDIO_MODEL: string; LMSTUDIO_MAX_CONTEXT?: string } = {
    LMSTUDIO_MODEL: chosen.id,
  };
  const ctx = chosen.loaded_context_length;
  if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
    updates.LMSTUDIO_MAX_CONTEXT = String(Math.floor(ctx));
  }
  return { ok: true, model: chosen, updates };
}

/**
 * One-shot detection for `getProvider("lmstudio")`: the single loaded chat model,
 * or an actionable throw (server down / nothing loaded / more than one loaded).
 */
export async function detectLmStudioModel(
  baseUrl: string,
  opts: FetchModelsOpts = {},
): Promise<LmStudioModelInfo> {
  const plan = planLmStudioDetection(await fetchLmStudioModels(baseUrl, opts));
  if (plan.ok) return plan.model;
  if (plan.reason === "ambiguous") {
    throw new Error(
      `lmstudio: hay ${plan.loaded.length} modelos cargados (${plan.loaded.map((m) => m.id).join(", ")}). ` +
        "Elige uno con `aitl models --detect <id>` o fija LMSTUDIO_MODEL.",
    );
  }
  throw new Error(
    "lmstudio: el servidor responde pero no hay ningún modelo cargado. " +
      "Carga uno en LM Studio (`lms load <id>`) o fija LMSTUDIO_MODEL para que el modo JIT lo cargue bajo demanda.",
  );
}
