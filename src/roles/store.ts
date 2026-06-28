/**
 * RoleStore — persists engineering roles (H11) in the existing `agents` collection,
 * discriminated by metadata.kind === "role". Reuses DefinitionStore for writes (so
 * created_at is preserved) and queries the collection directly for role-filtered reads.
 */

import type { Db, Document } from "mongodb";
import { getDb } from "../db/client.js";
import { AGENTS_COLLECTION } from "../projectctx/schemas.js";
import { DefinitionStore } from "../projectctx/store.js";
import { type Role, makeRole } from "./schema.js";

/** Map a stored agent-definition document back into a Role. */
export function roleFromDoc(doc: Document): Role {
  const m = (doc.metadata ?? {}) as Record<string, unknown>;
  return makeRole({
    name: String(doc.name ?? ""),
    lens: String(doc.content ?? ""),
    description: String(doc.description ?? ""),
    mode: (m.mode as Role["mode"]) ?? "review",
    severity: (m.severity as Role["severity"]) ?? "advisory",
    triggers: (m.triggers as string[]) ?? [],
    denyGlobs: (m.denyGlobs as string[]) ?? [],
    skills: (m.skills as string[]) ?? [],
    binding: (m.binding as Role["binding"]) ?? { host: "model", model: null },
  });
}

export class RoleStore {
  readonly db: Db;
  constructor(db?: Db) {
    this.db = db ?? getDb();
  }

  /** Upsert a role as an agent definition with metadata.kind="role". */
  async upsert(project: string, role: Role): Promise<Role> {
    await new DefinitionStore("agent", this.db).upsert({
      project,
      name: role.name,
      description: role.description,
      content: role.lens,
      source: "role",
      tags: ["role", `mode:${role.mode}`, `severity:${role.severity}`],
      metadata: {
        kind: "role",
        mode: role.mode,
        severity: role.severity,
        triggers: role.triggers,
        denyGlobs: role.denyGlobs,
        skills: role.skills,
        binding: role.binding,
      },
    });
    return role;
  }

  async get(project: string, name: string): Promise<Role | null> {
    const doc = await this.db.collection(AGENTS_COLLECTION).findOne({ project, name, "metadata.kind": "role" });
    return doc ? roleFromDoc(doc) : null;
  }

  async list(project: string): Promise<Role[]> {
    const docs = await this.db
      .collection(AGENTS_COLLECTION)
      .find({ project, "metadata.kind": "role" })
      .sort({ name: 1 })
      .toArray();
    return docs.map(roleFromDoc);
  }

  async delete(project: string, name: string): Promise<boolean> {
    const res = await this.db.collection(AGENTS_COLLECTION).deleteOne({ project, name, "metadata.kind": "role" });
    return res.deletedCount === 1;
  }
}
