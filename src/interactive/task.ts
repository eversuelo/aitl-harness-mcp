/**
 * «Task» branch flows for the interactive panel (P9) — Planear / Delegar / Council.
 *
 * The flows run IN-PROCESS under the menu's suspend() (the menu's raw keyboard handling
 * is off and its stdin is paused — ADR-0045). Host children are spawned by the existing
 * adapters with PIPED stdio, so no child ever competes with the TUI for the TTY.
 *
 * Degradation contract (same as `aitl council` / `aitl init`, F9):
 *   - sin Mongo  → the flow RUNS with one loud warning and persists nothing.
 *   - sin modelo → Planear is disabled upstream (computeTaskActions carries the reason).
 *   - sin hosts  → Delegar/Council are disabled upstream with the reason.
 *
 * Heavy modules (db, providers, hosts, council, sdd) are imported lazily so opening the
 * panel stays instant.
 */

import { homedir } from "node:os";
import type { CouncilSeats, HostAvailability } from "./taskLogic.js";

/** Terminal I/O seam the menu provides (readline-backed); injectable for tests. */
export interface TaskIO {
  write(text: string): void;
  question(prompt: string): Promise<string>;
}

const confirmed = (answer: string): boolean => /^\s*[sy]/i.test(answer);

/**
 * Probe the Mongo backend once (primary → fallback). `false` = degraded mode; the
 * caller prints the standard "sin backend" warning and skips persistence.
 */
async function probeBackend(io: TaskIO): Promise<boolean> {
  try {
    const { connectWithFallback } = await import("../db/client.js");
    const res = await connectWithFallback();
    if (res.label === "fallback") io.write(`[aitl] primary MongoDB unreachable; using fallback: ${res.uri}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Numbered host picker. Returns the chosen host name, or null when cancelled/invalid. */
async function pickHost(io: TaskIO, hosts: HostAvailability[], label: string): Promise<string | null> {
  io.write(`${label}:\n`);
  hosts.forEach((h, i) => {
    io.write(`  ${i + 1}. ${h.name}  (${h.via === "override" ? `override → ${h.command}` : h.command})\n`);
  });
  const answer = (await io.question(`Elige [1-${hosts.length}] (vacío cancela): `)).trim();
  if (!answer) return null;
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= hosts.length) {
    io.write("(opción inválida — cancelado)\n");
    return null;
  }
  return hosts[idx].name;
}

// ── PLANEAR: SDD pipeline in preview mode, confirm-before-persist ─────────────

export async function planFlow(project: string, io: TaskIO): Promise<void> {
  const task = (await io.question("Tarea a planear: ")).trim();
  if (!task) {
    io.write("(cancelado)\n");
    return;
  }
  let provider: import("../providers/base.js").Provider;
  try {
    const { getProviderWithFallback } = await import("../providers/base.js");
    provider = await getProviderWithFallback((from, to, error) =>
      io.write(`[aitl] provider '${from}' falló (${error}); probando '${to}'…\n`),
    );
  } catch (err) {
    io.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  const hasBackend = await probeBackend(io);
  if (!hasBackend) {
    io.write("[task] sin backend Mongo — la vista previa corre SIN persistir (spec/design/tasks solo en pantalla).\n");
  }
  io.write(`Generando spec → design → tasks con '${provider.name}' (puede tardar)…\n`);
  const { runSddPipelinePreview } = await import("../specs/pipeline.js");
  const preview = await runSddPipelinePreview(task, { project, provider });

  for (const doc of preview.artifacts) {
    io.write(`\n━━━ ${doc.type} · ${doc.slug} ━━━\n${doc.body}\n`);
  }
  io.write(`\ntasks (${preview.result.tasks.length}):\n`);
  for (const t of preview.result.tasks) {
    io.write(`  ${t.id}  ${t.title}${t.dependsOn.length ? `  [after: ${t.dependsOn.join(", ")}]` : ""}\n`);
  }
  if (!hasBackend) return;

  const answer = await io.question("\n¿Persistir como memorias spec/design/task? [s/N] ");
  if (!confirmed(answer)) {
    io.write("(no persistido)\n");
    return;
  }
  const slugs = await preview.persist();
  io.write(`Persistido: ${slugs.join(", ")}\n`);
}

// ── EXPORTAR: task memory docs → <dir>/tasks/*.md (ADR-0062) ──────────────────

export async function exportTasksFlow(project: string, io: TaskIO): Promise<void> {
  const answer = (await io.question("Directorio destino para <dir>/tasks/*.md (vacío cancela): ")).trim();
  if (!answer) {
    io.write("(cancelado)\n");
    return;
  }
  const dir = answer.replace(/^~(?=\/|$)/, homedir());
  const hasBackend = await probeBackend(io);
  if (!hasBackend) {
    io.write("[task] sin backend Mongo — no hay tareas durables que exportar.\n");
    return;
  }
  const { exportTasks } = await import("../sync/export.js");
  const res = await exportTasks(project, dir);
  for (const p of res.written) io.write(`  + ${p}\n`);
  const total = res.written.length + res.unchanged.length;
  io.write(
    `${res.written.length} escritos · ${res.unchanged.length} sin cambios` +
      (total === 0 ? " — el proyecto no tiene tareas SDD (genera con Planear o `aitl sdd`)" : "") +
      "\n",
  );
}

// ── DELEGAR: run-host over an available host ──────────────────────────────────

/**
 * Execute `prompt` on `host`. With a Mongo backend this is the full `run-host` wrap
 * (hydration + run/telemetry + tokens); without one it degrades to a direct host run
 * with the standard warning — the flow still runs, nothing persists.
 */
export async function executeOnHost(project: string, io: TaskIO, host: string, prompt: string): Promise<void> {
  const hasBackend = await probeBackend(io);
  const t0 = Date.now();
  io.write(`Ejecutando en '${host}'… (la salida del host llega al terminar)\n`);
  if (hasBackend) {
    const { runOnHost } = await import("../hosts/run.js");
    const result = await runOnHost(prompt, project, { host });
    const tu = result.token_usage;
    const cost = (result.meta?.cost_usd as number | null) ?? null;
    io.write(`\nrun_id=${result.run_id} host=${result.host} status=${result.status} exit=${result.exit_code}\n`);
    io.write(
      `tokens: in=${tu.input} out=${tu.output} total=${tu.input + tu.output}` +
        (cost != null ? ` cost_usd=${cost}` : "") +
        ` duración=${Date.now() - t0}ms\n\n`,
    );
    io.write(`${result.final_text}\n`);
  } else {
    io.write("[task] sin backend Mongo — el host corre SIN persistir (run/telemetría omitidos).\n");
    const { getHost } = await import("../hosts/base.js");
    const res = await getHost(host).runTask(prompt);
    const u = res.usage;
    io.write(
      `\nhost=${host} exit=${res.exitCode}` +
        (u ? ` tokens: in=${u.input} out=${u.output} total=${u.input + u.output}` : "") +
        ` duración=${Date.now() - t0}ms\n\n`,
    );
    io.write(`${res.text}\n`);
  }
}

export async function delegateFlow(project: string, io: TaskIO, hosts: HostAvailability[]): Promise<void> {
  const available = hosts.filter((h) => h.available);
  if (!available.length) {
    io.write("Sin hosts disponibles.\n");
    return;
  }
  const host = await pickHost(io, available, "Hosts disponibles");
  if (!host) return;
  const task = (await io.question("Tarea a delegar: ")).trim();
  if (!task) {
    io.write("(cancelado)\n");
    return;
  }
  await executeOnHost(project, io, host, task);
}

// ── COUNCIL: deliberate, show verdict, offer to delegate the winning plan ─────

export async function councilFlow(
  project: string,
  io: TaskIO,
  seats: CouncilSeats,
  hosts: HostAvailability[],
): Promise<void> {
  const task = (await io.question("Tarea a deliberar (council): ")).trim();
  if (!task) {
    io.write("(cancelado)\n");
    return;
  }
  const hasBackend = await probeBackend(io);
  if (!hasBackend) {
    io.write("[aitl council] sin backend Mongo — el consejo corre SIN persistir (run/eventos/memoria omitidos).\n");
  }
  const { makeCouncilClient } = await import("../council/adapters.js");
  const { runCouncil } = await import("../council/orchestrator.js");
  const proponents = await Promise.all(seats.proponents.map((s) => makeCouncilClient(s)));
  const judge = await makeCouncilClient(seats.judge);
  io.write(`Council: proponentes=${seats.proponents.join(", ")} · juez=${seats.judge}. Deliberando…\n`);

  const result = await runCouncil({
    project,
    task,
    proponents,
    judge,
    ...(hasBackend ? {} : { telemetry: null }),
    warn: (msg) => io.write(`${msg}\n`),
  });

  const { buildWinnerDelegationPrompt, formatCouncilSummary } = await import("../council/format.js");
  io.write("\n");
  for (const line of formatCouncilSummary(result)) io.write(`${line}\n`);

  // Handoff: delegate the winning plan to a host of the user's choice (run-host wrap).
  const prompt = buildWinnerDelegationPrompt(result);
  if (!prompt) {
    io.write("\n(sin plan ganador que delegar)\n");
    return;
  }
  const available = hosts.filter((h) => h.available);
  if (!available.length) {
    io.write("\n(sin hosts disponibles para delegar el plan ganador)\n");
    return;
  }
  const answer = await io.question("\n¿Delegar el plan ganador a un host? [s/N] ");
  if (!confirmed(answer)) return;
  const host = await pickHost(io, available, "Host para ejecutar el plan");
  if (!host) return;
  await executeOnHost(project, io, host, prompt);
}
