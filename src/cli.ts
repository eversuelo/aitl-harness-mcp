#!/usr/bin/env node
/**
 * AITL-Harness command-line interface (parity with aitl/cli.py).
 *
 *   aitl init-db                          create collections + indexes
 *   aitl check-db                         validate MongoDB connectivity/auth
 *   aitl ingest --path DIR --project P    ingest markdown memory + transcripts
 *   aitl search "query" --project P       semantic search (vector) with text fallback
 *   aitl run "task" --project P           run the agent loop
 *   aitl synthesize --project P           compact a project's memory (force optional)
 *   aitl repomap --root DIR --project P   build/print the repo map
 *   aitl adr-sync --dir docs/adr --project P  mirror ADRs into Mongo
 *   aitl sync --project P                 bidirectional markdown sync (Mongo ⇄ .aitl + docs/adr)
 *   aitl export --adapter cursor --project P  project canon into a tool's format
 *   aitl mcp                              run the MCP server (stdio) for Claude Code
 *   aitl interactive | -i                interactive control panel (supervise MCP/UI)
 *   aitl ui --project P                   memory-admin web UI (HTTP API + Vite)
 *   aitl config {path,show,export,import,set,unset}  user-level config profile
 *   aitl prompt {add,list,search} --project P        durable prompt history
 *   aitl init agent --interactive        write AGENTS.md (consult the MCP on every decision)
 *   aitl migrate-atlas <uri> --to-db P   copy a DB to another cluster (local → Atlas)
 */

import { Command } from "commander";
import { closeClient } from "./db/client.js";

const program = new Command();
program
  .name("aitl")
  .description("AITL-Harness — Agent In The Loop.")
  .version("0.1.0")
  // Positional options (here + on `init`) keep the parent `aitl init` options
  // (--project/--force/…) from swallowing the SAME-named options of its subcommands
  // (`init agent|claude --project …`). Program-level flags (-i) go before the command.
  .enablePositionalOptions()
  .option("-i, --interactive", "Launch the interactive control panel (supervise MCP/UI, run commands).");

// Commands that never touch MongoDB — skip the connection probe so they stay instant
// and work offline (the interactive panel only supervises child processes). `council`
// probes Mongo itself and DEGRADES to non-persistent deliberation when it is down.
const NO_DB_COMMANDS = new Set(["interactive", "menu", "config", "init", "help", "check-db", "models", "council"]);

// Commands that still do useful work WITHOUT Mongo: the host agent runs and only the
// durable telemetry is skipped. For these a DB outage DEGRADES (warn + continue) instead
// of aborting — losing a whole run to a transient outage is worse than losing its metrics.
// This is exactly what corrupted the raytracer measurement (false gate-fails + lost work
// when Atlas timed out mid-course). `run` (native loop) is NOT here: it persists every
// iteration, so it keeps requiring Mongo rather than stalling mid-loop.
const DEGRADABLE_COMMANDS = new Set(["run-host"]);

// Resolve the working MongoDB URI (primary → fallback) once, before any DB command runs,
// so every subcommand inherits the resilient local-and/or-Atlas connection.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  // Skip the DB probe if the command OR any ancestor is a no-DB command, so nested
  // subcommands (e.g. `init claude`, `config set`) also stay offline and exit cleanly.
  for (let cmd: Command | null = actionCommand; cmd; cmd = cmd.parent) {
    if (NO_DB_COMMANDS.has(cmd.name())) return;
  }
  const { connectWithFallback } = await import("./db/client.js");
  try {
    const result = await connectWithFallback();
    if (result.label === "fallback") {
      console.error(`[aitl] primary MongoDB unreachable; using fallback: ${result.uri}`);
    }
  } catch (err) {
    // A degradable command runs WITHOUT persistence (agent still executes; telemetry
    // skipped). Signal it downstream via env and continue instead of aborting.
    for (let cmd: Command | null = actionCommand; cmd; cmd = cmd.parent) {
      if (DEGRADABLE_COMMANDS.has(cmd.name())) {
        process.env.AITL_DB_DEGRADED = "1";
        console.error(err instanceof Error ? err.message : String(err));
        console.error("[aitl] Mongo no disponible — corriendo SIN persistir telemetría (run degradado).");
        return;
      }
    }
    // Fail fast with one clear message. Letting the command proceed just moves the
    // failure to the first DB access, where it surfaces as a confusing stall/stack.
    console.error(err instanceof Error ? err.message : String(err));
    console.error("\n[aitl] No hay MongoDB accesible. Revisa MONGODB_URI/MONGODB_URI_FALLBACK o corre `aitl check-db`.");
    process.exit(1);
  }
});

async function launchInteractive(): Promise<void> {
  const { runInteractive } = await import("./interactive/menu.js");
  await runInteractive();
}

// Bare `aitl` and `aitl -i` open the interactive panel.
program.action(launchInteractive);

program
  .command("interactive")
  .alias("menu")
  .description("Launch the interactive control panel (supervise MCP/UI, run commands).")
  .action(launchInteractive);

program
  .command("check-db")
  .description("Validate MongoDB connectivity/auth (tries primary then fallback) and RBAC readiness (users collection, unique indexes, root user).")
  .action(async () => {
    const { connectWithFallback, getDb } = await import("./db/client.js");
    const result = await connectWithFallback({
      onAttempt: (a) =>
        console.log(a.ok ? `  ✓ ${a.label}: ${a.uri}` : `  ✗ ${a.label}: ${a.uri} — ${a.error}`),
    });
    console.log(`MongoDB ping OK via ${result.label}: ${result.uri} (db=${result.dbName})`);
    if (result.serverVersion !== undefined) {
      console.log(`Server version: ${result.serverVersion}`);
    }
    const { checkRbac } = await import("./auth/checkdb.js");
    const rbac = await checkRbac(getDb());
    for (const line of rbac.lines) console.log(line);
    await closeClient();
    if (!rbac.ready) process.exitCode = 1;
  });

program
  .command("init-db")
  .description("Create collections, scalar/text indexes and Atlas vector indexes.")
  .action(async () => {
    const { initIndexes } = await import("./db/indexes.js");
    const db = await initIndexes();
    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    console.log(`OK. Collections: ${names.join(", ")}`);
    await closeClient();
  });

program
  .command("ingest")
  .requiredOption("--path <dir>", "Directory of markdown memory and/or transcripts.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--repo <repo>", "Repo sub-scope to tag the ingested docs with.")
  .description("Parse -> classify -> embed -> upsert markdown memory.")
  .action(async (opts) => {
    const { embedOne } = await import("./ingest/embedder.js");
    const { parseMarkdownDir } = await import("./ingest/markdown.js");
    const { Classifier } = await import("./memory/classifier.js");
    const { MemoryStore } = await import("./memory/store.js");
    const { currentBranch } = await import("./util/git.js");
    const store = new MemoryStore();
    const clf = new Classifier();
    const branch = currentBranch();
    const docs = await parseMarkdownDir(opts.path, opts.project);
    for (const doc of docs) {
      if (opts.repo) doc.repo = opts.repo;
      await clf.classifyMemory(doc);
      doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
      await store.upsertMemory(doc, { actor: { id: CLI_ACTOR.id, role: CLI_ACTOR.role }, branch });
    }
    console.log(`Ingested ${docs.length} memory docs into project '${opts.project}'.`);
    await closeClient();
  });

program
  .command("search")
  .argument("<query>", "Search query.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--collection <c>", "memory | messages | decisions", "memory")
  .option("--limit <n>", "Max results", "10")
  .description("Semantic search via $vectorSearch (falls back to text search on error).")
  .action(async (query, opts) => {
    const { embedOne } = await import("./ingest/embedder.js");
    const { MemoryStore } = await import("./memory/store.js");
    const store = new MemoryStore();
    const limit = Number(opts.limit);
    let hits: Record<string, unknown>[];
    try {
      hits = await store.vectorSearch(opts.collection, await embedOne(query), { project: opts.project, limit });
    } catch (exc) {
      console.log(`(vector search unavailable: ${String(exc)}; using text search)`);
      hits = await store.textSearch(opts.collection, query, { project: opts.project, limit });
    }
    for (const h of hits) {
      const score = typeof h.score === "number" ? h.score.toFixed(3) : "0.000";
      console.log(`[${score}] ${h.slug ?? String(h.content ?? "").slice(0, 80)}`);
    }
    await closeClient();
  });

program
  .command("run")
  .argument("<task>", "Task prompt.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--model <m>", "auto | anthropic | openrouter | lmstudio | openai-compat | primary | secondary", "primary")
  .option("--bare", "C0 baseline: no hydration, no skills, no gates (improvised agent).")
  .option("--verify-cmd <cmd>", "Quality gate: shell command that must exit 0 to end the run (e.g. a test cmd).")
  .option("--roles <list>", "Comma-separated engineering roles (H11) to attach (e.g. security,architect,qa).")
  .option("--ask", "Human-in-the-loop: confirm side-effect tools (write_file, shell, mcp__*) before they run.")
  .option("--ask-fallback <policy>", "Non-TTY behavior for --ask: deny | allow.", "deny")
  .option("--mcp [path]", "Mount tools from MCP servers declared in .mcp.json (or the given path).")
  .option("--stream", "Stream assistant text deltas to stdout as they arrive (ADR-0005).")
  .description("Run the model-agnostic agent loop, persisting the run/transcript to Mongo.")
  .action(async (task, opts) => {
    const { runAgent } = await import("./orchestration/graph.js");
    const { getProvider } = await import("./providers/base.js");
    // Resolve the provider FIRST (F9): `--model auto` builds the same fallback chain as
    // `aitl chat` (getProvider('auto') → getProviderWithFallback). A missing backend is a
    // config problem → actionable message, no stack trace.
    let provider: import("./providers/base.js").Provider;
    try {
      provider = await getProvider(opts.model);
    } catch (err) {
      const { NO_BACKEND_MESSAGE, providerStatus } = await import("./providers/base.js");
      // With ZERO backends configured the root cause is global, not the chosen name:
      // show the actionable options (memory mode / run-host) instead of a terse key error.
      console.error(!providerStatus().active ? NO_BACKEND_MESSAGE : String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
      await closeClient();
      return;
    }
    // --verify-cmd turns the quality gate into the loop's termination condition: the run
    // only finishes when the command exits 0, so "I'm done" before green can't end it.
    const verify = opts.verifyCmd
      ? async (): Promise<true | string> => {
          const { execSync } = await import("node:child_process");
          try {
            execSync(opts.verifyCmd, { stdio: "pipe", encoding: "utf8" });
            return true;
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            return `Quality gate failed (\`${opts.verifyCmd}\`). Fix it, then finish:\n${(err.stdout ?? "") + (err.stderr ?? "") || err.message || "non-zero exit"}`.slice(0, 2000);
          }
        }
      : undefined;
    // --bare operationalizes condition C0 (memory/specs/gates OFF); default is C2 (all ON).
    const roles = opts.roles ? String(opts.roles).split(",").map((r: string) => r.trim()).filter(Boolean) : undefined;
    // --mcp mounts external MCP servers' tools (ADR-0041). The CLI owns the lifecycle
    // (mount here, close in finally) so runAgent stays a pure library.
    let mcpMount: import("./mcpclient/client.js").McpMount | null = null;
    if (opts.mcp) {
      const { mountMcpTools } = await import("./mcpclient/client.js");
      const { defaultRegistry } = await import("./tools/base.js");
      mcpMount = await mountMcpTools({
        registry: defaultRegistry,
        configPath: typeof opts.mcp === "string" ? opts.mcp : undefined,
        onEvent: (ev) => {
          console.error(`[mcp] ${ev.server}: ${ev.ok ? `${ev.tools} tools mounted` : `FAILED — ${ev.error}`}`);
        },
      });
      // Durable trace of what was reachable (project-scoped: no run exists yet).
      try {
        const { MemoryStore } = await import("./memory/store.js");
        const { makeEvent } = await import("./models/event.model.js");
        const store = new MemoryStore();
        for (const s of mcpMount.servers) {
          await store.logEvent(await makeEvent({ project: opts.project, type: "mcp_connect", payload: { ...s } }));
        }
      } catch {
        // telemetry is best-effort
      }
    }
    try {
      const result = await runAgent(task, opts.project, {
        provider,
        installDefaultTools: true,
        ...(verify ? { verify } : {}),
        ...(roles ? { roles } : {}),
        ...(opts.ask ? { ask: true, askPolicy: opts.askFallback === "allow" ? "allow" as const : "deny" as const } : {}),
        ...(opts.stream ? { onDelta: (d: { text: string }) => process.stdout.write(d.text) } : {}),
        ...(opts.bare ? { hydrate: false, skills: false, gates: false } : {}),
      });
      if (opts.stream) process.stdout.write("\n\n"); // separate the streamed text from the summary line
      console.log(`run_id=${result.run_id} iters=${result.iters} gate_denials=${result.gate_denials}`);
      if (result.decision_brief) {
        console.log(`\n── Decision brief (H11) ── ${result.decision_brief.summary}`);
        for (const v of result.decision_brief.verdicts) {
          console.log(`  [${v.role}/${v.mode}] ${v.stance}${v.findings.length ? `: ${v.findings.join("; ")}` : ""}`);
        }
      }
      if (!opts.stream) console.log(`\n${result.final_text}`); // already streamed live
    } finally {
      await mcpMount?.close();
      await closeClient();
    }
  });

program
  .command("chat")
  .option("--project <project>", "Project scope (default: $AITL_PROJECT or the cwd folder name).")
  .option("--model <m>", "auto | anthropic | openrouter | lmstudio | openai-compat | primary | secondary", "auto")
  .option("--ask", "Confirm side-effect tools before they run (y/n/always).")
  .option("--ask-fallback <policy>", "Non-TTY behavior for --ask: deny | allow.", "deny")
  .option("--mcp [path]", "Mount tools from MCP servers declared in .mcp.json (or the given path).")
  .description("Claude Code–style chat over the agent loop (streams, tool trace, /help; ADR-0003).")
  .action(async (opts) => {
    const { chatRepl } = await import("./repl/chat.js");
    const { basename } = await import("node:path");
    const project: string = opts.project ?? process.env.AITL_PROJECT?.trim() ?? basename(process.cwd());
    try {
      await chatRepl({
        project,
        model: opts.model,
        ask: Boolean(opts.ask),
        askPolicy: opts.askFallback === "allow" ? "allow" : "deny",
        mcp: opts.mcp,
      });
    } catch (err) {
      // Config errors (no LLM set up) deserve a hint, not a stack trace.
      console.error(String(err instanceof Error ? err.message : err));
      console.error("\nRevisa qué backends tienes con: aitl models");
      process.exitCode = 1;
    } finally {
      await closeClient();
    }
  });

program
  .command("models")
  .option("--json", "Print the raw status object as JSON.")
  .description("Show which LLM backends are configured, the active one, and the fallback chain.")
  .action(async (opts) => {
    const { providerStatus } = await import("./providers/base.js");
    const st = providerStatus();
    if (opts.json) {
      console.log(JSON.stringify(st, null, 2));
      await closeClient();
      return;
    }
    console.log("LLMs configurados:");
    for (const p of st.providers) {
      const mark = p.configured ? "●" : "○";
      const tag = p.name === st.active ? "  ← activo" : "";
      console.log(`  ${mark} ${p.name.padEnd(14)} ${p.configured ? p.model : `no configurado (${p.via})`}${tag}`);
    }
    if (st.fallbacks.length) console.log(`  fallback: ${st.fallbacks.join(" → ")}`);
    if (st.aitl_api_key) console.log(`  AITL_API_KEY → ${st.aitl_api_key}`);
    if (!st.active) {
      console.log(
        "\nNingún LLM configurado. Define AITL_API_KEY (sk-ant-*/sk-or-*), ANTHROPIC_API_KEY,\n" +
          "OPENROUTER_API_KEY, LMSTUDIO_MODEL, o OPENAI_COMPAT_BASE_URL+OPENAI_COMPAT_MODEL.",
      );
    }
    await closeClient();
  });

program
  .command("sdd")
  .argument("<prompt>", "Spec or task prompt (auto-classified; ad-hoc tasks get a generated spec).")
  .requiredOption("--project <project>", "Project scope.")
  .option("--model <m>", "auto | anthropic | openrouter | lmstudio | openai-compat | primary | secondary", "primary")
  .option("--repo <repo>", "Repo sub-scope to tag the artifacts with.")
  .option("--max-tasks <n>", "Maximum number of tasks to decompose into.", "10")
  .description("SDD phase D (ADR-0042): spec → design doc → task decomposition, persisted as linked memory artifacts.")
  .action(async (prompt, opts) => {
    const { runSddPipeline } = await import("./specs/pipeline.js");
    const { getProvider } = await import("./providers/base.js");
    const res = await runSddPipeline(prompt, {
      project: opts.project,
      provider: await getProvider(opts.model),
      repo: opts.repo ?? null,
      maxTasks: Number(opts.maxTasks) || 10,
    });
    console.log(
      `pipeline_id=${res.pipeline_id} spec=${res.spec_slug}${res.generated_spec ? " (generated)" : " (verbatim)"} design=${res.design_slug}`,
    );
    console.log(`tasks (${res.tasks.length}):`);
    for (const t of res.tasks) {
      console.log(`  ${t.id}  ${t.title}${t.dependsOn.length ? `  [after: ${t.dependsOn.join(", ")}]` : ""}`);
    }
    await closeClient();
  });

program
  .command("intervene")
  .argument("<runId>", "Run id the human intervened on.")
  .requiredOption("--reason <text>", "What you had to intervene on and why.")
  .option("--minutes <n>", "Approximate duration of the intervention.", "0")
  .description("Record a human intervention on a run (Tabla 4.3 #6 supervisión humana).")
  .action(async (runId, opts) => {
    const { MemoryStore } = await import("./memory/store.js");
    const { makeEvent } = await import("./models/event.model.js");
    const { ensureMongoose } = await import("./db/mongoose.js");
    const { RunModel } = await import("./models/run.model.js");
    await ensureMongoose();
    const run = await RunModel.findOne({ _id: runId }).lean();
    const project = (run?.project as string) ?? "unknown";
    await new MemoryStore().logEvent(await makeEvent({ project, run_id: runId, type: "human_intervention", payload: { reason: opts.reason, minutes: Number(opts.minutes) } }));
    console.log(`Recorded human intervention on ${runId} (${opts.minutes} min): ${opts.reason}`);
    await closeClient();
  });

program
  .command("run-show")
  .argument("<runId>", "Run id to summarize.")
  .description("Show a run's measurable totals: tokens, iterations, tool calls, gate denials, hydrate.")
  .action(async (runId) => {
    const { getDb } = await import("./db/client.js");
    const { ensureMongoose } = await import("./db/mongoose.js");
    const { RunModel } = await import("./models/run.model.js");
    await ensureMongoose();
    const db = getDb();
    const run = (await RunModel.findOne({ _id: runId }).lean()) as Record<string, unknown> | null;
    if (!run) {
      console.log(`(no run '${runId}')`);
      await closeClient();
      return;
    }
    // Event counts (counted from the events collection) complement the run rollup.
    const events = await db.collection("events").find({ run_id: runId }).toArray();
    const byType: Record<string, number> = {};
    let hydrateSections: Record<string, unknown> | null = null;
    let interventionMinutes = 0;
    let approvalMs = 0;
    for (const e of events) {
      const t = String(e.type);
      byType[t] = (byType[t] ?? 0) + 1;
      if (t === "hydrate") hydrateSections = (e.payload as Record<string, unknown>) ?? null;
      if (t === "human_intervention") interventionMinutes += Number((e.payload as Record<string, unknown>)?.minutes ?? 0);
      if (t === "approval") approvalMs += Number((e.payload as Record<string, unknown>)?.ms ?? 0);
    }
    const tu = (run.token_usage as { input?: number; output?: number }) ?? {};
    const ms = run.started_at && run.ended_at ? new Date(run.ended_at as string).getTime() - new Date(run.started_at as string).getTime() : null;
    console.log(JSON.stringify({
      run_id: runId,
      project: run.project,
      model: run.model,
      status: run.status,
      started_at: run.started_at,
      ended_at: run.ended_at,
      duration_ms: ms,
      tokens: { input: tu.input ?? 0, output: tu.output ?? 0, total: (tu.input ?? 0) + (tu.output ?? 0) },
      // Host runs (Cara B) carry the host's own telemetry: cost, turns, cache breakdown.
      host_meta: run.host_meta ?? null,
      spec: run.spec ?? false,
      iters: run.iters ?? null,
      tool_calls: run.tool_calls ?? byType.tool_call ?? 0,
      gate_denials: run.gate_denials ?? byType.gate ?? 0,
      human_interventions: { count: byType.human_intervention ?? 0, minutes: interventionMinutes },
      // In-loop approvals (--ask, ADR-0040): the human's answer latency is supervision time.
      approvals: { count: byType.approval ?? 0, ms: approvalMs },
      supervision_minutes: interventionMinutes + approvalMs / 60000,
      roles: run.roles ?? [],
      decision_blocked: run.decision_blocked ?? false,
      review_events: { review: byType.review ?? 0, role_veto: byType.role_veto ?? 0, deliberation: byType.deliberation ?? 0 },
      event_counts: byType,
      hydrate: hydrateSections,
    }, null, 2));
    await closeClient();
  });

program
  .command("run-host")
  .argument("<task>", "Task prompt.")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--host <host>", "Agent host to run over: claude-code | codex | antigravity")
  .option("--cwd <dir>", "Working directory for the host process.")
  .option("--timeout <ms>", "Kill the host after N ms.")
  .option(
    "--permission-mode <mode>",
    "Explicit permission mode for the host CLI (claude-code: acceptEdits|plan|bypassPermissions; default acceptEdits).",
  )
  .option(
    "--allowed-tools <list>",
    'Tools to pre-approve, comma-separated (claude-code --allowedTools), e.g. "Bash(make:*),Bash(python3:*)".',
  )
  .option("--no-record-prompt", "Do not persist the prompt to the durable history.")
  .option("--no-spec-synthesis", "Do not synthesize spec-classified runs into durable memory.")
  .description("Run a task OVER an external agent host (Codex/Claude Code/Antigravity), wrapped with durable context + telemetry.")
  .action(async (task, opts) => {
    const { runOnHost } = await import("./hosts/run.js");
    // Permission flags travel explicitly on the argv so the host never depends on the
    // target directory's settings or folder trust (headless runs in an untrusted cwd
    // would otherwise silently deny every tool). The two flags are claude-code syntax;
    // other hosts take raw extra argv via AITL_HOST_ARGS_<NAME>.
    const hostArgs: string[] = [];
    if (opts.permissionMode) hostArgs.push("--permission-mode", opts.permissionMode);
    if (opts.allowedTools) hostArgs.push("--allowedTools", opts.allowedTools);
    if (hostArgs.length && opts.host !== "claude-code") {
      console.error(
        `[aitl run-host] --permission-mode/--allowed-tools are claude-code flags; for '${opts.host}' pass raw argv via AITL_HOST_ARGS_${opts.host.toUpperCase().replace(/-/g, "_")}.`,
      );
      process.exitCode = 1;
      await closeClient();
      return;
    }
    const result = await runOnHost(task, opts.project, {
      host: opts.host,
      cwd: opts.cwd,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
      hostArgs: hostArgs.length ? hostArgs : undefined,
      recordPrompt: opts.recordPrompt, // commander sets false for --no-record-prompt
      synthesizeSpec: opts.specSynthesis, // commander sets false for --no-spec-synthesis
    });
    const tu = result.token_usage;
    const cost = (result.meta?.cost_usd as number | null) ?? null;
    console.log(`run_id=${result.run_id} host=${result.host} status=${result.status} exit=${result.exit_code}`);
    console.log(
      `tokens: in=${tu.input} out=${tu.output} total=${tu.input + tu.output}` +
        (cost != null ? ` cost_usd=${cost}` : "") +
        ` spec=${result.spec}` +
        (result.synthesis_slug ? ` synthesis=${result.synthesis_slug}` : ""),
    );
    console.log(result.final_text);
    await closeClient();
  });

program
  .command("council")
  .argument("<task>", "Plan/task to deliberate on (nothing is executed).")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--hosts <list>", "Comma-separated council seats: claude-code | codex | antigravity | provider[:modelo].")
  .option("--judge <spec>", "Judge (host or provider[:modelo]); must differ from the proponents. Without it and ≥3 seats, the LAST seat judges.")
  .option("--rounds <n>", "Deliberation rounds: 1 propose + N-1 critique.", "2")
  .option("--cwd <dir>", "Working directory for host processes.")
  .option("--timeout <ms>", "Kill a host call after N ms.")
  .option("--json", "Print the full structured result as JSON.", false)
  .description("Plan-council (ADR-0003 v1): varios clientes PROPONEN un plan, se CRITICAN anónimamente con rúbrica y un JUEZ emite el veredicto — antes de ejecutar nada. Los hosts corren en modo solo-lectura.")
  .action(async (task, opts) => {
    const { makeCouncilClient } = await import("./council/adapters.js");
    const { runCouncil, splitCouncil } = await import("./council/orchestrator.js");
    const rounds = Number(opts.rounds);
    if (!Number.isInteger(rounds) || rounds < 1) {
      console.error(`[aitl council] --rounds inválido '${opts.rounds}' (entero ≥ 1).`);
      process.exitCode = 1;
      return;
    }
    const hostOpts = {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.timeout ? { timeoutMs: Number(opts.timeout) } : {}),
    };
    let proponents: import("./council/ports.js").CouncilClientPort[];
    let judge: import("./council/ports.js").CouncilClientPort;
    try {
      const specs = String(opts.hosts).split(",").map((s: string) => s.trim()).filter(Boolean);
      const clients = await Promise.all(specs.map((s: string) => makeCouncilClient(s, hostOpts)));
      const explicitJudge = opts.judge ? await makeCouncilClient(String(opts.judge), hostOpts) : undefined;
      ({ proponents, judge } = splitCouncil(clients, explicitJudge));
    } catch (err) {
      console.error(`[aitl council] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    // `council` skips the global DB probe: with Mongo down it DEGRADES (deliberates
    // without persisting) instead of aborting — same contract as `aitl init` (F9).
    let telemetry: import("./council/orchestrator.js").CouncilTelemetryStore | null | undefined;
    try {
      const { connectWithFallback } = await import("./db/client.js");
      const result = await connectWithFallback();
      if (result.label === "fallback") console.error(`[aitl] primary MongoDB unreachable; using fallback: ${result.uri}`);
    } catch {
      telemetry = null;
      console.error("[aitl council] sin backend Mongo — el consejo corre SIN persistir (run/eventos/memoria omitidos).");
    }
    try {
      const result = await runCouncil({
        project: opts.project,
        task,
        proponents,
        judge,
        rounds,
        ...(telemetry !== undefined ? { telemetry } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // Human summary: proposals → rubric table → verdict.
      console.log(
        `council run=${result.run_id ?? "(sin persistir)"} propuestas=${result.proposals.length} ` +
          `juez=${result.judge_id} rondas=${result.rounds} tokens=${result.token_usage.input}+${result.token_usage.output} ` +
          `duración=${result.duration_ms}ms`,
      );
      console.log("\nPropuestas:");
      for (const p of result.proposals) {
        console.log(`  [${p.label}] ${p.client_id} — ${p.proposal.steps.length} pasos, complejidad ${p.proposal.estimated_complexity}`);
        for (const s of p.proposal.steps) console.log(`      • ${s.title}`);
      }
      const labels = result.proposals.map((p) => p.label);
      const cell = (v: number | undefined): string => (v === undefined ? "  —  " : v.toFixed(2).padStart(5));
      const rows = Object.entries(result.rubric.weights).map(([c, w]) => [`${c} (${w})`, c] as const);
      const width = Math.max("criterio".length, ...rows.map(([head]) => head.length)) + 2;
      console.log("\nRúbrica (0–5, media ponderada de las críticas):");
      console.log(`  ${"criterio".padEnd(width)}${labels.map((l) => l.padStart(6)).join("")}`);
      for (const [head, criterion] of rows) {
        const row = labels.map((l) => ` ${cell(result.rubric.scores[l]?.criteria[criterion])}`).join("");
        console.log(`  ${head.padEnd(width)}${row}`);
      }
      console.log(`  ${"TOTAL".padEnd(width)}${labels.map((l) => ` ${cell(result.rubric.scores[l]?.total)}`).join("")}`);
      if (result.no_votes.length) {
        console.log("\nSin-voto:");
        for (const nv of result.no_votes) console.log(`  ${nv.client_id} (${nv.phase} r${nv.round}): ${nv.error}`);
      }
      const v = result.verdict;
      console.log(`\nVeredicto (juez ${result.judge_id}):`);
      console.log(`  Ganador: ${v.winner ? `${v.winner} — ${result.authors[v.winner]}` : "ninguno"}`);
      console.log(`  Síntesis: ${v.synthesis}`);
      console.log(`  Razonamiento: ${v.reasoning}`);
      if (result.memory_slug) console.log(`  Memoria design: ${result.memory_slug}`);
    } catch (err) {
      console.error(`[aitl council] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
    }
  });

program
  .command("orchestrate")
  .argument("<task>", "Master task prompt.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--model <m>", "auto | anthropic | openrouter | lmstudio | openai-compat | primary | secondary", "primary")
  .option("--max <n>", "Max parallel sub-agents.", "4")
  .description("Decompose a task, run sub-agents in parallel, and synthesize the result.")
  .action(async (task, opts) => {
    const { orchestrate } = await import("./orchestration/orchestrator.js");
    const { getProvider } = await import("./providers/base.js");
    const result = await orchestrate(task, opts.project, {
      provider: await getProvider(opts.model),
      maxSubagents: Number(opts.max),
      subAgentOpts: { installDefaultTools: true },
    });
    console.log(`run_id=${result.run_id} subagents=${result.subagents.length}`);
    for (const s of result.subagents) console.log(`  [${s.status}] ${s.task}`);
    console.log("\n" + result.final_text);
    await closeClient();
  });

program
  .command("synthesize")
  .requiredOption("--project <project>", "Project scope.")
  .option("--force", "Synthesize even if under the limit.", false)
  .option("--at <ref>", "Stamp the synthesis docs with this git ref's commit (provenance only, no historical rebuild).")
  .option(
    "--compact",
    "Archive the absorbed sources out of the live memory (compacted_into ← synthesis slug): they leave hydrate and the growth trigger but stay searchable and versioned — nothing is deleted.",
    false,
  )
  .description("Compact a project's memory when it exceeds the configured limit.")
  .action(async (opts) => {
    let commitSha: string | undefined;
    if (opts.at) {
      const { resolveRef } = await import("./util/git.js");
      const sha = resolveRef(opts.at);
      if (!sha) {
        console.error(`[aitl synthesize] cannot resolve git ref '${opts.at}' (not a repo, or unknown ref).`);
        process.exitCode = 1;
        await closeClient();
        return;
      }
      commitSha = sha;
    }
    // Degradación sin LLM (F9): with a configured backend the synthesis is model-made
    // (fallback chain, like chat); without one it degrades to the extractive summary
    // WITH an explicit notice — it never fails for lack of a provider.
    const { getProviderWithFallback, providerStatus } = await import("./providers/base.js");
    let llm: import("./providers/base.js").Provider | null = null;
    if (providerStatus().active) {
      llm = await getProviderWithFallback();
    } else {
      console.error("[aitl synthesize] sin modelo configurado: síntesis extractiva (primer renglón por fuente).");
    }
    const { Synthesizer } = await import("./memory/synthesizer.js");
    const { MemoryStore } = await import("./memory/store.js");
    const report = await new Synthesizer(new MemoryStore(), llm).synthesize(opts.project, {
      force: opts.force,
      compact: opts.compact,
      ...(commitSha !== undefined ? { commitSha } : {}),
    });
    console.log(
      `Synthesis docs written: ${report.written.length ? report.written.join(", ") : "(none — under limit)"}`,
    );
    for (const c of report.categories) {
      const ratio = c.chars_before > 0 ? ` (${Math.round((100 * c.chars_after) / c.chars_before)}%)` : "";
      console.log(
        `  - ${c.category}: ${c.sources} source${c.sources === 1 ? "" : "s"}${c.folded ? " + previous synthesis" : ""}, ${c.chars_before} → ${c.chars_after} chars${ratio}`,
      );
    }
    if (opts.compact && report.written.length) {
      console.log(`Compacted sources (excluded from hydrate/trigger, never deleted): ${report.compacted}`);
    }
    // Curation (F4): PROPOSE stale-ADR deprecations — never applied automatically.
    const { proposeDeprecations } = await import("./decisions/lifecycle.js");
    const proposals = await proposeDeprecations(opts.project);
    if (proposals.length) {
      console.log(`ADR deprecation proposals (${proposals.length}) — apply manually with \`aitl adr deprecate\`:`);
      for (const p of proposals) console.log(`  - ${p.id} ${p.title}: ${p.reason}`);
    }
    await closeClient();
  });

program
  .command("repomap")
  .option("--root <dir>", "Codebase root to map (required without --modules; with --modules it forces a rebuild first).")
  .requiredOption("--project <project>", "Project scope.")
  .option("--repo <repo>", "Repo sub-scope (rebuilds only this repo's symbols).")
  .option("--modules", "Print the first-level module map (kind view|back|mixed|infra + files + top symbols) from the cached symbols.", false)
  .option("--json", "With --modules: print the module map as JSON.", false)
  .description("Build the tree-sitter + PageRank repo map and print the top symbols (or the module map with --modules).")
  .action(async (opts) => {
    // Without --modules the legacy contract holds: --root is required (build + render).
    if (!opts.root && !opts.modules) program.error("error: required option '--root <dir>' not specified");
    const { RepoMap } = await import("./repomap/store.js");
    const rm = new RepoMap();
    if (opts.root) {
      const n = await rm.build(opts.root, opts.project, opts.repo ?? null);
      // With --modules --json keep stdout machine-readable; the build note goes to stderr.
      const note = `Indexed ${n} symbols${opts.repo ? ` for repo '${opts.repo}'` : ""}.\n`;
      if (opts.modules && opts.json) console.error(note.trimEnd());
      else console.log(note);
    }
    if (opts.modules) {
      const { buildModuleMap, renderModuleMap } = await import("./repomap/modules.js");
      const map = await buildModuleMap(opts.project, {
        ...(opts.repo ? { repo: opts.repo } : {}),
        ...(opts.root ? { root: opts.root } : {}),
      });
      console.log(opts.json ? JSON.stringify(map, null, 2) : renderModuleMap(map));
    } else {
      console.log(await rm.render(opts.project, opts.repo ? { repo: opts.repo } : {}));
    }
    await closeClient();
  });

program
  .command("module-brief")
  .argument("<dir>", "Module dir, repo-root-relative (e.g. src/server).")
  .requiredOption("--project <project>", "Project scope.")
  .option("--repo <repo>", "Repo sub-scope for the module map.")
  .option("--json", "Print the brief as JSON.", false)
  .description("Render a module's brief: its module-map block + ACTIVE ADRs whose components match the dir + memories tagged component:<dir>.")
  .action(async (dir, opts) => {
    const { buildModuleBrief, renderModuleBrief } = await import("./repomap/modules.js");
    const brief = await buildModuleBrief({ project: opts.project, dir, ...(opts.repo ? { repo: opts.repo } : {}) });
    console.log(opts.json ? JSON.stringify(brief, null, 2) : renderModuleBrief(brief));
    await closeClient();
  });

program
  .command("index-repo")
  .requiredOption("--root <dir>", "Repo root to index.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--repo <repo>", "Repo sub-scope (tags symbols/memory).")
  .option("--memory <dir>", "Directory of markdown memory to ingest.")
  .option("--adr <dir>", "ADR directory to sync (default: <root>/docs/adr).")
  .description("Master indexer: build repo map + ingest memory + sync ADRs in one pass.")
  .action(async (opts) => {
    const { indexRepo } = await import("./indexing/indexRepo.js");
    const r = await indexRepo({
      project: opts.project,
      root: opts.root,
      repo: opts.repo ?? null,
      memoryDir: opts.memory,
      adrDir: opts.adr,
      actor: { id: CLI_ACTOR.id, role: CLI_ACTOR.role },
    });
    console.log(`Indexed project '${r.project}'${r.repo ? ` repo '${r.repo}'` : ""}${r.branch ? ` @${r.branch}` : ""}:`);
    for (const s of r.steps) console.log(`  - ${s}`);
    await closeClient();
  });

program
  .command("adr-sync")
  .option("--dir <dir>", "ADR directory.", "docs/adr")
  .requiredOption("--project <project>", "Project scope.")
  .description("Mirror Nygard-format ADRs from a directory into the `decisions` collection.")
  .action(async (opts) => {
    const { ADRStore } = await import("./decisions/adr.js");
    const { currentBranch } = await import("./util/git.js");
    const ids = await new ADRStore().syncDir(opts.dir, opts.project, { actor: { id: CLI_ACTOR.id, role: CLI_ACTOR.role }, branch: currentBranch() });
    console.log(`Synced ADRs: ${ids.join(", ")}`);
    await closeClient();
  });

program
  .command("export")
  .requiredOption("--adapter <name>", "agents_md | cursor | copilot | antigravity | kiro | trae | markdown")
  .requiredOption("--project <project>", "Project scope.")
  .option("--root <dir>", "Repo root to write tool files into.", ".")
  .description("Project the canonical artifacts into a tool's native format (incremental).")
  .action(async (opts) => {
    const { getAdapter, loadCanon } = await import("./adapters/base.js");
    const canon = await loadCanon(opts.project, opts.root);
    const written = await (await getAdapter(opts.adapter)).export(canon, opts.root);
    console.log(written.length ? `Wrote: ${written.join(", ")}` : "Nothing to write (all up to date).");
    await closeClient();
  });

program
  .command("sync")
  .option("--project <project>", "Project scope (default: $AITL_PROJECT or the cwd folder name).")
  .option("--pull", "One-way Mongo → disk; conflicts resolve in Mongo's favor.")
  .option("--push", "One-way disk → Mongo; conflicts resolve in the disk's favor.")
  .option("--dir <dir>", "Mirror root for memory/skills/agents (hosts .sync-state.json).", ".aitl")
  .option("--adr-dir <dir>", "ADR mirror directory.", "docs/adr")
  .option("--include-reserved", "Also sync reserved memory types (synthesis/spec/design/task).")
  .description("Bidirectional markdown sync: Mongo ⇄ .aitl/{memory,skills,agents} + docs/adr (manifest-based; conflicts reported, never clobbered).")
  .action(async (opts) => {
    if (opts.pull && opts.push) {
      console.error("Elige --pull O --push (sin flags = bidireccional).");
      process.exitCode = 1;
      return;
    }
    const { basename } = await import("node:path");
    const { syncProject } = await import("./sync/sync.js");
    const project: string = opts.project ?? process.env.AITL_PROJECT?.trim() ?? basename(process.cwd());
    const mode = opts.pull ? "pull" : opts.push ? "push" : "both";
    const res = await syncProject(project, {
      dir: opts.dir,
      adrDir: opts.adrDir,
      mode,
      includeReserved: Boolean(opts.includeReserved),
      actor: { id: CLI_ACTOR.id, role: CLI_ACTOR.role },
    });
    const show = (label: string, items: { entity: string; key: string; path?: string; reason?: string }[]) => {
      if (!items.length) return;
      console.log(`${label} (${items.length}):`);
      for (const it of items) {
        console.log(`  - ${it.entity} ${it.key}${it.path ? ` → ${it.path}` : ""}${it.reason ? `  [${it.reason}]` : ""}`);
      }
    };
    console.log(`sync '${project}' (${mode}) — ${opts.dir} + ${opts.adrDir}`);
    show("pulled (Mongo → disco)", res.pulled);
    show("pushed (disco → Mongo)", res.pushed);
    show("CONFLICTS (sin tocar)", res.conflicts);
    show("skipped", res.skipped);
    console.log(`unchanged: ${res.unchanged} · manifiesto: ${res.statePath}`);
    if (res.conflicts.length) process.exitCode = 2;
    await closeClient();
  });

program
  .command("mcp")
  .description("Run the MCP server so Claude Code (stdio) or remote clients (--http) can use AITL's durable memory.")
  .option("--http", "Serve over Streamable HTTP instead of stdio (exposes the server on the network).", false)
  .option("--host <host>", "HTTP bind host (use 0.0.0.0 behind a proxy/tunnel).", "127.0.0.1")
  .option("--port <n>", "HTTP port.", "8000")
  .option("--path <path>", "HTTP path.", "/mcp")
  .option("--socket <path>", "HTTP Unix socket path (local only; overrides --host/--port).")
  .option("--token <token>", "Require this Bearer token (or set AITL_MCP_TOKEN). Omit only on trusted localhost.")
  .action(async (opts) => {
    const { main, mainHttp } = await import("./mcpserver/server.js");
    if (opts.http) {
      await mainHttp({ host: opts.host, port: Number(opts.port), path: opts.path, socketPath: opts.socket, token: opts.token });
    } else {
      await main();
    }
  });

const user = program
  .command("user")
  .description("Manage bootstrap users stored in MongoDB.");

user
  .command("bootstrap")
  .description("Create the env-configured bootstrap user if it does not exist.")
  .action(async () => {
    const { connectWithFallback, closeClient } = await import("./db/client.js");
    const { bootstrapBaseUser } = await import("./auth/users.js");
    await connectWithFallback();
    const result = await bootstrapBaseUser();
    console.log(`Bootstrap user: ${result.status}${result.username ? ` (${result.username}, ${result.email}, role=${result.role})` : ""}`);
    if (result.reason) console.log(result.reason);
    await closeClient();
  });

user
  .command("verify")
  .requiredOption("--username <username>", "Username to verify.")
  .requiredOption("--email <email>", "Email to verify.")
  .requiredOption("--password <password>", "Password to verify.")
  .description("Verify username + email + password against the stored bootstrap user.")
  .action(async (opts) => {
    const { connectWithFallback, closeClient } = await import("./db/client.js");
    const { verifyUserCredentials } = await import("./auth/users.js");
    await connectWithFallback();
    const result = await verifyUserCredentials({
      username: opts.username,
      email: opts.email,
      password: opts.password,
    });
    console.log(result.ok ? `User verified: ${result.username} (${result.email}, role=${result.role})` : `User verification failed: ${result.reason}`);
    await closeClient();
    if (!result.ok) process.exitCode = 1;
  });

// CLI runs on the host that owns AITL, so the operator acts as root.
const CLI_ACTOR = { id: "cli:local", role: "root" as const, source: "cli" as const };

user
  .command("list")
  .description("List users (no password hashes). Root-only.")
  .action(async () => {
    const { connectWithFallback } = await import("./db/client.js");
    const { listUsers } = await import("./auth/users.js");
    await connectWithFallback();
    const rows = await listUsers();
    for (const u of rows) {
      console.log(`${u.username}\t${u.role}\t${u.email}${u.disabled ? "\t(disabled)" : ""}`);
    }
    if (!rows.length) console.log("(no users)");
    await closeClient();
  });

user
  .command("create")
  .requiredOption("--username <username>", "New username.")
  .requiredOption("--email <email>", "New email.")
  .requiredOption("--password <password>", "Password (min 12 chars).")
  .option("--role <role>", "root | admin | user | agent | auditor", "user")
  .description("Create a user. Root-only; audited.")
  .action(async (opts) => {
    const { connectWithFallback } = await import("./db/client.js");
    const { createUser } = await import("./auth/users.js");
    const { assertCan } = await import("./auth/rbac.js");
    const { recordAudit } = await import("./auth/audit.js");
    await connectWithFallback();
    try {
      assertCan(CLI_ACTOR, "users", "create");
      const created = await createUser({ username: opts.username, email: opts.email, password: opts.password, role: opts.role });
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.create", resource: `user:${created.username}`, ok: true });
      console.log(`Created user: ${created.username} (${created.email}, role=${created.role})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.create", resource: `user:${opts.username}`, ok: false, reason });
      console.error(`Create failed: ${reason}`);
      process.exitCode = 1;
    }
    await closeClient();
  });

user
  .command("register")
  .requiredOption("--username <username>", "New username.")
  .requiredOption("--email <email>", "New email.")
  .requiredOption("--password <password>", "Password (min 12 chars).")
  .description("Self-service registration (no root needed). First real user becomes admin; audited.")
  .action(async (opts) => {
    const { connectWithFallback } = await import("./db/client.js");
    const { registerUser } = await import("./auth/users.js");
    await connectWithFallback();
    try {
      const created = await registerUser(
        { username: opts.username, email: opts.email, password: opts.password },
        { source: "cli" },
      );
      console.log(`Registered user: ${created.username} (${created.email}, role=${created.role})`);
    } catch (err) {
      console.error(`Register failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    await closeClient();
  });

user
  .command("set-role")
  .requiredOption("--username <username>", "Target username.")
  .requiredOption("--role <role>", "root | admin | user | agent | auditor")
  .description("Change a user's role. Root-only; audited.")
  .action(async (opts) => {
    const { connectWithFallback } = await import("./db/client.js");
    const { setUserRole } = await import("./auth/users.js");
    const { assertCan } = await import("./auth/rbac.js");
    const { recordAudit } = await import("./auth/audit.js");
    await connectWithFallback();
    try {
      assertCan(CLI_ACTOR, "users", "set_role");
      const u = await setUserRole(opts.username, opts.role);
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.set_role", resource: `user:${u.username}`, ok: true, reason: `role=${u.role}` });
      console.log(`Updated ${u.username}: role=${u.role}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.set_role", resource: `user:${opts.username}`, ok: false, reason });
      console.error(`Set-role failed: ${reason}`);
      process.exitCode = 1;
    }
    await closeClient();
  });

user
  .command("disable")
  .requiredOption("--username <username>", "Target username.")
  .option("--enable", "Re-enable instead of disabling.")
  .description("Disable (or re-enable) a user. Root-only; audited.")
  .action(async (opts) => {
    const { connectWithFallback } = await import("./db/client.js");
    const { setUserDisabled } = await import("./auth/users.js");
    const { assertCan } = await import("./auth/rbac.js");
    const { recordAudit } = await import("./auth/audit.js");
    await connectWithFallback();
    const disabled = !opts.enable;
    try {
      assertCan(CLI_ACTOR, "users", "disable");
      const u = await setUserDisabled(opts.username, disabled);
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.disable", resource: `user:${u.username}`, ok: true, reason: `disabled=${disabled}` });
      console.log(`Updated ${u.username}: disabled=${disabled}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordAudit({ actor_id: CLI_ACTOR.id, actor_role: CLI_ACTOR.role, source: "cli", action: "users.disable", resource: `user:${opts.username}`, ok: false, reason });
      console.error(`Disable failed: ${reason}`);
      process.exitCode = 1;
    }
    await closeClient();
  });

// ── config (portable profile for `npm i -g`; stored at ~/.aitl/config.json) ──────
const config = program
  .command("config")
  .description("Manage the user-level config profile (~/.aitl/config.json).");

config
  .command("path")
  .description("Print the path to the user-level config file.")
  .action(async () => {
    const { configFilePath } = await import("./config/store.js");
    console.log(configFilePath());
  });

config
  .command("show")
  .option("--secrets", "Reveal secret values instead of masking them.", false)
  .description("Print the effective config (env > file > defaults). Secrets masked by default.")
  .action(async (opts) => {
    const { resolveProfile } = await import("./config/store.js");
    console.log(JSON.stringify(resolveProfile({ includeSecrets: opts.secrets }), null, 2));
  });

config
  .command("export")
  .option("--out <file>", "Write to a file instead of stdout.")
  .option("--secrets", "Include secret values (do NOT share the output).", false)
  .description("Export the effective config as a portable JSON profile.")
  .action(async (opts) => {
    const { resolveProfile } = await import("./config/store.js");
    const json = JSON.stringify(resolveProfile({ includeSecrets: opts.secrets }), null, 2);
    if (opts.out) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(opts.out, `${json}\n`, "utf-8");
      console.log(`Wrote profile to ${opts.out}${opts.secrets ? "" : " (secrets masked)"}.`);
    } else {
      console.log(json);
    }
  });

config
  .command("import")
  .argument("<file>", "JSON profile to import (ENV-style keys).")
  .option("--merge", "Merge onto the existing profile instead of replacing it.", false)
  .description("Import a JSON profile into ~/.aitl/config.json.")
  .action(async (file, opts) => {
    const { readFile } = await import("node:fs/promises");
    const { sanitizeProfile, writeConfigFile } = await import("./config/store.js");
    const raw = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    const profile = sanitizeProfile(raw);
    const ignored = Object.keys(raw).filter((k) => !(k in profile));
    const path = await writeConfigFile(profile, { merge: opts.merge });
    console.log(`Imported ${Object.keys(profile).length} keys into ${path}.`);
    if (ignored.length) console.log(`(ignored unknown/empty keys: ${ignored.join(", ")})`);
  });

config
  .command("set")
  .argument("<key>", "ENV-style key (e.g. GEMINI_API_KEY).")
  .argument("<value>", "Value.")
  .option("--env", "Also mirror the key into ./.env (created when missing; preserves other lines).", false)
  .description("Set a single key in the user-level config profile.")
  .action(async (key, value, opts) => {
    const { ENV_KEYS, writeConfigFile } = await import("./config/store.js");
    if (!(ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown key '${key}'. Known: ${ENV_KEYS.join(", ")}`);
    }
    const path = await writeConfigFile({ [key]: value }, { merge: true });
    console.log(`Set ${key} in ${path}.`);
    if (opts.env) {
      const { updateEnvFile } = await import("./config/envfile.js");
      const { join } = await import("node:path");
      const envPath = join(process.cwd(), ".env");
      await updateEnvFile(envPath, { [key]: value });
      console.log(`Mirrored ${key} into ${envPath}.`);
    }
  });

config
  .command("unset")
  .argument("<key>", "ENV-style key to remove.")
  .description("Remove a single key from the user-level config profile.")
  .action(async (key) => {
    const { readConfigFile, writeConfigFile } = await import("./config/store.js");
    const profile = readConfigFile();
    delete (profile as Record<string, unknown>)[key];
    const path = await writeConfigFile(profile, { merge: false });
    console.log(`Unset ${key} in ${path}.`);
  });

// ── ui (memory-admin: HTTP API + Vite dev server, launched together) ─────────────
program
  .command("ui")
  .option("--project <project>", "Default project to focus in the UI.")
  .option("--api-port <n>", "Port for the memory-admin API server.", "4317")
  .option("--web-port <n>", "Port for the Vite dev server.", "5317")
  .option("--no-web", "Start only the API (skip the Vite dev server).")
  .description("Launch the memory-admin UI: the HTTP API and the Vite dev server together.")
  .action(async (opts) => {
    const { startUi } = await import("./server/ui.js");
    await startUi({
      apiPort: Number(opts.apiPort),
      webPort: Number(opts.webPort),
      web: opts.web !== false,
      project: opts.project,
    });
  });

// ── prompt history (durable record of prompts; separate `prompts` collection) ────
const prompt = program.command("prompt").description("Durable prompt history for a project.");

prompt
  .command("add")
  .argument("<text>", "Prompt text to record.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--title <title>", "Short title.")
  .option("--source <source>", "Where it came from.", "cli")
  .option("--tags <list>", "Comma-separated tags.")
  .description("Append a prompt to the durable history (shared with the MCP).")
  .action(async (text, opts) => {
    const { PromptStore } = await import("./prompts/store.js");
    const rec = await new PromptStore().add({
      project: opts.project,
      prompt: text,
      title: opts.title ?? "",
      source: opts.source,
      tags: opts.tags ? String(opts.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [],
    });
    console.log(`Recorded prompt ${rec.id} in project '${rec.project}'.`);
    await closeClient();
  });

prompt
  .command("list")
  .requiredOption("--project <project>", "Project scope.")
  .option("--source <source>", "Only this source.")
  .option("--tag <tag>", "Only this tag.")
  .option("--limit <n>", "Max rows.", "50")
  .description("Print the prompt history for a project (newest first).")
  .action(async (opts) => {
    const { PromptStore } = await import("./prompts/store.js");
    const rows = await new PromptStore().list(opts.project, {
      source: opts.source,
      tag: opts.tag,
      limit: Number(opts.limit),
    });
    for (const r of rows) {
      const ts = r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 16).replace("T", " ") : "";
      const title = r.title ? `${r.title}: ` : "";
      console.log(`[${ts}] (${r.source}) ${title}${String(r.prompt).replace(/\s+/g, " ").slice(0, 100)}`);
    }
    if (!rows.length) console.log("(no prompts recorded)");
    await closeClient();
  });

prompt
  .command("search")
  .argument("<query>", "Search text.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--limit <n>", "Max rows.", "10")
  .description("Search the prompt history ($text with regex fallback).")
  .action(async (query, opts) => {
    const { PromptStore } = await import("./prompts/store.js");
    const rows = await new PromptStore().search(opts.project, query, Number(opts.limit));
    for (const r of rows) console.log(`- ${String(r.prompt).replace(/\s+/g, " ").slice(0, 120)}`);
    if (!rows.length) console.log("(no matches)");
    await closeClient();
  });

// ── revision history (ADR-0027) ──────────────────────────────────────────────
async function showHistory(
  kind: "decision" | "memory",
  ref: string,
  opts: { project: string; diff?: boolean; from?: string; to?: string; fields: readonly string[] },
): Promise<void> {
  const { loadVersionChain } = await import("./memory/history.js");
  const { diffFields } = await import("./util/diff.js");
  const chain = await loadVersionChain(kind, opts.project, ref);
  if (!chain.length) {
    console.log(`(no ${kind} '${ref}' in project '${opts.project}')`);
    return;
  }
  if (!opts.diff) {
    console.log(`History of ${kind} '${ref}' (${chain.length} version(s)):`);
    for (const e of chain) {
      const when = e.archived_at instanceof Date ? e.archived_at.toISOString().slice(0, 16).replace("T", " ") : e.live ? "current" : "";
      const who = e.actor_id ? ` by ${e.actor_id}` : "";
      const br = e.branch ? ` @${e.branch}` : "";
      const label = kind === "decision" ? String(e.doc.title ?? "") : String(e.doc.description ?? "");
      console.log(`  v${e.version}${e.live ? " (live)" : ""}  ${when}${who}${br}  ${label}`.trimEnd());
    }
    return;
  }
  // Diff mode: consecutive pairs, or a single from→to pair.
  const byVersion = new Map(chain.map((e) => [e.version, e]));
  const pairs: [number, number][] = [];
  if (opts.from && opts.to) {
    pairs.push([Number(opts.from), Number(opts.to)]);
  } else {
    for (let i = 1; i < chain.length; i++) pairs.push([chain[i - 1].version, chain[i].version]);
  }
  if (!pairs.length) {
    console.log("(only one version — nothing to diff)");
    return;
  }
  for (const [a, b] of pairs) {
    const ea = byVersion.get(a);
    const eb = byVersion.get(b);
    if (!ea || !eb) {
      console.log(`v${a} → v${b}: (version not found)`);
      continue;
    }
    const lines = diffFields(ea.doc, eb.doc, opts.fields);
    console.log(`\n── v${a} → v${b} ──`);
    if (!lines.length) console.log("  (no field changes)");
    else for (const ln of lines) console.log(ln);
  }
}

const adr = program
  .command("adr")
  .description("Inspect ADR revision history and curate the ADR lifecycle.");

adr
  .command("history")
  .argument("<id>", "ADR id, e.g. 0026.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--diff", "Show field-level diffs between versions.")
  .option("--from <v>", "Diff from this version (with --to).")
  .option("--to <v>", "Diff to this version (with --from).")
  .action(async (id, opts) => {
    const { ADR_CONTENT_FIELDS } = await import("./memory/versioning.js");
    await showHistory("decision", id, { project: opts.project, diff: opts.diff, from: opts.from, to: opts.to, fields: ["title", ...ADR_CONTENT_FIELDS] });
    await closeClient();
  });

adr
  .command("deprecate")
  .argument("<id>", "ADR id, e.g. 0026.")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--reason <text>", "Why this ADR no longer applies.")
  .option("--superseded-by <id>", "Id of the ADR that replaces it.")
  .option("--review-after <date>", "Soft-TTL review date (ISO, e.g. 2027-01-31).")
  .description("Mark an ADR as deprecated with a reason (append-only: bumps the version, keeps history).")
  .action(async (id, opts) => {
    let reviewAfter: Date | undefined;
    if (opts.reviewAfter) {
      reviewAfter = new Date(opts.reviewAfter);
      if (Number.isNaN(reviewAfter.getTime())) {
        console.error(`[aitl adr deprecate] invalid --review-after date '${opts.reviewAfter}' (use ISO, e.g. 2027-01-31).`);
        process.exitCode = 1;
        await closeClient();
        return;
      }
    }
    const { deprecateDecision } = await import("./decisions/lifecycle.js");
    try {
      const res = await deprecateDecision({
        project: opts.project,
        id,
        reason: opts.reason,
        supersededBy: opts.supersededBy ?? null,
        reviewAfter: reviewAfter ?? null,
        actor: { id: CLI_ACTOR.id, role: CLI_ACTOR.role },
      });
      console.log(`ADR ${res.id} → status '${res.status}' (v${res.version}).`);
    } catch (err) {
      console.error(`[aitl adr deprecate] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    await closeClient();
  });

program
  .command("memory")
  .description("Inspect memory revision history.")
  .command("history")
  .argument("<slug>", "Memory slug.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--diff", "Show field-level diffs between versions.")
  .option("--from <v>", "Diff from this version (with --to).")
  .option("--to <v>", "Diff to this version (with --from).")
  .action(async (slug, opts) => {
    const { MEMORY_CONTENT_FIELDS } = await import("./memory/versioning.js");
    await showHistory("memory", slug, { project: opts.project, diff: opts.diff, from: opts.from, to: opts.to, fields: MEMORY_CONTENT_FIELDS });
    await closeClient();
  });

// ── software / repo catalog (ADR-0028) ───────────────────────────────────────
const software = program.command("software").description("Manage software (software -> projects -> repos).");

software
  .command("add")
  .argument("<name>", "Software name (unique).")
  .option("--display <name>", "Display name.")
  .option("--desc <text>", "Description.")
  .option("--projects <list>", "Comma-separated member project scopes.")
  .option("--tags <list>", "Comma-separated tags.")
  .description("Create/update a software and its member projects.")
  .action(async (name, opts) => {
    const { SoftwareStore } = await import("./softwares/store.js");
    const split = (s?: string) => (s ? String(s).split(",").map((x: string) => x.trim()).filter(Boolean) : []);
    const doc = await new SoftwareStore().upsert({ name, display_name: opts.display ?? "", description: opts.desc ?? "", projects: split(opts.projects), tags: split(opts.tags) });
    console.log(`Saved software '${doc.name}' (projects: ${doc.projects.join(", ") || "none"}).`);
    await closeClient();
  });

software
  .command("list")
  .option("--tag <tag>", "Filter by tag.")
  .description("List softwares (newest first).")
  .action(async (opts) => {
    const { SoftwareStore } = await import("./softwares/store.js");
    const rows = await new SoftwareStore().list({ tag: opts.tag });
    for (const r of rows) console.log(`- ${r.name}  [${(r.projects ?? []).join(", ")}]  ${r.description ?? ""}`.trimEnd());
    if (!rows.length) console.log("(no softwares)");
    await closeClient();
  });

software
  .command("get")
  .argument("<name>", "Software name.")
  .action(async (name) => {
    const { SoftwareStore } = await import("./softwares/store.js");
    const doc = await new SoftwareStore().get(name);
    console.log(doc ? JSON.stringify(doc, null, 2) : `(no software '${name}')`);
    await closeClient();
  });

software
  .command("rm")
  .argument("<name>", "Software name.")
  .action(async (name) => {
    const { SoftwareStore } = await import("./softwares/store.js");
    console.log((await new SoftwareStore().delete(name)) ? `Deleted '${name}'.` : `(no software '${name}')`);
    await closeClient();
  });

const repo = program.command("repo").description("Manage repos (the leaf of software -> projects -> repos).");

repo
  .command("add")
  .argument("<name>", "Repo name (the data sub-scope `repo`).")
  .requiredOption("--project <project>", "Owning project scope.")
  .option("--software <software>", "Owning software name.")
  .option("--remote <url>", "Git remote URL.")
  .option("--branch <branch>", "Branch.")
  .option("--path <dir>", "Local filesystem root.")
  .option("--desc <text>", "Description.")
  .option("--tags <list>", "Comma-separated tags.")
  .description("Create/update a repo under a project.")
  .action(async (name, opts) => {
    const { RepoStore } = await import("./repos/store.js");
    const split = (s?: string) => (s ? String(s).split(",").map((x: string) => x.trim()).filter(Boolean) : []);
    const doc = await new RepoStore().upsert({ project: opts.project, name, software: opts.software ?? null, remote: opts.remote ?? "", branch: opts.branch ?? "", path: opts.path ?? "", description: opts.desc ?? "", tags: split(opts.tags) });
    console.log(`Saved repo '${doc.name}' in project '${doc.project}'${doc.software ? ` (software ${doc.software})` : ""}.`);
    await closeClient();
  });

repo
  .command("list")
  .option("--project <project>", "Filter by project.")
  .option("--software <software>", "Filter by software.")
  .description("List repos by project and/or software.")
  .action(async (opts) => {
    const { RepoStore } = await import("./repos/store.js");
    const rows = await new RepoStore().list({ project: opts.project, software: opts.software });
    for (const r of rows) console.log(`- ${r.project}/${r.name}  ${r.remote ?? ""}${r.branch ? `#${r.branch}` : ""}`.trimEnd());
    if (!rows.length) console.log("(no repos)");
    await closeClient();
  });

repo
  .command("get")
  .argument("<name>", "Repo name.")
  .requiredOption("--project <project>", "Owning project scope.")
  .action(async (name, opts) => {
    const { RepoStore } = await import("./repos/store.js");
    const doc = await new RepoStore().get(opts.project, name);
    console.log(doc ? JSON.stringify(doc, null, 2) : `(no repo '${name}' in '${opts.project}')`);
    await closeClient();
  });

repo
  .command("rm")
  .argument("<name>", "Repo name.")
  .requiredOption("--project <project>", "Owning project scope.")
  .action(async (name, opts) => {
    const { RepoStore } = await import("./repos/store.js");
    console.log((await new RepoStore().delete(opts.project, name)) ? `Deleted '${name}'.` : `(no repo '${name}')`);
    await closeClient();
  });

// ── branch catalog (ADR-0031: grafo de ramas estilo GitHub) ──────────────────
const branch = program.command("branch").description("Classify git branches and feed the branch graph.");

branch
  .command("sync")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--repo <repo>", "Repo name this branch set belongs to.")
  .option("--root <dir>", "Git repo root.", ".")
  .option("--remote <url>", "Remote URL to record.")
  .option("--reindex", "Run the master indexer when the base trunk's head advanced since the last sync.", false)
  .description("Read the repo's git branches, classify them and upsert into the catalog.")
  .action(async (opts) => {
    const { syncBranchesWithReindex } = await import("./branches/reindex.js");
    const { records: recs, reindex } = await syncBranchesWithReindex({
      project: opts.project,
      repo: opts.repo,
      root: opts.root,
      remote: opts.remote,
      reindex: opts.reindex,
    });
    console.log(`Synced ${recs.length} branch(es) for ${opts.project}/${opts.repo}:`);
    for (const r of recs) {
      const env = r.environment !== "none" ? ` [${r.environment}]` : "";
      const from = r.base ? ` ← ${r.base}` : "";
      console.log(`  ${r.name}  (${r.kind})${env}${from}`);
    }
    if (!recs.length) console.log("  (no local branches found — is --root a git repo?)");
    if (reindex) {
      if (!reindex.base) {
        console.log("reindex: no base trunk (main/master/develop) found — skipped.");
      } else if (!reindex.changed) {
        console.log(`reindex: base ${reindex.base} sin cambios (${reindex.liveSha ?? "?"}).`);
      } else {
        const prev = reindex.storedSha ? `antes ${reindex.storedSha.slice(0, 7)}` : "primer registro";
        console.log(`reindex: base ${reindex.base} avanzó a ${reindex.liveSha?.slice(0, 7)} (${prev}), reindexando…`);
        for (const s of reindex.result?.steps ?? []) console.log(`  - ${s}`);
      }
    }
    await closeClient();
  });

branch
  .command("list")
  .option("--project <project>", "Filter by project.")
  .option("--repo <repo>", "Filter by repo.")
  .option("--kind <kind>", "Filter by kind (main|master|develop|staging|release|hotfix|feature|other).")
  .description("List classified branches (newest first).")
  .action(async (opts) => {
    const { BranchStore } = await import("./branches/store.js");
    const rows = await new BranchStore().list({ project: opts.project, repo: opts.repo, kind: opts.kind });
    for (const r of rows) {
      const env = r.environment !== "none" ? ` [${r.environment}]` : "";
      const from = r.base ? ` ← ${r.base}` : "";
      console.log(`- ${r.project}/${r.repo}:${r.name}  (${r.kind})${env}${from}`);
    }
    if (!rows.length) console.log("(no branches)");
    await closeClient();
  });

branch
  .command("rm")
  .argument("<name>", "Branch name.")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--repo <repo>", "Repo name.")
  .action(async (name, opts) => {
    const { BranchStore } = await import("./branches/store.js");
    console.log((await new BranchStore().delete(opts.project, opts.repo, name)) ? `Deleted '${name}'.` : `(no branch '${name}')`);
    await closeClient();
  });

// ── coordination (ADR-0002 v1): task claims + eventos + polling ───────────────
const coord = program
  .command("coord")
  .description("Minimal multi-agent coordination over the shared DB: task claims (heartbeat + TTL) + durable events + polling.");

coord
  .command("claim")
  .argument("<task_key>", "Task key: SDD task slug, path, or short description.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--scope <text>", "Declared work scope (free text, e.g. \"schoolar backend\").")
  .option("--ttl <minutes>", "Claim TTL in minutes (fractional ok; default: AITL_CLAIM_TTL_MS or 30 min).")
  .description("Claim a task (atomic). Conflicts report who holds it; re-claiming your own task renews it.")
  .action(async (taskKey, opts) => {
    const { claimTask, coordOwnerId } = await import("./coord/claims.js");
    let ttlMs: number | undefined;
    if (opts.ttl !== undefined) {
      const mins = Number(opts.ttl);
      if (!Number.isFinite(mins) || mins <= 0) {
        console.error(`[aitl coord claim] invalid --ttl '${opts.ttl}' (minutes > 0).`);
        process.exitCode = 1;
        await closeClient();
        return;
      }
      ttlMs = Math.round(mins * 60_000);
    }
    const owner = coordOwnerId();
    const res = await claimTask({ project: opts.project, taskKey, scope: opts.scope, ownerId: owner, ttlMs });
    if (res.ok) {
      const kind = res.renewed ? "renovado" : res.reclaimed ? "reclamado (el anterior expiró)" : "OK";
      console.log(`Claim ${kind}: "${taskKey}" → ${owner} (expira ${new Date(res.claim.expires_at).toISOString()}).`);
    } else {
      console.error(`Conflicto: "${taskKey}" lo tiene ${res.heldBy} (expira ${res.expiresAt.toISOString()}).`);
      process.exitCode = 1;
    }
    await closeClient();
  });

coord
  .command("release")
  .argument("<task_key>", "Task key of YOUR active claim.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--outcome <outcome>", "done | abandoned.", "done")
  .description("Release your active claim on a task (emits a release event).")
  .action(async (taskKey, opts) => {
    const { RELEASE_OUTCOMES, coordOwnerId, releaseTask } = await import("./coord/claims.js");
    if (!(RELEASE_OUTCOMES as readonly string[]).includes(opts.outcome)) {
      console.error(`[aitl coord release] invalid --outcome '${opts.outcome}' (use: ${RELEASE_OUTCOMES.join(" | ")}).`);
      process.exitCode = 1;
      await closeClient();
      return;
    }
    const owner = coordOwnerId();
    const res = await releaseTask({ project: opts.project, taskKey, ownerId: owner, outcome: opts.outcome });
    if (res.ok) {
      console.log(`Released: "${taskKey}" (${res.outcome}) por ${owner}.`);
    } else if (res.reason === "not_owner") {
      console.error(`No liberado: "${taskKey}" lo tiene ${res.heldBy}, no ${owner}.`);
      process.exitCode = 1;
    } else {
      console.error(`No liberado: no hay claim activo para "${taskKey}".`);
      process.exitCode = 1;
    }
    await closeClient();
  });

coord
  .command("list")
  .requiredOption("--project <project>", "Project scope.")
  .option("--all", "Include released and expired claims (full history).")
  .description("List the project's task claims (active ones by default).")
  .action(async (opts) => {
    const { listClaims } = await import("./coord/claims.js");
    const rows = await listClaims(opts.project, { active: !opts.all });
    const now = Date.now();
    for (const c of rows) {
      const state = c.released
        ? `released ${c.released_at ? new Date(c.released_at).toISOString() : ""}`.trimEnd()
        : new Date(c.expires_at).getTime() > now
          ? `expira ${new Date(c.expires_at).toISOString()}`
          : `EXPIRADO ${new Date(c.expires_at).toISOString()}`;
      console.log(`- ${c.task_key}  → ${c.owner_id}${c.scope ? `  [${c.scope}]` : ""}  (${state})`);
    }
    if (!rows.length) console.log(opts.all ? "(no claims)" : "(no active claims)");
    await closeClient();
  });

coord
  .command("poll")
  .requiredOption("--project <project>", "Project scope.")
  .option("--since <iso>", "Only events after this ISO timestamp (overrides the stored cursor).")
  .option("--quiet", "Print ONLY when there are new events (for hooks); always exit 0.")
  .description("Poll coordination events (one compact line each). Incremental: the cursor persists in ~/.aitl/coord-cursor-<hash>.json.")
  .action(async (opts) => {
    const { formatCoordEvent, pollEvents } = await import("./coord/events.js");
    const { loadCursor, saveCursor } = await import("./coord/cursor.js");
    let since: Date;
    if (opts.since) {
      since = new Date(opts.since);
      if (Number.isNaN(since.getTime())) {
        console.error(`[aitl coord poll] invalid --since '${opts.since}' (use ISO, e.g. 2026-07-06T12:00:00Z).`);
        process.exitCode = 1;
        await closeClient();
        return;
      }
    } else {
      // Stored cursor → incremental between invocations; first run: last 60 min.
      since = loadCursor(opts.project) ?? new Date(Date.now() - 60 * 60 * 1000);
    }
    const { events, cursor } = await pollEvents(opts.project, { since });
    for (const e of events) console.log(formatCoordEvent(e));
    if (!events.length && !opts.quiet) console.log("Sin eventos nuevos.");
    // Only advance the cursor when something was seen (an explicit old --since must not
    // rewind the stored cursor, and an empty first poll keeps the 60-min default).
    if (events.length && cursor) saveCursor(opts.project, cursor);
    await closeClient();
    // Hook-friendly: polling never signals failure via exit code.
    process.exitCode = 0;
  });

// ── engineering roles (H11): asisten al Software Engineer a decidir con criterio ──
const role = program.command("role").description("Engineering roles (review/pair/gate) that assist the engineer's decision.");

role
  .command("seed")
  .requiredOption("--project <project>", "Project scope.")
  .description("Seed the role catalog (security, devops, qa, architect, devsecops).")
  .action(async (opts) => {
    const { seedRoles } = await import("./roles/seed.js");
    const { RoleStore } = await import("./roles/store.js");
    const names = await seedRoles(opts.project, new RoleStore());
    console.log(`Seeded roles: ${names.join(", ")}.`);
    await closeClient();
  });

role
  .command("list")
  .requiredOption("--project <project>", "Project scope.")
  .description("List engineering roles.")
  .action(async (opts) => {
    const { RoleStore } = await import("./roles/store.js");
    const roles = await new RoleStore().list(opts.project);
    for (const r of roles) console.log(`- ${r.name}  (${r.mode}/${r.severity})  ${r.description}`.trimEnd());
    if (!roles.length) console.log("(no roles — run: aitl role seed)");
    await closeClient();
  });

role
  .command("rm")
  .argument("<name>", "Role name.")
  .requiredOption("--project <project>", "Project scope.")
  .action(async (name, opts) => {
    const { RoleStore } = await import("./roles/store.js");
    console.log((await new RoleStore().delete(opts.project, name)) ? `Deleted '${name}'.` : `(no role '${name}')`);
    await closeClient();
  });

// Deterministic gate check (no model/key): does a role's gate block a path?
role
  .command("gate-check")
  .argument("<path>", "Path the agent would write/touch.")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--role <name>", "Gate-mode role to check against.")
  .description("Check a gate-mode role's deterministic veto for a path (no model needed).")
  .action(async (path, opts) => {
    const { RoleStore } = await import("./roles/store.js");
    const { roleGate } = await import("./roles/engine.js");
    const r = await new RoleStore().get(opts.project, opts.role);
    if (!r) { console.log(`(no role '${opts.role}')`); await closeClient(); return; }
    const [allowed, reason] = roleGate(r)("write_file", { path });
    console.log(allowed ? `ALLOW ${path}` : `VETO ${path} — ${reason}`);
    await closeClient();
  });

// Model-based deliberation: roles review a target and produce a DecisionBrief.
program
  .command("review")
  .argument("<target>", "Text, or @file to review.")
  .requiredOption("--project <project>", "Project scope.")
  .requiredOption("--roles <list>", "Comma-separated roles to consult.")
  .option("--model <m>", "auto | anthropic | openrouter | lmstudio | openai-compat | primary | secondary", "primary")
  .description("Have engineering roles review a target → DecisionBrief (assists the engineer).")
  .action(async (target, opts) => {
    const { RoleStore } = await import("./roles/store.js");
    const { deliberate } = await import("./roles/engine.js");
    const { getProvider } = await import("./providers/base.js");
    const { MemoryStore } = await import("./memory/store.js");
    let text = target;
    if (String(target).startsWith("@")) {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(String(target).slice(1), "utf8");
    }
    const store = new RoleStore();
    const names = String(opts.roles).split(",").map((r: string) => r.trim()).filter(Boolean);
    const resolved = await Promise.all(names.map((n: string) => store.get(opts.project, n)));
    const present = resolved.filter((r): r is NonNullable<typeof r> => r != null);
    if (!present.length) { console.log("(no matching roles — run: aitl role seed)"); await closeClient(); return; }
    const brief = await deliberate({ project: opts.project, target: text, roles: present, provider: await getProvider(opts.model), store: new MemoryStore() });
    console.log(`Decision brief: ${brief.summary}\n`);
    for (const v of brief.verdicts) {
      console.log(`[${v.role}/${v.mode}/${v.severity}] ${v.stance}`);
      for (const f of v.findings) console.log(`   - ${f}`);
      if (v.recommendation) console.log(`   → ${v.recommendation}`);
    }
    console.log(`\nblocked=${brief.blocked} (el ingeniero decide con estos criterios)`);
    await closeClient();
  });

// ── definition builder (ADR-0030: skill constructora) ────────────────────────
const build = program.command("build").description("Construct skills/agents (and seed the master skills).");

const buildOne = (kind: "skill" | "agent") =>
  build
    .command(kind)
    .argument("<name>", `${kind} name.`)
    .requiredOption("--project <project>", "Project scope.")
    .option("--desc <text>", "Description.")
    .option("--content <md>", "Inline markdown content.")
    .option("--from <file>", "Read content from a file.")
    .option("--tags <list>", "Comma-separated tags.")
    .option("--host <host>", "(agent) Execution host: model|claude-code|codex.")
    .option("--model <id>", "(agent) Model ref.")
    .description(`Build and persist ONE ${kind} definition (scaffolds content if omitted).`)
    .action(async (name, opts) => {
      const { buildDefinition } = await import("./builder/buildDefinition.js");
      let content = opts.content as string | undefined;
      if (!content && opts.from) {
        const { readFile } = await import("node:fs/promises");
        content = await readFile(opts.from, "utf8");
      }
      const tags = opts.tags ? String(opts.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [];
      const doc = await buildDefinition({ kind, project: opts.project, name, description: opts.desc ?? "", content, tags, host: opts.host, model: opts.model });
      console.log(`Built ${kind} '${doc.name}' in project '${doc.project}' (${content ? "from content" : "scaffold"}).`);
      await closeClient();
    });

buildOne("skill");
buildOne("agent");

build
  .command("seed")
  .requiredOption("--project <project>", "Project scope.")
  .description("Register the master skills (definition-builder, repo-indexer) into a project.")
  .action(async (opts) => {
    const { seedMasterSkills } = await import("./builder/seed.js");
    const docs = await seedMasterSkills(opts.project);
    console.log(`Seeded master skills: ${docs.map((d) => d.name).join(", ")}.`);
    await closeClient();
  });

// ── init (orchestrator) + init agent/claude (guide-only scaffolds) ────────────────
// `aitl init` (no subcommand) onboards THIS repo end-to-end: DB, identity, index,
// seeds, guides, .mcp.json, host hooks, git post-merge (P5/F1). The parent action
// needs Mongo, but `init` stays in NO_DB_COMMANDS so `init agent|claude` keep working
// offline — the parent action opens the connection itself (same fail-fast contract).
const init = program
  .command("init")
  .description("Onboard a repo into the harness (aitl init), or scaffold single guides (init agent|claude).")
  // Options after `agent`/`claude` belong to the subcommand (see enablePositionalOptions
  // on the program): `aitl init claude --project x` keeps working unchanged.
  .enablePositionalOptions()
  .option("--root <path>", "Target repo root.", ".")
  .option("--project <p>", "Project scope (default: basename of --root).")
  .option("--software <s>", "Owning software name (default: the project).")
  .option("--repo <r>", "Repo name / data sub-scope (default: basename of --root).")
  .option("--host <list>", "Comma-separated hosts to wire hooks for: claude-code,codex.")
  .option("--memory-only", "Skip provider validation: memory mode (hydrate/search/sync/capture).", false)
  .option("--force", "Re-apply steps that would skip; overwrite guides and the post-merge hook.", false)
  .action(async (opts) => {
    // Fail fast on Mongo exactly like the global preAction does for DB commands.
    const { connectWithFallback } = await import("./db/client.js");
    try {
      const result = await connectWithFallback();
      if (result.label === "fallback") {
        console.error(`[aitl] primary MongoDB unreachable; using fallback: ${result.uri}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error("\n[aitl] No hay MongoDB accesible. Revisa MONGODB_URI/MONGODB_URI_FALLBACK o corre `aitl check-db`.");
      process.exit(1);
    }
    try {
      const { initRepo } = await import("./init/initRepo.js");
      const hosts = opts.host
        ? String(opts.host).split(",").map((h: string) => h.trim()).filter(Boolean)
        : [];
      const bad = hosts.filter((h: string) => h !== "claude-code" && h !== "codex");
      if (bad.length) {
        console.error(`--host inválido: ${bad.join(", ")} (soportados: claude-code, codex)`);
        process.exitCode = 1;
        return;
      }
      const report = await initRepo({
        root: opts.root,
        project: opts.project,
        software: opts.software,
        repo: opts.repo,
        host: hosts as ("claude-code" | "codex")[],
        memoryOnly: Boolean(opts.memoryOnly),
        force: Boolean(opts.force),
      });
      console.log(
        `aitl init — proyecto '${report.project}' · software '${report.software}' · repo '${report.repo}'` +
          `${report.branch ? ` @${report.branch}` : ""} (${report.root})`,
      );
      for (const s of report.steps) console.log(`  [${s.status}] ${s.step}: ${s.detail}`);
      console.log("\nPróximos pasos:");
      for (const n of report.next) console.log(`  ${n}`);
    } catch (err) {
      console.error(`[aitl init] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
    }
  });

init
  .command("agent")
  .option("-i, --interactive", "Prompt for the values instead of using defaults.", false)
  .option("--out <file>", "Output markdown file.", "AGENTS.md")
  .option("--project <project>", "Project scope the agent should use.", "aitl-js")
  .option("--mcp <name>", "MCP server name to consult.", "aitl-js")
  .option("--force", "Overwrite an existing AGENTS.md.", false)
  .description("Create an agent guide (AGENTS.md) that reminds the agent to consult the MCP on every decision.")
  .action(async (opts) => {
    const { writeAgentGuide } = await import("./init/agent.js");
    const path = await writeAgentGuide({
      out: opts.out,
      project: opts.project,
      mcp: opts.mcp,
      interactive: opts.interactive,
      force: opts.force,
    });
    console.log(`Wrote agent guide to ${path}.`);
  });

init
  .command("claude")
  .option("-i, --interactive", "Prompt for the values instead of using defaults.", false)
  .option("--out <file>", "Output markdown file.", "CLAUDE.md")
  .option("--project <project>", "Project scope the session should use.", "aitl-js")
  .option("--mcp <name>", "MCP server name to consult.", "aitl-js")
  .option("--force", "Overwrite an existing CLAUDE.md.", false)
  .description("Create a CLAUDE.md initializer wiring Claude Code to this harness (MCP contract + measurement + setup).")
  .action(async (opts) => {
    const { writeClaudeGuide } = await import("./init/claude.js");
    const path = await writeClaudeGuide({
      out: opts.out,
      project: opts.project,
      mcp: opts.mcp,
      interactive: opts.interactive,
      force: opts.force,
    });
    console.log(`Wrote CLAUDE.md initializer to ${path}.`);
  });

// ── migrate-atlas (copy a DB to another cluster, e.g. local → Atlas; data only) ──
program
  .command("migrate-atlas")
  .argument("<target-uri>", "Destination MongoDB URI (e.g. an Atlas mongodb+srv string).")
  .option("--from <uri>", "Source URI (default: configured MONGODB_URI).")
  .option("--from-db <db>", "Source database (default: configured MONGODB_DB).")
  .option("--to-db <db>", "Target database (default: same as source).")
  .option("--collections <list>", "Comma-separated subset (default: all).")
  .option("--drop", "Drop each target collection before copying (overwrite).", false)
  .option("--dry-run", "Report counts without writing anything.", false)
  .description("Copy a database to another MongoDB/Atlas cluster (data only; run init-db on the target for indexes).")
  .action(async (targetUri, opts) => {
    const { migrateToAtlas } = await import("./migrate/atlas.js");
    const rows = await migrateToAtlas({
      targetUri,
      fromUri: opts.from,
      fromDb: opts.fromDb,
      toDb: opts.toDb,
      collections: opts.collections
        ? String(opts.collections).split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined,
      drop: opts.drop,
      dryRun: opts.dryRun,
    });
    const total = rows.reduce((n, r) => n + r.copied, 0);
    for (const r of rows) console.log(`${r.collection.padEnd(16)} ${r.copied}`);
    console.log(
      `TOTAL: ${total} docs across ${rows.length} collections` +
        (opts.dryRun ? " (dry-run — nothing written)." : "."),
    );
    const to = opts.toDb ?? opts.fromDb ?? "<db>";
    console.log(`Next (indexes incl. vector): MONGODB_URI="${targetUri}" MONGODB_DB="${to}" aitl init-db`);
    await closeClient();
  });

// ── hydrate (print a durable-context preamble for injection into a host session) ──
// Designed for a Claude Code UserPromptSubmit/SessionStart hook: stdout is added to the
// model's context. Best-effort and silent on failure so it never breaks the session.
program
  .command("hydrate")
  .argument("[prompt]", "Prompt to bias relevance (else read from the hook JSON on stdin).")
  .option("--project <project>", "Project scope.", "aitl-js")
  .option("--component <name>", "Bias retrieval toward a named component.")
  .option("--no-vector", "Skip embeddings (text→recency fast path). Recommended for per-prompt hooks.")
  .option("--max-chars <n>", "Memory budget in characters.", "4000")
  .description("Print a durable-context preamble (memory + ADRs + conventions + repo map) to inject into an external agent host.")
  .action(async (promptArg, opts) => {
    try {
      let prompt = String(promptArg ?? "");
      if (!prompt) {
        const { readHookStdin } = await import("./context/capture.js");
        const hook = await readHookStdin();
        prompt = String(hook.prompt ?? "");
      }
      if (opts.component) prompt = `${opts.component} ${prompt}`.trim();
      const { hydrate } = await import("./memory/lifecycle.js");
      const res = await hydrate(opts.project, prompt, {
        vector: opts.vector,
        maxChars: Number(opts.maxChars),
      });
      if (res.preamble.trim()) process.stdout.write(`${res.preamble}\n`);
    } catch (err) {
      // Never fail a host hook: report on stderr, emit nothing to stdout.
      console.error(`[aitl hydrate] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await closeClient();
    }
  });

// ── capture-session (persist a finished host session into durable memory) ─────────
// Designed for a Claude Code Stop hook: reads the hook JSON on stdin (transcript_path,
// session_id, cwd), summarizes the transcript into ONE durable memory doc + a context
// snapshot, auto-tagged by the components (dirs) the session edited.
program
  .command("capture-session")
  .option("--project <project>", "Project scope.", "aitl-js")
  .option("--transcript <path>", "Transcript JSONL path (else read from the Stop-hook JSON on stdin).")
  .option("--session <id>", "Session id used as the run id (else from stdin or random).")
  .option("--cwd <dir>", "Working dir used to derive component tags (else from stdin or process cwd).")
  .option("--component <name>", "Explicit component name to tag (added to the auto dir tags).")
  .option("--source <source>", "Host label for tags/snapshot.", "claude-code")
  .description("Capture a finished external-host session into durable memory + a context snapshot, auto-tagged by component.")
  .action(async (opts) => {
    try {
      let transcript = opts.transcript as string | undefined;
      let session = opts.session as string | undefined;
      let cwd = opts.cwd as string | undefined;
      if (!transcript || !session) {
        const { readHookStdin } = await import("./context/capture.js");
        const hook = await readHookStdin();
        transcript = transcript ?? (hook.transcript_path as string | undefined);
        session = session ?? (hook.session_id as string | undefined);
        cwd = cwd ?? (hook.cwd as string | undefined);
      }
      const { captureSession } = await import("./context/capture.js");
      const res = await captureSession({
        project: opts.project,
        transcriptPath: transcript,
        sessionId: session,
        cwd,
        component: opts.component,
        source: opts.source,
      });
      const tu = res.token_usage;
      const a = res.artifacts;
      console.error(
        `[aitl capture-session] run=${res.run_id.slice(0, 8)} ` +
          `tokens=${tu.input + tu.output} (in=${tu.input} out=${tu.output}) ` +
          `artifacts=[ADRs ${a.decisions.length}, mem ${a.memories.length}, prompts ${a.prompts.length}] ` +
          `memory=${res.summary?.slug ?? "(none)"} ` +
          `components=[${res.components.join(", ")}] snapshot=${res.context_id ? "ok" : "skipped"}`,
      );
    } catch (err) {
      console.error(`[aitl capture-session] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await closeClient();
    }
  });

// ── Extended per-command help ────────────────────────────────────────────────
// Concrete examples + notes appended (commander `addHelpText("after", …)`) to every
// command and subcommand, keyed by its space-joined path (no `aitl` prefix). Shown by
// `aitl <cmd> --help`. Purely additive: descriptions/behavior are unchanged.
const HELP_EXAMPLES: Record<string, string> = {
  "interactive": `
Examples:
  aitl                      # bare invocation opens the panel
  aitl -i
  aitl interactive

The panel supervises child processes (MCP server, web UI) and runs commands; it requires a TTY.`,

  "check-db": `
Examples:
  aitl check-db

Notes:
  Tries MONGODB_URI, then MONGODB_URI_FALLBACK. Also reports RBAC readiness (users
  collection, unique indexes, root user). Exit code 1 if RBAC is not ready.`,

  "init-db": `
Examples:
  aitl init-db

Notes:
  Idempotent. Creates collections, scalar/text indexes and Atlas $vectorSearch indexes.
  Run once per database (and again after changing EMBEDDING_DIMS).`,

  "ingest": `
Examples:
  aitl ingest --path docs --project demo
  aitl ingest --path ./notes --project demo --repo backend

Notes:
  Pipeline: parse markdown → classify → embed → upsert. Frontmatter and [[wiki-links]]
  are preserved. Re-running upserts by slug (no duplicates).`,

  "search": `
Examples:
  aitl search "token accounting" --project demo
  aitl search "auth flow" --project demo --collection decisions --limit 5

Notes:
  Uses Atlas $vectorSearch; falls back to text search if the vector index is missing.
  --collection: memory | messages | decisions.`,

  "run": `
Examples:
  aitl run "add a health endpoint" --project demo                  # C2 (full harness)
  aitl run "add a health endpoint" --project demo --bare           # C0 (no memory/skills/gates)
  aitl run "fix the failing test" --project demo --verify-cmd "npm test"
  aitl run "harden the upload" --project demo --roles security,architect
  aitl run "add a health endpoint" --project demo --model lmstudio # local LM Studio server
  aitl run "migrate the config file" --project demo --ask          # confirm write_file/shell first
  aitl run "use the db tools to list repos" --project demo --mcp   # mount ./.mcp.json servers
  aitl run "..." --project demo --mcp=./configs/tools.mcp.json     # explicit manifest path
  aitl run "write a haiku about tests" --project demo --stream     # live token deltas

Notes:
  Drives the model-agnostic loop (needs a configured model, e.g. OPENROUTER_API_KEY).
  --model lmstudio targets a local LM Studio server (default http://localhost:1234/v1;
  start it with \`lms server start\` and set LMSTUDIO_MODEL). --model openai-compat
  targets any OpenAI-compatible endpoint via OPENAI_COMPAT_BASE_URL/MODEL.
  --ask pauses before side-effect tools (y/n/always, prompt on stderr); without a TTY
  the --ask-fallback policy decides (deny by default). Approvals + answer latency show
  up in run-show as approvals/supervision_minutes (human supervision metric).
  --mcp mounts every server in .mcp.json (standard format, same file Claude Code reads)
  as tools named mcp__<server>__<tool>; non read-only MCP tools respect --ask. Use
  --mcp=<path> (with =) since the path is optional. A server that fails to start is
  skipped with a warning — the run continues.
  --stream prints assistant deltas live (approval prompts go to stderr, so --ask
  combines cleanly). Servers that omit the stream usage chunk (older LM Studio)
  report 0 tokens for streamed turns; a mid-stream retry may repeat deltas.
  --verify-cmd makes the run end only when the command exits 0 (quality gate).
  Experimental comparison (thesis conditions): C0 = \`aitl run --bare\` (no hydrate,
  no skills, no gates) vs C2 = the default full harness. Run the same task under both
  conditions and compare with run-show — there is no separate eval command.
  Persists a run+transcript; inspect it with: aitl run-show <runId>.`,

  "chat": `
Examples:
  aitl chat                                  # auto: usa el LLM configurado (+fallback)
  aitl chat --project demo --model lmstudio
  aitl chat --project demo --ask --mcp

Notes:
  REPL estilo Claude Code sobre UN run durable: cada turno reanuda el transcript
  (inspección: aitl run-show <runId>). Slash commands: /help /models /model <n>
  /tools /tokens /new /id /ask /exit. --model auto (default) detecta el primer
  backend configurado y encadena el resto como fallback; el texto streamea en vivo
  cuando el provider implementa chatStream (ADR-0005) y las tool calls se muestran
  con su duración. Sin --project usa $AITL_PROJECT o el nombre de la carpeta.`,

  "sdd": `
Examples:
  aitl sdd "Como admin quiero exportar reportes CSV. Criterios: ..." --project demo
  aitl sdd "fix the login button" --project demo --model lmstudio    # spec gets generated

Notes:
  Phase D of spec-driven development (ADR-0042). A prompt that already reads as a spec
  is persisted VERBATIM (type "spec"); an ad-hoc task is formalized first. Then the
  provider derives a design doc (type "design") and decomposes it into tasks (type
  "task"), all chained by tags run:<id8> / parent:<slug>. The pipeline shows up as a
  Run (harness_config.sdd=true) in run-show and the web UI Runs tab. Search artifacts
  with: aitl search "sdd design" --project <p>.`,

  "intervene": `
Examples:
  aitl intervene <runId> --reason "had to fix a wrong import" --minutes 3

Notes:
  Records a human_intervention event on the run (thesis Tabla 4.3 #6). Surfaces in run-show.`,

  "run-show": `
Examples:
  aitl run-show 1a2b3c4d-....

Notes:
  Prints tokens (in/out/total), iters, tool_calls, gate_denials, duration, roles,
  human interventions and event counts. Host runs also show host_meta (cost/turns/cache)
  and spec. See docs/token-accounting.md for how tokens are summed.`,

  "run-host": `
Examples:
  aitl run-host "implement the spec in SPEC.md" --project demo --host claude-code
  aitl run-host "refactor utils" --project demo --host codex --cwd ./packages/core
  aitl run-host "draft notes" --project demo --host claude-code --no-spec-synthesis
  aitl run-host "build it" --project demo --host claude-code \\
    --allowed-tools "Bash(make:*),Bash(python3:*)"

Notes:
  Runs the task OVER an external agent host, wrapped with durable context + telemetry.
  Claude Code reports measured tokens/cost/turns (via --output-format json). Spec-shaped
  prompts are auto-classified, persisted, and synthesized with the outcome. No model key needed.
  Permissions travel EXPLICITLY on the argv (never via the target dir's settings/trust):
  claude-code defaults to --permission-mode acceptEdits; pre-approve more tools with
  --allowed-tools, or override everything with --permission-mode. Any host also accepts
  raw extra argv via AITL_HOST_ARGS_<NAME> (e.g. AITL_HOST_ARGS_CLAUDE_CODE).`,

  "orchestrate": `
Examples:
  aitl orchestrate "migrate the API to v2" --project demo --max 4

Notes:
  Decomposes the task, runs sub-agents in parallel (fresh context each), and synthesizes.`,

  "synthesize": `
Examples:
  aitl synthesize --project demo
  aitl synthesize --project demo --force
  aitl synthesize --project demo --force --compact     # sources leave the live memory
  aitl synthesize --project demo --force --at v1.2.0   # stamp docs with that ref's commit

Notes:
  Compacts the memory bank by category when it exceeds the configured limit (--force
  ignores the limit). Rolling compression: each run folds the previous synthesis plus
  only the docs that accumulated since. With a model the summary is map-reduced over
  bounded chunks (nothing silently truncated); without one it degrades to extractive.
  --compact stamps the absorbed sources with compacted_into so they leave hydrate and
  the growth trigger — they stay searchable/versioned; NOTHING is deleted. Never
  touches ADRs. --at resolves any git ref and stamps its commit_sha on the synthesis
  docs (provenance only — no historical reconstruction). Afterwards it PROPOSES
  stale-ADR deprecations (superseded_by set, review_after lapsed, near-duplicate
  titles); apply them manually with \`aitl adr deprecate\`.`,

  "repomap": `
Examples:
  aitl repomap --root . --project demo
  aitl repomap --root . --project demo --repo backend
  aitl repomap --modules --project demo --repo backend        # module map from the cached symbols
  aitl repomap --modules --json --root . --project demo       # rebuild first, then JSON module map

Notes:
  Builds the symbol map (tree-sitter heuristic) + PageRank and prints the top symbols.
  --modules groups the cached symbols by first-level dir (kind view|back|mixed|infra,
  files, top symbols by PageRank); when ONE top-level dir holds >80% of the files it
  descends one level (src/server, src/db, ...). Override kinds in .aitl/modules.json.
  Tip: point --root at src to avoid indexing dist/ noise.`,

  "module-brief": `
Examples:
  aitl module-brief src/server --project demo
  aitl module-brief web --project demo --repo frontend --json

Notes:
  Renders the module's invariants checklist: its module-map block (kind, files, top
  symbols) + ACTIVE ADRs whose components[] match the dir (prefix match both ways;
  deprecated/superseded excluded) + memories tagged component:<dir>. Tag decisions
  via record_decision { components: ["src/server"] }; capture-session auto-tags memories.`,

  "index-repo": `
Examples:
  aitl index-repo --root . --project demo
  aitl index-repo --root . --project demo --repo backend --memory docs --adr docs/adr

Notes:
  Master indexer: repo map + memory ingest + ADR sync in one pass.`,

  "adr-sync": `
Examples:
  aitl adr-sync --dir docs/adr --project demo

Notes:
  Mirrors Nygard-format ADR markdown into the decisions collection (file → ledger only).
  For the bidirectional (ledger ⇄ file) flow with conflict detection use: aitl sync.`,

  "export": `
Examples:
  aitl export --adapter cursor --project demo
  aitl export --adapter agents_md --project demo --root .
  aitl export --adapter markdown --project demo     # Mongo → .aitl/ + docs/adr (one-shot)

Notes:
  Adapters: agents_md | cursor | copilot | antigravity | kiro | trae | markdown.
  Incremental write. The markdown adapter is manifest-less: .aitl/ is overwritten
  freely, but existing docs/adr files with different content are kept (use aitl sync).`,

  "sync": `
Examples:
  aitl sync --project demo                 # bidireccional: propaga y reporta conflictos
  aitl sync --pull --project demo          # Mongo gana: refresca el espejo en disco
  aitl sync --push --project demo          # disco gana: sube tus ediciones .md a Mongo

Notes:
  Espejo canónico: memoria/skills/agents en .aitl/{memory,skills,agents}/<slug>.md y
  ADRs en docs/adr/NNNN-slug.md. El manifiesto .aitl/.sync-state.json guarda el hash
  de CADA lado en el último sync: "cambió" = cambió respecto a esa línea base, nunca
  "difiere del otro lado". Primera corrida (bootstrap): lo que existe en un solo lado
  se propaga; lo que existe en ambos con bytes distintos NO se toca (se siembra la
  línea base) — por eso los docs/adr escritos a mano sobreviven byte a byte.
  Conflicto (cambió en ambos) → exit code 2 y nada se escribe; resuélvelo con --pull
  o --push. Los borrados nunca se propagan. --include-reserved añade los tipos de
  pipeline (synthesis/spec/design/task). Sin --project usa $AITL_PROJECT o la carpeta.`,

  "mcp": `
Examples:
  aitl mcp                                              # stdio (Claude Code default)
  aitl mcp --http --host 127.0.0.1 --port 8000 --token "<secret>"
  aitl mcp --http --socket /tmp/aitl-mcp.sock

Notes:
  stdio is what most MCP clients use; logs go to stderr/AITL_MCP_LOG_FILE. Use --token
  when exposing --http beyond localhost (or set AITL_MCP_TOKEN).`,

  "ui": `
Examples:
  aitl ui --project demo
  aitl ui --project demo --api-port 4320 --web-port 5320
  aitl ui --project demo --no-web        # API only

Notes:
  Tabs: Memory · Decisions · Prompts · Runs · Graph · Knowledge. Restart it after upgrading
  to pick up new API routes. API → :4317/api, SPA → :5317 by default.`,

  "migrate-atlas": `
Examples:
  aitl migrate-atlas "mongodb+srv://user:pass@cluster.mongodb.net/aitl" --to-db aitl --dry-run
  aitl migrate-atlas "<target-uri>" --to-db aitl --drop

Notes:
  Copies data only; run init-db on the target for indexes. --dry-run reports counts without writing.`,

  "hydrate": `
Examples:
  aitl hydrate "what did we decide about auth?" --project demo --no-vector
  echo '{"prompt":"..."}' | aitl hydrate --project demo

Notes:
  Prints a durable-context preamble to stdout. Designed as a Claude Code UserPromptSubmit
  hook (its stdout is injected into the model's context). --no-vector is recommended per-prompt.`,

  "capture-session": `
Examples:
  aitl capture-session --project demo --transcript ~/.claude/projects/<dir>/<session>.jsonl --session <id>
  cat stop-hook.json | aitl capture-session --project demo

Notes:
  Designed as a Claude Code Stop hook. Records the session as a run with MEASURED tokens,
  links the ADRs/memories/prompts it produced (per-session graph), and writes a memory
  summary + context snapshot. Re-running with the same --session refreshes it.`,

  "review": `
Examples:
  aitl review @diff.txt --project demo --roles security,architect
  aitl review "DROP TABLE users;" --project demo --roles security

Notes:
  Engineering roles critique a target → a DecisionBrief that ASSISTS the engineer (it does
  not decide). @file reads the target from a file.`,

  // ── parents (overview + pointer to subcommands) ──
  "user": `
Subcommands: bootstrap | verify | list | create | register | set-role | disable
Example:  aitl user list`,
  "config": `
Subcommands: path | show | export | import | set | unset
Example:  aitl config show`,
  "prompt": `
Subcommands: add | list | search
Example:  aitl prompt list --project demo`,
  "adr": `
Subcommands: history | deprecate
Example:  aitl adr history 0026 --project demo --diff`,
  "memory": `
Subcommands: history
Example:  aitl memory history my-slug --project demo --diff`,
  "software": `
Subcommands: add | list | get | rm
Example:  aitl software list`,
  "repo": `
Subcommands: add | list | get | rm
Example:  aitl repo list --project demo`,
  "branch": `
Subcommands: sync | list | rm
Example:  aitl branch sync --project demo --repo backend`,
  "role": `
Subcommands: seed | list | rm | gate-check
Example:  aitl role list --project demo`,
  "build": `
Subcommands: skill | agent | seed
Example:  aitl build skill code-review --project demo`,
  "init": `
Examples:
  aitl init                                          # onboard the cwd repo end-to-end
  aitl init --root ../mi-app --project mi-app --host claude-code
  aitl init --memory-only --host claude-code          # sin LLM: hydrate/search/sync/capture
  aitl init --force                                   # re-aplica pasos y sobrescribe guías

Notes:
  Idempotente: cada paso reporta [ok|skip|done|warn]; una segunda corrida es todo skip.
  Pasos: DB (colecciones/índices/root) → identidad (software/repo/branches) → índice
  maestro (símbolos+memoria+ADRs) → seeds (skills/roles) → guías CLAUDE.md/AGENTS.md →
  .mcp.json → hooks del host → hook git post-merge (branch sync --reindex).
  No pisa archivos existentes sin --force (merge conservador: añade solo lo que falta).
  --memory-only omite la validación de provider (run/chat requieren backend o host).

Subcommands (solo guías, sin DB): agent | claude
  aitl init claude --project demo`,

  // ── user subcommands ──
  "user bootstrap": `
Examples:
  aitl user bootstrap

Notes:
  Creates the env-configured bootstrap user if missing (AITL_BOOTSTRAP_*).`,
  "user verify": `
Examples:
  aitl user verify --username root --email root@x.com --password "<pw>"`,
  "user list": `
Examples:
  aitl user list

Notes:
  Root-only. Never prints password hashes.`,
  "user create": `
Examples:
  aitl user create --username alice --email alice@x.com --password "<12+ chars>" --role admin

Notes:
  Root-only; audited. Roles: root | admin | user | agent | auditor.`,
  "user register": `
Examples:
  aitl user register --username alice --email alice@x.com --password "<12+ chars>"

Notes:
  Self-service (no root needed) — same flow as the web signup. The first real user
  (excluding the local-root bootstrap) becomes admin; later ones are plain users.
  Username and email must be unique; audited (action "register").`,
  "user set-role": `
Examples:
  aitl user set-role --username alice --role auditor

Notes:
  Root-only; audited.`,
  "user disable": `
Examples:
  aitl user disable --username alice
  aitl user disable --username alice --enable     # re-enable`,

  // ── config subcommands ──
  "config path": `
Examples:
  aitl config path          # prints ~/.aitl/config.json (or $AITL_HOME)`,
  "config show": `
Examples:
  aitl config show
  aitl config show --secrets        # reveal secrets (handle with care)

Notes:
  Effective config = env > file > defaults. Secrets masked unless --secrets.`,
  "config export": `
Examples:
  aitl config export --out profile.json
  aitl config export --secrets --out profile.json    # do NOT share`,
  "config import": `
Examples:
  aitl config import profile.json
  aitl config import profile.json --merge`,
  "config set": `
Examples:
  aitl config set MONGODB_URI "mongodb+srv://user:pass@cluster.mongodb.net/aitl?appName=app"
  aitl config set MONGODB_DB aitl
  aitl config set OPENROUTER_API_KEY "<key>"
  aitl config set MODEL_PRIMARY lmstudio --env    # also mirror into ./.env

Notes:
  URL-encode special chars in passwords (e.g. * → %2A). Stored in plain text locally; never commit it.
  --env mirrors the key into the project's .env (uncomments "# KEY=..." lines, preserves the rest).`,
  "config unset": `
Examples:
  aitl config unset OPENROUTER_API_KEY`,

  // ── prompt subcommands ──
  "prompt add": `
Examples:
  aitl prompt add "implement the spec" --project demo --title "spec-foo" --tags spec,sdd`,
  "prompt list": `
Examples:
  aitl prompt list --project demo
  aitl prompt list --project demo --tag spec --limit 20`,
  "prompt search": `
Examples:
  aitl prompt search "auth" --project demo`,

  // ── adr / memory history ──
  "adr history": `
Examples:
  aitl adr history 0026 --project demo
  aitl adr history 0026 --project demo --diff
  aitl adr history 0026 --project demo --from 1 --to 3`,
  "adr deprecate": `
Examples:
  aitl adr deprecate 0026 --project demo --reason "replaced by the event-driven design"
  aitl adr deprecate 0026 --project demo --reason "obsolete" --superseded-by 0031
  aitl adr deprecate 0026 --project demo --reason "revisit quarterly" --review-after 2027-01-31

Notes:
  Append-only: the prior version is archived in decisions_history and the live doc gets
  status "deprecated" + deprecation_reason (never deleted). Deprecated ADRs are excluded
  from \`aitl hydrate\`; review_after is a SOFT TTL that flags the ADR "needs review".`,
  "memory history": `
Examples:
  aitl memory history project-identity --project demo --diff`,

  // ── software subcommands ──
  "software add": `
Examples:
  aitl software add acme --display "ACME Platform" --projects demo,web --tags saas`,
  "software list": `
Examples:
  aitl software list
  aitl software list --tag saas`,
  "software get": `
Examples:
  aitl software get acme`,
  "software rm": `
Examples:
  aitl software rm acme`,

  // ── repo subcommands ──
  "repo add": `
Examples:
  aitl repo add backend --project demo --software acme --remote git@github.com:acme/backend.git --branch main --path ./backend`,
  "repo list": `
Examples:
  aitl repo list --project demo
  aitl repo list --software acme`,
  "repo get": `
Examples:
  aitl repo get backend --project demo`,
  "repo rm": `
Examples:
  aitl repo rm backend --project demo`,

  // ── branch subcommands ──
  "branch sync": `
Examples:
  aitl branch sync --project demo --repo backend --root .
  aitl branch sync --project demo --repo backend --root . --reindex

Notes:
  Reads local git branches, classifies them (main/develop/release/feature/…) and detects
  the real base by fork-point. Falls back to gitflow conventions without git.
  --reindex compares the base trunk's stored head vs the live one and, if it advanced
  (e.g. a merge landed), re-runs the master indexer (repo map + memory + ADRs).`,
  "branch list": `
Examples:
  aitl branch list --project demo
  aitl branch list --project demo --repo backend --kind feature`,
  "branch rm": `
Examples:
  aitl branch rm feature/x --project demo --repo backend`,

  // ── role subcommands ──
  "role seed": `
Examples:
  aitl role seed --project demo

Notes:
  Seeds security, devops, qa, architect, devsecops.`,
  "role list": `
Examples:
  aitl role list --project demo`,
  "role rm": `
Examples:
  aitl role rm security --project demo`,
  "role gate-check": `
Examples:
  aitl role gate-check .env --project demo --role security
  aitl role gate-check src/app.ts --project demo --role security

Notes:
  Deterministic veto for a path (no model). Useful in CI/pre-commit.`,

  // ── coord subcommands (ADR-0002 v1) ──
  "coord claim": `
Examples:
  aitl coord claim "T3-tenant-isolation" --project schoolar --scope "schoolar backend"
  aitl coord claim src/auth/rbac.ts --project aitl-js --ttl 15
  AITL_COORD_OWNER=alice aitl coord claim T3 --project demo   # explicit owner identity

Notes:
  Atomic: ONE active claim per (project, task_key) — a partial unique index arbitrates
  races. Conflicts exit 1 and report the holder + expiry. Claims ALWAYS expire (default
  30 min, AITL_CLAIM_TTL_MS); re-claiming your own task renews it (heartbeat), and an
  expired claim is taken over (emits expire_reclaim). Owner identity: AITL_COORD_OWNER,
  else AITL_MCP_ACTOR_ID, else cli:<os-user>@<host>.`,
  "coord release": `
Examples:
  aitl coord release "T3-tenant-isolation" --project schoolar
  aitl coord release "T3-tenant-isolation" --project schoolar --outcome abandoned

Notes:
  Only the owner may release (same identity rules as coord claim). Emits a release
  event with the outcome so peers see "[release] ... (done|abandoned)" on their poll.`,
  "coord list": `
Examples:
  aitl coord list --project schoolar
  aitl coord list --project schoolar --all      # include released/expired history`,
  "coord poll": `
Examples:
  aitl coord poll --project schoolar
  aitl coord poll --project schoolar --since 2026-07-06T12:00:00Z
  aitl coord poll --project schoolar --quiet    # hook-friendly: silent when idle

Notes:
  One compact line per event: "[claim] alice tomó T3 (expira 12:45)", "[decision] nuevo
  ADR 0054: ...". Incremental without flags: the last cursor persists in
  ~/.aitl/coord-cursor-<projecthash>.json (base dir honours AITL_HOME); first ever poll
  defaults to the last 60 minutes. --quiet prints ONLY when there are new events and
  always exits 0 — wire it as a Claude Code hook, e.g. in .claude/settings.json:
    { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
      "command": "aitl coord poll --project <p> --quiet" } ] } ] } }`,

  // ── build subcommands ──
  "build skill": `
Examples:
  aitl build skill code-review --project demo --desc "review diffs for bugs"
  aitl build skill api-style --project demo --from docs/api-style.md --tags conventions`,
  "build agent": `
Examples:
  aitl build agent triager --project demo --host claude-code --model anthropic/claude-3.5-sonnet`,
  "build seed": `
Examples:
  aitl build seed --project demo

Notes:
  Registers the master skills (definition-builder, repo-indexer).`,

  // ── init subcommands ──
  "init agent": `
Examples:
  aitl init agent --project demo --mcp aitl-js --out AGENTS.md
  aitl init agent -i

Notes:
  Writes an AGENTS.md operating contract (consult the MCP before decisions, persist after).`,
  "init claude": `
Examples:
  aitl init claude --project demo --mcp aitl-js --out CLAUDE.md
  aitl init claude --project demo --force        # overwrite an existing CLAUDE.md

Notes:
  Writes a CLAUDE.md that wires Claude Code to this harness: MCP contract + measurement +
  setup checklist (.mcp.json, permissions, hooks, Mongo). Won't overwrite without --force.`,
};

function attachHelpExamples(cmd: Command, prefix: string): void {
  const key = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  const extra = HELP_EXAMPLES[key];
  if (extra) cmd.addHelpText("after", extra);
  for (const sub of cmd.commands) attachHelpExamples(sub, key);
}
for (const c of program.commands) attachHelpExamples(c, "");

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
