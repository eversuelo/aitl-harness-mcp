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

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    for (const gate of this.gates) {
      const [allowed, reason] = gate(name, args);
      if (!allowed) return `[denied by gate] ${reason}`;
    }
    const tool = this.tools.get(name);
    if (tool === undefined) return `[error] unknown tool '${name}'`;
    return tool.run(args);
  }
}

export const defaultRegistry = new ToolRegistry();
