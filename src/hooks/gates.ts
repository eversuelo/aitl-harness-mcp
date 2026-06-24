/**
 * Permission gates + phase-gates.
 *
 * A gate is `(toolName, args) -> [allowed, reason]`. Gates run before every tool call
 * in `ToolRegistry.call`. PhaseGate models the TDD-style "Green cannot start without
 * passing Red" pattern: a named phase must be satisfied before a tool is allowed.
 */

import { type PermissionGate, type ToolRegistry, defaultRegistry } from "../tools/base.js";

// Lightweight glob match (a single `*` wildcard per segment) to avoid an extra dep.
function globMatch(value: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}

/** Deny filesystem writes to any path matching one of `patterns`. */
export function denyPathsGate(patterns: string[]): PermissionGate {
  return (name, args) => {
    if (name === "write_file" || name === "shell") {
      const path = String(args.path ?? "");
      const target = `${path} ${String(args.command ?? "")}`;
      for (const pat of patterns) {
        if (globMatch(path, pat) || target.includes(pat)) {
          return [false, `path/command blocked by policy: ${pat}`];
        }
      }
    }
    return [true, ""];
  };
}

/** Block a set of tools until `check()` returns true (a phase-gate). */
export class PhaseGate {
  constructor(
    readonly name: string,
    readonly guardedTools: Set<string>,
    private check: () => boolean,
  ) {}

  asGate(): PermissionGate {
    return (name) => {
      if (this.guardedTools.has(name) && !this.check()) {
        return [false, `phase '${this.name}' not satisfied yet`];
      }
      return [true, ""];
    };
  }
}

/** Sensible defaults: protect VCS internals and secrets from writes. */
export function installDefaultGates(registry: ToolRegistry = defaultRegistry): void {
  registry.addGate(denyPathsGate([".git/*", "*.env", "*.pem", "*id_rsa*"]));
}
