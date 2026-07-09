import assert from "node:assert/strict";
import { test } from "node:test";
import { AnsiMarkdownStream, renderMarkdownAnsi, styleInline } from "./markdown.js";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const GRAY = `${ESC}[90m`;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (s: string): string => renderMarkdownAnsi(s, { enabled: true });

// ── inline spans ──────────────────────────────────────────────────────────────

test("inline: bold, code and italic get their ANSI styles; text survives verbatim", () => {
  const out = render("a **negrita** y `código` y *cursiva*\n");
  assert.equal(stripAnsi(out), "a negrita y código y cursiva\n");
  assert.ok(out.includes(`${BOLD}negrita${RESET}`));
  assert.ok(out.includes(`${YELLOW}código${RESET}`));
});

test("inline: links render as text + dim url", () => {
  const out = render("ver [docs](https://x.y/z)\n");
  assert.equal(stripAnsi(out), "ver docs (https://x.y/z)\n");
  assert.ok(out.includes(`${CYAN}docs${RESET}`));
});

test("inline: unmatched markers stay literal", () => {
  assert.equal(stripAnsi(render("2 * 3 = 6 y un `tick suelto\n")), "2 * 3 = 6 y un `tick suelto\n");
  assert.equal(styleInline("sin *cierre"), "sin *cierre");
});

// ── blocks ────────────────────────────────────────────────────────────────────

test("headers: hashes stripped, h1/h2 bold+cyan, h3 bold", () => {
  const h1 = render("# Título\n");
  assert.equal(stripAnsi(h1), "Título\n");
  assert.ok(h1.includes(BOLD + CYAN));
  const h3 = render("### Sección\n");
  assert.equal(stripAnsi(h3), "Sección\n");
  assert.ok(h3.includes(BOLD));
});

test("lists: bullets become • and ordered keeps its number; indentation survives", () => {
  const out = render("- uno\n  - dos\n1. tres\n");
  assert.equal(stripAnsi(out), "• uno\n  • dos\n1. tres\n");
});

test("blockquote: dim content behind a │ gutter", () => {
  const out = render("> cita\n");
  assert.equal(stripAnsi(out), "│ cita\n");
  assert.ok(out.includes(DIM));
});

test("horizontal rule renders as a ─ line", () => {
  assert.equal(stripAnsi(render("---\n")), "─".repeat(3) + "\n");
});

test("fences: markers gray, code content byte-exact and never inline-styled", () => {
  const out = render("```ts\nconst a = \"**no bold**\";\n```\n");
  const plain = stripAnsi(out);
  assert.equal(plain, "```ts\nconst a = \"**no bold**\";\n```\n");
  // the ** inside the fence must NOT have been converted to a bold span
  assert.ok(out.includes('const a = "**no bold**";'));
  assert.ok(out.includes(`${GRAY}\`\`\``));
});

test("table pipes get the gray accent, cell text survives", () => {
  const out = render("| a | b |\n");
  assert.equal(stripAnsi(out), "| a | b |\n");
  assert.ok(out.includes(`${GRAY}|${RESET}`));
});

// ── streaming ─────────────────────────────────────────────────────────────────

test("streaming: char-by-char equals one-shot (modulo ANSI chunking)", () => {
  const text = "# Hola\n\ntexto **fuerte** y `code`.\n\n- item *it*\n> quote\n```js\n1*2\n```\nfin [l](http://a)\n";
  const stream = new AnsiMarkdownStream({ enabled: true });
  let streamed = "";
  for (const ch of text) streamed += stream.push(ch);
  streamed += stream.flush();
  assert.equal(stripAnsi(streamed), stripAnsi(render(text)));
});

test("streaming: plain prose is emitted before the newline arrives", () => {
  const stream = new AnsiMarkdownStream({ enabled: true });
  const out = stream.push("hola mundo sin cerrar la línea");
  assert.equal(stripAnsi(out), "hola mundo sin cerrar la línea");
});

test("streaming: an open bold span is held, then styled when it closes", () => {
  const stream = new AnsiMarkdownStream({ enabled: true });
  const first = stream.push("antes **negri");
  assert.equal(stripAnsi(first), "antes ");
  const second = stream.push("ta** después");
  assert.ok(second.includes(`${BOLD}negrita${RESET}`));
  assert.equal(stripAnsi(first + second), "antes negrita después");
});

test("streaming: fence state survives across pushes", () => {
  const stream = new AnsiMarkdownStream({ enabled: true });
  let out = stream.push("```\ncode **raw**\n");
  out += stream.push("```\nya **fuera**\n");
  out += stream.flush();
  assert.ok(out.includes("code **raw**"), "inside the fence ** stays literal");
  assert.ok(out.includes(`${BOLD}fuera${RESET}`), "after the fence inline styling resumes");
});

test("flush renders held markers literally", () => {
  const stream = new AnsiMarkdownStream({ enabled: true });
  const a = stream.push("cola **abierta");
  const b = stream.flush();
  assert.equal(stripAnsi(a + b), "cola **abierta");
});

test("disabled: push/flush are identity/empty (piped output stays clean)", () => {
  const stream = new AnsiMarkdownStream({ enabled: false });
  const text = "# raw **md**\n";
  assert.equal(stream.push(text), text);
  assert.equal(stream.flush(), "");
  assert.equal(renderMarkdownAnsi(text, { enabled: false }), text);
});
