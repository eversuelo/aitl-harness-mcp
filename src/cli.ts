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
 */

import { Command } from "commander";
import { closeClient } from "./db/client.js";

const program = new Command();
program
  .name("aitl")
  .description("AITL-Harness — Agent In The Loop.")
  .version("0.1.0")
  .option("-i, --interactive", "Launch the interactive control panel (supervise MCP/UI, run commands).");

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
  .description("Validate MongoDB connectivity/auth without creating collections or indexes.")
  .action(async () => {
    const { checkMongoConnection } = await import("./db/client.js");
    const report = await checkMongoConnection();
    console.log(`MongoDB ping OK: ${report.uri} (db=${report.dbName})`);
    if (report.serverVersion !== undefined) {
      console.log(`Server version: ${report.serverVersion}`);
    }
    await closeClient();
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
  .description("Parse -> classify -> embed -> upsert markdown memory.")
  .action(async (opts) => {
    const { embedOne } = await import("./ingest/embedder.js");
    const { parseMarkdownDir } = await import("./ingest/markdown.js");
    const { Classifier } = await import("./memory/classifier.js");
    const { MemoryStore } = await import("./memory/store.js");
    const store = new MemoryStore();
    const clf = new Classifier();
    const docs = await parseMarkdownDir(opts.path, opts.project);
    for (const doc of docs) {
      await clf.classifyMemory(doc);
      doc.embedding = await embedOne(`${doc.description}\n${doc.body}`);
      await store.upsertMemory(doc);
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
  .option("--model <m>", "primary | secondary | gemini | google-free | gemini-free | openai | anthropic", "primary")
  .description("Run the model-agnostic agent loop, persisting the run/transcript to Mongo.")
  .action(async (task, opts) => {
    const { runAgent } = await import("./orchestration/graph.js");
    const { getProvider } = await import("./providers/base.js");
    const { defaultRegistry } = await import("./tools/base.js");
    const { ReadFileTool, WriteFileTool } = await import("./tools/filesystem.js");
    const { ShellTool } = await import("./tools/shell.js");
    const { installDefaultGates } = await import("./hooks/gates.js");
    for (const t of [new ReadFileTool(), new WriteFileTool(), new ShellTool()]) defaultRegistry.register(t);
    installDefaultGates(defaultRegistry);

    const result = await runAgent(task, opts.project, { provider: await getProvider(opts.model) });
    console.log(`run_id=${result.run_id} iters=${result.iters}`);
    console.log(result.final_text);
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
  .description("Build the tree-sitter + PageRank repo map and print the top symbols.")
  .action(async (opts) => {
    const { RepoMap } = await import("./repomap/store.js");
    const rm = new RepoMap();
    const n = await rm.build(opts.root, opts.project);
    console.log(`Indexed ${n} symbols.\n`);
    console.log(await rm.render(opts.project));
    await closeClient();
  });

program
  .command("adr-sync")
  .option("--dir <dir>", "ADR directory.", "docs/adr")
  .requiredOption("--project <project>", "Project scope.")
  .description("Mirror Nygard-format ADRs from a directory into the `decisions` collection.")
  .action(async (opts) => {
    const { ADRStore } = await import("./decisions/adr.js");
    const ids = await new ADRStore().syncDir(opts.dir, opts.project);
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
  .description("Run the MCP server (stdio) so Claude Code can use AITL's durable memory.")
  .action(async () => {
    const { main } = await import("./mcpserver/server.js");
    await main();
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

// ── init agent (write an AGENTS.md that enforces consulting the AITL MCP) ─────────
const init = program.command("init").description("Scaffold agent/project artifacts.");

init
  .command("agent")
  .option("-i, --interactive", "Prompt for the values instead of using defaults.", false)
  .option("--out <file>", "Output markdown file.", "AGENTS.md")
  .option("--project <project>", "Project scope the agent should use.", "aitl-js")
  .option("--mcp <name>", "MCP server name to consult.", "aitl-js")
  .description("Create an agent guide (AGENTS.md) that reminds the agent to consult the MCP on every decision.")
  .action(async (opts) => {
    const { writeAgentGuide } = await import("./init/agent.js");
    const path = await writeAgentGuide({
      out: opts.out,
      project: opts.project,
      mcp: opts.mcp,
      interactive: opts.interactive,
    });
    console.log(`Wrote agent guide to ${path}.`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
