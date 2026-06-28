/**
 * RBAC — single source of truth for AITL roles and the permission matrix.
 *
 * This module encodes the matrix from `docs/RBAC-REGISTRO.md` verbatim, so the web
 * API, the MCP HTTP transport and the CLI all answer authorization the same way.
 * Keep this file in sync with that document: it IS the policy.
 *
 * Decision model (per cell):
 *   "allow"      → permitted for this role.
 *   "deny"       → forbidden.
 *   "own"        → permitted only on resources the actor owns (needs `ownerId`).
 *   "delegated"  → not permitted to the actor directly; only AITL Server may perform
 *                  it acting under an `agent` identity (needs `delegated: true`).
 */

export const ROLES = ["root", "admin", "user", "agent", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const RESOURCES = [
  "users",
  "prompts",
  "memory",
  "decisions",
  "agents_skills",
  "softwares",
  "repos",
  "config_secrets",
  "indexes",
] as const;
export type Resource = (typeof RESOURCES)[number];

export type Action =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "set_role"
  | "disable"
  | "execute";

type Perm = "allow" | "deny" | "own" | "delegated";

/** Actor performing an operation. `source` records where the identity came from. */
export interface Actor {
  id: string;
  role: Role;
  source?: "web" | "server" | "mcp" | "cli" | "host-agent";
}

/**
 * The permission matrix. Reading order: MATRIX[resource][action][role].
 * Missing cells default to "deny" (fail closed).
 */
const MATRIX: Record<string, Partial<Record<Action, Partial<Record<Role, Perm>>>>> = {
  users: {
    create: { root: "allow" },
    read: { root: "allow", admin: "allow", user: "own", auditor: "allow" },
    set_role: { root: "allow" },
    disable: { root: "allow" },
  },
  prompts: {
    create: { root: "allow", admin: "allow", user: "own", agent: "allow" },
    read: { root: "allow", admin: "allow", user: "own", agent: "allow", auditor: "allow" },
    delete: { root: "allow", admin: "allow", user: "own", agent: "allow" },
  },
  memory: {
    create: { root: "allow", admin: "delegated", agent: "allow" },
    update: { root: "allow", admin: "delegated", agent: "allow" },
    delete: { root: "allow", admin: "delegated", agent: "allow" },
  },
  decisions: {
    create: { root: "allow", admin: "delegated", agent: "allow" },
    update: { root: "allow", admin: "delegated", agent: "allow" },
    delete: { root: "allow", admin: "delegated", agent: "allow" },
  },
  agents_skills: {
    create: { root: "allow", admin: "delegated", agent: "allow" },
    update: { root: "allow", admin: "delegated", agent: "allow" },
    delete: { root: "allow", admin: "delegated", agent: "allow" },
  },
  softwares: {
    create: { root: "allow", admin: "delegated", agent: "allow" },
    update: { root: "allow", admin: "delegated", agent: "allow" },
    delete: { root: "allow", admin: "delegated", agent: "allow" },
  },
  repos: {
    create: { root: "allow", admin: "delegated", agent: "allow" },
    update: { root: "allow", admin: "delegated", agent: "allow" },
    delete: { root: "allow", admin: "delegated", agent: "allow" },
  },
  config_secrets: {
    read: { root: "allow" },
    update: { root: "allow" },
  },
  indexes: {
    execute: { root: "allow" },
  },
};

export interface AccessContext {
  /** Owner id of the target resource, for "own" cells. */
  ownerId?: string;
  /** True when AITL Server performs the op under an `agent` identity. */
  delegated?: boolean;
}

export interface AccessDecision {
  allow: boolean;
  reason: string;
}

/**
 * Resolve whether `actor` may perform `action` on `resource`.
 * Fails closed: unknown role/resource/action → deny.
 */
export function can(
  actor: Actor,
  resource: Resource,
  action: Action,
  ctx: AccessContext = {},
): AccessDecision {
  if (!isRole(actor.role)) return { allow: false, reason: `unknown role '${actor.role}'` };

  const perm = MATRIX[resource]?.[action]?.[actor.role];
  if (perm === undefined || perm === "deny") {
    return { allow: false, reason: `role '${actor.role}' cannot ${action} ${resource}` };
  }
  if (perm === "allow") return { allow: true, reason: "permitted" };
  if (perm === "own") {
    if (ctx.ownerId !== undefined && ctx.ownerId === actor.id) {
      return { allow: true, reason: "owner" };
    }
    return { allow: false, reason: `role '${actor.role}' may only ${action} its own ${resource}` };
  }
  // "delegated"
  if (ctx.delegated === true) return { allow: true, reason: "delegated via AITL Server" };
  return {
    allow: false,
    reason: `role '${actor.role}' must delegate ${action} ${resource} to AITL Server (agent identity)`,
  };
}

/** Throwing variant for guard sites. */
export class RbacError extends Error {
  constructor(
    readonly actor: Actor,
    readonly resource: Resource,
    readonly action: Action,
    reason: string,
  ) {
    super(`RBAC denied: ${reason}`);
    this.name = "RbacError";
  }
}

export function assertCan(
  actor: Actor,
  resource: Resource,
  action: Action,
  ctx: AccessContext = {},
): void {
  const decision = can(actor, resource, action, ctx);
  if (!decision.allow) throw new RbacError(actor, resource, action, decision.reason);
}
