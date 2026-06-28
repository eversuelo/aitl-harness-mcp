# Hoja de métrica manual v2 — por corrida (Tabla 4.3)

> Instrumento de captura por corrida, mapeado 1:1 a la Tabla 4.3. Llena C0 y C2 sobre la **misma SDD**
> y el **mismo estado inicial** del repo; compáralos al final.
>
> **Honestidad de medición:** marca cada número con su fuente — `measured` (lo reporta el
> proveedor/herramienta), `counted` (lo contaste de eventos/logs), `estimated` (a ojo). No mezcles
> estimados con medidos al concluir.

---

## ✅ Antes de medir (precondiciones — una sola vez)

- [ ] **P0 seguridad:** rotar el password de Mongo y sacar `.mcp.json` de git (`git rm --cached`).
      No generes datos "oficiales" sobre un repo público con credenciales filtradas (publicarás el
      dataset, §5.4).
      &nbsp;&nbsp;↳ *Estado verificado (2026-06-28): `.mcp.json` tiene **0 hits en git** (nunca
      commiteado) y ya está en `.gitignore`; existe `.mcp.json.example`. El git está limpio. La
      **rotación** sigue siendo recomendable (el password se mostró en salidas de sesión).*
- [ ] **Confirmar el comando de captura:** `aitl run-show <runId>` existe y devuelve `tokens.total`,
      `tool_calls`, `iters` y las secciones de `hydrate`. **Si no existe, ese es el bloqueador real**
      — no la hoja.
      &nbsp;&nbsp;↳ *Verificado: `aitl run-show` implementado y probado con un run sintético.*
- [ ] **Proveedor para `aitl run`:** definir `OPENROUTER_API_KEY` (sin esto el loop de C2 no llama a
      un modelo). *Bloqueador actual del primer C2.*
- [ ] **Fijar la definición del reloj** (abajo) y no cambiarla entre corridas.

## ⏱️ Definición del reloj (fija — no cambiar entre corridas)

- **Inicio:** al enviar el primer prompt al agente.
- **Fin:** primer `npm test` en verde con **todos** los criterios de aceptación cumplidos.
- **No se pausa:** incluye el "pensamiento" del modelo, tus lecturas, reintentos e intervenciones.
  (Las intervenciones se cuentan aparte en la métrica 6, pero el reloj sigue corriendo.)

## ⚖️ Regla de medición C0 vs C2 (léela antes de la primera corrida)

La **medición se aplica idéntica a las dos condiciones**; solo difiere el **desarrollo**. En C0 el
*agente* trabaja sin harness, sin memoria, sin ADR, sin gates y sin recuperación de contexto — pero
**tú igual** (a) corres las pruebas de aceptación sobre su salida para medir calidad y (b) registras
tokens/iteraciones del proveedor externamente. Si no mides C0 igual que C2, la comparación no es justa.

> En este harness: **C2** = `aitl run … --project schoolar-mvp` (default) · **C0** = `aitl run … --bare`
> (apaga hydrate/skills/gates). Mismo estado inicial vía `git checkout -- examples/schoolar-mvp`.

---

## 🧾 Setup por SDD (una vez por especificación — compartido por C0 y C2)

| Campo | Valor |
|---|---|
| sddId | |
| Hash de la spec (`sha256sum examples/schoolar-mvp/SPEC.md`) | |
| Título de la tarea | T1 — Alta de alumno con validaciones |
| Estado inicial del repo (SHA) | |
| **Línea base de la suite (# pruebas en verde ANTES)** | (T1 gate: 3/4; el caso válido falla) |
| Comando de pruebas | `npm test --prefix examples/schoolar-mvp` |
| Comando de reset entre corridas | `git checkout -- examples/schoolar-mvp` |

> El `sddId` + hash es lo que **prueba** que C0 y C2 corrieron exactamente la misma especificación.
> Nunca modifiques la spec entre ambas corridas.

---

## Corrida (duplica este bloque por cada ejecución)

| Campo | Valor |
|---|---|
| ID de corrida (runId) | |
| sddId (debe coincidir con el setup) | |
| Condición | ☐ C0 (improvisado)  ☐ C1  ☐ C2 (harness completo) |
| Modelo / host | |
| Fecha | |
| Repetición # | (1, 2, 3…) |
| **¿Éxito alucinado?** (¿el agente afirmó "terminé" ANTES del gate verde?) | ☐ sí  ☐ no |

### Métricas (Tabla 4.3)

| # | Dimensión | Métrica | Cómo capturar | Fuente | Valor | Confianza |
|---|---|---|---|---|---|---|
| 1 | Velocidad | Tiempo hasta gate verde | Reloj (def. arriba): envío del prompt → primer `npm test` verde | manual | | counted |
| 2 | Calidad funcional | % pruebas de aceptación aprobadas | Salida de `npm test` (aprobadas/total) | auto | | measured |
| 3 | Estabilidad | # regresiones | Suite completa: pruebas que pasaban en la **línea base** y ahora fallan | auto | | measured |
| 4 | Mantenibilidad | Complejidad / duplicación / violaciones | Nota cualitativa (alta/media/baja) en el piloto | manual | | estimated |
| 5 | Seguridad | Violaciones de aislamiento por tenant | `validate_tenant_isolation` (0 = ok). N/A si la SDD no es de tenant | auto | | measured |
| 6 | Supervisión humana | # y duración de intervenciones | Cuenta intervenciones + minutos | manual | | counted |
| 7 | Eficiencia del agente | Tokens · costo aprox · tool calls · iteraciones | `aitl run-show <runId>` (`tokens.total`, `tool_calls`, `iters`). En C0: tokens del proveedor | auto | | measured |
| 8 | Memoria | # recuerdos recuperados · relevancia · uso efectivo | `aitl run-show` → `hydrate`. **C0 = 0** (sin memoria) | auto/manual | | counted/estimated |
| 9 | Trazabilidad | ¿Cadena spec → tarea → cambios → pruebas → resultado reconstruible? | `events` + commits: ☐ sí ☐ parcial ☐ no | manual | | counted |

### Notas de la corrida

- ¿Éxito alucinado? — qué afirmó vs. qué pasó realmente:
- Intervenciones (qué y por qué):
- Fallos / reintentos observados:
- Cadena de trazabilidad (qué eslabón faltó, si alguno):

---

## Comparación C0 vs C2 (misma SDD)

| Dimensión | C0 | C2 | Δ (C2 − C0) | Observación |
|---|---|---|---|---|
| Tiempo a gate | | | | |
| % pruebas aprobadas | | | | |
| Regresiones | | | | |
| **Éxitos alucinados** | | | | |
| Mantenibilidad | | | | |
| Aislamiento tenant | | | | |
| Intervenciones humanas | | | | |
| Tokens / iteraciones | | | | |
| Memoria (recuerdos usados) | | | | |
| Trazabilidad | | | | |

**Lectura esperada (§5.5, hipótesis):** C2 debería mejorar calidad, estabilidad y trazabilidad, y
reducir el tiempo a gate, **a costa de más tokens**. Si el primer dato lo contradice, **es hallazgo**
— anótalo, no lo descartes.

---

## Recordatorios de validez

- **Repite cada condición ≥3 veces** antes de concluir (§4.4): una corrida no estima dispersión.
- **Mismo estado inicial:** `git checkout -- examples/schoolar-mvp` entre corridas.
- **Aleatoriza el orden** de las corridas (no todas las C0 seguidas y luego las C2).
- **maker/checker:** quien evalúa la salida no es quien la construyó (§1.10.4).
- Este lote es **piloto** (afinar instrumento y definiciones), no las 63 corridas formales.
