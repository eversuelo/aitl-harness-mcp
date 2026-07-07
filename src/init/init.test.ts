/**
 * Tests for `aitl init` (P5/F1): the conservative merge helpers and the orchestrator's
 * idempotency. No Mongo — the orchestrator runs over fake InitServices and a temp fs.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeClaudeSettings, mergeGuideSection, mergeMcpJson, mergePostMergeHook } from "./merge.js";
import { type InitServices, initRepo } from "./initRepo.js";

// ── fakes ─────────────────────────────────────────────────────────────────────

function fakeServices() {
  const state = {
    softwares: new Map<string, Record<string, unknown>>(),
    repos: new Map<string, Record<string, unknown>>(),
    branches: new Map<string, { name: string }[]>(),
    symbols: new Map<string, number>(),
    skills: new Set<string>(),
    roles: new Set<string>(),
  };
  const skillNames = ["definition-builder", "repo-indexer"];
  const roleNames = ["security", "devops", "qa", "architect", "devsecops"];
  const svc: InitServices = {
    async initDb() {
      return {
        collections: ["memory", "decisions", "users"],
        vector: { ok: true },
        bootstrap: { status: "exists", username: "root", email: "root@local", role: "root" },
      };
    },
    async getSoftware(name) {
      return state.softwares.get(name) ?? null;
    },
    async upsertSoftware(rec) {
      state.softwares.set(rec.name, rec);
      return rec;
    },
    async getRepo(project, name) {
      return state.repos.get(`${project}:${name}`) ?? null;
    },
    async upsertRepo(rec) {
      state.repos.set(`${rec.project}:${rec.name}`, rec as unknown as Record<string, unknown>);
      return rec;
    },
    async listBranches(project, repo) {
      return state.branches.get(`${project}:${repo}`) ?? [];
    },
    async syncBranches({ project, repo }) {
      const recs = [{ name: "main" }];
      state.branches.set(`${project}:${repo}`, recs);
      return recs;
    },
    async countSymbols(project, repo, branch) {
      return state.symbols.get(`${project}:${repo}:${branch}`) ?? 0;
    },
    async indexRepo({ project, repo }) {
      state.symbols.set(`${project}:${repo}:main`, 5);
      return { symbols: 5, steps: ["repomap: 5 symbols"] };
    },
    async hasSkills(project, names) {
      return names.every((n) => state.skills.has(`${project}:${n}`));
    },
    async seedSkills(project) {
      for (const n of skillNames) state.skills.add(`${project}:${n}`);
      return skillNames;
    },
    async hasRoles(project, names) {
      return names.every((n) => state.roles.has(`${project}:${n}`));
    },
    async seedRoles(project) {
      for (const n of roleNames) state.roles.add(`${project}:${n}`);
      return roleNames;
    },
    providerStatus: () => ({ active: null, fallbacks: [] }),
    currentBranch: () => "main",
  };
  return { svc, state };
}

async function mkRepoRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "aitl-init-"));
  await fs.mkdir(join(root, ".git"), { recursive: true }); // enough for the post-merge step
  return root;
}

// ── orchestrator: idempotency + files ────────────────────────────────────────

test("initRepo creates all artifacts and a second run is all skip (idempotent)", async () => {
  const root = await mkRepoRoot();
  const { svc } = fakeServices();
  const opts = { root, project: "demo", host: ["claude-code" as const], memoryOnly: true };

  const first = await initRepo(opts, svc);
  assert.equal(first.project, "demo");
  assert.equal(first.branch, "main");
  // Files created.
  for (const f of ["CLAUDE.md", "AGENTS.md", ".mcp.json", ".claude/settings.json", ".git/hooks/post-merge"]) {
    await fs.access(join(root, f));
  }
  // post-merge is executable and best-effort (`|| true`).
  const st = await fs.stat(join(root, ".git", "hooks", "post-merge"));
  assert.ok(st.mode & 0o111, "post-merge must be executable");
  const hook = await fs.readFile(join(root, ".git", "hooks", "post-merge"), "utf8");
  assert.match(hook, /branch sync --reindex --project demo --repo .+ \|\| true/);
  // Memory-only note in the final block.
  assert.ok(first.next.some((n) => n.includes("modo memoria")));
  // Steps that DO work are reported as done at least once.
  assert.ok(first.steps.some((s) => s.step === "index" && s.status === "done"));

  const second = await initRepo(opts, svc);
  const done = second.steps.filter((s) => s.status === "done");
  assert.deepEqual(done, [], `second run must not re-apply anything, got: ${JSON.stringify(done)}`);
  assert.ok(second.steps.some((s) => s.step === "index" && s.status === "skip"));
  assert.ok(second.steps.some((s) => s.step === ".mcp.json" && s.status === "skip"));
  assert.ok(second.steps.some((s) => s.step === "hooks-claude" && s.status === "skip"));
  assert.ok(second.steps.some((s) => s.step === "post-merge" && s.status === "skip"));
});

test("initRepo never clobbers an existing CLAUDE.md without --force (AITL section appended once)", async () => {
  const root = await mkRepoRoot();
  const { svc } = fakeServices();
  const original = "# Mi proyecto\n\nInstrucciones propias del equipo.\n";
  await fs.writeFile(join(root, "CLAUDE.md"), original, "utf8");

  const first = await initRepo({ root, project: "demo", memoryOnly: true }, svc);
  const merged = await fs.readFile(join(root, "CLAUDE.md"), "utf8");
  assert.ok(merged.startsWith(original), "original content must be preserved");
  assert.match(merged, /\n## AITL\n/);
  assert.ok(first.steps.some((s) => s.step === "CLAUDE.md" && s.status === "done"));

  // Re-running does not duplicate the section.
  await initRepo({ root, project: "demo", memoryOnly: true }, svc);
  const again = await fs.readFile(join(root, "CLAUDE.md"), "utf8");
  assert.equal(again, merged);
  assert.equal(again.match(/## AITL/g)?.length, 1);
});

test("initRepo --force overwrites the guides with the full scaffold", async () => {
  const root = await mkRepoRoot();
  const { svc } = fakeServices();
  await fs.writeFile(join(root, "CLAUDE.md"), "# viejo\n", "utf8");
  const report = await initRepo({ root, project: "demo", memoryOnly: true, force: true }, svc);
  const content = await fs.readFile(join(root, "CLAUDE.md"), "utf8");
  assert.ok(!content.includes("# viejo"));
  assert.match(content, /Operating contract for \*\*Claude Code\*\*/);
  assert.ok(report.steps.some((s) => s.step === "CLAUDE.md" && s.detail.includes("--force")));
});

// ── merge helpers ─────────────────────────────────────────────────────────────

test("mergeClaudeSettings preserves existing hooks and other keys", () => {
  const existing = JSON.stringify({
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo custom" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }],
    },
  });
  const res = mergeClaudeSettings(existing, [
    { event: "UserPromptSubmit", command: "aitl hydrate --project p --no-vector", marker: "hydrate" },
    { event: "Stop", command: "aitl capture-session --project p", marker: "capture-session" },
  ]);
  assert.equal(res.changed, true);
  const doc = JSON.parse(res.content);
  // Other keys untouched.
  assert.deepEqual(doc.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(doc.hooks.PreToolUse[0].hooks[0].command, "./lint.sh");
  // Existing UserPromptSubmit group preserved; ours appended after it.
  assert.equal(doc.hooks.UserPromptSubmit.length, 2);
  assert.equal(doc.hooks.UserPromptSubmit[0].hooks[0].command, "echo custom");
  assert.match(doc.hooks.UserPromptSubmit[1].hooks[0].command, /aitl hydrate/);
  assert.match(doc.hooks.Stop[0].hooks[0].command, /capture-session/);

  // Idempotent: a second merge changes nothing.
  const res2 = mergeClaudeSettings(res.content, [
    { event: "UserPromptSubmit", command: "aitl hydrate --project p --no-vector", marker: "hydrate" },
    { event: "Stop", command: "aitl capture-session --project p", marker: "capture-session" },
  ]);
  assert.equal(res2.changed, false);
});

test("mergeMcpJson adds the entry without touching other servers, and skips when present", () => {
  const entry = { command: "npm", args: ["--prefix", "/opt/aitl", "run", "mcp", "--silent"] };
  const created = mergeMcpJson(null, "aitl-js", entry);
  assert.equal(created.changed, true);
  assert.deepEqual(JSON.parse(created.content).mcpServers["aitl-js"], entry);

  const existing = JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } });
  const merged = mergeMcpJson(existing, "aitl-js", entry);
  assert.equal(merged.changed, true);
  const doc = JSON.parse(merged.content);
  assert.deepEqual(doc.mcpServers.other, { command: "other-mcp" });
  assert.deepEqual(doc.mcpServers["aitl-js"], entry);

  const again = mergeMcpJson(merged.content, "aitl-js", entry);
  assert.equal(again.changed, false);

  // Invalid JSON is never clobbered — the merge refuses instead.
  assert.throws(() => mergeMcpJson("{ not json", "aitl-js", entry), /JSON inválido/);
});

test("mergeGuideSection appends once and respects existing AITL markers", () => {
  const first = mergeGuideSection("# Guía\n", "demo");
  assert.equal(first.changed, true);
  assert.match(first.content, /## AITL/);
  assert.match(first.content, /aitl hydrate --project demo --no-vector/);
  const second = mergeGuideSection(first.content, "demo");
  assert.equal(second.changed, false);
  // A guide that already mentions AITL (e.g. generated by init agent) is left alone.
  assert.equal(mergeGuideSection("# Agent operating contract (AITL)\n", "demo").changed, false);
});

test("mergePostMergeHook creates, appends to an existing hook, and is idempotent", () => {
  const line = 'aitl branch sync --reindex --project p --repo r --root "$(git rev-parse --show-toplevel)" || true';
  const created = mergePostMergeHook(null, line);
  assert.equal(created.changed, true);
  assert.match(created.content, /^#!\/bin\/sh\n/);
  assert.ok(created.content.includes(line));

  const existing = "#!/bin/bash\nmake refresh\n";
  const appended = mergePostMergeHook(existing, line);
  assert.equal(appended.changed, true);
  assert.ok(appended.content.startsWith(existing), "existing hook body preserved");
  assert.ok(appended.content.includes(line));

  const again = mergePostMergeHook(appended.content, line);
  assert.equal(again.changed, false);
});
