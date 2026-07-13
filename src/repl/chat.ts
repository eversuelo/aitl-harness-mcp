/**
 * `aitl chat` — Claude Code–style REPL over the agent loop (evolves ADR-0003).
 *
 * Dependency-free TUI niceties: ANSI colors, an input history shared across turns,
 * a spinner while the model thinks, live tool-call lines (via `RunAgentOpts.onTool`),
 * a per-turn token/latency status line, and slash commands (/help /model /tokens …).
 *
 * Provider selection defaults to `auto`: whatever LLM is configured wins, with the
 * remaining configured backends as a fallback chain (see `getProviderWithFallback`).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Provider } from "../providers/base.js";
import { getProvider, getProviderWithFallback, providerStatus } from "../providers/base.js";
import { listenForEscape } from "./escape.js";
import { appendHistory, expandFileMentions, historyFile, loadHistory } from "./history.js";
import { AnsiMarkdownStream, markdownEnabledByDefault, renderMarkdownAnsi } from "./markdown.js";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const GRAY = `${ESC}[90m`;

const dim = (s: string) => `${DIM}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;

/** Braille spinner on stderr; stopped (and its line cleared) on first output.
 *  The stop closure is idempotent: it clears the line only ONCE. It gets called
 *  again after the run resolves, and by then the line holds streamed model text —
 *  a second `\r`+spaces would overwrite the first ~15 chars of the response. */
function spinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stderr.write(`\r${CYAN}${frames[i++ % frames.length]}${RESET} ${DIM}${label}${RESET}  `);
  }, 80);
  let cleared = false;
  return () => {
    clearInterval(iv);
    if (cleared) return;
    cleared = true;
    process.stderr.write(`\r${" ".repeat(label.length + 6)}\r`);
  };
}

/** One-line preview of tool args, truncated ("path/to/file", {cmd:…}). */
function argPreview(args: Record<string, unknown> | undefined): string {
  if (!args || !Object.keys(args).length) return "";
  const s = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export interface ChatReplOpts {
  project: string;
  /** Provider name, or "auto" (default) to detect + chain fallbacks. */
  model?: string;
  ask?: boolean;
  askPolicy?: "deny" | "allow";
  /** Mount MCP tools from .mcp.json (or an explicit path). */
  mcp?: string | boolean;
  /** Render model output as ANSI markdown (default: TTY && !NO_COLOR). */
  markdown?: boolean;
}

const expandTilde = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

function printStatusObject(): void {
  const st = providerStatus();
  console.log(bold("LLMs configurados:"));
  for (const p of st.providers) {
    const mark = p.configured ? `${GREEN}●${RESET}` : `${GRAY}○${RESET}`;
    const tag = p.name === st.active ? cyan(" ← activo") : "";
    console.log(`  ${mark} ${p.name.padEnd(14)} ${dim(p.configured ? p.model : `no configurado (${p.via})`)}${tag}`);
  }
  if (st.fallbacks.length) console.log(`  ${dim(`fallback: ${st.fallbacks.join(" → ")}`)}`);
  if (st.aitl_api_key) console.log(`  ${dim(`AITL_API_KEY → ${st.aitl_api_key}`)}`);
}

function printHelp(): void {
  console.log(
    [
      `  ${cyan("/help")}            esta ayuda`,
      `  ${cyan("/models")}          objeto de LLMs configurados + fallback`,
      `  ${cyan("/model <name>")}    cambiar de provider (anthropic|openrouter|lmstudio|openai-compat|auto)`,
      `  ${cyan("/tools")}           tools registradas en esta sesión`,
      `  ${cyan("/call <tool>")}     invocar una tool directamente: /call read_file {"path":"src/app.ts"}`,
      `  ${cyan("/tokens")}          tokens acumulados de la sesión`,
      `  ${cyan("/new")}             empezar un run nuevo (contexto fresco)`,
      `  ${cyan("/id")}              id del run durable actual`,
      `  ${cyan("/ask")}             alternar aprobación humana de tools con efectos`,
      `  ${cyan("/mcp")}             gestionar servidores MCP: list · add <name> <cmd> [args…] · rm <name> · reload · self`,
      `  ${cyan("/md")}              alternar el render markdown de las respuestas`,
      `  ${cyan("/read <file>")}     mostrar un archivo (los .md se renderizan)`,
      `  ${cyan("/export <dir>")}    exportar las tareas como markdown a <dir>/tasks ('all' añade memoria/skills/agents)`,
      `  ${cyan("/exit")}            salir (Ctrl+C también)`,
      dim("  @ruta/archivo en el prompt adjunta el contenido del archivo al turno"),
    ].join("\n"),
  );
}

export async function chatRepl(opts: ChatReplOpts): Promise<void> {
  const { runAgent } = await import("../orchestration/graph.js");

  const onFallback = (from: string, to: string, error: string) =>
    console.error(`\n${YELLOW}⚠ ${from} falló (${error}) — probando ${to}${RESET}`);

  let provider: Provider =
    !opts.model || opts.model === "auto" ? await getProviderWithFallback(onFallback) : await getProvider(opts.model);

  // MCP mounts are a LIVE set here (McpManager): /mcp add|rm|reload|self edit them
  // mid-session; --mcp only decides what gets mounted at boot.
  const { McpManager, selfServerSpec } = await import("../mcpclient/manager.js");
  const { removeMcpServer, upsertMcpServer } = await import("../mcpclient/config.js");
  const { defaultRegistry } = await import("../tools/base.js");
  const mcpConfigPath = typeof opts.mcp === "string" ? opts.mcp : undefined;
  const manifestPath = mcpConfigPath
    ? mcpConfigPath.endsWith(".json")
      ? mcpConfigPath
      : join(mcpConfigPath, ".mcp.json")
    : join(process.cwd(), ".mcp.json");
  const onMcpEvent = (ev: { server: string; ok: boolean; tools?: number; error?: string }) =>
    console.error(dim(`[mcp] ${ev.server}: ${ev.ok ? `${ev.tools} tools` : `FALLÓ — ${ev.error}`}`));
  const mcp = new McpManager(defaultRegistry);
  // Like Claude Code, a `.mcp.json` in the cwd mounts BY DEFAULT (--no-mcp opts out).
  if (opts.mcp !== false) {
    try {
      const mounted = await mcp.mountFromConfig(mcpConfigPath, onMcpEvent);
      if (!mounted.length) {
        console.error(
          dim(`[mcp] sin servidores montados (¿existe ${manifestPath}?) — /mcp add <name> <cmd> · /mcp self`),
        );
      }
    } catch (err) {
      console.error(`${YELLOW}⚠ .mcp.json:${RESET} ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  // Install the default tools + gates NOW (not at the first turn) so /tools shows
  // the real registry and /call works — always through the gates, never around them.
  {
    const { EditFileTool, ReadFileTool, WriteFileTool } = await import("../tools/filesystem.js");
    const { ShellTool } = await import("../tools/shell.js");
    for (const t of [new ReadFileTool(), new EditFileTool(), new WriteFileTool(), new ShellTool()])
      defaultRegistry.register(t);
    // The LLM can mount MCP servers itself, LIVE: mounted tools land in this same
    // registry and the loop re-reads `registry.schemas()` every iteration, so they
    // are callable from the next turn on — no chat restart (mirrors `/mcp add`).
    defaultRegistry.register({
      name: "mcp_add",
      description:
        "Mount an MCP server into this chat session (live, no restart): its tools become available " +
        "as mcp__<name>__<tool> on your NEXT turn. The server is persisted to .mcp.json.",
      requiresApproval: true, // spawns a child process — subject to --ask (ADR-0040)
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["name", "command"],
      },
      run: async (args: Record<string, unknown>) => {
        const name = String(args.name);
        const spec = {
          command: String(args.command),
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          env: {},
        };
        const st = await mcp.mount(name, spec); // si no arranca, no se persiste
        upsertMcpServer(manifestPath, name, spec);
        return `mounted '${st.name}' (${st.tools} tools) — call them as mcp__${st.name}__<tool> from your next turn`;
      },
    });
    const { installDefaultGates } = await import("../hooks/gates.js");
    installDefaultGates(defaultRegistry); // idempotent per registry
    // ADR regression guard (Layer 3): annotate write/edit results with ADR reminders.
    try {
      const { installAdrGuard } = await import("../hooks/adrGuard.js");
      installAdrGuard(defaultRegistry, { project: opts.project });
    } catch {
      // best-effort — never break the chat session.
    }
  }

  const caps = provider.capabilities();
  console.log();
  console.log(`${bold("AITL")} ${dim("·")} ${cyan(provider.name)} ${dim(`· project ${opts.project}`)}`);
  console.log(
    dim(
      `  ctx ${Math.round(caps.maxContext / 1000)}k · tools ${caps.toolUse ? "✓" : "✗"} · stream ${
        caps.streaming ? "✓" : "✗"
      }${opts.ask ? " · ask ✓" : ""}`,
    ),
  );
  console.log(dim("  /help para comandos · esc interrumpe el turno\n"));

  let runId: string | null = null;
  let ask = Boolean(opts.ask);
  let mdOn = opts.markdown ?? markdownEnabledByDefault();
  let sessionIn = 0;
  let sessionOut = 0;
  // Input history persists across sessions (one file per project under ~/.aitl/history/).
  const histPath = historyFile(opts.project);
  const history: string[] = await loadHistory(histPath);

  // Ctrl+C must ALWAYS kill the REPL. Two traps otherwise: (1) readline swallows
  // SIGINT while a question is pending (emits 'SIGINT' on the rl instead of the
  // process), (2) raw mode left on after a question means ^C echoes literally and
  // never reaches the process. Handle both + force cooked mode during runs.
  const onSigint = () => {
    process.stdout.write(`\n${DIM}(interrumpido)${RESET}\n`);
    // Tear down before dying: a bare process.exit() orphans the MCP server child
    // processes and leaves DB connections open. The timer backstop guarantees the
    // process still exits even if a close() wedges.
    setTimeout(() => process.exit(130), 2000).unref();
    void (async () => {
      try {
        await mcp.closeAll();
      } catch {}
      try {
        const { closeClient } = await import("../db/client.js");
        await closeClient();
      } catch {}
      process.exit(130);
    })();
  };
  process.on("SIGINT", onSigint);

  try {
    for (;;) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, history, historySize: 200 });
      rl.on("SIGINT", onSigint); // ^C while typing
      let line: string;
      try {
        // `question()` never settles if stdin ends while it's pending (piped input /
        // CI) — race it against the interface's close event so EOF exits the REPL.
        const closed = new Promise<never>((_, reject) =>
          rl.once("close", () => reject(new Error("stdin closed"))),
        );
        line = (await Promise.race([rl.question(`${CYAN}❯${RESET} `), closed])).trim();
      } catch {
        break; // stdin closed / EOF
      } finally {
        rl.close(); // free stdin for --ask prompts during the run
        if (process.stdin.isTTY) process.stdin.setRawMode(false); // ensure ^C → SIGINT mid-run
      }
      if (!line) continue;
      void appendHistory(histPath, line); // best-effort, never blocks the turn

      // ── slash commands ────────────────────────────────────────────────────
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.split(/\s+/);
        if (cmd === "/exit" || cmd === "/quit") break;
        if (cmd === "/help") {
          printHelp();
          continue;
        }
        if (cmd === "/models") {
          printStatusObject();
          continue;
        }
        if (cmd === "/model") {
          const name = rest[0];
          if (!name) {
            console.log(dim(`provider actual: ${provider.name}`));
            continue;
          }
          try {
            provider = name === "auto" ? await getProviderWithFallback(onFallback) : await getProvider(name);
            console.log(dim(`provider → ${provider.name}`));
          } catch (err) {
            console.error(`${RED}${String(err instanceof Error ? err.message : err)}${RESET}`);
          }
          continue;
        }
        if (cmd === "/tools") {
          const names = defaultRegistry.schemas().map((s) => String(s.name));
          console.log(names.length ? names.map((n) => `  ${dim("·")} ${n}`).join("\n") : dim("(sin tools registradas)"));
          console.log(dim("  invoca una con /call <tool> [args JSON] · monta más con /mcp"));
          continue;
        }
        if (cmd === "/call") {
          const name = rest[0];
          if (!name) {
            console.log(dim("uso: /call <tool> [args JSON] — invoca una tool del registry (los gates aplican)"));
            continue;
          }
          let args: Record<string, unknown> = {};
          const rawArgs = rest.slice(1).join(" ").trim();
          if (rawArgs) {
            try {
              args = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch (err) {
              console.error(`${RED}args inválidos (JSON):${RESET} ${String(err instanceof Error ? err.message : err)}`);
              continue;
            }
          }
          const tCall = Date.now();
          const out = await defaultRegistry.call(name, args, (reason) =>
            console.error(`${RED}✗ denegado por gate${RESET} ${dim(reason)}`),
          );
          console.log(dim(`⏺ ${name} · ${Date.now() - tCall}ms`));
          process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
          continue;
        }
        if (cmd === "/tokens") {
          console.log(dim(`sesión: in ${sessionIn} · out ${sessionOut} · total ${sessionIn + sessionOut}`));
          continue;
        }
        if (cmd === "/new") {
          runId = null;
          console.log(dim("(run nuevo)"));
          continue;
        }
        if (cmd === "/id") {
          console.log(dim(runId ?? "(sin run todavía)"));
          continue;
        }
        if (cmd === "/ask") {
          ask = !ask;
          console.log(dim(`ask ${ask ? "activado" : "desactivado"}`));
          continue;
        }
        if (cmd === "/md") {
          mdOn = !mdOn;
          console.log(dim(`markdown ${mdOn ? "activado" : "desactivado"}`));
          continue;
        }
        if (cmd === "/mcp") {
          const sub = rest[0] ?? "list";
          try {
            if (sub === "list") {
              const st = mcp.list();
              if (!st.length) {
                console.log(dim("(sin servidores MCP montados) — /mcp add <name> <cmd> [args…] · /mcp self · /mcp reload"));
              } else {
                for (const s of st) {
                  console.log(`  ${GREEN}●${RESET} ${s.name.padEnd(14)} ${dim(`${s.tools} tools · ${s.command}`)}`);
                }
              }
            } else if (sub === "add") {
              const [, first, command, ...args] = rest;
              if (!first) {
                console.log(dim("uso: /mcp add <name> <comando> [args…]  ·  /mcp add <ruta a .mcp.json>"));
                continue;
              }
              // A path-looking single arg is a manifest: mount everything it declares.
              if (!command && (first.endsWith(".json") || first.includes("/"))) {
                const path = expandTilde(first);
                const mounted = await mcp.mountFromConfig(path, onMcpEvent);
                console.log(dim(`montados ${mounted.length} servidores desde ${path}`));
                continue;
              }
              if (!command) {
                console.log(dim("uso: /mcp add <name> <comando> [args…]  ·  /mcp add <ruta a .mcp.json>"));
                continue;
              }
              const spec = { command, args, env: {} };
              const st = await mcp.mount(first, spec); // si no arranca, no se persiste
              upsertMcpServer(manifestPath, first, spec);
              console.log(dim(`montado '${st.name}' (${st.tools} tools) · guardado en ${manifestPath}`));
            } else if (sub === "rm" || sub === "remove") {
              const name = rest[1];
              if (!name) {
                console.log(dim("uso: /mcp rm <name>"));
                continue;
              }
              const wasMounted = await mcp.unmount(name);
              const wasInFile = removeMcpServer(manifestPath, name);
              console.log(
                dim(`'${name}': ${wasMounted ? "desmontado" : "no estaba montado"}${wasInFile ? " · quitado de .mcp.json" : ""}`),
              );
            } else if (sub === "reload") {
              await mcp.closeAll();
              const mounted = await mcp.mountFromConfig(mcpConfigPath, onMcpEvent);
              console.log(dim(`remontados ${mounted.length} servidores desde ${manifestPath}`));
            } else if (sub === "self" || sub === "aitl") {
              const st = await mcp.mount("aitl", selfServerSpec());
              console.log(dim(`MCP propio del harness montado (${st.tools} tools: memoria/ADRs/skills/coordinación)`));
            } else {
              console.log(dim("subcomandos: list · add <name> <cmd> [args…] · rm <name> · reload · self"));
            }
          } catch (err) {
            console.error(`${RED}mcp:${RESET} ${String(err instanceof Error ? err.message : err)}`);
          }
          continue;
        }
        if (cmd === "/read") {
          const target = rest.join(" ").trim();
          if (!target) {
            console.log(dim("uso: /read <archivo>"));
            continue;
          }
          try {
            const raw = await fs.readFile(expandTilde(target), "utf-8");
            console.log(dim(`── ${target} (${raw.split("\n").length} líneas) ──`));
            const pretty = mdOn && /\.(md|markdown)$/i.test(target) ? renderMarkdownAnsi(raw) : raw;
            process.stdout.write(pretty.endsWith("\n") ? pretty : `${pretty}\n`);
          } catch (err) {
            console.error(`${RED}no se pudo leer:${RESET} ${String(err instanceof Error ? err.message : err)}`);
          }
          continue;
        }
        if (cmd === "/export") {
          const dir = rest[0] ? expandTilde(rest[0]) : "";
          if (!dir) {
            console.log(dim("uso: /export <dir> [all] — tareas a <dir>/tasks/*.md; con 'all' también memoria/skills/agents"));
            continue;
          }
          try {
            const { exportAgents, exportMemory, exportSkills, exportTasks } = await import("../sync/export.js");
            const results = [await exportTasks(opts.project, dir)];
            if (rest[1] === "all") {
              results.push(
                await exportMemory(opts.project, dir),
                await exportSkills(opts.project, dir),
                await exportAgents(opts.project, dir),
              );
            }
            const written = results.flatMap((r) => r.written);
            const unchanged = results.reduce((n, r) => n + r.unchanged.length, 0);
            if (written.length) console.log(written.map((p) => `  ${GREEN}+${RESET} ${p}`).join("\n"));
            console.log(dim(`  ${written.length} escritos · ${unchanged} sin cambios`));
          } catch (err) {
            console.error(`${RED}export falló:${RESET} ${String(err instanceof Error ? err.message : err)}`);
          }
          continue;
        }
        console.log(dim(`comando desconocido: ${cmd} — /help`));
        continue;
      }

      // @archivo → adjunta el contenido al turno (estilo Claude Code)
      let prompt = line;
      if (line.includes("@")) {
        const expanded = await expandFileMentions(line);
        prompt = expanded.prompt;
        for (const f of expanded.attached) console.log(dim(`  ⎘ adjunto ${f}`));
      }

      // ── one agent turn ────────────────────────────────────────────────────
      let stopSpin = spinner("pensando…");
      let streamed = false;
      // One markdown stream per turn: fence state survives tool interruptions,
      // and a fresh turn never inherits a half-open fence from the previous one.
      const md = new AnsiMarkdownStream({ enabled: mdOn });
      const t0 = Date.now();
      // ESC aborts THIS turn only (the REPL and the run survive; ^C still kills all).
      const interrupt = new AbortController();
      const stopEsc = listenForEscape(() => {
        if (interrupt.signal.aborted) return;
        stopSpin();
        process.stdout.write(`\n${DIM}(esc — interrumpiendo el turno…)${RESET}\n`);
        interrupt.abort();
      });
      try {
        const result = await runAgent(prompt, opts.project, {
          provider,
          signal: interrupt.signal,
          installDefaultTools: true,
          summarize: false, // a summary per REPL turn is noise; run-show has the transcript
          onDelta: (d) => {
            if (!streamed) {
              stopSpin();
              streamed = true;
            }
            process.stdout.write(md.push(d.text));
          },
          onTool: (ev) => {
            stopSpin();
            if (ev.phase === "start") {
              const pending = md.flush(); // held inline markers print before the tool line
              if (pending) process.stdout.write(pending);
              if (streamed) process.stdout.write("\n");
              streamed = false;
              process.stdout.write(`${GREEN}⏺${RESET} ${bold(ev.name)}${dim(`(${argPreview(ev.args)})`)}`);
            } else if (ev.phase === "done") {
              process.stdout.write(dim(` ✓ ${ev.ms}ms\n`));
              stopSpin = spinner("pensando…");
            } else {
              process.stdout.write(`\n  ${RED}✗ denegado por gate${RESET} ${dim(ev.reason ?? "")}\n`);
              stopSpin = spinner("pensando…");
            }
          },
          ...(ask ? { ask: true, askPolicy: opts.askPolicy ?? "deny" } : {}),
          ...(runId ? { resume: runId, hydrate: false, skills: false } : {}),
        });
        stopSpin();
        runId = result.run_id;
        const tail = md.flush();
        if (tail) process.stdout.write(tail);
        // Non-streaming providers resolve silently — print the final text once.
        if (!streamed && result.final_text) {
          process.stdout.write(mdOn ? renderMarkdownAnsi(result.final_text) : result.final_text);
        }
        const tu = result.token_usage ?? { input: 0, output: 0 };
        sessionIn += tu.input;
        sessionOut += tu.output;
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(
          `\n${dim(
            `  ${provider.name} · ${secs}s · ↑${tu.input} ↓${tu.output} tok · ${result.iters} iter${
              result.tool_calls ? ` · ${result.tool_calls} tools` : ""
            }${result.gate_denials ? ` · ${result.gate_denials} vetos` : ""} · run ${result.run_id.slice(0, 8)}`,
          )}\n\n`,
        );
        if (result.stop_reason === "interrupted") {
          process.stdout.write(dim("  (turno interrumpido — escribe para continuar el mismo run)\n\n"));
        }
      } catch (err) {
        stopSpin();
        console.error(`\n${RED}error:${RESET} ${String(err instanceof Error ? err.message : err)}\n`);
      } finally {
        stopEsc(); // detach the ESC listener and restore stdin for the next prompt
      }
    }
  } finally {
    await mcp.closeAll();
  }
}
