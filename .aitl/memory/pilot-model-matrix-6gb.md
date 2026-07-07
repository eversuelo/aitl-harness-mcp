---
name: pilot-model-matrix-6gb
description: >-
  Matriz de modelos locales para el piloto de tesis en RTX 4050 (6GB VRAM / 16GB
  RAM) + settings de LM Studio
type: reference
category: decision
tags:
  - pilot
  - lmstudio
  - models
  - hardware
  - thesis
version: 1
updated_at: 2026-07-02T17:36:00.626Z
branch: master
---
Matriz experimental de modelos locales (2026-07-02) para RTX 4050 6GB VRAM / 16GB RAM, Ubuntu + LM Studio. Mismo harness, mismas tareas T1/T3, condiciones C0/C2 — el MODELO es el factor.

| Rol en la matriz | Modelo | Nota |
|---|---|---|
| Control (verificado E2E, ADR-0043) | google/gemma-4-e4b | tool calling OK, ya corrió el loop |
| Worker/coder principal | Qwen2.5-Coder-7B-Instruct Q4_K_M (~4.68GB) | el mejor en JSON estricto + tool calling; CUIDADO: la variante "itlwas" es el modelo BASE (sin instruct) — no usar |
| Razonador | deepseek-r1-0528-qwen3-8b (4.43GB) | ver [[deepseek-r1-distill-findings]]: NO hace tool calling; solo sirve para sdd/decompose/síntesis |
| Orquestador | Nemotron Orchestrator 8B | preferir Q4_K_S sobre Q3_K_M (Q3 degrada mucho un 8B) |
| Baseline citable | Llama-3.1-8B-Instruct Q4_K_M (4.92GB) | referencia estándar en papers; contexto justo (ver fórmula) |
| Worker pequeño / subagentes concurrentes | Qwen3-4B-Instruct-2507 (~2.5GB) | cabe entero + ~32k ctx; ideal para orchestrate con paralelismo |

**Settings LM Studio en 6GB**: Flash Attention ON, KV cache Q8_0 (K y V), GPU offload máximo, context 8192 (y LMSTUDIO_MAX_CONTEXT=8192 en el harness para que ContextManager compacte a tiempo).

**Fórmula de contexto útil en 6GB**: ctx ≈ (6GB − peso_GGUF − 0.5GB overhead) / 64KB·token (KV Q8). Ej. Llama-3.1-8B Q4 (4.92GB): ~8-10k con KV Q8, ~4-5k en FP16. KV de Llama-3.1-8B: 128KB/token FP16 (32 capas × 8 KV heads GQA × 128 dim).

**Racional de tesis**: cuanto más débil el modelo, más medible el efecto del harness (C0 --bare vs C2); modelos locales = costo cero + reproducible, desbloquea el piloto sin OPENROUTER_API_KEY.

**Gotcha recurrente**: el daemon de LM Studio (:41343) NO sirve /v1 — hay que `lms server start` (puerto 1234). En Linux lms está en ~/.lmstudio/bin/lms.
