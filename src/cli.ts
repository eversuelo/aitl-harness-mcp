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
 *   aitl export --adapter cursor --project P  project canon into a tool's format
 *   aitl eval --models gemini,openai --project P  run the eval delta (stub benchmarks)
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
  .option("-i, --interactive", "Launch the interactive control panel (supervise MCP/UI, run commands).");

// Commands that never touch MongoDB — skip the connection probe so they stay instant
// and work offline (the interactive panel only supervises child processes).
const NO_DB_COMMANDS = new Set(["interactive", "menu", "config", "init", "help", "check-db"]);

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
    console.error(err instanceof Error ? err.message : String(err));
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
  .option("--model <m>", "primary | secondary | openrouter", "primary")
  .option("--bare", "C0 baseline: no hydration, no skills, no gates (improvised agent).")
  .option("--verify-cmd <cmd>", "Quality gate: shell command that must exit 0 to end the run (e.g. a test cmd).")
  .option("--roles <list>", "Comma-separated engineering roles (H11) to attach (e.g. security,architect,qa).")
  .description("Run the model-agnostic agent loop, persisting the run/transcript to Mongo.")
  .action(async (task, opts) => {
    const { runAgent } = await import("./orchestration/graph.js");
    const { getProvider } = await import("./providers/base.js");
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
    const result = await runAgent(task, opts.project, {
      provider: await getProvider(opts.model),
      installDefaultTools: true,
      ...(verify ? { verify } : {}),
      ...(roles ? { roles } : {}),
      ...(opts.bare ? { hydrate: false, skills: false, gates: false } : {}),
    });
    console.log(`run_id=${result.run_id} iters=${result.iters} gate_denials=${result.gate_denials}`);
    if (result.decision_brief) {
      console.log(`\n── Decision brief (H11) ── ${result.decision_brief.summary}`);
      for (const v of result.decision_brief.verdicts) {
        console.log(`  [${v.role}/${v.mode}] ${v.stance}${v.findings.length ? `: ${v.findings.join("; ")}` : ""}`);
      }
    }
    console.log(`\n${result.final_text}`);
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
    await new MemoryStore().logEvent(makeEvent({ project, run_id: runId, type: "human_intervention", payload: { reason: opts.reason, minutes: Number(opts.minutes) } }));
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
    const db = getDb();
    await ensureMongoose();
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
    for (const e of events) {
      const t = String(e.type);
      byType[t] = (byType[t] ?? 0) + 1;
      if (t === "hydrate") hydrateSections = (e.payload as Record<string, unknown>) ?? null;
      if (t === "human_intervention") interventionMinutes += Number((e.payload as Record<string, unknown>)?.minutes ?? 0);
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
  .option("--no-record-prompt", "Do not persist the prompt to the durable history.")
  .option("--no-spec-synthesis", "Do not synthesize spec-classified runs into durable memory.")
  .description("Run a task OVER an external agent host (Codex/Claude Code/Antigravity), wrapped with durable context + telemetry.")
  .action(async (task, opts) => {
    const { runOnHost } = await import("./hosts/run.js");
    const result = await runOnHost(task, opts.project, {
      host: opts.host,
      cwd: opts.cwd,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
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
  .command("orchestrate")
  .argument("<task>", "Master task prompt.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--model <m>", "primary | secondary | openrouter", "primary")
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
  .description("Compact a project's memory when it exceeds the configured limit.")
  .action(async (opts) => {
    const { Synthesizer } = await import("./memory/synthesizer.js");
    const written = await new Synthesizer().synthesize(opts.project, { force: opts.force });
    console.log(`Synthesis docs written: ${written.length ? written.join(", ") : "(none — under limit)"}`);
    await closeClient();
  });

program
  .command("repomap")
  .requiredOption("--root <dir>", "Codebase root to map.")
  .requiredOption("--project <project>", "Project scope.")
  .option("--repo <repo>", "Repo sub-scope (rebuilds only this repo's symbols).")
  .description("Build the tree-sitter + PageRank repo map and print the top symbols.")
  .action(async (opts) => {
    const { RepoMap } = await import("./repomap/store.js");
    const rm = new RepoMap();
    const n = await rm.build(opts.root, opts.project, opts.repo ?? null);
    console.log(`Indexed ${n} symbols${opts.repo ? ` for repo '${opts.repo}'` : ""}.\n`);
    console.log(await rm.render(opts.project, opts.repo ? { repo: opts.repo } : {}));
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
  .requiredOption("--adapter <name>", "agents_md | cursor | copilot | antigravity | kiro | trae")
  .requiredOption("--project <project>", "Project scope.")
  .option("--root <dir>", "Repo root to write tool files into.", ".")
  .description("Project the canonical artifacts into a tool's native format (incremental).")
  .action(async (opts) => {
    const { getAdapter, loadCanon } = await import("./adapters/base.js");
    const canon = await loadCanon(opts.project, opts.root);
    const written = await (await getAdapter(opts.adapter)).export(canon, opts.root);
    console.log(`Wrote: ${written.join(", ")}`);
    await closeClient();
  });

program
  .command("eval")
  .requiredOption("--models <list>", "Comma-separated model roles/names (e.g. gemini,openai).")
  .option("--project <project>", "Project scope.", "eval")
  .description("Run a benchmark with/without the harness for ≥2 models (concrete benchmarks TODO).")
  .action(async (opts) => {
    console.log(
      `eval requires a concrete Benchmark implementation (see src/eval/runner.ts TODOs). ` +
        `Models: ${opts.models}, project: ${opts.project}.`,
    );
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
  .description("Set a single key in the user-level config profile.")
  .action(async (key, value) => {
    const { ENV_KEYS, writeConfigFile } = await import("./config/store.js");
    if (!(ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown key '${key}'. Known: ${ENV_KEYS.join(", ")}`);
    }
    const path = await writeConfigFile({ [key]: value }, { merge: true });
    console.log(`Set ${key} in ${path}.`);
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

program
  .command("adr")
  .description("Inspect ADR revision history.")
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
  .description("Read the repo's git branches, classify them and upsert into the catalog.")
  .action(async (opts) => {
    const { syncBranches } = await import("./branches/sync.js");
    const recs = await syncBranches({ project: opts.project, repo: opts.repo, root: opts.root, remote: opts.remote });
    console.log(`Synced ${recs.length} branch(es) for ${opts.project}/${opts.repo}:`);
    for (const r of recs) {
      const env = r.environment !== "none" ? ` [${r.environment}]` : "";
      const from = r.base ? ` ← ${r.base}` : "";
      console.log(`  ${r.name}  (${r.kind})${env}${from}`);
    }
    if (!recs.length) console.log("  (no local branches found — is --root a git repo?)");
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
  .option("--model <m>", "primary | secondary | openrouter", "primary")
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

// ── init agent (write an AGENTS.md that enforces consulting the AITL MCP) ─────────
const init = program.command("init").description("Scaffold agent/project artifacts.");

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

Notes:
  Drives the model-agnostic loop (needs a configured model, e.g. OPENROUTER_API_KEY).
  --verify-cmd makes the run end only when the command exits 0 (quality gate).
  Persists a run+transcript; inspect it with: aitl run-show <runId>.`,

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

Notes:
  Runs the task OVER an external agent host, wrapped with durable context + telemetry.
  Claude Code reports measured tokens/cost/turns (via --output-format json). Spec-shaped
  prompts are auto-classified, persisted, and synthesized with the outcome. No model key needed.`,

  "orchestrate": `
Examples:
  aitl orchestrate "migrate the API to v2" --project demo --max 4

Notes:
  Decomposes the task, runs sub-agents in parallel (fresh context each), and synthesizes.`,

  "synthesize": `
Examples:
  aitl synthesize --project demo
  aitl synthesize --project demo --force

Notes:
  Compacts the memory bank by category when it exceeds the configured limit (--force
  ignores the limit). Never touches ADRs.`,

  "repomap": `
Examples:
  aitl repomap --root . --project demo
  aitl repomap --root . --project demo --repo backend

Notes:
  Builds the symbol map (tree-sitter heuristic) + PageRank and prints the top symbols.
  Tip: point --root at src to avoid indexing dist/ noise.`,

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
  Mirrors Nygard-format ADR markdown into the decisions collection (file → ledger only).`,

  "export": `
Examples:
  aitl export --adapter cursor --project demo
  aitl export --adapter agents_md --project demo --root .

Notes:
  Adapters: agents_md | cursor | copilot | antigravity | kiro | trae. Incremental write.`,

  "eval": `
Examples:
  aitl eval --models openrouter,primary --project eval

Notes:
  Runs the harness-vs-bare delta across ≥2 models. Concrete benchmarks are stubs (TODO).`,

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
Subcommands: bootstrap | verify | list | create | set-role | disable
Example:  aitl user list`,
  "config": `
Subcommands: path | show | export | import | set | unset
Example:  aitl config show`,
  "prompt": `
Subcommands: add | list | search
Example:  aitl prompt list --project demo`,
  "adr": `
Subcommands: history
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
Subcommands: agent | claude
Example:  aitl init claude --project demo`,

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

Notes:
  URL-encode special chars in passwords (e.g. * → %2A). Stored in plain text locally; never commit it.`,
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

Notes:
  Reads local git branches, classifies them (main/develop/release/feature/…) and detects
  the real base by fork-point. Falls back to gitflow conventions without git.`,
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
