## SPEC-12 — Multimodalidad aditiva del harness
**Requisitos que cubre:** 17 (principal); toca 12 (costo de imágenes por modelo, vía SPEC-09) y 16 (flag `vision` del catálogo, vía SPEC-11).

### Objetivo y motivación
Hoy el soporte multimodal es CERO end-to-end: `content` es `string` en todo el pipeline (verificado 2026-07-17; los hits de image/vision en `src/` son falsos positivos de "supervisión"/"revisión"). Pero las tres capas externas ya son multimodales sin que el harness las use: el SDK Anthropic acepta bloques `image`, los gateways OpenAI-compat (OpenRouter/Chutes) aceptan `image_url` con VLMs, y el protocolo MCP permite `image` content en tool results — que `src/mcpclient/client.ts` hoy APLANA a texto. El objetivo es una ruta **aditiva y retrocompatible** en 4 frentes: entrada (`ContentPart[]`), tools con resultado de imagen (`view_image`/`screenshot`, cliente MCP sin aplanar), memoria de artefactos visuales (referencia content-addressed + caption textual; embeddings siguen text-only), y **verificación visual del loop**: un verifier que VE el render del raytracer y lo compara con la referencia — el caso estrella no es una feature, es un **instrumento de medición de la tesis** (cap. 4: gate `check.sh` con media $|\Delta| \le 2.00$ por canal contra render PPM de referencia; métrica `imagen_ok` del CSV).

### Estado actual (anclas de código verificadas)
- `src/models/message.model.ts:44` — `content: { type: String, default: "" }`; `tool_calls` subdocumento; sin campo para partes no-texto. `makeMessage` (línea 81) valida vía Mongoose.
- `src/providers/base.ts` — `ChatTurn.text: string`, `ChatOpts` sin noción de partes; `Provider.chat(messages: Record<string,unknown>[])` (el shape del mensaje es informal: `{role, content, tool_calls?, tool_call_id?}`).
- `src/providers/anthropic.ts:45-92` — `toAnthropicMessages` solo emite bloques `text`/`tool_use`/`tool_result` con `content: string`; línea 58: `const text = typeof m.content === "string" ? m.content : ""` (un array hoy se DESCARTA en silencio).
- `src/providers/openai.ts:96-114` — `toOpenAiMessages` pasa `content` tal cual; nunca arma arrays `[{type:"text"},{type:"image_url"}]`.
- `src/contracts.ts:56-63` — `ProviderCapabilitiesSchema` sin flag `vision` (campos toolUse/jsonMode/maxContext/streaming/caching/hostAdapter).
- `src/tools/base.ts:17` — `Tool.run(args): Promise<string>`; `ToolRegistry.call` (118-161) devuelve `Promise<string>` y los post-hooks tipan `result: string`.
- `src/mcpclient/client.ts:46-54` — `contentToString` aplana el content del tool result MCP: los bloques no-texto caen a `JSON.stringify(p)` (una imagen base64 se serializa como JSON gigante o se pierde).
- `src/orchestration/graph.ts` — `Verifier {name, run(ctx)}` (123-126), `runVerifiers` (426-458) agrega fallos como feedback y loguea evento `verify` por verdicto; tool results se persisten como `role:"tool"` con `content` string (691-699); `rebuildConvo` (166-178) reconstruye solo texto.
- `src/repl/chat.ts` — `expandFileMentions` (`@ruta` adjunta TEXTO), slash commands `/read`, `/call`; `printHelp` (91-111) es el punto para `/image`.
- Tesis cap. 4 (`sections/chapter-04/chapter.tex`): fases F0–F5 con gate objetivo `make && check.sh` (líneas 54-72: F0 sondas de píxel ±10/255; F1/F3 media $|\Delta|$ por canal contra render de referencia, tolerancia 2.00; F5 tres escenas a 32/512 spp), renders PPM P3, solución humana en `objective/`, CSV con columna `imagen_ok` (línea 346).

### Diseño

#### D1. Tipos de contenido (`src/content/parts.ts`, módulo nuevo)
```ts
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type ImageSource =
  | { kind: "base64"; media_type: ImageMime; data: string }   // wire-ready
  | { kind: "path"; path: string }                            // se resuelve lazy al armar el request
  | { kind: "artifact"; hash: string };                       // resuelto desde el ArtifactStore (D4)
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource; caption?: string };
export type MessageContent = string | ContentPart[];

export const textOf = (c: MessageContent): string;            // proyección texto (compat total)
export const hasImages = (c: MessageContent): boolean;
export async function imagePartFromFile(path: string, caption?: string): Promise<ContentPart>; // registra en ArtifactStore, sniff MIME por magic bytes, cap AITL_IMAGE_MAX_BYTES
export async function resolveConvoImages(convo: Record<string,unknown>[], store: ArtifactStore): Promise<void>; // path/artifact → base64 ANTES de llamar al provider; los adaptadores siguen síncronos
```
Regla de presupuesto: solo las últimas `AITL_IMAGE_CONVO_MAX` (default 4) imágenes del convo van al modelo; las anteriores degradan a `[imagen: <caption>]` (texto). Nunca se resuelve base64 hacia Mongo.

#### D2. Persistencia retrocompatible (`message.model.ts`)
`content` SIGUE siendo string (la proyección `textOf` — todo lector viejo, embeddings y `$text` intactos). Se añade subdocumento opcional:
```ts
const contentPartSchema = new Schema({
  type: { type: String, enum: ["text", "image"], required: true },
  text: { type: String, default: "" },
  media_type: { type: String, default: null },
  artifact_hash: { type: String, default: null },  // sha256 → ArtifactStore; JAMÁS base64 en Mongo (sin campo data, enforced por schema)
  caption: { type: String, default: "" },
}, { _id: false, ...BASE_SCHEMA_OPTS });
// en messageSchema:  parts: { type: [contentPartSchema], default: [] },
```
`rebuildConvo` (graph.ts:166-178) reconstruye `content: ContentPart[]` cuando `parts` no está vacío; si el artefacto ya no existe en disco degrada a caption — un resume nunca rompe.

#### D3. Adaptadores y capabilities
- `toAnthropicMessages`: parte imagen → `{type:"image", source:{type:"base64", media_type, data}}` dentro del user turn; un `tool_result` con partes emite `content: [bloques image+text]` (el SDK lo soporta nativo).
- `toOpenAiMessages`: user content array `[{type:"text",text},{type:"image_url", image_url:{url:"data:image/png;base64,…"}}]`. El rol `tool` de la mayoría de gateways solo acepta string ⇒ un tool result con imagen conserva su texto en el mensaje `tool` y la imagen se **reemite como user turn sintético** inmediato marcado `[resultado visual de <tool>]` (determinista, documentado en tests).
- `contracts.ts`: `vision: z.boolean().default(false)` en `ProviderCapabilitiesSchema` (aditivo: ningún `capabilities()` existente rompe). `AnthropicProvider` → `true`; `OpenAIProvider` recibe `opts.vision` — la verdad por-modelo vive en el catálogo SPEC-11. Si `hasImages(convo)` y el provider activo no declara `vision`, el loop degrada las imágenes a caption CON AVISO y evento `vision_degraded`, y sugiere VLM vía el protocolo de handoff de SPEC-11 (nunca silencioso).

#### D4. Artefactos (`src/artifacts/store.ts` + `src/models/artifact.model.ts`, nuevos)
```ts
// colección `artifacts`: content-addressed, metadatos consultables
{ project, hash /* sha256, índice único (project,hash) */, media_type, bytes,
  width, height, storage_path, caption: "", caption_model: null,
  source: "user"|"tool"|"render"|"host", run_id: null, tool: null, created_at }
```
`ArtifactStore.put(buf, meta) → {hash}` escribe `.aitl/artifacts/<hh>/<sha256>.<ext>` (config `AITL_ARTIFACTS_DIR`) + doc Mongo best-effort (sin backend: disco puro, mismo patrón de degradación que memoria). `resolve(hash) → Buffer`. Dimensiones leídas de cabeceras (PNG IHDR / JPEG SOF / PPM header) sin dependencias. Caption: al cierre del run, el tier `synthesize` (SPEC-02) con VLM genera ≤280 chars por artefacto nuevo; sin VLM, caption heurístico ("captura de <tool> en run <id>"). **Embeddings siguen text-only: se embebe el caption, nunca píxeles.** Convención en memoria: `![<caption>](aitl-artifact://<hash>)` en el body; `aitl sync` exporta el binario junto al espejo markdown con ruta relativa. Web: `GET /api/artifacts/:hash` + preview en Runs (mensajes con `parts`) y Memory (render del esquema `aitl-artifact://`).

#### D5. Tools con resultado de imagen
```ts
export interface RichToolResult { text: string; parts?: ContentPart[] }
// Tool.run pasa a: run(args): Promise<string | RichToolResult>   (todo tool existente compila sin cambios)
// ToolRegistry: nuevo callRich(name, args, onDeny?, opts?) → Promise<RichToolResult> — la vía del loop;
// call() delega en callRich y devuelve .text (compat total: /call del chat, tests, post-hooks siguen tipando string y ven .text).
```
Tools nuevas (`src/tools/vision.ts`), registradas en el toolset perfil `vision` de SPEC-05 (NO en el default de un 7B):
- `view_image` — `{path: string}` → guarda en ArtifactStore y devuelve `{text: "PNG 800×600 · 1.2MB · hash ab12…", parts:[{type:"image", source:{kind:"artifact", hash}}]}`. Read-only.
- `screenshot` — `{window?: "full"|"active", out?: string}`; `requiresApproval: true` (ADR-0040); backends probados en orden: `scrot -o` → `gnome-screenshot -f` → `import -window root` (Linux), `screencapture` (macOS); error accionable listando los probados (trampa scrot/gamma conocida del lab rayo-vk).
- Cliente MCP: `contentToString` (client.ts:46) se reemplaza por `contentToParts`: bloques `{type:"image", data, mimeType}` del result → `ArtifactStore.put` → parte `{kind:"artifact"}`; el texto se concatena como hoy. `mountClientTools` devuelve `RichToolResult`. El server propio también DEVUELVE image content: tool MCP nueva `get_artifact`.
- graph.ts: el loop usa `callRich`; persiste `makeMessage({…, content: rich.text, parts})` y empuja `{role:"tool", tool_call_id, content: rich.text, parts}` al convo; `resolveConvoImages` corre justo antes de `provider.chat/chatStream`.

Tools MCP nuevas (patrón `server.tool` + `runLogged` + `TOOL_RBAC` + canario en `mcpserver/rbac.test.ts`):
- `save_artifact` — zod `{project: z.string(), path: z.string().optional(), base64: z.string().optional(), media_type: z.string().optional(), caption: z.string().optional(), run_id: z.string().optional()}` → `{hash, storage_path}`. RBAC: recurso `artifacts`, acción create (entrada nueva en `TOOL_RBAC`, server.ts:241-277).
- `get_artifact` — zod `{project: z.string(), hash: z.string(), as: z.enum(["meta","image"]).default("meta")}`; `as:"image"` responde content MCP `[{type:"image", data, mimeType}]`. Read-only, sin entrada mutante en RBAC.

#### D6. Verificación visual del loop (`src/orchestration/visualVerify.ts`, nuevo)
Dos verifiers componibles (encajan en `verifiers[]` de `RunAgentOpts`; `runVerifiers` ya agrega feedback y loguea evento `verify` por verdicto):
```ts
export function imageCompareVerifier(o: { render: string; reference: string; maxMeanDelta?: number /* default 2.0 = tolerancia check.sh */ }): Verifier;
export function vlmVisionVerifier(o: { render: string; reference?: string; instructions: string; provider?: Provider /* VLM del catálogo SPEC-11 */ }): Verifier;
```
- **Determinista** (`imageCompareVerifier`): parser PPM P3/P6 puro TS (el raytracer emite PPM — formato canónico del gate) + PNG por decodificador de metadatos propio y píxeles vía `magick compare` si está en PATH (fallback explícito, error accionable si no). Métrica: media $|\Delta|$ por canal + % de píxeles fuera de tolerancia + grid 3×3 de deltas por región. Feedback ejemplo: `media |Δ|=7.31 (tol 2.0) · 18% píxeles fuera · peor región: inferior-izquierda (|Δ|=21.4)` — señal accionable sin gastar tokens.
- **VLM** (`vlmVisionVerifier`) — *el verifier que VE*: arma un turno con render (+ referencia si hay) como `ContentPart[]` y pide veredicto con constrained decoding (`CompleteOpts.jsonSchema`): `{pass: boolean, diagnosis: string, differences: string[]}`. `pass:false` → `diagnosis` entra como feedback del loop ("falta la sombra suave bajo la esfera emisora; probable ausencia del término coseno") — el diagnóstico *semántico* que la métrica numérica no puede dar. Provider: flag `vision` del catálogo (SPEC-11) elige el VLM; tokens atribuidos al tier del verifier (SPEC-09).
- **CLI** (`src/cli.ts`, junto a `--verify-cmd` línea 187): `--verify-image <render>:<ref>[:<tol>]` (repetible) y `--verify-vlm "<instrucciones>" --verify-vlm-images <render>[,<ref>]`. **LoopSpec** (loopspec.ts, re-versiona por content-hash): campos `verifyImage: [{render, reference, tol?}]` y `verifyVlm: {instructions, images: string[]}` — un spec de fase del raytracer queda autocontenido.

Ejemplo de LoopSpec autocontenido para una fase del raytracer (`.aitl/loops/raytracer-f1.yaml`, versionado por content-hash como cualquier LoopSpec ADR-0062):
```yaml
name: raytracer-f1
maxIters: 12
maxVerifyRounds: 4
reflect: true
budgets: { ms: 3600000 }          # tope 60 min, alineado al protocolo del cap. 4
verifyCmd: "make && ./check.sh f1"
verifyImage:
  - { render: out/f1.ppm, reference: objective/ref_f1.ppm, tol: 2.0 }
verifyVlm:
  instructions: >
    Compara el render con la referencia de la escena 1L (esfera superior emisora).
    Si difieren: nombra la región, el fenómeno (sombra, energía, ruido) y la causa
    probable en el código del muestreador.
  images: [out/f1.ppm, objective/ref_f1.ppm]
```

#### D7. Flujo de la verificación visual (secuencia end-to-end)
1. El modelo termina un turno sin tool_calls → `runVerifiers` (graph.ts:426) ejecuta en orden: `verify_cmd` (check.sh, determinista) → `image_compare` (métrica numérica) → `vlm_vision` (diagnóstico semántico).
2. Cada verdicto emite su evento `verify` con payload propio: `{verifier: "image_compare", ok, mean_delta, worst_region}` / `{verifier: "vlm_vision", ok, diagnosis}` — la telemetría distingue QUÉ gate falló (medible por separado).
3. Fallo ⇒ feedback agregado `[image_compare] media |Δ|=7.31 … \n [vlm_vision] falta la sombra…` como user turn; con `reflect: true` el modelo diagnostica sin tools antes de tocar código (graph.ts:462).
4. `completed` exige TODOS verdes; el VLM nunca decide solo (riesgo 8): sin `check.sh` + `image_compare` en verde no hay éxito.
5. Al cierre, el render final se registra como artefacto (`source: "render"`, run_id) con caption del tier synthesize — la evidencia visual del cap. 4 queda enlazada al run, no suelta en disco.

#### D8. Entrada por CLI/chat
- `aitl run "<prompt>" --image <path>` (repetible) → `RunAgentOpts.images?: string[]` → partes imagen del primer user turn.
- `aitl chat`: `/image <path>` adjunta al siguiente turno; `@foto.png` en el prompt detecta extensión de imagen en `expandFileMentions` y adjunta parte (hoy adjuntaría el binario como texto); `/help` documenta ambos.
- MCP `run_agent`: parámetro zod nuevo `images: z.array(z.string()).optional()` (paths del lado del server).
```bash
aitl run "explica este bug visual" --project aitl-js --image docs/bug.png --model openrouter
aitl run "implementa la fase F1" --verify-cmd "make && ./check.sh f1" \
  --verify-image out/f1.ppm:objective/ref_f1.ppm:2.0 \
  --verify-vlm "¿coincide el render con la referencia? señala región y causa probable"
```
Config/env nuevos: `AITL_IMAGE_MAX_BYTES` (default 5242880), `AITL_IMAGE_CONVO_MAX` (default 4), `AITL_ARTIFACTS_DIR` (default `.aitl/artifacts`).

### Fases de implementación
- **F1 — Entrada** (`parts.ts` + `message.model` `parts` + adaptadores + flag `vision` + CLI/chat): entregable = `aitl run --image` y `/image` funcionando contra Anthropic y un VLM de OpenRouter/Chutes. Verifica: `npm run verify` (tests nuevos en `anthropic.messages.test.ts`/`openai.messages.test.ts`: parte imagen → bloque correcto; array descartado hoy → ahora preservado; degradación a caption sin `vision`); E2E vivo: `aitl run "¿qué hay en esta imagen?" --image test/fixtures/red-dot.png` responde el color.
- **F2 — Tools** (`RichToolResult` + `callRich` + `vision.ts` + `contentToParts` del cliente MCP + persistencia `parts` en graph.ts): entregable = `view_image`/`screenshot` operativas y tool results MCP con imagen ya no aplanados. Verifica: `npm run verify` (tests: registry compat `call→.text`, round-trip parts en tool message, `contentToParts` con InMemoryTransport); E2E: en `aitl chat`, `/call view_image {"path":"render.png"}` y preguntar "¿qué ves?" en el turno siguiente.
- **F3 — Memoria de artefactos** (`artifact.model` + `ArtifactStore` + captions al cierre + tools MCP `save_artifact`/`get_artifact` + web preview + sync): entregable = imágenes referenciadas por hash desde memoria con caption embebido. Verifica: `npm run verify` (canario RBAC de `save_artifact`, store content-addressed idempotente, degradación sin Mongo); E2E: `search_memory` recupera por caption una memoria con `aitl-artifact://` y la web la previsualiza.
- **F4 — Verificación visual** (`visualVerify.ts` + flags CLI + campos LoopSpec + loop-spec del raytracer): entregable = **el instrumento de medición**: corrida de fase del raytracer con gate determinista + verifier VLM. Verifica: `npm run verify` (fixtures PPM: idéntica→pass, corrida→feedback con región; VLM mockeado por Provider fake); E2E en el lab (`raytracer`, rama `curso`): `aitl run "implementa F1" --loop-spec .aitl/loops/raytracer-f1.yaml` termina `completed` solo con `check.sh` verde Y veredicto VLM registrado como eventos `verify`.

### ADRs a registrar
- «Multimodalidad aditiva: ContentPart en mensajes, adaptadores y capability `vision`» — proposed.
- «Artefactos visuales content-addressed referenciados desde memoria (caption textual, embeddings text-only)» — proposed.
- «Verificación visual del loop: métrica determinista de imagen + verifier VLM componible» — proposed.

### Medición para la tesis
- **Condición nueva en `tab:cond` (cap. 4): C2-vision** = C2 + `vlmVisionVerifier` activo sobre el render de la fase. Comparable celda-a-celda con C2 (gate solo textual `check.sh`).
- **Métricas** (en `tab:metrics` y el CSV `costo_pond, verify_1er, imagen_ok, …`): (a) `imagen_ok` pasa de juicio del script a dato del verifier (media $|\Delta|$ numérica persistida en el evento `verify`); (b) nueva `verify_rondas_visual`: rondas hasta gate verde con feedback visual semántico vs. dump textual de check.sh — hipótesis de trabajo: el diagnóstico del VLM reduce rondas; (c) costo del verifier (tokens VLM por ronda) atribuido por tier vía SPEC-09, entra a `costo_pond`.
- Capítulos: cap. 3 §loop (verifiers componibles ya diseñados — esta spec los instancia en visual), cap. 4 (condición/celda y gate), cap. 5 §division (el VLM verificador es otro eje de división de trabajo entre modelos). Bitácora IMPL y cifra de ADRs se actualizan vía SPEC-10.

### Riesgos y mitigaciones
1. **Costo en tokens de imágenes** (~1.1–1.6k tok por imagen 1024²): ventana rodante `AITL_IMAGE_CONVO_MAX` + degradación a caption; contabilidad por modelo en SPEC-09 antes de campañas.
2. **Modelo sin visión recibe partes** → error críptico del gateway: flag `vision` (capabilities + catálogo SPEC-11), degradación a caption con AVISO + evento + sugerencia de handoff; nunca silencioso.
3. **Tool role sin imágenes en OpenAI-compat**: reemisión determinista como user turn sintético marcado; test de round-trip fija el contrato.
4. **Resume/transcript**: imagen solo como `artifact_hash` en Mongo (jamás base64 — el schema no tiene campo `data`, así el doc de 16MB es imposible); artefacto perdido en disco degrada a caption; el fix del doble-user (SPEC-04) aplica igual a turnos con partes.
5. **Decodificar PNG sin dependencias**: PPM es el formato canónico del gate (el raytracer YA emite PPM P3); PNG completo delega en `magick compare` si existe, con error accionable — no se vendoriza un decoder.
6. **`screenshot` frágil por entorno** (trampas scrot/gamma documentadas en el lab): best-effort con cadena de backends, `requiresApproval`, error accionable.
7. **Costo de esquemas para modelos chicos** (~80% de ventana de un 7B en schemas): `view_image`/`screenshot` viven en el toolset perfil `vision` de SPEC-05, no en el default.
8. **Veredicto VLM no determinista contamina la métrica**: el gate que decide `completed` sigue siendo el determinista (`check.sh`/`imageCompareVerifier`); el VLM aporta *feedback*, y su acierto se mide, no se presume (C2-vision vs C2).

### Dependencias
- **SPEC-11 `modelcat`**: flag `vision` por modelo + protocolo de handoff (sugerir VLM al usuario).
- **SPEC-02 `tiering`**: el router elige el VLM del verifier y del caption (tier synthesize/design).
- **SPEC-05 `filetools`**: toolsets por perfil — las tools de visión entran al perfil `vision`.
- **SPEC-03 `sintesis`**: los captions se generan en la síntesis de cierre obligatoria.
- **SPEC-04 `cli`**: resume coherente (doble-user) precede al resume con partes; re-render del transcript muestra `[imagen: caption]`.
- **SPEC-09 `telemetry`**: precio por imagen/modelo para `costo_pond`.
- ADR-0070 (repomap) y AACL: no aplican.
