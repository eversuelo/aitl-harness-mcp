/** Shell tool: run a command. Gated by the permission layer (src/hooks/gates.ts). */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./base.js";

const execAsync = promisify(exec);

export class ShellTool implements Tool {
  readonly name = "shell";
  readonly description = "Run a shell command and return combined stdout/stderr.";
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
      const { stdout, stderr } = await execAsync(command, { timeout });
      return `${stdout || ""}${stderr || ""}\n[exit 0]`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      if (e.killed) return `[timeout] command exceeded ${timeout / 1000}s`;
      return `${e.stdout || ""}${e.stderr || ""}\n[exit ${e.code ?? 1}]`;
    }
  }
}
