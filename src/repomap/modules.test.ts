import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModuleKind, ModuleMap, SymbolRow } from "./modules.js";
import {
  ROOT_MODULE,
  aggregateModules,
  buildModuleBrief,
  classifyModuleKind,
  componentMatchesDir,
  renderModuleBrief,
  renderModuleMap,
} from "./modules.js";

/**
 * DB-free tests for the module map + module brief (P6): the classification heuristic
 * is pure, the aggregation core takes plain symbol rows, and the brief runs over the
 * injectable deps seam — no Mongo, no mocks of Mongoose needed.
 */

// ── classifyModuleKind: table of cases ────────────────────────────────────────

const CLASSIFY_CASES: { name: string; dir: string; files: string[]; overrides?: Record<string, ModuleKind>; want: ModuleKind }[] = [
  {
    name: "view by extension (.tsx/.css dominate)",
    dir: "app",
    files: ["app/App.tsx", "app/Nav.tsx", "app/main.css", "app/util.ts"],
    want: "view",
  },
  {
    name: "view by dir name even with neutral .ts files",
    dir: "web",
    files: ["web/api.ts", "web/util.ts"],
    want: "view",
  },
  {
    name: "back by path segments (server/db/models)",
    dir: "src",
    files: ["src/server/api.ts", "src/db/client.ts", "src/models/user.ts"],
    want: "back",
  },
  {
    name: "back as default for plain signal-less code",
    dir: "lib",
    files: ["lib/parse.ts", "lib/math.ts"],
    want: "back",
  },
  {
    name: "mixed when both sides carry weight (50/50)",
    dir: "src",
    files: ["src/server/api.ts", "src/db/client.ts", "src/components/App.tsx", "src/ui/nav.tsx"],
    want: "mixed",
  },
  {
    name: "one side >=70% of the signals decides (3 view vs 1 back)",
    dir: "src",
    files: ["src/components/a.tsx", "src/components/b.tsx", "src/views/c.tsx", "src/server/api.ts"],
    want: "view",
  },
  {
    name: "infra by top dir name (scripts/)",
    dir: "scripts",
    files: ["scripts/checkDb.ts", "scripts/initDb.ts"],
    want: "infra",
  },
  {
    name: "infra for dot-dirs (.github/)",
    dir: ".github",
    files: [".github/workflows/ci.yml"],
    want: "infra",
  },
  {
    name: "infra for loose root files ((root) module)",
    dir: ROOT_MODULE,
    files: ["vite.config.ts", "eslint.config.js"],
    want: "infra",
  },
  {
    name: "infra by name is NOT triggered by nested segments (src/config is code)",
    dir: "src/config",
    files: ["src/config/envfile.ts"],
    want: "back",
  },
  {
    name: "override always wins (declare a view dir as back)",
    dir: "web",
    files: ["web/App.tsx", "web/index.css"],
    overrides: { web: "back" },
    want: "back",
  },
  {
    name: "override keys are path-normalized (./scripts/ == scripts)",
    dir: "scripts",
    files: ["scripts/deploy.ts"],
    overrides: { "./scripts/": "view" },
    want: "view",
  },
];

for (const c of CLASSIFY_CASES) {
  test(`classifyModuleKind: ${c.name}`, () => {
    assert.equal(classifyModuleKind(c.dir, c.files, c.overrides ?? {}), c.want);
  });
}

// ── aggregation: first-level grouping, (root), top-by-pagerank ────────────────

const row = (file: string, name: string, pagerank = 0): SymbolRow => ({ file, name, pagerank });

test("aggregateModules groups by first-level dir; root files go to (root)", () => {
  const rows = [
    row("src/a.ts", "a", 0.1),
    row("src/deep/b.ts", "b", 0.2),
    row("web/App.tsx", "App", 0.3),
    row("vite.config.ts", "cfg", 0.05),
  ];
  const { modules, descendedInto } = aggregateModules(rows, {}, { descend: false });
  assert.equal(descendedInto, null);
  const names = modules.map((m) => m.module);
  assert.deepEqual(new Set(names), new Set(["src", "web", ROOT_MODULE]));
  const src = modules.find((m) => m.module === "src")!;
  assert.deepEqual(src.files, ["src/a.ts", "src/deep/b.ts"]);
  assert.equal(src.symbols, 2);
  const root = modules.find((m) => m.module === ROOT_MODULE)!;
  assert.equal(root.kind, "infra");
  assert.deepEqual(root.files, ["vite.config.ts"]);
});

test("aggregateModules: topSymbols are the top 5 by pagerank, symbols counted per module", () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => row("src/one.ts", `sym${i}`, i / 10)),
    row("src/two.ts", "hot", 9.9),
  ];
  const { modules } = aggregateModules(rows, {}, { descend: false });
  const src = modules.find((m) => m.module === "src")!;
  assert.equal(src.symbols, 8);
  assert.deepEqual(src.files, ["src/one.ts", "src/two.ts"]); // files are DISTINCT
  assert.equal(src.topSymbols.length, 5);
  assert.equal(src.topSymbols[0].name, "hot");
  assert.equal(src.topSymbols[0].file, "src/two.ts");
  // strictly non-increasing pagerank
  for (let i = 1; i < src.topSymbols.length; i++) {
    assert.ok(src.topSymbols[i - 1].pagerank >= src.topSymbols[i].pagerank);
  }
});

test("aggregateModules sorts modules by symbol count desc", () => {
  const rows = [row("a/x.ts", "x"), row("b/y.ts", "y"), row("b/z.ts", "z")];
  const { modules } = aggregateModules(rows, {}, { descend: false });
  assert.deepEqual(modules.map((m) => m.module), ["b", "a"]);
});

test("aggregateModules descends ONE level when one top dir holds >80% of the files", () => {
  const rows = [
    row("src/server/api.ts", "api", 0.5),
    row("src/server/ui.ts", "ui", 0.4),
    row("src/db/client.ts", "client", 0.3),
    row("src/models/user.ts", "user", 0.2),
    row("src/cli.ts", "cli", 0.9), // loose file directly under src → module "src"
    // 5 of 6 files under src/ (83%) → descend; web keeps its top-level module
    row("web/App.tsx", "App", 0.1),
  ];
  const { modules, descendedInto } = aggregateModules(rows);
  assert.equal(descendedInto, "src");
  const names = modules.map((m) => m.module);
  assert.deepEqual(new Set(names), new Set(["src/server", "src/db", "src/models", "src", "web"]));
  assert.equal(modules.find((m) => m.module === "src/server")!.kind, "back");
  assert.equal(modules.find((m) => m.module === "web")!.kind, "view");
});

test("aggregateModules does NOT descend below the dominance threshold", () => {
  const rows = [
    row("src/server/api.ts", "api"),
    row("src/db/client.ts", "client"),
    row("web/App.tsx", "App"),
    row("web/Nav.tsx", "Nav"),
  ];
  const { modules, descendedInto } = aggregateModules(rows);
  assert.equal(descendedInto, null);
  assert.deepEqual(new Set(modules.map((m) => m.module)), new Set(["src", "web"]));
});

test("renderModuleMap renders one row per module and the empty-map hint", () => {
  const rows = [row("src/server/api.ts", "api", 0.5), row("web/App.tsx", "App", 0.1)];
  const { modules, descendedInto } = aggregateModules(rows, {}, { descend: false });
  const map: ModuleMap = { project: "p", repo: null, branch: "main", stale: false, descendedInto, modules };
  const rendered = renderModuleMap(map);
  assert.match(rendered, /module\s+kind\s+files\s+symbols/);
  assert.match(rendered, /src\s+back\s+1\s+1\s+api/);
  assert.match(rendered, /web\s+view\s+1\s+1\s+App/);
  assert.match(renderModuleMap({ ...map, modules: [] }), /module map empty/);
});

// ── componentMatchesDir: prefix matching on whole segments ────────────────────

test("componentMatchesDir: exact, ancestor, subdir; never partial-segment", () => {
  assert.equal(componentMatchesDir("src/server", "src/server"), true, "exact");
  assert.equal(componentMatchesDir("src", "src/server"), true, "component is an ancestor of the dir");
  assert.equal(componentMatchesDir("src/server/routes", "src/server"), true, "component is a subdir of the dir");
  assert.equal(componentMatchesDir("src/serverx", "src/server"), false, "no partial segment match");
  assert.equal(componentMatchesDir("src/server", "src/serv"), false, "no partial segment match (dir side)");
  assert.equal(componentMatchesDir("web", "src/server"), false, "disjoint");
  assert.equal(componentMatchesDir("./src/server/", "src/server"), true, "normalization");
  assert.equal(componentMatchesDir("", "src"), false, "empty component");
});

// ── module brief over fake stores ─────────────────────────────────────────────

function fakeMap(modules: ModuleMap["modules"]): ModuleMap {
  return { project: "p", repo: null, branch: "main", stale: false, descendedInto: null, modules };
}

const SERVER_MODULE = {
  module: "src/server",
  kind: "back" as const,
  files: ["src/server/api.ts"],
  symbols: 3,
  topSymbols: [{ name: "createApi", file: "src/server/api.ts", pagerank: 0.9 }],
};

test("buildModuleBrief matches ADR components by prefix and EXCLUDES deprecated/superseded", async () => {
  const brief = await buildModuleBrief(
    { project: "p", dir: "src/server" },
    {
      loadModuleMap: async () => fakeMap([SERVER_MODULE]),
      listDecisions: async () => [
        { id: "0001", title: "REST", status: "accepted", components: ["src/server"], decision: "REST only.\nMore." },
        { id: "0002", title: "Ancestor tag", status: "accepted", components: ["src"], decision: "d" },
        { id: "0003", title: "Subdir tag", status: "proposed", components: ["src/server/routes"], decision: "d" },
        { id: "0004", title: "Deprecated", status: "deprecated", components: ["src/server"], decision: "d" },
        { id: "0005", title: "Superseded", status: "superseded", components: ["src/server"], decision: "d" },
        { id: "0006", title: "Other module", status: "accepted", components: ["web"], decision: "d" },
        { id: "0007", title: "No components", status: "accepted", components: [], decision: "d" },
      ],
      listComponentMemories: async () => [],
    },
  );
  assert.deepEqual(brief.adrs.map((a) => a.id), ["0001", "0002", "0003"]);
  assert.equal(brief.adrs[0].decision, "REST only."); // reduced to the first line
  assert.deepEqual(brief.modules, [SERVER_MODULE]);
});

test("buildModuleBrief matches memories via component:<dir> tags (same prefix rule)", async () => {
  const brief = await buildModuleBrief(
    { project: "p", dir: "src/server" },
    {
      loadModuleMap: async () => fakeMap([SERVER_MODULE]),
      listDecisions: async () => [],
      listComponentMemories: async () => [
        { slug: "sess-1", type: "session", description: "touched server", tags: ["component:src/server", "host:claude-code"] },
        { slug: "sess-2", type: "session", description: "subdir", tags: ["component:src/server/routes"] },
        { slug: "sess-3", type: "session", description: "other", tags: ["component:web/src"] },
        { slug: "sess-4", type: "session", description: "partial must not match", tags: ["component:src/serverx"] },
      ],
    },
  );
  assert.deepEqual(brief.memories.map((m) => m.slug), ["sess-1", "sess-2"]);
});

test("buildModuleBrief prefers the exact module block over ancestor/descendant blocks", async () => {
  const src = { ...SERVER_MODULE, module: "src", files: ["src/cli.ts"] };
  const brief = await buildModuleBrief(
    { project: "p", dir: "src/server" },
    {
      loadModuleMap: async () => fakeMap([src, SERVER_MODULE]),
      listDecisions: async () => [],
      listComponentMemories: async () => [],
    },
  );
  assert.deepEqual(brief.modules.map((m) => m.module), ["src/server"]);
});

test("renderModuleBrief: checklist when tagged; explicit suggestions when nothing is tagged", async () => {
  const tagged = await buildModuleBrief(
    { project: "p", dir: "src/server" },
    {
      loadModuleMap: async () => fakeMap([SERVER_MODULE]),
      listDecisions: async () => [
        { id: "0001", title: "REST", status: "accepted", components: ["src/server"], decision: "REST only." },
      ],
      listComponentMemories: async () => [
        { slug: "sess-1", type: "session", description: "touched server", tags: ["component:src/server"] },
      ],
    },
  );
  const renderedTagged = renderModuleBrief(tagged);
  assert.match(renderedTagged, /- \[ADR-0001\] REST \(accepted\) — REST only\./);
  assert.match(renderedTagged, /- sess-1 \[session\] — touched server/);
  assert.match(renderedTagged, /src\/server — back · 1 files · 3 symbols/);

  const empty = await buildModuleBrief(
    { project: "p", dir: "src/server" },
    { loadModuleMap: async () => fakeMap([]), listDecisions: async () => [], listComponentMemories: async () => [] },
  );
  const renderedEmpty = renderModuleBrief(empty);
  assert.match(renderedEmpty, /sin ADRs etiquetados/);
  assert.match(renderedEmpty, /record_decision \{ components: \["src\/server"\] \}/);
  assert.match(renderedEmpty, /sin memorias con tag component:/);
  assert.match(renderedEmpty, /no symbols for 'src\/server'/);
});
