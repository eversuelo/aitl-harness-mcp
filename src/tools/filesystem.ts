/** Filesystem tools: read / write files within a workspace root. */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "./base.js";

export class ReadFileTool implements Tool {
  readonly name = "read_file";
  readonly description = "Read a UTF-8 text file and return its contents.";
  readonly inputSchema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };

  async run(args: Record<string, unknown>): Promise<string> {
    return fs.readFile(String(args.path), "utf-8");
  }
}

export class WriteFileTool implements Tool {
  readonly name = "write_file";
  readonly description = "Write (overwrite) a UTF-8 text file.";
  readonly inputSchema = {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  };

  async run(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path);
    const content = String(args.content);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, "utf-8");
    return `wrote ${content.length} chars to ${path}`;
  }
}
