/**
 * Shared node/edge colors for every graph + hierarchy view (Graph, Knowledge Map,
 * Workspace). One source of truth so the same entity kind reads with the same hue
 * across tabs.
 */
import type { NodeKind } from "../api.js";

export const NODE_FILL: Record<NodeKind, string> = {
  symbol: "#6366f1",
  memory: "#f59e0b",
  decision: "#ec4899",
  context: "#14b8a6",
  software: "#ef4444",
  project: "#8b5cf6",
  repo: "#22c55e",
  branch: "#0ea5e9",
  run: "#0f172a",
  prompt: "#64748b",
};

export const EDGE_STROKE: Record<string, string> = {
  ref: "#a5b4fc",
  link: "#fcd34d",
  contains: "#94a3b8",
  references: "#f472b6",
  derives: "#0ea5e9",
};

/** Badge classes per branch kind (trunks strongest, feature work greenish). */
export const BRANCH_KIND_BADGE: Record<string, string> = {
  main: "border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  master: "border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  develop: "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  staging: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  release: "border-teal-500/50 bg-teal-500/15 text-teal-700 dark:text-teal-300",
  hotfix: "border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300",
  feature: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  other: "border-border bg-muted text-muted-foreground",
};

/** Chip classes per branch environment. */
export const BRANCH_ENV_BADGE: Record<string, string> = {
  prod: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300",
  staging: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  dev: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300",
};
