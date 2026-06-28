/**
 * T3 acceptance tests (checker). The maker (agent under C0/C1/C2) edits
 * src/tenant.ts until these pass. Do NOT edit these during a measured run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { StudentRepo, validateTenantIsolation } from "./src/tenant.js";

function seeded(): StudentRepo {
  const r = new StudentRepo();
  r.add({ id: "a1", tenantId: "acme", name: "Ada" });
  r.add({ id: "a2", tenantId: "acme", name: "Alan" });
  r.add({ id: "b1", tenantId: "globex", name: "Bart" });
  return r;
}

test("T3: a tenant query returns ONLY that tenant's students", () => {
  const r = seeded();
  const acme = r.findStudentsByTenant("acme");
  assert.equal(acme.length, 2);
  assert.ok(acme.every((s) => s.tenantId === "acme"));
  const globex = r.findStudentsByTenant("globex");
  assert.equal(globex.length, 1);
  assert.equal(globex[0].id, "b1");
});

test("T3: validate_tenant_isolation reports 0 violations (no cross-tenant leak)", () => {
  const r = seeded();
  assert.equal(validateTenantIsolation(r, ["acme", "globex"]), 0);
});

test("T3: an unknown tenant returns no students", () => {
  assert.equal(seeded().findStudentsByTenant("nope").length, 0);
});
