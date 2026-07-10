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
  readonly description =
    "Write (overwrite) a UTF-8 text file. Only for NEW files or full rewrites; to modify an existing file use edit_file instead.";
  readonly requiresApproval = true; // side-effect: subject to --ask (ADR-0040)
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

export class EditFileTool implements Tool {
  readonly name = "edit_file";
  readonly description =
    "Edit an existing text file by replacing an exact substring — a targeted diff, NOT a full rewrite. " +
    "`old_string` must match the file content exactly and only once (include surrounding lines to " +
    "disambiguate), or pass `replace_all` to replace every occurrence. Never echo the whole file in " +
    "your reply; make changes through this tool.";
  readonly requiresApproval = true; // side-effect: subject to --ask (ADR-0040)
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  };

  async run(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    if (!oldStr) throw new Error("old_string must be non-empty (use write_file to create a file).");
    if (oldStr === newStr) throw new Error("old_string and new_string are identical — nothing to change.");
    const content = await fs.readFile(path, "utf-8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${path} — re-read the file and copy the current text exactly.`);
    }
    if (count > 1 && args.replace_all !== true) {
      throw new Error(
        `old_string matches ${count} places in ${path} — include surrounding lines to make it unique, or set replace_all.`,
      );
    }
    const replaced = args.replace_all === true ? count : 1;
    const next =
      args.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await fs.writeFile(path, next, "utf-8");
    return `edited ${path}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}`;
  }
}
