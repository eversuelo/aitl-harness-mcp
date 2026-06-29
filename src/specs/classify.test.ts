import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySpec } from "./classify.js";

test("classifySpec flags a structured English spec", () => {
  const spec = `# Spec: user authentication

## Requirements
- Users must be able to log in with email and password.
- Sessions should expire after 30 minutes.

## Acceptance Criteria
- Given a valid user, when they submit correct credentials, then a session is created.
`;
  const c = classifySpec(spec);
  assert.equal(c.isSpec, true);
  assert.ok(c.signals.includes("heading:spec"));
  assert.ok(c.signals.includes("acceptance-criteria"));
});

test("classifySpec flags a Spanish user-story spec", () => {
  const spec = `## Historia de usuario

Como administrador quiero filtrar estudiantes por tenant para garantizar el aislamiento.

## Criterios de aceptación
- Dado un tenant, cuando consulto estudiantes, entonces solo veo los de ese tenant.
- El sistema debe rechazar accesos cruzados.
`;
  const c = classifySpec(spec);
  assert.equal(c.isSpec, true);
  assert.ok(c.signals.includes("user-story"));
});

test("classifySpec does NOT flag an ad-hoc task", () => {
  const c = classifySpec("arregla el bug del botón de login que no responde al click");
  assert.equal(c.isSpec, false);
});

test("classifySpec does NOT flag a short imperative even with a normative word", () => {
  const c = classifySpec("debe compilar");
  assert.equal(c.isSpec, false);
});
