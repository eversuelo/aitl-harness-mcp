/**
 * ADR store — mirror Nygard-format ADRs from docs/adr/ into MongoDB.
 *
 * ADRs are the durable answer to Pain Point #1 (decision amnesia). They live as
 * markdown in git (human-readable, reviewable) AND in the `decisions` collection
 * (machine-retrievable via $vectorSearch alongside memory and chats).
 */

import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Db } from "mongodb";
import { getDb } from "../db/client.js";
import { embedOne } from "../ingest/embedder.js";
import { type ADR, makeADR } from "../memory/schemas.js";

const ID_RE = /ADR-?(\d+)/i;
const SECTION_RE = /^##\s+(Context|Decision|Consequences)\s*$/gim;

export async function parseAdrMarkdown(path: string, project: string): Promise<ADR> {
  const text = await fs.readFile(path, "utf-8");
  const firstLine = text.split(/\r?\n/).find((ln) => ln.trim()) ?? "";
  const m = ID_RE.exec(firstLine) ?? ID_RE.exec(basename(path));
  const adrId = m ? m[1] : basename(path, extname(path));
  const title =
    firstLine.replace(/^#+\s*/, "").split("—").pop()?.trim() || firstLine.trim();

  // Split on the section headings: [pre, "Context", body, "Decision", body, ...].
  const parts = text.split(SECTION_RE);
  const sections: Record<string, string> = {};
  for (let i = 1; i < parts.length - 1; i += 2) {
    sections[parts[i].toLowerCase()] = parts[i + 1].trim();
  }

  return makeADR({
    project,
    id: adrId,
    title,
    context: sections.context ?? "",
    decision: sections.decision ?? "",
    consequences: sections.consequences ?? "",
    git_ref: path,
  });
}

export class ADRStore {
  private db: Db;

  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  async upsert(adr: ADR, opts: { embed?: boolean } = {}): Promise<string> {
    if (opts.embed !== false) {
      adr.embedding = await embedOne(`${adr.title}\n${adr.context}\n${adr.decision}`);
    }
    await this.db
      .collection("decisions")
      .updateOne({ project: adr.project, id: adr.id }, { $set: adr }, { upsert: true });
    return adr.id;
  }

  /** Mirror all docs/adr/*.md into Mongo. Returns ADR ids written. */
  async syncDir(directory: string, project: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && extname(e.name) === ".md")
      .map((e) => join(directory, e.name))
      .sort();
    const ids: string[] = [];
    for (const p of mdFiles) ids.push(await this.upsert(await parseAdrMarkdown(p, project)));
    return ids;
  }
}
