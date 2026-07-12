/**
 * CLI over the `mcp_tool_calls` aggregation (`src/toolcalls/report.ts`): which MCP
 * tools were called, on which project, how often, and what they actually hydrated
 * (read) or created/mutated (write) — identified from `args` via the first
 * identifying field present (slug, name, path, dir, id, query). Same aggregation
 * backs the web UI's "ToolCalls" tab (`GET /api/tool-calls`).
 *
 * Usage:
 *   npm run tool-calls-report -- [--project ray-tracer-learning] [--since 7d] [--json]
 *
 * `--since` accepts an ISO date or a relative window like `24h` / `7d`.
 */

import { ensureMongoose } from "../src/db/mongoose.js";
import { closeClient } from "../src/db/client.js";
import { kind, toolCallsReport, type TargetRow } from "../src/toolcalls/report.js";

interface Args {
  project?: string;
  since?: Date;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") out.project = argv[++i];
    else if (a === "--since") out.since = parseSince(argv[++i]);
    else if (a === "--json") out.json = true;
  }
  return out;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function parseSince(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const rel = /^(\d+)([hd])$/.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`--since inválido: ${raw}`);
  return d;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const match: Record<string, unknown> = {};
  if (args.project) match.project = args.project;
  if (args.since) match.ts = { $gte: args.since };

  await ensureMongoose();
  const { summary, targets } = await toolCallsReport(match);

  if (args.json) {
    console.log(JSON.stringify({ summary, targets }, null, 2));
    await closeClient();
    return;
  }

  const targetsByGroup = new Map<string, TargetRow[]>();
  for (const row of targets) {
    const key = `${row._id.project ?? "(sin proyecto)"}::${row._id.tool}`;
    const list = targetsByGroup.get(key) ?? [];
    list.push(row);
    targetsByGroup.set(key, list);
  }

  let currentProject: string | null | undefined;
  for (const row of summary) {
    const project = row._id.project ?? "(sin proyecto)";
    if (project !== currentProject) {
      console.log(`\n=== ${project} ===`);
      currentProject = project;
    }
    const rate = row.calls ? Math.round((row.ok / row.calls) * 100) : 0;
    const avg = row.avgMs != null ? `${Math.round(row.avgMs)}ms` : "n/a";
    console.log(
      `  [${kind(row._id.tool)}] ${row._id.tool.padEnd(22)} calls=${row.calls} ok=${row.ok} failed=${row.failed} ` +
        `(${rate}%) avgMs=${avg} last=${row.lastTs.toISOString()}`,
    );
    const key = `${project}::${row._id.tool}`;
    const top = (targetsByGroup.get(key) ?? []).slice(0, 5);
    for (const t of top) {
      console.log(`      -> ${t._id.target} (x${t.calls}, ok=${t.ok}, failed=${t.failed})`);
      if (t.lastResultPreview) console.log(`         evidencia: ${oneLine(t.lastResultPreview)}`);
    }
    if (row.lastErrorMessage) console.log(`      último error: ${oneLine(row.lastErrorMessage)}`);
  }

  if (summary.length === 0) console.log("Sin llamadas registradas para ese filtro.");

  await closeClient();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
