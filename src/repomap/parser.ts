/**
 * Extract definitions and references from source files via tree-sitter.
 *
 * Returns lightweight records: each definition is [name, kind], and each file carries
 * the set of identifier *references* it makes. The ranker uses defs+refs to build a
 * dependency graph. web-tree-sitter loads prebuilt `.wasm` grammars, so this
 * generalizes beyond any single language.
 *
 * NOTE: grammar `.wasm` files must be provided (see `loadLanguage`). Until they are
 * wired up, `parseFile` degrades gracefully to an empty FileSymbols (TODO: phase 2).
 */

import { promises as fs } from "node:fs";
import { extname, join } from "node:path";

// node types that denote a "definition" across common tree-sitter grammars
const DEF_NODE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "class_definition",
  "class_declaration",
  "type_declaration",
  "interface_declaration",
  "struct_specifier",
]);
const NAME_FIELDS = ["name", "declarator"];

export const EXT_LANG: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
};

export interface FileSymbols {
  file: string;
  defs: [string, string][]; // [name, kind]
  refs: Set<string>; // identifiers referenced
}

// Cache of loaded grammars, keyed by language name.
const grammarCache = new Map<string, unknown>();

/**
 * Load (and cache) a tree-sitter grammar for `lang`. Returns null if web-tree-sitter
 * or the grammar `.wasm` is unavailable — callers degrade gracefully.
 * TODO(phase 2): ship/resolve grammar wasm paths (e.g. tree-sitter-<lang>.wasm).
 */
async function loadLanguage(lang: string): Promise<unknown | null> {
  if (grammarCache.has(lang)) return grammarCache.get(lang)!;
  try {
    const { optionalImport } = await import("../util/optional.js");
    const Parser = (await optionalImport("web-tree-sitter")).default;
    await Parser.init();
    const grammarPath = process.env.AITL_GRAMMAR_DIR
      ? join(process.env.AITL_GRAMMAR_DIR, `tree-sitter-${lang}.wasm`)
      : `tree-sitter-${lang}.wasm`;
    const Language = await Parser.Language.load(grammarPath);
    grammarCache.set(lang, { Parser, Language });
    return grammarCache.get(lang)!;
  } catch {
    grammarCache.set(lang, null);
    return null;
  }
}

function nodeName(node: any, src: string): string | null {
  for (const f of NAME_FIELDS) {
    const child = node.childForFieldName(f);
    if (child) return src.slice(child.startIndex, child.endIndex);
  }
  return null;
}

export async function parseFile(path: string): Promise<FileSymbols> {
  const lang = EXT_LANG[extname(path)];
  const fsym: FileSymbols = { file: path, defs: [], refs: new Set() };
  if (!lang) return fsym;

  const loaded = (await loadLanguage(lang)) as { Parser: any; Language: any } | null;
  if (loaded === null) return fsym;

  const parser = new loaded.Parser();
  parser.setLanguage(loaded.Language);
  const src = await fs.readFile(path, "utf-8");
  const tree = parser.parse(src);

  const walk = (node: any): void => {
    if (DEF_NODE_TYPES.has(node.type)) {
      const name = nodeName(node, src);
      if (name) fsym.defs.push([name, node.type]);
    }
    if (["identifier", "type_identifier", "field_identifier"].includes(node.type)) {
      fsym.refs.add(src.slice(node.startIndex, node.endIndex));
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return fsym;
}

async function walkSources(root: string, exts: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(root, e.name);
    if (e.isDirectory()) out.push(...(await walkSources(full, exts)));
    else if (e.isFile() && exts.has(extname(e.name))) out.push(full);
  }
  return out;
}

export async function parseTree(root: string, exts?: string[]): Promise<FileSymbols[]> {
  const extSet = new Set(exts ?? Object.keys(EXT_LANG));
  const files = await walkSources(root, extSet);
  return Promise.all(files.map(parseFile));
}
