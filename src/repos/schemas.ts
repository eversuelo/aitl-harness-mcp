/**
 * Repo catalog (ADR-0028). A `repo` is the leaf of `software -> projects -> repos`:
 * a concrete git repository (remote/branch/path) that belongs to a `project` scope.
 * Keyed by (project, name). The same `name` is used as the data sub-scope `repo` on
 * memory/symbols/context.
 */

import { z } from "zod";

const now = () => new Date();

export const RepoRecordSchema = z.object({
  project: z.string(), // owning project scope
  name: z.string(), // repo key within the project (also the data sub-scope `repo`)
  software: z.string().nullable().default(null), // owning software name (optional)
  remote: z.string().default(""), // git remote URL
  branch: z.string().default(""),
  path: z.string().default(""), // local filesystem root, if any
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.date().default(now),
  updated_at: z.date().default(now),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

export const makeRepoRecord = (v: z.input<typeof RepoRecordSchema>): RepoRecord => RepoRecordSchema.parse(v);

export const REPOS_COLLECTION = "repos";
