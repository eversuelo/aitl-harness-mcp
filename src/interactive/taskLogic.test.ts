import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  availableHostNames,
  computeTaskActions,
  detectAvailableHosts,
  findOnPath,
  hostOverrideEnvVar,
  planCouncilSeats,
} from "./taskLogic.js";

// ── findOnPath ────────────────────────────────────────────────────────────────

test("findOnPath resolves an executable on PATH and misses absent ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-path-"));
  const bin = join(dir, "fake-host");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  const env = { PATH: dir } as NodeJS.ProcessEnv;
  assert.equal(findOnPath("fake-host", env), bin);
  assert.equal(findOnPath("no-such-cmd", env), null);
  assert.equal(findOnPath("", env), null);
  // A command that already carries a path separator is checked directly.
  assert.equal(findOnPath(bin, { PATH: "" }), bin);
  assert.equal(findOnPath(join(dir, "missing"), env), null);
});

// ── host availability ─────────────────────────────────────────────────────────

test("hostOverrideEnvVar matches the getHost seam naming", () => {
  assert.equal(hostOverrideEnvVar("claude-code"), "AITL_HOST_CMD_CLAUDE_CODE");
  assert.equal(hostOverrideEnvVar("codex"), "AITL_HOST_CMD_CODEX");
});

test("detectAvailableHosts: PATH probe and AITL_HOST_CMD_* override", () => {
  const specs = { "claude-code": { command: "claude" }, codex: { command: "codex" } };
  const onPath = new Set(["claude"]);
  const hosts = detectAvailableHosts(
    { AITL_HOST_CMD_CODEX: "/opt/fake/codex.mjs" } as NodeJS.ProcessEnv,
    { specs, isOnPath: (cmd) => onPath.has(cmd) },
  );
  assert.deepEqual(hosts, [
    { name: "claude-code", available: true, via: "path", command: "claude" },
    { name: "codex", available: true, via: "override", command: "/opt/fake/codex.mjs" },
  ]);
  assert.deepEqual(availableHostNames(hosts), ["claude-code", "codex"]);

  const none = detectAvailableHosts({} as NodeJS.ProcessEnv, { specs, isOnPath: () => false });
  assert.ok(none.every((h) => !h.available && h.via === null));
  assert.deepEqual(availableHostNames(none), []);
});

// ── council seat composition ──────────────────────────────────────────────────

test("planCouncilSeats: hosts propose, provider judges", () => {
  const { seats, reason } = planCouncilSeats(["a", "b"], ["gemini"]);
  assert.equal(reason, undefined);
  assert.deepEqual(seats, { proponents: ["a", "b"], judge: "provider:gemini" });
});

test("planCouncilSeats: ≥3 hosts without provider — last host judges", () => {
  const { seats } = planCouncilSeats(["a", "b", "c"], []);
  assert.deepEqual(seats, { proponents: ["a", "b"], judge: "c" });
});

test("planCouncilSeats: 2 hosts without provider is not runnable", () => {
  const { seats, reason } = planCouncilSeats(["a", "b"], []);
  assert.equal(seats, undefined);
  assert.match(reason ?? "", /juez/);
});

test("planCouncilSeats: 1 host + 2 providers fills the three seats", () => {
  const { seats } = planCouncilSeats(["a"], ["p1", "p2"]);
  assert.deepEqual(seats, { proponents: ["a", "provider:p1"], judge: "provider:p2" });
});

test("planCouncilSeats: 1 host + 1 provider is not enough", () => {
  const { seats, reason } = planCouncilSeats(["a"], ["p1"]);
  assert.equal(seats, undefined);
  assert.match(reason ?? "", /≥2 proponentes/);
});

test("planCouncilSeats: providers-only council needs ≥3", () => {
  const { seats } = planCouncilSeats([], ["p1", "p2", "p3"]);
  assert.deepEqual(seats, { proponents: ["provider:p1", "provider:p2"], judge: "provider:p3" });
  const short = planCouncilSeats([], ["p1", "p2"]);
  assert.equal(short.seats, undefined);
  assert.match(short.reason ?? "", /≥2 clientes/);
});

// ── action availability ───────────────────────────────────────────────────────

test("computeTaskActions: everything enabled when hosts + providers exist", () => {
  const actions = computeTaskActions({ hosts: ["a", "b"], providers: ["gemini"] });
  assert.equal(actions.plan.enabled, true);
  assert.equal(actions.delegate.enabled, true);
  assert.equal(actions.council.enabled, true);
  assert.deepEqual(actions.council.seats, { proponents: ["a", "b"], judge: "provider:gemini" });
});

test("computeTaskActions: disabled actions carry a human-readable reason", () => {
  const actions = computeTaskActions({ hosts: [], providers: [] });
  assert.equal(actions.plan.enabled, false);
  assert.match(actions.plan.reason ?? "", /modelo/);
  assert.equal(actions.delegate.enabled, false);
  assert.match(actions.delegate.reason ?? "", /hosts/);
  assert.equal(actions.council.enabled, false);
  assert.equal(actions.council.seats, undefined);
  assert.ok(actions.council.reason);
});
