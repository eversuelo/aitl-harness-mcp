/**
 * Seed catalog of engineering roles (H11 / E3). Each assists the Software Engineer's
 * decision through a distinct lens and coupling mode. Idempotent (upsert by name).
 */

import { RoleStore } from "./store.js";
import { type Role, makeRole } from "./schema.js";

export const SEED_ROLES: Role[] = [
  makeRole({
    name: "security",
    description: "Seguridad: secretos, authz/authn, inyección, CVEs, cripto.",
    lens: "Revisa por riesgos de seguridad: secretos hardcodeados, fugas de credenciales, authz/authn débil, inyección (SQL/command/prompt), dependencias vulnerables, cripto incorrecta. Bloquea solo lo demostrablemente inseguro; lo demás es advisory.",
    mode: "gate",
    severity: "blocking",
    triggers: ["write_file", "shell", "**/auth/**"],
    denyGlobs: ["*.env", "*.pem", "*id_rsa*", "**/secrets/**"],
    skills: [],
  }),
  makeRole({
    name: "devops",
    description: "DevOps: deploy, CI/CD, observabilidad, costo, IaC, rollback.",
    lens: "Revisa por operabilidad: impacto en CI/CD y deploy, observabilidad (logs/métricas), reversibilidad/rollback, costo, configuración por entorno. Señala riesgos operativos como advisory.",
    mode: "review",
    severity: "advisory",
    triggers: [],
    skills: [],
  }),
  makeRole({
    name: "qa",
    description: "QA: cobertura, edge cases, regresiones.",
    lens: "Revisa por calidad de pruebas: cobertura de criterios de aceptación, edge cases sin probar, posibles regresiones, aserciones débiles. Acompaña de forma continua; advisory.",
    mode: "pair",
    severity: "advisory",
    triggers: ["write_file"],
    skills: [],
  }),
  makeRole({
    name: "architect",
    description: "Arquitectura: consistencia con ADRs, límites de módulo.",
    lens: "Revisa por consistencia arquitectónica: respeto a ADRs aceptadas, límites entre módulos, acoplamiento, no reintroducir lo eliminado. Bloquea si contradice una ADR aceptada; el resto advisory.",
    mode: "gate",
    severity: "blocking",
    triggers: ["write_file"],
    denyGlobs: [],
    skills: [],
  }),
  makeRole({
    name: "devsecops",
    description: "DevSecOps: seguridad en el pipeline + deployability.",
    lens: "Composición de Security (bloqueante en secretos) y DevOps (operabilidad). Revisa pre-PR/pre-deploy: que el cambio sea seguro Y desplegable/reversible.",
    mode: "review",
    severity: "advisory",
    triggers: [],
    skills: [],
  }),
];

/** Upsert the seed roles into a project. Returns the role names written. */
export async function seedRoles(project: string, store = new RoleStore()): Promise<string[]> {
  for (const r of SEED_ROLES) await store.upsert(project, r);
  return SEED_ROLES.map((r) => r.name);
}
