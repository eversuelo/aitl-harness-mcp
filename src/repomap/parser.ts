/**
 * Extract definitions and references from source files via tree-sitter.
 *
 * Returns rich records (repo map v2, F1 — ADR-0070): each definition carries its
 * name, kind, line range, enclosing class (`parent`), export status, trimmed
 * signature and the doc comment written right above it. Each file also carries the
 * set of identifier *references* it makes; the ranker uses defs+refs to build a
 * dependency graph. web-tree-sitter loads prebuilt `.wasm` grammars, so this
 * generalizes beyond any single language.
 *
 * NOTE: grammar `.wasm` files give the most accurate parse (see `loadLanguage`). When
 * they are unavailable, `parseFile` falls back to a scope-aware line scanner
 * (`parseFileHeuristic`) so the repo map still works offline (notably for this TS repo).
 */

import { promises as fs } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

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

// Collapse tree-sitter node types to the same kind vocabulary the heuristic emits.
const NODE_KIND: Record<string, string> = {
  function_definition: "function",
  function_declaration: "function",
  method_definition: "method",
  class_definition: "class",
  class_declaration: "class",
  type_declaration: "type",
  interface_declaration: "interface",
  struct_specifier: "struct",
};

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

/** One definition, with the metadata the impact/brief layers need (plan v2, F1). */
export interface SymbolDef {
  name: string;
  kind: string; // function | class | interface | type | enum | const | method | property | struct
  line_start: number; // 1-based, inclusive
  line_end: number; // 1-based, inclusive; equals line_start for braceless defs
  parent: string | null; // enclosing class name for method/property
  exported: boolean; // part of the module's API (methods inherit the class's flag)
  signature: string; // trimmed first line of the definition
  doc: string | null; // doc comment written right above the definition, cleaned
}

export interface FileSymbols {
  file: string;
  defs: SymbolDef[];
  refs: Set<string>; // identifiers referenced
}

const SIGNATURE_MAX = 160;
const DOC_MAX = 600;

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

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "interface", "type", "enum", "return", "if",
  "else", "for", "while", "switch", "case", "break", "continue", "new", "await", "async",
  "import", "export", "default", "from", "as", "extends", "implements", "this", "super",
  "true", "false", "null", "undefined", "void", "typeof", "instanceof", "in", "of", "try",
  "catch", "finally", "throw", "yield", "static", "public", "private", "protected", "readonly",
]);

// Words that look like `name(` at class-body depth but are NOT method definitions.
// `constructor` is excluded on purpose: every class has one and it never names an API.
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "return", "new", "do", "else", "function", "typeof", "await", "constructor"]);

/**
 * Blank out comments and string/template literals, preserving line structure so
 * line numbers and brace depth stay accurate. `#`-comments are stripped only for
 * hash-comment languages (python/ruby) — `#` is a private-field prefix in TS.
 */
export function stripCommentsAndStrings(src: string, lang?: string): string {
  const hashComments = lang === "python" || lang === "ruby";
  const out: string[] = [];
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let st: State = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "\n") {
      if (st === "line" || st === "single" || st === "double") st = "code"; // strings don't span lines
      out.push("\n");
      continue;
    }
    switch (st) {
      case "code":
        if (c === "/" && next === "/") { st = "line"; out.push(" "); }
        else if (c === "/" && next === "*") { st = "block"; out.push(" "); }
        else if (hashComments && c === "#") { st = "line"; out.push(" "); }
        else if (c === "'") { st = "single"; out.push(" "); }
        else if (c === '"') { st = "double"; out.push(" "); }
        else if (c === "`") { st = "template"; out.push(" "); }
        else out.push(c);
        break;
      case "line":
        out.push(" ");
        break;
      case "block":
        if (c === "*" && next === "/") { st = "code"; out.push("  "); i++; }
        else out.push(" ");
        break;
      case "single":
        if (c === "\\") { out.push("  "); i++; }
        else if (c === "'") st = "code", out.push(" ");
        else out.push(" ");
        break;
      case "double":
        if (c === "\\") { out.push("  "); i++; }
        else if (c === '"') st = "code", out.push(" ");
        else out.push(" ");
        break;
      case "template":
        if (c === "\\") { out.push("  "); i++; }
        else if (c === "`") st = "code", out.push(" ");
        else out.push(c === "\n" ? "\n" : " ");
        break;
    }
  }
  return out.join("");
}

/**
 * Doc comment written right above line `i` (0-based): a JSDoc/block comment, or a
 * contiguous run of `//` (or `#`) lines. Decorator lines (`@x`) between the doc and
 * the definition are skipped. Cleaned of comment markers, capped at DOC_MAX chars.
 */
function docAbove(rawLines: string[], i: number, hashComments: boolean): string | null {
  let j = i - 1;
  while (j >= 0 && /^\s*@[\w.]+/.test(rawLines[j])) j--; // skip decorators
  if (j < 0) return null;
  const collected: string[] = [];
  if (/\*\/\s*$/.test(rawLines[j])) {
    // walk back to the opening /* (bounded so a stray */ can't scan the whole file)
    let k = j;
    while (k >= 0 && !/\/\*/.test(rawLines[k]) && j - k < 60) k--;
    if (k < 0 || !/\/\*/.test(rawLines[k])) return null;
    for (let l = k; l <= j; l++) collected.push(rawLines[l]);
  } else {
    const lineRe = hashComments ? /^\s*#(.*)$/ : /^\s*\/\/(.*)$/;
    let k = j;
    while (k >= 0 && lineRe.test(rawLines[k])) k--;
    if (k === j) return null;
    for (let l = k + 1; l <= j; l++) collected.push(rawLines[l]);
  }
  const text = collected
    .map((l) => l.replace(/^\s*\/\*+/, "").replace(/\*+\/\s*$/, "").replace(/^\s*\*\s?/, "").replace(/^\s*(\/\/|#)\s?/, ""))
    .join("\n")
    .trim();
  if (!text) return null;
  return text.length > DOC_MAX ? `${text.slice(0, DOC_MAX)}…` : text;
}

// Top-level definition patterns (anchored to line start), shared across languages.
const LINE_DEFS: [RegExp, string, boolean][] = [
  // [pattern, kind, opensBlock]
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class", true],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function", true],
  [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface", true],
  [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, "type", false],
  [/^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum", true],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^;{]*\)|[A-Za-z_$][\w$]*)\s*=>/, "const", true],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/, "function", false], // python (indent blocks)
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/, "function", true], // go
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/, "function", true], // rust
];

// Class members (matched only at the class body's exact brace depth).
const METHOD_RE = /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async)\s+)*(?:get\s+|set\s+|\*\s*)?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const PROPERTY_RE = /^\s*(?:(?:public|private|protected|static|readonly|abstract|override)\s+)*([A-Za-z_$#][\w$]*)\??\s*[:=]/;

/**
 * Scope-aware line scanner used when a tree-sitter grammar is unavailable (repo map
 * v2, F1). Tracks brace depth and the enclosing class, so class methods/properties
 * become symbols with `parent`, every definition gets a line range + signature, and
 * the doc comment above each definition is captured as its `doc` metadata.
 */
async function parseFileHeuristic(path: string): Promise<FileSymbols> {
  const fsym: FileSymbols = { file: path, defs: [], refs: new Set() };
  let src: string;
  try {
    src = await fs.readFile(path, "utf-8");
  } catch {
    return fsym;
  }
  const lang = EXT_LANG[extname(path)];
  const hashComments = lang === "python" || lang === "ruby";
  const rawLines = src.split("\n");
  const codeLines = stripCommentsAndStrings(src, lang).split("\n");

  const seen = new Set<string>(); // `${parent ?? ""}.${name}` — dedupe within the file
  const openDefs: { def: SymbolDef; bodyDepth: number }[] = [];
  const classStack: { name: string; bodyDepth: number; exported: boolean }[] = [];
  let depth = 0;
  let parenDepth = 0; // open `(`s — the body `{` of a pending def only counts once these close
  // A def whose `{` may arrive on a later line; the next brace outside parens claims it.
  let pending: { def: SymbolDef; isClass: boolean; exported: boolean } | null = null;

  const addDef = (def: SymbolDef): void => {
    const key = `${def.parent ?? ""}${def.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    fsym.defs.push(def);
  };

  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i];
    const raw = rawLines[i] ?? "";
    if (code.trim()) {
      const inClass = classStack.length > 0 && classStack[classStack.length - 1].bodyDepth === depth
        ? classStack[classStack.length - 1]
        : null;
      const exported = /^\s*export\b/.test(raw);
      const signature = raw.trim().slice(0, SIGNATURE_MAX);
      const doc = docAbove(rawLines, i, hashComments);
      let matched: { def: SymbolDef; isClass: boolean; opensBlock: boolean } | null = null;

      for (const [re, kind, opensBlock] of LINE_DEFS) {
        const m = code.match(re);
        if (!m?.[1]) continue;
        matched = {
          def: { name: m[1], kind, line_start: i + 1, line_end: i + 1, parent: null, exported, signature, doc },
          isClass: kind === "class",
          opensBlock,
        };
        break;
      }
      if (!matched && inClass) {
        const m = code.match(METHOD_RE);
        if (m?.[1] && !NOT_METHOD.has(m[1])) {
          matched = {
            def: { name: m[1], kind: "method", line_start: i + 1, line_end: i + 1, parent: inClass.name, exported: inClass.exported, signature, doc },
            isClass: false,
            opensBlock: true,
          };
        } else {
          const p = code.match(PROPERTY_RE);
          if (p?.[1] && !JS_KEYWORDS.has(p[1])) {
            matched = {
              def: { name: p[1], kind: "property", line_start: i + 1, line_end: i + 1, parent: inClass.name, exported: inClass.exported, signature, doc },
              isClass: false,
              opensBlock: false,
            };
          }
        }
      }
      if (matched) {
        addDef(matched.def);
        pending = matched.opensBlock ? { def: matched.def, isClass: matched.isClass, exported: matched.def.exported } : null;
      }
    }

    for (const ch of code) {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "{") {
        depth++;
        // Braces inside a parameter list (type literals, `= {}` defaults) are not the body.
        if (pending && parenDepth === 0) {
          openDefs.push({ def: pending.def, bodyDepth: depth });
          if (pending.isClass) classStack.push({ name: pending.def.name, bodyDepth: depth, exported: pending.exported });
          pending = null;
        }
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        while (openDefs.length && openDefs[openDefs.length - 1].bodyDepth > depth) {
          openDefs.pop()!.def.line_end = i + 1;
        }
        while (classStack.length && classStack[classStack.length - 1].bodyDepth > depth) classStack.pop();
      }
    }
  }
  // EOF: close anything still open (unbalanced braces / template-literal noise).
  for (const o of openDefs) o.def.line_end = rawLines.length;

  const codeAll = codeLines.join("\n");
  for (const m of codeAll.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!JS_KEYWORDS.has(m[0])) fsym.refs.add(m[0]);
  }
  return fsym;
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
  // No tree-sitter grammar wired up → fall back to the scope-aware scanner instead of giving up.
  if (loaded === null) return parseFileHeuristic(path);

  const parser = new loaded.Parser();
  parser.setLanguage(loaded.Language);
  const src = await fs.readFile(path, "utf-8");
  const tree = parser.parse(src);
  const lineOf = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
    return line;
  };

  const walk = (node: any, parentClass: string | null): void => {
    let nextParent = parentClass;
    if (DEF_NODE_TYPES.has(node.type)) {
      const name = nodeName(node, src);
      if (name) {
        const kind = NODE_KIND[node.type] ?? node.type;
        const firstLine = src.slice(node.startIndex, node.endIndex).split("\n")[0].trim().slice(0, SIGNATURE_MAX);
        fsym.defs.push({
          name,
          kind,
          line_start: lineOf(node.startIndex),
          line_end: lineOf(node.endIndex),
          parent: kind === "method" ? parentClass : null,
          exported: false, // not derivable generically from the grammar; the heuristic path covers TS/JS
          signature: firstLine,
          doc: null,
        });
        if (kind === "class") nextParent = name;
      }
    }
    if (["identifier", "type_identifier", "field_identifier"].includes(node.type)) {
      fsym.refs.add(src.slice(node.startIndex, node.endIndex));
    }
    for (const child of node.children) walk(child, nextParent);
  };
  walk(tree.rootNode, null);
  return fsym;
}

/**
 * Load `<root>/.gitignore` (if present) into an `ignore()` matcher so the walk skips
 * anything git ignores (e.g. `dist/`, `logs/`). Returns null when there is no
 * `.gitignore` — callers then fall back to the baseline `.git`/`node_modules` skip.
 */
async function loadIgnore(root: string): Promise<Ignore | null> {
  try {
    const spec = await fs.readFile(join(root, ".gitignore"), "utf-8");
    return ignore().add(spec);
  } catch {
    return null; // no .gitignore → only the baseline skip applies
  }
}

/**
 * Recursively collect source files under `dir`. Skips `.git`/`node_modules` (baseline,
 * covers the no-`.gitignore` case) and anything the `ignore()` matcher rejects, matched
 * on the path relative to `root` (where `.gitignore` lives). `ignore` wants POSIX-style,
 * root-relative paths, and a trailing "/" so directory patterns like `dist/` match.
 */
async function walkDir(dir: string, root: string, exts: Set<string>, ig: Ignore | null): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    const rel = relative(root, full).split(sep).join("/"); // POSIX, root-relative
    if (ig && rel && ig.ignores(e.isDirectory() ? `${rel}/` : rel)) continue;
    if (e.isDirectory()) out.push(...(await walkDir(full, root, exts, ig)));
    else if (e.isFile() && exts.has(extname(e.name))) out.push(full);
  }
  return out;
}

async function walkSources(root: string, exts: Set<string>): Promise<string[]> {
  const ig = await loadIgnore(root);
  return walkDir(root, root, exts, ig);
}

export async function parseTree(root: string, exts?: string[]): Promise<FileSymbols[]> {
  const extSet = new Set(exts ?? Object.keys(EXT_LANG));
  const files = await walkSources(root, extSet);
  return Promise.all(files.map(parseFile));
}
