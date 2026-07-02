import assert from "node:assert/strict";
import { test } from "node:test";

// Settings are a cached singleton read on the FIRST import of ../config.js, so pin the
// env before any dynamic import below (node --test isolates this file in its own
// process, so this cannot leak into other suites). dotenv never overrides pre-set vars.
process.env.LMSTUDIO_MODEL = "qwen2.5-coder-7b";
process.env.LMSTUDIO_MAX_CONTEXT = "16000";
process.env.OPENAI_COMPAT_BASE_URL = "";
process.env.OPENAI_COMPAT_MODEL = "";

test("getProvider resolves lmstudio via the OpenAI-compatible provider", async () => {
  const { getProvider } = await import("./base.js");
  const p = await getProvider("lmstudio");
  assert.equal(p.name, "lmstudio");
  assert.equal(p.capabilities().maxContext, 16000); // LMSTUDIO_MAX_CONTEXT wins over default
  assert.equal(p.capabilities().toolUse, true);
});

test("getProvider('openai-compat') fails clearly when base URL/model are missing", async () => {
  const { getProvider } = await import("./base.js");
  await assert.rejects(() => getProvider("openai-compat"), /OPENAI_COMPAT_BASE_URL/);
});

test("getProvider still rejects unknown providers, listing the valid ones", async () => {
  const { getProvider } = await import("./base.js");
  await assert.rejects(() => getProvider("nope"), /Unknown provider 'nope'.*lmstudio/);
});

test("OpenAIProvider maxContext is configurable with a sane default", async () => {
  const { OpenAIProvider } = await import("./openai.js");
  assert.equal(new OpenAIProvider({ apiKey: "x", maxContext: 9_000 }).capabilities().maxContext, 9_000);
  assert.equal(new OpenAIProvider({ apiKey: "x" }).capabilities().maxContext, 128_000);
});
