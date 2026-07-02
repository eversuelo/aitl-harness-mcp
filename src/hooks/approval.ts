/**
 * Human-in-the-loop approval gate (ADR-0040).
 *
 * An async PermissionGate that pauses the loop before a side-effect tool
 * (`Tool.requiresApproval`) runs and asks the human on the terminal:
 * yes / no / always-allow-this-tool. Prompts go to STDERR so stdout stays clean
 * for `--stream`; the wait time feeds the human-supervision metric (H11).
 *
 * Non-interactive callers (no TTY) never hang: the configured `policy` decides
 * ("deny" by default — the safe fallback), and the decision is still audited.
 */

import { createInterface } from "node:readline/promises";
import type { PermissionGate, ToolRegistry } from "../tools/base.js";

export type ApprovalDecision = "allow" | "deny" | "always";

export interface ApprovalEvent {
  tool: string;
  decision: ApprovalDecision;
  /** Milliseconds the human took to answer (0 when non-interactive). */
  ms: number;
  interactive: boolean;
}

export interface ApprovalGateOpts {
  registry: ToolRegistry;
  /** Fallback when stdin is not a TTY (default "deny"). */
  policy?: "deny" | "allow";
  /** Injectable streams for tests; default process.stdin / process.stderr. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  onDecision?: (ev: ApprovalEvent) => void;
}

const MAX_ARGS_PREVIEW = 600;

function argsPreview(args: Record<string, unknown>): string {
  let json = "";
  try {
    json = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    json = String(args);
  }
  if (json.length > MAX_ARGS_PREVIEW) {
    json = `${json.slice(0, MAX_ARGS_PREVIEW)}… (+${json.length - MAX_ARGS_PREVIEW} chars)`;
  }
  return json.replace(/\n/g, "\n  ");
}

/** Build the async gate. Tools without `requiresApproval` pass through silently. */
export function approvalGate(opts: ApprovalGateOpts): PermissionGate {
  // "always allow" decisions live as long as the gate — i.e. the whole process, so a
  // multi-turn chat doesn't re-ask about a tool the human already blessed.
  const alwaysAllow = new Set<string>();

  return async (name, args) => {
    if (opts.registry.get(name)?.requiresApproval !== true) return [true, ""];
    if (alwaysAllow.has(name)) return [true, ""];

    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stderr;
    const interactive = input.isTTY === true;

    if (!interactive) {
      const allow = (opts.policy ?? "deny") === "allow";
      opts.onDecision?.({ tool: name, decision: allow ? "allow" : "deny", ms: 0, interactive: false });
      return allow
        ? [true, ""]
        : [false, `approval denied for '${name}' (non-interactive; use --ask-fallback allow to auto-approve)`];
    }

    output.write(
      `\n── approval required ─────────────────────────────\n` +
        `  tool: ${name}\n` +
        `  args: ${argsPreview(args)}\n`,
    );
    const rl = createInterface({ input, output });
    const t0 = Date.now();
    let answer = "";
    try {
      answer = (await rl.question(`  Allow? [y]es / [n]o / [a]lways allow '${name}' > `))
        .trim()
        .toLowerCase();
    } finally {
      rl.close();
    }
    const ms = Date.now() - t0;

    if (answer === "a" || answer === "always") {
      alwaysAllow.add(name);
      opts.onDecision?.({ tool: name, decision: "always", ms, interactive: true });
      return [true, ""];
    }
    if (["y", "yes", "s", "si", "sí"].includes(answer)) {
      opts.onDecision?.({ tool: name, decision: "allow", ms, interactive: true });
      return [true, ""];
    }
    // Anything else — including an empty answer — denies: the safe default.
    opts.onDecision?.({ tool: name, decision: "deny", ms, interactive: true });
    return [false, `approval denied for '${name}'`];
  };
}

// One approval gate per registry: re-installing only re-points the runtime opts, so
// multi-turn callers (aitl chat resumes the same registry) never stack duplicate prompts.
const _installed = new WeakMap<ToolRegistry, ApprovalGateOpts>();

/** Install the approval gate once per registry (idempotent); later calls update opts. */
export function installApprovalGate(
  registry: ToolRegistry,
  opts: Omit<ApprovalGateOpts, "registry"> = {},
): void {
  const existing = _installed.get(registry);
  if (existing) {
    existing.policy = opts.policy;
    existing.input = opts.input;
    existing.output = opts.output;
    existing.onDecision = opts.onDecision;
    return;
  }
  const box: ApprovalGateOpts = { registry, ...opts };
  _installed.set(registry, box);
  registry.addGate(approvalGate(box));
}
