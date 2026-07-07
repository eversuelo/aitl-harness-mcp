# ADR-0021 — Empaquetado para instalación global (npm i -g) y rename a aitl-mcp

- **Status:** accepted
- **Date:** 2026-06-24

## Context

El objetivo es dejar el harness instalable y funcional en el sistema (npm i -g) con el comando 'aitl ui|mcp|repomap|...'. Había un bug bloqueante: tsconfig usa rootDir '.', así que el build sale en dist/src/cli.js, pero package.json apuntaba bin a ./dist/cli.js (archivo inexistente) → una instalación global dejaba un 'aitl' roto. Faltaba además declarar qué se publica.

## Decision

En package.json: (1) corregir bin → ./dist/src/cli.js (coincide con la salida real de tsc); (2) renombrar el paquete npm a 'aitl-mcp' (el binario sigue siendo 'aitl'); (3) añadir files:["dist"] para publicar solo el build; (4) añadir prepare:"npm run build" para que el build viaje en el tarball al publicar y se construya en 'npm i -g .' desde el checkout. El shebang en src/cli.ts ya existía. La configuración sin .env funciona vía 'aitl config set/show/path' → ~/.aitl/config.json (ADR 0006). NOTA: el nombre npm 'aitl-mcp' es distinto del project key del backend MCP, que sigue siendo 'aitl-js' (namespaces distintos).

## Consequences

Verificado: npm pack --dry-run incluye dist/src/cli.js como bin; npm install -g . instala 'aitl' en el PATH (AppData/Roaming/npm/aitl), aitl --version=0.1.0, aitl config path → ~/.aitl/config.json, y el cli.js global expone todos los comandos (ui, mcp, repomap, run-host, orchestrate, etc.). README actualizado a 'npm install -g aitl-mcp'. Pendiente menor: 'aitl --help' en un pipe/background de Git Bash se comportó raro (verificar en terminal real; --version y subcomandos salen bien). Deps muertas @google/genai y @anthropic-ai/sdk siguen en package.json (limpieza opcional).
