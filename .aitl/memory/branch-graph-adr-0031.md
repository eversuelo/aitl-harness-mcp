---
name: branch-graph-adr-0031
description: >-
  ADR-0031: clasificación de ramas
  (main/master/develop/staging/release/hotfix/feature/other) + colección
  branches + grafo derives estilo GitHub.
type: reference
category: decision
tags:
  - adr-0031
  - session-2026-06-28
  - branches
  - 'component:src/branches'
  - 'component:src/util'
  - 'component:src/graph'
version: 1
updated_at: 2026-06-28T15:09:39.790Z
---
ADR-0031 (2026-06-28, verificado, 37 tests). Clasificador puro src/util/branches.ts classifyBranch(name,trunks) -> {kind, environment(prod/staging/dev/none), derivesFrom, protected}. Colección branches keyed (project,repo,name) con kind/environment/base/protectedBranch/head_sha/remote (src/branches/{schemas,store,sync}.ts). Sync git lee ramas locales, clasifica y detecta la base real por fork-point (src/util/git.ts: listLocalBranches/aheadCount/detectBaseBranch via 'git rev-list --count base..branch'), cae a la convención gitflow si no hay git. Superficie: MCP sync_branches/list_branches/delete_branch (recurso RBAC nuevo 'branches'), CLI aitl branch {sync,list,rm}, API GET /api/branches. Knowledge map: NodeKind +branch, EdgeKind +derives; buildKnowledgeGraph cuelga branch bajo su repo (contains) y traza derives (branch->base); UI con color/filtro/legend. Live: master(master)[prod] y ciclo-01/foundation(other)<-master (base por git). Pendiente del ciclo: el hook SessionStart (bloqueado por auto-mode) y, recomendado, guardar rutas de symbols RELATIVAS al root para que el repomap sea portable entre hosts (el usuario alterna Windows/Linux). Repomap re-indexado en Linux (912 símbolos, incluye dist/ = ruido; conviene --root src o ignorar dist).
