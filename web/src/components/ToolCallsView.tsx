/**
 * ToolCalls tab — projection of the `mcp_tool_calls` aggregation
 * (`GET /api/tool-calls`, `src/toolcalls/report.ts`): which MCP tools ran for this
 * project, how often, their success rate/latency, and — per tool — what they
 * actually hydrated (read) or created/mutated (write), identified from `args`
 * (slug/name/path/dir/id/query/root).
 *
 * Read-only. Refreshes on project change, on the `since` window change, and on
 * manual refresh — there is no live/streaming feed; `mcp_tool_calls` rows land only
 * after a tool call already completed, so polling wouldn't show anything "live".
 */
import { Database, Loader2, PenLine, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api, type ToolCallsReport, type ToolSummaryRow, type ToolTargetRow } from "../api.js";

const SINCE_OPTIONS = [
  { value: "", label: "todo el historial" },
  { value: "24h", label: "últimas 24h" },
  { value: "7d", label: "últimos 7 días" },
  { value: "30d", label: "últimos 30 días" },
] as const;

function sinceToDateParam(since: string): string | undefined {
  if (!since) return undefined;
  const m = /^(\d+)([hd])$/.exec(since);
  if (!m) return undefined;
  const n = Number(m[1]);
  const ms = m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "recién";
  if (ms < 3_600_000) return `hace ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `hace ${Math.round(ms / 3_600_000)}h`;
  return `hace ${Math.round(ms / 86_400_000)}d`;
}

/** Any tool listed in TOOL_RBAC (src/mcpserver/server.ts) mutates durable state —
 *  the API already resolves this server-side; this list mirrors it 1:1 for display
 *  so the frontend doesn't need to import server code. Keep in sync with TOOL_RBAC. */
const WRITE_TOOLS = new Set([
  "write_memory",
  "update_memory",
  "delete_memory",
  "ingest_path",
  "graphify",
  "record_decision",
  "deprecate_decision",
  "record_prompt",
  "save_mcp_context",
  "record_human_intervention",
  "synthesize",
  "write_software",
  "delete_software",
  "write_repo",
  "delete_repo",
  "index_repo",
  "build_definition",
  "write_agent",
  "write_skill",
  "delete_agent",
  "delete_skill",
  "sync_branches",
  "delete_branch",
  "write_role",
  "seed_roles",
  "claim_task",
  "release_task",
  "publish_event",
  "run_agent",
]);

function kindOf(tool: string): "read" | "write" {
  return WRITE_TOOLS.has(tool) ? "write" : "read";
}

function rowKey(row: ToolSummaryRow): string {
  return `${row._id.project ?? ""}::${row._id.tool}`;
}

export function ToolCallsView({ project, onError }: { project: string; onError: (e: unknown) => void }) {
  const [report, setReport] = useState<ToolCallsReport | null>(null);
  const [since, setSince] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!project) return;
    onError(null);
    setLoading(true);
    try {
      setReport(await api.toolCalls(project, sinceToDateParam(since)));
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [project, since, onError]);

  useEffect(() => {
    setSelected(null);
    void refresh();
    // refresh runs again automatically whenever `project` or `since` change (see deps of refresh)
  }, [refresh]);

  const summary = report?.summary ?? [];
  const targets = report?.targets ?? [];
  const selectedRow = summary.find((r) => rowKey(r) === selected) ?? null;
  const selectedTargets: ToolTargetRow[] = selectedRow
    ? targets.filter((t) => t._id.project === selectedRow._id.project && t._id.tool === selectedRow._id.tool)
    : [];

  const totals = summary.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.ok += r.ok;
      acc.failed += r.failed;
      return acc;
    },
    { calls: 0, ok: 0, failed: 0 },
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(340px,42%)_1fr]">
      <section className="flex max-h-[45vh] min-h-0 flex-col border-b md:max-h-none md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b p-3">
          <div className="flex flex-1 flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>{summary.length} tools</span>
            <span>· Σ llamadas {totals.calls}</span>
            {totals.failed > 0 && <span className="text-destructive">· {totals.failed} fallidas</span>}
          </div>
          <Select value={since} onValueChange={setSince}>
            <SelectTrigger className="h-8 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SINCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={refresh} disabled={!project || loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="flex flex-col gap-2">
            {summary.map((r) => {
              const key = rowKey(r);
              const rate = r.calls ? Math.round((r.ok / r.calls) * 100) : 0;
              return (
                <Card
                  key={key}
                  onClick={() => setSelected(key)}
                  className={`cursor-pointer p-3 transition-colors hover:bg-accent ${
                    selected === key ? "border-primary ring-1 ring-primary" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{r._id.tool}</span>
                    <Badge variant={kindOf(r._id.tool) === "write" ? "default" : "secondary"}>
                      {kindOf(r._id.tool) === "write" ? (
                        <>
                          <PenLine className="h-3 w-3" /> crea/muta
                        </>
                      ) : (
                        <>
                          <Database className="h-3 w-3" /> hidrata
                        </>
                      )}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{r.calls} llamadas</span>
                    <span className={r.failed ? "text-destructive" : ""}>
                      {r.ok} ok / {r.failed} fail ({rate}%)
                    </span>
                    {r.avgMs != null && <span>{Math.round(r.avgMs)}ms avg</span>}
                    <span>{timeAgo(typeof r.lastTs === "string" ? r.lastTs : String(r.lastTs))}</span>
                  </div>
                </Card>
              );
            })}
            {!summary.length && !loading && (
              <div className="px-2 py-10 text-center text-sm text-muted-foreground">
                Sin llamadas MCP registradas para este proyecto en esa ventana.
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="min-h-0 overflow-y-auto">
        {selectedRow ? (
          <article className="mx-auto max-w-2xl p-6">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-lg font-semibold">{selectedRow._id.tool}</span>
              <Badge variant={kindOf(selectedRow._id.tool) === "write" ? "default" : "secondary"}>
                {kindOf(selectedRow._id.tool)}
              </Badge>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              proyecto: <span className="font-mono">{selectedRow._id.project ?? "(sin proyecto)"}</span>
            </p>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="llamadas" value={selectedRow.calls} />
              <Stat label="ok" value={selectedRow.ok} />
              <Stat label="fallidas" value={selectedRow.failed} />
              <Stat label="avg ms" value={selectedRow.avgMs != null ? Math.round(selectedRow.avgMs) : "—"} />
            </div>

            {selectedRow.lastArgsPreview && (
              <>
                <h3 className="mb-1 text-sm font-medium text-muted-foreground">Se pidió (args, última llamada)</h3>
                <pre className="mb-4 max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs">
                  {selectedRow.lastArgsPreview}
                </pre>
              </>
            )}

            {selectedRow.lastResultPreview ? (
              <>
                <h3 className="mb-1 text-sm font-medium text-muted-foreground">
                  Evidencia de hidratación — lo que realmente volvió (última llamada ok)
                </h3>
                <pre className="mb-4 max-h-64 overflow-auto rounded border bg-muted/40 p-2 text-xs">
                  {selectedRow.lastResultPreview}
                </pre>
              </>
            ) : (
              <p className="mb-4 text-sm text-muted-foreground">
                Sin `result_preview` capturado (la última corrida ok no dejó muestra, o todas las llamadas fallaron).
              </p>
            )}

            {selectedRow.lastErrorMessage && (
              <>
                <h3 className="mb-1 text-sm font-medium text-destructive">Último error</h3>
                <pre className="mb-4 max-h-32 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  {selectedRow.lastErrorMessage}
                </pre>
              </>
            )}

            <Separator className="my-4" />
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">
              Qué {kindOf(selectedRow._id.tool) === "write" ? "creó/mutó" : "hidrató"}, por identificador (args)
            </h3>
            <div className="flex flex-col gap-2">
              {selectedTargets.map((t) => (
                <div key={t._id.target} className="rounded border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono">{t._id.target}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      x{t.calls} {t.failed ? `(${t.failed} fail)` : ""} · {timeAgo(t.lastTs)}
                    </span>
                  </div>
                  {t.lastResultPreview && (
                    <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-muted/40 p-1.5 text-[11px]">
                      {t.lastResultPreview}
                    </pre>
                  )}
                </div>
              ))}
              {!selectedTargets.length && (
                <p className="text-sm text-muted-foreground">Sin identificadores capturados para este tool.</p>
              )}
            </div>
          </article>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Database className="h-10 w-10 opacity-30" />
            <p className="text-sm">Selecciona un tool para ver qué hidrató o creó.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded border p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}
