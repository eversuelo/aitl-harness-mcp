/**
 * Tool interface + registry + permission gates + pre/post tool hooks.
 *
 * A Tool exposes a name, a JSON-schema for its input, and a `run(args)`. The
 * registry renders the provider-agnostic tool schema and dispatches calls. The
 * permission gate is where deterministic policy lives (mirrors PreToolUse hooks);
 * pre/post hooks are the in-process extensibility seam around `tool.run` (ADR-0039).
 */

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Execute the tool and return a string result. */
  run(args: Record<string, unknown>): Promise<string>;
}

/** Normalized schema shared by all providers (adapted per-provider). */
export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // OpenAI's adapter reads `parameters`; keep both for convenience.
    parameters: tool.inputSchema,
  };
}

// A gate returns [allowed, reason]. Registered by src/hooks/gates.ts.
export type PermissionGate = (name: string, args: Record<string, unknown>) => [boolean, string];

/**
 * Pre-tool hook (ADR-0039): observes — and may rewrite — the args before the tool
 * runs (inject defaults, redact secrets…). A throwing pre-hook ABORTS the call
 * (the tool never runs), so hooks can also act as policy.
 */
export type PreToolHook = (
  name: string,
  args: Record<string, unknown>,
) => void | { args?: Record<string, unknown> } | Promise<void | { args?: Record<string, unknown> }>;

/**
 * Post-tool hook (ADR-0039): observes — and may transform — the result (truncate,
 * annotate…). Each post-hook runs in its own try/catch: a broken observer never
 * loses the tool's output.
 */
export type PostToolHook = (
  name: string,
  args: Record<string, unknown>,
  result: string,
) => void | { result?: string } | Promise<void | { result?: string }>;

/** Telemetry envelope — emitted ONLY when a hook acts (mutates args/result). */
export interface ToolHookEvent {
  phase: "pre" | "post";
  tool: string;
  /** Position of the acting hook in its chain. */
  index: number;
  mutated: true;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private gates: PermissionGate[] = [];
  private preHooks: PreToolHook[] = [];
  private postHooks: PostToolHook[] = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  addGate(gate: PermissionGate): void {
    this.gates.push(gate);
  }

  addPreHook(hook: PreToolHook): void {
    this.preHooks.push(hook);
  }

  addPostHook(hook: PostToolHook): void {
    this.postHooks.push(hook);
  }

  schemas(): Record<string, unknown>[] {
    return [...this.tools.values()].map(toolSchema);
  }

  /** Whether any permission gate is installed (used to avoid double-installing defaults). */
  hasGates(): boolean {
    return this.gates.length > 0;
  }

  /**
   * Run a tool through the permission gates. If a gate denies, `onDeny(reason)` is
   * invoked (for audit) and a `[denied by gate]` string is returned so the caller can
   * feed it back to the model — the tool never executes.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    onDeny?: (reason: string) => void,
    opts: { onHookEvent?: (ev: ToolHookEvent) => void } = {},
  ): Promise<string> {
    for (const gate of this.gates) {
      const [allowed, reason] = gate(name, args);
      if (!allowed) {
        onDeny?.(reason);
        return `[denied by gate] ${reason}`;
      }
    }
    const tool = this.tools.get(name);
    if (tool === undefined) return `[error] unknown tool '${name}'`;
    try {
      // Pre-hooks run AFTER gates (policy first) and may rewrite the args; a throwing
      // pre-hook falls through to the catch below — the tool never runs.
      for (const [i, hook] of this.preHooks.entries()) {
        const r = await hook(name, args);
        if (r && typeof r === "object" && r.args) {
          args = r.args;
          opts.onHookEvent?.({ phase: "pre", tool: name, index: i, mutated: true });
        }
      }
      let result = await tool.run(args);
      for (const [i, hook] of this.postHooks.entries()) {
        try {
          const r = await hook(name, args, result);
          if (r && typeof r === "object" && typeof r.result === "string") {
            result = r.result;
            opts.onHookEvent?.({ phase: "post", tool: name, index: i, mutated: true });
          }
        } catch {
          // A throwing post-hook is skipped; the tool's result is preserved.
        }
      }
      return result;
    } catch (err) {
      // A throwing tool becomes a result the model can react to, never a crashed run.
      return `[tool error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const defaultRegistry = new ToolRegistry();
