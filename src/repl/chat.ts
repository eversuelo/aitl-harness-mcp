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

import { createInterface } from "node:readline/promises";
import type { Provider } from "../providers/base.js";
import { getProvider, getProviderWithFallback, providerStatus } from "../providers/base.js";

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

/** Braille spinner on stderr; stopped (and its line cleared) on first output. */
function spinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stderr.write(`\r${CYAN}${frames[i++ % frames.length]}${RESET} ${DIM}${label}${RESET}  `);
  }, 80);
  return () => {
    clearInterval(iv);
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
}

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
      `  ${cyan("/tokens")}          tokens acumulados de la sesión`,
      `  ${cyan("/new")}             empezar un run nuevo (contexto fresco)`,
      `  ${cyan("/id")}              id del run durable actual`,
      `  ${cyan("/ask")}             alternar aprobación humana de tools con efectos`,
      `  ${cyan("/exit")}            salir (Ctrl+C también)`,
    ].join("\n"),
  );
}

export async function chatRepl(opts: ChatReplOpts): Promise<void> {
  const { runAgent } = await import("../orchestration/graph.js");

  const onFallback = (from: string, to: string, error: string) =>
    console.error(`\n${YELLOW}⚠ ${from} falló (${error}) — probando ${to}${RESET}`);

  let provider: Provider =
    !opts.model || opts.model === "auto" ? await getProviderWithFallback(onFallback) : await getProvider(opts.model);

  let mcpMount: import("../mcpclient/client.js").McpMount | null = null;
  if (opts.mcp) {
    const { mountMcpTools } = await import("../mcpclient/client.js");
    const { defaultRegistry } = await import("../tools/base.js");
    mcpMount = await mountMcpTools({
      registry: defaultRegistry,
      configPath: typeof opts.mcp === "string" ? opts.mcp : undefined,
      onEvent: (ev) =>
        console.error(dim(`[mcp] ${ev.server}: ${ev.ok ? `${ev.tools} tools` : `FALLÓ — ${ev.error}`}`)),
    });
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
  console.log(dim("  /help para comandos\n"));

  let runId: string | null = null;
  let ask = Boolean(opts.ask);
  let sessionIn = 0;
  let sessionOut = 0;
  const history: string[] = [];

  // Ctrl+C must ALWAYS kill the REPL. Two traps otherwise: (1) readline swallows
  // SIGINT while a question is pending (emits 'SIGINT' on the rl instead of the
  // process), (2) raw mode left on after a question means ^C echoes literally and
  // never reaches the process. Handle both + force cooked mode during runs.
  const onSigint = () => {
    process.stdout.write(`\n${DIM}(interrumpido)${RESET}\n`);
    process.exit(130);
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
          const { defaultRegistry } = await import("../tools/base.js");
          const names = defaultRegistry.schemas().map((s) => String(s.name));
          console.log(names.length ? names.map((n) => `  ${dim("·")} ${n}`).join("\n") : dim("(aún sin tools — se instalan al primer turno)"));
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
        console.log(dim(`comando desconocido: ${cmd} — /help`));
        continue;
      }

      // ── one agent turn ────────────────────────────────────────────────────
      let stopSpin = spinner("pensando…");
      let streamed = false;
      const t0 = Date.now();
      try {
        const result = await runAgent(line, opts.project, {
          provider,
          installDefaultTools: true,
          summarize: false, // a summary per REPL turn is noise; run-show has the transcript
          onDelta: (d) => {
            if (!streamed) {
              stopSpin();
              streamed = true;
            }
            process.stdout.write(d.text);
          },
          onTool: (ev) => {
            stopSpin();
            if (ev.phase === "start") {
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
        // Non-streaming providers resolve silently — print the final text once.
        if (!streamed && result.final_text) process.stdout.write(result.final_text);
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
      } catch (err) {
        stopSpin();
        console.error(`\n${RED}error:${RESET} ${String(err instanceof Error ? err.message : err)}\n`);
      }
    }
  } finally {
    await mcpMount?.close();
  }
}
