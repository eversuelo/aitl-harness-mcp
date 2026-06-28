/**
 * T3 — Restricción de consultas por tenant (ADR-SCH-002).  ← TASK (maker = agent)
 *
 * Implement `findStudentsByTenant` so a query NEVER returns another tenant's data
 * (filtro obligatorio por tenantId). `validateTenantIsolation` is the checker tool
 * (Tabla 4.3 "Seguridad" / `schoolar.validate_tenant_isolation`): 0 = sin fugas.
 * See ../SPEC.md. This stub leaks (returns all) to keep the gate RED.
 */

export interface TenantStudent {
  id: string;
  tenantId: string;
  name: string;
}

export class StudentRepo {
  private rows: TenantStudent[] = [];
  add(s: TenantStudent): void {
    this.rows.push(s);
  }
  /** All rows (test helper / "raw" access — not tenant-safe by itself). */
  all(): TenantStudent[] {
    return [...this.rows];
  }
  /**
   * TASK: return ONLY the students of `tenantId` (mandatory tenant filter).
   * Current stub LEAKS (returns every tenant's rows) → T3 gate is RED until fixed.
   */
  findStudentsByTenant(_tenantId: string): TenantStudent[] {
    return this.all();
  }
}

/**
 * Checker tool: returns the number of cross-tenant leakage violations (0 = ok).
 * For every known tenant, querying it must not surface any other tenant's row.
 */
export function validateTenantIsolation(repo: StudentRepo, tenantIds: string[]): number {
  let violations = 0;
  for (const t of tenantIds) {
    for (const row of repo.findStudentsByTenant(t)) {
      if (row.tenantId !== t) violations++;
    }
  }
  return violations;
}
