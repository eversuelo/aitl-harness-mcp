import assert from "node:assert/strict";
import { test } from "node:test";
import { deliberate, type RoleReviewProvider, roleGate } from "./engine.js";
import { makeRole } from "./schema.js";

test("roleGate vetoes a path matching the role's denyGlobs (deterministic, no model)", () => {
  const security = makeRole({ name: "security", lens: "x", mode: "gate", severity: "blocking", denyGlobs: ["*.env", "**/secrets/**"] });
  const gate = roleGate(security);
  assert.equal(gate("write_file", { path: "config/.env" })[0], false);
  assert.equal(gate("write_file", { path: "app/secrets/key.txt" })[0], false);
  assert.equal(gate("write_file", { path: "src/app.ts" })[0], true);
  // The veto reason is attributed to the role (H11 traceability).
  assert.match(gate("write_file", { path: "x.env" })[1], /\[role:security\]/);
});

// A fake provider returns a scripted JSON verdict per role lens.
function fakeProvider(byRole: Record<string, string>): RoleReviewProvider {
  return {
    async chat(_messages, opts) {
      const sys = opts?.system ?? "";
      for (const [name, json] of Object.entries(byRole)) if (sys.includes(`lens (${name})`)) return { text: json };
      return { text: '{"stance":"approve","findings":[],"recommendation":""}' };
    },
  };
}

test("deliberate produces a DecisionBrief; blocking role blocks, advisory softens", async () => {
  const roles = [
    makeRole({ name: "architect", lens: "ADRs", mode: "gate", severity: "blocking" }),
    makeRole({ name: "devops", lens: "ops", mode: "review", severity: "advisory" }),
  ];
  const provider = fakeProvider({
    architect: '{"stance":"block","findings":["contradice ADR-0020"],"recommendation":"no reintroducir provider crudo"}',
    devops: '{"stance":"block","findings":["sin rollback"],"recommendation":"añadir rollback"}',
  });
  const brief = await deliberate({ project: "p", target: "diff...", roles, provider });
  assert.equal(brief.verdicts.length, 2);
  // architect is blocking-severity → its block stands; devops is advisory → softened to concerns.
  const arch = brief.verdicts.find((v) => v.role === "architect")!;
  const ops = brief.verdicts.find((v) => v.role === "devops")!;
  assert.equal(arch.stance, "block");
  assert.equal(ops.stance, "concerns");
  assert.equal(brief.blocked, true);
});

test("deliberate: all advisory approvals → not blocked", async () => {
  const roles = [makeRole({ name: "qa", lens: "tests", mode: "pair", severity: "advisory" })];
  const brief = await deliberate({ project: "p", target: "x", roles, provider: fakeProvider({ qa: '{"stance":"approve","findings":[],"recommendation":""}' }) });
  assert.equal(brief.blocked, false);
});
