import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mock, test } from "node:test";
import { mongoose } from "../db/mongoose.js";
import { SymbolModel } from "../models/symbol.model.js";
import { parseTree } from "./parser.js";
import { RepoMap } from "./store.js";

/**
 * DB-free tests for the repo map. The parser tests use a real temp fixture dir; the
 * `build` tests run against a temp git repo and stub the Mongoose layer (mirrors
 * `auth/users.test.ts`): `mongoose.connect` so `ensureMongoose()` resolves without a
 * real Atlas connection, and the SymbolModel collection methods backed by a local
 * in-memory array so incremental writes/prunes can be asserted on.
 */

/** Create a temp source tree with a `dist/`-ignored dir. Returns the root path. */
async function makeFixture(opts: { git?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "aitl-repomap-"));
  await fs.writeFile(join(root, ".gitignore"), "dist/\nlogs/\n");
  await fs.mkdir(join(root, "src"), { recursive: true });
  await fs.writeFile(join(root, "src", "keep.ts"), "export function keptFn() { return other(); }\n");
  await fs.writeFile(join(root, "src", "other.ts"), "export function other() { return 1; }\n");
  // Build output that .gitignore excludes — must NOT be indexed.
  await fs.mkdir(join(root, "dist"), { recursive: true });
  await fs.writeFile(join(root, "dist", "bundled.ts"), "export function shouldBeSkipped() { return 2; }\n");
  if (opts.git) {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run(["init", "-q"]);
    run(["checkout", "-q", "-b", "feat/testbranch"]);
    run(["config", "user.email", "t@t.co"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
  }
  return root;
}

/**
 * Stub the Mongoose layer with an in-memory `symbols` collection so the incremental
 * build (find + per-file deleteMany + insertMany + bulkWrite) can run without Atlas.
 */
function stubSymbolModel(): { store: Record<string, unknown>[]; restore: () => void } {
  const store: Record<string, unknown>[] = [];
  const matches = (d: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (v !== null && typeof v === "object" && "$in" in (v as Record<string, unknown>)) {
        if (!((v as { $in: unknown[] }).$in.includes(d[k]))) return false;
      } else if (d[k] !== v && !(d[k] == null && v == null)) return false;
    }
    return true;
  };
  mock.method(mongoose, "connect", (async () => mongoose) as never);
  mock.method(SymbolModel, "find", ((filter: Record<string, unknown>) => ({
    lean: async () => store.filter((d) => matches(d, filter)).map((d) => ({ ...d })),
  })) as never);
  mock.method(SymbolModel, "deleteMany", (async (filter: Record<string, unknown>) => {
    const keep = store.filter((d) => !matches(d, filter));
    const deleted = store.length - keep.length;
    store.length = 0;
    store.push(...keep);
    return { deletedCount: deleted };
  }) as never);
  mock.method(SymbolModel, "insertMany", (async (docs: Record<string, unknown>[]) => {
    store.push(...docs);
    return docs;
  }) as never);
  mock.method(SymbolModel, "bulkWrite", (async (ops: { updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } } }[]) => {
    for (const op of ops) {
      for (const d of store) if (matches(d, op.updateOne.filter)) Object.assign(d, op.updateOne.update.$set);
    }
    return { modifiedCount: ops.length };
  }) as never);
  return { store, restore: () => mock.restoreAll() };
}

test("parseTree excludes files under a .gitignore'd dir (dist/)", async () => {
  const root = await makeFixture();
  try {
    const files = await parseTree(root, [".ts"]);
    const rels = files.map((f) => f.file);
    // dist/bundled.ts is ignored; src files are kept.
    assert.ok(rels.some((f) => f.endsWith(join("src", "keep.ts"))), "src/keep.ts should be indexed");
    assert.ok(rels.some((f) => f.endsWith(join("src", "other.ts"))), "src/other.ts should be indexed");
    assert.ok(!rels.some((f) => f.endsWith("bundled.ts")), "dist/bundled.ts must be excluded");
    assert.equal(files.some((f) => f.defs.some((d) => d.name === "shouldBeSkipped")), false, "dist/ defs must not be parsed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rich symbols (F1): methods get parent+lines, defs get doc comment / exported / signature", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "aitl-repomap-rich-"));
  try {
    await fs.writeFile(join(root, "calc.ts"), [
      "/** Sums two numbers. */",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export class Calc {",
      "  total = 0;",
      "  /** Adds x to the running total. */",
      "  add(x: number): number {",
      "    this.total += x;",
      "    return this.total;",
      "  }",
      "}",
      "",
    ].join("\n"));
    const [file] = await parseTree(root, [".ts"]);
    const byKey = new Map(file.defs.map((d) => [`${d.parent ?? ""}.${d.name}`, d]));

    const addFn = byKey.get(".add")!;
    assert.equal(addFn.kind, "function");
    assert.equal(addFn.exported, true);
    assert.equal(addFn.doc, "Sums two numbers.");
    assert.equal(addFn.line_start, 2);
    assert.equal(addFn.line_end, 4);
    assert.ok(addFn.signature.startsWith("export function add("));

    const cls = byKey.get(".Calc")!;
    assert.equal(cls.kind, "class");
    assert.equal(cls.line_start, 6);
    assert.equal(cls.line_end, 13);

    const method = byKey.get("Calc.add")!;
    assert.equal(method.kind, "method");
    assert.equal(method.parent, "Calc");
    assert.equal(method.exported, true, "methods inherit the class's exported flag");
    assert.equal(method.doc, "Adds x to the running total.");
    assert.equal(method.line_start, 9);
    assert.equal(method.line_end, 12);

    const prop = byKey.get("Calc.total")!;
    assert.equal(prop.kind, "property");
    assert.equal(prop.parent, "Calc");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("build stores RELATIVE file paths (portable keys) and rich fields", async () => {
  const root = await makeFixture();
  const { store, restore } = stubSymbolModel();
  try {
    const n = await new RepoMap().build(root, "p");
    assert.ok(n > 0, "should index at least one symbol");
    for (const d of store) {
      const file = d.file as string;
      assert.ok(!isAbsolute(file), `file must be relative, got: ${file}`);
      assert.ok(!file.startsWith("dist"), `dist/ symbols must not be stored, got: ${file}`);
    }
    // keptFn lives at the portable path src/keep.ts, with v2 metadata stamped.
    const kept = store.find((d) => d.name === "keptFn")!;
    assert.equal(kept.file, join("src", "keep.ts"));
    assert.equal(kept.exported, true);
    assert.equal(kept.line_start, 1);
    assert.ok((kept.signature as string).includes("keptFn"));
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("build stamps the current git branch on every symbol", async () => {
  const root = await makeFixture({ git: true });
  const { store, restore } = stubSymbolModel();
  try {
    await new RepoMap().build(root, "p");
    assert.ok(store.length > 0);
    for (const d of store) assert.equal(d.branch, "feat/testbranch");
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rebuild keeps a CONSTANT symbol count and does not rewrite unchanged files", async () => {
  const root = await makeFixture();
  const { store, restore } = stubSymbolModel();
  try {
    const rm = new RepoMap();
    const first = await rm.build(root, "p");
    assert.equal(rm.lastStats?.files_written, rm.lastStats?.files_scanned, "first build writes everything");
    const countAfterFirst = store.length;
    const second = await rm.build(root, "p");
    // Same inputs → same count, one snapshot (no doubling), and zero rewrites (mtime cache).
    assert.equal(second, first);
    assert.equal(store.length, countAfterFirst);
    assert.equal(rm.lastStats?.files_written, 0);
    assert.equal(rm.lastStats?.files_pruned, 0);
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("build prunes symbols of files deleted from disk (limpieza de huérfanos)", async () => {
  const root = await makeFixture();
  const { store, restore } = stubSymbolModel();
  try {
    const rm = new RepoMap();
    await rm.build(root, "p");
    assert.ok(store.some((d) => (d.file as string).endsWith("other.ts")));
    await fs.rm(join(root, "src", "other.ts"));
    await rm.build(root, "p");
    assert.equal(rm.lastStats?.files_pruned, 1);
    assert.ok(!store.some((d) => (d.file as string).endsWith("other.ts")), "stale symbols must be pruned");
    assert.ok(store.some((d) => d.name === "keptFn"), "surviving files keep their symbols");
  } finally {
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
