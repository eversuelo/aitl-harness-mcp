/** Shell tool: run a command. Gated by the permission layer (src/hooks/gates.ts). */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./base.js";

const execAsync = promisify(exec);

// exec's default maxBuffer is 1 MB and EXCEEDING IT THROWS, losing the output entirely.
// Give commands generous room, then clip what goes back to the model (head + tail) so a
// verbose command degrades to a truncated result instead of an opaque `[tool error]`.
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_RESULT_CHARS = 30_000;

function clip(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  const half = MAX_RESULT_CHARS / 2;
  return `${s.slice(0, half)}\n… [${s.length - MAX_RESULT_CHARS} chars truncated] …\n${s.slice(-half)}`;
}

export class ShellTool implements Tool {
  readonly name = "shell";
  readonly description = "Run a shell command and return combined stdout/stderr.";
  readonly requiresApproval = true; // side-effect: subject to --ask (ADR-0040)
  readonly inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", default: 120 },
    },
    required: ["command"],
  };

  async run(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command);
    const timeout = Number(args.timeout ?? 120) * 1000;
    try {
      const { stdout, stderr } = await execAsync(command, { timeout, maxBuffer: MAX_BUFFER });
      return `${clip(`${stdout || ""}${stderr || ""}`)}\n[exit 0]`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      if (e.killed) return `[timeout] command exceeded ${timeout / 1000}s`;
      return `${clip(`${e.stdout || ""}${e.stderr || ""}`)}\n[exit ${e.code ?? 1}]`;
    }
  }
}
