# ADR-0064 — Tool edit_file: ediciones incrementales estilo diff en el toolset por defecto

- **Status:** accepted
- **Date:** 2026-07-09
- **Components:** src/tools, src/hooks, src/repl, src/orchestration

## Context

El toolset por defecto (chat REPL y runAgent) solo ofrecía read_file, write_file (sobreescritura completa) y shell. Sin una primitiva de edición incremental, los modelos locales chicos (4B–8B en la RTX 4050) responden volcando el archivo completo como bloque de código en el chat en lugar de aplicar el cambio — quema contexto (8–16k), corrompe la salida en streaming y deja el archivo sin tocar. Observado en vivo pidiendo mejorar asteroids-game.html: el modelo leyó el archivo con read_file y luego imprimió el HTML entero.

## Decision

Añadir EditFileTool (name: edit_file) a src/tools/filesystem.ts: reemplazo exacto old_string→new_string con match único obligatorio (error accionable si 0 o >1 matches; replace_all opt-in), requiresApproval=true (sujeto a --ask, ADR-0040). Registrada en el registro por defecto del chat (src/repl/chat.ts) y del loop (src/orchestration/graph.ts, installDefaultTools). denyPathsGate ahora también vigila edit_file (misma política de paths que write_file/shell). La descripción de write_file se reorienta: solo archivos nuevos o reescrituras completas; para modificar existentes, edit_file. La instrucción de conducta («nunca volcar el archivo entero en la respuesta») vive en la descripción de la tool, no en un system prompt aparte, para que aplique igual con cualquier provider.

## Consequences

- Los modelos chicos tienen un camino barato para editar: el costo por edición pasa de O(archivo) a O(hunk), clave con LMSTUDIO_MAX_CONTEXT 8–16k.
- La superficie de tools medida del harness cambia: corridas C0–C2 previas a este ADR se compararon con un toolset de 3 tools; las posteriores ven 4. Registrar en el análisis de métricas.
- El match único obligatorio convierte ediciones ambiguas en errores que el modelo puede corregir re-leyendo, en vez de escrituras silenciosamente mal ubicadas.
- 3 tests nuevos (388 total).
