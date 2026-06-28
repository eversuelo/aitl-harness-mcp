/**
 * Software catalog (ADR-0028). A `software` is the top of the product hierarchy
 * `software -> projects -> repos`: it groups one or more existing `project` scopes
 * under a product name (e.g. "Schoolar"). Keyed globally by `name` (not scoped).
 */

import { z } from "zod";

const now = () => new Date();

export const SoftwareRecordSchema = z.object({
  name: z.string(), // globally-unique product key, e.g. "schoolar"
  display_name: z.string().default(""),
  description: z.string().default(""),
  projects: z.array(z.string()).default([]), // member project scopes
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  created_at: z.date().default(now),
  updated_at: z.date().default(now),
});
export type SoftwareRecord = z.infer<typeof SoftwareRecordSchema>;

export const makeSoftwareRecord = (v: z.input<typeof SoftwareRecordSchema>): SoftwareRecord =>
  SoftwareRecordSchema.parse(v);

export const SOFTWARES_COLLECTION = "softwares";
