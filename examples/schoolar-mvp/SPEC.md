# T1 — Alta de alumno con validaciones (spec)

> Rebanada vertical mínima de Schoolar (tenant + alumno). Esta es la tarea medible del
> primer piloto C0 vs C2. El estado inicial del repo (este directorio) es el MISMO para
> ambas condiciones; reinícialo entre corridas (`git checkout -- examples/schoolar-mvp`).

## Objetivo

Implementar `registerStudent(input)` en `src/student.ts` con **validación Zod**, de modo
que el alta de un alumno valide su entrada y normalice el email, dentro de un tenant.

## Contrato

```ts
interface StudentInput { tenantId: string; name: string; email: string; }
interface Student { id: string; tenantId: string; name: string; email: string; createdAt: Date; }
function registerStudent(input: StudentInput): Student
```

## Criterios de aceptación (gate = `npm test` en este directorio)

1. Una entrada válida devuelve un `Student` con `id` (string no vacío), `tenantId`,
   `name`, `email` **normalizado a minúsculas** y `createdAt` (Date).
2. Rechaza (lanza error) si `name` está vacío/en blanco.
3. Rechaza si `email` no es un email válido.
4. Rechaza si `tenantId` está vacío/en blanco.

La validación debe hacerse con **Zod** (`zod` ya está disponible en el workspace).

## Cómo correr el gate

```bash
npm test --prefix examples/schoolar-mvp
# o:  cd examples/schoolar-mvp && npm test
```

Estado inicial: **RED** (la implementación es un stub que lanza "not implemented").
La tarea está completa cuando las 4 pruebas pasan.

---

# T3 — Restricción de consultas por tenant (ADR-SCH-002)

## Objetivo

Implementar `findStudentsByTenant(tenantId)` en `src/tenant.ts` con **filtro obligatorio
por `tenantId`**, de modo que ninguna consulta devuelva datos de otro tenant.

## Criterios de aceptación (gate = `npm run test:t3`)

1. Una consulta por tenant devuelve **solo** los alumnos de ese tenant.
2. `validateTenantIsolation(repo, tenants)` (el tool `schoolar.validate_tenant_isolation`
   de la Tabla 4.3 "Seguridad") devuelve **0** (sin fugas entre tenants).
3. Un tenant desconocido devuelve cero alumnos.

Estado inicial: **RED** (el stub `findStudentsByTenant` devuelve todos los rows = fuga).

## Gates por tarea

```bash
npm run test:t1 --prefix examples/schoolar-mvp   # T1
npm run test:t3 --prefix examples/schoolar-mvp   # T3
npm test        --prefix examples/schoolar-mvp   # ambas
```
