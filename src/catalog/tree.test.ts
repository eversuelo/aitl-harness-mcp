import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalogTree, renderCatalogTree, sortBranchRows } from "./tree.js";

const softwares = [
  { name: "aitl-js", display_name: "AITL", description: "harness", projects: ["aitl-js"] },
  { name: "schoolar", projects: ["schoolar-api", "schoolar-web"] },
];
const repos = [
  { project: "aitl-js", name: "AITL-Harness-JS", software: "aitl-js", remote: "git@x", branch: "master" },
  { project: "schoolar-api", name: "api" },
  { project: "orphan-proj", name: "solo-repo" },
];
const branches = [
  { project: "aitl-js", repo: "AITL-Harness-JS", name: "feat/harness-v2", kind: "feature", environment: "none", base: "master" },
  { project: "aitl-js", repo: "AITL-Harness-JS", name: "master", kind: "master", environment: "prod", protectedBranch: true },
];

test("buildCatalogTree groups software → project → repo → branch", () => {
  const tree = buildCatalogTree({ softwares, repos, branches, projects: ["loose-proj"] });
  assert.equal(tree.length, 3); // 2 softwares + orphan group
  assert.equal(tree[0].software?.name, "aitl-js");
  assert.equal(tree[0].projects[0].repos[0].repo.name, "AITL-Harness-JS");
  // trunks first
  assert.deepEqual(
    tree[0].projects[0].repos[0].branches.map((b) => b.name),
    ["master", "feat/harness-v2"],
  );
  const orphan = tree[2];
  assert.equal(orphan.software, null);
  assert.deepEqual(orphan.projects.map((p) => p.project).sort(), ["loose-proj", "orphan-proj"]);
});

test("projectFilter keeps only the matching project and drops empty groups", () => {
  const tree = buildCatalogTree({ softwares, repos, branches, projectFilter: "schoolar-api" });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].software?.name, "schoolar");
  assert.deepEqual(tree[0].projects.map((p) => p.project), ["schoolar-api"]);
});

test("softwareFilter keeps only the matching software group", () => {
  const tree = buildCatalogTree({ softwares, repos, branches, softwareFilter: "aitl-js" });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].software?.name, "aitl-js");
});

test("renderCatalogTree draws the hierarchy without ANSI when color is off", () => {
  const tree = buildCatalogTree({ softwares, repos, branches });
  const lines = renderCatalogTree(tree, { color: false });
  const text = lines.join("\n");
  assert.ok(text.includes("◆ AITL (software) — harness"));
  assert.ok(text.includes("└─ aitl-js (project)"));
  assert.ok(text.includes("AITL-Harness-JS (repo) git@x#master"));
  assert.ok(text.includes("master (master) [prod]"));
  assert.ok(text.includes("feat/harness-v2 (feature) ← master"));
  assert.ok(!text.includes("["), "no ANSI escapes without color");
});

test("renderCatalogTree adds ANSI escapes with color on and handles empty input", () => {
  const tree = buildCatalogTree({ softwares, repos, branches });
  assert.ok(renderCatalogTree(tree, { color: true }).join("\n").includes("["));
  const empty = renderCatalogTree([], {});
  assert.equal(empty.length, 1);
  assert.ok(empty[0].includes("catálogo vacío"));
});

test("sortBranchRows orders trunks before features", () => {
  const rows = sortBranchRows([
    { project: "p", repo: "r", name: "zeta", kind: "feature" },
    { project: "p", repo: "r", name: "develop", kind: "develop" },
    { project: "p", repo: "r", name: "main", kind: "main" },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["main", "develop", "zeta"]);
});
