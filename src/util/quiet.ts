/**
 * CLI noise control — import FIRST from user-facing entrypoints.
 *
 * Mongoose 9 deprecates `Document.prototype.validateSync()` (used by every model
 * factory in src/models/*). The migration to async `validate()` is real debt, but the
 * repeated runtime DeprecationWarning interleaves with the chat spinner and wrecks the
 * REPL. Suppress deprecation warnings in the CLI process; they still show with
 * `node --trace-deprecation` when debugging.
 */
process.noDeprecation = true;

// Mongoose emits its deprecations with a CUSTOM warning type ("[MONGOOSE] Warning:"),
// which `noDeprecation` does not cover — filter it at the emitWarning source.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (text.includes("validateSync")) return;
  return (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
