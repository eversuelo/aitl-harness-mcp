/**
 * Host adapters — the harness running OVER an existing agent host.
 *
 * Unlike a raw-model `Provider` (which the harness drives with its own loop), a HOST is a
 * full agent CLI that runs its own loop (Codex, Claude Code, Antigravity). The harness
 * "runs over" it: it wraps the host with durable context (hydration), persistence and
 * telemetry — the cognitive layer around someone else's agent. See `runOnHost`.
 *
 * Each known host is invoked headlessly via its CLI; the prompt is fed on stdin so it
 * never has to be shell-escaped. Commands are overridable via
 * `AITL_HOST_CMD_<NAME>` (e.g. AITL_HOST_CMD_CLAUDE_CODE=/usr/local/bin/claude).
 */

import { spawn } from "node:child_process";

export interface HostResult {
  text: string;
  raw: string; // stdout+stderr, for the durable transcript
  exitCode: number;
  /** Token usage parsed from the host's structured output, when available. */
  usage?: { input: number; output: number };
  /** Extra host telemetry (cost, turns, duration, session id…), when available. */
  meta?: Record<string, unknown>;
}

export interface HostRunOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface HostAdapter {
  readonly name: string;
  runTask(prompt: string, opts?: HostRunOpts): Promise<HostResult>;
}

export interface CliHostSpec {
  command: string;
  args: string[];
  /** How the prompt reaches the host: piped on stdin (default) or appended as an argv. */
  promptVia?: "stdin" | "arg";
  /** Run through a shell (needed on Windows to resolve `.cmd` shims). */
  shell?: boolean;
  /**
   * Parse the host's stdout into final text + measured token usage + meta. Hosts emit
   * different structured formats (e.g. Claude Code `--output-format json`); when omitted
   * the raw stdout is the final text and no metrics are captured. Best-effort: a throw or
   * null falls back to the trimmed raw text.
   */
  parse?: (stdout: string) => {
    text?: string;
    usage?: { input: number; output: number };
    meta?: Record<string, unknown>;
  } | null;
}

/**
 * Parse the JSON envelope emitted by `claude -p --output-format json`. It is a single
 * object with `result` (final text), `usage` (input/output/cache tokens), `total_cost_usd`,
 * `num_turns` and `duration_ms`. Input is the sum of fresh + cache tokens (the billed
 * input side); the breakdown is preserved in `meta`.
 */
export function parseClaudeJson(stdout: string): ReturnType<NonNullable<CliHostSpec["parse"]>> {
  const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const u = (obj.usage ?? {}) as Record<string, number>;
  const input =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  return {
    text: typeof obj.result === "string" ? obj.result : stdout.trim(),
    usage: { input, output },
    meta: {
      cost_usd: obj.total_cost_usd ?? null,
      num_turns: obj.num_turns ?? null,
      duration_ms: obj.duration_ms ?? null,
      duration_api_ms: obj.duration_api_ms ?? null,
      session_id: obj.session_id ?? null,
      model: obj.model ?? null,
      is_error: obj.is_error ?? null,
      raw_input_tokens: u.input_tokens ?? 0,
      cache: { creation: u.cache_creation_input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0 },
    },
  };
}

/** Default headless invocations for known agent hosts (override via AITL_HOST_CMD_<NAME>). */
export const HOST_SPECS: Record<string, CliHostSpec> = {
  // JSON output lets the harness measure tokens/cost/turns (thesis metric #7) for Cara B.
  "claude-code": {
    command: "claude",
    args: ["-p", "--output-format", "json"],
    promptVia: "stdin",
    parse: parseClaudeJson,
  },
  codex: { command: "codex", args: ["exec", "-"], promptVia: "stdin" },
  antigravity: { command: "agy", args: ["run"], promptVia: "stdin" },
};

/** A host backed by a headless CLI invocation. */
export class CliHostAdapter implements HostAdapter {
  constructor(
    readonly name: string,
    private spec: CliHostSpec,
  ) {}

  runTask(prompt: string, opts: HostRunOpts = {}): Promise<HostResult> {
    const via = this.spec.promptVia ?? "stdin";
    const shell = this.spec.shell ?? process.platform === "win32";
    const args = via === "arg" ? [...this.spec.args, prompt] : this.spec.args;

    return new Promise<HostResult>((resolve, reject) => {
      const child = spawn(this.spec.command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        shell,
      });
      let out = "";
      let err = "";
      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
          : null;
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        let text = out.trim();
        let usage: HostResult["usage"];
        let meta: HostResult["meta"];
        // Parse structured output (tokens/cost/turns) only on a clean exit; the parser is
        // best-effort, so a malformed/partial payload falls back to the raw text.
        if (code === 0 && this.spec.parse) {
          try {
            const parsed = this.spec.parse(out);
            if (parsed) {
              if (typeof parsed.text === "string") text = parsed.text;
              usage = parsed.usage;
              meta = parsed.meta;
            }
          } catch {
            // keep the raw text; no metrics captured for this run
          }
        }
        resolve({ text, raw: `${out}${err}`, exitCode: code ?? -1, usage, meta });
      });
      if (via === "stdin") {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
  }
}

/** Resolve a known host by name, honoring an `AITL_HOST_CMD_<NAME>` command override. */
export function getHost(name: string): HostAdapter {
  const spec = HOST_SPECS[name];
  if (!spec) {
    throw new Error(`Unknown host '${name}'. Known hosts: ${Object.keys(HOST_SPECS).join(", ")}.`);
  }
  const override = process.env[`AITL_HOST_CMD_${name.toUpperCase().replace(/-/g, "_")}`];
  return new CliHostAdapter(name, override ? { ...spec, command: override } : spec);
}
