# AITL — Una capa cognitiva durable para agentes de código

> Propuesta técnica · 2026-07-06 · Everardo T.
> Estado actual: ~60 tools MCP, CLI + interfaz web + TUI, 132/132 pruebas en verde y 48 decisiones de arquitectura registradas y versionadas usando el propio sistema.

---

## 1. El problema

Los agentes de código (Claude Code, Codex, Copilot Workspace) ya producen software real. Sin embargo, al usarlos dentro de un equipo aparecen cinco problemas que ninguno resuelve por sí solo:

1. **Amnesia entre sesiones.** Cada conversación arranca de cero. Las decisiones de arquitectura, las convenciones del equipo y el contexto del proyecto hay que re-explicarlos una y otra vez; cuando no se hace, el agente los contradice sin saberlo.
2. **Falta de trazabilidad.** Cuando un agente modifica el código, no queda un registro auditable de qué decidió, por qué, con qué contexto y sobre qué commit. Para un equipo que responde ante auditorías o clientes, eso no es sostenible.
3. **Éxito alucinado.** El agente reporta que terminó sin que nada verifique que las pruebas pasan. El costo aparece después, en revisión o en producción.
4. **Conocimiento que caduca en silencio.** Una decisión tomada hace tres meses puede seguir inyectándose como vigente aunque el código ya la contradiga. Nadie gobierna el ciclo de vida de ese conocimiento.
5. **Dependencia del host.** Todo lo que el equipo invierte en configurar un agente —contexto, reglas, memoria— vive dentro de ese producto. Cambiar de herramienta implica empezar de cero.

El patrón de fondo es el mismo en los cinco casos: el conocimiento del proyecto vive en la herramienta equivocada. Está en el chat, no en una capa que pertenezca al equipo.

## 2. La propuesta

AITL es una capa de estado cognitivo durable, propiedad del equipo, que se coloca entre los agentes y el proyecto. Lo que un agente necesita saber —y lo que hace— se persiste en una base de datos del equipo (MongoDB Atlas), no en la sesión de chat.

Opera en dos modos sobre esa misma capa:

| Modo | Qué hace | Cuándo conviene |
|---|---|---|
| Harness propio | Ejecuta agentes él mismo (`aitl run` / `orchestrate`), con cualquier modelo vía OpenRouter | Tareas repetibles, pipelines, experimentos comparables bajo condiciones controladas |
| Capa cognitiva sobre hosts | Se engancha a los agentes que el equipo ya usa (Claude Code, Codex) mediante hooks y un servidor MCP con ~60 tools | Adopción gradual: cada quien sigue en su herramienta, pero con memoria, contexto y auditoría compartidos |

La consecuencia práctica es que AITL no sustituye al agente que ya se usa; le da al equipo la parte que hoy no existe: memoria, gobierno y evidencia.

## 3. Qué resuelve cada pieza

### Memoria e hidratación — contra la amnesia
Cada sesión inicia hidratada con lo relevante del proyecto: memorias (recuperación vectorial, con respaldo por texto y recencia), decisiones vigentes, convenciones y un mapa del repositorio. Al cerrar, la sesión se sintetiza y se guarda sin intervención manual. El contexto deja de ser conocimiento tribal que alguien tiene que repetir.

### Decisiones con ciclo de vida — contra el conocimiento caduco
Las decisiones de arquitectura se registran como datos versionados, no como archivos sueltos. Cada una lleva el commit exacto en que se tomó, un estado (`accepted`, `deprecated`, `superseded`), la razón de deprecación y una fecha de revisión. El vencimiento es suave: al cumplirse, la decisión se excluye del contexto y se marca para revisión, pero nunca se borra ni se deprecia sola. El sistema puede proponer deprecaciones; decidir sigue siendo del humano.

### Trazabilidad — contra la caja negra
Cada corrida queda ligada a los artefactos que produjo (decisiones, memorias, prompts) a partir de su propio transcript, y se visualiza como un grafo de sesión en la interfaz web. La pregunta "¿qué hizo el agente el martes, con qué contexto y qué decidió?" se responde con datos, no con memoria de quien estuvo presente.

### Gates y roles — contra el éxito alucinado
Un run no termina hasta que el comando de verificación definido por el equipo (pruebas, lint) sale en verde. Además, roles configurables (seguridad, QA, arquitectura, devops) actúan de tres formas: como veto determinista dentro del loop (por ejemplo, impedir que el agente toque un `.env`), como revisión al final del run, o como asesoría en paralelo. El resultado es un resumen de hallazgos que asiste al ingeniero; no decide por él. La supervisión humana también se mide: cada intervención se registra con los minutos invertidos.

### MCP y adaptadores de host — contra la dependencia
El estado vive en la base del equipo y se sirve por MCP, un protocolo estándar. Hoy se consume desde Claude Code; puede consumirse desde cualquier host compatible. Cambiar de agente no pierde nada. El acceso está gobernado con RBAC y sesiones con tokens opacos de vida limitada.

## 4. En qué se distingue de los frameworks de agentes

Frente a LangGraph, AutoGen, CrewAI o el Agents SDK de OpenAI, la diferencia no está en la lista de funciones sino en el problema que atacan. Esos frameworks resuelven cómo ejecutar y coordinar agentes; ninguno resuelve qué recuerda el equipo entre sesiones ni quién gobierna el ciclo de vida de las decisiones. AITL se concentra en eso.

Dos datos ilustran el punto. Primero, AITL usó LangGraph y terminó retirándolo: un loop único que reanuda desde un transcript durable resultó más simple y más auditable, y esa decisión quedó registrada como cualquier otra. Segundo, AITL funciona sobre las herramientas existentes, no en su lugar, así que adoptarlo no exige migrar nada.

## 5. Qué respalda la madurez del sistema

- El sistema se construye a sí mismo con su propia disciplina: 48 decisiones contiguas y versionadas, y cada fase cerrada con verificación en verde, prueba E2E dirigida, decisión registrada y espejo en markdown. Es su propio caso de estudio.
- Hay una evaluación experimental en curso con diseño controlado: las mismas tareas se ejecutan con y sin harness (condiciones C0 y C2), midiendo tiempo, tokens, iteraciones, minutos de intervención humana y tasa de éxito verificado —no auto-reportado—. Un piloto (un ray-tracer) ya está instrumentado; un segundo (un backend SaaS multi-tenant) está en preparación.
- La suite es estable: 132/132 pruebas, typecheck limpio y autenticación web con sesiones TTL probada de extremo a extremo contra Atlas.

## 6. Lo que sigue

En el corto plazo: gestión de usuarios self-service, una pantalla de configuración con RBAC y auditoría, sincronización bidireccional del estado a markdown dentro del repo (para que el conocimiento sea legible incluso sin el sistema) y un `aitl init` de un solo paso. Más adelante: mapa de módulos del repositorio, coordinación entre varios agentes (una primera versión por polling, deliberadamente simple) y un consejo de agentes que delibera sobre un plan antes de ejecutarlo.

También hay pendientes que conviene decir de frente: la degradación sin LLM todavía no está unificada, y dos hipótesis del diseño —la conversión de fallos en guías reutilizables y la portabilidad entre modelos— aún no tienen dato empírico. Ambas están dentro del plan de medición.

## 7. Cómo se adopta

1. **Primer día — enganche pasivo.** `aitl init` sobre un repo más los hooks en el host que ya usa el equipo. Desde ahí, cada sesión se hidrata e indexa sola. Nadie cambia su flujo de trabajo.
2. **Primera semana — disciplina de decisiones.** El equipo empieza a registrar decisiones a través del propio agente y las decisiones previas se importan.
3. **Cuando haya confianza — automatización.** Las tareas repetibles pasan al harness propio con gates de verificación, y la interfaz web se convierte en el panel de auditoría de lo que hicieron los agentes.

Cada etapa deja valor por sí sola; no hace falta comprometerse con la siguiente para justificar la anterior.

---

### Lo que me gustaría discutir con ustedes

- ¿El gobierno de decisiones propuesto (vencimiento suave más marca de revisión, con el humano decidiendo siempre) les parece suficiente, o preferirían un flujo de re-aprobación explícito?
- ¿Qué modelo de amenaza le pondrían a una pantalla de configuración que administra llaves? Lo diseñado es RBAC (root directo, admin delegado) con auditoría.
- ¿Qué proyecto interno sería buen candidato para un piloto de adopción pasiva, en modo capa cognitiva, sin cambiar el flujo de nadie?
