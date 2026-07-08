import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getHost, resolveHostSpec, splitHostArgs } from "./base.js";

// The permission posture must always travel explicitly on the argv (never depend on the
// target directory's settings/trust), and read-only must always win (ADR-0055).

test("claude-code: normal delegated runs carry an explicit write posture", () => {
  const spec = resolveHostSpec("claude-code", {}, {});
  assert.deepEqual(spec.args, ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"]);
});

test("claude-code: readonly keeps the exact plan argv (no write posture leaks in)", () => {
  const spec = resolveHostSpec("claude-code", { readonly: true }, {});
  assert.deepEqual(spec.args, ["-p", "--output-format", "json", "--permission-mode", "plan"]);
});

test("an explicit --permission-mode in extraArgs suppresses the acceptEdits default", () => {
  const spec = resolveHostSpec(
    "claude-code",
    { extraArgs: ["--permission-mode", "bypassPermissions"] },
    {},
  );
  assert.deepEqual(spec.args, [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("extraArgs append --allowedTools after the write posture", () => {
  const spec = resolveHostSpec(
    "claude-code",
    { extraArgs: ["--allowedTools", "Bash(make:*),Bash(python3:*)"] },
    {},
  );
  assert.deepEqual(spec.args, [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(make:*),Bash(python3:*)",
  ]);
});

test("AITL_HOST_ARGS_<NAME> injects tokenized argv (quotes preserved as one token)", () => {
  const env = { AITL_HOST_ARGS_CLAUDE_CODE: `--allowedTools "Bash(make:*),Edit" --verbose` };
  const spec = resolveHostSpec("claude-code", {}, env);
  assert.deepEqual(spec.args, [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(make:*),Edit",
    "--verbose",
  ]);
});

test("AITL_HOST_ARGS with an explicit --permission-mode also suppresses the default", () => {
  const env = { AITL_HOST_ARGS_CLAUDE_CODE: "--permission-mode plan" };
  const spec = resolveHostSpec("claude-code", {}, env);
  assert.deepEqual(spec.args, ["-p", "--output-format", "json", "--permission-mode", "plan"]);
});

test("codex: extra argv is inserted BEFORE the trailing '-' stdin marker", () => {
  const spec = resolveHostSpec("codex", { extraArgs: ["--foo"] }, {});
  assert.deepEqual(spec.args, ["exec", "--foo", "-"]);
});

test("codex: readonly argv unchanged (council contract)", () => {
  const spec = resolveHostSpec("codex", { readonly: true }, {});
  assert.deepEqual(spec.args, ["exec", "--sandbox", "read-only", "-"]);
});

test("AITL_HOST_CMD_<NAME> still overrides only the command", () => {
  const spec = resolveHostSpec("claude-code", {}, { AITL_HOST_CMD_CLAUDE_CODE: "/opt/fake" });
  assert.equal(spec.command, "/opt/fake");
  assert.equal(spec.args[0], "-p");
});

test("unknown host throws with the known-host list", () => {
  assert.throws(() => resolveHostSpec("nope", {}, {}), /Known hosts:/);
});

test("splitHostArgs: empty, plain, and quoted values", () => {
  assert.deepEqual(splitHostArgs(undefined), []);
  assert.deepEqual(splitHostArgs("   "), []);
  assert.deepEqual(splitHostArgs("--a b"), ["--a", "b"]);
  assert.deepEqual(splitHostArgs(`--a "b c" 'd e'`), ["--a", "b c", "d e"]);
});

// E2E: the resolved argv actually reaches the spawned host binary.
test("runTask spawns the host with the explicit permission argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aitl-host-"));
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({
  result: process.argv.slice(2).join(" "),
  usage: { input_tokens: 1, output_tokens: 1 },
}));
`,
  );
  chmodSync(fake, 0o755);
  const prev = process.env.AITL_HOST_CMD_CLAUDE_CODE;
  process.env.AITL_HOST_CMD_CLAUDE_CODE = fake;
  try {
    const host = getHost("claude-code", { extraArgs: ["--allowedTools", "Bash(make:*)"] });
    const res = await host.runTask("hola");
    assert.equal(res.exitCode, 0);
    assert.equal(
      res.text,
      "-p --output-format json --permission-mode acceptEdits --allowedTools Bash(make:*)",
    );
  } finally {
    if (prev === undefined) delete process.env.AITL_HOST_CMD_CLAUDE_CODE;
    else process.env.AITL_HOST_CMD_CLAUDE_CODE = prev;
  }
});
