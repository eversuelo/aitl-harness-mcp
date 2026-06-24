/**
 * Tool interface + registry + permission gate.
 *
 * A Tool exposes a name, a JSON-schema for its input, and a `run(args)`. The
 * registry renders the provider-agnostic tool schema and dispatches calls. The
 * permission gate is where deterministic policy lives (mirrors PreToolUse hooks).
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

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private gates: PermissionGate[] = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  addGate(gate: PermissionGate): void {
    this.gates.push(gate);
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
      return await tool.run(args);
    } catch (err) {
      // A throwing tool becomes a result the model can react to, never a crashed run.
      return `[tool error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const defaultRegistry = new ToolRegistry();
