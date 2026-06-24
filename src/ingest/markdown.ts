/**
 * Parse markdown memory files into MemoryDoc objects.
 *
 * Handles YAML frontmatter (name/description/type + arbitrary metadata) and extracts
 * `[[wiki-style]]` links between memories. Mirrors the harness's own memory format.
 */

import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import matter from "gray-matter";
import { MEMORY_TYPES, type MemoryDoc, type MemoryType, makeMemoryDoc } from "../memory/schemas.js";

export const LINK_RE = /\[\[([^\]]+)\]\]/g;

/** Extract every `[[wiki-link]]` target from a body of text. */
export function extractLinks(body: string): string[] {
  return [...body.matchAll(LINK_RE)].map((m) => m[1]);
}

export async function parseMarkdownFile(path: string, project: string): Promise<MemoryDoc> {
  const raw = await fs.readFile(path, "utf-8");
  const { data: meta, content: body } = matter(raw);

  const metaType = (meta.metadata?.type as string | undefined) ?? (meta.type as string | undefined) ?? "project";
  const mdType: MemoryType = (MEMORY_TYPES as readonly string[]).includes(metaType)
    ? (metaType as MemoryType)
    : "project";

  const slug = String(meta.name ?? basename(path, extname(path)));

  return makeMemoryDoc({
    project,
    slug,
    type: mdType,
    description: String(meta.description ?? ""),
    body,
    frontmatter: meta as Record<string, unknown>,
    links: extractLinks(body),
    source_path: path,
  });
}

/** Recursively collect every `*.md` file under a directory. */
async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (e.isFile() && extname(e.name) === ".md") out.push(full);
  }
  return out.sort();
}

export async function parseMarkdownDir(directory: string, project: string): Promise<MemoryDoc[]> {
  const files = await walkMarkdown(directory);
  return Promise.all(files.map((p) => parseMarkdownFile(p, project)));
}
