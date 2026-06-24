/**
 * Optional dynamic import.
 *
 * Several backends (Transformers.js, web-tree-sitter, LangGraph, the Gemini SDK) are
 * `optionalDependencies`. We import them through this helper, which takes the module
 * specifier as a *non-literal* string so TypeScript resolves it to `any` and never
 * errors at compile time whether or not the package is installed. Callers handle the
 * runtime `ERR_MODULE_NOT_FOUND` and degrade gracefully.
 */
export function optionalImport(spec: string): Promise<any> {
  return import(spec);
}
