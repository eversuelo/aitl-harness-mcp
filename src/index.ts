/**
 * Public entry point / barrel for AITL-Harness-JS.
 *
 * Re-exports the stable surface so the package can be consumed as a library
 * (`import { runAgent, MemoryStore, getProvider } from "aitl-js"`).
 */

export { settings, getSettings } from "./config.js";
export * from "./contracts.js";
export {
  getDb,
  getClient,
  checkMongoConnection,
  closeClient,
  redactMongoUri,
  COLLECTIONS,
} from "./db/client.js";
export { initIndexes } from "./db/indexes.js";
export { MemoryStore } from "./memory/store.js";
export { Classifier } from "./memory/classifier.js";
export { Synthesizer } from "./memory/synthesizer.js";
export { hydrate, summarizeSession, TRIGGER_CATEGORIES } from "./memory/lifecycle.js";
export { getProvider, estimateTokens } from "./providers/base.js";
export type { Provider, ChatTurn } from "./providers/base.js";
export { runAgent } from "./orchestration/graph.js";
export { orchestrate } from "./orchestration/orchestrator.js";
export type { OrchestrateOpts, OrchestrateResult, SubAgentOutcome } from "./orchestration/orchestrator.js";
export { withRetry, isTransientError } from "./util/retry.js";
export { getHost, CliHostAdapter, HOST_SPECS } from "./hosts/base.js";
export type { HostAdapter, HostResult, HostRunOpts, CliHostSpec } from "./hosts/base.js";
export { runOnHost } from "./hosts/run.js";
export type { RunOnHostOpts, RunOnHostResult } from "./hosts/run.js";
export { ContextManager } from "./context/manager.js";
export { ToolRegistry, defaultRegistry } from "./tools/base.js";
export type { Tool } from "./tools/base.js";
export { RepoMap } from "./repomap/store.js";
export { ADRStore } from "./decisions/adr.js";
export { loadConventions } from "./conventions/loader.js";
export { getAdapter, loadCanon } from "./adapters/base.js";
export { buildServer } from "./mcpserver/server.js";
export { DefinitionStore } from "./projectctx/store.js";
export { routeSkills } from "./projectctx/router.js";
export type { RouteSkillsResult } from "./projectctx/router.js";
export {
  AGENTS_COLLECTION,
  SKILLS_COLLECTION,
  makeDefinitionRecord,
} from "./models/definition.model.js";
export type { DefinitionKind, DefinitionRecord } from "./models/definition.model.js";
